# WB-432 用户黑名单（冻结）功能设计文档

> Jira: https://jira.agoralab.co/browse/WB-432
> 状态: InProgress | 报告人: 杨柳02 | 经办人: hongqiuer@agora.io
> 创建日期: 2026-07-06

## 1. 背景

按照公司合规要求，PA 提供涉诈涉骗手机号后，公司内 APP/Demo 必须禁止这些用户正常使用。需要在 flat-server 中提供黑名单能力：

- 支持导入手机号 / 邮箱 / userUUID，将对应 Flat 用户标记为黑名单（冻结）用户
- 黑名单用户无法登录、注册
- 支持解冻（移除黑名单）

## 2. 需求拆解

| # | 需求 | 来源 |
|---|---|---|
| R1 | 用户列表 / 用户模型新增"是否冻结（黑名单）"字段 | 用户指令 |
| R2 | 提供导入手机号 → 关联用户 → 标记冻结 的 API | 用户指令 / Jira |
| R3 | 改造登录 / 注册 API：执行前判断黑名单，命中则失败 | 用户指令 / Jira |
| R4 | 提供解冻 API，按导入的手机号移除冻结标记 | 用户指令 |
| R5 | （Jira 完整范围）支持邮箱、userUUID 作为黑名单导入标识 | Jira |
| R6 | （Jira 完整范围）黑名单用户无法创建 / 加入房间 | Jira |

**本期交付范围**：R1–R6。R6（房间创建/加入拦截）一并落地，确保黑名单用户在产品功能上完全不可用。

## 3. 现状分析

### 3.1 数据模型

`src/model/user/User.ts` —— `users` 表，无黑名单字段：

```ts
@Entity({ name: "users" })
export class UserModel extends Content {
    user_uuid: string;       // 40
    user_name: string;       // 50
    user_password: string;   // precision 32
    avatar_url: string;      // 2083
    gender: Gender;
    is_delete: boolean;      // 软删
}
```

`src/model/user/Phone.ts` —— `user_phone` 表，`phone_number` 唯一索引：
`src/model/user/Email.ts` —— `user_email` 表，`user_email` 唯一索引。

所有实体继承 `Content`（`id` / `created_at` / `updated_at` / `version`）。`is_delete` 不在 `Content` 基类中，由各 Model 独立定义（如 `UserModel`、`UserBlacklistModel` 各自声明 `@Column is_delete: boolean`）。

### 3.2 登录注册入口（需要拦截的点）

| 入口 | 路径 | 文件 | 登录 / 注册 |
|---|---|---|---|
| v1 短信登录（自动注册） | `POST /login/phone` | `src/v1/controller/login/phone/Phone.ts` | 登录 + 注册二合一 |
| v1 OAuth 回调（WeChat/Github/Apple/Agora/Google） | `POST /login/{platform}/callback` | `src/v1/controller/login/*/Callback.ts` | 登录 + 注册二合一 |
| v1 登录确认 | `POST /login` | `src/v1/controller/login/Login.ts` | 登录（需 JWT） |
| v2 手机号密码登录 | `POST /v2/login/phone` | `src/v2/controllers/login/phone/index.ts` → `services/user/phone.ts` | 仅登录 |
| v2 邮箱密码登录 | `POST /v2/login/email` | `src/v2/controllers/login/email/index.ts` → `services/user/email.ts` | 仅登录 |
| v2 手机号注册 | `POST /v2/register/phone` | `src/v2/controllers/register/phone/index.ts` → `services/user/phone.ts` | 仅注册 |
| v2 邮箱注册 | `POST /v2/register/email` | `src/v2/controllers/register/email/index.ts` → `services/user/email.ts` | 仅注册 |

### 3.3 现有 Admin 模式

`src/v2/controllers/admin/` 已经有 `ban-rooms` / `room-messages` 等管理端接口，统一通过 `admin: true` 走 `authenticateAdmin` 中间件（`x-flat-secret` Header 校验，配置项 `Admin.secret`）。新接口应沿用该模式。

### 3.4 现有 DAO 模式

- v1: `src/dao/index.ts` 工厂函数 `DAOImplement(Model)` 返回单例 DAO
- v2: `src/v2/dao/index.ts` 用 `class DAO<M>` 泛型 + 实例化，统一处理软删（`is_delete: false`）

新表 DAO 在 v2 模块下创建，遵循 v2 DAO 模式。

## 4. 设计方案

### 4.1 关键设计决策

**决策 1：双存储（用户表标志位 + 独立黑名单表）**

- `users.is_blacklist` 布尔字段：用于用户列表展示、按状态筛选、O(1) 命中判断
- `user_blacklist` 独立表：存储被ban的标识（phone / email / user_uuid），用于登录注册前的"标识级"拦截

**为什么需要独立表？** PA 提供的涉诈手机号可能尚未注册 Flat 账号。若只标记 `users.is_blacklist`，则该手机号仍可注册新账号。独立表支持"未注册先拉黑"。

**决策 2：黑名单表支持三标识**

为对齐 Jira 完整范围，黑名单表同时支持 `phone_number` / `email` / `user_uuid` 三个字段（均 nullable）。MySQL 的 UNIQUE 索引允许多个 NULL，因此不会互相冲突。

**决策 3：Ban 操作的语义**

调用 ban API 时，按传入标识类型写入 `user_blacklist` 表，并尝试关联现有用户：

- 传入 phone → 写入 `phone_number`；若 `user_phone` 表能找到对应 userUUID，同步设置 `users.is_blacklist = true` 并回填 `user_blacklist.user_uuid`
- 传入 email → 写入 `email`；若 `user_email` 表能找到，同上
- 传入 userUUID → 写入 `user_uuid`；若 `users` 表存在该用户，直接设置 `is_blacklist = true`

**决策 4：Unban 操作的语义**

按标识删除 `user_blacklist` 记录（软删 `is_delete = true`）。同时如果关联到了用户，把 `users.is_blacklist` 置回 `false`。

**三种 unban 的粒度不同：**

- `unbanByPhone(phone)` —— 仅软删 `phone_number` 匹配的记录。若该用户还被 email / userUUID 记录封禁，`is_blacklist` 保持 `true`，Redis 缓存不清除（`resetUserBlacklistFlag` 返回的 `toReset` 为空）。
- `unbanByEmail(email)` —— 同上，仅软删 `email` 匹配的记录。
- `unbanByUserUUID(userUUID)` —— **完全解冻**：软删所有 `user_uuid` 匹配的记录（含 phone / email ban 时回填了 `user_uuid` 的记录）。`resetUserBlacklistFlag` 会检查是否还有其他记录，若无则 `is_blacklist` 置回 `false` 并清除 Redis 缓存。

> **Edge case：** 若某手机号在用户注册前被 ban（`user_uuid = null`），后续该用户注册并被 ban by userUUID，`unbanByUserUUID` 不会清除该 phone 记录（因 `user_uuid` 为 null 不匹配）。管理员需单独调 `unbanByPhone` 清除。这是已知限制，本期不处理。

**Ban 操作的幂等性：**

- `banByPhone` / `banByEmail` —— `deleteHard({ phone_number: In(...) })` / `deleteHard({ email: In(...) })` 仅按对应标识匹配，不影响其他标识符的记录。
- `banByUserUUID` —— `deleteHard({ user_uuid: In(...), phone_number: IsNull(), email: IsNull() })` **仅删除纯 userUUID 记录**，不破坏 phone / email ban 时回填了 `user_uuid` 的记录。否则 `banByUserUUID` 会误删 phone ban 记录，导致 phone 级拦截失效。

**决策 5：登录 / 注册 / 重置密码 / 发送验证码拦截点**

在 v2 的 `UserPhoneService` / `UserEmailService` 的以下方法首行调用 `UserBlacklistService.assertNotBanned(...)`：

- `register(phone/email, ...)` —— 注册前拦截
- `login(phone/email, ...)` —— 登录前拦截
- `sendMessageForRegister(phone/email, ...)` —— 注册发送验证码前拦截（避免向黑名单手机/邮箱发送短信/邮件）
- `sendMessageForReset(phone/email, ...)` —— 重置密码发送验证码前拦截
- `reset(phone/email, ...)` —— 重置密码前拦截

v1 的 `/login/phone`（PhoneLogin）也是注册登录二合一，需在 `execute()` 校验码之前调用同样的断言。

