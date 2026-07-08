import test from "ava";
import { v4 } from "uuid";
import { Status } from "../../../../constants/Project";
import { FError } from "../../../../error/ControllerError";
import { ErrorCode } from "../../../../ErrorCode";
import { userBlacklistDAO, userDAO } from "../../../dao";
import { testService } from "../../../__tests__/helpers/db";
import { useTransaction } from "../../../__tests__/helpers/db/query-runner";
import { initializeDataSource } from "../../../__tests__/helpers/db/test-hooks";
import { randomPhoneNumber } from "../../../__tests__/helpers/db/user-phone";
import { ids } from "../../../__tests__/helpers/fastify/ids";
import { UserBlacklistService } from "../blacklist";

const namespace = "v2.services.user.blacklist";
initializeDataSource(test, namespace);

test.serial(`${namespace} - banByPhone writes blacklist and marks user`, async ava => {
    const { t, releaseRunner } = await useTransaction();
    const { createUser, createUserPhone } = testService(t);

    const userInfo = await createUser.quick();
    const phoneInfo = await createUserPhone.quick(userInfo);
    const reason = "fraud";
    const operator = v4();

    await new UserBlacklistService(ids(), t).banByPhone(
        phoneInfo.phoneNumber,
        reason,
        operator,
    );

    const blacklist = await userBlacklistDAO.findOne(t, ["user_uuid", "reason", "operator"], {
        phone_number: phoneInfo.phoneNumber,
    });
    ava.not(blacklist, null);
    ava.is(blacklist?.user_uuid, userInfo.userUUID);
    ava.is(blacklist?.reason, reason);
    ava.is(blacklist?.operator, operator);

    const user = await userDAO.findOne(t, ["is_blacklist"], {
        user_uuid: userInfo.userUUID,
    });
    ava.is(Number(user?.is_blacklist), 1);

    await releaseRunner();
});

test.serial(`${namespace} - banByPhone on unregistered phone only writes blacklist`, async ava => {
    const { t, releaseRunner } = await useTransaction();

    const phone = randomPhoneNumber();
    await new UserBlacklistService(ids(), t).banByPhone(phone);

    const blacklist = await userBlacklistDAO.findOne(t, ["user_uuid"], {
        phone_number: phone,
    });
    ava.not(blacklist, null);
    ava.is(blacklist?.user_uuid, null);

    await releaseRunner();
});

test.serial(`${namespace} - banByEmail writes blacklist and marks user`, async ava => {
    const { t, releaseRunner } = await useTransaction();
    const { createUser, createUserEmail } = testService(t);

    const userInfo = await createUser.quick();
    const emailInfo = await createUserEmail.quick(userInfo);
    const email = emailInfo.userEmail;

    await new UserBlacklistService(ids(), t).banByEmail(email);

    const blacklist = await userBlacklistDAO.findOne(t, ["user_uuid"], {
        email,
    });
    ava.is(blacklist?.user_uuid, userInfo.userUUID);

    const user = await userDAO.findOne(t, ["is_blacklist"], {
        user_uuid: userInfo.userUUID,
    });
    ava.is(Number(user?.is_blacklist), 1);

    await releaseRunner();
});

test.serial(`${namespace} - banByUserUUID writes blacklist and marks user`, async ava => {
    const { t, releaseRunner } = await useTransaction();
    const { createUser } = testService(t);

    const userInfo = await createUser.quick();

    const result = await new UserBlacklistService(ids(), t).banByUserUUID(userInfo.userUUID);
    ava.deepEqual(result, { matchedCount: 1, skippedCount: 0 });

    const blacklist = await userBlacklistDAO.findOne(t, ["phone_number", "email"], {
        user_uuid: userInfo.userUUID,
    });
    ava.not(blacklist, null);
    ava.is(blacklist?.phone_number, null);
    ava.is(blacklist?.email, null);

    const user = await userDAO.findOne(t, ["is_blacklist"], {
        user_uuid: userInfo.userUUID,
    });
    ava.is(Number(user?.is_blacklist), 1);

    await releaseRunner();
});

test.serial(`${namespace} - banByUserUUID on non-existent user does not write blacklist`, async ava => {
    const { t, releaseRunner } = await useTransaction();

    const fakeUUID = v4();
    const result = await new UserBlacklistService(ids(), t).banByUserUUID(fakeUUID);
    ava.deepEqual(result, { matchedCount: 0, skippedCount: 1 });

    const blacklist = await userBlacklistDAO.findOne(t, ["id"], {
        user_uuid: fakeUUID,
    });
    ava.is(blacklist, null);

    await releaseRunner();
});

