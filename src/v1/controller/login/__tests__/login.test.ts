import test from "ava";
import { dataSource } from "../../../../thirdPartyService/TypeORMService";
import { v4 } from "uuid";
import { Status } from "../../../../constants/Project";
import { ErrorCode } from "../../../../ErrorCode";
import { UserBlacklistService } from "../../../../v2/services/user/blacklist";
import { UserDAO, UserPhoneDAO } from "../../../../dao";
import { UserBlacklistModel } from "../../../../model/user/Blacklist";
import { createLogin } from "./helpers/createLogin";

const namespace = "[api][api-v1][api-v1-login][api-v1-login-login]";

test.before(`${namespace} - initialize dataSource`, async () => {
    await dataSource.initialize();
});

test.after(`${namespace} - destroy dataSource`, async () => {
    await dataSource.destroy();
});

test(`${namespace} - blacklisted user refresh JWT rejected`, async ava => {
    ava.plan(1);

    const userUUID = v4();
    await UserDAO().insert({
        user_uuid: userUUID,
        user_name: "test_name",
        avatar_url: "xxx",
        user_password: "",
    });
    await new UserBlacklistService(
        { reqID: v4(), sesID: v4() },
        dataSource.manager,
    ).banByUserUUID(userUUID);

    const login = createLogin(userUUID);
    try {
        await login.execute();
    } catch (error) {
        ava.is(login.errorHandler(error as Error).code, ErrorCode.UserBlacklisted);
    }
});

test(`${namespace} - refresh JWT rejected when bound phone is blacklisted without userUUID`, async ava => {
    ava.plan(1);

    const userUUID = v4();
    const phone = `+86188${v4().replace(/\D/g, "").padEnd(8, "0").slice(0, 8)}`;
    await UserDAO().insert({
        user_uuid: userUUID,
        user_name: "test_name",
        avatar_url: "xxx",
        user_password: "",
    });
    await UserPhoneDAO().insert({
        user_uuid: userUUID,
        user_name: "test_name",
        phone_number: phone,
    });
    await dataSource.manager.getRepository(UserBlacklistModel).insert({
        user_uuid: null,
        phone_number: phone.replace(/\D/g, ""),
        email: null,
        reason: null,
        operator: null,
    });

    const login = createLogin(userUUID);
    try {
        await login.execute();
    } catch (error) {
        ava.is(login.errorHandler(error as Error).code, ErrorCode.UserBlacklisted);
    }
});

test(`${namespace} - non-blacklisted user passes blacklist check`, async ava => {
    const userUUID = v4();
    await UserDAO().insert({
        user_uuid: userUUID,
        user_name: "test_name",
        avatar_url: "xxx",
        user_password: "",
    });

    const login = createLogin(userUUID);
    // The call will proceed past blacklist check and fail later on GitHub service
    // (since GitHub is not configured in test), but the important thing is it
    // does NOT fail with UserBlacklisted.
    try {
        await login.execute();
        ava.pass();
    } catch (error) {
        const err = login.errorHandler(error as Error);
        ava.not(err.code, ErrorCode.UserBlacklisted);
        ava.is(err.status, Status.Failed);
    }
});
