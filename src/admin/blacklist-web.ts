import { FastifyReply, FastifyRequest } from "fastify";
import { FindOptionsWhere, In } from "typeorm";
import { ErrorCode } from "../ErrorCode";
import { Status } from "../constants/Project";
import { FError } from "../error/ControllerError";
import { UserBlacklistModel } from "../model/user/Blacklist";
import { dataSource } from "../thirdPartyService/TypeORMService";
import { FastifyInstance } from "../types/Server";
import {
    UserBlacklistService,
    normalizeBlacklistEmail,
    normalizeBlacklistPhone,
} from "../v2/services/user/blacklist";
import { AdminAccountService } from "../v2/services/admin/account";

const ADMIN_COOKIE_NAME = "flat_admin_token";
const ADMIN_SESSION_SECONDS = 60 * 60 * 12;
const MAX_BATCH_SIZE = 500;
const PHONE_MAX_LENGTH = 50;
const EMAIL_MAX_LENGTH = 100;
const REASON_MAX_LENGTH = 255;
const UUID_V4_REGEXP = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_REGEXP = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type JWTApp = FastifyInstance & {
    jwt: {
        sign: (payload: Record<string, unknown>, options?: { expiresIn?: string }) => Promise<string>;
        verify: <T>(token: string) => Promise<T>;
    };
};

type AdminSession = {
    flatAdmin: true;
    username: string;
};

type IdentifierKind = "phone" | "email" | "userUUID";

type ParsedIdentifierBatch = {
    kind: IdentifierKind;
    values: string[];
    items: Array<{
        input: string;
        normalized: string;
    }>;
};

type UserBlacklistDTO = {
    userUUID: string | null;
    phone: string | null;
    email: string | null;
    reason: string | null;
    operator: string | null;
    createdAt: string | null;
    updatedAt: string | null;
};

type UserBlacklistSearchItem = {
    type: IdentifierKind;
    input: string;
    normalized: string;
    banned: boolean;
    records: UserBlacklistDTO[];
};

export const registerAdminBlacklistWeb = (app: FastifyInstance): void => {
    app.get("/admin", async (_request, reply) => {
        return reply.redirect("/admin/blacklist");
    });

    app.get("/admin/blacklist", async (_request, reply) => {
        return reply.type("text/html; charset=utf-8").send(ADMIN_BLACKLIST_HTML);
    });

    app.get("/admin/api/session", async (request, reply) => {
        const session = await requireAdminSession(app, request, reply);
        if (!session) return reply;

        return reply.send(successJSON({ username: session.username }));
    });

    app.post("/admin/api/login", async (request, reply) => {
        try {
            const body = request.body as { username?: string; password?: string } | undefined;
            const username = body?.username?.trim() || "";
            const password = body?.password || "";
            if (!username || !password) {
                throw new FError(ErrorCode.ParamsCheckFailed);
            }

            const login = await dataSource.transaction(async t => {
                return await new AdminAccountService(t).login(username, password);
            });

            if (!login) {
                return reply.code(401).send(failJSON(ErrorCode.NotPermission));
            }

            const token = await (app as JWTApp).jwt.sign(
                {
                    flatAdmin: true,
                    username: login.username,
                },
                { expiresIn: `${ADMIN_SESSION_SECONDS}s` },
            );

            setAdminCookie(reply, token);
            return reply.send(successJSON({ username: login.username }));
        } catch (error) {
            return sendAdminError(reply, error);
        }
    });

    app.post("/admin/api/logout", async (_request, reply) => {
        clearAdminCookie(reply);
        return reply.send(successJSON({}));
    });

    app.post("/admin/api/blacklist/search", async (request, reply) => {
        const session = await requireAdminSession(app, request, reply);
        if (!session) return reply;

        try {
            const parsed = parseIdentifierBatch(request.body);
            const items = await searchBlacklist(parsed);
            return reply.send(successJSON({ items }));
        } catch (error) {
            return sendAdminError(reply, error);
        }
    });

    app.post("/admin/api/blacklist/import", async (request, reply) => {
        const session = await requireAdminSession(app, request, reply);
        if (!session) return reply;

        try {
            const body = request.body as { reason?: string } | undefined;
            const parsed = parseIdentifierBatch(request.body);
            const reason = body?.reason?.trim() || undefined;
            if (reason && reason.length > REASON_MAX_LENGTH) {
                throw new FError(ErrorCode.ParamsCheckFailed);
            }
            const operator = session.username.slice(0, 40);

            await dataSource.transaction(async t => {
                const service = new UserBlacklistService(requestIDS(request), t);
                if (parsed.kind === "phone") {
                    await service.banByPhones(parsed.values, reason, operator);
                } else if (parsed.kind === "email") {
                    await service.banByEmails(parsed.values, reason, operator);
                } else {
                    await service.banByUserUUIDs(parsed.values, reason, operator);
                }
            });

            return reply.send(successJSON({
                type: parsed.kind,
                count: parsed.values.length,
            }));
        } catch (error) {
            return sendAdminError(reply, error);
        }
    });

    app.post("/admin/api/blacklist/remove", async (request, reply) => {
        const session = await requireAdminSession(app, request, reply);
        if (!session) return reply;

        try {
            const parsed = parseIdentifierBatch(request.body);

            await dataSource.transaction(async t => {
                const service = new UserBlacklistService(requestIDS(request), t);
                if (parsed.kind === "phone") {
                    await service.unbanByPhones(parsed.values);
                } else if (parsed.kind === "email") {
                    await service.unbanByEmails(parsed.values);
                } else {
                    await service.unbanByUserUUIDs(parsed.values);
                }
            });

            return reply.send(successJSON({
                type: parsed.kind,
                count: parsed.values.length,
            }));
        } catch (error) {
            return sendAdminError(reply, error);
        }
    });
};

