ALTER TABLE `tbo_hotel_master`
  ADD COLUMN `is_priority` TINYINT NOT NULL DEFAULT 0,
  ADD COLUMN `amenities` JSON NULL,
  ADD COLUMN `reviews` JSON NULL,
  ADD INDEX `idx_tbo_hotel_master_priority` (`is_priority`);
