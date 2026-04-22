-- AxisRooms production DB sync script
-- Property: AX_DVI_HOTEL_153
-- Generated: 2026-04-22T19:05:15.408Z
SET NAMES utf8mb4;
START TRANSACTION;

-- Missing table DDL from local schema
CREATE TABLE `dvi_hotel_rate_plan_master` (
  `hotel_rate_plan_master_id` int NOT NULL AUTO_INCREMENT,
  `rate_plan_code` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `default_rateplan_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `rate_plan_name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `includes_breakfast` tinyint NOT NULL DEFAULT '0',
  `includes_lunch` tinyint NOT NULL DEFAULT '0',
  `includes_dinner` tinyint NOT NULL DEFAULT '0',
  `sort_order` int NOT NULL DEFAULT '0',
  `createdby` int NOT NULL DEFAULT '0',
  `createdon` datetime DEFAULT NULL,
  `updatedon` datetime DEFAULT NULL,
  `status` tinyint NOT NULL DEFAULT '1',
  `deleted` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`hotel_rate_plan_master_id`),
  UNIQUE KEY `uniq_hotel_rate_plan_master_code` (`rate_plan_code`),
  UNIQUE KEY `uniq_hotel_rate_plan_master_default_id` (`default_rateplan_id`),
  KEY `idx_hotel_rate_plan_master_status` (`status`),
  KEY `idx_hotel_rate_plan_master_deleted` (`deleted`),
  KEY `idx_hotel_rate_plan_master_sort_order` (`sort_order`)
) ENGINE=MyISAM AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `dvi_hotel_room_rate_plan` (
  `hotel_room_rate_plan_id` int NOT NULL AUTO_INCREMENT,
  `hotel_id` int NOT NULL DEFAULT '0',
  `room_id` int NOT NULL DEFAULT '0',
  `room_type_id` int NOT NULL DEFAULT '0',
  `axisrooms_room_id` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `rate_plan_code` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `rateplan_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `rateplan_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `meal_plan_description` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `commission_perc` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `tax_perc` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `currency` varchar(10) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `createdby` int NOT NULL DEFAULT '0',
  `createdon` datetime DEFAULT NULL,
  `updatedon` datetime DEFAULT NULL,
  `status` tinyint NOT NULL DEFAULT '1',
  `deleted` tinyint NOT NULL DEFAULT '0',
  `occupancy` json DEFAULT NULL,
  PRIMARY KEY (`hotel_room_rate_plan_id`),
  UNIQUE KEY `uniq_hotel_room_rate_plan` (`hotel_id`,`room_id`,`rateplan_id`),
  KEY `idx_hotel_room_rate_plan_hotel_id` (`hotel_id`),
  KEY `idx_hotel_room_rate_plan_room_id` (`room_id`),
  KEY `idx_hotel_room_rate_plan_room_type_id` (`room_type_id`),
  KEY `idx_hotel_room_rate_plan_axisrooms_room_id` (`axisrooms_room_id`),
  KEY `idx_hotel_room_rate_plan_code` (`rate_plan_code`),
  KEY `idx_hotel_room_rate_plan_rateplan_id` (`rateplan_id`),
  KEY `idx_hotel_room_rate_plan_status` (`status`),
  KEY `idx_hotel_room_rate_plan_deleted` (`deleted`)
) ENGINE=MyISAM AUTO_INCREMENT=9 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `dvi_hotel_occupancy_rate` (
  `id` int NOT NULL AUTO_INCREMENT,
  `hotel_id` int NOT NULL,
  `room_id` int NOT NULL,
  `rateplan_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `start_date` date NOT NULL,
  `end_date` date NOT NULL,
  `occupancy_rates` json NOT NULL,
  `received_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_dvi_hotel_occupancy_rate` (`hotel_id`,`room_id`,`rateplan_id`,`start_date`,`end_date`),
  KEY `idx_dvi_hotel_occupancy_rate_hotel` (`hotel_id`),
  KEY `idx_dvi_hotel_occupancy_rate_room` (`room_id`),
  KEY `idx_dvi_hotel_occupancy_rate_rateplan` (`rateplan_id`),
  KEY `idx_dvi_hotel_occupancy_rate_start` (`start_date`)
) ENGINE=MyISAM AUTO_INCREMENT=26 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `dvi_hotel_room_availability` (
  `id` int NOT NULL AUTO_INCREMENT,
  `hotel_id` int NOT NULL,
  `room_id` int NOT NULL,
  `start_date` date NOT NULL,
  `end_date` date NOT NULL,
  `free` int NOT NULL,
  `received_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_dvi_hotel_room_availability` (`hotel_id`,`room_id`,`start_date`,`end_date`),
  KEY `idx_dvi_hotel_room_avail_hotel` (`hotel_id`),
  KEY `idx_dvi_hotel_room_avail_room` (`room_id`),
  KEY `idx_dvi_hotel_room_avail_start` (`start_date`)
) ENGINE=MyISAM AUTO_INCREMENT=6 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Canonical rate plan master rows
INSERT INTO dvi_hotel_rate_plan_master (rate_plan_code, default_rateplan_id, rate_plan_name, description, includes_breakfast, includes_lunch, includes_dinner, sort_order, status, deleted, createdon, updatedon) VALUES ('CP', 'CP_PLAN', 'Continental Plan', 'Breakfast only', 1, 0, 0, 1, 1, 0, NOW(), NOW()) ON DUPLICATE KEY UPDATE default_rateplan_id=VALUES(default_rateplan_id), rate_plan_name=VALUES(rate_plan_name), description=VALUES(description), includes_breakfast=VALUES(includes_breakfast), includes_lunch=VALUES(includes_lunch), includes_dinner=VALUES(includes_dinner), sort_order=VALUES(sort_order), status=1, deleted=0, updatedon=NOW();
INSERT INTO dvi_hotel_rate_plan_master (rate_plan_code, default_rateplan_id, rate_plan_name, description, includes_breakfast, includes_lunch, includes_dinner, sort_order, status, deleted, createdon, updatedon) VALUES ('EP', 'EP_PLAN', 'European Plan', 'Room only', 0, 0, 0, 2, 1, 0, NOW(), NOW()) ON DUPLICATE KEY UPDATE default_rateplan_id=VALUES(default_rateplan_id), rate_plan_name=VALUES(rate_plan_name), description=VALUES(description), includes_breakfast=VALUES(includes_breakfast), includes_lunch=VALUES(includes_lunch), includes_dinner=VALUES(includes_dinner), sort_order=VALUES(sort_order), status=1, deleted=0, updatedon=NOW();
INSERT INTO dvi_hotel_rate_plan_master (rate_plan_code, default_rateplan_id, rate_plan_name, description, includes_breakfast, includes_lunch, includes_dinner, sort_order, status, deleted, createdon, updatedon) VALUES ('MAP', 'MAP_PLAN', 'Modified American Plan', 'Breakfast + Lunch or Dinner', 1, 1, 1, 3, 1, 0, NOW(), NOW()) ON DUPLICATE KEY UPDATE default_rateplan_id=VALUES(default_rateplan_id), rate_plan_name=VALUES(rate_plan_name), description=VALUES(description), includes_breakfast=VALUES(includes_breakfast), includes_lunch=VALUES(includes_lunch), includes_dinner=VALUES(includes_dinner), sort_order=VALUES(sort_order), status=1, deleted=0, updatedon=NOW();
INSERT INTO dvi_hotel_rate_plan_master (rate_plan_code, default_rateplan_id, rate_plan_name, description, includes_breakfast, includes_lunch, includes_dinner, sort_order, status, deleted, createdon, updatedon) VALUES ('AP', 'AP_PLAN', 'American Plan', 'Breakfast + Lunch + Dinner', 1, 1, 1, 4, 1, 0, NOW(), NOW()) ON DUPLICATE KEY UPDATE default_rateplan_id=VALUES(default_rateplan_id), rate_plan_name=VALUES(rate_plan_name), description=VALUES(description), includes_breakfast=VALUES(includes_breakfast), includes_lunch=VALUES(includes_lunch), includes_dinner=VALUES(includes_dinner), sort_order=VALUES(sort_order), status=1, deleted=0, updatedon=NOW();

-- Canonical room rate plan rows for this property
INSERT INTO dvi_hotel_room_rate_plan (hotel_id, room_id, room_type_id, axisrooms_room_id, rate_plan_code, rateplan_id, rateplan_name, meal_plan_description, commission_perc, tax_perc, currency, occupancy, status, deleted, createdon, updatedon) VALUES (153, 189, 283, 'DVIRHON666981', 'CP', 'CP_PLAN', 'CP_PLAN', 'Breakfast only', '0.0', '0.0', 'INR', '["DOUBLE"]', 1, 0, NOW(), NOW()) ON DUPLICATE KEY UPDATE room_type_id=VALUES(room_type_id), axisrooms_room_id=VALUES(axisrooms_room_id), rate_plan_code=VALUES(rate_plan_code), rateplan_name=VALUES(rateplan_name), meal_plan_description=VALUES(meal_plan_description), commission_perc=VALUES(commission_perc), tax_perc=VALUES(tax_perc), currency=VALUES(currency), occupancy=VALUES(occupancy), status=1, deleted=0, updatedon=NOW();
INSERT INTO dvi_hotel_room_rate_plan (hotel_id, room_id, room_type_id, axisrooms_room_id, rate_plan_code, rateplan_id, rateplan_name, meal_plan_description, commission_perc, tax_perc, currency, occupancy, status, deleted, createdon, updatedon) VALUES (153, 190, 183, 'DVIREXE136214', 'CP', 'CP_PLAN', 'CP', 'Breakfast only', '0.0', '0.0', 'INR', '["SINGLE","EXTRABED"]', 1, 0, NOW(), NOW()) ON DUPLICATE KEY UPDATE room_type_id=VALUES(room_type_id), axisrooms_room_id=VALUES(axisrooms_room_id), rate_plan_code=VALUES(rate_plan_code), rateplan_name=VALUES(rateplan_name), meal_plan_description=VALUES(meal_plan_description), commission_perc=VALUES(commission_perc), tax_perc=VALUES(tax_perc), currency=VALUES(currency), occupancy=VALUES(occupancy), status=1, deleted=0, updatedon=NOW();
INSERT INTO dvi_hotel_room_rate_plan (hotel_id, room_id, room_type_id, axisrooms_room_id, rate_plan_code, rateplan_id, rateplan_name, meal_plan_description, commission_perc, tax_perc, currency, occupancy, status, deleted, createdon, updatedon) VALUES (153, 190, 183, 'DVIREXE136214', 'MAP', 'MAP_PLAN', 'Modified American Plan', 'Breakfast + Lunch or Dinner', '0.0', '0.0', 'INR', '["SINGLE","DOUBLE","TRIPLE","QUAD","PENTA","HEXA","EXTRABED","EXTRAADULT","EXTRACHILD","EXTRAADULT2","EXTRACHILD2","EXTRAADULT3","EXTRACHILD3","EXTRAINFANT","CHILD_WITH_BED","CHILD_WITHOUT_BED"]', 1, 0, NOW(), NOW()) ON DUPLICATE KEY UPDATE room_type_id=VALUES(room_type_id), axisrooms_room_id=VALUES(axisrooms_room_id), rate_plan_code=VALUES(rate_plan_code), rateplan_name=VALUES(rateplan_name), meal_plan_description=VALUES(meal_plan_description), commission_perc=VALUES(commission_perc), tax_perc=VALUES(tax_perc), currency=VALUES(currency), occupancy=VALUES(occupancy), status=1, deleted=0, updatedon=NOW();

-- Occupancy rate rows for canonical rate plans
INSERT INTO dvi_hotel_occupancy_rate (hotel_id, room_id, rateplan_id, start_date, end_date, occupancy_rates, received_at) VALUES (153, 189, 'CP_PLAN', '2026-04-10', '2026-06-12', '{"DECA":12010,"HEXA":12006,"NONA":12009,"OCTA":12008,"QUAD":12004,"HEPTA":12007,"PENTA":12005,"DOUBLE":120000,"SINGLE":18001,"TRIPLE":12003,"EXTRABED":12011,"EXTRAADULT":12012,"EXTRACHILD":12013,"EXTRAADULT2":12014,"EXTRAADULT3":12016,"EXTRACHILD2":12015,"EXTRACHILD3":12017,"EXTRAINFANT":12018}', NOW()) ON DUPLICATE KEY UPDATE occupancy_rates=VALUES(occupancy_rates), received_at=NOW();
INSERT INTO dvi_hotel_occupancy_rate (hotel_id, room_id, rateplan_id, start_date, end_date, occupancy_rates, received_at) VALUES (153, 189, 'CP_PLAN', '2026-04-22', '2026-04-24', '{"DOUBLE":2,"SINGLE":2}', NOW()) ON DUPLICATE KEY UPDATE occupancy_rates=VALUES(occupancy_rates), received_at=NOW();
INSERT INTO dvi_hotel_occupancy_rate (hotel_id, room_id, rateplan_id, start_date, end_date, occupancy_rates, received_at) VALUES (153, 189, 'CP_PLAN', '2026-04-22', '2026-04-29', '{"DOUBLE":657,"SINGLE":345,"EXTRABED":45677,"EXTRAADULT":2232,"EXTRACHILD":3232,"EXTRAADULT2":32,"EXTRACHILD2":323,"CHILD_WITH_BED":3232,"CHILD_WITHOUT_BED":3232}', NOW()) ON DUPLICATE KEY UPDATE occupancy_rates=VALUES(occupancy_rates), received_at=NOW();
INSERT INTO dvi_hotel_occupancy_rate (hotel_id, room_id, rateplan_id, start_date, end_date, occupancy_rates, received_at) VALUES (153, 189, 'CP_PLAN', '2026-04-22', '2026-04-30', '{"DOUBLE":2,"SINGLE":123456}', NOW()) ON DUPLICATE KEY UPDATE occupancy_rates=VALUES(occupancy_rates), received_at=NOW();
INSERT INTO dvi_hotel_occupancy_rate (hotel_id, room_id, rateplan_id, start_date, end_date, occupancy_rates, received_at) VALUES (153, 189, 'CP_PLAN', '2026-04-22', '2026-05-01', '{"DOUBLE":2322}', NOW()) ON DUPLICATE KEY UPDATE occupancy_rates=VALUES(occupancy_rates), received_at=NOW();
INSERT INTO dvi_hotel_occupancy_rate (hotel_id, room_id, rateplan_id, start_date, end_date, occupancy_rates, received_at) VALUES (153, 189, 'CP_PLAN', '2026-04-22', '2026-06-11', '{"DOUBLE":2,"SINGLE":2}', NOW()) ON DUPLICATE KEY UPDATE occupancy_rates=VALUES(occupancy_rates), received_at=NOW();
INSERT INTO dvi_hotel_occupancy_rate (hotel_id, room_id, rateplan_id, start_date, end_date, occupancy_rates, received_at) VALUES (153, 189, 'CP_PLAN', '2026-04-30', '2026-06-02', '{"DOUBLE":2,"SINGLE":678}', NOW()) ON DUPLICATE KEY UPDATE occupancy_rates=VALUES(occupancy_rates), received_at=NOW();
INSERT INTO dvi_hotel_occupancy_rate (hotel_id, room_id, rateplan_id, start_date, end_date, occupancy_rates, received_at) VALUES (153, 189, 'CP_PLAN', '2026-04-30', '2026-06-12', '{"DECA":21010,"HEXA":21006,"NONA":21009,"OCTA":21008,"QUAD":21004,"HEPTA":21007,"PENTA":21005,"DOUBLE":888,"SINGLE":999,"TRIPLE":21003,"EXTRABED":21011,"EXTRAADULT":21012}', NOW()) ON DUPLICATE KEY UPDATE occupancy_rates=VALUES(occupancy_rates), received_at=NOW();
INSERT INTO dvi_hotel_occupancy_rate (hotel_id, room_id, rateplan_id, start_date, end_date, occupancy_rates, received_at) VALUES (153, 189, 'CP_PLAN', '2026-05-01', '2026-05-31', '{"DECA":9010,"HEXA":9006,"NONA":9009,"OCTA":9008,"QUAD":9004,"HEPTA":9007,"PENTA":9005,"DOUBLE":9002,"SINGLE":9001,"TRIPLE":9003,"EXTRABED":777,"EXTRAADULT":9012}', NOW()) ON DUPLICATE KEY UPDATE occupancy_rates=VALUES(occupancy_rates), received_at=NOW();
INSERT INTO dvi_hotel_occupancy_rate (hotel_id, room_id, rateplan_id, start_date, end_date, occupancy_rates, received_at) VALUES (153, 189, 'CP_PLAN', '2026-05-05', '2026-05-06', '{"DOUBLE":2222,"SINGLE":1111,"EXTRABED":777}', NOW()) ON DUPLICATE KEY UPDATE occupancy_rates=VALUES(occupancy_rates), received_at=NOW();
INSERT INTO dvi_hotel_occupancy_rate (hotel_id, room_id, rateplan_id, start_date, end_date, occupancy_rates, received_at) VALUES (153, 189, 'CP_PLAN', '2026-05-10', '2026-06-10', '{"DECA":8900,"HEXA":8500,"NONA":8800,"OCTA":8700,"QUAD":8300,"HEPTA":8600,"PENTA":8400,"DOUBLE":8100,"SINGLE":12000,"TRIPLE":8200,"EXTRABED":9000,"EXTRAADULT":9100,"EXTRACHILD":9200,"EXTRAADULT2":9300,"EXTRAADULT3":9500,"EXTRACHILD2":9400,"EXTRACHILD3":9600,"EXTRAINFANT":9700}', NOW()) ON DUPLICATE KEY UPDATE occupancy_rates=VALUES(occupancy_rates), received_at=NOW();
INSERT INTO dvi_hotel_occupancy_rate (hotel_id, room_id, rateplan_id, start_date, end_date, occupancy_rates, received_at) VALUES (153, 189, 'CP_PLAN', '2026-05-10', '2026-06-11', '{"DOUBLE":2,"SINGLE":2}', NOW()) ON DUPLICATE KEY UPDATE occupancy_rates=VALUES(occupancy_rates), received_at=NOW();
INSERT INTO dvi_hotel_occupancy_rate (hotel_id, room_id, rateplan_id, start_date, end_date, occupancy_rates, received_at) VALUES (153, 189, 'CP_PLAN', '2026-06-10', '2026-06-12', '{}', NOW()) ON DUPLICATE KEY UPDATE occupancy_rates=VALUES(occupancy_rates), received_at=NOW();
INSERT INTO dvi_hotel_occupancy_rate (hotel_id, room_id, rateplan_id, start_date, end_date, occupancy_rates, received_at) VALUES (153, 190, 'CP_PLAN', '2026-04-10', '2026-06-12', '{"DECA":12010,"HEXA":12006,"NONA":12009,"OCTA":12008,"QUAD":12004,"HEPTA":12007,"PENTA":12005,"DOUBLE":120000,"SINGLE":5000,"TRIPLE":12003,"EXTRABED":6000,"EXTRAADULT":12012,"EXTRACHILD":12013,"EXTRAADULT2":12014,"EXTRAADULT3":12016,"EXTRACHILD2":12015,"EXTRACHILD3":12017,"EXTRAINFANT":12018}', NOW()) ON DUPLICATE KEY UPDATE occupancy_rates=VALUES(occupancy_rates), received_at=NOW();
INSERT INTO dvi_hotel_occupancy_rate (hotel_id, room_id, rateplan_id, start_date, end_date, occupancy_rates, received_at) VALUES (153, 190, 'CP_PLAN', '2026-04-21', '2026-04-30', '{"HEXA":2,"NONA":2,"OCTA":2,"QUAD":2,"HEPTA":2,"PENTA":2,"DOUBLE":220,"SINGLE":22,"TRIPLE":2,"EXTRABED":2,"EXTRACHILD":2,"CHILD_WITH_BED":2,"CHILD_WITHOUT_BED":2}', NOW()) ON DUPLICATE KEY UPDATE occupancy_rates=VALUES(occupancy_rates), received_at=NOW();
INSERT INTO dvi_hotel_occupancy_rate (hotel_id, room_id, rateplan_id, start_date, end_date, occupancy_rates, received_at) VALUES (153, 190, 'CP_PLAN', '2026-04-22', '2026-05-21', '{"SINGLE":25}', NOW()) ON DUPLICATE KEY UPDATE occupancy_rates=VALUES(occupancy_rates), received_at=NOW();
INSERT INTO dvi_hotel_occupancy_rate (hotel_id, room_id, rateplan_id, start_date, end_date, occupancy_rates, received_at) VALUES (153, 190, 'MAP_PLAN', '2026-04-22', '2026-04-23', '{"HEXA":2,"QUAD":2,"PENTA":2,"DOUBLE":2,"SINGLE":2,"TRIPLE":2,"EXTRABED":2,"EXTRAADULT":2,"EXTRACHILD":2,"EXTRAADULT2":2,"EXTRAADULT3":2,"EXTRACHILD2":2,"EXTRACHILD3":2,"EXTRAINFANT":2,"CHILD_WITH_BED":2,"CHILD_WITHOUT_BED":2}', NOW()) ON DUPLICATE KEY UPDATE occupancy_rates=VALUES(occupancy_rates), received_at=NOW();

COMMIT;
