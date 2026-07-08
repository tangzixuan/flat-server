-- WB-432: 黑名单管理网页 admin 账号
-- 1. 新建 admin_accounts 表
-- 2. 初始化账号 admin/admin1234

CREATE TABLE `admin_accounts` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(64) NOT NULL COMMENT 'admin login username',
  `password_hash` VARCHAR(128) NOT NULL COMMENT 'password hash',
  `password_salt` VARCHAR(64) NOT NULL COMMENT 'password salt',
  `is_delete` TINYINT(1) NOT NULL DEFAULT 0,
  `last_login_at` DATETIME(3) NULL DEFAULT NULL COMMENT 'last login time',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `version` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `admin_accounts_username_uindex` (`username`),
  INDEX `admin_accounts_is_delete_index` (`is_delete`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Flat admin accounts';

INSERT IGNORE INTO `admin_accounts` (
  `username`,
  `password_hash`,
  `password_salt`,
  `is_delete`
) VALUES (
  'admin',
  '5e88c4da92e68a1e2684b17b4edac9e4a7e83dca9cb2f7795f37d215e0056729',
  'flat-server-admin-default-salt',
  0
);
