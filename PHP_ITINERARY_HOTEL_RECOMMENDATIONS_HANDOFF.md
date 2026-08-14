# PHP itinerary hotel recommendations and multi-room selection

## Purpose

This is a handoff for implementing the PHP behavior behind:

https://www.b2b.dvi.co.in/head/latestitinerary.php?route=add&formtype=generate_itinerary&id=51384

The screenshots show three separate concepts:

1. Recommended groups: the Recommended #1, Recommended #2, etc. tabs.
2. Hotel candidates inside the active group/day: hotel cards with a Choose button.
3. Room categories: one independent room-type choice for every requested room.

## Implementation update — 2026-07-31

The current NestJS/React branches were updated from the requirements in this
document. Vehicle code was not changed.

### Backend

Implemented in `api.dvi.travel`:

- Added `HotelRecommendationPackageService` for complete-package generation.
- Groups consecutive nights at the same destination into one logical stay,
  preserving `stayKey` and `routeIds`.
- Selects only real eligible options and does not create duplicate packages
  from one hotel option.
- Applies availability, bookability, expiry, category, and configurable
  distance checks.
- Uses live options first and only considers offline options when no eligible
  live option exists for that stay.
- Enforces exact requested meal-plan matching. Unknown meal data is no longer
  silently interpreted as EP.
- Adds structured Alleppey houseboat handling requiring AP.
- Keeps the existing algorithm as the default rollback path. The new package
  generator is enabled with:

```env
HOTEL_RECOMMENDATION_ALGORITHM=v2
```

Optional configuration:

```env
MAX_RECOMMENDED_HOTEL_DISTANCE_KM=15
HOTEL_RECOMMENDATION_REQUIRE_DISTANCE=true
```

Relevant files:

- `src/modules/itineraries/services/hotel-recommendation-package.service.ts`
- `src/modules/itineraries/services/hotel-meal-plan-policy.service.ts`
- `src/modules/itineraries/itinerary-hotel-details-tbo.service.ts`
- `src/modules/hotels/hotel-rate-plans.ts`
- `src/modules/hotels/interfaces/hotel-provider.interface.ts`

### Frontend

Implemented in `dvi_frontend`:

- Unknown or missing meal plans are displayed as unknown instead of EP.
- A mismatched meal plan is shown as unavailable for the requested plan; it is
  not shown with a misleading green selected badge.
- Removed the duplicate room-selection setter that caused a Vite warning.

Relevant files:

- `src/pages/hotel-list/MealPlanCell.tsx`
- `src/pages/hotel-list/hotelList.utils.ts`
- `src/pages/HotelList.tsx`

### Verification

- Backend production build passed.
- Frontend production build passed.
- Backend focused/regression suite: 37 passed, 0 failed.
- Frontend focused suite: 14 passed, 0 failed.
- Changes were committed separately on branch
  `codex/vehicle-recovery-hotel-merge-20260728`:
  - Backend `2be2370e` — `Implement strict hotel recommendation eligibility`
  - Frontend `63d706d` — `Prevent misleading hotel meal plan display`
- No changes were pushed.

The Chrome localhost smoke reload could not be completed because the browser
security policy blocked access to `localhost:8080`; no browser-policy bypass
was used. Full refresh/reset API integration and complete browser E2E remain
separate follow-up work from this focused implementation.

## Important finding: the URL is only a shell

latestitinerary.php only chooses which AJAX form to load. For formtype=generate_itinerary it calls:

~~~text
POST engine/ajax/ajax_latest_itineary_step2_form.php?type=show_form&selected_group_type=1
data: { _ID: itineraryPlanId }
~~~

The step-2 form then loads the hotel UI:

~~~text
POST engine/ajax/ajax_latest_itineary_hotel_details.php?type=show_form
data: { _itinerary_plan_ID: itineraryPlanId, _group_type: groupType }
~~~

Source references:

- C:/wamp64/www/dvi_b2b/latestitinerary.php:367-418
- C:/wamp64/www/dvi_b2b/ajax_latest_itineary_step2_form.php:20-26
- C:/wamp64/www/dvi_b2b/ajax_latest_itineary_step2_form.php:1255-1259,1552-1565

