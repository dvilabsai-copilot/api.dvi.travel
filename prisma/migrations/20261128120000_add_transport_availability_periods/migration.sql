CREATE TABLE `dvi_transport_availability_period` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `kind` ENUM(
        'maintenance',
        'reserved',
        'driver_leave',
        'blocked'
    ) NOT NULL,
    `resourceId` INTEGER NOT NULL,
    `vehicleKey` VARCHAR(50) NULL,
    `startsAt` DATETIME(3) NOT NULL,
    `endsAt` DATETIME(3) NOT NULL,
    `reason` VARCHAR(255) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `idx_transport_period_resource`(
        `kind`, `resourceId`, `active`, `startsAt`, `endsAt`
    ),

    INDEX `idx_transport_period_vehicle`(
        `vehicleKey`, `active`, `startsAt`, `endsAt`
    ),

    PRIMARY KEY (`id`)
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;