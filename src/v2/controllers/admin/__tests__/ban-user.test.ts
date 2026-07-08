import test from "ava";
import { v4 } from "uuid";
import { initializeDataSource } from "../../../__tests__/helpers/db/test-hooks";
import { useTransaction } from "../../../__tests__/helpers/db/query-runner";
import { testService } from "../../../__tests__/helpers/db";
import { banUser } from "../ban-user";
import { unbanUser } from "../unban-user";
import { banUserBatch } from "../ban-user-batch";
import { unbanUserBatch } from "../unban-user-batch";
import { userBlacklistDAO } from "../../../dao";
import { UserBlacklistModel } from "../../../../model/user/Blacklist";
import { Status } from "../../../../constants/Project";
import { FError } from "../../../../error/ControllerError";
import { ErrorCode } from "../../../../ErrorCode";

const namespace = "v2.controllers.admin.ban-user";

const findBlacklistRaw = async (
    t: any,
    where: Record<string, unknown>,
): Promise<{ is_delete: number | null }> => {
    return await t
        .getRepository(UserBlacklistModel)
        .findOne({ where, select: ["is_delete"] as any }) as any;
};
initializeDataSource(test, namespace);

const buildReq = (
    body: any,
    t: any,
    userUUID?: string,
): any => ({
    body,
    ids: { reqID: v4(), sesID: v4() },
    DBTransaction: t,
    userUUID: userUUID || v4(),
});

test.serial(`${namespace} - ban by phone succeeds`, async ava => {
    const { t, commitTransaction, releaseRunner } = await useTransaction();
    const { createUser, createUserPhone } = testService(t);

    const userInfo = await createUser.quick();
    const phoneInfo = await createUserPhone.quick(userInfo);

    const resp = await banUser(buildReq({ phone: phoneInfo.phoneNumber }, t));

    ava.is(resp.status, Status.Success);
    await commitTransaction();

    const blacklist = await userBlacklistDAO.findOne(t, ["user_uuid"], {
        phone_number: phoneInfo.phoneNumber,
    });
    ava.is(blacklist?.user_uuid, userInfo.userUUID);

    await releaseRunner();
});

test.serial(`${namespace} - ban by email succeeds`, async ava => {
    const { t, commitTransaction, releaseRunner } = await useTransaction();
    const { createUser, createUserEmail } = testService(t);

    const userInfo = await createUser.quick();
    const emailInfo = await createUserEmail.quick(userInfo);

    const resp = await banUser(buildReq({ email: emailInfo.userEmail }, t));

    ava.is(resp.status, Status.Success);
    await commitTransaction();

    const blacklist = await userBlacklistDAO.findOne(t, ["user_uuid"], {
        email: emailInfo.userEmail,
    });
    ava.is(blacklist?.user_uuid, userInfo.userUUID);

    await releaseRunner();
});

test.serial(`${namespace} - ban by userUUID succeeds`, async ava => {
    const { t, commitTransaction, releaseRunner } = await useTransaction();
    const { createUser } = testService(t);

    const userInfo = await createUser.quick();

    const resp = await banUser(buildReq({ userUUID: userInfo.userUUID }, t));

    ava.is(resp.status, Status.Success);
    ava.is((resp as any).data?.matchedCount, 1);
    ava.is((resp as any).data?.skippedCount, 0);
    await commitTransaction();

    const blacklist = await userBlacklistDAO.findOne(t, ["id"], {
        user_uuid: userInfo.userUUID,
    });
    ava.not(blacklist, null);

    await releaseRunner();
});


test.serial(`${namespace} - ban with no identifier throws ParamsCheckFailed`, async ava => {
    const { t, releaseRunner } = await useTransaction();

    await ava.throwsAsync(() => banUser(buildReq({}, t)), {
        instanceOf: FError,
        message: `${Status.Failed}: ${ErrorCode.ParamsCheckFailed}`,
    });

    await releaseRunner();
});

