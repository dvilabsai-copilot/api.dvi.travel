ALTER TABLE `dvi_global_settings`
   ADD COLUMN `tbo_map_lunch_rate_3_star` FLOAT NOT NULL DEFAULT 900,
  ADD COLUMN `tbo_map_lunch_rate_4_star` FLOAT NOT NULL DEFAULT 1500,
  ADD COLUMN `tbo_map_lunch_rate_5_star` FLOAT NOT NULL DEFAULT 2500;

UPDATE `dvi_global_settings`
SET
   `tbo_map_lunch_rate_3_star` = COALESCE(`tbo_map_lunch_rate_3_star`, 900),
  `tbo_map_lunch_rate_4_star` = COALESCE(`tbo_map_lunch_rate_4_star`, 1500),
  `tbo_map_lunch_rate_5_star` = COALESCE(`tbo_map_lunch_rate_5_star`, 2500)
WHERE `deleted` = 0;
