-- Revenue Manager Properties import (from Revenue Manager Properties-3.xls)
-- Safe to run multiple times: updates existing rows and inserts missing rows.
-- Target table: dvi_hotel

START TRANSACTION;

-- Force a collation compatible with legacy dvi_hotel text columns.
SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

DROP TEMPORARY TABLE IF EXISTS tmp_resavenue_hotels_import;

CREATE TEMPORARY TABLE tmp_resavenue_hotels_import (
  prop_id VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  hotel_name VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  hotel_city VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  hotel_country VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (prop_id)
);

INSERT INTO tmp_resavenue_hotels_import (prop_id, hotel_name, hotel_city, hotel_country)
VALUES
  ('18',   'Poppys Hotel Madurai',                 'Madurai',       'India'),
  ('20',   'Vinayaga by Poppys Rameswaram',        'Rameswaram',    'India'),
  ('21',   'Vinayaga by Poppys Kumbakonam',        'Kumbakonam',    'India'),
  ('22',   'Vinayaga Inn by Poppys Ooty',          'Uthagamandalam','India'),
  ('1294', 'Tuskers Hill by Poppys',               'Thrissur',      'India'),
  ('3097', 'Poppys Olive De Villa',                'Vellore',       'India'),
  ('4543', 'Tuskers Hill Banquets by Poppys',      'Thrissur',      'India');

-- 1) Update rows that already exist by ResAvenue property code.
UPDATE dvi_hotel h
JOIN tmp_resavenue_hotels_import t
  ON h.resavenue_hotel_code COLLATE utf8mb4_general_ci = t.prop_id COLLATE utf8mb4_general_ci
SET
  h.hotel_name = t.hotel_name,
  h.hotel_city = t.hotel_city,
  h.hotel_country = t.hotel_country,
  h.hotel_code = CONCAT('RESAVENUE-', t.prop_id),
  h.status = 1,
  h.deleted = 0,
  h.updatedon = NOW();

-- 2) Update rows that match by name+city (for rows that may exist without ResAvenue code).
UPDATE dvi_hotel h
JOIN tmp_resavenue_hotels_import t
  ON h.hotel_name COLLATE utf8mb4_general_ci = t.hotel_name COLLATE utf8mb4_general_ci
 AND h.hotel_city COLLATE utf8mb4_general_ci = t.hotel_city COLLATE utf8mb4_general_ci
SET
  h.resavenue_hotel_code = t.prop_id,
  h.hotel_code = CONCAT('RESAVENUE-', t.prop_id),
  h.hotel_country = t.hotel_country,
  h.status = 1,
  h.deleted = 0,
  h.updatedon = NOW()
WHERE (h.resavenue_hotel_code IS NULL OR h.resavenue_hotel_code = '');

-- 3) Insert rows that do not exist by code and also do not exist by name+city.
INSERT INTO dvi_hotel (
  hotel_name,
  hotel_code,
  resavenue_hotel_code,
  hotel_country,
  hotel_city,
  status,
  deleted,
  createdon,
  updatedon
)
SELECT
  t.hotel_name,
  CONCAT('RESAVENUE-', t.prop_id) AS hotel_code,
  t.prop_id AS resavenue_hotel_code,
  t.hotel_country,
  t.hotel_city,
  1 AS status,
  0 AS deleted,
  NOW() AS createdon,
  NOW() AS updatedon
FROM tmp_resavenue_hotels_import t
WHERE NOT EXISTS (
    SELECT 1
    FROM dvi_hotel h
    WHERE h.resavenue_hotel_code COLLATE utf8mb4_general_ci = t.prop_id COLLATE utf8mb4_general_ci
  )
  AND NOT EXISTS (
    SELECT 1
    FROM dvi_hotel h
    WHERE h.hotel_name COLLATE utf8mb4_general_ci = t.hotel_name COLLATE utf8mb4_general_ci
      AND h.hotel_city COLLATE utf8mb4_general_ci = t.hotel_city COLLATE utf8mb4_general_ci
  );

COMMIT;

-- Optional verification query:
-- SELECT hotel_id, hotel_name, hotel_city, resavenue_hotel_code, hotel_code, status, deleted
-- FROM dvi_hotel
-- WHERE resavenue_hotel_code IN ('18','20','21','22','1294','3097','4543')
-- ORDER BY CAST(resavenue_hotel_code AS UNSIGNED);
