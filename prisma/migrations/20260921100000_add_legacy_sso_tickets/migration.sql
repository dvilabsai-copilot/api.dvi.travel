CREATE TABLE `dvi_legacy_sso_tickets` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `token_hash` CHAR(64) NOT NULL,
  `user_id` BIGINT NOT NULL,
  `audience` VARCHAR(32) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `consumed_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_dvi_legacy_sso_tickets_token_hash` (`token_hash`),
  KEY `idx_dvi_legacy_sso_tickets_user_id` (`user_id`),
  KEY `idx_dvi_legacy_sso_tickets_expires_at` (`expires_at`),
  KEY `idx_dvi_legacy_sso_tickets_redeem` (`audience`, `consumed_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