test.serial(`${namespace} - ban with multiple identifiers throws ParamsCheckFailed`, async ava => {
    const { t, releaseRunner } = await useTransaction();
    const { createUser, createUserPhone } = testService(t);

    const userInfo = await createUser.quick();
    const phoneInfo = await createUserPhone.quick(userInfo);

    await ava.throwsAsync(
        () =>
            banUser(
                buildReq(
                    { phone: phoneInfo.phoneNumber, userUUID: userInfo.userUUID },
                    t,
                ),
            ),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.ParamsCheckFailed}`,
        },
    );

    await releaseRunner();
});

test.serial(`${namespace} - unban by phone succeeds`, async ava => {
    const { t, commitTransaction, releaseRunner } = await useTransaction();
    const { createUser, createUserPhone, createUserBlacklist } = testService(t);

    const userInfo = await createUser.quick();
    const phoneInfo = await createUserPhone.quick(userInfo);
    await createUserBlacklist.byPhone(phoneInfo.phoneNumber);

    const resp = await unbanUser(buildReq({ phone: phoneInfo.phoneNumber }, t));

    ava.is(resp.status, Status.Success);
    await commitTransaction();

    const blacklist = await findBlacklistRaw(t, { phone_number: phoneInfo.phoneNumber });
    ava.is(Number(blacklist?.is_delete), 1);

    await releaseRunner();
});

test.serial(`${namespace} - unban by email succeeds`, async ava => {
    const { t, commitTransaction, releaseRunner } = await useTransaction();
    const { createUser, createUserEmail, createUserBlacklist } = testService(t);

    const userInfo = await createUser.quick();
    const emailInfo = await createUserEmail.quick(userInfo);
    await createUserBlacklist.byEmail(emailInfo.userEmail);

    const resp = await unbanUser(buildReq({ email: emailInfo.userEmail }, t));

    ava.is(resp.status, Status.Success);
    await commitTransaction();

    const blacklist = await findBlacklistRaw(t, { email: emailInfo.userEmail });
    ava.is(Number(blacklist?.is_delete), 1);

    await releaseRunner();
});

test.serial(`${namespace} - unban by userUUID succeeds`, async ava => {
    const { t, commitTransaction, releaseRunner } = await useTransaction();
    const { createUser, createUserBlacklist } = testService(t);

    const userInfo = await createUser.quick();
    await createUserBlacklist.byUserUUID(userInfo.userUUID);

    const resp = await unbanUser(buildReq({ userUUID: userInfo.userUUID }, t));

    ava.is(resp.status, Status.Success);
    await commitTransaction();

    const blacklist = await findBlacklistRaw(t, { user_uuid: userInfo.userUUID });
    ava.is(Number(blacklist?.is_delete), 1);

    await releaseRunner();
});

test.serial(`${namespace} - unban with no identifier throws ParamsCheckFailed`, async ava => {
    const { t, releaseRunner } = await useTransaction();

    await ava.throwsAsync(() => unbanUser(buildReq({}, t)), {
        instanceOf: FError,
        message: `${Status.Failed}: ${ErrorCode.ParamsCheckFailed}`,
    });

    await releaseRunner();
});

test.serial(`${namespace} - batch ban by phones succeeds`, async ava => {
    const { t, commitTransaction, releaseRunner } = await useTransaction();
    const { createUser, createUserPhone } = testService(t);

    const user1 = await createUser.quick();
    const phone1 = await createUserPhone.quick(user1);
    const phone2 = await createUserPhone.quick(user1);

    const resp = await banUserBatch(
        buildReq({ phones: [phone1.phoneNumber, phone2.phoneNumber] }, t),
    );

    ava.is(resp.status, Status.Success);
    await commitTransaction();

    const blacklist1 = await userBlacklistDAO.findOne(t, ["id"], {
        phone_number: phone1.phoneNumber,
    });
    ava.not(blacklist1, null);
    const blacklist2 = await userBlacklistDAO.findOne(t, ["id"], {
        phone_number: phone2.phoneNumber,
    });
    ava.not(blacklist2, null);

    await releaseRunner();
});

test.serial(`${namespace} - batch ban with empty arrays throws ParamsCheckFailed`, async ava => {
    const { t, releaseRunner } = await useTransaction();

    await ava.throwsAsync(
        () => banUserBatch(buildReq({ phones: [], emails: [] }, t)),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.ParamsCheckFailed}`,
        },
    );

    await releaseRunner();
});

