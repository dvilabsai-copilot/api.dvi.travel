SELECT itinerary_route_ID, no_of_days, location_name, itinerary_route_date
FROM dvi_itinerary_route_details
WHERE itinerary_plan_ID = 381 AND deleted = 0
ORDER BY no_of_days ASC;
