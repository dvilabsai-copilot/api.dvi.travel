CREATE TABLE `dvi_toll_city_aliases` (
  `toll_city_alias_id` INT NOT NULL AUTO_INCREMENT,
  `alias_name` VARCHAR(255) NOT NULL,
  `alias_key` VARCHAR(191) NOT NULL,
  `canonical_city` VARCHAR(150) NOT NULL,
  `status` TINYINT NOT NULL DEFAULT 1,
  `deleted` TINYINT NOT NULL DEFAULT 0,
  `createdon` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `updatedon` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  PRIMARY KEY (`toll_city_alias_id`),
  UNIQUE INDEX `uq_dvi_toll_city_aliases_alias_key` (`alias_key`),
  INDEX `idx_dvi_toll_city_aliases_canonical` (`canonical_city`, `status`, `deleted`),
  INDEX `idx_dvi_toll_city_aliases_active` (`status`, `deleted`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `dvi_vehicle_toll_charges`
  MODIFY COLUMN `location_id` BIGINT NULL DEFAULT NULL,
  ADD COLUMN `source_city` VARCHAR(150) NULL,
  ADD COLUMN `destination_city` VARCHAR(150) NULL,
  ADD INDEX `idx_dvi_vehicle_toll_charges_city_route` (`source_city`, `destination_city`),
  ADD INDEX `idx_dvi_vehicle_toll_charges_city_vehicle` (`source_city`, `destination_city`, `vehicle_type_id`);
