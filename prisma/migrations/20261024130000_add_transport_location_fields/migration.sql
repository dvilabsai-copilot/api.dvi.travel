ALTER TABLE `dvi_itinerary_plan_details`
  ADD COLUMN `transport_overnight_location_name` VARCHAR(255) NULL,
  ADD COLUMN `transport_early_arrival_location_name` VARCHAR(255) NULL;

ALTER TABLE `dvi_confirmed_itinerary_plan_details`
  ADD COLUMN `transport_overnight_location_name` VARCHAR(255) NULL,
  ADD COLUMN `transport_early_arrival_location_name` VARCHAR(255) NULL;
