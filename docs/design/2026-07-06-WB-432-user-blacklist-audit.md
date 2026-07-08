# WB-432 用户黑名单功能 - 设计文档审计报告（第九轮）

> 审计日期: 2026-07-07
> 审计对象: `docs/design/2026-07-06-WB-432-user-blacklist.md`
> Jira: https://jira.agoralab.co/browse/WB-432
> 审计范围: 设计文档 + flat-server 黑名单主功能落盘代码 + flat 前端项目 `/Users/hongqiuer/work/flat`

## 审计结论

第八轮遗留的服务端黑名单校验缺口已在本轮补齐：`UserPhoneService` / `UserEmailService` 的 `sendMessageForRegister`、`sendMessageForReset`、`reset` 方法首行新增 `assertNotBanned` 调用，覆盖注册发送验证码、重置密码发送验证码、重置密码三条路径。

flat 前端复验确认：所有非 OAuth 流程（注册、绑定、换绑、密码登录、验证码登录、重置密码）已通过 `errorTips()` 统一处理 `UserBlacklisted` 错误码并显示 `user-blacklisted` 文案；OAuth 流程通过 `?error=blacklisted` 重定向处理。前端无需额外改动。

已执行测试：

```text
yarn ava src/v2/services/user/__tests__/rebind-phone.test.ts src/v2/services/user/__tests__/blacklist.test.ts src/v2/services/user/__tests__/email.test.ts src/v2/services/user/__tests__/phone.test.ts src/v2/controllers/admin/__tests__/ban-user.test.ts src/v2/controllers/admin/__tests__/ban-user-auth.test.ts src/v1/controller/login/__tests__/process.test.ts src/v1/controller/login/__tests__/login.test.ts src/v1/controller/user/binding/platform/phone/__tests__/binding.test.ts --timeout=120s --no-fail-fast
84 tests passed, 2 tests failed, 2 tests skipped
```

2 个失败用例为 `user email register success` / `user phone register success`，因 `setGuidePPTX` 调用 OSS `test.test` 端点不可达（`ENOTFOUND`），属测试环境基础设施问题，与黑名单功能无关。

## 本轮修复项

### 服务端黑名单校验缺口补齐

**背景**：第八轮审计发现 `UserPhoneService` / `UserEmailService` 的 `sendMessageForRegister`、`sendMessageForReset`、`reset` 三个方法未调用 `assertNotBanned`，导致黑名单手机号/邮箱仍可收到注册验证码、重置密码验证码，且黑名单用户可执行重置密码操作。

**修复内容**：

`src/v2/services/user/email.ts`：
- `sendMessageForRegister(email)` —— 首行新增 `assertNotBanned({ email })`
- `sendMessageForReset(email)` —— 首行新增 `assertNotBanned({ email })`
- `reset(email, code, password)` —— `hash(password)` 后新增 `assertNotBanned({ email })`

`src/v2/services/user/phone.ts`：
- `sendMessageForRegister(phone, captchaVerifyParam)` —— `safePhone` 计算后新增 `assertNotBanned({ phone })`
- `sendMessageForReset(phone, captchaVerifyParam)` —— `safePhone` 计算后新增 `assertNotBanned({ phone })`
- `reset(phone, code, password)` —— `safePhone` 计算后新增 `assertNotBanned({ phone })`

**拦截顺序**：`assertNotBanned` 均放在 `canSend`（rate limit）和 `notExhaustiveAttack` 之前，确保黑名单用户立即被拒绝，不消耗 rate limit 配额、不发送短信/邮件。

**测试覆盖**（`src/v2/services/user/__tests__/email.test.ts`、`phone.test.ts`）：

新增 6 个 `test.serial` 用例：
- `blacklisted email/phone sendMessageForRegister rejected`
- `blacklisted email/phone sendMessageForReset rejected`
- `blacklisted email/phone reset rejected`

`email.test.ts` / `phone.test.ts` 的全部测试改为 `test.serial`（与 `blacklist.test.ts` 一致），避免并发事务对 `user_blacklist` 表的 `deleteHard` + `insert` 写入与 `assertNotBanned` 的 `SELECT` 产生 InnoDB next-key lock 死锁。

## 前端复验

前端无需改动。所有非 OAuth 流程的错误已通过 `errorTips()`（`flat-components/src/utils/errorTip.ts`）统一处理：

- `ServerRequestError` 构造时 `errorMessage = RequestErrorMessage[UserBlacklisted] = "user-blacklisted"`
- `errorTips` 调用 `FlatI18n.t("user-blacklisted")` → `message.error(...)`
- 覆盖路径：注册、注册发送验证码、绑定手机、绑定手机发送验证码、换绑手机、换绑手机发送验证码、密码登录、验证码登录、重置密码、重置密码发送验证码、创建/加入房间、UserSettingPage 改绑

OAuth 流程（agora/github/google/wechat/apple）通过服务端 redirect `?error=blacklisted` → `LoginPage/utils/state.ts` `useEffect` 捕获并提示。

## 已修复项复验（前轮）

### `/v2/admin/*` HTTP 层 401 鉴权测试（第八轮）

`src/v2/controllers/admin/__tests__/ban-user-auth.test.ts` 通过 `fastify.inject` 验证 `authenticateAdmin` 中间件 HTTP 层行为：缺失/错误 `x-flat-secret` → 401 + `NotPermission`；正确 secret → 200。

### `banByUserUUIDs` 返回计数（第八轮）

`banByUserUUID` / `banByUserUUIDs` 返回 `{ matchedCount, skippedCount }`；`/v2/admin/ban-user` 与 `/v2/admin/ban-user-batch` 在 userUUID 路径下回传计数。

### v2 `rebind()` 校验顺序（第六轮）

`UserRebindPhoneService.rebind()` 业务校验全部前置到破坏性写操作之前。

### Redis 副作用文档（第六轮）

设计文档第 9 节已明确 Redis 与 DB 无原子性。

### 绑定 / 换绑黑名单拦截（第六轮）

v1 `/user/bindingPhone` 与 `/user/bindingPhone/sendMessage`、v2 `/user/rebind-phone` 与 `/user/rebind-phone/send-message` 均已检查目标 phone。

## 修复优先级

| 优先级 | 问题 | 建议动作 | 状态 |
|---|---|---|---|
| P2 | `sendMessageForRegister` / `sendMessageForReset` / `reset` 未校验黑名单 | 三个方法首行新增 `assertNotBanned` | 已修复（第九轮） |
| P3 | `/v2/admin/*` 401 HTTP 层测试缺口 | 增加 inject 级别无效 `x-flat-secret` 测试 | 已修复（第八轮） |
| P3 | 不存在 userUUID 静默成功 | 返回 `matchedCount` / `skippedCount` | 已修复（第八轮） |
| 已修复 | v2 `rebind()` 黑名单失败前已有破坏性副作用 | 校验前置，补 no-side-effect 测试 | 已修复（第六轮） |
| 已修复 | Redis "无部分状态"表述不准确 | 修正文档，明确 Redis 副作用无法自动回滚 | 已修复（第六轮） |
| 已修复 | 文件清单/测试计划漏绑定换绑文件 | 补齐第 7/8 节 | 已修复（第六轮） |
