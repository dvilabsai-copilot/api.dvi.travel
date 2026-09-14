CREATE TABLE `dvi_calendar_events` (
  `calendar_event_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `event_key` VARCHAR(150) NOT NULL,
  `title` VARCHAR(200) NOT NULL,
  `short_title` VARCHAR(80) NULL,
  `event_type` VARCHAR(40) NOT NULL,
  `event_start_date` DATE NOT NULL,
  `event_end_date` DATE NOT NULL,
  `travel_window_start_date` DATE NOT NULL,
  `travel_window_end_date` DATE NOT NULL,
  `is_public_holiday` TINYINT NOT NULL DEFAULT 0,
  `travel_impact` VARCHAR(20) NOT NULL DEFAULT 'UNSPECIFIED',
  `description` TEXT NULL,
  `travel_advisory` TEXT NULL,
  `source_name` VARCHAR(255) NULL,
  `source_reference` VARCHAR(500) NULL,
  `sort_priority` INT NOT NULL DEFAULT 100,
  `createdby` BIGINT NOT NULL DEFAULT 0,
  `createdon` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `updatedon` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `status` TINYINT NOT NULL DEFAULT 1,
  `deleted` TINYINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`calendar_event_id`),
  UNIQUE INDEX `uq_dvi_calendar_events_event_key` (`event_key`),
  INDEX `idx_dvi_calendar_events_window_status` (`deleted`, `status`, `travel_window_start_date`, `travel_window_end_date`),
  INDEX `idx_dvi_calendar_events_event_start` (`event_start_date`),
  INDEX `idx_dvi_calendar_events_status_deleted` (`status`, `deleted`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `dvi_calendar_event_scopes` (
  `calendar_event_scope_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `calendar_event_id` BIGINT UNSIGNED NOT NULL,
  `scope_type` VARCHAR(20) NOT NULL,
  `scope_ref_id` INT NOT NULL,
  `status` TINYINT NOT NULL DEFAULT 1,
  `deleted` TINYINT NOT NULL DEFAULT 0,
  `createdon` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `updatedon` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  PRIMARY KEY (`calendar_event_scope_id`),
  UNIQUE INDEX `uq_dvi_calendar_event_scope` (`calendar_event_id`, `scope_type`, `scope_ref_id`),
  INDEX `idx_dvi_calendar_event_scope_lookup` (`scope_type`, `scope_ref_id`, `status`, `deleted`),
  INDEX `idx_dvi_calendar_event_scope_event` (`calendar_event_id`),
  CONSTRAINT `fk_dvi_calendar_event_scope_event`
    FOREIGN KEY (`calendar_event_id`) REFERENCES `dvi_calendar_events` (`calendar_event_id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
