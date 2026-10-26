CREATE TABLE IF NOT EXISTS `dvi_hotel_block_guest_details` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `itinerary_plan_id` INT NOT NULL,
  `guest_payload` LONGTEXT NOT NULL,
  `created_by` INT NULL,
  `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_dvi_hotel_block_guest_plan` (`itinerary_plan_id`),
  KEY `idx_dvi_hotel_block_guest_plan` (`itinerary_plan_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