test.serial(`${namespace} - banByUserUUIDs returns matched and skipped counts for mixed inputs`, async ava => {
    const { t, releaseRunner } = await useTransaction();
    const { createUser } = testService(t);

    const user1 = await createUser.quick();
    const user2 = await createUser.quick();

    const result = await new UserBlacklistService(ids(), t).banByUserUUIDs([
        user1.userUUID,
        user2.userUUID,
        v4(),
        v4(),
    ]);
    ava.deepEqual(result, { matchedCount: 2, skippedCount: 2 });

    await releaseRunner();
});

test.serial(`${namespace} - banByPhones re-ban after unban is idempotent (hard delete + insert)`, async ava => {
    const { t, releaseRunner } = await useTransaction();

    const phone = randomPhoneNumber();
    const svc = new UserBlacklistService(ids(), t);

    await svc.banByPhone(phone);
    await svc.unbanByPhone(phone);
    await svc.banByPhone(phone);

    const blacklist = await userBlacklistDAO.findOne(t, ["is_delete"], {
        phone_number: phone,
    });
    ava.not(blacklist, null);
    ava.is(Number(blacklist?.is_delete), 0);

    await releaseRunner();
});

test.serial(`${namespace} - unbanByPhone soft-deletes blacklist and clears user flag`, async ava => {
    const { t, releaseRunner } = await useTransaction();
    const { createUser, createUserPhone } = testService(t);

    const userInfo = await createUser.quick();
    const phoneInfo = await createUserPhone.quick(userInfo);

    await new UserBlacklistService(ids(), t).banByPhone(phoneInfo.phoneNumber);
    await new UserBlacklistService(ids(), t).unbanByPhone(phoneInfo.phoneNumber);

    const user = await userDAO.findOne(t, ["is_blacklist"], {
        user_uuid: userInfo.userUUID,
    });
    ava.is(Number(user?.is_blacklist), 0);

    await releaseRunner();
});

test.serial(`${namespace} - assertNotBanned throws UserBlacklisted when phone is banned`, async ava => {
    const { t, releaseRunner } = await useTransaction();

    const phone = randomPhoneNumber();
    await new UserBlacklistService(ids(), t).banByPhone(phone);

    await ava.throwsAsync(
        () => new UserBlacklistService(ids(), t).assertNotBanned({ phone }),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.UserBlacklisted}`,
        },
    );

    await releaseRunner();
});

test.serial(`${namespace} - assertNotBanned throws on email match`, async ava => {
    const { t, releaseRunner } = await useTransaction();

    const email = `${v4()}@example.com`;
    await new UserBlacklistService(ids(), t).banByEmail(email);

    await ava.throwsAsync(
        () => new UserBlacklistService(ids(), t).assertNotBanned({ email }),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.UserBlacklisted}`,
        },
    );

    await releaseRunner();
});

test.serial(`${namespace} - assertNotBanned throws on userUUID match`, async ava => {
    const { t, releaseRunner } = await useTransaction();
    const { createUser } = testService(t);

    const userInfo = await createUser.quick();
    await new UserBlacklistService(ids(), t).banByUserUUID(userInfo.userUUID);

    await ava.throwsAsync(
        () =>
            new UserBlacklistService(ids(), t).assertNotBanned({
                userUUID: userInfo.userUUID,
            }),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.UserBlacklisted}`,
        },
    );

    await releaseRunner();
});

test.serial(`${namespace} - assertNotBanned passes when not banned`, async ava => {
    const { t, releaseRunner } = await useTransaction();

    await new UserBlacklistService(ids(), t).assertNotBanned({
        phone: randomPhoneNumber(),
        email: `${v4()}@example.com`,
        userUUID: v4(),
    });

    ava.pass();
    await releaseRunner();
});

test.serial(`${namespace} - assertNotBanned catches any of three identifiers`, async ava => {
    const { t, releaseRunner } = await useTransaction();

    const phone = randomPhoneNumber();
    const email = `${v4()}@example.com`;
    const userUUID = v4();

    await new UserBlacklistService(ids(), t).banByPhone(phone);

    await ava.throwsAsync(
        () =>
            new UserBlacklistService(ids(), t).assertNotBanned({
                email,
                userUUID,
                phone,
            }),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.UserBlacklisted}`,
        },
    );

    await releaseRunner();
});