v1 OAuth 回调（Github / Google / WeChat-Web / WeChat-Mobile / Apple-JWT / Agora）全部拦截，详见 4.5.6。拦截点在 `userUUIDByUnionUUID` 之后、`register()` / `jwtSign()` 之前，仅对已存在的 Flat 用户（`userUUIDByDB` 非空）做 userUUID 级检查。

### 4.2 数据模型变更

#### 4.2.1 修改 `users` 表

`src/model/user/User.ts` 增加 `is_blacklist` 字段：

```ts
@Index("users_is_blacklist_index")
@Column({
    default: false,
})
is_blacklist: boolean;
```

#### 4.2.2 新增 `user_blacklist` 表

新建 `src/model/user/Blacklist.ts`：

```ts
import { Column, Entity, Index } from "typeorm";
import { Content } from "../Content";

@Entity({
    name: "user_blacklist",
})
export class UserBlacklistModel extends Content {
    @Index("user_blacklist_user_uuid_index")
    @Column({
        type: "varchar",
        length: 40,
        nullable: true,
        comment: "banned user uuid, nullable if banned by phone/email only",
    })
    user_uuid: string | null;

    @Index("user_blacklist_phone_uindex", {
        unique: true,
    })
    @Column({
        type: "varchar",
        length: 50,
        nullable: true,
        comment: "banned phone number",
    })
    phone_number: string | null;

    @Index("user_blacklist_email_uindex", {
        unique: true,
    })
    @Column({
        type: "varchar",
        length: 100,
        nullable: true,
        comment: "banned email",
    })
    email: string | null;

    @Column({
        length: 255,
        nullable: true,
        comment: "ban reason",
    })
    reason: string | null;

    @Column({
        length: 40,
        nullable: true,
        comment: "operator (admin user uuid or system name)",
    })
    operator: string | null;

    @Index("user_blacklist_is_delete_index")
    @Column({
        default: false,
    })
    is_delete: boolean;
}
```

**索引设计说明**：
- `phone_number` / `email` —— UNIQUE 索引。MySQL 的 UNIQUE 索引允许多个 NULL 值共存，因此按手机号 ban 时 `email` 字段为 NULL 不会与按邮箱 ban 的记录冲突。同一手机号/邮箱全局只能有一条非软删记录（ban 前先 `deleteHard` 旧记录保证幂等）。
- `user_uuid` —— **非** UNIQUE 普通索引。同一用户可同时被多个标识符 ban（如手机号 + 邮箱），每条 ban 记录独立存在，`assertNotBanned` 用 OR 查询遍历三条记录。若设为 UNIQUE，多标识符 ban 时第二条记录会因 `user_uuid` 冲突被 `INSERT OR IGNORE` 静默丢弃，导致解冻其中一个标识符后用户被错误放行（P1 缓存清除 bug 的前置条件）。

#### 4.2.3 DAO 注册

`src/v2/dao/index.ts` 增加：

```ts
import { UserBlacklistModel } from "../../model/user/Blacklist";
// ...
export const userBlacklistDAO = new DAO(UserBlacklistModel);
```

#### 4.2.4 数据库迁移

dev / test 环境通过 `yarn test:sync:orm`（`scripts/sync-orm.ts`）自动 `synchronize` 建表。

生产环境需写迁移 SQL，参考 `scripts/migration/` 现有目录命名规范：

新建 `scripts/migration/2026-07-06_db_user-blacklist/index.sql`：

