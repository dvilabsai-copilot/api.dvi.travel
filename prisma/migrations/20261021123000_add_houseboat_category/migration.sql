INSERT INTO dvi_hotel_category
  (hotel_category_title, hotel_category_code, createdon, updatedon, createdby, status, deleted)
SELECT 'Houseboat', 'HOUSEBOAT', NOW(), NOW(), 0, 1, 0
WHERE NOT EXISTS (
  SELECT 1 FROM dvi_hotel_category
  WHERE hotel_category_code = 'HOUSEBOAT' OR LOWER(hotel_category_title) = 'houseboat'
);

ALTER TABLE tbo_hotel_master
  ADD COLUMN hotel_category_id INT NOT NULL DEFAULT 0 AFTER star_rating,
  ADD INDEX idx_tbo_hotel_master_category_id (hotel_category_id);

UPDATE tbo_hotel_master
SET hotel_category_id = (
  SELECT hotel_category_id
  FROM dvi_hotel_category
  WHERE hotel_category_code = 'HOUSEBOAT'
     OR LOWER(hotel_category_title) = 'houseboat'
  ORDER BY hotel_category_id
  LIMIT 1
)
WHERE tbo_hotel_code IN ('1674220', '5110229');

UPDATE dvi_hotel
SET hotel_category = (
  SELECT hotel_category_id
  FROM dvi_hotel_category
  WHERE hotel_category_code = 'HOUSEBOAT'
     OR LOWER(hotel_category_title) = 'houseboat'
  ORDER BY hotel_category_id
  LIMIT 1
)
WHERE tbo_hotel_code IN ('1674220', '5110229');
