import test from "ava";
import fastify from "fastify";
import { In } from "typeorm";
import { registerAdminBlacklistWeb } from "../blacklist-web";
import { fastifyAuthenticate } from "../../plugins/fastify/authenticate";
import { dataSource } from "../../thirdPartyService/TypeORMService";
import { AdminAccountModel } from "../../model/admin/AdminAccount";
import { adminPasswordHash } from "../../v2/services/admin/account";
import { initializeDataSource } from "../../v2/__tests__/helpers/db/test-hooks";
import { Status } from "../../constants/Project";
import { ErrorCode } from "../../ErrorCode";
import { UserBlacklistModel } from "../../model/user/Blacklist";

const namespace = "admin.blacklist-web";
const username = "admin-web-test";
const password = "admin-web-test-password";
const salt = "admin-web-test-salt";
const phone = "8613800999000";
const phone2 = "8613800999001";
const pagePhones = ["8613800999002", "8613800999003", "8613800999004"];
const email = "admin-web-test@example.com";
const userUUID = "11111111-1111-4111-8111-111111111111";

initializeDataSource(test, namespace);

const createApp = async () => {
    const app = fastify();
    await app.register(fastifyAuthenticate);
    registerAdminBlacklistWeb(app as any);
    return app;
};

const seedAdmin = async (): Promise<void> => {
    const repo = dataSource.manager.getRepository(AdminAccountModel);
    await repo.delete({ username });
    await repo.insert({
        username,
        password_hash: adminPasswordHash(password, salt),
        password_salt: salt,
        is_delete: false,
        last_login_at: null,
    });
};

const cleanup = async (): Promise<void> => {
    await dataSource.manager.getRepository(AdminAccountModel).delete({ username });
    await dataSource.manager.getRepository(UserBlacklistModel).delete({
        phone_number: In([phone, phone2, ...pagePhones]),
    });
    await dataSource.manager.getRepository(UserBlacklistModel).delete({ email });
    await dataSource.manager.getRepository(UserBlacklistModel).delete({ user_uuid: userUUID });
};

const cookieFrom = (setCookie: string | string[] | number | undefined): string => {
    if (Array.isArray(setCookie)) {
        return setCookie[0];
    }
    return String(setCookie || "");
};

test.serial(`${namespace} - unauthenticated search returns 401`, async ava => {
    const app = await createApp();
    const resp = await app.inject({
        method: "POST",
        url: "/admin/api/blacklist/search",
        payload: { phones: [phone] },
    });

    ava.is(resp.statusCode, 401);
    ava.is(resp.json().status, Status.Failed);
    ava.is(resp.json().code, ErrorCode.NotPermission);
});

test.serial(`${namespace} - login imports removes phone and search reflects it`, async ava => {
    await cleanup();
    await seedAdmin();
    const app = await createApp();

    const loginResp = await app.inject({
        method: "POST",
        url: "/admin/api/login",
        payload: { username, password },
    });
    ava.is(loginResp.statusCode, 200);
    ava.is(loginResp.json().status, Status.Success);
    const cookie = cookieFrom(loginResp.headers["set-cookie"]);
    ava.truthy(cookie);

    const importResp = await app.inject({
        method: "POST",
        url: "/admin/api/blacklist/import",
        headers: { cookie },
        payload: { phones: [phone, phone2], reason: "WB-432 smoke test" },
    });
    ava.is(importResp.statusCode, 200);
    ava.is(importResp.json().status, Status.Success);
    ava.is(importResp.json().data.count, 2);

    const searchResp = await app.inject({
        method: "POST",
        url: "/admin/api/blacklist/search",
        headers: { cookie },
        payload: { phones: [phone, phone2] },
    });
    ava.is(searchResp.statusCode, 200);
    const searchBody = searchResp.json();
    ava.is(searchBody.status, Status.Success);
    ava.true(searchBody.data.items[0].banned);
    ava.is(searchBody.data.items[0].normalized, phone);
    ava.true(searchBody.data.items[1].banned);
    ava.is(searchBody.data.items[1].normalized, phone2);

    const removeResp = await app.inject({
        method: "POST",
        url: "/admin/api/blacklist/remove",
        headers: { cookie },
        payload: { phones: [phone, phone2] },
    });
    ava.is(removeResp.statusCode, 200);
    ava.is(removeResp.json().status, Status.Success);

    const searchAfterRemoveResp = await app.inject({
        method: "POST",
        url: "/admin/api/blacklist/search",
        headers: { cookie },
        payload: { phones: [phone, phone2] },
    });
    ava.is(searchAfterRemoveResp.statusCode, 200);
    const searchAfterRemoveBody = searchAfterRemoveResp.json();
    ava.is(searchAfterRemoveBody.status, Status.Success);
    ava.false(searchAfterRemoveBody.data.items[0].banned);
    ava.false(searchAfterRemoveBody.data.items[1].banned);

    await cleanup();
});

test.serial(`${namespace} - empty search lists paginated records by type`, async ava => {
    await cleanup();
    await seedAdmin();
    const app = await createApp();

    const loginResp = await app.inject({
        method: "POST",
        url: "/admin/api/login",
        payload: { username, password },
    });
    const cookie = cookieFrom(loginResp.headers["set-cookie"]);

    await dataSource.manager.getRepository(UserBlacklistModel).insert([
        ...pagePhones.map(p => ({
            phone_number: p,
            user_uuid: null,
            email: null,
            reason: "WB-432 page test",
            operator: username,
            is_delete: false,
        })),
        {
            phone_number: null,
            user_uuid: null,
            email,
            reason: "WB-432 page test",
            operator: username,
            is_delete: false,
        },
        {
            phone_number: null,
            user_uuid: userUUID,
            email: null,
            reason: "WB-432 page test",
            operator: username,
            is_delete: false,
        },
    ]);

    const phoneListResp = await app.inject({
        method: "POST",
        url: "/admin/api/blacklist/search",
        headers: { cookie },
        payload: { phones: [], page: 1, pageSize: 2 },
    });
    ava.is(phoneListResp.statusCode, 200);
    const phoneListBody = phoneListResp.json();
    ava.is(phoneListBody.status, Status.Success);
    ava.true(phoneListBody.data.pagination.total >= pagePhones.length);
    ava.is(phoneListBody.data.pagination.pageSize, 2);
    ava.is(phoneListBody.data.items.length, 2);
    ava.true(phoneListBody.data.items.every((item: any) => item.type === "phone"));
    ava.true(phoneListBody.data.items.every((item: any) => item.banned));

    const emailListResp = await app.inject({
        method: "POST",
        url: "/admin/api/blacklist/search",
        headers: { cookie },
        payload: { emails: [], page: 1, pageSize: 20 },
    });
    const emailListBody = emailListResp.json();
    ava.is(emailListBody.status, Status.Success);
    ava.true(emailListBody.data.items.some((item: any) => item.normalized === email));

    const uuidListResp = await app.inject({
        method: "POST",
        url: "/admin/api/blacklist/search",
        headers: { cookie },
        payload: { userUUIDs: [], page: 1, pageSize: 20 },
    });
    const uuidListBody = uuidListResp.json();
    ava.is(uuidListBody.status, Status.Success);
    ava.true(uuidListBody.data.items.some((item: any) => item.normalized === userUUID));

    await cleanup();
});
