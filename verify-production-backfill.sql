-- Verify Production Backfill
SELECT '========== PRODUCTION VERIFICATION ==========' as status;
SELECT COUNT(*) as total_active_hotels FROM dvi_hotel WHERE deleted = 0;
SELECT COUNT(*) as axisrooms_enabled FROM dvi_hotel WHERE axisrooms_enabled = 1 AND deleted = 0;
SELECT COUNT(*) as missing_property_id FROM dvi_hotel WHERE (axisrooms_property_id IS NULL OR axisrooms_property_id = '') AND deleted = 0;
SELECT COUNT(*) as properly_configured FROM dvi_hotel WHERE axisrooms_property_id IS NOT NULL AND axisrooms_property_id != '' AND axisrooms_enabled = 1 AND deleted = 0;

SELECT '========== SAMPLE HOTELS ==========' as status;
SELECT hotel_id, hotel_name, axisrooms_property_id, axisrooms_enabled FROM dvi_hotel WHERE hotel_id IN (44578, 153);
