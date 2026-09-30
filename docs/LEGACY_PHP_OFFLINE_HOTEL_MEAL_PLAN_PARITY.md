# Legacy PHP offline hotel meal-plan parity

This document records how the legacy PHP B2B application stores, calculates, and displays hotel Breakfast, Lunch, and Dinner data. It is the implementation reference for matching that behavior in the NestJS/React application for offline hotels.

Scope: hotels whose master record is in dvi_hotel and whose selection is not being supplied by a live AX, STAAH, or TBO availability response.

## Executive summary

The legacy application has two different meal-data layers:

1. The hotel master pricebook stores a daily price for each meal.
2. The itinerary snapshot stores which meals were selected for the room, the per-person prices used, the calculated totals, and the derived display code.

The values Breakfast, Lunch, and Dinner are not themselves the row/card label. The displayed CP, MAP, AP, or EP value is derived from the persisted room flags and positive per-person prices.

For NestJS parity, do not calculate the itinerary display label from the current hotel master after a selection has been saved. Resolve the daily pricebook values during selection, persist the selected flags/prices/totals, and render the persisted result on reload.

## 1. Legacy master pricebook storage

### Table

dvi_hotel_meal_price_book

The current Nest Prisma schema contains this model in api.dvi.travel/prisma/schema.prisma.

| Field | Meaning |
| --- | --- |
| hotel_id | Foreign key to the offline hotel in dvi_hotel |
| meal_type = 1 | Breakfast |
| meal_type = 2 | Lunch |
| meal_type = 3 | Dinner |
| year | Pricebook year, stored as text |
| month | Pricebook month, stored as text, for example October |
| day_1 … day_31 | Price for that meal on the corresponding calendar day |
| status, deleted | Active/deleted flags |

The logical lookup is:

~~~text
(hotel_id, meal_type, year, month) -> day_N
~~~

There is normally one monthly row per hotel and meal type. A day outside the month is still represented by the legacy schema as a column; it should be treated as zero/not applicable.

### Admin write flow

Relevant legacy files:

- C:\wamp64\www\dvi_b2b\engine\ajax\ajax_hotel_pricebook_details_form.php
- C:\wamp64\www\dvi_b2b\engine\ajax\ajax_manage_hotel_pricebook_details.php

The pricebook form accepts:

~~~text
hotel_breafast_cost  -> meal_type 1
hotel_lunch_cost     -> meal_type 2
hotel_dinner_cost    -> meal_type 3
~~~

hotel_breafast_cost is a legacy spelling typo. NestJS should expose a correctly named breakfastCost field and map it explicitly if compatibility with the PHP request is ever required.

For every month intersecting the selected date range, the PHP write endpoint either updates or inserts the monthly row. Days inside the range receive the entered cost; days outside the range are written as zero. Missing/non-numeric input is also treated as zero by the legacy write path.

### Admin read/display flow

ajax_hotel_meal_pricebook_details.php?type=show_form:

1. Receives hotelID, start_date, and end_date.
2. Loads the matching monthly rows from dvi_hotel_meal_price_book.
3. Indexes rows by meal_type.
4. Renders exactly three rows in this order: Breakfast, Lunch, Dinner.
5. Reads the appropriate day_N column for each date.
6. Displays a formatted rupee amount when a numeric value exists; otherwise displays No Price.

This is the source represented by the legacy screenshot showing the monthly matrix.

## 2. Itinerary selection snapshot storage

The legacy itinerary does not repeatedly derive a saved itinerary from the master pricebook. During hotel/room selection it writes a snapshot into two tables.

### Room-level snapshot

dvi_itinerary_plan_hotel_room_details

Relevant fields:

| Field | Meaning |
| --- | --- |
| breakfast_required | 1 when Breakfast was selected |
| lunch_required | 1 when Lunch was selected |
| dinner_required | 1 when Dinner was selected |
| breakfast_cost_per_person | Selected Breakfast unit price |
| lunch_cost_per_person | Selected Lunch unit price |
| dinner_cost_per_person | Selected Dinner unit price |
| total_breafast_cost | Calculated Breakfast total; legacy typo is part of the schema |
| total_lunch_cost | Calculated Lunch total |
| total_dinner_cost | Calculated Dinner total |
| room_qty, room_rate, total_room_cost | Room quantity and room charge values |

The total for each meal is calculated from the selected flag, the per-person price, and the applicable person count. If the meal is not required, its total is zero.

### Hotel-level aggregate

dvi_itinerary_plan_hotel_details

Relevant fields:

