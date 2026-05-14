-- ==================================================================================
-- AXISROOMS INTEGRATION BACKFILL - PRODUCTION SAFE
-- 
-- This script fixes AxisRooms configuration for all hotels:
-- 1. Sets axisrooms_property_id to AX_DVI_HOTEL_{hotel_id} where missing
-- 2. Enables AxisRooms (axisrooms_enabled = 1) for all active hotels
-- 
-- Safe to run multiple times (idempotent)
-- ==================================================================================

-- Step 1: Backfill missing axisrooms_property_id
UPDATE dvi_hotel 
SET axisrooms_property_id = CONCAT('AX_DVI_HOTEL_', hotel_id),
    updatedon = NOW()
WHERE (axisrooms_property_id IS NULL OR axisrooms_property_id = '')
  AND deleted = 0;

-- Step 2: Enable AxisRooms for all active hotels
UPDATE dvi_hotel 
SET axisrooms_enabled = 1,
    updatedon = NOW()
WHERE axisrooms_enabled = 0 
  AND deleted = 0;

-- Verification queries (run these to verify)
-- SELECT COUNT(*) as missing_property_id FROM dvi_hotel WHERE (axisrooms_property_id IS NULL OR axisrooms_property_id = '') AND deleted = 0;
-- SELECT COUNT(*) as disabled_count FROM dvi_hotel WHERE axisrooms_enabled = 0 AND deleted = 0;
-- SELECT COUNT(*) as properly_configured FROM dvi_hotel WHERE axisrooms_property_id IS NOT NULL AND axisrooms_property_id != '' AND axisrooms_enabled = 1 AND deleted = 0;
