-- Remap hotel category IDs to:
--   1=Budget, 2=STD, 3=3*, 4=4*, 5=5*
--
-- Current active map:
--   2=3*, 3=4*, 4=5*, 5=STD, 6=Budget
--
-- This script also preserves old ID 1 (deleted category) by moving it to 101.
-- Run in MySQL 8+.

START TRANSACTION;

-- 0) Snapshot current state (for manual rollback verification)
SELECT hotel_category_id, hotel_category_title, hotel_category_code, status, deleted
FROM dvi_hotel_category
ORDER BY hotel_category_id;

-- 1) Remap references in integer FK-like columns
--    Mapping used here: 1->101, 2->3, 3->4, 4->5, 5->2, 6->1
UPDATE dvi_hotel
SET hotel_category = CASE hotel_category
  WHEN 1 THEN 101
  WHEN 2 THEN 3
  WHEN 3 THEN 4
  WHEN 4 THEN 5
  WHEN 5 THEN 2
  WHEN 6 THEN 1
  ELSE hotel_category
END
WHERE hotel_category IN (1,2,3,4,5,6);

UPDATE dvi_itinerary_plan_hotel_details
SET hotel_category_id = CASE hotel_category_id
  WHEN 1 THEN 101
  WHEN 2 THEN 3
  WHEN 3 THEN 4
  WHEN 4 THEN 5
  WHEN 5 THEN 2
  WHEN 6 THEN 1
  ELSE hotel_category_id
END
WHERE hotel_category_id IN (1,2,3,4,5,6);

UPDATE dvi_confirmed_itinerary_plan_hotel_details
SET hotel_category_id = CASE hotel_category_id
  WHEN 1 THEN 101
  WHEN 2 THEN 3
  WHEN 3 THEN 4
  WHEN 4 THEN 5
  WHEN 5 THEN 2
  WHEN 6 THEN 1
  ELSE hotel_category_id
END
WHERE hotel_category_id IN (1,2,3,4,5,6);

UPDATE dvi_cancelled_itinerary_plan_hotel_details
SET hotel_category_id = CASE hotel_category_id
  WHEN 1 THEN 101
  WHEN 2 THEN 3
  WHEN 3 THEN 4
  WHEN 4 THEN 5
  WHEN 5 THEN 2
  WHEN 6 THEN 1
  ELSE hotel_category_id
END
WHERE hotel_category_id IN (1,2,3,4,5,6);

-- 2) Remap CSV values in itinerary preference column safely (token-based)
--    preferred_hotel_category stores comma-separated IDs as text.
--    We convert to temp tokens first to avoid overlap issues.
UPDATE dvi_itinerary_plan_details
SET preferred_hotel_category =
  TRIM(BOTH ',' FROM
    REPLACE(
      REPLACE(
        REPLACE(
          REPLACE(
            REPLACE(
              REPLACE(CONCAT(',', COALESCE(preferred_hotel_category, ''), ','), ',1,', ',101,'),
            ',2,', ',9002,'),
          ',3,', ',9003,'),
        ',4,', ',9004,'),
      ',5,', ',9005,'),
    ',6,', ',9006,')
  )
WHERE preferred_hotel_category IS NOT NULL
  AND preferred_hotel_category <> '';

UPDATE dvi_itinerary_plan_details
SET preferred_hotel_category =
  TRIM(BOTH ',' FROM
    REPLACE(
      REPLACE(
        REPLACE(
          REPLACE(
            REPLACE(CONCAT(',', preferred_hotel_category, ','), ',9002,', ',3,'),
          ',9003,', ',4,'),
        ',9004,', ',5,'),
      ',9005,', ',2,'),
    ',9006,', ',1,')
  )
WHERE preferred_hotel_category IS NOT NULL
  AND preferred_hotel_category <> '';

-- 3) Remap PKs in dvi_hotel_category via temp offset to avoid key collisions
UPDATE dvi_hotel_category
SET hotel_category_id = hotel_category_id + 100
WHERE hotel_category_id IN (1,2,3,4,5,6);

UPDATE dvi_hotel_category
SET hotel_category_id = CASE hotel_category_id
  WHEN 101 THEN 101  -- old deleted category preserved
  WHEN 102 THEN 3    -- 3*
  WHEN 103 THEN 4    -- 4*
  WHEN 104 THEN 5    -- 5*
  WHEN 105 THEN 2    -- STD
  WHEN 106 THEN 1    -- Budget
  ELSE hotel_category_id
END
WHERE hotel_category_id IN (101,102,103,104,105,106);

-- 4) Optional: normalize category titles to match your target naming exactly
UPDATE dvi_hotel_category SET hotel_category_title = 'Budget' WHERE hotel_category_id = 1;
UPDATE dvi_hotel_category SET hotel_category_title = 'STD'    WHERE hotel_category_id = 2;
UPDATE dvi_hotel_category SET hotel_category_title = '3*'     WHERE hotel_category_id = 3;
UPDATE dvi_hotel_category SET hotel_category_title = '4*'     WHERE hotel_category_id = 4;
UPDATE dvi_hotel_category SET hotel_category_title = '5*'     WHERE hotel_category_id = 5;

-- 5) Verification queries
SELECT hotel_category_id, hotel_category_title, hotel_category_code, status, deleted
FROM dvi_hotel_category
ORDER BY hotel_category_id;

SELECT preferred_hotel_category, COUNT(*) AS cnt
FROM dvi_itinerary_plan_details
GROUP BY preferred_hotel_category
ORDER BY cnt DESC
LIMIT 20;

SELECT hotel_category, COUNT(*) AS cnt
FROM dvi_hotel
GROUP BY hotel_category
ORDER BY hotel_category;

-- If verification looks good:
COMMIT;

-- If anything looks wrong, run this instead of COMMIT:
-- ROLLBACK;
