-- Supporting indexes for provider city-code resolution. These columns are
-- nullable because most city master rows are not mapped to every provider.
CREATE INDEX `idx_city_tbo_code` ON `dvi_cities` (`tbo_city_code`);
CREATE INDEX `idx_city_hobse_code` ON `dvi_cities` (`hobse_city_code`);
