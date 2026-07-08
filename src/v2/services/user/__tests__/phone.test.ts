import test from "ava";
import { v4 } from "uuid";
import { Status } from "../../../../constants/Project";
import { FError } from "../../../../error/ControllerError";
import { ErrorCode } from "../../../../ErrorCode";
import RedisService from "../../../../thirdPartyService/RedisService";
import { hash } from "../../../../utils/Hash";
import { RedisKey } from "../../../../utils/Redis";
import { MessageExpirationSecond } from "../../../constants";
import { userDAO, userPhoneDAO } from "../../../dao";
import { testService } from "../../../__tests__/helpers/db";
import { useTransaction } from "../../../__tests__/helpers/db/query-runner";
import { initializeDataSource } from "../../../__tests__/helpers/db/test-hooks";
import { randomPhoneNumber } from "../../../__tests__/helpers/db/user-phone";
import { ids } from "../../../__tests__/helpers/fastify/ids";
import { UserPhoneService } from "../phone";
import { UserBlacklistService } from "../blacklist";

const namespace = "v2.services.user.phone";
initializeDataSource(test, namespace);

test.serial(`${namespace} - user already registered in send message`, async ava => {
    const { t, releaseRunner } = await useTransaction();
    const { createUser, createUserPhone } = testService(t);

    const userInfo = await createUser.quick();
    const userPhoneInfo = await createUserPhone.quick(userInfo);

    await ava.throwsAsync(
        () => new UserPhoneService(ids(), t).sendMessageForRegister(userPhoneInfo.phoneNumber),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.SMSAlreadyExist}`,
        },
    );

    await releaseRunner();
});

test.serial(`${namespace} - user not found in send message for reset`, async ava => {
    const { t, releaseRunner } = await useTransaction();

    await ava.throwsAsync(
        () => new UserPhoneService(ids(), t).sendMessageForReset(randomPhoneNumber()),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.UserNotFound}`,
        },
    );

    await releaseRunner();
});

test.serial(`${namespace} - user phone already registered`, async ava => {
    const { t, releaseRunner } = await useTransaction();
    const { createUser, createUserPhone } = testService(t);

    const userInfo = await createUser.quick();
    const userPhoneInfo = await createUserPhone.quick(userInfo);

    RedisService.set(
        RedisKey.phoneRegisterOrReset(userPhoneInfo.phoneNumber),
        "666666",
        MessageExpirationSecond,
    );

    await ava.throwsAsync(
        () =>
            new UserPhoneService(ids(), t).register(
                userPhoneInfo.phoneNumber,
                666666,
                v4(),
                async () => "",
            ),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.SMSAlreadyExist}`,
        },
    );

    await releaseRunner();
});

test.serial(`${namespace} - user phone register success`, async ava => {
    const { t, releaseRunner } = await useTransaction();

    const phoneNumber = randomPhoneNumber();
    RedisService.set(RedisKey.phoneRegisterOrReset(phoneNumber), "666666", MessageExpirationSecond);

    const password = v4();
    const { userUUID } = await new UserPhoneService(ids(), t).register(
        phoneNumber,
        666666,
        password,
        async () => "",
    );

    const userInfo = await userDAO.findOne(t, ["user_password"], { user_uuid: userUUID });
    ava.not(userInfo, null);
    ava.is(userInfo?.user_password, hash(password));

    const userPhoneInfo = await userPhoneDAO.findOne(t, ["id"], { phone_number: phoneNumber });
    ava.not(userPhoneInfo, null);

    await releaseRunner();
});

test.serial(`${namespace} - user phone not found in reset`, async ava => {
    const { t, releaseRunner } = await useTransaction();

    const phoneNumber = randomPhoneNumber();
    RedisService.set(RedisKey.phoneRegisterOrReset(phoneNumber), "666666", MessageExpirationSecond);

    const password = v4();

    await ava.throwsAsync(
        () => new UserPhoneService(ids(), t).reset(phoneNumber, 666666, password),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.UserNotFound}`,
        },
    );

    await releaseRunner();
});

test.serial(`${namespace} - user phone reset success`, async ava => {
    const { t, releaseRunner } = await useTransaction();
    const { createUser, createUserPhone } = testService(t);

    const userInfo = await createUser.quick();
    const userPhoneInfo = await createUserPhone.quick(userInfo);

    RedisService.set(
        RedisKey.phoneRegisterOrReset(userPhoneInfo.phoneNumber),
        "666666",
        MessageExpirationSecond,
    );

    const password = v4();

    await new UserPhoneService(ids(), t).reset(userPhoneInfo.phoneNumber, 666666, password);

    const newUserInfo = await userDAO.findOne(t, ["user_password"], {
        user_uuid: userInfo.userUUID,
    });
    ava.not(newUserInfo, null);
    ava.is(newUserInfo?.user_password, hash(password));

    await releaseRunner();
});

