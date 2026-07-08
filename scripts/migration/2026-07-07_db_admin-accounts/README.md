## 2026-07-07

WB-432 黑名单管理网页 admin 登录账号。新增 `admin_accounts` 表，并初始化默认账号：

```text
admin/admin1234
```

### 执行步骤

1. 先确认已经执行 `scripts/migration/2026-07-06_db_user-blacklist/index.sql`
2. 在执行迁移前停止 flat-server 流量（关服维护）
3. 执行 `scripts/migration/2026-07-07_db_admin-accounts/index.sql`
4. 同步 flat-server 最新代码并重新部署
5. 登录 `/admin/blacklist` 后立即修改默认账号密码（如已实现改密入口）或在数据库中替换初始 hash

### SQL 执行示例

```bash
mysql -h <host> -P <port> -u <user> -p <database> < scripts/migration/2026-07-07_db_admin-accounts/index.sql
```

### 说明

- `admin_accounts.password_hash` 使用 `sha256(password_salt + ":" + password)` 存储
- 初始密码不会明文写入表中，但默认账号仍应只用于首次登录/内测
- dev / test 环境可通过 `yarn test:sync:orm` 自动建表，但初始化账号仍需执行本 SQL 或手动插入
