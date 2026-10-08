CREATE TABLE IF NOT EXISTS `dvi_itinerary_extra_margin_rule_vendors` (
  `rule_vendor_id` INT NOT NULL AUTO_INCREMENT,
  `rule_id` INT NOT NULL,
  `vendor_id` INT NOT NULL,
  `createdon` DATETIME(0) NULL,
  `updatedon` DATETIME(0) NULL,
  PRIMARY KEY (`rule_vendor_id`),
  UNIQUE INDEX `uq_itinerary_extra_margin_rule_vendor` (`rule_id`, `vendor_id`),
  INDEX `idx_itinerary_extra_margin_rule_vendor_rule` (`rule_id`),
  INDEX `idx_itinerary_extra_margin_rule_vendor_vendor` (`vendor_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