The Nest implementation should return JSON from API endpoints, rather than HTML fragments with inline jQuery.

## UI contract and ASCII wireframes

The React page should preserve the visual hierarchy shown in the screenshots. The following diagrams are implementation guides, not literal text to render in the browser.

### Meal-plan rule for the current Nest/React cards

The current Nest/React hotel-card flow uses a fixed meal-plan code on each rate option/card. The visible values are package codes such as:

~~~text
CP  = Continental Plan
EP  = European Plan
MAP = Modified American Plan
~~~

The card displays the selected rate's meal plan; it does not expose Breakfast/Lunch/Dinner checkboxes. Meal plan is not part of the room-category modal update. Changing a room category must preserve the existing meal-plan code/rate selection.

This matches the current frontend patterns:

- dvi_frontend/src/components/hotels/HotelSearchResultCard.tsx:181-184 displays the rate option as room type plus meal plan.
- dvi_frontend/src/components/hotels/HotelSearchResultCard.tsx:209-214 displays the meal-plan badge.
- dvi_frontend/src/components/hotels/HotelRoomSelectionModal.tsx:192-208 only renders the room-type selector.

The PHP Breakfast/Lunch/Dinner flags remain relevant to legacy price calculation, but they are backend-derived implementation details for this Nest/React flow. Do not add those checkboxes to the card or modal UI, and do not send zero-valued flags merely because the room category changed.

### Overall page layout

