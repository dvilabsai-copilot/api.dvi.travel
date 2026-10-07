-- Adds global toggle to enable/disable meal plan filtering in hotel search.
-- 1 = enabled (default), 0 = disabled.

SET @col_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'dvi_global_settings'
    AND COLUMN_NAME = 'meal_plan_search_enabled'
);

SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE dvi_global_settings ADD COLUMN meal_plan_search_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER hotel_terms_condition',
  'SELECT 1'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Ensure existing rows have valid value.
UPDATE dvi_global_settings
SET meal_plan_search_enabled = 1
WHERE meal_plan_search_enabled IS NULL;

-- EP is hidden by default. Set this to 1 only when EP inventory should be
-- visible in hotel search and itinerary recommendations.
SET @ep_col_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'dvi_global_settings'
    AND COLUMN_NAME = 'show_ep_hotels'
);

SET @ep_ddl := IF(
  @ep_col_exists = 0,
  'ALTER TABLE dvi_global_settings ADD COLUMN show_ep_hotels TINYINT(1) NOT NULL DEFAULT 0 AFTER meal_plan_search_enabled',
  'SELECT 1'
);

PREPARE ep_stmt FROM @ep_ddl;
EXECUTE ep_stmt;
DEALLOCATE PREPARE ep_stmt;

UPDATE dvi_global_settings
SET show_ep_hotels = 0
WHERE show_ep_hotels IS NULL;

-- Quick toggle examples:
-- Disable meal-plan filtering globally:
-- UPDATE dvi_global_settings SET meal_plan_search_enabled = 0 WHERE deleted = 0;

-- Enable meal-plan filtering globally:
-- UPDATE dvi_global_settings SET meal_plan_search_enabled = 1 WHERE deleted = 0;
