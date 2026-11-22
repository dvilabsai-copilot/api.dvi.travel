CREATE TABLE `dvi_itinerary_quote_revision` (
    `plan_id` INTEGER NOT NULL,
    `original_plan_id` INTEGER NOT NULL,
    `parent_plan_id` INTEGER NULL,
    `revision_number` INTEGER NOT NULL,
    `quote_id` VARCHAR(191) NOT NULL,
    `status` VARCHAR(12) NOT NULL,
    `edit_key` CHAR(64) NULL,
    `reasons` JSON NOT NULL,
    `changed_by` INTEGER NOT NULL,
    `changed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `search_run_id` VARCHAR(191) NULL,
    `superseded_at` DATETIME(3) NULL,
    `overall_cost` DECIMAL(16,2) NULL,
    `frozen_cost_breakdown` JSON NULL,
    `frozen_hotels` JSON NULL,
    PRIMARY KEY (`plan_id`),
    UNIQUE INDEX `uq_itinerary_revision_quote` (`quote_id`),
    UNIQUE INDEX `uq_itinerary_revision_number` (`original_plan_id`, `revision_number`),
    INDEX `idx_itinerary_revision_parent` (`parent_plan_id`),
    CONSTRAINT `dvi_itinerary_quote_revision_plan_id_fkey` FOREIGN KEY (`plan_id`)
        REFERENCES `dvi_itinerary_plan_details` (`itinerary_plan_ID`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