test.serial(`${namespace} - batch ban with multiple identifier types throws ParamsCheckFailed`, async ava => {
    const { t, releaseRunner } = await useTransaction();
    const { createUser, createUserPhone } = testService(t);

    const userInfo = await createUser.quick();
    const phoneInfo = await createUserPhone.quick(userInfo);

    await ava.throwsAsync(
        () =>
            banUserBatch(
                buildReq(
                    { phones: [phoneInfo.phoneNumber], userUUIDs: [userInfo.userUUID] },
                    t,
                ),
            ),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.ParamsCheckFailed}`,
        },
    );

    await releaseRunner();
});


test.serial(`${namespace} - batch unban by phones succeeds`, async ava => {
    const { t, commitTransaction, releaseRunner } = await useTransaction();
    const { createUserBlacklist } = testService(t);

    const phone1 = await createUserBlacklist.byPhone();
    const phone2 = await createUserBlacklist.byPhone();

    const resp = await unbanUserBatch(
        buildReq({ phones: [phone1.phoneNumber, phone2.phoneNumber] }, t),
    );

    ava.is(resp.status, Status.Success);
    await commitTransaction();

    const blacklist1 = await findBlacklistRaw(t, { phone_number: phone1.phoneNumber });
    ava.is(Number(blacklist1?.is_delete), 1);
    const blacklist2 = await findBlacklistRaw(t, { phone_number: phone2.phoneNumber });
    ava.is(Number(blacklist2?.is_delete), 1);

    await releaseRunner();
});

test.serial(`${namespace} - batch unban by emails succeeds`, async ava => {
    const { t, commitTransaction, releaseRunner } = await useTransaction();
    const { createUserBlacklist } = testService(t);

    const email1 = await createUserBlacklist.byEmail();
    const email2 = await createUserBlacklist.byEmail();

    const resp = await unbanUserBatch(
        buildReq({ emails: [email1.email, email2.email] }, t),
    );

    ava.is(resp.status, Status.Success);
    await commitTransaction();

    const blacklist1 = await findBlacklistRaw(t, { email: email1.email });
    ava.is(Number(blacklist1?.is_delete), 1);
    const blacklist2 = await findBlacklistRaw(t, { email: email2.email });
    ava.is(Number(blacklist2?.is_delete), 1);

    await releaseRunner();
});

test.serial(`${namespace} - batch unban by userUUIDs succeeds`, async ava => {
    const { t, commitTransaction, releaseRunner } = await useTransaction();
    const { createUser, createUserBlacklist } = testService(t);

    const user1 = await createUser.quick();
    const user2 = await createUser.quick();
    await createUserBlacklist.byUserUUID(user1.userUUID);
    await createUserBlacklist.byUserUUID(user2.userUUID);

    const resp = await unbanUserBatch(
        buildReq({ userUUIDs: [user1.userUUID, user2.userUUID] }, t),
    );

    ava.is(resp.status, Status.Success);
    await commitTransaction();

    const blacklist1 = await findBlacklistRaw(t, { user_uuid: user1.userUUID });
    ava.is(Number(blacklist1?.is_delete), 1);
    const blacklist2 = await findBlacklistRaw(t, { user_uuid: user2.userUUID });
    ava.is(Number(blacklist2?.is_delete), 1);

    await releaseRunner();
});

test.serial(`${namespace} - batch unban with no arrays throws ParamsCheckFailed`, async ava => {
    const { t, releaseRunner } = await useTransaction();

    await ava.throwsAsync(() => unbanUserBatch(buildReq({}, t)), {
        instanceOf: FError,
        message: `${Status.Failed}: ${ErrorCode.ParamsCheckFailed}`,
    });

    await releaseRunner();
});

test.serial(`${namespace} - batch ban then unban end-to-end`, async ava => {
    const { t, commitTransaction, releaseRunner } = await useTransaction();
    const { createUser, createUserPhone } = testService(t);

    const user1 = await createUser.quick();
    const phone1 = await createUserPhone.quick(user1);
    const user2 = await createUser.quick();
    const phone2 = await createUserPhone.quick(user2);

    const banResp = await banUserBatch(
        buildReq({ phones: [phone1.phoneNumber, phone2.phoneNumber] }, t),
    );
    ava.is(banResp.status, Status.Success);

    const unbanResp = await unbanUserBatch(
        buildReq({ phones: [phone1.phoneNumber, phone2.phoneNumber] }, t),
    );
    ava.is(unbanResp.status, Status.Success);
    await commitTransaction();

    const blacklist1 = await findBlacklistRaw(t, { phone_number: phone1.phoneNumber });
    ava.is(Number(blacklist1?.is_delete), 1);
    const blacklist2 = await findBlacklistRaw(t, { phone_number: phone2.phoneNumber });
    ava.is(Number(blacklist2?.is_delete), 1);

    await releaseRunner();
});