```sql
ALTER TABLE `users`
  ADD COLUMN `is_blacklist` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否黑名单用户',
  ADD INDEX `users_is_blacklist_index` (`is_blacklist`);

CREATE TABLE `user_blacklist` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_uuid` VARCHAR(40) NULL DEFAULT NULL COMMENT 'banned user uuid',
  `phone_number` VARCHAR(50) NULL DEFAULT NULL COMMENT 'banned phone number',
  `email` VARCHAR(100) NULL DEFAULT NULL COMMENT 'banned email',
  `reason` VARCHAR(255) NULL DEFAULT NULL COMMENT 'ban reason',
  `operator` VARCHAR(40) NULL DEFAULT NULL COMMENT 'operator',
  `is_delete` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `version` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  INDEX `user_blacklist_user_uuid_index` (`user_uuid`),
  UNIQUE INDEX `user_blacklist_phone_uindex` (`phone_number`),
  UNIQUE INDEX `user_blacklist_email_uindex` (`email`),
  INDEX `user_blacklist_is_delete_index` (`is_delete`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户黑名单';
```

### 4.3 错误码

`src/ErrorCode.ts` 在 `UserNotFound = 400000` 段后追加：

```ts
UserNotFound = 400000,
UserRoomListNotEmpty,
UserAlreadyBinding,
UserPasswordIncorrect,
UserOrPasswordIncorrect,
UserPmiDrained,
UserBlacklisted, // 用户已被加入黑名单（登录 / 注册拒绝）
```

错误码数值 `400006`（紧随 `UserPmiDrained = 400005` 自增），含义：用户已被加入黑名单，登录 / 注册失败。

### 4.4 服务层：`UserBlacklistService`

新建 `src/v2/services/user/blacklist.ts`：

```ts
import { EntityManager } from "typeorm";
import { FError } from "../../../error/ControllerError";
import { ErrorCode } from "../../../ErrorCode";
import { createLoggerService } from "../../../logger";
import { userBlacklistDAO, userDAO, userPhoneDAO, userEmailDAO } from "../../dao";

export class UserBlacklistService {
    private readonly logger = createLoggerService<"userBlacklist">({
        serviceName: "userBlacklist",
        ids: this.ids,
    });

    constructor(
        private readonly ids: IDS,
        private readonly DBTransaction: EntityManager,
    ) {}

    /** 按手机号 ban：写入黑名单表 + 标记 users.is_blacklist */
    public async banByPhone(phone: string, reason?: string, operator?: string): Promise<void> { /* ... */ }

    /** 按邮箱 ban */
    public async banByEmail(email: string, reason?: string, operator?: string): Promise<void> { /* ... */ }

    /** 按 userUUID ban：返回匹配/跳过计数（不存在的 userUUID 计入 skippedCount） */
    public async banByUserUUID(
        userUUID: string,
        reason?: string,
        operator?: string,
    ): Promise<{ matchedCount: number; skippedCount: number }> { /* ... */ }

    /** 批量按手机号 ban（导入场景） */
    public async banByPhones(phones: string[], reason?: string, operator?: string): Promise<void> { /* ... */ }

    /** 批量按邮箱 ban（导入场景） */
    public async banByEmails(emails: string[], reason?: string, operator?: string): Promise<void> { /* ... */ }

    /** 批量按 userUUID ban（导入场景）：返回匹配/跳过计数 */
    public async banByUserUUIDs(
        userUUIDs: string[],
        reason?: string,
        operator?: string,
    ): Promise<{ matchedCount: number; skippedCount: number }> { /* ... */ }

    /** 解除 ban */
    public async unbanByPhone(phone: string): Promise<void> { /* ... */ }
    public async unbanByEmail(email: string): Promise<void> { /* ... */ }
    public async unbanByUserUUID(userUUID: string): Promise<void> { /* ... */ }

    /** 批量解除 ban */
    public async unbanByPhones(phones: string[]): Promise<void> { /* ... */ }
    public async unbanByEmails(emails: string[]): Promise<void> { /* ... */ }
    public async unbanByUserUUIDs(userUUIDs: string[]): Promise<void> { /* ... */ }

    /** 登录 / 注册前断言：若命中黑名单抛 FError(UserBlacklisted) */
    public async assertNotBanned(
        identifier: { phone?: string; email?: string; userUUID?: string },
    ): Promise<void> { /* ... */ }

    /** 查询单条黑名单状态（供管理端使用） */
    public async isBanned(
        identifier: { phone?: string; email?: string; userUUID?: string },
    ): Promise<boolean> { /* ... */ }
}
```

**`assertNotBanned` 实现**：

```ts
public async assertNotBanned(
    identifier: { phone?: string; email?: string; userUUID?: string },
): Promise<void> {
    const or: Array<Record<string, unknown>> = [];
    if (identifier.phone) or.push({ phone_number: identifier.phone });
    if (identifier.email) or.push({ email: identifier.email });
    if (identifier.userUUID) or.push({ user_uuid: identifier.userUUID });
    if (or.length === 0) return;

    // 注意：v2 DAO 默认追加 is_delete: false，无需手动处理
    const found = await userBlacklistDAO.findOne(
        this.DBTransaction,
        ["id"],
        // 此处需绕过 DAO 的 softDelete 帮手拼接 OR 查询，
        // 实际实现走 Repository.createQueryBuilder() 或扩展 DAO 支持 OR。
        // @ts-expect-error - 复合 OR 查询需直接走 repository
        or.length === 1 ? or[0] : { /* OR group */ },
    );
    if (found) {
        this.logger.warn("user blacklisted", identifier);
        throw new FError(ErrorCode.UserBlacklisted);
    }
}
```

> ⚠️ 当前 v2 DAO 的 `findOne` 第三参 `where` 是 `FindOptionsWhere<M>`（AND 语义）。本设计需要 OR 查询。两种实现方式：
>
> 1. 在 `UserBlacklistService` 内直接使用 `this.DBTransaction.getRepository(UserBlacklistModel).findOne({ where: or })` —— TypeORM 的 `FindOptionsWhere` 数组形式即 OR 语义，最简单
> 2. 扩展 `DAO.findOne` 支持数组参数（影响面大，本期不做）
>
> 选 1。

#### 4.4.1 标识符归一化（防绕过）

**问题**：系统内 `user_phone.phone_number` 存储原始输入（含 `+`，如 `+8613800138000`），但 PA / admin 提供的 ban 输入格式不一定一致（可能无 `+`）。若 ban 写入与 assertNotBanned 查询使用不同格式，黑名单可被完全绕过。邮箱同理——大小写差异导致 `User@Example.com` 与 `user@example.com` 不匹配。

**方案**：`UserBlacklistService` 内部统一归一化，所有调用方自动安全：

- **phone** → `SMSUtils.safePhone(phone)`（去除所有非数字字符，`+8613800138000` → `8613800138000`）
  - `banByPhones` / `unbanByPhones` / `assertNotBanned` / `isBanned` 均在内部归一化
  - `banByPhones` 查 `user_phone` 表时兼容 `safePhone` 和 `+safePhone` 两种格式（`phoneVariants()`），确保无论用户注册时是否带 `+` 都能回填 `user_uuid`
  - `user_blacklist.phone_number` 始终存归一化后的 `safePhone` 格式
- **email** → `email.toLowerCase()`
  - `banByEmails` / `unbanByEmails` / `assertNotBanned` / `isBanned` 均在内部归一化
  - `banByEmails` 查 `user_email` 表时用归一化后的 email，同时将查到的 `user_email` 归一化后作为 map key
  - `user_blacklist.email` 始终存小写格式

**注意**：`user_phone.phone_number` 和 `user_email.user_email` 表本身存储格式不变（原始输入），归一化仅在黑名单服务内部发生。这样既保证黑名单匹配的可靠性，又不影响现有用户数据。

**数据前提**：`banByPhones` 关联 `user_phone` 时通过 `phoneVariants()` 仅匹配 `safePhone` 与 `+safePhone` 两种存储形态。`assertNotBanned` / `isBanned` 不受此限制——它们只比对 `user_blacklist.phone_number`（始终存归一化后的 `safePhone`），因此无论历史数据格式如何，登录/注册拦截均能可靠生效。`banByPhones` 的 `user_uuid` 回填、`users.is_blacklist` 标记、Redis 缓存写入依赖 `user_phone` 关联，若历史数据存在 `digits` / `+digits` 以外的格式（含空格、短横线、括号等），这三个副作用会缺失。当前前提：v1 `format: "phone"` 与 v2 实际入参均只产生 `digits` / `+digits` 两种存储形态，满足该前提。

### 4.5 登录 / 注册拦截改造

#### 4.5.1 v2 手机号登录 / 注册

`src/v2/services/user/phone.ts` 顶部注入 `UserBlacklistService` 并在 `login` / `register` 入口调用断言：

```ts
// register() 方法首行
const blacklist = new UserBlacklistService(this.ids, this.DBTransaction);
await blacklist.assertNotBanned({ phone });

// login() 方法首行
const blacklist = new UserBlacklistService(this.ids, this.DBTransaction);
await blacklist.assertNotBanned({ phone });
```

#### 4.5.2 v2 邮箱登录 / 注册

`src/v2/services/user/email.ts` 同样注入并断言：

```ts
await blacklist.assertNotBanned({ email });
```

#### 4.5.3 v1 `/login/phone`（PhoneLogin）

`src/v1/controller/login/phone/Phone.ts` 在 `execute()` 内、`notExhaustiveAttack` 之前插入断言。这里没有 v2 的 `DBTransaction`，直接用 `dataSource`：

```ts
import { dataSource } from "../../../../thirdPartyService/TypeORMService";
import { UserBlacklistService } from "../../../v2/services/user/blacklist";

public async execute(): Promise<Response<ResponseType>> {
    const { phone, code } = this.body;

    // 黑名单拦截
    const blacklist = new UserBlacklistService(this.req.ids, dataSource.manager);
    await blacklist.assertNotBanned({ phone });

    // ...原有逻辑
}
```

> 注：v1 controller 通过 `this.req.ids` 获取 `ids`（`AbstractController` 暴露 `this.req: PatchRequest`，`ids` 由 fastify hook 挂载到 request 上，与 v2 的 `req.ids` 同构）。

#### 4.5.4 v1 `/login`（Login.ts）—— OAuth 用户 JWT 刷新拦截

OAuth 用户（WeChat/Github/Apple/Agora/Google）登录路径不经过 `/login/phone`，而是经 OAuth 回调 → `/login/process` 拿到 JWT，后续用 `/login` 刷新。在 `Login.ts:execute()` 首行加 userUUID 级断言，阻断黑名单用户刷新 JWT：

```ts
// src/v1/controller/login/Login.ts
import { dataSource } from "../../../thirdPartyService/TypeORMService";
import { UserBlacklistService } from "../../v2/services/user/blacklist";

public async execute(): Promise<Response<ResponseType>> {
    // 黑名单拦截（OAuth 用户的 userUUID 来自 JWT）
    const blacklist = new UserBlacklistService(this.req.ids, dataSource.manager);
    await blacklist.assertNotBanned({ userUUID: this.userUUID });

    this.assertAccess();
    // ...原有逻辑
}
```

#### 4.5.5 v1 `/login/process`（LoginProcess.ts）—— OAuth 流程发券前拦截

`/login/process` 是 OAuth 流程的最终发券点：从 Redis 取出已签发的 JWT 返回给前端。在返回前增加黑名单检查，保证黑名单用户即使 OAuth 回调已写入 Redis，也拿不到 token：

```ts
// src/v1/controller/login/Process.ts
public async execute(): Promise<Response<ResponseType>> {
    const { authUUID } = this.body;
    await AbstractLogin.assertHasAuthUUID(authUUID, this.logger);

    const failedReason = await RedisService.get(RedisKey.authFailed(authUUID));
    if (failedReason !== null) {
        // ...原有 failedReason 映射逻辑
        // 增加 "user_blacklisted" → ErrorCode.UserBlacklisted
    }

    const userInfoStr = await RedisService.get(RedisKey.authUserInfo(authUUID));
    if (userInfoStr === null) {
        // ...原有空数据处理
    }

    const userInfo = JSON.parse(userInfoStr);

    // 黑名单拦截：OAuth 流程发券前最后一道关
    const blacklist = new UserBlacklistService(this.req.ids, dataSource.manager);
    await blacklist.assertNotBanned({ userUUID: userInfo.userUUID });

    return {
        status: Status.Success,
        data: userInfo,
    };
}
```

**为什么三层拦截（Callback + LoginProcess + Login）？**

- **Callback（4.5.6）**：源头拦截，避免 `register()` 写入"幽灵用户"记录，覆盖模式 B/C 直发券路径（WeChat-Mobile / Apple-JWT / Agora 不走 `/login/process`）
- **LoginProcess（4.5.5）**：模式 A 的发券点，从 Redis 取 JWT 返回前拦截；同时读取回调 `errorHandler` 写入的 `failedReason = "user_blacklisted"`，把黑名单错误码回传前端
- **Login（4.5.4）**：拦截已持有旧 JWT 的刷新——黑名单用户若在 ban 之前已有 JWT（29 天有效），刷新时被拦截

三层互补，覆盖 v1 所有 OAuth 登录路径（新发券 / 刷新 / 模式 B/C 直发）。`/login/phone` 已在 4.5.3 覆盖。

#### 4.5.6 OAuth 回调拦截实现（6 入口全覆盖）

**为什么必须拦截回调？**

5 个 OAuth Callback + Apple JWT 共 6 个入口，实际有 3 种发券模式：

| 模式 | 入口 | 发券方式 | 是否走 `/login/process` |
|---|---|---|---|
| A | Github / Google / WeChat-Web Callback | `tempSaveUserInfo` 写 Redis，前端轮询 `/login/process` 取 token | 是 |
| B | WeChat-Mobile Callback / Apple JWT | 直接 JSON 返回 token | 否 |
| C | Agora Callback | `reply.redirect` 到 `${Website}/login?token=...` | 否 |

模式 B/C 完全绕过 `/login/process`，若不在回调内拦截，黑名单用户仍可拿到新 JWT。模式 A 虽有 `/login/process` 兜底（4.5.5），但回调内拦截可避免 `register()` 写入"幽灵用户"记录、且能在源头阻断。因此 6 个入口全部需要在回调内加黑名单拦截。

**拦截点**：在 `ServiceUserXxx.userUUIDByUnionUUID(...)` 拿到 `userUUIDByDB` 之后、`register()` 与 `jwtSign()` 之前。仅当 `userUUIDByDB` 存在时检查（OAuth 新用户没有 phone/email/userUUID 可比对，检查是 no-op，但保留统一拦截结构）。

**模式 A（Github / Google / WeChat-Web）**

以 Github 为例（Google 结构完全一致）：

```ts
// src/v1/controller/login/github/Callback.ts
const userUUIDByDB = await ServiceUserGithub.userUUIDByUnionUUID(userInfo.unionUUID);

// 黑名单拦截：已有 Flat 账号的 OAuth 用户，在注册/发券前阻断
if (userUUIDByDB) {
    const blacklist = new UserBlacklistService(this.req.ids, dataSource.manager);
    await blacklist.assertNotBanned({ userUUID: userUUIDByDB });
}

const userUUID = userUUIDByDB || v4();
// ...原有 register / tempSaveUserInfo 逻辑
```

`errorHandler` 需识别 `FError(UserBlacklisted)` 并将 `failedReason` 写为 `"user_blacklisted"`（而不是 `this.querystring.error || ""`），供 `/login/process` 映射（见 4.5.5 已设计的 `"user_blacklisted" → ErrorCode.UserBlacklisted`）。这样前端轮询 `/login/process` 时能拿到正确错误码。**Github / Google / WeChat-Web / WeChat-Mobile 四个 errorHandler 均已实现此逻辑**——WeChat-Web（模式 A）返回 `failedHTML()`，WeChat-Mobile（模式 B）走 `autoHandlerError` 返回 JSON。

WeChat-Web 走 `wechatCallback` 工具函数（`src/v1/controller/login/weChat/Utils.ts`），需把 `ids` 透传进去：

```ts
// src/v1/controller/login/weChat/Utils.ts
export const wechatCallback = async (
    code: string,
    authUUID: string,
    type: "WEB" | "MOBILE",
    logger: Logger<LoggerAPI>,
    reply: FastifyReply,
    ids: IDS,  // 新增参数
): Promise<WeChatResponse> => {
    // ...
    const userUUIDByDB = await ServiceUserWeChat.userUUIDByUnionUUID(userInfo.unionUUID);

    if (userUUIDByDB) {
        const blacklist = new UserBlacklistService(ids, dataSource.manager);
        await blacklist.assertNotBanned({ userUUID: userUUIDByDB });
    }
    // ...
};
```

两个调用方（`weChat/web/Callback.ts`、`weChat/mobile/Callback.ts`）传入 `this.req.ids`。

**模式 B（WeChat-Mobile / Apple JWT）**

WeChat-Mobile 复用上面的 `wechatCallback` 工具函数，拦截点相同。其 `errorHandler` 走 `autoHandlerError`，`FError(UserBlacklisted)` 会被 `parseFlatError` 转成 `{ status: Failed, code: 400006 }` JSON 直接返回给前端，无需额外处理。

Apple JWT（`src/v1/controller/login/apple/jwt.ts`）是 POST API（非 OAuth 跳转），但在 `ServiceUserApple.userUUIDByUnionUUID(appleID)` 后同样发券，拦截方式与模式 B 一致：

```ts
// src/v1/controller/login/apple/jwt.ts
const userUUIDByDB = await ServiceUserApple.userUUIDByUnionUUID(appleID);

if (userUUIDByDB) {
    const blacklist = new UserBlacklistService(this.req.ids, dataSource.manager);
    await blacklist.assertNotBanned({ userUUID: userUUIDByDB });
}

const userUUID = userUUIDByDB || v4();
// ...原有 register / jwtSign 逻辑
```

**模式 C（Agora）**

Agora 回调 `execute` 末尾 `reply.redirect(`${Website}/login?token=${token}`)`，`errorHandler` 返回 HTML。黑名单错误需要通过 redirect query 传递：

```ts
// src/v1/controller/login/agora/Callback.ts
const userUUIDByDB = await ServiceUserAgora.userUUIDByUnionUUID(userInfo.unionUUID);

if (userUUIDByDB) {
    const blacklist = new UserBlacklistService(this.req.ids, dataSource.manager);
    await blacklist.assertNotBanned({ userUUID: userUUIDByDB });
}

// ...原有 register / jwtSign 逻辑
```

`errorHandler` 内增加黑名单判断，`FError(UserBlacklisted)` 时 `redirect` 到 `${Website}/login?error=blacklisted`（前端 login 页需识别该 query 并提示，属前端配套改动）。

**小结**：6 个入口的拦截结构一致 —— `userUUIDByDB` 存在则 `assertNotBanned({ userUUID: userUUIDByDB })`。差异仅在错误码如何回传前端：模式 A 走 Redis `failedReason` → `/login/process`，模式 B 走 JSON `autoHandlerError`，模式 C 走 redirect query。

#### 4.5.7 手机号绑定 / 换绑拦截

**问题**：admin 对未注册手机号执行 `banByPhone` 后，`user_blacklist` 记录为 `{ phone_number: X, user_uuid: null }`，不写 `users.is_blacklist`、不写 Redis userUUID 缓存。若用户用 OAuth/邮箱创建正常账号后绑定该手机号，绑定流程不检查目标 phone 是否在黑名单中，绑定成功后该账号仍可通过当前 JWT 创建/加入房间（房间拦截只查 `userUUID`，而 phone ban 记录 `user_uuid = null`）。这绕过了"未注册先拉黑"的核心目标。

**方案**：在绑定/换绑的目标 phone 上显式调用 `assertNotBanned({ phone })`，拒绝绑定黑名单手机号。

**v1 `/user/bindingPhone` 与 `/user/bindingPhone/sendMessage`**：

```ts
// BindingPhone.execute() 与 SendMessage.execute() 首行（safePhone 计算后）
await new UserBlacklistService(this.req.ids, dataSource.manager).assertNotBanned({
    phone,
});
```

**v2 `/user/rebind-phone` 与 `/user/rebind-phone/send-message`**（`UserRebindPhoneService`）：

```ts
// sendMessage() 首行
await new UserBlacklistService(this.ids, this.DBTransaction).assertNotBanned({ phone });

// rebind() 首行
const blacklist = new UserBlacklistService(this.ids, this.DBTransaction);
await blacklist.assertNotBanned({ phone });

// ...获取 original.user_uuid 后
await blacklist.assertNotBanned({ userUUID: original.user_uuid });
```

v2 `rebind()` 额外检查 `original.user_uuid`（目标手机号原属用户），避免把当前账号的 OAuth/邮箱绑定合并到黑名单用户上。

### 4.6 管理端 API 设计

新建 `src/v2/controllers/admin/ban-user.ts`、`unban-user.ts`、`ban-user-batch.ts`，并在 `src/v2/controllers/admin/routes.ts` 注册：

#### 4.6.1 POST `/v2/admin/ban-user` —— 单条 ban

**参数格式校验**：所有标识字段都加 `minLength: 1`，禁止空字符串；`Type.Optional` 仅表示"该字段可缺省"，传入 `null` / `""` 会被 schema 直接拒绝（返回 `ParamsCheckFailed`）。服务层 `assertNotBanned` 内部对假值再做一道 `if (identifier.phone)` 过滤，作为防御性兜底。

```ts
export const banUserSchema = {
    body: Type.Object(
        {
            // 三选一，每个字段都要求非空字符串
            phone: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
            email: Type.Optional(Type.String({ format: "email", minLength: 1, maxLength: 100 })),
            userUUID: Type.Optional(Type.String({ format: "uuid-v4" })),
            reason: Type.Optional(Type.String({ maxLength: 255 })),
        },
        { additionalProperties: false },
    ),
};

export const banUser = async (req, reply): Promise<Response> => {
    const service = new UserBlacklistService(req.ids, req.DBTransaction);
    const { phone, email, userUUID, reason } = req.body;
    const operator = req.userUUID;

    // 三选一校验：必须恰好传一个标识
    const provided = [phone, email, userUUID].filter(Boolean);
    if (provided.length !== 1) {
        throw new FError(ErrorCode.ParamsCheckFailed);
    }

    if (phone) await service.banByPhone(phone, reason, operator);
    else if (email) await service.banByEmail(email, reason, operator);
    else if (userUUID) {
        const { matchedCount, skippedCount } = await service.banByUserUUID(
            userUUID,
            reason,
            operator,
        );
        return successJSON({ matchedCount, skippedCount });
    }

    return successJSON({});
};
```

路由配置：

```ts
server.post("admin/ban-user", banUser, {
    schema: banUserSchema,
    auth: false,
    admin: true,
});
```

#### 4.6.2 POST `/v2/admin/unban-user` —— 单条解冻

```ts
export const unbanUserSchema = {
    body: Type.Object(
        {
            phone: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
            email: Type.Optional(Type.String({ format: "email", minLength: 1, maxLength: 100 })),
            userUUID: Type.Optional(Type.String({ format: "uuid-v4" })),
        },
        { additionalProperties: false },
    ),
};
```

逻辑同 ban，三选一校验后调用 `service.unbanByPhone / unbanByEmail / unbanByUserUUID`。

#### 4.6.4 POST `/v2/admin/unban-user/batch` —— 批量解冻（三标识任选其一）

与批量 ban 对称，支持按手机号 / 邮箱 / userUUID 批量解除冻结：

```ts
export const unbanUserBatchSchema = {
    body: Type.Object(
        {
            phones: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 50 }), { maxItems: 500 })),
            emails: Type.Optional(Type.Array(Type.String({ format: "email", minLength: 1, maxLength: 100 }), { maxItems: 500 })),
            userUUIDs: Type.Optional(Type.Array(Type.String({ format: "uuid-v4" }), { maxItems: 500 })),
        },
        { additionalProperties: false },
    ),
};

