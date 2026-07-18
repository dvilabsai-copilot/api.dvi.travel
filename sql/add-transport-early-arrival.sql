ALTER TABLE dvi_itinerary_plan_details
    ADD COLUMN transport_early_arrival_option VARCHAR(50) NULL,
    ADD COLUMN transport_early_arrival_hotel_name VARCHAR(255) NULL,
    ADD COLUMN transport_early_arrival_rest_minutes SMALLINT UNSIGNED NULL;

ALTER TABLE dvi_confirmed_itinerary_plan_details
    ADD COLUMN transport_early_arrival_option VARCHAR(50) NULL,
    ADD COLUMN transport_early_arrival_hotel_name VARCHAR(255) NULL,
    ADD COLUMN transport_early_arrival_rest_minutes SMALLINT UNSIGNED NULL;
