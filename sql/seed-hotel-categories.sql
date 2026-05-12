-- Canonical hotel category seed
-- Reserved IDs:
--   1 = Budget
--   2 = STD
--   3 = 3*
--   4 = 4*
--   5 = 5*
--
-- Safe to run multiple times (idempotent via ON DUPLICATE KEY UPDATE)

START TRANSACTION;

INSERT INTO dvi_hotel_category
  (
    hotel_category_id,
    hotel_category_title,
    hotel_category_code,
    createdon,
    updatedon,
    createdby,
    status,
    deleted
  )
VALUES
  (1, 'Budget', 'DVIB-918791', NOW(), NOW(), 0, 1, 0),
  (2, 'STD',    'DVIS-858685', NOW(), NOW(), 0, 1, 0),
  (3, '3*',     'DVI3-122193', NOW(), NOW(), 0, 1, 0),
  (4, '4*',     'DVI4-874464', NOW(), NOW(), 0, 1, 0),
  (5, '5*',     'DVI5-376679', NOW(), NOW(), 0, 1, 0)
ON DUPLICATE KEY UPDATE
  hotel_category_title = VALUES(hotel_category_title),
  hotel_category_code = VALUES(hotel_category_code),
  status = VALUES(status),
  deleted = VALUES(deleted),
  updatedon = NOW();

-- Quick verification
SELECT hotel_category_id, hotel_category_title, hotel_category_code, status, deleted
FROM dvi_hotel_category
WHERE hotel_category_id IN (1,2,3,4,5)
ORDER BY hotel_category_id;

COMMIT;
