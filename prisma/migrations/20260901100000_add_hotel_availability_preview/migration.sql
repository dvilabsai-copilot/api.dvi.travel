CREATE TABLE `dvi_itinerary_hotel_availability_preview` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `preview_id` VARCHAR(100) NOT NULL,
  `quote_id` VARCHAR(50) NOT NULL,
  `plan_id` INT NOT NULL,
  `payload_json` LONGTEXT NOT NULL,
  `expires_at` DATETIME(0) NOT NULL,
  `status` TINYINT NOT NULL DEFAULT 1,
  `createdon` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `updatedon` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_hotel_availability_preview_id` (`preview_id`),
  INDEX `idx_hotel_availability_preview_scope` (`quote_id`, `plan_id`, `status`),
  INDEX `idx_hotel_availability_preview_expiry` (`expires_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
