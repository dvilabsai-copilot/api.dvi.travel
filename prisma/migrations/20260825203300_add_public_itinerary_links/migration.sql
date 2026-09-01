-- CreateTable
CREATE TABLE `public_itinerary_links` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `tokenHash` VARCHAR(64) NOT NULL,
    `itineraryPlanId` INTEGER NOT NULL,
    `groupType` INTEGER NOT NULL,
    `createdAt` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `expiresAt` DATETIME(0) NOT NULL,
    `revokedAt` DATETIME(0) NULL,
    `createdByUserId` INTEGER NULL,
    `createdByAgentId` INTEGER NULL,
    `firstAccessedAt` DATETIME(0) NULL,
    `lastAccessedAt` DATETIME(0) NULL,
    `accessCount` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `public_itinerary_links_tokenHash_key`(`tokenHash`),
    INDEX `idx_public_itinerary_plan`(`itineraryPlanId`),
    INDEX `idx_public_itinerary_expires`(`expiresAt`),
    INDEX `idx_public_itinerary_created_by_agent`(`createdByAgentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
