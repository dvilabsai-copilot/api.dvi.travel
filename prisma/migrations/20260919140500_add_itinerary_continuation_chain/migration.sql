ALTER TABLE `dvi_itinerary_plan_details`
  ADD COLUMN `continued_from_plan_ID` INT NOT NULL DEFAULT 0,
  ADD COLUMN `continuation_root_quote_ID` VARCHAR(100) NULL;

CREATE INDEX `idx_itinerary_plan_continued_from_plan_ID`
  ON `dvi_itinerary_plan_details` (`continued_from_plan_ID`);

CREATE INDEX `idx_itinerary_plan_continuation_root_quote_ID`
  ON `dvi_itinerary_plan_details` (`continuation_root_quote_ID`);
