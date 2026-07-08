## 2026-07-06

WB-432 用户黑名单（冻结）功能。新增 `user_blacklist` 表，并在 `users` 表增加 `is_blacklist` 字段。

### 执行步骤

1. 在执行迁移前停止 flat-server 流量（关服维护）
2. 执行 `scripts/migration/2026-07-06_db_user-blacklist/index.sql` 中的 SQL
3. 同步 flat-server 最新代码并重新部署

### SQL 执行示例

```bash
mysql -h <host> -P <port> -u <user> -p <database> < scripts/migration/2026-07-06_db_user-blacklist/index.sql
```

### 说明

- dev / test 环境通过 `yarn test:sync:orm`（`scripts/sync-orm.ts`）自动 `synchronize` 建表，无需手动执行本 SQL
- 生产环境必须手动执行本 SQL，因为 `synchronize` 在生产被禁用
- `user_blacklist` 表的三个标识字段（`user_uuid` / `phone_number` / `email`）均 nullable，MySQL UNIQUE 索引允许多个 NULL 共存，因此不会互相冲突
