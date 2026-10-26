ALTER TABLE `dvi_hotel_block_requests`
  ADD COLUMN `cutoff_reminder_sent_at` DATETIME NULL;

CREATE INDEX `idx_hotel_block_request_cutoff_reminder`
  ON `dvi_hotel_block_requests` (`cutoff_reminder_sent_at`);
