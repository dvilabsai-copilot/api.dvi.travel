# Itinerary Vehicle Create Flow

This document describes the current NestJS vehicle build flow for itinerary creation and edit, so a future AI agent can safely debug or extend it without breaking hotel, hotspot, or pricing parity.

## What This Flow Must Preserve

- Vehicle calculation and day-wise pricing must stay aligned with PHP parity.
- Hotel building logic must not be changed here.
- Hotspot auto/manual logic must not be changed here.
- Vehicle rows must be created for every itinerary day that PHP expects to show in the timeline, including outstation hotel-stay days with 0 km.

## Main Entry Points

- `src/modules/itineraries/itineraries.controller.ts`
- `src/modules/itineraries/itineraries.service.ts`
- `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
- `src/modules/itineraries/engines/hotspot-engine.service.ts`
- `src/modules/itineraries/engines/vehicles-engine.service.ts`

## End-to-End Build Order

1. The itinerary save/update request reaches the itineraries service.
2. Route rows are created or updated.
3. Vehicle eligibility rows are built for all eligible vendors.
4. Vehicle detail rows are generated day by day into `dvi_itinerary_plan_vendor_vehicle_details`.
5. Hotel rows are generated separately by the hotel engine.
6. Hotspots are generated separately by the hotspot engine.
7. After vehicle detail rows exist, eligible vendor totals are recalculated from those rows.
8. The itinerary details API reads the persisted rows and renders the UI.

## Vehicle Detail Generation

The critical builder is `itinerary-vehicles.engine.ts`.

### Key tables

- `dvi_itinerary_plan_vendor_eligible_list`
- `dvi_itinerary_plan_vendor_vehicle_details`
- `dvi_itinerary_plan_vehicle_details`

### How rows are created

- The engine loops through every eligible vendor.
- For each route/day it runs the pricing calculation helper.
- It builds a `detailsData` payload for that day.
- The payload is buffered in `pendingVehicleDetailCreates`.
- Buffered rows are deduped with `buildVehicleDetailPersistenceKey`.
- The final list is inserted with `createMany`.
- Duplicate persisted rows are removed with `cleanupDuplicateVehicleDetailRows`.

### Important row-preservation rule

- Outstation rows must not be dropped just because `vehicle_cost_for_the_day` is zero.
- Some outstation days are hotel-stay days with 0 km.
- PHP keeps those rows visible in the trip timeline.
- The current Nest fix preserves those rows by allowing all outstation rows through the zero-cost guard.
- Local hotel-stay rows where `location_name` equals `next_visiting_location` must also be preserved.
- Those rows often have zero cost and zero or near-zero km, but they still represent real itinerary days in PHP.

## Detail API Read Path

`GET /api/v1/itineraries/details/:quoteId` reads the vendor vehicle details and formats:

- vendor name
- origin
- day-wise pricing
- toll breakdown
- parking breakdown
- total days
- total amount

If the persisted detail rows are missing, the API cannot reconstruct them correctly.

## Known Safe Zones

Do not change these unless the task explicitly requires it:

- hotel building and hotel fetch flow
- hotspot auto/manual selection logic
- route family quote generation unless the bug is in route creation itself
- confirmed itinerary parity unless the issue is in confirmed-specific data

## Debugging Checklist

When a vendor shows fewer rows than expected:

1. Check the source rows in `dvi_itinerary_plan_vendor_vehicle_details`.
2. Compare `itinerary_plan_vendor_eligible_ID` counts across vendors.
3. Check whether the missing rows were skipped by the zero-cost guard.
4. Check whether `dedupeBufferedRows` or `cleanupDuplicateVehicleDetailRows` collapsed valid rows.
5. Compare the result with PHP for the same plan and route family.

## Recent Regression Note

PR `#255` changed the vehicle calculation flow and introduced a stricter zero-cost route guard. That guard must not remove outstation hotel-stay days, or vendor day counts will shrink from the PHP baseline.

## Expected Outcome

For a transportation + hotel itinerary, vehicle details should remain stable across reloads and route switches:

- same route count
- same vendor count
- same day-wise pricing rows
- same hotel/hotspot behavior
