ALTER TABLE `dvi_global_settings`
  ADD COLUMN `same_city_hotspot_rank_enabled` TINYINT NOT NULL DEFAULT 0,
  ADD COLUMN `same_city_hotspot_max_rank` INT NOT NULL DEFAULT 30,
  ADD COLUMN `same_city_hotspot_base_increment` INT NOT NULL DEFAULT 10,
  ADD COLUMN `same_city_hotspot_distribution_mode` VARCHAR(20) NOT NULL DEFAULT 'BALANCED';