~~~text
hotel_breakfast_cost
hotel_breakfast_cost_gst_amount
hotel_lunch_cost
hotel_lunch_cost_gst_amount
hotel_dinner_cost
hotel_dinner_cost_gst_amount
total_hotel_meal_plan_cost
total_hotel_meal_plan_cost_gst_amount
total_room_cost
total_hotel_cost
total_hotel_tax_amount
~~~

These are the aggregate values used by the itinerary row price tooltip and the selected-hotel detail view. The hotel total is not just the room price; it includes the applicable meal totals and other hotel supplements/taxes.

The Nest Prisma schema already contains these fields in the two itinerary models. It also contains selected_price_snapshot on dvi_itinerary_plan_hotel_details; this is useful for provider/rate identity, but it should not replace the authoritative persisted meal flags and aggregate amounts.

### Route/night boundary

The legacy selection workflow has route-specific rules. In particular, it can suppress Dinner on the last route when that route does not represent a hotel night or when the route structure indicates that the last route is only a transfer. The Nest implementation must apply the same route-night rule before calculating totals; otherwise the displayed meal label and amount can disagree with the itinerary’s actual hotel nights.

## 3. Legacy meal-plan code derivation

The authoritative PHP rule appears in:

- engine/ajax/ajax_latest_itineary_hotel_details.php
- engine/ajax/ajax_show_recommended_hotel_details_form.php
- engine/ajax/ajax_view_itinerary_recommended_hotel_details_form.php

The rule is equivalent to:

~~~text
if hotel_required != 1:
    EP
else if breakfast_required == 1 and breakfast_cost_per_person > 0:
    if lunch_required == 1 and lunch_cost_per_person > 0
       and dinner_required == 1 and dinner_cost_per_person > 0:
        AP
    else if (lunch_required == 1 and lunch_cost_per_person > 0)
         or (dinner_required == 1 and dinner_cost_per_person > 0):
        MAP
    else:
        CP
else:
    EP
~~~

| Breakfast | Lunch | Dinner | Positive prices | Legacy code |
| --- | --- | --- | --- | --- |
| no | no | no | irrelevant | EP |
| no | yes | yes | lunch/dinner only | EP |
| no | yes | no | lunch only | EP |
| no | no | yes | dinner only | EP |
| yes | no | no | breakfast | CP |
| yes | yes | no | breakfast/lunch | MAP |
| yes | no | yes | breakfast/dinner | MAP |
| yes | yes | yes | all three | AP |

The price check is important. A flag set to 1 with a zero/missing price does not qualify that meal for the code. For example, Breakfast selected with a zero Breakfast price produces EP, not CP.

The legacy implementation therefore does not treat Lunch + Dinner without Breakfast as MAP. That combination must remain EP for strict PHP parity.

## 4. Legacy itinerary row and selected-card display

### Hotel row/table

The legacy row is rendered by the itinerary AJAX files listed above. The query joins:

~~~text
dvi_itinerary_plan_hotel_details
  LEFT JOIN dvi_itinerary_plan_hotel_room_details
~~~

The row displays:

| UI column | Source |
| --- | --- |
| Day/date | itinerary route fields |
| Destination | itinerary_route_location |
| Hotel Name - Category | dvi_hotel name plus itinerary hotel_category_id |
| Hotel Room Type | room type master through room_type_id |
| Price | persisted hotel totals and taxes |
| Meal Plan | derived EP/CP/MAP/AP label |

The selected hotel row is therefore snapshot-driven. It should not query the current live supplier or recalculate from the current room card simply to paint the table.

### Selected hotel detail/price card

engine/ajax/ajax_latest_itineary_hotel_info_view.php loads the same persisted room and hotel aggregates. Its cost breakdown conditionally displays:

~~~text
Total Room Cost
Total Breakfast Cost   only when hotel_breakfast_cost > 0
Total Lunch Cost       only when hotel_lunch_cost > 0
Total Dinner Cost      only when hotel_dinner_cost > 0
Total Extra Bed Cost   only when applicable
child/amenity costs   only when applicable
taxes
Grand Total
~~~

The meal-plan code shown on the row/card and the individual meal amounts shown in the price breakdown come from the same saved selection state. This prevents the label from changing merely because the master pricebook was edited later.

## 5. Current NestJS/React mapping

### Current offline search path

The current Nest offline search is in:

api.dvi.travel/src/modules/itineraries/services/offline-hotel-catalog.service.ts

The current path:

