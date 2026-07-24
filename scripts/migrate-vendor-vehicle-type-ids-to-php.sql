-- Migrates non-deleted vehicle rows from master vehicle IDs to the
-- vendor_vehicle_type_ID convention used by the PHP application.
-- The script is idempotent: already-migrated rows are not changed.

CREATE TABLE IF NOT EXISTS dvi_vehicle_type_migration_backup LIKE dvi_vehicle;

INSERT IGNORE INTO dvi_vehicle_type_migration_backup
SELECT v.*
FROM dvi_vehicle v
JOIN dvi_vendor_vehicle_types m
    ON m.vendor_id = v.vendor_id
   AND m.vehicle_type_id = v.vehicle_type_id
   AND m.deleted = 0
   AND m.status = 1
LEFT JOIN dvi_vendor_vehicle_types existing_vendor_mapping
    ON existing_vendor_mapping.vendor_id = v.vendor_id
   AND existing_vendor_mapping.vendor_vehicle_type_ID = v.vehicle_type_id
   AND existing_vendor_mapping.deleted = 0
   AND existing_vendor_mapping.status = 1
WHERE v.deleted = 0
  AND existing_vendor_mapping.vendor_vehicle_type_ID IS NULL
  AND m.vendor_vehicle_type_ID <> v.vehicle_type_id;

START TRANSACTION;

UPDATE dvi_vehicle v
JOIN dvi_vendor_vehicle_types m
    ON m.vendor_id = v.vendor_id
   AND m.vehicle_type_id = v.vehicle_type_id
   AND m.deleted = 0
   AND m.status = 1
LEFT JOIN dvi_vendor_vehicle_types existing_vendor_mapping
    ON existing_vendor_mapping.vendor_id = v.vendor_id
   AND existing_vendor_mapping.vendor_vehicle_type_ID = v.vehicle_type_id
   AND existing_vendor_mapping.deleted = 0
   AND existing_vendor_mapping.status = 1
SET v.vehicle_type_id = m.vendor_vehicle_type_ID
WHERE v.deleted = 0
  AND existing_vendor_mapping.vendor_vehicle_type_ID IS NULL
  AND m.vendor_vehicle_type_ID <> v.vehicle_type_id;

COMMIT;

-- Rows with no active vendor mapping remain unchanged for manual review.
SELECT
    v.vendor_id,
    v.vehicle_id,
    v.vehicle_type_id AS unresolved_vehicle_type_id
FROM dvi_vehicle v
LEFT JOIN dvi_vendor_vehicle_types vendor_mapping
    ON vendor_mapping.vendor_id = v.vendor_id
   AND vendor_mapping.vendor_vehicle_type_ID = v.vehicle_type_id
   AND vendor_mapping.deleted = 0
   AND vendor_mapping.status = 1
LEFT JOIN dvi_vendor_vehicle_types master_mapping
    ON master_mapping.vendor_id = v.vendor_id
   AND master_mapping.vehicle_type_id = v.vehicle_type_id
   AND master_mapping.deleted = 0
   AND master_mapping.status = 1
WHERE v.deleted = 0
  AND vendor_mapping.vendor_vehicle_type_ID IS NULL
  AND master_mapping.vehicle_type_id IS NULL
ORDER BY v.vendor_id, v.vehicle_id;