export const unbanUserBatch = async (req): Promise<Response> => {
    const service = new UserBlacklistService(req.ids, req.DBTransaction);
    const { phones, emails, userUUIDs } = req.body;

    const nonEmpty = [phones, emails, userUUIDs].filter(arr => arr && arr.length > 0);
    if (nonEmpty.length === 0 || nonEmpty.length > 1) {
        throw new FError(ErrorCode.ParamsCheckFailed);
    }

    if (phones?.length) await service.unbanByPhones(phones);
    else if (emails?.length) await service.unbanByEmails(emails);
    else if (userUUIDs?.length) await service.unbanByUserUUIDs(userUUIDs);

    return successJSON({});
};
```

服务层同步增加 `unbanByPhones` / `unbanByEmails` / `unbanByUserUUIDs` 三个批量方法，实现走批量 `update is_delete = true` + 关联用户 `is_blacklist = false` 回写。

#### 4.6.3 POST `/v2/admin/ban-user/batch` —— 批量导入（三标识任选其一）

对应 R2 的"导入"场景，支持手机号 / 邮箱 / userUUID 三种批量导入。请求体三数组三选一（同时传多个时返回 `ParamsCheckFailed`）：

```ts
export const banUserBatchSchema = {
    body: Type.Object(
        {
            phones: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 50 }), { maxItems: 500 })),
            emails: Type.Optional(Type.Array(Type.String({ format: "email", minLength: 1, maxLength: 100 }), { maxItems: 500 })),
            userUUIDs: Type.Optional(Type.Array(Type.String({ format: "uuid-v4" }), { maxItems: 500 })),
            reason: Type.Optional(Type.String({ maxLength: 255 })),
        },
        { additionalProperties: false },
    ),
};

