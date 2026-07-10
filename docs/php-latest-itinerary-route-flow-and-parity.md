# PHP Latest Itinerary Route Flow And Nest/React Parity Notes

## Scope

This note traces the route-creation flow behind the legacy B2B PHP screen:

- PHP legacy app: `C:\wamp64\www\dvi_b2b`
- Nest API: `C:\wamp64\www\dvi_fullstack\api.dvi.travel`
- React app: `C:\wamp64\www\dvi_fullstack\dvi_frontend`

The screenshots match the `latestitinerary.php` flow, not the older `itinerary.php` / `newitinerary.php` flow.

The goal is to help another AI agent implement PHP parity in Nest + React without breaking the existing hotspot engines, especially:

- auto hotspot generation
- manual hotspot insertion / fit-here logic
- route time patch logic

## Hard Guardrails

The implementation agent should treat these areas as frozen unless there is a separate explicit approval:

- hotel building
- vehicle calculations / vehicle cost logic / vehicle assignment math
- hotspot auto-build logic
- hotspot manual insertion / fit-here / rescue logic

Allowed work for parity should stay focused on:

- create/edit payload parity
- route-family and quote-family parity
- sibling-route persistence and retrieval
- UI field parity
- orchestration differences around save flow

## 1. Legacy PHP End-To-End Flow

### 1.1 Entry page and step routing

Main entry:

- `dvi_b2b/latestitinerary.php`

Behavior:

- `latestitinerary.php?route=&formtype=` loads the latest itinerary list through `engine/ajax/ajax_latest_itinerary_list.php?type=show_form`
- `latestitinerary.php?route=add|edit&formtype=basic_info&id=...` loads step 1 through `engine/ajax/ajax_latest_itineary_step1_form.php?type=show_form`
- `latestitinerary.php?route=add|edit&formtype=generate_itinerary&id=...` loads step 2 through `engine/ajax/ajax_latest_itineary_step2_form.php?type=show_form&selected_group_type=1`

Special note:

- `latestitinerary.php?regen=y` only does `session_regenerate_id(TRUE)`; it is not business logic by itself.

### 1.2 Step 1: Basic info + route matrix + vehicles + travellers

Step 1 renderer:

- `dvi_b2b/engine/ajax/ajax_latest_itineary_step1_form.php`

This screen collects or shows:

- itinerary preference: Vehicle / Hotel / Both
- agent
- arrival and departure
- trip start/end date and time
- itinerary type
- arrival type / departure type
- budget
- guide flag
- nationality
- pickup datetime
- special instructions
- adults / children / infants / room-wise traveller details
- route rows
- via-route editing
- vehicle rows

Important route behaviors in step 1:

- Existing plan:
  - route rows are loaded from `dvi_itinerary_route_details`
  - via-route button opens `ajax_latest_itineary_via_route_form.php`
- New plan:
  - if itinerary type is default/suggested, PHP can render multiple route tabs from stored route templates
  - if itinerary type is customize, PHP shows one editable route table

Default route suggestion source:

- `dvi_b2b/engine/ajax/ajax_latest_itineary_default_route_suggestions_latest.php`

Data source:

- `dvi_stored_routes`
- `dvi_stored_route_location_details`
- base `location_id` comes from `getSTOREDLOCATION_ID_FROM_SOURCE_AND_DESTINATION(arrival, departure)`

Selection rule:

- only stored routes with enough location rows for the requested day count are considered
- up to 5 route suggestions are returned
- the last leg is forced to the chosen departure location

### 1.3 Step 1 submit flow

The form submit in `ajax_latest_itineary_step1_form.php` does this:

1. Validate the form.
2. Show a modal from `ajax_latest_manage_itineary.php?type=optimize_itineary_route`.
3. User chooses:
   - same route -> `type=itineary_basic_info`
   - optimize route -> `type=itineary_basic_info_with_optimized_route`
4. The form is posted to `engine/ajax/ajax_latest_manage_itineary.php`.

### 1.4 PHP save handler: what really gets written

Main save handler:

- `dvi_b2b/engine/ajax/ajax_latest_manage_itineary.php`

Two main branches:

- `type=itineary_basic_info_with_optimized_route`
- `type=itineary_basic_info`

Both branches eventually persist the same shape of data. The optimized branch first reorders route rows.

#### Header/plan persistence

Primary table:

- `dvi_itinerary_plan_details`

Stored fields include:

- preference
- arrival/departure
- trip start/end datetime
- arrival/departure type
- nights/days
- budget
- itinerary type
- entry ticket flag
- pax totals
- guide flag
- room/extra-bed/child-bed totals
- food type
- nationality
- meal flags
- special instructions
- pickup datetime
- agent/staff
- quote id

#### Route persistence

Primary table:

- `dvi_itinerary_route_details`

