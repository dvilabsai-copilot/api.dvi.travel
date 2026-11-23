-- CreateTable
CREATE TABLE `tbo_hotel_booking_attempt` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `confirmed_itinerary_plan_ID` INTEGER NOT NULL,
    `itinerary_plan_ID` INTEGER NOT NULL,
    `itinerary_route_ID` INTEGER NOT NULL,
    `batch_index` INTEGER NOT NULL,
    `start_room_index` INTEGER NOT NULL,
    `number_of_rooms` INTEGER NOT NULL,
    `booking_code_hash` CHAR(64) NOT NULL,
    `state` VARCHAR(32) NOT NULL DEFAULT 'PREPARED',
    `supplier_booking_id` VARCHAR(100) NULL,
    `supplier_booking_reference` VARCHAR(100) NULL,
    `confirmation_id` INTEGER NULL,
    `createdon` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedon` DATETIME(3) NOT NULL,

    INDEX `tbo_hotel_booking_attempt_itinerary_plan_ID_idx`(`itinerary_plan_ID`),
    INDEX `tbo_hotel_booking_attempt_state_idx`(`state`),
    UNIQUE INDEX `uniq_tbo_booking_attempt_batch`(`confirmed_itinerary_plan_ID`, `itinerary_route_ID`, `batch_index`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
