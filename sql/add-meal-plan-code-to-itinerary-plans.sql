SET @add_itinerary_meal_plan_code = (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'dvi_itinerary_plan_details'
        AND COLUMN_NAME = 'meal_plan_code'
    ),
    'SELECT 1',
    'ALTER TABLE dvi_itinerary_plan_details ADD COLUMN meal_plan_code VARCHAR(16) NULL AFTER itinerary_preference'
  )
);
PREPARE stmt FROM @add_itinerary_meal_plan_code;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @add_confirmed_meal_plan_code = (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'dvi_confirmed_itinerary_plan_details'
        AND COLUMN_NAME = 'meal_plan_code'
    ),
    'SELECT 1',
    'ALTER TABLE dvi_confirmed_itinerary_plan_details ADD COLUMN meal_plan_code VARCHAR(16) NULL AFTER itinerary_preference'
  )
);
PREPARE stmt FROM @add_confirmed_meal_plan_code;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;