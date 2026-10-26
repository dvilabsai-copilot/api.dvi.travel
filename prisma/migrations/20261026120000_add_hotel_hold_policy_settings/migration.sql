ALTER TABLE `dvi_global_settings`
  ADD COLUMN `hotel_hold_no_block_before_hours` FLOAT NOT NULL DEFAULT 48,
  ADD COLUMN `hotel_hold_min_lead_days` INT NOT NULL DEFAULT 3,
  ADD COLUMN `hotel_hold_short_lead_days` INT NOT NULL DEFAULT 15,
  ADD COLUMN `hotel_hold_medium_lead_days` INT NOT NULL DEFAULT 30,
  ADD COLUMN `hotel_hold_short_duration_hours` FLOAT NOT NULL DEFAULT 4,
  ADD COLUMN `hotel_hold_medium_duration_hours` FLOAT NOT NULL DEFAULT 12,
  ADD COLUMN `hotel_hold_long_duration_hours` FLOAT NOT NULL DEFAULT 48;
