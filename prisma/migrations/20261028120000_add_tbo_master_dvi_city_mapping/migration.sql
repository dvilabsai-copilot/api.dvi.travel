ALTER TABLE `tbo_hotel_master`
  ADD COLUMN `dvi_city_id` INT NULL,
  ADD INDEX `idx_tbo_hotel_master_dvi_city_id` (`dvi_city_id`);
