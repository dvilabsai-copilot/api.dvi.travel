ALTER TABLE `dvi_stored_locations`
  ADD COLUMN `source_city_id` INT NULL AFTER `source_location_city`,
  ADD COLUMN `destination_city_id` INT NULL AFTER `destination_location_city`;

ALTER TABLE `dvi_stored_locations`
  ADD INDEX `idx_dvi_stored_locations_source_city_id` (`source_city_id`),
  ADD INDEX `idx_dvi_stored_locations_destination_city_id` (`destination_city_id`),
  ADD INDEX `idx_location_lookup_city_pair` (`source_city_id`, `destination_city_id`);
