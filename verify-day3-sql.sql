-- SQL Verification for Day 3 Route 4648 (Munnar → Alleppey)
-- 
-- This query checks the database state directly for corruption:
-- 1. Self-travel rows (same source/dest)
-- 2. Overlapping attractions
-- 3. Invalid time ranges
-- 4. Break duration mismatches
--
-- Run this after executing: node rebuild-route-4648.js
-- 
-- Copy and paste into your database client

SELECT
  route_hotspot_ID,
  item_type,
  hotspot_order,
  hotspot_ID,
  hotspot_name,
  CAST(hotspot_traveling_time AS CHAR) AS travel_time,
  hotspot_start_time,
  hotspot_end_time,
  allow_break_hours,
  is_conflict,
  conflict_reason
FROM dvi_itinerary_route_hotspot_details
WHERE itinerary_plan_ID = 381
  AND itinerary_route_ID = 4648
  AND deleted = 0
  AND status = 1
ORDER BY hotspot_start_time ASC, hotspot_end_time ASC, hotspot_order ASC, route_hotspot_ID ASC;

-- Expected output structure for Day 3:
-- =====================================
-- 
-- Item Type Reference:
-- 1 = Break (allow_break_hours = 1)
-- 2 = Attraction/Hotspot
-- 3 = Travel/Transfer
-- 7 = Hotel Check-in
-- 
-- Sequence should be:
-- 1. Travel from Munnar/start point
-- 2. Attractions in Alleppey (Coir Museum, Backwater, Revi, etc.)
-- 3. Optional: Break before mandatory Mullakkal
-- 4. Travel to Mullakkal
-- 5. Mullakkal temple at 17:00-18:00 (5:00 PM - 6:00 PM)
-- 6. Travel to check-in location
-- 7. Hotel check-in
--
-- NO CORRUPTION CHECKS:
-- ✅ No self-travel (travel from X pointing to X)
-- ✅ No overlapping attractions (check start/end times don't overlap)
-- ✅ Attractions in time sequence (each starts after previous ends)
-- ✅ Mullakkal remains 17:00 - 18:00
-- ✅ Break duration = hotspot_end_time - hotspot_start_time (not from traveling_time)

-- Additional check: Overlapping attractions
SELECT
  COUNT(*) as overlap_count,
  GROUP_CONCAT(DISTINCT hotspot_ID) as overlapping_hotspot_ids
FROM (
  SELECT
    a.route_hotspot_ID,
    a.hotspot_ID,
    a.hotspot_name,
    b.route_hotspot_ID as other_id,
    b.hotspot_name as other_name
  FROM dvi_itinerary_route_hotspot_details a
  JOIN dvi_itinerary_route_hotspot_details b 
    ON a.itinerary_plan_ID = b.itinerary_plan_ID
    AND a.itinerary_route_ID = b.itinerary_route_ID
    AND a.route_hotspot_ID < b.route_hotspot_ID
    AND a.item_type = 2  -- Attraction
    AND b.item_type = 2  -- Attraction
    AND a.deleted = 0 AND b.deleted = 0
    AND a.status = 1 AND b.status = 1
  WHERE a.itinerary_plan_ID = 381
    AND a.itinerary_route_ID = 4648
    -- Overlap check: NOT (a.end <= b.start OR b.end <= a.start)
    AND NOT (a.hotspot_end_time <= b.hotspot_start_time OR b.hotspot_end_time <= a.hotspot_start_time)
) overlaps;

-- Expected result: 0 (no overlaps)
-- If > 0: Day 3 still has overlapping attractions
