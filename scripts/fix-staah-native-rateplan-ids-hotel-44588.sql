UPDATE dvi_hotel_room_rate_plan
SET rateplan_id = 'CP_PLAN'
WHERE hotel_id = 44588
  AND rateplan_id = 'CPPLAN';

UPDATE dvi_hotel_room_rate_plan
SET rateplan_id = 'MAP_PLAN'
WHERE hotel_id = 44588
  AND rateplan_id = 'MAPPLAN';

UPDATE dvi_hotel_room_rate_plan
SET rateplan_id = 'AP_PLAN'
WHERE hotel_id = 44588
  AND rateplan_id = 'APPLAN';

UPDATE dvi_hotel_room_rate_plan
SET rateplan_id = 'EP_PLAN'
WHERE hotel_id = 44588
  AND rateplan_id = 'EPPLAN';

UPDATE dvi_hotel_occupancy_rate
SET rateplan_id = 'CP_PLAN'
WHERE hotel_id = 44588
  AND rateplan_id = 'CPPLAN';

UPDATE dvi_hotel_occupancy_rate
SET rateplan_id = 'MAP_PLAN'
WHERE hotel_id = 44588
  AND rateplan_id = 'MAPPLAN';

UPDATE dvi_hotel_occupancy_rate
SET rateplan_id = 'AP_PLAN'
WHERE hotel_id = 44588
  AND rateplan_id = 'APPLAN';

UPDATE dvi_hotel_occupancy_rate
SET rateplan_id = 'EP_PLAN'
WHERE hotel_id = 44588
  AND rateplan_id = 'EPPLAN';