Each route row stores:

- `location_id`
- `location_name`
- `itinerary_route_date`
- `no_of_days`
- `no_of_km`
- `direct_to_next_visiting_place`
- `next_visiting_location`
- `route_start_time`
- `route_end_time`

#### Via-route persistence

Primary table:

- `dvi_itinerary_via_route_details`

Separate AJAX handler:

- `type=add_via_route`
- `type=remove_via_route`

PHP stores via routes either:

- against a persisted `itinerary_plan_ID` + `itinerary_route_ID`, or
- temporarily by `itinerary_session_id` before the plan exists

#### Vehicle persistence

Primary table:

- `dvi_itinerary_plan_vehicle_details`

After basic-info save, PHP also triggers:

- `engine/ajax/ajax_latest_itineary_manage_vehicle_details.php?type=add_vehicle_plan`

That means PHP tries to have transport-side plan rows ready before the final redirect.

#### Traveller persistence

Primary table:

- `dvi_itinerary_traveller_details`

PHP writes travellers room-by-room:

- adults
- children
- infants
- child age
- child bed type

#### Hotel-side cleanup / rebuild behavior

Related tables:

- `dvi_itinerary_plan_hotel_details`
- `dvi_itinerary_plan_hotel_room_details`
- `dvi_itinerary_plan_hotel_room_amenities`

PHP conditionally deletes or retains hotel data depending on:

- itinerary preference changes
- route date / route id changes
- full new create vs existing update

#### Guide-side cleanup / rebuild behavior

Related tables:

- `dvi_itinerary_route_guide_details`
- `dvi_itinerary_route_guide_slot_cost_details`

#### Hotspot / activity / entry-cost / parking rebuild

Core route timeline table:

- `dvi_itinerary_route_hotspot_details`

Related tables:

- `dvi_itinerary_route_activity_details`
- `dvi_itinerary_route_hotspot_entry_cost_details`
- `dvi_itinerary_route_activity_entry_cost_details`
- `dvi_itinerary_route_hotspot_parking_charge`

This is the important part:

- PHP basic-info save is not only a header save
- it also rebuilds route-level sightseeing/travel timeline data
- it recalculates route end times when required
- it inserts or updates travel segments, hotspot visit segments, return-to-hotel/departure segments, and entry-cost rows

So the legacy save is an orchestration flow, not a thin CRUD call.

### 1.5 PHP route optimization behavior

In `ajax_latest_manage_itineary.php`:

- for up to 10 route legs, PHP tries exhaustive permutations
- above 10 route legs, PHP switches to nearest-neighbor plus simulated annealing
- start and end stay fixed
- distances come from `dvi_stored_locations`

### 1.6 PHP multi-route family behavior

This is one of the most important legacy behaviors.

For a new create with multiple suggested route tabs:

- PHP inserts multiple `dvi_itinerary_plan_details` rows in one submit
- one shared base quote is created
- quotes are suffixed as:
  - `DVI...-R1`
  - `DVI...-R2`
  - `DVI...-R3`
  - etc.

Code evidence:

- `ajax_latest_manage_itineary.php`
- branch where `$inserted_itineries = []`
- `$_POST['total_route_tabs']`
- quote suffix assignment with `-R$route_count`

The response returns:

- `inserted_itineries`

Step 2 then shows sibling route tabs by querying plans that share the same base quote prefix.

### 1.7 Step 2: generated itinerary screen

Renderer:

- `dvi_b2b/engine/ajax/ajax_latest_itineary_step2_form.php`

This screen reads:

- plan header
- agent margin / hotel margin / vehicle margin
- guide totals
- routes
- hotspots and timeline data
- special instructions
- overall trip cost

It also shows sibling route tabs by finding other plan rows that belong to the same route family.

## 2. Current Nest/React Flow

### 2.1 React create flow

Main files:

- `dvi_frontend/src/pages/CreateItinerary/CreateItinerary.tsx`
- `dvi_frontend/src/pages/CreateItinerary/ItineraryPlanBlock.tsx`
- `dvi_frontend/src/pages/CreateItinerary/RouteDetailsBlock.tsx`
- `dvi_frontend/src/pages/CreateItinerary/ViaRouteDialog.tsx`
- `dvi_frontend/src/components/DefaultRoutesSuggestions.tsx`
- `dvi_frontend/src/services/itinerary.ts`

Current frontend flow:

1. User fills one consolidated React form.
2. Suggested/default routes come from:
   - `POST /itineraries/default-route-suggestions/v2`
3. Save confirm modal lets the user choose:
   - same route
   - optimize route
4. Frontend posts to:
   - `POST /itineraries?type=itineary_basic_info`
   - or `POST /itineraries?type=itineary_basic_info_with_optimized_route`
5. Frontend redirects to `/itinerary-details/:quoteId`