test.serial(`${namespace} - user phone not found in login`, async ava => {
    const { t, releaseRunner } = await useTransaction();
    const { createUser, createUserPhone } = testService(t);

    await ava.throwsAsync(
        () => new UserPhoneService(ids(), t).login(randomPhoneNumber(), v4(), async () => ""),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.UserOrPasswordIncorrect}`,
        },
    );

    const userInfo = await createUser.quick({ userPassword: "" });
    const userPhoneInfo = await createUserPhone.quick(userInfo);

    await ava.throwsAsync(
        () => new UserPhoneService(ids(), t).login(userPhoneInfo.phoneNumber, v4(), async () => ""),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.UserOrPasswordIncorrect}`,
        },
    );

    await releaseRunner();
});

test.serial(`${namespace} - user phone wrong password`, async ava => {
    const { t, releaseRunner } = await useTransaction();
    const { createUser, createUserPhone } = testService(t);

    const userInfo = await createUser.quick();
    const userPhoneInfo = await createUserPhone.quick(userInfo);

    await ava.throwsAsync(
        () => new UserPhoneService(ids(), t).login(userPhoneInfo.phoneNumber, v4(), async () => ""),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.UserOrPasswordIncorrect}`,
        },
    );

    await releaseRunner();
});

test.serial(`${namespace} - user phone login success`, async ava => {
    const { t, releaseRunner } = await useTransaction();
    const { createUser, createUserPhone } = testService(t);

    const password = v4();
    const userInfo = await createUser.quick({ userPassword: hash(password) });
    const userPhoneInfo = await createUserPhone.quick(userInfo);

    const result = await new UserPhoneService(ids(), t).login(
        userPhoneInfo.phoneNumber,
        password,
        async () => "",
    );

    ava.is(result.userUUID, userInfo.userUUID);
    ava.is(result.hasPhone, true);

    await releaseRunner();
});

test.serial(`${namespace} - blacklisted phone register rejected`, async ava => {
    const { t, releaseRunner } = await useTransaction();

    const phoneNumber = randomPhoneNumber();
    RedisService.set(RedisKey.phoneRegisterOrReset(phoneNumber), "666666", MessageExpirationSecond);

    await new UserBlacklistService(ids(), t).banByPhone(phoneNumber);

    await ava.throwsAsync(
        () =>
            new UserPhoneService(ids(), t).register(
                phoneNumber,
                666666,
                v4(),
                async () => "",
            ),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.UserBlacklisted}`,
        },
    );

    await releaseRunner();
});

test.serial(`${namespace} - blacklisted phone login rejected`, async ava => {
    const { t, releaseRunner } = await useTransaction();
    const { createUser, createUserPhone } = testService(t);

    const password = v4();
    const userInfo = await createUser.quick({ userPassword: hash(password) });
    const userPhoneInfo = await createUserPhone.quick(userInfo);

    await new UserBlacklistService(ids(), t).banByPhone(userPhoneInfo.phoneNumber);

    await ava.throwsAsync(
        () =>
            new UserPhoneService(ids(), t).login(
                userPhoneInfo.phoneNumber,
                password,
                async () => "",
            ),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.UserBlacklisted}`,
        },
    );

    await releaseRunner();
});

test.serial(`${namespace} - blacklisted phone sendMessageForRegister rejected`, async ava => {
    const { t, releaseRunner } = await useTransaction();

    const phoneNumber = randomPhoneNumber();
    await new UserBlacklistService(ids(), t).banByPhone(phoneNumber);

    await ava.throwsAsync(
        () => new UserPhoneService(ids(), t).sendMessageForRegister(phoneNumber),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.UserBlacklisted}`,
        },
    );

    await releaseRunner();
});

test.serial(`${namespace} - blacklisted phone sendMessageForReset rejected`, async ava => {
    const { t, releaseRunner } = await useTransaction();
    const { createUser, createUserPhone } = testService(t);

    const userInfo = await createUser.quick();
    const userPhoneInfo = await createUserPhone.quick(userInfo);
    await new UserBlacklistService(ids(), t).banByPhone(userPhoneInfo.phoneNumber);

    await ava.throwsAsync(
        () => new UserPhoneService(ids(), t).sendMessageForReset(userPhoneInfo.phoneNumber),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.UserBlacklisted}`,
        },
    );

    await releaseRunner();
});

test.serial(`${namespace} - blacklisted phone reset rejected`, async ava => {
    const { t, releaseRunner } = await useTransaction();
    const { createUser, createUserPhone } = testService(t);

    const userInfo = await createUser.quick();
    const userPhoneInfo = await createUserPhone.quick(userInfo);
    await new UserBlacklistService(ids(), t).banByPhone(userPhoneInfo.phoneNumber);

    RedisService.set(
        RedisKey.phoneRegisterOrReset(userPhoneInfo.phoneNumber),
        "666666",
        MessageExpirationSecond,
    );

    await ava.throwsAsync(
        () =>
            new UserPhoneService(ids(), t).reset(userPhoneInfo.phoneNumber, 666666, v4()),
        {
            instanceOf: FError,
            message: `${Status.Failed}: ${ErrorCode.UserBlacklisted}`,
        },
    );

    await releaseRunner();
});
