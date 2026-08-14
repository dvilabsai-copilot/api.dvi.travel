ALTER TABLE `dvi_itinerary_hotel_search_cache`
  ADD COLUMN `recommendation_algorithm_version` VARCHAR(8) NULL,
  ADD COLUMN `recommendation_search_run_id` VARCHAR(100) NULL,
  ADD COLUMN `recommendation_generated_at` DATETIME(0) NULL;

CREATE INDEX `idx_hotel_cache_recommendation_run`
  ON `dvi_itinerary_hotel_search_cache` (`plan_id`, `recommendation_search_run_id`);
