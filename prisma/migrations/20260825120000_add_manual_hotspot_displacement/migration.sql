CREATE TABLE `dvi_itinerary_manual_hotspot_displacement` (
  `displacement_ID` INTEGER NOT NULL AUTO_INCREMENT,
  `itinerary_plan_ID` INTEGER NOT NULL DEFAULT 0,
  `itinerary_route_ID` INTEGER NOT NULL DEFAULT 0,
  `manual_hotspot_ID` INTEGER NOT NULL DEFAULT 0,
  `displaced_hotspot_ID` INTEGER NOT NULL DEFAULT 0,
  `createdby` INTEGER NOT NULL DEFAULT 0,
  `createdon` DATETIME(0) NULL,
  `updatedon` DATETIME(0) NULL,
  `status` TINYINT NOT NULL DEFAULT 1,
  `deleted` TINYINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`displacement_ID`),
  UNIQUE INDEX `uq_manual_hotspot_displacement` (`itinerary_plan_ID`, `itinerary_route_ID`, `manual_hotspot_ID`, `displaced_hotspot_ID`),
  INDEX `idx_manual_hotspot_displacement_route` (`itinerary_plan_ID`, `itinerary_route_ID`),
  INDEX `idx_manual_hotspot_displacement_manual` (`manual_hotspot_ID`),
  INDEX `idx_manual_hotspot_displacement_displaced` (`displaced_hotspot_ID`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
