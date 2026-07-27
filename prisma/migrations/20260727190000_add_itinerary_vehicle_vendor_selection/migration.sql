CREATE TABLE `dvi_itinerary_plan_vehicle_vendor_selection` (
  `itinerary_plan_vehicle_vendor_selection_ID` INTEGER NOT NULL AUTO_INCREMENT,
  `itinerary_plan_id` INTEGER NOT NULL,
  `vehicle_type_id` INTEGER NOT NULL,
  `selected_vendor_eligible_id` INTEGER NULL,
  `vendor_id` INTEGER NOT NULL,
  `vendor_branch_id` INTEGER NOT NULL,
  `vendor_vehicle_type_id` INTEGER NOT NULL,
  `vehicle_id` INTEGER NOT NULL DEFAULT 0,
  `selection_source` VARCHAR(10) NOT NULL DEFAULT 'auto',
  `createdby` INTEGER NOT NULL DEFAULT 0,
  `createdon` DATETIME(0) NULL,
  `updatedon` DATETIME(0) NULL,
  `status` TINYINT NOT NULL DEFAULT 1,
  `deleted` TINYINT NOT NULL DEFAULT 0,

  UNIQUE INDEX `uq_itinerary_vehicle_vendor_selection` (
    `itinerary_plan_id`,
    `vehicle_type_id`
  ),

  INDEX `idx_vehicle_vendor_selection_plan` (
    `itinerary_plan_id`
  ),

  INDEX `idx_vehicle_vendor_selection_type` (
    `vehicle_type_id`
  ),

  INDEX `idx_vehicle_vendor_selection_vendor` (
    `vendor_id`
  ),

  INDEX `idx_vehicle_vendor_selection_source` (
    `selection_source`
  ),

  PRIMARY KEY (
    `itinerary_plan_vehicle_vendor_selection_ID`
  )
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
