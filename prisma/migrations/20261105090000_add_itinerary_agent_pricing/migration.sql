CREATE TABLE IF NOT EXISTS `dvi_itinerary_agent_pricing` (
  `itinerary_plan_ID` INT NOT NULL,
  `agent_profit` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `final_selling_price` DECIMAL(14,2) NULL DEFAULT NULL,
  `updated_at` TIMESTAMP NOT NULL
    DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`itinerary_plan_ID`)
);