const requestIDS = (request: FastifyRequest): IDS => {
    const ids = request as FastifyRequest & { reqID?: string; sesID?: string };
    return {
        reqID: ids.reqID || "",
        sesID: ids.sesID || "",
    };
};

const requireAdminSession = async (
    app: FastifyInstance,
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<AdminSession | null> => {
    const token = parseCookie(request.headers.cookie || "")[ADMIN_COOKIE_NAME];
    if (!token) {
        await reply.code(401).send(failJSON(ErrorCode.NotPermission));
        return null;
    }

    try {
        const payload = await (app as JWTApp).jwt.verify<Partial<AdminSession>>(token);
        if (payload.flatAdmin !== true || typeof payload.username !== "string") {
            throw new Error("invalid admin session");
        }
        return {
            flatAdmin: true,
            username: payload.username,
        };
    } catch (_error) {
        clearAdminCookie(reply);
        await reply.code(401).send(failJSON(ErrorCode.NotPermission));
        return null;
    }
};

const parseCookie = (cookieHeader: string): Record<string, string> => {
    const cookies: Record<string, string> = {};
    for (const part of cookieHeader.split(";")) {
        const [name, ...valueParts] = part.trim().split("=");
        if (!name || valueParts.length === 0) continue;
        cookies[name] = decodeURIComponent(valueParts.join("="));
    }
    return cookies;
};

const setAdminCookie = (reply: FastifyReply, token: string): void => {
    reply.header(
        "Set-Cookie",
        `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_SESSION_SECONDS}`,
    );
};

const clearAdminCookie = (reply: FastifyReply): void => {
    reply.header(
        "Set-Cookie",
        `${ADMIN_COOKIE_NAME}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`,
    );
};

const parseIdentifierBatch = (body: unknown): ParsedIdentifierBatch => {
    const payload = body as {
        phones?: unknown;
        emails?: unknown;
        userUUIDs?: unknown;
    } | undefined;

    const candidates: Array<{
        kind: IdentifierKind;
        raw: unknown;
    }> = [
        { kind: "phone", raw: payload?.phones },
        { kind: "email", raw: payload?.emails },
        { kind: "userUUID", raw: payload?.userUUIDs },
    ];

    const nonEmpty = candidates
        .map(candidate => ({
            ...candidate,
            values: readStringArray(candidate.raw),
        }))
        .filter(candidate => candidate.values.length > 0);

    if (nonEmpty.length !== 1) {
        throw new FError(ErrorCode.ParamsCheckFailed);
    }

    const selected = nonEmpty[0];
    const items = selected.values.map(input => ({
        input,
        normalized: normalizeIdentifier(selected.kind, input),
    }));
    const uniqueItems = dedupeItems(items);

    if (uniqueItems.length > MAX_BATCH_SIZE) {
        throw new FError(ErrorCode.ParamsCheckFailed);
    }

    return {
        kind: selected.kind,
        values: uniqueItems.map(item => item.normalized),
        items: uniqueItems,
    };
};

const readStringArray = (value: unknown): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        throw new FError(ErrorCode.ParamsCheckFailed);
    }
    return value
        .filter((item): item is string => typeof item === "string")
        .map(item => item.trim())
        .filter(Boolean);
};