1. Loads offline hotel records from dvi_hotel.
2. Loads rooms and rate plans from dvi_hotel_room_rate_plan.
3. Loads date-covering prices from dvi_hotel_occupancy_rate.
4. Builds nightly offers and exposes mealPlan, room type, category/rating, and price in the response.
5. Persists selected meal flags through itinerary-selection-workflow.service.ts.

This is a meaningful difference from the legacy PHP admin pricebook. The current offline search code does not read dvi_hotel_meal_price_book when it builds its room price. It uses the canonical occupancy-rate source and rate-plan metadata. That behavior must not be changed globally for AX/STAAH/TBO flows.

The current resolveMealPlan() fallback in offline-hotel-catalog.service.ts derives a code from room inclusion flags:

~~~text
breakfast + lunch + dinner -> AP
breakfast + (lunch or dinner) -> MAP
breakfast -> CP
otherwise -> EP
~~~

The explicit requested rate plan is preferred when an active room rate plan matches it.

### Current frontend display path

Relevant React files:

- dvi_frontend/src/pages/hotel-list/HotelListTable.tsx — hotel row/table display and edit controls.
- dvi_frontend/src/pages/hotel-list/MealPlanCell.tsx — table meal cell rendering.
- dvi_frontend/src/pages/hotel-list/hotelList.utils.ts — meal normalization, selection hydration, and display helpers.
- dvi_frontend/src/components/hotels/HotelSearchResultCard.tsx — search/card display for hotel options.

The frontend accepts both a concrete selected mealPlan and supplier rate-condition text such as CP / MAP / AP / EP. It gives persisted selection metadata priority after reload. That is correct for live supplier options, but offline rows should receive a server-authoritative concrete code rather than relying on a frontend inference fallback.

There is one parity risk to address during implementation: the frontend normalizer currently treats Lunch + Dinner as MAP when it infers from free text, while the legacy PHP rule requires Breakfast to be present and priced. For offline persisted rows, the frontend should display the backend’s concrete code and avoid re-deriving it from an incomplete string.

## 6. Recommended Nest implementation

Implement this as an offline-only path with one shared backend calculation boundary.

### Step 1: Read the offline meal pricebook

Add a small repository/service method that reads dvi_hotel_meal_price_book for:

~~~text
hotel_id + the itinerary’s applicable route-night dates
~~~

Map meal_type 1/2/3 to Breakfast/Lunch/Dinner and read day_N from the matching month row. Treat zero, null, missing month rows, and missing day values as a non-priced meal, matching PHP.

Do not add this query to live AX/STAAH/TBO provider flows.

### Step 2: Resolve the selected offline meal state

At selection time, create a normalized internal object:

~~~ts
{
  breakfastRequired: boolean;
  lunchRequired: boolean;
  dinnerRequired: boolean;
  breakfastCostPerPerson: number;
  lunchCostPerPerson: number;
  dinnerCostPerPerson: number;
  totalBreakfastCost: number;
  totalLunchCost: number;
  totalDinnerCost: number;
  mealPlanCode: 'EP' | 'CP' | 'MAP' | 'AP';
}
~~~

Apply route/night suppression before calculating the totals. Calculate each total once using the same person/room counts used by the hotel total calculation.

### Step 3: Persist both flags and aggregates

For offline selections, persist:

- room-level required flags and per-person costs in dvi_itinerary_plan_hotel_room_details;
- room-level meal totals in total_breafast_cost, total_lunch_cost, and total_dinner_cost for schema parity;
- hotel-level meal totals and GST fields in dvi_itinerary_plan_hotel_details;
- the normalized mealPlanCode in the selected snapshot/response metadata for stable display.

The persisted database values remain authoritative after refresh. The current snapshot may contain the display code, but it must not be the only place where totals or flags exist.

### Step 4: Return one display contract

The itinerary-details API should return the same concrete mealPlan/mealPlanCode for:

1. the selected hotel row;
2. the selected hotel card;
3. the room/meal edit dialog;
4. the post-refresh hydrated selection.

The API should also return the individual meal amounts when the price breakdown is shown. The React layer should render those fields, not recompute the code from rate-condition text.

### Step 5: Keep live-provider behavior separate

Use provider branching at the service boundary:

~~~text
offline -> dvi_hotel + offline pricebook/occupancy + persisted meal snapshot
AX      -> AxisRooms rate-plan response
STAAH   -> STAAH rate-plan response
TBO     -> TBO rate-plan response
~~~

Do not change the shared live-provider meal normalizer to compensate for offline data. Do not replace live rate-plan values with dvi_hotel_meal_price_book values.

## 7. Regression matrix before implementation

