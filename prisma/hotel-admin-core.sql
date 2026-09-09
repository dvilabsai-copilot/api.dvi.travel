-- Hotel Admin additions for the existing DVI MySQL database.
-- Database: dvi_main
-- Role ID 10 verified unused before initial application.

INSERT INTO dvi_rolemenu
(
  role_ID,
  role_name,
  createdby,
  createdon,
  updatedon,
  status,
  deleted
)
SELECT
  10,
  'Hotel Admin',
  1,
  NOW(),
  NOW(),
  1,
  0
WHERE NOT EXISTS
(
  SELECT 1
  FROM dvi_rolemenu
  WHERE role_ID = 10
);

CREATE TABLE IF NOT EXISTS dvi_hotel_admin_user_hotel
(
  hotel_admin_user_hotel_id BIGINT NOT NULL AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  hotel_id INT NOT NULL,
  createdby BIGINT NOT NULL DEFAULT 0,
  createdon DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedon DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  status TINYINT NOT NULL DEFAULT 1,
  deleted TINYINT NOT NULL DEFAULT 0,

  PRIMARY KEY (hotel_admin_user_hotel_id),

  UNIQUE KEY uq_dvi_hotel_admin_user_hotel
    (user_id, hotel_id),

  KEY idx_dvi_hotel_admin_user_hotel_user
    (user_id),

  KEY idx_dvi_hotel_admin_user_hotel_hotel
    (hotel_id),

  KEY idx_dvi_hotel_admin_user_hotel_status
    (status),

  KEY idx_dvi_hotel_admin_user_hotel_deleted
    (deleted)
);

CREATE TABLE IF NOT EXISTS dvi_hotel_admin_user_permission
(
  hotel_admin_user_permission_id BIGINT NOT NULL AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  permission_key VARCHAR(64) NOT NULL,
  can_view TINYINT NOT NULL DEFAULT 0,
  can_create TINYINT NOT NULL DEFAULT 0,
  can_edit TINYINT NOT NULL DEFAULT 0,
  can_delete TINYINT NOT NULL DEFAULT 0,
  createdby BIGINT NOT NULL DEFAULT 0,
  createdon DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedon DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  status TINYINT NOT NULL DEFAULT 1,
  deleted TINYINT NOT NULL DEFAULT 0,

  PRIMARY KEY (hotel_admin_user_permission_id),

  UNIQUE KEY uq_dvi_hotel_admin_user_permission
    (user_id, permission_key),

  KEY idx_dvi_hotel_admin_user_permission_user
    (user_id),

  KEY idx_dvi_hotel_admin_user_permission_key
    (permission_key),

  KEY idx_dvi_hotel_admin_user_permission_status
    (status),

  KEY idx_dvi_hotel_admin_user_permission_deleted
    (deleted)
);