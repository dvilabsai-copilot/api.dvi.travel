ALTER TABLE `dvi_itinerary_plan_hotel_details`
  MODIFY COLUMN `hotel_id` INT NULL DEFAULT NULL;

ALTER TABLE `dvi_confirmed_itinerary_plan_hotel_details`
  MODIFY COLUMN `hotel_id` INT NULL DEFAULT NULL;

ALTER TABLE `dvi_itinerary_plan_hotel_room_details`
  MODIFY COLUMN `hotel_id` INT NULL DEFAULT NULL;

ALTER TABLE `dvi_confirmed_itinerary_plan_hotel_room_details`
  MODIFY COLUMN `hotel_id` INT NULL DEFAULT NULL;