export const banUserBatch = async (req): Promise<Response> => {
    const service = new UserBlacklistService(req.ids, req.DBTransaction);
    const { phones, emails, userUUIDs, reason } = req.body;
    const operator = req.userUUID;

    const nonEmpty = [phones, emails, userUUIDs].filter(arr => arr && arr.length > 0);
    if (nonEmpty.length === 0 || nonEmpty.length > 1) {
        throw new FError(ErrorCode.ParamsCheckFailed);
    }

    if (phones?.length) await service.banByPhones(phones, reason, operator);
    else if (emails?.length) await service.banByEmails(emails, reason, operator);
    else if (userUUIDs?.length) {
        const { matchedCount, skippedCount } = await service.banByUserUUIDs(
            userUUIDs,
            reason,
            operator,
        );
        return successJSON({ matchedCount, skippedCount });
    }

    return successJSON({});
};
```

**批量实现要点**（`banByPhones` / `banByEmails` / `banByUserUUIDs` 共用）：

1. 在事务内拼一次性 SQL 批量插入 `user_blacklist` 表（用 `orIgnore` 避免唯一索引冲突）
2. 关联用户标记走批量查询：`SELECT user_uuid FROM user_phone WHERE phone_number IN (...)`，然后 `UPDATE users SET is_blacklist = true WHERE user_uuid IN (...)`
3. 回填 `user_blacklist.user_uuid`：对能关联到用户的记录，update 设上 `user_uuid` 字段
4. 全程在 `req.DBTransaction` 内，失败回滚
5. `banByUserUUIDs` 返回 `{ matchedCount, skippedCount }`（matchedCount = 命中存在用户的 userUUID 数；skippedCount = 不存在的 userUUID 数）；`banByPhones` / `banByEmails` 仍返回 `void`（phone/email 总会写入黑名单记录，不存在 skip 概念）

### 4.7 房间创建 / 加入拦截（R6）

#### 4.7.1 拦截点与拦截位置

| 入口 | 路径 | 文件 | 拦截位置 | 说明 |
|---|---|---|---|---|
| 创建普通房间 | `POST /room/create/ordinary` | `src/v1/controller/room/create/Ordinary.ts` | `execute()` 首行 | 创建无存在性探测，黑名单优先 |
| 创建周期房间 | `POST /room/create/periodic` | `src/v1/controller/room/create/Periodic.ts` | `execute()` 首行 | 同上 |
| 加入房间 | `POST /room/join` | `src/v1/controller/room/join/index.ts` | **房间存在性校验之后、分发 `joinOrdinary`/`joinPeriodic` 之前** | 见 4.7.3 优先级说明 |

v2 当前没有房间创建/加入路由（v2 的 `roomRouters` 仅有 `export-users` / `list/pmi`），所以拦截全部集中在 v1。

#### 4.7.2 创建房间实现

`CreateOrdinary.execute()` 与 `CreatePeriodic.execute()` 在首行加：

```ts
import { dataSource } from "../../../../thirdPartyService/TypeORMService";
import { UserBlacklistService } from "../../../v2/services/user/blacklist";

