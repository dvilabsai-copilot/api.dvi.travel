ALTER TABLE `dvi_itinerary_plan_hotel_details`
  ADD COLUMN `selection_origin` VARCHAR(20) NULL AFTER `selected_currency`;

UPDATE `dvi_itinerary_plan_hotel_details`
SET `selection_origin` = UPPER(JSON_UNQUOTE(JSON_EXTRACT(`selected_price_snapshot`, '$.selectionOrigin')))
WHERE `selection_origin` IS NULL
  AND JSON_VALID(`selected_price_snapshot`)
  AND UPPER(JSON_UNQUOTE(JSON_EXTRACT(`selected_price_snapshot`, '$.selectionOrigin')))
    IN ('AUTO_SELECTED', 'USER_SELECTED');
