ALTER TABLE `dvi_global_settings` ADD COLUMN `houseboat_only_city_ids` JSON NULL;
ALTER TABLE `tbo_hotel_master` ADD COLUMN `is_houseboat` BOOLEAN NULL;
CREATE INDEX `idx_tbo_hotel_houseboat_city`
  ON `tbo_hotel_master` (`tbo_city_code`, `is_houseboat`, `status`);

UPDATE `tbo_hotel_master` AS hotel
LEFT JOIN `dvi_hotel_category` AS category ON category.hotel_category_id = hotel.hotel_category_id
SET hotel.is_houseboat = TRUE
WHERE hotel.is_houseboat IS NULL AND (
  category.hotel_category_code = 'HOUSEBOAT'
  OR hotel.tbo_hotel_code IN ('1674220', '5110229')
  OR LOWER(TRIM(hotel.hotel_name)) REGEXP '(^|[^[:alnum:]])house[[:space:]-]*boats?([^[:alnum:]]|$)'
);
