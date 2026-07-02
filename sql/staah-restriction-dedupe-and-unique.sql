SELECT
  staah_property_id,
  room_id,
  rateplan_id,
  start_date,
  end_date,
  type,
  COUNT(*) AS duplicate_count
FROM staah_restriction
GROUP BY
  staah_property_id,
  room_id,
  rateplan_id,
  start_date,
  end_date,
  type
HAVING COUNT(*) > 1;

DELETE r1
FROM staah_restriction r1
JOIN staah_restriction r2
  ON r1.staah_property_id = r2.staah_property_id
 AND r1.room_id = r2.room_id
 AND r1.rateplan_id = r2.rateplan_id
 AND r1.start_date = r2.start_date
 AND r1.end_date = r2.end_date
 AND r1.type = r2.type
 AND r1.id > r2.id;

SELECT
  staah_property_id,
  room_id,
  rateplan_id,
  start_date,
  end_date,
  type,
  COUNT(*) AS duplicate_count
FROM staah_restriction
GROUP BY
  staah_property_id,
  room_id,
  rateplan_id,
  start_date,
  end_date,
  type
HAVING COUNT(*) > 1;

SHOW INDEX FROM staah_restriction WHERE Key_name = 'uniq_staah_restriction';

ALTER TABLE staah_restriction
ADD UNIQUE KEY uniq_staah_restriction
(
  staah_property_id,
  room_id,
  rateplan_id,
  start_date,
  end_date,
  type
);
