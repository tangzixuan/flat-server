-- WB-432: 用户黑名单功能
-- 1. users 表新增 is_blacklist 字段
-- 2. 新建 user_blacklist 表

ALTER TABLE `users`
  ADD COLUMN `is_blacklist` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否黑名单用户',
  ADD INDEX `users_is_blacklist_index` (`is_blacklist`);

CREATE TABLE `user_blacklist` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_uuid` VARCHAR(40) NULL DEFAULT NULL COMMENT 'banned user uuid, nullable if banned by phone/email only',
  `phone_number` VARCHAR(50) NULL DEFAULT NULL COMMENT 'banned phone number',
  `email` VARCHAR(100) NULL DEFAULT NULL COMMENT 'banned email',
  `reason` VARCHAR(255) NULL DEFAULT NULL COMMENT 'ban reason',
  `operator` VARCHAR(40) NULL DEFAULT NULL COMMENT 'operator (admin user uuid or system name)',
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
