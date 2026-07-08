import test from "ava";
import fastify from "fastify";
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
    await dataSource.manager.getRepository(UserBlacklistModel).delete({ phone_number: phone });
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
        payload: { phones: [phone], reason: "WB-432 smoke test" },
    });
    ava.is(importResp.statusCode, 200);
    ava.is(importResp.json().status, Status.Success);

    const searchResp = await app.inject({
        method: "POST",
        url: "/admin/api/blacklist/search",
        headers: { cookie },
        payload: { phones: [phone] },
    });
    ava.is(searchResp.statusCode, 200);
    const searchBody = searchResp.json();
    ava.is(searchBody.status, Status.Success);
    ava.true(searchBody.data.items[0].banned);
    ava.is(searchBody.data.items[0].normalized, phone);

    const removeResp = await app.inject({
        method: "POST",
        url: "/admin/api/blacklist/remove",
        headers: { cookie },
        payload: { phones: [phone] },
    });
    ava.is(removeResp.statusCode, 200);
    ava.is(removeResp.json().status, Status.Success);

    const searchAfterRemoveResp = await app.inject({
        method: "POST",
        url: "/admin/api/blacklist/search",
        headers: { cookie },
        payload: { phones: [phone] },
    });
    ava.is(searchAfterRemoveResp.statusCode, 200);
    const searchAfterRemoveBody = searchAfterRemoveResp.json();
    ava.is(searchAfterRemoveBody.status, Status.Success);
    ava.false(searchAfterRemoveBody.data.items[0].banned);

    await cleanup();
});