~~~text
+----------------------+---------------------------------------------------------------+
| Sidebar              | Header: Tour Itinerary Plan                  [Back to Route]   |
|                      +---------------------------------------------------------------+
|  Dashboard           | #DVI...   Nov 13, 2026 to Nov 16, 2026      Adults 13        |
|  Create Itinerary    | Room Count 5   Extra Bed 3                  Infants 3        |
|  Download Packages   |                               Overall Trip Cost: ₹131,248.00 |
|  Latest Itinerary    +---------------------------------------------------------------+
|  Confirmed Itinerary | HOTEL LIST                         [Display Rates]          |
|  Accounts            |                                                               |
|  Hotels              | [Recommended #1 ₹88,957.31] [Recommended #2] [Recommended #3]|
|  Hotspot             |                                                               |
|  Activity            | +-----------------------------------------------------------+ |
|  Locations           | | DAY | DESTINATION | HOTEL-CATEGORY | ROOM TYPE | MEAL   | |
|  Guide               | |  1  | Munnar      | Green Ridge   | Deluxe    | CP     | |
|                      | +-----------------------------------------------------------+ |
|  Admin profile       |                                                               |
+----------------------+---------------------------------------------------------------+
~~

React layout mapping:

- `ItineraryGeneratePage`: shell, sticky itinerary summary, and active group state.
- `RecommendationTabs`: tabs and group totals.
- `HotelDayTable`: day/destination/hotel/room/meal summary rows.
- `HotelDayRow`: expands the candidate hotel panel for one route/day.

### Recommendation tabs

~~~text
HOTEL LIST                                      [Display Rates toggle]

  [ Recommended #1 (₹88,957.31) ]  Recommended #2 (₹70,486.17)
                                    Recommended #3 (₹82,617.49)
                                    Recommended #4 (₹122,717.86)
             ^ active tab / active groupType

  activeGroupType = 1
  only the active group's hotel rows and totals are shown below
~~~

The active tab should use the purple/pink selected style and an indicator arrow. The other tabs remain available without loading their data into the same section. On tab change, set `activeGroupType`, fetch that group's rows, and refresh the overall total.

### Hotel candidate card grid

~~~text
+--------------------------------------------------------------------------------+
| Day 1 | Munnar | GREEN RIDGE - STD | DELUXE | CP                         |
+--------------------------------------------------------------------------------+
| Search Hotel...                                                               |
|                                                                                |
| +------------------+  +------------------+  +------------------+  +----------+ |
| | bed - 5          |  | bed - 5          |  | bed - 5          |  | bed - 5  | |
| |                  |  |                  |  |                  |  |          | |
| |     [photo]      |  |     [photo]      |  |     [photo]      |  | [photo]  | |
| | 3* EASTEND       |  | STD GREEN RIDGE  |  | 4* KTDC Tea      |  | STD ...  | |
| | from ₹3,518      |  | from ₹2,600      |  | from ₹5,565      |  | from ... | |
| |       ▲ ₹5,076   |  | SELECTED        |  |       ▲ ₹19,199  |  | ▲ ₹4,819 | |
| | [Choose]         |  | [Update]        |  | [Choose]         |  | [Choose] |
| +------------------+  +------------------+  +------------------+  +----------+ |
+--------------------------------------------------------------------------------+
~~

Card rules:

- The selected card is visually highlighted and shows `Update` or remove behavior.
- Alternative cards show `Choose`.
- The card grid belongs to one day and one active `groupType` only.
- Include room availability, lowest starting price, check-in/out, the fixed meal-plan code, room-type edit, gallery, details, and amenities actions as supported by the current UI. Do not add Breakfast/Lunch/Dinner meal controls to the card.
- On narrow screens, use a responsive one-column/two-column layout rather than horizontal overflow.

### Expanded selected hotel room section

~~~text
+------------------ selected hotel card ------------------+
| GREEN RIDGE                                             |
| Check in 02:00 PM        Check out 12:00 PM              |
|                                                         |
| Room Type - 5 Rooms Selected                         [edit]|
|                                                         |
| Meal Plan: CP       (fixed package; display only)        |
|                                                         |
|                         [ Update ]       [ trash ]       |
+---------------------------------------------------------+

Clicking the room-type edit control opens the multi-room category modal. The displayed count comes from preferredRoomCount and must not be treated as one room-type quantity.
~~~

### Multi-room category modal

~~~text
                         +--------------------------------------+
                         |                         [ X ]          |
                         |          Choose Room Category         |
                         |       Select room category for each   |
                         |                 room                  |
                         |                                        |
                         |  [bed] Room #1    1 x  [DELUXE v]      |
                         |  [bed] Room #2    1 x  [DELUXE v]      |
                         |  [bed] Room #3    1 x  [DELUXE v]      |
                         |  [bed] Room #4    1 x  [DELUXE v]      |
                         |  [bed] Room #5    1 x  [DELUXE v]      |
                         |                                        |
                         |                     [ Cancel ]         |
                         +--------------------------------------+

When a dropdown is opened:

                         +-----------------------------+
                         | DELUXE - Deluxe             |  selected
                         | SUPER DELUXE - Super Deluxe |
                         | EXECUTIVE - Executive       |
                         +-----------------------------+
~~~

Modal behavior:

- Render one `RoomCategoryRow` for each room slot.
- Keep each row's selection independent.
- Existing child room rows are preselected; blank padded slots start empty.
- Selecting a value updates only that slot's draft state.
- The server validates and prices the selected room when the user confirms.
- After success, close the modal and refresh the active day, tab total, and overall total.

### UI state relationship

~~~text
activeGroupType
       |
       v
RecommendationTabs ---- selects ----> HotelDayTable
                                       |
                                       v
                              HotelDayRow / parent hotel
                                       |
                     expands candidate hotel cards
                                       |
                              selected hotel card
                                       |
                     opens RoomCategoryModal
                                       |
                  roomSlots[0..preferredRoomCount-1]
                                       |
                   PATCH one roomDetailId + recalculate
                                       |
             refresh active group + recommendation + overall totals
~~~

Do not flatten this into one `selectedHotel` and one `selectedRoomType`. The required identity is:

~~~text
(planId, groupType, routeId, hotelDetailsId, hotelId, roomDetailId)
~~~

That identity prevents a room selection in Recommended #1 or Day 1 from changing the corresponding room in another recommendation group or route.

## 1. Recommended-group behavior

### What a recommended group is

The PHP database stores several complete hotel alternatives for the same itinerary. The alternative is identified by:

~~~text
dvi_itinerary_plan_hotel_details.group_type
dvi_itinerary_plan_hotel_room_details.group_type
~~~

The page queries distinct active group_type values and creates one tab for each:

~~~sql
SELECT group_type
FROM dvi_itinerary_plan_hotel_details
WHERE deleted = 0
  AND itinerary_plan_ID = :planId
GROUP BY group_type
~~~

The label is Recommended #<group_type>. The tab price is calculated for that same group:

~~~php
getHOTEL_ITINEARY_PLAN_DETAILS($itinerary_plan_ID, $group_type,
                               'GRAND_TOTAL_OF_THE_HOTEL_CHARGES')
~~~

Source: engine/ajax/ajax_latest_itineary_hotel_details.php:50-79.

### How the active recommendation is selected

- Initial active group is 1.
- Clicking a tab changes active groupType.
- The hotel table reloads using planId + groupType.
- All hotel, room, amenities, and cost reads must use the selected group.
- Switching tabs replaces the displayed group; it does not merge groups.

This page does not calculate the recommendation ranking. It reads groups already generated and persisted by the earlier itinerary hotel-selection flow. Preserve the stored group number first; implement generation/ranking as a separate use case.

Do not assume Recommended #1 means cheapest unless the generation flow guarantees that. On this page, #1 means group_type = 1.

Recommended API shape:

~~~ts
type RecommendationGroup = {
  groupType: number;
  label: string;
  hotelTotal: number;
  overallTripTotal: number;
  days: HotelDay[];
};

type HotelDay = {
  hotelDetailsId: number;
  planId: number;
  routeId: number;
  routeDate: string;
  destination: string;
  hotelRequired: boolean;
  hotelId: number | null;
  hotelName: string | null;
  hotelCategoryId: number | null;
  selectedRoomCount: number;
  roomTypeSummary: string | null;
  mealPlan: 'CP' | 'EP' | 'MAP';
  totalHotelCost: number;
  totalHotelTaxAmount: number;
};
~~~

Use groupType ASC in the new API for stable tab order. The PHP group query has no explicit ORDER BY.

## 2. Hotel candidates inside a group

Clicking a day row expands a hotel-candidate panel scoped by:

~~~text
planId
routeId
routeDate
activeGroupType
selectedHotelId
preferredRoomCount
~~~

Sources:

- engine/ajax/ajax_show_recommended_hotel_details_form.php:182
- engine/ajax/ajax_itineary_hotel_roomdetails.php:20-42

### Candidate search rules

ajax_itineary_hotel_roomdetails.php searches hotels that:

- are active and not deleted;
- have active, non-deleted rooms;
- have latitude and longitude;
- are within 20 km of the itinerary destination;
- have a non-zero room rate for the itinerary date;
- for multiple rooms, have at least preferred_room_count available rooms.

Candidates are ordered by distance. PHP gathers room types and daily prices and calculates the lowest non-zero room rate for display.

Source: engine/ajax/ajax_itineary_hotel_roomdetails.php:55-93,155-156.

The current selected hotel is the parent row hotel_id for the active group and route. It is highlighted and gets update/remove actions. Other cards show Choose.

These operations are different:

~~~text
Recommendation tab click -> switch to a complete persisted alternative group
Hotel card Choose         -> change hotel for one route/day within that group
Room dropdown change      -> change one room detail within that hotel
~~~

## 3. Parent/child database model

The current Nest Prisma schema already contains the legacy tables.

### Parent: dvi_itinerary_plan_hotel_details

One parent row represents one hotel assignment for one itinerary route/date and one recommendation group.

Important fields:

| Field | Meaning |
|---|---|
| itinerary_plan_hotel_details_ID | Parent hotel assignment ID |
| group_type | Recommendation alternative key |
| itinerary_plan_id | Itinerary plan |
| itinerary_route_id | Day/route |
| itinerary_route_date | Hotel date |
| itinerary_route_location | Destination |
| hotel_required | Whether a hotel is required |
| hotel_category_id | Category/star/category ID |
| hotel_id | Currently selected hotel |
| total_no_of_rooms | Aggregate room quantity |
| total_room_cost | Aggregate room cost |
| total_hotel_cost | Aggregate hotel cost |
| total_hotel_tax_amount | Aggregate hotel tax |
| total_hotel_meal_plan_cost | Aggregate meal cost |
| total_extra_bed_cost | Aggregate extra-bed cost |
| total_childwith_bed_cost | Aggregate child-with-bed cost |
| total_childwithout_bed_cost | Aggregate child-without-bed cost |
| total_amenities_cost | Aggregate amenities cost |
| status, deleted | Active/deleted flags |

Schema: prisma/schema.prisma:3939-4055.

### Child: dvi_itinerary_plan_hotel_room_details

Each row represents one room allocation. For the multi-room screen, the intended representation is one row per room with room_qty = 1.

Important fields:

| Field | Meaning |
|---|---|
| itinerary_plan_hotel_room_details_ID | Room allocation ID / UI row identity |
| itinerary_plan_hotel_details_id | Parent hotel assignment |
| group_type | Must match active recommendation group |
| itinerary_plan_id, itinerary_route_id, itinerary_route_date | Scope |
| hotel_id | Hotel for this room |
| room_type_id | Selected category, for example Deluxe |
| room_id | Concrete hotel room/rate row |
| room_qty | Quantity represented by this row; normally 1 per slot |
| room_rate | Selected daily room rate |
| gst_type, gst_percentage | Room tax configuration |
| extra_bed_count, extra_bed_rate | Extra-bed values |
| child_with_bed_count, child_with_bed_charges | Child-with-bed values |
| child_without_bed_count, child_without_bed_charges | Child-without-bed values |
| breakfast_required, lunch_required, dinner_required | Meal flags |
| breakfast_cost_per_person, lunch_cost_per_person, dinner_cost_per_person | Daily meal rates |
| total_breafast_cost, total_lunch_cost, total_dinner_cost | Calculated meal totals |
| total_room_cost, total_room_gst_amount | Calculated room totals |
| status, deleted | Active/deleted flags |

Schema: prisma/schema.prisma:4093-4162.

Supporting master tables:

- dvi_hotel_rooms: concrete room/rate row and availability, schema.prisma:3623-3670.
- dvi_hotel_roomtype: room category name, schema.prisma:3672-3687.
- dvi_hotel_room_price_book: date-based room pricebook, schema.prisma:3532-3575+.
- dvi_hotel_meal_price_book: date-based meal pricebook, schema.prisma:3404-3488.

## 4. Multi-room category modal

The Room #1 through Room #5 modal comes from:

~~~text
engine/ajax/ajax_latest_itineary_hotel_multiple_rooms.php?type=show_form
~~~

Request inputs:

~~~text
itinerary_plan_hotel_details_ID
itinerary_plan_id
itinerary_route_id
hotel_id
hotel_required
all_meal_plan
breakfast_meal_plan
lunch_meal_plan
dinner_meal_plan
group_type
~~~

Those meal fields are part of the legacy PHP HTML/AJAX contract. They should not become editable controls in the Nest/React room-category modal. The React modal should load and preserve the active meal-plan code from the selected hotel/rate option.

The endpoint reads preferred_room_count from the itinerary plan.

### Rendering algorithm

PHP loads existing room-detail rows matching:

~~~sql
deleted = 0
AND itinerary_plan_id = :planId
AND itinerary_route_id = :routeId
AND itinerary_route_date = :routeDate
AND hotel_id = :hotelId
AND group_type = :groupType
~~~

For each existing row it renders:

~~~text
Room #n | room_qty x | room category dropdown
~~~

The dropdown contains categories supported by the selected hotel/date. If there are no existing rows, PHP renders preferred_room_count blank rows.

For the screenshot, the React state should look like:

~~~ts
rooms = [
  { slot: 1, roomDetailId: 9001, roomQty: 1, roomTypeId: DELUXE },
  { slot: 2, roomDetailId: 9002, roomQty: 1, roomTypeId: DELUXE },
  { slot: 3, roomDetailId: 9003, roomQty: 1, roomTypeId: DELUXE },
  { slot: 4, roomDetailId: 9004, roomQty: 1, roomTypeId: DELUXE },
  { slot: 5, roomDetailId: 9005, roomQty: 1, roomTypeId: DELUXE },
]
~~~

Each dropdown is independent. Selecting SUPER DELUXE for Room #5 must not change Rooms #1-#4.

Source: engine/ajax/ajax_latest_itineary_hotel_multiple_rooms.php:17-79.

### Legacy edge case to improve

The PHP endpoint only pads to preferred_room_count when there are no existing rows. If some rows exist, it does not reliably pad the remaining slots, and the query has no ORDER BY.

Implement the intended behavior in Nest:

1. Load active child rows in deterministic ID order.
2. Treat each child row as a room slot.
3. Pad with empty slots until preferredRoomCount.
4. Reject a save if there are more slots than requested, unless changing room count is supported.

## 5. Room category options

The PHP helper getHOTEL_ROOM_TYPE_DETAIL(...) produces options such as:

~~~text
DELUXE - Deluxe
SUPER DELUXE - Super Deluxe
EXECUTIVE - Executive
~~~

Nest should return structured options:

~~~ts
type RoomTypeOption = {
  roomTypeId: number;
  code: string;
  title: string;
  availableRoomCount: number;
  priceAvailable: boolean;
};
~~~

Options must be filtered to the selected hotel and date. A room_type_id alone is not sufficient for final pricing; the server must resolve a concrete available dvi_hotel_rooms.room_ID.

## 6. Save and price recalculation

Changing a dropdown calls:

~~~text
GET engine/ajax/ajax_latest_manage_itineary.php?type=show_modify_hotel_room_type_form
POST engine/ajax/ajax_latest_manage_itineary.php?type=confirm_modify_itineary_plan_hotel_room_type
~~~

Payload:

~~~text
itinerary_plan_hotel_details_ID
itinerary_plan_hotel_room_details_ID
itinerary_plan_id
itinerary_route_id
group_type
hotel_id
choosen_room_type
~~~

The fields removed from the recommended Nest/React payload are legacy PHP meal flags. Do not send all_meal_plan, breakfast_meal_plan, lunch_meal_plan, or dinner_meal_plan as zero values when changing only a room category. That would risk replacing the selected CP/EP/MAP package with an incorrect meal state.

Authoritative current branch: engine/ajax/ajax_latest_manage_itineary.php:29151-29730.

### PHP sequence

1. Load the target child row using plan, route, child ID, and group_type.
2. Resolve an available concrete room_ID for hotel and chosen room type.
3. Reject if no room is available.
4. Resolve the route-date room pricebook rate.
5. Reject if no positive pricebook rate exists.
6. Resolve the selected meal-plan package code (CP, EP, or MAP) and its included meal rates from the itinerary/rate option.
7. Resolve extra-bed and child-bed rates.
8. Calculate the meal cost for the existing package using the itinerary food count, divided by preferred room count when there is more than one room. Do not let a room-category change alter the package.
9. Calculate room rate times room_qty.
10. Calculate inclusive or exclusive GST.
11. Update the child row.
12. Aggregate all active child rows for the same plan, route, and group_type.
13. Recalculate and update the parent hotel row.
14. Refresh the active group and overall cost.

Relevant source: ajax_latest_manage_itineary.php:29336-29464. Parent aggregation is around 29467-29715.

Relevant PHP helpers:

~~~php
getHOTELMEAL_PRICEBOOK_DETAILS(...)
getROOMBED_PRICEBOOK_DETAILS_WITH_ROOMTYPE(...)
getROOM_PRICEBOOK_DETAILS_WITH_ROOMTYPE(...)
~~~

### Cost formulas

~~~text
roomCost = roomRatePerNight * roomQty

mealCost = selectedMealRatePerPerson
         * foodRequiredCountPerRoom
         * roomQty

extraBedCost        = extraBedRate        * extraBedCount
childWithBedCost    = childWithBedRate    * childWithBedCount
childWithoutBedCost = childWithoutBedRate * childWithoutBedCount
~~~

For inclusive GST, PHP derives the tax portion from the stored total and subtracts it from the amount. For exclusive GST, it keeps the amount and adds the calculated tax. Meal-plan inclusion is derived from the fixed package code; it is not selected with separate Breakfast/Lunch/Dinner checkboxes in the target UI.

Use decimal-safe money calculations in Nest. Recalculate parent totals from child rows; never trust browser-sent totals.

## 7. Suggested NestJS API

Use route names consistent with the existing itinerary module, but keep these responsibilities separate.

### Load recommendations

~~~http
GET /itineraries/:planId/hotel-recommendations
~~~

~~~json
{
  "planId": 51384,
  "preferredRoomCount": 5,
  "activeGroupType": 1,
  "groups": [
    {
      "groupType": 1,
      "label": "Recommended #1",
      "hotelTotal": 88957.31,
      "days": []
    }
  ]
}
~~~

Build tabs from distinct stored group types. Do not hard-code [1, 2, 3, 4] unless it is a business rule.

### Load one group

~~~http
GET /itineraries/:planId/hotel-recommendations/:groupType
~~~

Return parent hotel rows for that group, ordered by route date, with selected hotel and room summary. Scope every query by planId and groupType.

### Load candidate hotels

~~~http
GET /itineraries/:planId/hotel-recommendations/:groupType/routes/:routeId/candidates
~~~

Return nearby active hotels, availability, lowest date rate, room types, images, and selected state. Apply distance and preferred-room-count rules in the service.

### Load room slots

~~~http
GET /itineraries/:planId/hotel-details/:hotelDetailsId/room-slots
~~~

Return one slot per existing child row and pad to the preferred count:

~~~json
{
  "preferredRoomCount": 5,
  "hotelId": 123,
  "groupType": 1,
  "slots": [
    {
      "slot": 1,
      "roomDetailId": 9001,
      "roomQty": 1,
      "roomTypeId": 10,
      "roomTypeLabel": "DELUXE - Deluxe",
      "options": []
    }
  ]
}
~~~

### Change one room category

~~~http
PATCH /itineraries/:planId/hotel-room-details/:roomDetailId/room-type
~~~

~~~json
{
  "groupType": 1,
  "hotelDetailsId": 7001,
  "hotelId": 123,
  "routeId": 44,
  "roomTypeId": 10
}
~~~

Verify server-side that the child belongs to the supplied plan, group, parent hotel, route, and hotel. Update the child, aggregate parent, group total, and overall total in one transaction. Return all updated totals so React does not display stale values.

The response may include the unchanged meal plan for display:

~~~json
{
  "mealPlanCode": "CP",
  "mealPlanLabel": "Continental Plan",
  "roomTypeId": 10
}
~~~

The request must not contain a meal-plan editor for this interaction.

## 8. React state and components

Suggested hierarchy:

~~~text
ItineraryGeneratePage
  └─ HotelRecommendations
       ├─ RecommendationTabs
       ├─ RecommendationSummary
       └─ HotelDayTable
            └─ HotelDayRow
                 └─ HotelCandidatesPanel
                      └─ HotelCard
                           └─ RoomCategoryModal
                                └─ RoomCategoryRow
~~~

Suggested state:

~~~ts
const [activeGroupType, setActiveGroupType] = useState(1);
const [expandedHotelDetailsId, setExpandedHotelDetailsId] = useState<number | null>(null);
const [roomSlots, setRoomSlots] = useState<RoomSlot[]>([]);
const mealPlanCode: 'CP' | 'EP' | 'MAP' = selectedRateOption.mealPlanCode;

type RoomSlotDraft = {
  slot: number;
  roomDetailId: number | null;
  roomQty: number;
  roomTypeId: number | null;
};
~~~

Do not store one selectedRoomTypeId for the whole hotel. Use an array keyed by roomDetailId or temporary slot key.

When the modal opens:

1. Fetch the active parent hotel details.
2. Fetch existing child rows for active groupType.
3. Sort rows by ID.
4. Pad to preferredRoomCount.
5. Render one select per slot.

When a row changes, update only that row. The five Deluxe rows in the screenshot are five independent selections, not one quantity field.

Meal-plan UI rule:

- Show the current code (`CP`, `EP`, or `MAP`) as a read-only badge/value on the hotel card or day row.
- Do not render All, Breakfast, Lunch, or Dinner checkboxes in the hotel-card or room-category flow.
- Do not include mealPlan in the room-category PATCH body.
- Preserve the existing meal-plan code and its backend-derived pricing while changing room type.

After a successful update:

1. Close the confirmation modal.
2. Refresh the active group's day table/candidate selection.
3. Refresh the recommendation tab total.
4. Refresh the overall trip total.

## 9. Security and data integrity

The PHP endpoint accepts many IDs from query strings. The Nest implementation should:

- derive plan, group, route, hotel, and parent relationships from authorized database records;
- never trust client price, tax, availability, or total values;
- validate the room type belongs to the hotel and has a date pricebook entry;
- validate availability for the requested quantity;
- use a transaction for child update and parent aggregation;
- apply status/deleted filters;
- prevent cross-group child updates;
- enforce itinerary authorization;
- return structured errors for unavailable rooms and missing pricebook entries.

## 10. PHP source map

| Concern | PHP source |
|---|---|
| Route shell and AJAX step-2 load | latestitinerary.php:367-418 |
| Step-2 and initial group context | ajax_latest_itineary_step2_form.php:20-26,80-102 |
| Initial hotel AJAX load | ajax_latest_itineary_step2_form.php:1255-1259,1552-1565 |
| Recommendation tabs and group totals | engine/ajax/ajax_latest_itineary_hotel_details.php:50-79 |
| Active group hotel/day table | engine/ajax/ajax_show_recommended_hotel_details_form.php:18-29,56-75 |
| Expanded hotel candidate cards | engine/ajax/ajax_itineary_hotel_roomdetails.php:20-42,55-156 |
| Room-category modal | engine/ajax/ajax_latest_itineary_hotel_multiple_rooms.php:15-79 |
| Room dropdown request | engine/ajax/ajax_latest_itineary_hotel_multiple_rooms.php:90-107 |
| Confirmation dialog | engine/ajax/ajax_latest_manage_itineary.php:29151-29243 |
| Validation and child update | engine/ajax/ajax_latest_manage_itineary.php:29307-29465 |
| Parent aggregation | engine/ajax/ajax_latest_manage_itineary.php:29467-29715 |
| Group-scoped cost helpers | controller/core/sql_functions.php:11448-12014 |
| React rate-option meal-plan display | dvi_frontend/src/components/hotels/HotelSearchResultCard.tsx:181-184,209-214 |
| React room-category-only modal | dvi_frontend/src/components/hotels/HotelRoomSelectionModal.tsx:192-208 |
| Nest Prisma models | api.dvi.travel/prisma/schema.prisma:3404-3687,3939-4162 |

## Acceptance checklist

- [ ] Initial page opens with groupType 1 when available.
- [ ] Tabs come from distinct persisted group types.
- [ ] Tab and overall totals are scoped to active group.
- [ ] Hotel rows are ordered by route date.
- [ ] Candidates are scoped to active day and group.
- [ ] Candidate search applies active/deleted, date-rate, distance, and availability rules.
- [ ] Selected hotel is visibly distinct.
- [ ] Hotel cards display the fixed meal-plan code (CP, EP, or MAP); no Breakfast/Lunch/Dinner controls are shown.
- [ ] Room modal displays one row per requested room.
- [ ] Existing rows are shown before padded empty slots.
- [ ] Every room row can select a different room category.
- [ ] A room save updates only the targeted child row.
- [ ] A room-category save preserves the existing meal-plan code and package pricing.
- [ ] Rates, meals, beds, children, GST, parent totals, group totals, and overall totals are recalculated server-side.
- [ ] Switching groups never leaks another group's rows.
- [ ] Unavailable room types and missing pricebook entries return clear errors.
