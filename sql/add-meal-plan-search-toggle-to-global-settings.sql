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

-- Quick toggle examples:
-- Disable meal-plan filtering globally:
-- UPDATE dvi_global_settings SET meal_plan_search_enabled = 0 WHERE deleted = 0;

-- Enable meal-plan filtering globally:
-- UPDATE dvi_global_settings SET meal_plan_search_enabled = 1 WHERE deleted = 0;