const normalizeIdentifier = (kind: IdentifierKind, value: string): string => {
    if (kind === "phone") {
        const phone = normalizeBlacklistPhone(value);
        if (phone.length > PHONE_MAX_LENGTH) {
            throw new FError(ErrorCode.ParamsCheckFailed);
        }
        return phone;
    }
    if (kind === "email") {
        const email = normalizeBlacklistEmail(value);
        if (email.length > EMAIL_MAX_LENGTH || !EMAIL_REGEXP.test(email)) {
            throw new FError(ErrorCode.ParamsCheckFailed);
        }
        return email;
    }

    const uuid = value.toLowerCase();
    if (!UUID_V4_REGEXP.test(uuid)) {
        throw new FError(ErrorCode.ParamsCheckFailed);
    }
    return uuid;
};

const dedupeItems = (
    items: Array<{ input: string; normalized: string }>,
): Array<{ input: string; normalized: string }> => {
    const seen = new Set<string>();
    const uniqueItems: Array<{ input: string; normalized: string }> = [];
    for (const item of items) {
        if (seen.has(item.normalized)) continue;
        seen.add(item.normalized);
        uniqueItems.push(item);
    }
    return uniqueItems;
};

const searchBlacklist = async (
    parsed: ParsedIdentifierBatch,
): Promise<UserBlacklistSearchItem[]> => {
    const rows = await dataSource.manager.getRepository(UserBlacklistModel).find({
        where: searchWhere(parsed),
        select: [
            "user_uuid",
            "phone_number",
            "email",
            "reason",
            "operator",
            "created_at",
            "updated_at",
        ],
    });

    const recordsByValue = new Map<string, UserBlacklistDTO[]>();
    for (const row of rows) {
        const key = recordKey(parsed.kind, row);
        if (!key) continue;
        const records = recordsByValue.get(key) || [];
        records.push(toBlacklistDTO(row));
        recordsByValue.set(key, records);
    }

    return parsed.items.map(item => {
        const records = recordsByValue.get(item.normalized) || [];
        return {
            type: parsed.kind,
            input: item.input,
            normalized: item.normalized,
            banned: records.length > 0,
            records,
        };
    });
};

const searchWhere = (
    parsed: ParsedIdentifierBatch,
): FindOptionsWhere<UserBlacklistModel> => {
    if (parsed.kind === "phone") {
        return {
            phone_number: In(parsed.values),
            is_delete: false,
        };
    }
    if (parsed.kind === "email") {
        return {
            email: In(parsed.values),
            is_delete: false,
        };
    }
    return {
        user_uuid: In(parsed.values),
        is_delete: false,
    };
};

const recordKey = (
    kind: IdentifierKind,
    record: UserBlacklistModel,
): string | null => {
    if (kind === "phone") return record.phone_number;
    if (kind === "email") return record.email;
    return record.user_uuid;
};

const toBlacklistDTO = (record: UserBlacklistModel): UserBlacklistDTO => {
    return {
        userUUID: record.user_uuid,
        phone: record.phone_number,
        email: record.email,
        reason: record.reason,
        operator: record.operator,
        createdAt: toISOString(record.created_at),
        updatedAt: toISOString(record.updated_at),
    };
};

const toISOString = (date: Date | string | null | undefined): string | null => {
    if (!date) return null;
    if (date instanceof Date) return date.toISOString();
    return date;
};

const successJSON = <T>(data: T): { status: Status.Success; data: T } => {
    return {
        status: Status.Success,
        data,
    };
};

const failJSON = (code: ErrorCode): { status: Status.Failed; code: ErrorCode } => {
    return {
        status: Status.Failed,
        code,
    };
};

const sendAdminError = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof FError) {
        return reply.send({
            status: error.status,
            code: error.errorCode,
        });
    }

    return reply.send(failJSON(ErrorCode.CurrentProcessFailed));
};

