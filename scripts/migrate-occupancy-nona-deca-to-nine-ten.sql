-- ============================================================
-- Migration: Rename occupancy keys NONA → NINE and DECA → TEN
-- Affects two tables:
--   1. dvi_hotel_occupancy_rate.occupancy_rates  (JSON object)
--   2. dvi_hotel_room_rate_plan.occupancy         (JSON array)
-- Run on LOCAL and PRODUCTION databases.
-- Safe to run multiple times (no-op if already migrated).
-- ============================================================

-- ---------------------------------------------------------------
-- 1. dvi_hotel_occupancy_rate: rename JSON object keys
--    Step 1a: add NINE from NONA where NONA exists and NINE doesn't
--    Step 1b: remove NONA
--    Step 1c: add TEN from DECA where DECA exists and TEN doesn't
--    Step 1d: remove DECA
-- ---------------------------------------------------------------

UPDATE dvi_hotel_occupancy_rate
SET occupancy_rates = JSON_SET(
    occupancy_rates,
    '$.NINE',
    JSON_EXTRACT(occupancy_rates, '$.NONA')
)
WHERE JSON_TYPE(JSON_EXTRACT(occupancy_rates, '$.NONA')) IS NOT NULL
  AND JSON_TYPE(JSON_EXTRACT(occupancy_rates, '$.NINE')) IS NULL;

UPDATE dvi_hotel_occupancy_rate
SET occupancy_rates = JSON_REMOVE(occupancy_rates, '$.NONA')
WHERE JSON_TYPE(JSON_EXTRACT(occupancy_rates, '$.NONA')) IS NOT NULL;

UPDATE dvi_hotel_occupancy_rate
SET occupancy_rates = JSON_SET(
    occupancy_rates,
    '$.TEN',
    JSON_EXTRACT(occupancy_rates, '$.DECA')
)
WHERE JSON_TYPE(JSON_EXTRACT(occupancy_rates, '$.DECA')) IS NOT NULL
  AND JSON_TYPE(JSON_EXTRACT(occupancy_rates, '$.TEN')) IS NULL;

UPDATE dvi_hotel_occupancy_rate
SET occupancy_rates = JSON_REMOVE(occupancy_rates, '$.DECA')
WHERE JSON_TYPE(JSON_EXTRACT(occupancy_rates, '$.DECA')) IS NOT NULL;

-- ---------------------------------------------------------------
-- 2. dvi_hotel_room_rate_plan: rename values inside JSON array
--    MySQL doesn't have a direct array-value replace, so we use
--    JSON_SEARCH + JSON_REPLACE pattern:
--    Replace the string "NONA" → "NINE" and "DECA" → "TEN"
--    wherever they appear as array elements.
-- ---------------------------------------------------------------

UPDATE dvi_hotel_room_rate_plan
SET occupancy = JSON_SET(
    occupancy,
    CONCAT('$[', JSON_UNQUOTE(JSON_SEARCH(occupancy, 'one', 'NONA')), ']'),
    'NINE'
)
WHERE JSON_SEARCH(occupancy, 'one', 'NONA') IS NOT NULL;

UPDATE dvi_hotel_room_rate_plan
SET occupancy = JSON_SET(
    occupancy,
    CONCAT('$[', JSON_UNQUOTE(JSON_SEARCH(occupancy, 'one', 'DECA')), ']'),
    'TEN'
)
WHERE JSON_SEARCH(occupancy, 'one', 'DECA') IS NOT NULL;

-- ---------------------------------------------------------------
-- Verification queries (run after migration to confirm)
-- ---------------------------------------------------------------

-- Should return 0 rows after migration:
-- SELECT id, occupancy_rates FROM dvi_hotel_occupancy_rate
-- WHERE JSON_TYPE(JSON_EXTRACT(occupancy_rates, '$.NONA')) IS NOT NULL
--    OR JSON_TYPE(JSON_EXTRACT(occupancy_rates, '$.DECA')) IS NOT NULL;

-- Should return 0 rows after migration:
-- SELECT id, occupancy FROM dvi_hotel_room_rate_plan
-- WHERE JSON_SEARCH(occupancy, 'one', 'NONA') IS NOT NULL
--    OR JSON_SEARCH(occupancy, 'one', 'DECA') IS NOT NULL;
