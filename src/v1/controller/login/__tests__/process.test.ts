import test from "ava";
import { dataSource } from "../../../../thirdPartyService/TypeORMService";
import { v4 } from "uuid";
import { Status } from "../../../../constants/Project";
import { ErrorCode } from "../../../../ErrorCode";
import RedisService from "../../../../thirdPartyService/RedisService";
import { RedisKey } from "../../../../utils/Redis";
import { UserBlacklistService } from "../../../../v2/services/user/blacklist";
import { UserDAO } from "../../../../dao";
import { createLoginProcess } from "./helpers/createLoginProcess";

const namespace = "[api][api-v1][api-v1-login][api-v1-login-process]";

test.before(`${namespace} - initialize dataSource`, async () => {
    await dataSource.initialize();
});

test.after(`${namespace} - destroy dataSource`, async () => {
    await dataSource.destroy();
});

test(`${namespace} - failedReason user_blacklisted returns UserBlacklisted`, async ava => {
    const authUUID = v4();
    await RedisService.set(RedisKey.authUUID(authUUID), "1", 60 * 60);
    await RedisService.set(RedisKey.authFailed(authUUID), "user_blacklisted", 60 * 60);

    const process = createLoginProcess(authUUID);
    const result = await process.execute();

    ava.is(result.status, Status.Failed);
    ava.is((result as any).code, ErrorCode.UserBlacklisted);
});

test(`${namespace} - blacklisted userUUID in authUserInfo rejected`, async ava => {
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

    const authUUID = v4();
    await RedisService.set(RedisKey.authUUID(authUUID), "1", 60 * 60);
    await RedisService.set(
        RedisKey.authUserInfo(authUUID),
        JSON.stringify({
            name: "test",
            avatar: "xxx",
            userUUID,
            token: "fake-token",
            hasPhone: false,
            hasPassword: false,
        }),
        60 * 60,
    );

    const process = createLoginProcess(authUUID);
    try {
        await process.execute();
    } catch (error) {
        ava.is(process.errorHandler(error as Error).code, ErrorCode.UserBlacklisted);
    }
});

test(`${namespace} - non-blacklisted user gets token from authUserInfo`, async ava => {
    const userUUID = v4();
    await UserDAO().insert({
        user_uuid: userUUID,
        user_name: "test_name",
        avatar_url: "xxx",
        user_password: "",
    });

    const authUUID = v4();
    await RedisService.set(RedisKey.authUUID(authUUID), "1", 60 * 60);
    const userInfo = {
        name: "test",
        avatar: "xxx",
        userUUID,
        token: "fake-token",
        hasPhone: false,
        hasPassword: false,
    };
    await RedisService.set(RedisKey.authUserInfo(authUUID), JSON.stringify(userInfo), 60 * 60);

    const process = createLoginProcess(authUUID);
    const result = await process.execute();

    ava.is(result.status, Status.Success);
    ava.is((result as any).data.userUUID, userUUID);
});