public async execute(): Promise<Response<ResponseType>> {
    // 黑名单拦截
    const blacklist = new UserBlacklistService(this.req.ids, dataSource.manager);
    await blacklist.assertNotBanned({ userUUID: this.userUUID });

    await this.checkParams();
    // ...原有逻辑
}
```

理由：创建房间没有 invite code 解析或房间存在性探测，黑名单是合规硬性阻断，应优先于业务校验（时间合法性、文本合规等）。

#### 4.7.3 加入房间实现与报错优先级

**业务要求**：黑名单用户用错误 invite code 请求时，直接走加入房间错误（如 `RoomNotFound`），**不返回** `UserBlacklisted`。这样黑名单用户无法通过错误码差异探测房间是否存在。

实现：把黑名单拦截放在 invite code 解析 + 房间存在性校验**之后**，分发到 `joinOrdinary`/`joinPeriodic` **之前**：

```ts
// src/v1/controller/room/join/index.ts
public async execute(): Promise<Response<ResponseType>> {
    const userUUID = this.userUUID;

    let uuid: string = this.body.uuid;
    if (this.isInviteCode()) {
        // ...原有 invite code → roomUUID 解析逻辑
        // 解析失败时抛 RoomNotFound / RoomNotFoundAndIsPmi（原有行为不变）
    }

    const isOrdinaryRoomUUID = await RoomDAO().findOne(["id"], {
        room_uuid: uuid,
        periodic_uuid: "",
    });

    if (isOrdinaryRoomUUID) {
        // 房间存在，才做黑名单拦截
        const blacklist = new UserBlacklistService(this.req.ids, dataSource.manager);
        await blacklist.assertNotBanned({ userUUID: this.userUUID });

        return await joinOrdinary(uuid, userUUID);
    }

    const isPeriodicRoom = await RoomPeriodicConfigDAO().findOne(["id"], {
        periodic_uuid: uuid,
    });

    if (isPeriodicRoom) {
        // 房间存在，才做黑名单拦截
        const blacklist = new UserBlacklistService(this.req.ids, dataSource.manager);
        await blacklist.assertNotBanned({ userUUID: this.userUUID });

        return await joinPeriodic(uuid, userUUID);
    }

    // 房间不存在：直接抛 RoomNotFound，不做黑名单拦截
    throw new ControllerError(ErrorCode.RoomNotFound);
}
```

#### 4.7.4 拦截优先级矩阵

| 场景 | 错误 invite code / 房间不存在 | 正确 invite code / 房间存在 |
|---|---|---|
| 黑名单用户 | `RoomNotFound`（不暴露黑名单身份） | `UserBlacklisted` |
| 正常用户 | `RoomNotFound` | 成功加入 |

#### 4.7.5 v1 controller 的 `this.req.ids` 来源确认

`AbstractController` 暴露 `this.req: PatchRequest`（extends `FastifyRequest`），`ids` 由 fastify hook 挂载到 request 上，通过 `this.req.ids` 访问，与 v2 的 `req.ids` 完全同构。`UserBlacklistService` 构造函数签名 `(ids: IDS, DBTransaction: EntityManager)` 兼容。

### 4.8 用户列表 / 详情返回 is_blacklist 字段

涉及 `ServiceUser`（v1）和 `services/user/info.ts`（v2）。需在用户查询的 select 列表加入 `is_blacklist`，并在响应类型中暴露。

> 注：本期仅做最小变更 —— 把字段加到模型和返回类型里，前端列表页若需要展示可在下一期对接。具体列表查询接口（如有）在实现阶段再 grep 确认。

## 5. API 一览

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| POST | `/v2/admin/ban-user` | admin secret | 按 phone / email / userUUID 单条 ban |
| POST | `/v2/admin/unban-user` | admin secret | 按 phone / email / userUUID 单条 unban |
| POST | `/v2/admin/ban-user/batch` | admin secret | 批量导入 phone / email / userUUID ban（三选一） |
| POST | `/v2/admin/unban-user/batch` | admin secret | 批量解冻 phone / email / userUUID（三选一） |

登录 / 注册 / 房间创建 / 房间加入接口签名不变，命中黑名单时返回：

```json
{
  "status": "Failed",
  "code": 400006
}
```

OAuth 回调命中黑名单时，按发券模式不同回传错误码：
- **模式 A**（Github / Google / WeChat-Web）：回调 `errorHandler` 写 `failedReason = "user_blacklisted"` 到 Redis，前端轮询 `/login/process` 时返回 `{ status: "Failed", code: 400006 }`
- **模式 B**（WeChat-Mobile / Apple JWT）：回调 `errorHandler` 走 `autoHandlerError`，直接返回 JSON `{ status: "Failed", code: 400006 }`
- **模式 C**（Agora）：回调 `errorHandler` redirect 到 `${Website}/login?error=blacklisted`，前端识别 query 提示

## 6. 错误码对照

| code | 含义 | 触发场景 |
|---|---|---|
| 400006 | UserBlacklisted | 登录 / 注册 / OAuth 发券 / 房间创建 / 房间加入时命中黑名单 |
| 100000 | ParamsCheckFailed | ban-user 三标识全空 / 传 null / 传空串 / 同时传多种标识 |
| 110000 | SMSAlreadyExist | 注册时手机号已存在（已有逻辑） |

## 7. 测试计划

参考 `src/v2/services/room/__tests__/admin.test.ts` 的写法，新建：

- `src/v2/services/user/__tests__/blacklist.test.ts`
  - `banByPhone` → 写入黑名单表 + 关联用户标记
  - `banByPhone` 手机号未注册 → 仅写黑名单表
  - `banByEmail` / `banByUserUUID` 同上
  - `banByPhones` / `banByEmails` / `banByUserUUIDs` 批量 + 重复标识幂等（先硬删后插）
  - `unbanByPhone` → 软删黑名单 + 清除用户标志
  - `unbanByPhones` / `unbanByEmails` / `unbanByUserUUIDs` 批量
  - `assertNotBanned` 命中抛 `UserBlacklisted`
  - `assertNotBanned` 未命中不抛
  - `assertNotBanned` 三标识任一命中即拦截
- `src/v2/controllers/admin/__tests__/ban-user.test.ts`
  - 三种标识路径（phone / email / userUUID）
  - 缺参返回 `ParamsCheckFailed`
  - 同时传多种标识返回 `ParamsCheckFailed`
  - 非 admin secret 返回 401
  - 批量 ban / unban 端到端
- 修改 v2 phone / email service 测试：补黑名单命中用例
- 修改 `src/v1/controller/room/create/__tests__/ordinary.test.ts`：补黑名单用户创建房间被拦截
- 修改 `src/v1/controller/room/join/__tests__/join.test.ts`：
  - 黑名单用户 + 正确 invite code → `UserBlacklisted`
  - 黑名单用户 + 错误 invite code → `RoomNotFound`（**不返回** `UserBlacklisted`，验证优先级）
  - 黑名单用户 + 房间不存在 → `RoomNotFound`
- v1 OAuth 回调测试（6 个入口）—— **因测试基建限制 skipped**：
  - OAuth 平台 Login 类（LoginGithub / LoginGoogle / LoginWechat / LoginApple / LoginAgora）均 `extends AbstractLogin`，后者 import 了 `alibabaCloud/Utils` + `cloudStorage/Files/Configs/UserFiles` 等重组件，ava 4 worker thread 加载即 JS heap OOM（`ERR_WORKER_OUT_OF_MEMORY`）。项目此前无任何 OAuth callback 单测，本特性亦无法绕过。
  - 拦截逻辑与 `/login/process` 完全一致（均调用 `UserBlacklistService.assertNotBanned({ userUUID })`），已由 `src/v1/controller/login/__tests__/process.test.ts` 的 3 个用例完整覆盖：blacklisted userUUID rejected / `failedReason === "user_blacklisted"` / non-blacklisted proceeds。
  - `src/v1/controller/login/github/__tests__/callback.test.ts` 保留 3 个 `.skip` 占位 + 头部说明，待 ava 升级或重构 AbstractLogin 解耦 cloud storage 后可启用。
- 修改 `src/v1/controller/login/__tests__/login.test.ts`：黑名单用户刷新 JWT → `UserBlacklisted`
- 修改 `src/v1/controller/login/__tests__/process.test.ts`：`failedReason === "user_blacklisted"` → 返回 `UserBlacklisted`
- 修改 `src/v2/services/user/__tests__/rebind-phone.test.ts`：
  - `sendMessage` 黑名单 phone → `UserBlacklisted`
  - `rebind` 黑名单 phone → `UserBlacklisted`
  - `rebind` 目标 `original.user_uuid` 黑名单 → `UserBlacklisted`
  - `rebind` caller 有房 + 目标 userUUID 黑名单 → `UserBlacklisted` 且房间状态/入会记录不变（校验顺序不变量）
- v1 `/user/bindingPhone` 与 `/user/bindingPhone/sendMessage` 单测 —— **因 v1 controller 测试基建限制 skipped**：v1 controller import `PhoneSMS` config → 阿里云 Dysmsapi SDK，ava 4 worker thread 加载即 JS heap OOM（与 OAuth 回调测试同一限制）。`src/v1/controller/user/binding/platform/phone/__tests__/binding.test.ts` 保留 2 个 `.skip` 占位 + 头部说明。拦截逻辑为单行 `assertNotBanned({ phone })`，与 v2 `rebind-phone` 测试覆盖的路径一致（均调 `UserBlacklistService.assertNotBanned`）。待 ava 升级或重构 `PhoneSMS` config 解耦阿里云 SDK 后可启用。

测试基座沿用 `__tests__/helpers/db/`：`useTransaction` + `testService` + `ids()`。

## 8. 文件清单

### 新建
- `src/model/user/Blacklist.ts`
- `src/v2/services/user/blacklist.ts`
- `src/v2/services/user/__tests__/blacklist.test.ts`
- `src/v2/controllers/admin/ban-user.ts`
- `src/v2/controllers/admin/unban-user.ts`
- `src/v2/controllers/admin/ban-user-batch.ts`
- `src/v2/controllers/admin/unban-user-batch.ts`
- `src/v2/controllers/admin/__tests__/ban-user.test.ts`
- `src/v2/controllers/admin/__tests__/unban-user.test.ts`
- `scripts/migration/2026-07-06_db_user-blacklist/index.sql`
- `scripts/migration/2026-07-06_db_user-blacklist/README.md`

### 修改
- `src/model/user/User.ts` —— 新增 `is_blacklist` 字段
- `src/model/index.ts` —— 导出 `UserBlacklistModel`
- `src/ErrorCode.ts` —— 新增 `UserBlacklisted`（400006）
- `src/thirdPartyService/TypeORMService.ts` —— 注册 `UserBlacklistModel` 实体
- `src/utils/Redis.ts` —— 新增 `userBlacklist(userUUID)` key
- `src/plugins/fastify/authenticate.ts` —— 已认证请求查 Redis 黑名单缓存，命中即返回 `UserBlacklisted`（见 9.1）
- `src/abstract/controller/index.ts` —— `parseFlatError` 兼容 `FError`（v2 抛 `FError` 需经此映射为 `ResponseError`）
- `src/v2/dao/index.ts` —— 注册 `userBlacklistDAO`
- `src/v2/controllers/admin/routes.ts` —— 注册四条新路由
- `src/v2/services/user/phone.ts` —— `login` / `register` 调用 `assertNotBanned`（phone 内部由 `safePhone` 归一化）
- `src/v2/services/user/email.ts` —— `login` / `register` 调用 `assertNotBanned`（email 内部由 `toLowerCase` 归一化）
- `src/v1/controller/login/phone/Phone.ts` —— `execute` 调用 `assertNotBanned({ phone })`
- `src/v1/controller/login/Login.ts` —— `execute` 首行调用 `assertNotBanned({ userUUID })`（4.5.4，拦截 JWT 刷新）
- `src/v1/controller/login/Process.ts` —— `failedReason` 增加 `"user_blacklisted"` 映射 + `assertNotBanned({ userUUID })`（4.5.5）
- `src/v1/controller/login/github/Callback.ts` —— `userUUIDByUnionUUID` 后拦截 + `errorHandler` 写 `user_blacklisted`（4.5.6 模式 A）
- `src/v1/controller/login/google/Callback.ts` —— 同上
- `src/v1/controller/login/weChat/web/Callback.ts` —— `errorHandler` 识别 `FError(UserBlacklisted)` 写 `user_blacklisted` + 返回 `failedHTML()`（4.5.6 模式 A）
- `src/v1/controller/login/weChat/mobile/Callback.ts` —— `errorHandler` 识别 `FError(UserBlacklisted)` 写 `user_blacklisted`（4.5.6 模式 B）
- `src/v1/controller/login/weChat/Utils.ts` —— `wechatCallback` 内 `userUUIDByUnionUUID` 后拦截（4.5.6 模式 A/B 共用）
- `src/v1/controller/login/apple/jwt.ts` —— `userUUIDByUnionUUID` 后拦截（4.5.6 模式 B）
- `src/v1/controller/login/agora/Callback.ts` —— `userUUIDByUnionUUID` 后拦截 + `errorHandler` redirect 带 `error=blacklisted`（4.5.6 模式 C）
- `src/v1/controller/room/create/Ordinary.ts` —— `execute` 首行调用 `assertNotBanned({ userUUID })`
- `src/v1/controller/room/create/Periodic.ts` —— `execute` 首行调用 `assertNotBanned({ userUUID })`
- `src/v1/controller/room/join/index.ts` —— 房间存在性校验后、分发 `joinOrdinary`/`joinPeriodic` 前调用 `assertNotBanned({ userUUID })`（4.7.3，错误 invite code 不暴露黑名单身份）
- `src/v1/controller/user/binding/platform/phone/Binding.ts` —— `execute` 在 `safePhone` 计算后调用 `assertNotBanned({ phone })`（4.5.7）
- `src/v1/controller/user/binding/platform/phone/SendMessage.ts` —— `execute` 在 `safePhone` 计算后调用 `assertNotBanned({ phone })`（4.5.7）
- `src/v2/services/user/rebind-phone.ts` —— `sendMessage()` / `rebind()` 调用 `assertNotBanned({ phone })`，`rebind()` 在获取 `original.user_uuid` 后调用 `assertNotBanned({ userUUID: original.user_uuid })`；所有校验移到破坏性写操作之前（4.5.7、9.13）
- `src/v2/services/user/__tests__/rebind-phone.test.ts` —— 补 sendMessage / rebind 黑名单拦截用例 + 校验顺序无副作用用例
- `src/v1/controller/user/binding/platform/phone/__tests__/binding.test.ts` —— 2 个 `.skip` 占位（OOM 限制，见第 7 节）
- `config/test.yaml` —— admin secret / captcha 配置（测试用）

### 前端配套（flat 仓库，单独提 PR）
- `packages/flat-server-api/src/error.ts` —— `RequestErrorCode` 新增 `UserBlacklisted = 400006`，`RequestErrorMessage` 新增对应 i18n key
- `packages/flat-pages` —— login 页识别 Agora redirect 的 `?error=blacklisted` query 并提示

## 9. 风险与遗留问题

1. **OAuth 路径覆盖**：本期已覆盖全部 OAuth 发券路径 —— 6 个回调入口（Github / Google / WeChat-Web / WeChat-Mobile / Apple-JWT / Agora）在 `userUUIDByUnionUUID` 后拦截（4.5.6），`/login/process` 发券前拦截（4.5.5），`/login` JWT 刷新拦截（4.5.4）。三种发券模式（Redis 中转 / JSON 直返 / redirect 直返）均无遗漏。**JWT 立即失效**：`authenticate` 中间件已加 Redis 黑名单缓存查询（`RedisKey.userBlacklist(userUUID)`，TTL 29 天），ban 时写缓存、unban 时清缓存，保证黑名单用户的已有 JWT 在下一个请求即被拦截，无需等 JWT 过期。
   - **权衡**：`authenticate` 中间件仅查 Redis 缓存，不查 DB。若 Redis 被刷新或重启，已 ban 用户的旧 JWT 在缓存被重新填充前不会被拦截（重新填充需要再次执行 ban 操作或等用户再次 login/register 触发 `assertNotBanned`）。这是性能与一致性的权衡——每个已认证请求都查 DB 开销过大，Redis 缓存 + 29 天 TTL 是合理折中。
2. **MySQL UNIQUE 与 NULL**：MySQL 允许多个 NULL 共存于 UNIQUE 索引，三标识字段均 nullable 不会冲突。**API 层强制要求参数必须有值，三道防线拒绝空值**：
   - **Schema 层**：所有标识字段用 `Type.Optional(Type.String({ minLength: 1, maxLength: N }))`。字段可缺省（`Optional`），但不可为 `null` / `""` —— TypeBox 的 `Type.String()` 本身拒绝 `null`（非 string 类型），`minLength: 1` 拒绝空字符串，Ajv 校验失败直接返回 `ParamsCheckFailed`
   - **Controller 层**：接收 `req.body` 后用 `[phone, email, userUUID].filter(Boolean)` 过滤假值（`null` / `undefined` / `""` 均被过滤），再做"三选一恰好一个"校验，不满足抛 `ParamsCheckFailed`
   - **Service 层**：`assertNotBanned` / `banByXxx` 内部对每个标识做 `if (identifier.phone)` 真值检查，假值直接跳过，不拼入 OR 查询、不写入 `user_blacklist` 表

   三层防护确保不会有全 NULL 行写入 `user_blacklist` 表，也不会因 NULL 语义导致唯一索引行为异常。
3. **解冻后再 ban**：当前设计 unban 走软删（`is_delete = true`）。再次 ban 同一手机号会因唯一索引冲突插入失败。实现时需用 `orIgnore` 或先硬删旧软删记录再插入。**推荐**：ban 逻辑改为"先硬删旧软删记录，再 insert"，保证幂等。
4. **`is_blacklist` 字段同步一致性**：ban 时若用户不存在，`users.is_blacklist` 不会被设置；未来该用户注册时会在 `assertNotBanned` 阶段被拦截，因此 `is_blacklist` 字段保持 false 即可，无矛盾。
5. **管理端审计**：`operator` 字段记录操作者。当前 admin 走 `x-flat-secret` 校验，没有 userUUID，`operator` 留空或写 `"system"`。如需对接真实管理员账号体系，下期扩展。
6. **批量操作的事务粒度**：批量 ban/unban 单次最多 500 条，全程在同一事务内。若单条失败整批回滚。如果业务希望"部分成功"语义，下期改为逐条 try-catch + 返回成功/失败列表，但本期保守起见走全事务。
7. **unban 时 Redis 缓存仅清除"完全解冻"的用户**：用户同时被 phone 和 email ban，按 phone unban 时，`resetUserBlacklistFlag` 内部计算 `toReset`（email ban 仍在 → 该用户不进 `toReset`），`clearBanCache` 仅清除 `toReset` 中的用户。这样仍被其他标识符封禁的用户不会被错误放行。`resetUserBlacklistFlag` 返回 `toReset` 数组供 `clearBanCache` 使用。
8. **标识符归一化**：`UserBlacklistService` 内部对 phone 调 `SMSUtils.safePhone()`、email 调 `toLowerCase()` 归一化，防止 PA 输入格式与系统存储格式不一致导致黑名单被绕过（见 4.4.1）。`user_blacklist` 表始终存归一化后的值；`user_phone` / `user_email` 表存储格式不变，`banByPhones` 查 `user_phone` 时兼容 `safePhone` 和 `+safePhone` 两种格式。
9. **密码重置端点**：`/v2/reset/phone` 和 `/v2/reset/email`（`auth: false`）不做黑名单检查。黑名单用户可重置密码但仍无法登录（登录路径已拦截），非安全漏洞。属有意遗漏。
10. **手机号绑定端点**：`/user/bindingPhone`（v1）与 `/user/rebind-phone`（v2）已显式调用 `assertNotBanned({ phone })`，拒绝绑定/换绑到黑名单手机号。v2 `rebind()` 同时检查 `original.user_uuid`（目标手机号原属用户）是否在黑名单中，避免把正常账号的 OAuth/邮箱绑定合并到黑名单用户上。`/user/bindingPhone/sendMessage` 与 `/user/rebind-phone/send-message` 发短信阶段同样拦截，阻止黑名单手机号获取验证码。
11. **房间加入的报错优先级**：黑名单用户加入房间时，报错优先级为 **房间存在性 > 黑名单身份**：
   - 错误 invite code / 房间不存在 → 返回 `RoomNotFound`（或 `RoomNotFoundAndIsPmi`），**不返回** `UserBlacklisted`
   - 正确 invite code / 房间存在 + 黑名单用户 → 返回 `UserBlacklisted`

   这是预期行为，避免黑名单用户通过错误码差异探测房间是否存在。实现上，黑名单拦截放在 invite code 解析 + 房间存在性校验**之后**、分发 `joinOrdinary`/`joinPeriodic` **之前**（见 4.7.3）。优先级矩阵见 4.7.4。
12. **Redis 副作用与 DB 事务提交边界**：`UserBlacklistService` 的 `setBanCache` / `clearBanCache` 在 DB 事务内部执行，而 v2 事务由 `@fastify-userland/typeorm-query-runner` 在 `onSend` hook 中 commit/rollback。Redis 与 DB 无原子性，存在以下分叉：
   - **ban + Redis 成功 + DB 回滚**：Redis 缓存已写入但 DB 无黑名单记录。`authenticate` 中间件（仅查 Redis）会拦截该用户 JWT，但 `assertNotBanned`（查 DB）不会拦截登录/注册/房间。影响：已有 JWT 在 Redis TTL（29 天）内被拦截，新登录不受影响。属临时误拦，TTL 到期后自愈。
   - **unban + Redis 清除 + DB 回滚**：Redis 缓存已清除但 DB 黑名单仍在。`authenticate` 中间件放行（无缓存），但 `assertNotBanned`（查 DB）仍拦截房间创建/加入、登录/注册。影响：用户可通过 `authenticate` 但无法执行需 `assertNotBanned` 的操作。属部分绕过，DB 记录仍在故不会完全放行。
   - **批量 ban 中 Redis 部分成功**：`setBanCache` 使用 `Promise.all` 并发写多个 userUUID 的缓存。若部分 `set` 已成功、随后某个 `set` 失败，异常向上传播触发 DB 回滚，但已成功写入的 Redis key 不会自动撤回，产生临时缓存残留（TTL 29 天后自愈，或等下次 unban 清理）。
   - **当前策略**：Redis `set`/`del` 失败时异常向上传播，触发 DB 回滚（ban/unban 整体失败）。但已成功执行的 Redis 副作用无法自动回滚，可能产生临时缓存残留。代价是 Redis 故障期间 ban/unban 操作不可用且可能残留部分缓存。
   - **已知遗留**：DB commit 失败（如连接断开）时 Redis 副作用不可回滚。由于 commit 失败本身罕见且影响范围为临时误拦/部分绕过（均有 TTL 或 DB 记录兜底），本期保留现状。后续可考虑将 Redis 副作用移到事务提交后执行（需自定义 after-commit hook 或在 controller 层分离副作用），或对失败时已写入的 key 做补偿清理。
13. **v2 `rebind()` 校验顺序**：`UserRebindPhoneService.rebind()` 的所有会抛业务错误的校验（当前用户存在性、当前用户是否已有手机号、目标手机号原属用户存在性、`assertNotBanned({ userUUID: original.user_uuid })`、验证码校验）均在停房/删入会记录/迁移绑定/删除当前账号等破坏性写操作之前执行。原因是 v2 `@fastify-userland/typeorm-query-runner` 的 rollback 条件仅匹配 `CurrentProcessFailed` 固定 payload，`UserBlacklisted` 等业务错误会走 commit 路径——若破坏性操作在业务错误之前执行，请求失败但副作用已提交。测试 `rebind with blacklisted target userUUID does not stop caller rooms` 覆盖该不变量。

## 10. 实施步骤（粗粒度，供后续拆 task）

1. 数据层：新建 `UserBlacklistModel`、修改 `UserModel`、注册 DAO、写迁移 SQL
2. 错误码：`UserBlacklisted`（400006）
3. 服务层：`UserBlacklistService` 全部方法（含批量 ban / 批量 unban）+ 单元测试
4. 登录注册改造：v2 phone/email service + v1 PhoneLogin + 测试
5. OAuth 回调拦截：6 个入口（Github / Google / WeChat-Web / WeChat-Mobile / Apple-JWT / Agora）+ `wechatCallback` 工具函数 + `Login.ts` / `Process.ts` + 测试
6. 房间流程改造：v1 `create/Ordinary`、`create/Periodic`、`join/index` 三个 controller + 测试（含错误 invite code 优先级用例）
7. 管理端 API：四个 controller（ban / unban / ban-batch / unban-batch）+ 路由注册 + 测试
8. 前端配套：`flat-server-api` 错误码枚举 + login 页 Agora redirect query 识别（单独 PR）
9. 自测：`yarn test:local` 全量回归
10. 迁移：在测试库执行 SQL，端到端验证 ban → 登录/注册/OAuth 回调/创建房间/加入房间均被拦截 → unban → 全部恢复
