ALTER TABLE `dvi_global_settings`
  ADD COLUMN `hotel_hold_long_lead_days` INT NOT NULL DEFAULT 60,
  ADD COLUMN `hotel_hold_extended_duration_hours` FLOAT NOT NULL DEFAULT 240,
  ADD COLUMN `hotel_hold_reminders_enabled` TINYINT NOT NULL DEFAULT 1,
  ADD COLUMN `hotel_hold_reminder_email_enabled` TINYINT NOT NULL DEFAULT 1,
  ADD COLUMN `hotel_hold_reminder_milestones` LONGTEXT NULL,
  ADD COLUMN `hotel_hold_final_reminder_minutes` INT NOT NULL DEFAULT 15;

-- Replace only the old default short duration. Explicitly configured values
-- remain unchanged; the new policy default is 48 hours.
UPDATE `dvi_global_settings`
SET `hotel_hold_short_duration_hours` = 48
WHERE `hotel_hold_short_duration_hours` = 4;

-- Calendar-day bands are authoritative. Remove the legacy 48-hour elapsed-time
-- buffer where it was left at its old default, so a valid Day-3 hold is not
-- rejected because of a timezone/clock-time difference.
UPDATE `dvi_global_settings`
SET `hotel_hold_no_block_before_hours` = 0
WHERE `hotel_hold_no_block_before_hours` = 48;

UPDATE `dvi_global_settings`
SET `hotel_hold_reminder_milestones` = '{"12":[6,3,0.25],"48":[36,24,12,1,0.25],"240":[216,192,168,144,120,96,72,48,24,12,1,0.25]}'
WHERE `hotel_hold_reminder_milestones` IS NULL;

ALTER TABLE `dvi_hotel_block_requests`
  ADD COLUMN `release_status` VARCHAR(24) NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN `release_requested_at` DATETIME(0) NULL,
  ADD COLUMN `release_attempt_count` INT NOT NULL DEFAULT 0,
  ADD COLUMN `release_acknowledged_at` DATETIME(0) NULL,
  ADD COLUMN `release_last_error` TEXT NULL,
  ADD COLUMN `paid_confirmed_at` DATETIME(0) NULL,
  ADD COLUMN `release_email_status` VARCHAR(24) NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN `release_email_requested_at` DATETIME(0) NULL,
  ADD COLUMN `release_email_sent_at` DATETIME(0) NULL,
  ADD COLUMN `release_email_last_error` TEXT NULL;

CREATE TABLE `dvi_hotel_hold_notifications` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `request_id` INT NOT NULL,
  `request_version` INT NOT NULL DEFAULT 1,
  `notification_type` VARCHAR(24) NOT NULL,
  `milestone_key` VARCHAR(64) NOT NULL,
  `due_at` DATETIME(0) NOT NULL,
  `recipient` VARCHAR(320) NULL,
  `delivery_status` VARCHAR(24) NOT NULL DEFAULT 'QUEUED',
  `attempt_count` INT NOT NULL DEFAULT 0,
  `provider_message_id` VARCHAR(255) NULL,
  `last_error` TEXT NULL,
  `sent_at` DATETIME(0) NULL,
  `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_hotel_hold_notification_milestone` (`request_id`, `request_version`, `notification_type`, `milestone_key`),
  KEY `idx_hotel_hold_notification_due` (`delivery_status`, `due_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
