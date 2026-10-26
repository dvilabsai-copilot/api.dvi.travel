ALTER TABLE `tbo_hotel_master`
  ADD COLUMN `hotel_email` VARCHAR(255) NULL AFTER `hotel_image_url`,
  ADD COLUMN `hotel_mobile` VARCHAR(50) NULL AFTER `hotel_email`;