const ADMIN_BLACKLIST_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flat 黑名单管理</title>
<style>
:root {
  color-scheme: light;
  --bg: #f6f7f9;
  --panel: #ffffff;
  --text: #18202a;
  --muted: #667085;
  --line: #d9dee7;
  --accent: #1f7a5f;
  --accent-strong: #115c46;
  --danger: #b42318;
  --success-bg: #e8f5ef;
  --danger-bg: #fff1f0;
  --shadow: 0 12px 30px rgba(16, 24, 40, 0.08);
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--text);
}
button, input, textarea {
  font: inherit;
}
.page {
  min-height: 100vh;
}
.login-wrap {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
}
.login-panel {
  width: min(420px, 100%);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: var(--shadow);
  padding: 28px;
}
.login-panel h1, .app-title h1 {
  margin: 0;
  font-size: 22px;
  letter-spacing: 0;
}
.login-panel p, .app-title p {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 14px;
}
.field {
  display: grid;
  gap: 8px;
  margin-top: 18px;
}
label {
  color: #344054;
  font-size: 13px;
  font-weight: 600;
}
input, textarea {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #fff;
  color: var(--text);
  padding: 10px 12px;
  outline: none;
}
textarea {
  min-height: 180px;
  resize: vertical;
  line-height: 1.5;
}
input:focus, textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(31, 122, 95, 0.16);
}
.topbar {
  height: 68px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 28px;
  background: #fff;
  border-bottom: 1px solid var(--line);
}
.app-title h1 {
  font-size: 18px;
}
.content {
  width: min(1180px, calc(100vw - 32px));
  margin: 22px auto 44px;
  display: grid;
  gap: 16px;
}
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.segmented {
  display: inline-grid;
  grid-auto-flow: column;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
  overflow: hidden;
}
.segmented button {
  border: 0;
  border-right: 1px solid var(--line);
  background: transparent;
  padding: 9px 14px;
  min-width: 92px;
  cursor: pointer;
  color: #344054;
}
.segmented button:last-child {
  border-right: 0;
}
.segmented button.active {
  background: var(--accent);
  color: #fff;
}
.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: var(--shadow);
  padding: 18px;
}
.grid {
  display: grid;
  grid-template-columns: minmax(280px, 390px) 1fr;
  gap: 16px;
  align-items: start;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
}
.button {
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 10px 14px;
  min-height: 40px;
  cursor: pointer;
  background: var(--accent);
  color: #fff;
  font-weight: 600;
}
.button:hover {
  background: var(--accent-strong);
}
.button.secondary {
  background: #fff;
  color: #344054;
  border-color: var(--line);
}
.button.secondary:hover {
  background: #f9fafb;
}
.button.compact {
  min-height: 32px;
  padding: 6px 10px;
}
.button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.message {
  min-height: 22px;
  margin-top: 12px;
  color: var(--muted);
  font-size: 14px;
}
.message.error {
  color: var(--danger);
}
.message.ok {
  color: var(--accent-strong);
}
.summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}
.metric {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px;
  background: #fbfcfd;
}
.metric strong {
  display: block;
  font-size: 22px;
}
.metric span {
  color: var(--muted);
  font-size: 12px;
}
table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  background: #fff;
}
th, td {
  border-bottom: 1px solid var(--line);
  padding: 10px;
  text-align: left;
  vertical-align: top;
  font-size: 13px;
  word-break: break-word;
}
th {
  color: #475467;
  background: #f9fafb;
  font-weight: 700;
}
.badge {
  display: inline-block;
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 12px;
  font-weight: 700;
}
.badge.ok {
  color: var(--accent-strong);
  background: var(--success-bg);
}
.badge.no {
  color: var(--muted);
  background: #eef1f5;
}
.badge.bad {
  color: var(--danger);
  background: var(--danger-bg);
}
.hidden {
  display: none !important;
}
.muted {
  color: var(--muted);
}
.notice {
  margin: 12px 0 0;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: 6px;
  background: #fbfcfd;
  color: #475467;
  font-size: 13px;
  line-height: 1.5;
}
@media (max-width: 820px) {
  .topbar {
    height: auto;
    align-items: flex-start;
    padding: 16px;
    gap: 12px;
    flex-direction: column;
  }
  .grid {
    grid-template-columns: 1fr;
  }
  .summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .segmented {
    width: 100%;
    grid-auto-flow: row;
  }
  .segmented button {
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .segmented button:last-child {
    border-bottom: 0;
  }
}
</style>
</head>
<body>
<main class="page">
  <section id="loginView" class="login-wrap hidden">
    <form id="loginForm" class="login-panel">
      <h1>Flat 黑名单管理</h1>
      <p>Admin</p>
      <div class="field">
        <label for="username">账号</label>
        <input id="username" autocomplete="username" required>
      </div>
      <div class="field">
        <label for="password">密码</label>
        <input id="password" type="password" autocomplete="current-password" required>
      </div>
      <div class="actions">
        <button class="button" type="submit">登录</button>
      </div>
      <div id="loginMessage" class="message"></div>
    </form>
  </section>

  <section id="appView" class="hidden">
    <header class="topbar">
      <div class="app-title">
        <h1>Flat 黑名单管理</h1>
        <p id="sessionInfo"></p>
      </div>
      <button id="logoutButton" class="button secondary" type="button">退出</button>
    </header>
    <div class="content">
      <div class="toolbar">
        <div class="segmented" aria-label="mode">
          <button id="tabSearch" class="active" type="button">检索</button>
          <button id="tabImport" type="button">导入</button>
        </div>
      </div>

      <section id="searchPanel" class="panel">
        <div class="grid">
          <div>
            <div class="segmented" aria-label="search type">
              <button class="search-type active" data-type="phones" type="button">手机号</button>
              <button class="search-type" data-type="emails" type="button">邮箱</button>
              <button class="search-type" data-type="userUUIDs" type="button">userUUID</button>
            </div>
            <p id="searchPhoneNote" class="notice">手机号会去掉加号等非数字字符，但国家码会保留；请使用接口实际提交的格式。例如验证码接口传 +8618867105029 时，应检索 +8618867105029 或 8618867105029，不要只填 18867105029。</p>
            <div class="field">
              <label for="searchInput">检索内容</label>
              <textarea id="searchInput" spellcheck="false"></textarea>
            </div>
            <div class="actions">
              <button id="searchButton" class="button" type="button">检索</button>
              <button id="clearSearchButton" class="button secondary" type="button">清空</button>
            </div>
            <div id="searchMessage" class="message"></div>
          </div>
          <div>
            <div id="searchSummary" class="summary hidden"></div>
            <div style="overflow:auto">
              <table>
                <thead>
                  <tr>
                    <th style="width: 20%">输入</th>
                    <th style="width: 20%">归一化</th>
                    <th style="width: 12%">状态</th>
                    <th style="width: 12%">操作</th>
                    <th>记录</th>
                  </tr>
                </thead>
                <tbody id="searchRows">
                  <tr><td colspan="5" class="muted">暂无数据</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      <section id="importPanel" class="panel hidden">
        <div class="grid">
          <div>
            <div class="segmented" aria-label="import type">
              <button class="import-type active" data-type="phones" type="button">手机号</button>
              <button class="import-type" data-type="emails" type="button">邮箱</button>
              <button class="import-type" data-type="userUUIDs" type="button">userUUID</button>
            </div>
            <p id="importPhoneNote" class="notice">手机号会去掉加号等非数字字符，但国家码会保留；请使用接口实际提交的格式。例如验证码接口传 +8618867105029 时，应导入 +8618867105029 或 8618867105029，不要只填 18867105029。</p>
            <div class="field">
              <label for="importReason">reason</label>
              <input id="importReason" value="WB-432 PA import" maxlength="255">
            </div>
            <div class="field">
              <label for="importInput">导入内容</label>
              <textarea id="importInput" spellcheck="false"></textarea>
            </div>
            <div class="actions">
              <button id="previewButton" class="button secondary" type="button">预览</button>
              <button id="importButton" class="button" type="button" disabled>导入</button>
              <button id="clearImportButton" class="button secondary" type="button">清空</button>
            </div>
            <div id="importMessage" class="message"></div>
          </div>
          <div>
            <div id="importSummary" class="summary hidden"></div>
            <div style="overflow:auto">
              <table>
                <thead>
                  <tr>
                    <th style="width: 28%">输入</th>
                    <th style="width: 28%">归一化</th>
                    <th>结果</th>
                  </tr>
                </thead>
                <tbody id="importRows">
                  <tr><td colspan="3" class="muted">暂无数据</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    </div>
  </section>
</main>
<script>
(function () {
  var state = {
    username: "",
    searchType: "phones",
    importType: "phones",
    preview: null
  };
  var maxBatch = 500;
  var phoneMaxLength = 50;
  var emailMaxLength = 100;
  var uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var emailPattern = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;

  function el(id) {
    return document.getElementById(id);
  }

  function show(view) {
    el("loginView").classList.toggle("hidden", view !== "login");
    el("appView").classList.toggle("hidden", view !== "app");
  }

  function setMessage(id, text, type) {
    var node = el(id);
    node.textContent = text || "";
    node.className = "message" + (type ? " " + type : "");
  }

  function setActive(selector, value) {
    Array.prototype.forEach.call(document.querySelectorAll(selector), function (button) {
      button.classList.toggle("active", button.getAttribute("data-type") === value);
    });
  }

  function updateTypeNotes() {
    el("searchPhoneNote").classList.toggle("hidden", state.searchType !== "phones");
    el("importPhoneNote").classList.toggle("hidden", state.importType !== "phones");
  }

  function api(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.json().catch(function () {
        return null;
      }).then(function (json) {
        if (!res.ok || !json || json.status !== 0) {
          var code = json && json.code ? json.code : res.status;
          throw new Error(String(code));
        }
        return json.data;
      });
    });
  }

  function getSession() {
    return fetch("/admin/api/session", { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) throw new Error("no session");
        return res.json();
      })
      .then(function (json) {
        if (!json || json.status !== 0) throw new Error("no session");
        state.username = json.data.username;
        el("sessionInfo").textContent = state.username;
        show("app");
      })
      .catch(function () {
        show("login");
      });
  }

  function normalize(type, value) {
    var input = value.trim();
    if (!input) return null;
    if (type === "phones") {
      var digits = (input.match(/\\d+/g) || []).join("");
      return digits && digits.length <= phoneMaxLength ? digits : null;
    }
    if (type === "emails") {
      var email = input.toLowerCase();
      return email.length <= emailMaxLength && emailPattern.test(email) ? email : null;
    }
    var uuid = input.toLowerCase();
    return uuidV4.test(uuid) ? uuid : null;
  }

  function parseLines(type, text) {
    var lines = text.split(/\\r?\\n/).map(function (line) {
      return line.split(",")[0].trim();
    }).filter(Boolean);
    var seen = {};
    var valid = [];
    var invalid = [];
    lines.forEach(function (input, index) {
      var normalized = normalize(type, input);
      if (!normalized) {
        invalid.push({ line: index + 1, input: input });
        return;
      }
      if (seen[normalized]) return;
      seen[normalized] = true;
      valid.push({ input: input, normalized: normalized });
    });
    return {
      total: lines.length,
      valid: valid,
      invalid: invalid,
      chunks: chunk(valid.map(function (item) { return item.normalized; }), maxBatch)
    };
  }

  function chunk(values, size) {
    var chunks = [];
    for (var i = 0; i < values.length; i += size) {
      chunks.push(values.slice(i, i + size));
    }
    return chunks;
  }

  function requestBody(type, values, extra) {
    var body = extra ? Object.assign({}, extra) : {};
    body[type] = values;
    return body;
  }

  function requestKeyFor(type) {
    if (type === "phone") return "phones";
    if (type === "email") return "emails";
    if (type === "userUUID") return "userUUIDs";
    return type;
  }

  function metrics(id, stats) {
    el(id).classList.remove("hidden");
    el(id).innerHTML =
      '<div class="metric"><strong>' + stats.total + '</strong><span>总行数</span></div>' +
      '<div class="metric"><strong>' + stats.valid.length + '</strong><span>有效去重</span></div>' +
      '<div class="metric"><strong>' + stats.invalid.length + '</strong><span>无效行</span></div>' +
      '<div class="metric"><strong>' + stats.chunks.length + '</strong><span>请求批次</span></div>';
  }

  function renderInvalidRows(invalid) {
    if (!invalid.length) return "";
    return invalid.map(function (item) {
      return '<tr><td>' + escapeHTML(item.input) + '</td><td>-</td><td><span class="badge bad">格式错误</span> 第 ' + item.line + ' 行</td></tr>';
    }).join("");
  }

  function escapeHTML(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char];
    });
  }

  function recordText(records) {
    if (!records.length) return '<span class="muted">-</span>';
    return records.map(function (record) {
      var lines = [];
      if (record.userUUID) lines.push("userUUID: " + record.userUUID);
      if (record.phone) lines.push("phone: " + record.phone);
      if (record.email) lines.push("email: " + record.email);
      if (record.reason) lines.push("reason: " + record.reason);
      if (record.operator) lines.push("operator: " + record.operator);
      if (record.createdAt) lines.push("createdAt: " + record.createdAt);
      return escapeHTML(lines.join("\\n")).replace(/\\n/g, "<br>");
    }).join("<hr>");
  }

  function renderSearch(items, invalid) {
    var rows = items.map(function (item) {
      var badge = item.banned ? '<span class="badge ok">已拉黑</span>' : '<span class="badge no">未拉黑</span>';
      var action = item.banned
        ? '<button class="button secondary compact remove-button" type="button" data-type="' + escapeHTML(item.type) + '" data-value="' + escapeHTML(item.normalized) + '">移除</button>'
        : '<span class="muted">-</span>';
      return '<tr><td>' + escapeHTML(item.input) + '</td><td>' + escapeHTML(item.normalized) + '</td><td>' + badge + '</td><td>' + action + '</td><td>' + recordText(item.records) + '</td></tr>';
    }).join("");
    var invalidRows = invalid.map(function (item) {
      return '<tr><td>' + escapeHTML(item.input) + '</td><td>-</td><td><span class="badge bad">格式错误</span></td><td>-</td><td>第 ' + item.line + ' 行</td></tr>';
    }).join("");
    el("searchRows").innerHTML = rows + invalidRows || '<tr><td colspan="5" class="muted">暂无数据</td></tr>';
  }

  function doSearch(type, text, messageId) {
    var parsed = parseLines(type, text);
    metrics("searchSummary", parsed);
    if (!parsed.valid.length) {
      renderSearch([], parsed.invalid);
      setMessage(messageId, "没有可检索的数据", parsed.invalid.length ? "error" : "");
      return Promise.resolve([]);
    }
    setMessage(messageId, "检索中...");
    var calls = parsed.chunks.map(function (values) {
      return api("/admin/api/blacklist/search", requestBody(type, values));
    });
    return Promise.all(calls).then(function (results) {
      var items = [];
      results.forEach(function (result) {
        items = items.concat(result.items || []);
      });
      renderSearch(items, parsed.invalid);
      setMessage(messageId, "检索完成", "ok");
      return items;
    }).catch(function (error) {
      setMessage(messageId, "检索失败: " + error.message, "error");
      throw error;
    });
  }

  function removeBlacklist(type, value) {
    if (!type || !value) return;
    if (!window.confirm("确认从黑名单移除 " + value + " ?")) return;
    setMessage("searchMessage", "移除中...");
    api("/admin/api/blacklist/remove", requestBody(requestKeyFor(type), [value])).then(function () {
      setMessage("searchMessage", "移除成功，正在刷新", "ok");
      return doSearch(state.searchType, el("searchInput").value, "searchMessage");
    }).catch(function (error) {
      setMessage("searchMessage", "移除失败: " + error.message, "error");
    });
  }

  function previewImport() {
    var parsed = parseLines(state.importType, el("importInput").value);
    state.preview = parsed;
    metrics("importSummary", parsed);
    var rows = parsed.valid.map(function (item) {
      return '<tr><td>' + escapeHTML(item.input) + '</td><td>' + escapeHTML(item.normalized) + '</td><td><span class="badge ok">有效</span></td></tr>';
    }).join("");
    el("importRows").innerHTML = rows + renderInvalidRows(parsed.invalid) || '<tr><td colspan="3" class="muted">暂无数据</td></tr>';
    el("importButton").disabled = parsed.valid.length === 0;
    setMessage("importMessage", parsed.invalid.length ? "存在无效行，导入时会跳过" : "预览完成", parsed.invalid.length ? "error" : "ok");
  }

  function invalidateImportPreview() {
    if (!state.preview) return;
    state.preview = null;
    el("importButton").disabled = true;
    setMessage("importMessage", "内容已变化，请重新预览");
  }

  function doImport() {
    var preview = state.preview;
    if (!preview || !preview.valid.length) return;
    var reason = el("importReason").value.trim();
    var chunks = preview.chunks;
    el("importButton").disabled = true;
    setMessage("importMessage", "导入中...");
    var sequence = Promise.resolve();
    chunks.forEach(function (values, index) {
      sequence = sequence.then(function () {
        setMessage("importMessage", "导入中 " + (index + 1) + "/" + chunks.length);
        return api("/admin/api/blacklist/import", requestBody(state.importType, values, { reason: reason }));
      });
    });
    sequence.then(function () {
      setMessage("importMessage", "导入完成，正在回查", "ok");
      var calls = chunks.map(function (values) {
        return api("/admin/api/blacklist/search", requestBody(state.importType, values));
      });
      return Promise.all(calls);
    }).then(function (results) {
      var found = {};
      results.forEach(function (result) {
        (result.items || []).forEach(function (item) {
          found[item.normalized] = item;
        });
      });
      el("importRows").innerHTML = preview.valid.map(function (item) {
        var result = found[item.normalized];
        var banned = result && result.banned;
        var badge = banned ? '<span class="badge ok">已拉黑</span>' : '<span class="badge bad">未命中</span>';
        return '<tr><td>' + escapeHTML(item.input) + '</td><td>' + escapeHTML(item.normalized) + '</td><td>' + badge + '</td></tr>';
      }).join("") + renderInvalidRows(preview.invalid);
    }).then(function () {
      setMessage("importMessage", "导入并回查完成", "ok");
    }).catch(function (error) {
      el("importButton").disabled = false;
      setMessage("importMessage", "导入失败: " + error.message, "error");
    });
  }

  el("loginForm").addEventListener("submit", function (event) {
    event.preventDefault();
    setMessage("loginMessage", "登录中...");
    api("/admin/api/login", {
      username: el("username").value,
      password: el("password").value
    }).then(function (data) {
      state.username = data.username;
      el("sessionInfo").textContent = state.username;
      setMessage("loginMessage", "");
      show("app");
    }).catch(function (error) {
      setMessage("loginMessage", "登录失败: " + error.message, "error");
    });
  });

  el("logoutButton").addEventListener("click", function () {
    api("/admin/api/logout", {}).finally(function () {
      show("login");
    });
  });

  el("tabSearch").addEventListener("click", function () {
    el("tabSearch").classList.add("active");
    el("tabImport").classList.remove("active");
    el("searchPanel").classList.remove("hidden");
    el("importPanel").classList.add("hidden");
  });

  el("tabImport").addEventListener("click", function () {
    el("tabImport").classList.add("active");
    el("tabSearch").classList.remove("active");
    el("importPanel").classList.remove("hidden");
    el("searchPanel").classList.add("hidden");
  });

  Array.prototype.forEach.call(document.querySelectorAll(".search-type"), function (button) {
    button.addEventListener("click", function () {
      state.searchType = button.getAttribute("data-type");
      setActive(".search-type", state.searchType);
      updateTypeNotes();
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll(".import-type"), function (button) {
    button.addEventListener("click", function () {
      state.importType = button.getAttribute("data-type");
      state.preview = null;
      el("importButton").disabled = true;
      setActive(".import-type", state.importType);
      updateTypeNotes();
    });
  });

  el("searchButton").addEventListener("click", function () {
    doSearch(state.searchType, el("searchInput").value, "searchMessage").catch(function () {});
  });

  el("searchRows").addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.classList || !target.classList.contains("remove-button")) return;
    removeBlacklist(target.getAttribute("data-type"), target.getAttribute("data-value"));
  });

  el("clearSearchButton").addEventListener("click", function () {
    el("searchInput").value = "";
    el("searchRows").innerHTML = '<tr><td colspan="5" class="muted">暂无数据</td></tr>';
    el("searchSummary").classList.add("hidden");
    setMessage("searchMessage", "");
  });

  el("previewButton").addEventListener("click", previewImport);
  el("importButton").addEventListener("click", doImport);
  el("importInput").addEventListener("input", invalidateImportPreview);
  el("clearImportButton").addEventListener("click", function () {
    el("importInput").value = "";
    state.preview = null;
    el("importRows").innerHTML = '<tr><td colspan="3" class="muted">暂无数据</td></tr>';
    el("importSummary").classList.add("hidden");
    el("importButton").disabled = true;
    setMessage("importMessage", "");
  });

  updateTypeNotes();
  getSession();
})();
</script>
</body>
</html>`;