### 2.2 Nest save orchestration

Main files:

- `api.dvi.travel/src/modules/itineraries/itineraries.controller.ts`
- `api.dvi.travel/src/modules/itineraries/itineraries.service.ts`
- `api.dvi.travel/src/modules/itineraries/engines/plan-engine.service.ts`
- `api.dvi.travel/src/modules/itineraries/engines/route-engine.service.ts`
- `api.dvi.travel/src/modules/itineraries/engines/via-routes.engine.ts`
- `api.dvi.travel/src/modules/itineraries/engines/travellers-engine.service.ts`
- `api.dvi.travel/src/modules/itineraries/engines/hotel-engine.service.ts`
- `api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts`

Current backend save flow in `ItinerariesService.createPlan()`:

1. optionally optimize route order
2. validate hotel availability when needed
3. upsert plan header
4. delete/rebuild routes
5. rebuild permit charges
6. rebuild via routes
7. rebuild travellers
8. rebuild hotels
9. rebuild route hotspots
10. rebuild parking charges
11. start vehicle build in background for vehicle/both itineraries

This is already very close to the legacy PHP orchestration model.

### 2.3 Nest strengths already in place

Already implemented in Nest:

- route optimization endpoint parity
- stored default route suggestions
- route rebuild
- via-route rebuild
- hotel rebuild
- hotspot rebuild
- manual hotspot preview/apply flows
- route time patch endpoint:
  - `PATCH /itineraries/:id/route/:routeId/times`

That route-time patch flow is already cleaner than PHP and should be preserved.

## 3. Current Gaps And Mismatches

These are the gaps that matter most for parity.

### Gap 1: React does not expose a separate pickup datetime

PHP:

- basic-info screen has a dedicated `pick_up_date_and_time` field

React:

- there is no pickup field in `ItineraryPlanBlock.tsx`
- `CreateItinerary.tsx` hardcodes:
  - `pick_up_date_and_time = tripStartDate + startTime`

Impact:

- Nest cannot receive a user-edited pickup datetime
- vehicle timing and any pickup-based logic cannot fully match PHP

### Gap 2: React sends the wrong `departure_type`

In `CreateItinerary.tsx`, the payload currently uses:

- `departure_type: arrivalType ? Number(arrivalType) : 0`

instead of using `departureType`.

Impact:

- PHP allows arrival type and departure type to differ
- React/Nest currently collapse them accidentally

This is a real parity bug, not just a missing enhancement.

### Gap 3: Multi-route family is not persisted as a backend concept

PHP:

- one submit can create all suggested route variants
- sibling plans share one base quote family with `-R1`, `-R2`, etc.
- step 2 can rediscover siblings from the database later

React/Nest today:

- frontend loops and calls `POST /itineraries` once per suggested route
- each plan gets an independent quote id from `PlanEngineService.buildSafeQuoteId()`
- sibling route relationships are then stored only in browser `localStorage`

Impact:

- route siblings are not a durable backend feature
- route tabs can disappear on a fresh browser/device/session
- latest-itinerary and itinerary-details pages cannot reliably rediscover sibling routes from server data

### Gap 4: Backend itinerary-details response does not publish sibling route options

React details page looks for:

- `routeOptions`
- `suggestedRoutes`
- `siblingRoutes`

from the API response, then falls back to `localStorage`.

Current backend:

- does not return sibling route metadata from `itinerary-details.service.ts`

Impact:

- route-switch UI depends on local browser state
- PHP parity is incomplete for route family browsing

### Gap 5: React edit flow drops backend row identity

Nest DTO supports:

- `plan.itinerary_plan_id`
- `routes[].itinerary_route_id`
- `vehicles[].vehicle_details_id`

React edit load does fetch routes and vehicles, but the local state types only keep:

- route UI id
- vehicle UI id

not:

- `itinerary_route_id`
- `vehicle_details_id`

Impact:

- updates behave like full rebuilds only
- row identity cannot be preserved or targeted from the client
- this makes parity with PHP edit semantics weaker, especially for future partial-save behavior

### Gap 6: Vehicle build timing differs from PHP

PHP:

- creates downstream vehicle plan rows before final redirect

Nest:

- starts vehicle build after the main transaction and returns immediately

Impact:

- itinerary-details may load before transport-side build is complete
- user can briefly see partial transport state

This may be acceptable architecturally, but it is not full PHP parity.

### Gap 7: PHP route-family quote suffixes are missing

PHP family format:

- base quote
- `-R1`, `-R2`, `-R3`

Nest today:

- every created suggestion gets a standalone sequential quote id

Impact:

- users and admins lose the obvious visual grouping that exists in PHP
- sibling discovery becomes much harder

## 4. Safe Parity Plan

The safest parity plan is to change orchestration and data contracts, not hotspot scheduling internals.