test.serial(`${namespace} - banByPhones batch marks all matched users`, async ava => {
    const { t, releaseRunner } = await useTransaction();
    const { createUser, createUserPhone } = testService(t);

    const user1 = await createUser.quick();
    const phone1 = await createUserPhone.quick(user1);
    const phone2 = randomPhoneNumber();

    await new UserBlacklistService(ids(), t).banByPhones(
        [phone1.phoneNumber, phone2],
        "batch reason",
    );

    const blacklist1 = await userBlacklistDAO.findOne(t, ["user_uuid"], {
        phone_number: phone1.phoneNumber,
    });
    ava.is(blacklist1?.user_uuid, user1.userUUID);

    const blacklist2 = await userBlacklistDAO.findOne(t, ["user_uuid"], {
        phone_number: phone2,
    });
    ava.is(blacklist2?.user_uuid, null);

    const user = await userDAO.findOne(t, ["is_blacklist"], {
        user_uuid: user1.userUUID,
    });
    ava.is(Number(user?.is_blacklist), 1);

    await releaseRunner();
});

test.serial(`${namespace} - unbanByPhones batch clears user flags`, async ava => {
    const { t, releaseRunner } = await useTransaction();
    const { createUser, createUserPhone } = testService(t);

    const user1 = await createUser.quick();
    const phone1 = await createUserPhone.quick(user1);
    const user2 = await createUser.quick();
    const phone2 = await createUserPhone.quick(user2);

    const svc = new UserBlacklistService(ids(), t);
    await svc.banByPhones([phone1.phoneNumber, phone2.phoneNumber]);
    await svc.unbanByPhones([phone1.phoneNumber, phone2.phoneNumber]);

    const u1 = await userDAO.findOne(t, ["is_blacklist"], {
        user_uuid: user1.userUUID,
    });
    ava.is(Number(u1?.is_blacklist), 0);

    const u2 = await userDAO.findOne(t, ["is_blacklist"], {
        user_uuid: user2.userUUID,
    });
    ava.is(Number(u2?.is_blacklist), 0);

    await releaseRunner();
});

test.serial(`${namespace} - isBanned returns true/false correctly`, async ava => {
    const { t, releaseRunner } = await useTransaction();

    const phone = randomPhoneNumber();
    const svc = new UserBlacklistService(ids(), t);

    ava.is(await svc.isBanned({ phone }), false);

    await svc.banByPhone(phone);
    ava.is(await svc.isBanned({ phone }), true);

    await svc.unbanByPhone(phone);
    ava.is(await svc.isBanned({ phone }), false);

    await releaseRunner();
});

test.serial(`${namespace} - phone normalization: ban with +prefix, assert with digits`, async ava => {
    const { t, releaseRunner } = await useTransaction();

    const phone = randomPhoneNumber();
    const svc = new UserBlacklistService(ids(), t);

    await svc.banByPhone(`+${phone}`);
    await ava.throwsAsync(
        () => svc.assertNotBanned({ phone }),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.UserBlacklisted}`,
        },
    );

    await releaseRunner();
});

test.serial(`${namespace} - phone normalization: ban with digits, assert with +prefix`, async ava => {
    const { t, releaseRunner } = await useTransaction();

    const phone = randomPhoneNumber();
    const svc = new UserBlacklistService(ids(), t);

    await svc.banByPhone(phone);
    await ava.throwsAsync(
        () => svc.assertNotBanned({ phone: `+${phone}` }),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.UserBlacklisted}`,
        },
    );

    await releaseRunner();
});

