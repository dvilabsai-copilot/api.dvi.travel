-- Backfill dvi_hotel.hotel_city from legacy text values to dvi_cities.id strings.
-- Safe to run in both local and production MySQL environments.
-- Notes:
--   - Numeric city values are left untouched.
--   - City names are matched case-insensitively using the part before any comma.
--   - A small alias layer handles legacy labels like "Bangalore" -> "Bengaluru".
--   - Any rows that still cannot be resolved will be listed in the preview query.

START TRANSACTION;

DROP TEMPORARY TABLE IF EXISTS tmp_city_lookup;
CREATE TEMPORARY TABLE tmp_city_lookup (
  lookup_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL PRIMARY KEY,
  city_id INT NOT NULL
) ENGINE=InnoDB;

-- Canonical city-name lookup from the master city table.
-- We keep the smallest id for each normalized city name so the result is stable.
INSERT INTO tmp_city_lookup (lookup_key, city_id)
SELECT
  LOWER(TRIM(SUBSTRING_INDEX(name, ',', 1))) COLLATE utf8mb4_unicode_ci AS lookup_key,
  COALESCE(
    MIN(CASE WHEN status = 1 THEN id END),
    MIN(id)
  ) AS city_id
FROM dvi_cities
WHERE name IS NOT NULL
  AND TRIM(name) <> ''
  AND deleted IN (0, 1)
GROUP BY LOWER(TRIM(SUBSTRING_INDEX(name, ',', 1)));

DROP TEMPORARY TABLE IF EXISTS tmp_city_lookup_base;
CREATE TEMPORARY TABLE tmp_city_lookup_base AS
SELECT lookup_key, city_id FROM tmp_city_lookup;

-- Legacy aliases used by older hotel rows or import data.
INSERT INTO tmp_city_lookup (lookup_key, city_id)
VALUES ('bangalore', 0), ('bengalore', 0), ('araku valley', 0), ('uthagamandalam', 0),
       ('tvm', 0), ('trivandrum', 0), ('cochin', 0), ('calicut', 0), ('madras', 0),
       ('bombay', 0), ('pondicherry', 0)
ON DUPLICATE KEY UPDATE city_id = city_id;

UPDATE tmp_city_lookup a
JOIN tmp_city_lookup_base b ON b.lookup_key = 'bengaluru'
SET a.city_id = b.city_id
WHERE a.lookup_key IN ('bangalore', 'bengalore');

UPDATE tmp_city_lookup a
JOIN tmp_city_lookup_base b ON b.lookup_key = 'araku'
SET a.city_id = b.city_id
WHERE a.lookup_key = 'araku valley';

UPDATE tmp_city_lookup a
JOIN tmp_city_lookup_base b ON b.lookup_key = 'ooty'
SET a.city_id = b.city_id
WHERE a.lookup_key = 'uthagamandalam';

UPDATE tmp_city_lookup a
JOIN tmp_city_lookup_base b ON b.lookup_key = 'thiruvananthapuram'
SET a.city_id = b.city_id
WHERE a.lookup_key IN ('tvm', 'trivandrum');

UPDATE tmp_city_lookup a
JOIN tmp_city_lookup_base b ON b.lookup_key = 'kochi'
SET a.city_id = b.city_id
WHERE a.lookup_key = 'cochin';

UPDATE tmp_city_lookup a
JOIN tmp_city_lookup_base b ON b.lookup_key = 'kozhikode'
SET a.city_id = b.city_id
WHERE a.lookup_key = 'calicut';

UPDATE tmp_city_lookup a
JOIN tmp_city_lookup_base b ON b.lookup_key = 'chennai'
SET a.city_id = b.city_id
WHERE a.lookup_key = 'madras';

UPDATE tmp_city_lookup a
JOIN tmp_city_lookup_base b ON b.lookup_key = 'mumbai'
SET a.city_id = b.city_id
WHERE a.lookup_key = 'bombay';

UPDATE tmp_city_lookup a
JOIN tmp_city_lookup_base b ON b.lookup_key = 'puducherry'
SET a.city_id = b.city_id
WHERE a.lookup_key = 'pondicherry';

-- Preview anything that still cannot be resolved.
SELECT
  h.hotel_city AS unresolved_city,
  COUNT(*) AS row_count
FROM dvi_hotel h
LEFT JOIN tmp_city_lookup m
  ON m.lookup_key = LOWER(TRIM(SUBSTRING_INDEX(h.hotel_city, ',', 1))) COLLATE utf8mb4_unicode_ci
WHERE (h.deleted = 0 OR h.deleted IS NULL)
  AND h.hotel_city IS NOT NULL
  AND TRIM(h.hotel_city) <> ''
  AND h.hotel_city NOT REGEXP '^[0-9]+$'
  AND m.city_id IS NULL
GROUP BY h.hotel_city
ORDER BY row_count DESC, unresolved_city ASC;

-- Convert legacy text city names to the city id string.
UPDATE dvi_hotel h
JOIN tmp_city_lookup m
  ON m.lookup_key = LOWER(TRIM(SUBSTRING_INDEX(h.hotel_city, ',', 1))) COLLATE utf8mb4_unicode_ci
SET h.hotel_city = CAST(m.city_id AS CHAR)
WHERE (h.deleted = 0 OR h.deleted IS NULL)
  AND h.hotel_city IS NOT NULL
  AND TRIM(h.hotel_city) <> ''
  AND h.hotel_city NOT REGEXP '^[0-9]+$';

-- Verification after the update.
SELECT
  COUNT(*) AS total_rows,
  SUM(CASE WHEN hotel_city REGEXP '^[0-9]+$' THEN 1 ELSE 0 END) AS numeric_city_rows,
  SUM(
    CASE
      WHEN hotel_city IS NOT NULL
       AND TRIM(hotel_city) <> ''
       AND hotel_city NOT REGEXP '^[0-9]+$'
      THEN 1 ELSE 0
    END
  ) AS text_city_rows
FROM dvi_hotel
WHERE (deleted = 0 OR deleted IS NULL);

COMMIT;