| Scenario | Required result |
| --- | --- |
| Offline Breakfast only with positive price | CP |
| Offline Breakfast + Lunch | MAP |
| Offline Breakfast + Dinner | MAP |
| Offline Breakfast + Lunch + Dinner | AP |
| Offline Lunch + Dinner without Breakfast | EP, matching PHP |
| Offline selected flag with zero/missing price | Meal does not qualify for the code |
| Hotel not required | EP |
| Multiple nights with different daily prices | Each applicable date uses its own day_N value |
| Multiple rooms/person counts | Room-level and hotel-level totals reconcile |
| Last route without a hotel night | Dinner suppression follows route/night rule |
| Refresh/reload | Row, card, meal code, and amounts remain identical |
| Change room type only | Hotel identity and other selected meal state are preserved |
| Change meal plan only | Same hotel/room identity; only meal selection and totals change |
| Live AX/STAAH/TBO result | Existing supplier meal-plan behavior remains unchanged |
| Missing offline pricebook row | No false priced meal; behavior is explicit and logged |
| Hotel category/name display | Comes from canonical hotel/master data, not a placeholder fallback |

## 8. Verification queries and logs

For an offline hotel and itinerary route, verify these values together:

~~~sql
-- Master daily meal values
SELECT hotel_id, meal_type, year, month,
       day_1, day_2, day_3, day_4, day_5
FROM dvi_hotel_meal_price_book
WHERE hotel_id = :hotel_id
  AND meal_type IN (1, 2, 3)
  AND deleted = 0
  AND status = 1;

-- Persisted room selection
SELECT breakfast_required, lunch_required, dinner_required,
       breakfast_cost_per_person, lunch_cost_per_person,
       dinner_cost_per_person,
       total_breafast_cost, total_lunch_cost, total_dinner_cost
FROM dvi_itinerary_plan_hotel_room_details
WHERE itinerary_plan_hotel_details_id = :hotel_details_id
  AND deleted = 0
  AND status = 1;

-- Persisted hotel aggregate
SELECT hotel_breakfast_cost, hotel_lunch_cost, hotel_dinner_cost,
       total_hotel_meal_plan_cost,
       total_hotel_meal_plan_cost_gst_amount,
       total_hotel_cost, total_hotel_tax_amount
FROM dvi_itinerary_plan_hotel_details
WHERE itinerary_plan_hotel_details_ID = :hotel_details_id
  AND deleted = 0
  AND status = 1;
~~~

Recommended structured log fields for the Nest selection workflow:

~~~text
provider=offline
hotelId
routeId
routeDate
mealPlanCode
breakfastRequired/lunchRequired/dinnerRequired
breakfastCostPerPerson/lunchCostPerPerson/dinnerCostPerPerson
totalBreakfastCost/totalLunchCost/totalDinnerCost
totalHotelMealPlanCost
~~~

This makes it possible to distinguish a missing master price, an incorrect selection flag, a route-night boundary issue, and a frontend display issue without changing provider behavior.

## Source files inspected

Legacy PHP:

- C:\wamp64\www\dvi_b2b\engine\ajax\ajax_hotel_meal_pricebook_details.php
- C:\wamp64\www\dvi_b2b\engine\ajax\ajax_manage_hotel_pricebook_details.php
- C:\wamp64\www\dvi_b2b\engine\ajax\__ajax_hotelroom_pricebook_list.php
- C:\wamp64\www\dvi_b2b\engine\ajax\ajax_latest_itineary_hotel_details.php
- C:\wamp64\www\dvi_b2b\engine\ajax\ajax_show_recommended_hotel_details_form.php
- C:\wamp64\www\dvi_b2b\engine\ajax\ajax_view_itinerary_recommended_hotel_details_form.php
- C:\wamp64\www\dvi_b2b\engine\ajax\ajax_latest_itineary_hotel_info_view.php
- C:\wamp64\www\dvi_b2b\engine\ajax\ajax_latest_manage_itineary.php

NestJS/React:

- api.dvi.travel/prisma/schema.prisma
- api.dvi.travel/src/modules/itineraries/services/offline-hotel-catalog.service.ts
- api.dvi.travel/src/modules/itineraries/services/itinerary-selection-workflow.service.ts
- api.dvi.travel/src/modules/itineraries/itinerary-hotel-details.service.ts
- dvi_frontend/src/pages/hotel-list/HotelListTable.tsx
- dvi_frontend/src/pages/hotel-list/MealPlanCell.tsx
- dvi_frontend/src/pages/hotel-list/hotelList.utils.ts
- dvi_frontend/src/components/hotels/HotelSearchResultCard.tsx
