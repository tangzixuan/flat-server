import test from "ava";
import fastify, { FastifyInstance } from "fastify";
import { fastifyAuthenticate } from "../../../../plugins/fastify/authenticate";
import { Status } from "../../../../constants/Project";
import { ErrorCode } from "../../../../ErrorCode";

const namespace = "v2.controllers.admin.ban-user.auth";

const createApp = async (): Promise<FastifyInstance> => {
    const app = fastify();
    await app.register(fastifyAuthenticate);
    app.post(
        "/v2/admin/ban-user",
        {
            preValidation: [(app as any).authenticateAdmin],
        },
        async (_request, reply) => {
            return reply.send({ status: Status.Success, data: {} });
        },
    );
    return app;
};

test(`${namespace} - missing x-flat-secret returns 401`, async ava => {
    const app = await createApp();
    const resp = await app.inject({
        method: "POST",
        url: "/v2/admin/ban-user",
        payload: {},
    });

    ava.is(resp.statusCode, 401);
    const body = resp.json();
    ava.is(body.status, Status.Failed);
    ava.is(body.code, ErrorCode.NotPermission);
});

test(`${namespace} - invalid x-flat-secret returns 401`, async ava => {
    const app = await createApp();
    const resp = await app.inject({
        method: "POST",
        url: "/v2/admin/ban-user",
        headers: { "x-flat-secret": "wrong-secret" },
        payload: {},
    });

    ava.is(resp.statusCode, 401);
    const body = resp.json();
    ava.is(body.status, Status.Failed);
    ava.is(body.code, ErrorCode.NotPermission);
});

test(`${namespace} - valid x-flat-secret passes admin auth`, async ava => {
    const app = await createApp();
    const resp = await app.inject({
        method: "POST",
        url: "/v2/admin/ban-user",
        headers: { "x-flat-secret": "flat-server-test-admin" },
        payload: {},
    });

    ava.is(resp.statusCode, 200);
    ava.is(resp.json().status, Status.Success);
});
