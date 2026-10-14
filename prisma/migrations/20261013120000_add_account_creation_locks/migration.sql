CREATE TABLE IF NOT EXISTS `dvi_account_creation_locks` (
  `lock_key` CHAR(64) NOT NULL,
  `updatedon` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`lock_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
