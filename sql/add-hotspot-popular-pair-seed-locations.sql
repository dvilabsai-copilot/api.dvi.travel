-- Drops old location columns (if present), adds hotspot name columns,
-- and backfills values from dvi_hotspot_place.
-- Compatible with MySQL variants that do not support ADD COLUMN IF NOT EXISTS.

SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'hotspot_popular_pair_seed'
        AND COLUMN_NAME = 'from_hotspot_location'
    ),
    'ALTER TABLE hotspot_popular_pair_seed DROP COLUMN from_hotspot_location',
    'SELECT 1'
  )
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'hotspot_popular_pair_seed'
        AND COLUMN_NAME = 'to_hotspot_location'
    ),
    'ALTER TABLE hotspot_popular_pair_seed DROP COLUMN to_hotspot_location',
    'SELECT 1'
  )
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'hotspot_popular_pair_seed'
        AND COLUMN_NAME = 'from_hotspot_name'
    ),
    'SELECT 1',
    'ALTER TABLE hotspot_popular_pair_seed ADD COLUMN from_hotspot_name TEXT NULL'
  )
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'hotspot_popular_pair_seed'
        AND COLUMN_NAME = 'to_hotspot_name'
    ),
    'SELECT 1',
    'ALTER TABLE hotspot_popular_pair_seed ADD COLUMN to_hotspot_name TEXT NULL'
  )
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE hotspot_popular_pair_seed seed
LEFT JOIN dvi_hotspot_place hp_from
  ON hp_from.hotspot_ID = seed.from_hotspot_id
LEFT JOIN dvi_hotspot_place hp_to
  ON hp_to.hotspot_ID = seed.to_hotspot_id
SET
  seed.from_hotspot_name = hp_from.hotspot_name,
  seed.to_hotspot_name = hp_to.hotspot_name
WHERE
  seed.from_hotspot_name IS NULL
  OR seed.to_hotspot_name IS NULL;

SELECT
  from_hotspot_id,
  to_hotspot_id,
  from_hotspot_name,
  to_hotspot_name,
  usage_count
FROM hotspot_popular_pair_seed
ORDER BY usage_count DESC
LIMIT 20;