### 4.1 Do not touch these engines first

Avoid changing these until route-family/input parity is done:

- hotel build engines and hotel pricing/build selection behavior
- vehicle calculation/build engines and permit/transport calculation behavior
- `src/modules/itineraries/engines/hotspot-engine.service.ts`
- `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- `src/modules/itineraries/helpers/manual-fit-here*.ts`
- manual hotspot controller/service flows
- route time patch flow

Reason:

- hotel building and vehicle calculation behavior are already considered correct and should be preserved
- these already contain a lot of production-specific auto/manual hotspot behavior
- route creation parity can be achieved mostly above this layer

### 4.2 Phase 1: Fix payload parity in React

Implement first:

1. Add a dedicated pickup datetime UI field in `ItineraryPlanBlock.tsx`.
2. Send that real value as `pick_up_date_and_time`.
3. Fix `departure_type` to use `departureType`.
4. Preserve backend ids in create/edit state:
   - `itinerary_route_id`
   - `vehicle_details_id`
   - optionally traveller detail ids if needed later

These are low-risk and do not affect hotspot engines.

### 4.3 Phase 2: Move multi-route family creation to Nest

Recommended design:

- add a dedicated backend orchestration endpoint for "create all suggested route variants"
- backend should:
  - create one route family id or one shared base quote
  - create all sibling plans in one controlled flow
  - assign suffixes consistently
  - return the full sibling route list

Do not keep this as a frontend-only loop.

Suggested output shape:

- `primaryQuoteId`
- `routeOptions: [{ quoteId, label, planId, routeIndex }]`
- maybe `routeFamilyKey`

### 4.4 Phase 3: Persist route-family metadata in DB

Best options:

Option A:

- add a new route-family table

Example fields:

- `route_family_id`
- `base_quote_id`
- `itinerary_type`
- `created_plan_id`
- `createdby`

and on plan rows:

- `route_family_id`
- `route_variant_index`

Option B:

- keep PHP-style quote suffixes and derive family from base quote

If choosing Option B, be strict:

- one base quote
- suffixes `-R1...-Rn`
- details/list endpoints should be able to query siblings from DB alone

### 4.5 Phase 4: Return sibling route options from backend details/list APIs

Add sibling route metadata to:

- itinerary details response
- latest itinerary list response if useful

Then React should stop depending on `localStorage` as the source of truth.

### 4.6 Phase 5: Decide whether vehicle build must block redirect

If strict PHP parity is required:

- wait until vehicle build reaches a ready state before redirecting to details

If current async behavior is preferred:

- keep async build
- but expose a strong build-status contract and a clear loading state in details

## 5. Recommended Implementation Order

1. Fix React payload mismatches:
   - pickup datetime
   - departure type
   - edit ids
2. Add backend route-family persistence and sibling discovery.
3. Replace frontend localStorage sibling-route hack with API-driven route options.
4. Only after that, revisit transport readiness behavior if users still feel a parity gap.

## 6. Practical Mapping For Another AI Agent

### Legacy PHP files to study first

- `dvi_b2b/latestitinerary.php`
- `dvi_b2b/engine/ajax/ajax_latest_itineary_step1_form.php`
- `dvi_b2b/engine/ajax/ajax_latest_itineary_step2_form.php`
- `dvi_b2b/engine/ajax/ajax_latest_manage_itineary.php`
- `dvi_b2b/engine/ajax/ajax_latest_itineary_default_route_suggestions_latest.php`
- `dvi_b2b/engine/ajax/ajax_latest_itineary_via_route_form.php`

### Nest files to modify first

- `api.dvi.travel/src/modules/itineraries/itineraries.controller.ts`
- `api.dvi.travel/src/modules/itineraries/itineraries.service.ts`
- `api.dvi.travel/src/modules/itineraries/engines/plan-engine.service.ts`
- optionally a new route-family service/module

### React files to modify first

- `dvi_frontend/src/pages/CreateItinerary/CreateItinerary.tsx`
- `dvi_frontend/src/pages/CreateItinerary/ItineraryPlanBlock.tsx`
- `dvi_frontend/src/pages/CreateItinerary/helpers/useItineraryRoutes.ts`
- `dvi_frontend/src/pages/ItineraryDetails.tsx`
- `dvi_frontend/src/services/itinerary.ts`

## 7. Final Guidance

To match PHP safely, treat the problem as:

- create/edit form parity
- route-family persistence parity
- server-driven sibling-route discovery parity

Do not start by changing:

- hotel building
- vehicle calculations
- hotspot scheduling rules
- hotspot manual insertion logic

The hotspot stack in Nest is already richer than PHP and already contains manual-fit protections. The safest path is to feed it the same route/plan inputs and route-family metadata that PHP has, rather than rewriting the hotspot engine itself.