test.serial(`${namespace} - email normalization: case-insensitive match`, async ava => {
    const { t, releaseRunner } = await useTransaction();

    const email = `User.${v4()}@Example.COM`;
    const svc = new UserBlacklistService(ids(), t);

    await svc.banByEmail(email);
    await ava.throwsAsync(
        () => svc.assertNotBanned({ email: email.toLowerCase() }),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.UserBlacklisted}`,
        },
    );

    await releaseRunner();
});

test.serial(`${namespace} - banByPhone with +prefix matches user_phone stored with +prefix`, async ava => {
    const { t, releaseRunner } = await useTransaction();
    const { createUser, createUserPhone } = testService(t);

    const userInfo = await createUser.quick();
    const rawPhone = `+${randomPhoneNumber()}`;
    await createUserPhone.full({
        userUUID: userInfo.userUUID,
        userName: userInfo.userName,
        phoneNumber: rawPhone,
    });

    await new UserBlacklistService(ids(), t).banByPhone(rawPhone);

    const blacklist = await userBlacklistDAO.findOne(t, ["user_uuid"], {
        phone_number: rawPhone.replace("+", ""),
    });
    ava.is(blacklist?.user_uuid, userInfo.userUUID);

    const user = await userDAO.findOne(t, ["is_blacklist"], {
        user_uuid: userInfo.userUUID,
    });
    ava.is(Number(user?.is_blacklist), 1);

    await releaseRunner();
});

test.serial(`${namespace} - unban by one identifier keeps user banned via other identifier (cache preserved)`, async ava => {
    const { t, releaseRunner } = await useTransaction();
    const { createUser, createUserPhone, createUserEmail } = testService(t);

    const userInfo = await createUser.quick();
    const phoneInfo = await createUserPhone.quick(userInfo);
    const emailInfo = await createUserEmail.quick(userInfo);

    const svc = new UserBlacklistService(ids(), t);
    await svc.banByPhone(phoneInfo.phoneNumber);

    const phoneBlacklistBefore = await userBlacklistDAO.findOne(t, ["user_uuid"], {
        phone_number: phoneInfo.phoneNumber,
    });
    ava.truthy(phoneBlacklistBefore, "phone blacklist record should exist after banByPhone");

    await svc.banByEmail(emailInfo.userEmail);

    const phoneBlacklistAfter = await userBlacklistDAO.findOne(t, ["user_uuid"], {
        phone_number: phoneInfo.phoneNumber,
    });
    ava.truthy(phoneBlacklistAfter, "phone blacklist record should survive banByEmail");

    const emailBlacklist = await userBlacklistDAO.findOne(t, ["user_uuid"], {
        email: emailInfo.userEmail.toLowerCase(),
    });
    ava.truthy(emailBlacklist, "email blacklist record should exist after banByEmail");

    await svc.unbanByPhone(phoneInfo.phoneNumber);

    ava.is(await svc.isBanned({ userUUID: userInfo.userUUID }), true);

    const user = await userDAO.findOne(t, ["is_blacklist"], {
        user_uuid: userInfo.userUUID,
    });
    ava.is(Number(user?.is_blacklist), 1);

    await releaseRunner();
});

test.serial(`${namespace} - banByUserUUID preserves existing phone ban record`, async ava => {
    const { t, releaseRunner } = await useTransaction();
    const { createUser, createUserPhone } = testService(t);

    const userInfo = await createUser.quick();
    const phoneInfo = await createUserPhone.quick(userInfo);

    const svc = new UserBlacklistService(ids(), t);
    await svc.banByPhone(phoneInfo.phoneNumber);
    await svc.banByUserUUID(userInfo.userUUID);

    const phoneBlacklist = await userBlacklistDAO.findOne(t, ["user_uuid"], {
        phone_number: phoneInfo.phoneNumber,
    });
    ava.truthy(phoneBlacklist, "phone blacklist record should survive banByUserUUID");

    ava.is(await svc.isBanned({ phone: phoneInfo.phoneNumber }), true);

    await releaseRunner();
});

test.serial(`${namespace} - banByUserUUID preserves existing email ban record`, async ava => {
    const { t, releaseRunner } = await useTransaction();
    const { createUser, createUserEmail } = testService(t);

    const userInfo = await createUser.quick();
    const emailInfo = await createUserEmail.quick(userInfo);

    const svc = new UserBlacklistService(ids(), t);
    await svc.banByEmail(emailInfo.userEmail);
    await svc.banByUserUUID(userInfo.userUUID);

    const emailBlacklist = await userBlacklistDAO.findOne(t, ["user_uuid"], {
        email: emailInfo.userEmail.toLowerCase(),
    });
    ava.truthy(emailBlacklist, "email blacklist record should survive banByUserUUID");

    ava.is(await svc.isBanned({ email: emailInfo.userEmail }), true);

    await releaseRunner();
});

test.serial(`${namespace} - banByPhone throws ParamsCheckFailed on non-digit input`, async ava => {
    const { t, releaseRunner } = await useTransaction();

    await ava.throwsAsync(
        () => new UserBlacklistService(ids(), t).banByPhone("abc"),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.ParamsCheckFailed}`,
        },
    );

    await releaseRunner();
});

test.serial(`${namespace} - unbanByPhone throws ParamsCheckFailed on non-digit input`, async ava => {
    const { t, releaseRunner } = await useTransaction();

    await ava.throwsAsync(
        () => new UserBlacklistService(ids(), t).unbanByPhone("abc"),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.ParamsCheckFailed}`,
        },
    );

    await releaseRunner();
});
