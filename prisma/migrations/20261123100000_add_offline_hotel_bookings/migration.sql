CREATE TABLE `dvi_itinerary_offline_hotel_booking` (
    `itinerary_plan_id` INTEGER NOT NULL,
    `group_type` INTEGER NOT NULL,
    `route_id` INTEGER NOT NULL,
    `hotel_key` VARCHAR(300) NOT NULL,
    `check_in` DATE NOT NULL,
    `check_out` DATE NOT NULL,
    `details` JSON NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `updated_by` INTEGER NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`itinerary_plan_id`, `group_type`, `route_id`, `hotel_key`, `check_in`, `check_out`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
