# Itinerary Timeline System - Intern Architecture Guide v0.1

This is a living guide for interns and engineers working on the DVI itinerary timeline system. Future itinerary refactors must update this file when behavior, row contracts, or API shapes change. [Inference]

Evidence baseline:

- Main timeline case study: `DVI2026042 / PLAN_ID=48`. [Verified from DB/script output]
- Direct ON live replay case study: `DVI20260594 / PLAN_ID=410`. [Verified from live replay]

## 1. Purpose of the Itinerary System

The itinerary system turns a quote into a day-by-day travel plan with route rows, hotel rows, vehicle pricing rows, and a visible timeline of starts, travel legs, attractions, breaks, hotel check-ins, and final drop-off. [Verified from code]

Business users interact with the system through create/edit screens, details pages, hotel selection, vehicle selection, manual hotspot controls, confirmation, and cancellation flows. [Verified from code]

The important split is this: the timeline builder selects and schedules rows, while the details API reads persisted rows and maps them into frontend `days[].segments[]`. [Verified from code]

## 2. Big Picture Flow

The high-level flow is:

```text
Frontend request
-> ItinerariesController
-> ItinerariesService
-> route/via/hotel/vehicle/hotspot engines
-> HotspotEngineService
-> TimelineBuilder
-> dvi_itinerary_route_hotspot_details
-> ItineraryDetailsService.getItineraryDetails()
-> frontend days[].segments[]
```

`ItinerariesController` is the HTTP layer, `ItinerariesService` orchestrates most lifecycle actions, `HotspotEngineService` wraps timeline rebuild persistence, `TimelineBuilder` builds row arrays, and `ItineraryDetailsService.getItineraryDetails()` maps persisted rows into frontend-ready segments. [Verified from code]

## 3. Main Backend Files and Responsibilities

| File | Responsibility | Important methods | Confidence | Notes |
| --- | --- | --- | --- | --- |
| `src/modules/itineraries/itineraries.controller.ts` | HTTP surface for create/update, details, rebuild, hotel, vehicle, manual hotspot, activity, confirmation, and cancellation routes. | Controller route handlers such as `createPlan()`, `getItineraryDetails()`, `rebuildRoute()`, `updateRouteTimes()`, `confirmQuotation()`, `cancelItinerary()`. | High | [Verified from code] Controller mostly delegates to services. |
| `src/modules/itineraries/itineraries.service.ts` | Main itinerary orchestration layer. | `createPlan`, `rebuildRouteHotspotsForDay`, `updateRouteTimes`, `previewManualHotspotsBatch`, `addManualHotspot`, `applyManualHotspotsBatch`, `removeManualHotspot`, `selectHotel`, `bulkSaveHotels`, `selectVehicleVendor`, `selectVehicleSlab`, `autoSelectVehicleSlabs`, `confirmQuotation`, `prebookHotels`, `cancelItinerary`. | High | [Verified from code] Reads/writes plan, route, hotspot, hotel, vehicle, confirmation, wallet, and cancellation tables through service flows. |
| `src/modules/itineraries/engines/helpers/timeline.builder.ts` | Builds the in-memory timeline from routes, hotspots, timing, hotels, vehicles, and via data. | `buildTimelineForPlan(...)`. | High | [Verified from code] Returns `{ hotspotRows, parkingRows, routeRejectionSummaryByRoute }`; it does not persist rows itself. |
| `src/modules/itineraries/engines/hotspot-engine.service.ts` | Transactional hotspot rebuild and manual hotspot preview wrapper. | `rebuildRouteHotspots`, `rebuildParkingCharges`, `previewManualHotspotAdd`. | High | [Verified from code] Deletes old rows, protects manual rows, calls `TimelineBuilder`, and persists returned rows. |
| `src/modules/itineraries/itinerary-details.service.ts` | Maps persisted plan/route/hotspot/hotel/vehicle data into the frontend details payload. | `getPlanIdFromQuoteId`, `getItineraryDetails`, `getLatestItinerariesDataTable`, `findOne`, `findOneOld`. | High | [Verified from code] Returns `days[]`, `vehicles[]`, package notes, and cost breakdown. |
| `src/modules/itineraries/engines/itinerary-vehicles.engine.ts` | Rebuilds eligible vendor list and vehicle pricing rows. | `rebuildEligibleVendorList`. | High | [Verified from code] Uses vehicle, vendor, slab, toll, permit, parking, route, and location data. |
| `src/modules/itineraries/engines/vehicle-calculation.helpers.ts` | Low-level vehicle distance, toll, permit, parking, and slab helper logic. | `calculateVehicleTollCharges`, `calculatePermitCharges`, `getKmsLimitId`, `getTimeLimitId`, `calculateSightseeingKm`, `calculateRouteVehicleDetails`. | High | [Verified from code] Used by vehicle build and details/route cost flows. |
| `src/modules/itineraries/itinerary-hotel-details-tbo.service.ts` | Hotel details/package/room response layer with provider/cache support. | `getHotelDetailsByQuoteIdFromTbo`, `getHotelRoomDetailsFromTbo`, `clearHotelCacheForQuote`, `clearCacheForQuote`. | High | [Verified from code] Used by hotel endpoints and details fallback naming. |
| Provider booking services | Provider-specific booking, prebooking, push, and confirmation paths. | Provider-specific methods in `TboHotelBookingService`, `ResAvenueHotelBookingService`, `HobseHotelBookingService`, `AxisRoomsBookingPushService`, and `StaahBookingPushService`. | Medium | [Verified from code] Exact provider table side effects were not fully inspected in this evidence pass. |

## 4. Main Frontend Files and Responsibilities

| File | Responsibility | Important handlers | Backend APIs called |
| --- | --- | --- | --- |
| `src/services/itinerary.ts` | Frontend service wrapper for itinerary HTTP calls. | Methods such as `create`, `update`, `getDetails`, `rebuildRouteHotspots`, `updateRouteTimes`, `previewAddHotspot`, `applyManualHotspots`, `getHotelDetails`, `selectHotel`, `prebookHotels`, `selectVehicleVendor`, `getVehicleBuildStatus`, `confirmQuotation`, `cancelItinerary`. [Verified from code] | Calls `/itineraries`, `/itineraries/details/:quoteId`, route rebuild/time endpoints, manual hotspot endpoints, activity endpoints, hotel endpoints, vehicle endpoints, confirmation endpoints, cancellation endpoints. [Verified from code] |
| `src/pages/ItineraryDetails.tsx` | Main draft/details timeline page. | Renders `day.segments.map(...)`, triggers route time updates, manual hotspot flows, hotel detail actions, vehicle build polling, and confirmation-related actions. [Verified from code] | Calls details, route rebuild/time, manual hotspot, activity, hotel, vehicle build status/rebuild, and confirmation-related APIs through `ItineraryService`. [Verified from code] |
| `src/pages/VehicleList.tsx` | Vehicle selection UI. | Vendor and slab selection handlers. [Verified from code] | Calls vehicle select-vendor/select-slab APIs through `ItineraryService`. [Verified from code] |
| `src/pages/ConfirmedItineraryDetails.tsx` | Confirmed itinerary hotel/details and cancellation-oriented UI. | Confirmed detail display and cancellation actions. [Verified from code] | Calls confirmed itinerary and cancellation APIs through `ItineraryService`. [Verified from code] |

## 5. Itinerary Create/Update Flow

`POST /itineraries` and `PUT /itineraries/:id` call `ItinerariesController.createPlan()` and delegate to `ItinerariesService.createPlan()`. [Verified from code]

The obvious request body contains `plan`, `routes`, `vehicles`, and `travellers`; the route map also records an optional `type` query string. [Verified from code]

The create/update flow persists or updates the plan header, route rows, vehicle/traveller inputs, via-route data, permit charge data, hotel-related data where provided, then schedules hotspot rebuild and vehicle build work through service/engine paths. [Verified from code]

For `DVI20260594`, the direct build script returned `vehicleBuildStatus = "PROCESSING"` after the plan and routes were created/updated, so vehicle build can run post-commit rather than being fully complete in the create response. [Verified from live replay]

## 6. Route Model and Important Fields

Routes live in `dvi_itinerary_route_details`. [Verified from code]

Important fields visible in evidence:

- `itinerary_route_ID`: route/day primary identifier, such as `3421` through `3431` for `PLAN_ID=48`. [Verified from DB/script output]
- `itinerary_plan_ID`: parent plan id, such as `48` or `410`. [Verified from DB/script output]
- `location_name`: route source/departure city or place. [Verified from DB/script output]
- `next_visiting_location`: route destination/arrival city or place. [Verified from DB/script output]
- `itinerary_route_date`: day date used for the route. [Verified from DB/script output]
- `route_start_time`: day start time, such as `08:00:00` on many `DVI2026042` routes. [Verified from DB/script output]
- `route_end_time`: day end time, such as `20:00:00` on many `DVI2026042` routes and `10:00:00` on route `3431`. [Verified from DB/script output]
- `no_of_km`: route km input, visible per route in the DB evidence. [Verified from DB/script output]
- `direct_to_next_visiting_place`: direct flag; `1` means Direct ON and `0` means Direct OFF or normal/via handling. [Verified from code]
- `via_route` and `dvi_itinerary_via_route_details`: via route data, visible on `DVI2026042` routes `3422`, `3424`, and `3426`. [Verified from DB/script output]
- `status` and `deleted`: active rows in the evidence use `status = 1` and `deleted = 0`. [Verified from DB/script output]

## 7. Timeline Rows Table

The persisted timeline table is `dvi_itinerary_route_hotspot_details`. [Verified from code]

`TimelineBuilder.buildTimelineForPlan()` returns `hotspotRows`, and `HotspotEngineService.rebuildRouteHotspots()` persists those rows into `dvi_itinerary_route_hotspot_details`. [Verified from code]

Item type mapping:

- `item_type = 1`: start row. [Verified from code]
- `item_type = 2`: city-to-city travel row, but it is absent in both `DVI2026042` and `DVI20260594` evidence. [Verified from code] [Verified from DB/script output]
- `item_type = 3`: break, via-route travel, or normal travel fallback; reports mark it as overloaded. [Verified from code]
- `item_type = 4`: attraction or hotspot visit row. [Verified from code]
- `item_type = 5`: travel-to-hotel row. [Verified from code]
- `item_type = 6`: hotel check-in / return row. [Verified from code]
- `item_type = 7`: final drop-off / return-to-departure row on the last route only. [Verified from code]

Case-study facts:

- `DVI2026042` has 110 timeline rows. [Verified from DB/script output]
- `DVI2026042` has no `item_type = 2` rows. [Verified from DB/script output]
- `DVI2026042` has `item_type = 7` only on route `3431`. [Verified from DB/script output]
- `DVI20260594` has 60 timeline rows with counts `1=5`, `3=22`, `4=22`, `5=5`, `6=5`, and `7=1`. [Verified from DB/script output]
- `item_type = 3` appears overloaded in reports because it can map to travel, break, or via-route connector behavior. [Verified from code]

## 8. Auto Hotspot Build Flow

`HotspotEngineService.rebuildRouteHotspots()` wraps timeline generation in a transaction, deletes old active rows, protects manual hotspots, calls `TimelineBuilder.buildTimelineForPlan()`, then persists returned hotspot and parking rows. [Verified from code]

`TimelineBuilder.buildTimelineForPlan()` returns `{ hotspotRows, parkingRows, routeRejectionSummaryByRoute }`. [Verified from code]

`hotspotRows` are persisted into `dvi_itinerary_route_hotspot_details`, and `parkingRows` are persisted into `dvi_itinerary_route_hotspot_parking_charge`. [Verified from code]

## 9. Hotspot Candidate Selection

The builder loads route, hotspot, timing, via-route, hotel, and vehicle context before candidate selection. [Verified from code]

Candidate buckets include source hotspots, destination hotspots, enroute hotspots, and via route candidates. [Verified from code]

Priority ordering uses `hotspot_priority`; priority `0` is not filtered out in the reported code path and is sorted toward the end. [Verified from code]

Duplicate prevention happens in multiple layers: a plan-level `addedHotspotIds` set, exact candidate dedupe by `hotspot_ID + bucket`, final row dedupe before persistence, and route-level duplicate enforcement in `HotspotEngineService`. [Verified from code]

Carry-forward exists through `carryForwardHotspots`, same-city continuation context, and `mergeCarryForwardIntoCandidates()`. [Verified from code]

The builder returns `routeRejectionSummaryByRoute`, and rejection reasons can include outside operating hours, closed day, or no remaining route window. [Verified from code]

Important boundary: final inserted hotspot evidence is proven by DB/API rows; candidate filtering evidence needs builder trace logs. Do not say a hotspot was considered and rejected unless a builder-side trace proves it. [Needs builder trace verification]

## 10. Direct ON vs Direct OFF

`direct_to_next_visiting_place = 1` is Direct ON: the route is treated as a direct handoff to the destination city, and destination hotspots can be used on that same day. [Verified from code] [Verified from live replay]

`direct_to_next_visiting_place = 0` is Direct OFF or normal behavior: source, enroute, via, and destination bucket handling follows the non-direct path. [Verified from code]

Direct ON live replay: `DVI20260594 / PLAN_ID=410`. [Verified from live replay]

- Route `3439` is Direct ON: `Cochin -> Munnar`. [Verified from live replay]
- Route `3439` has `direct_to_next_visiting_place = 1`. [Verified from DB/script output]
- Day/route `3439` uses Munnar destination hotspots: `Eravikulam National Park ( closed in Feb & Mar)`, `Munnar Rose Garden`, `spice garden munnar`, and `Photo view point`. [Verified from live replay]
- Cochin source hotspots are on route/day `3438`, not on `3439`: `Chinese Fishing net`, `Dutch Palace ( Mattancherry Palace)`, `LuLu International Shopping Mall (only for Shopping)`, `K V Kathakali center`, and `Marine Drive - Cochin`. [Verified from live replay]
- Next same-city route `3440` has a different Munnar set: `TATA Tea Museum`, `Echo Point`, `Mattupetty Dam & Lake`, `Kolukkumalai Tea Estate (Munnar)`, `Botanical Garden Munnar`, and `Blossam Hydal Park`. [Verified from live replay]

`DESTINATION_RESERVATION_DIRECT_ON_GUARD` appears in `TimelineBuilder` and logs that a direct route must use destination hotspots today rather than reserve them for the next same-city day. [Verified from code]

The live replay matches the intended guard behavior because `3439` consumes Munnar destination hotspots and `3440` has a different same-city Munnar set. [Verified from live replay]

Cheeyappara / Valara note:

- `Cheeyappara Waterfalls` was not present in the inspected live replay day data. [Verified from live replay]
- `Valara Water Falls` was not present in the inspected live replay day data. [Verified from live replay]
- The older checker script mentioning `Cheeyappara Waterfalls` as required is stale/conflicting with the live replay output. [Inference]
- Candidate-level proof still needs builder trace logs, so do not claim Cheeyappara or Valara were considered and rejected. [Needs builder trace verification]

## 11. Via Route Behavior

Via-route data comes from `dvi_itinerary_via_route_details` and can also appear in route-level `via_route` evidence. [Verified from code] [Verified from DB/script output]

`DVI2026042` via-route examples:

- Route `3422`: `Tirupati, Andhra Pradesh, India -> Vellore` via `Mahabalipuram`. [Verified from DB/script output]
- Route `3424`: `Kanchipuram, Tamil Nadu, India -> Kanchipuram, Tamil Nadu, India` via `Tiruvannamalai`. [Verified from DB/script output]
- Route `3426`: `Chennai -> Chennai` via `Mahabalipuram`. [Verified from DB/script output]

Same-city plus via route is not simple local sightseeing because the route can leave and return to the same city through an explicit intermediate place. [Inference]

In details mapping, via-route rows can become travel segments to the via location rather than attraction cards. [Verified from code]

## 12. Manual Hotspot Flow

Manual hotspots are detected with `hotspot_plan_own_way = 1`. [Verified from code]

`DVI2026042` route `3425` has the manual hotspot example: `Vivekanandar House`, `hotspot_plan_own_way = 1`, `item_type = 4`, `hotspot_order = 3`, `15:00:00 - 16:00:00`. [Verified from DB/script output]

Manual hotspot APIs include preview, apply, add, remove, available hotspot lookup, anchor-specific lookup, and matrix build endpoints. [Verified from code]

`HotspotEngineService` preserves manual hotspots before deleting active rows and passes manual placement context into `TimelineBuilder`. [Verified from code]

Manual insertion can evict lower-priority auto hotspots in the reported `CYCLE 5: MANUAL_HOTSPOT_FORCE_INSERT` path. [Verified from code]

Risk: full rebuilds are sensitive because manual rows need protection and placement parity. [Inference]

## 13. Activity Flow

Activity APIs include available activity lookup, preview, preview across all hotspots, add, smart preview, smart insert, and delete. [Verified from code]

The route map shows request fields such as `planId`, `routeId`, `routeHotspotId`, `hotspotId`, `activityId`, optional gap information, and `allowTopPriorityRemoval`. [Verified from code]

The exact DB tables and side effects for activity persistence were not deeply proven in the current evidence set. [Needs verification]

## 14. Details API Mapping

`ItineraryDetailsService.getItineraryDetails()` does not select hotspots; it reads persisted rows and maps them to frontend segments. [Verified from code]

Main reads include `dvi_itinerary_plan_details`, `dvi_confirmed_itinerary_plan_details`, `dvi_itinerary_route_details`, `dvi_itinerary_route_hotspot_details`, draft/confirmed hotel tables, hotspot master/timing/gallery tables, stored locations, and vehicle pricing tables. [Verified from code]

DB row to API/frontend meaning:

| DB row | Details API segment | Frontend display meaning |
| --- | --- | --- |
| `item_type = 1` | `type: "start"` | Start card. [Verified from code] |
| `item_type = 2` | `type: "travel"` | City-to-city travel when present. [Verified from code] |
| `item_type = 3` | `type: "travel"` or `type: "break"` or via travel | Travel, break, or via connector. [Verified from code] |
| `item_type = 4` | `type: "attraction"` | Attraction card with name, timings, description, images, and metadata. [Verified from code] |
| `item_type = 5` | `type: "travel"` | End-of-day travel to hotel context. [Verified from code] |
| `item_type = 6` | `type: "checkin"` | Hotel check-in card. [Verified from code] |
| `item_type = 7` | final `type: "travel"` | Terminal drop-off or route end. [Verified from code] |

`DVI2026042` details facts:

- DB evidence has 110 timeline rows. [Verified from DB/script output]
- Details API returned 11 days. [Verified from API output]
- Details API returned 2 vehicle rows. [Verified from API output]
- Payload is draft because `isConfirmed = false`. [Verified from API output]
- `src/pages/ItineraryDetails.tsx` renders `day.segments.map(...)`. [Verified from code]

## 15. Time Calculation and Operating Hours

Routes carry start and end times through `route_start_time` and `route_end_time`. [Verified from DB/script output]

The builder prefetches `dvi_hotspot_timing` and checks candidate fit with `checkHotspotOperatingHoursFromMap(...)`. [Verified from code]

The builder uses travel time, hotspot duration, route windows, break/free time, hotel travel/check-in timing, and final drop timing guards when assembling rows. [Verified from code]

The details API can show an attraction outside operating hours, as `DVI2026042` route `3428` shows `Anna memorial.` with an outside-operating-hours note in the API summary. [Verified from API output]

Exact operating-hours semantics for every case-study hotspot still depend on DB timing rows and builder trace logs. [Needs live DB/API verification]

## 16. KM/Distance Calculation

Timeline travel distance is the distance shown in route hotspot/travel segments. [Verified from API output]

Vehicle billing KM/pricing is stored and read from vehicle detail rows such as `dvi_itinerary_plan_vendor_vehicle_details`. [Verified from code]

The details service groups vehicle KM values by route id and keeps max observed values for `total_running_km`, `total_siteseeing_km`, and `total_travelled_km`. [Verified from code]

Vehicle build separates running KM, sightseeing KM, pickup/drop KM, extra KM, tolls, parking, permits, rental, driver, and total vehicle amount fields. [Verified from DB/script output]

`DVI2026042` vehicle facts:

- The API returned 2 vehicle rows. [Verified from API output]
- Vendor eligible rows found: 2. [Verified from DB/script output]
- Vendor/vehicle rows include `DVI-CHENNAI`, `Innova Crysta 6+1`, and `INNOVA CRYSTA 7+1`. [Verified from API output]
- Local slab appears on day 7 for one assigned vehicle (`10 HRS 100 KMS`). [Verified from API output]
- The second assigned vehicle uses `12 HRS 120 KMS`. [Verified from API output]
- The rest of the plan uses outstation 250 KM packages. [Verified from API output]

## 17. Vehicle Build and Pricing Flow

`ItineraryVehiclesEngine.rebuildEligibleVendorList()` rebuilds eligible vendors and persisted vehicle detail rows. [Verified from code]

Vehicle pricing uses vendor eligible lists, vendor vehicles, vehicle type, local/outstation price books, time/kms limits, tolls, parking, permit charges, and stored route locations. [Verified from code]

Frontend-visible vehicle flows include select vendor, select slab, auto-select slabs, build-status polling, and async vehicle rebuild. [Verified from code]

For `DVI20260594`, `trigger_direct_build.js` returned `vehicleBuildStatus = "PROCESSING"` after the Direct ON build. [Verified from live replay]

Do not claim final vehicle pricing for `DVI20260594` from this replay because the captured build response only proves post-commit processing state. [Needs verification]

## 18. Hotel Selection / Prebooking / Voucher Flow

Hotel details APIs include hotel package search, room details, cache rebuild, available hotels, hotel select, bulk save, and prebook. [Verified from code]

Voucher-related APIs include voucher details, cancellation policy endpoints, voucher creation, hotel voucher cancellation, default voucher terms, and existing voucher lookup. [Verified from code]

`ItineraryHotelDetailsTboService` produces hotel package and room responses from provider/cache logic and is also used as a fallback naming path by details mapping. [Verified from code]

For `DVI2026042`, `isConfirmed = false`, and check-in segments are visible in days 1 through 10. [Verified from API output]

The exact backend hotel storage table for this specific case is still not directly proven beyond draft-vs-confirmed inference. [Needs verification]

Provider-specific voucher/prebooking side effects are not exercised by `DVI2026042` or `DVI20260594`. [Needs live DB/API verification]

## 19. Confirmation Flow

Confirmation APIs include customer info, wallet balance, and `POST /itineraries/confirm-quotation`. [Verified from code]

`confirmQuotation()` can call provider booking paths such as `processConfirmationWithTboBookings()` when hotel booking payloads exist. [Verified from code]

Confirmed-vs-draft details mapping switches hotel reads from draft hotel tables to `dvi_confirmed_itinerary_plan_hotel_details` when a confirmed plan is present. [Verified from code]

`DVI2026042` and `DVI20260594` are draft evidence cases and do not exercise confirmation side effects. [Verified from API output]

Wallet, accounting, and provider booking confirmation side effects still need dedicated evidence. [Needs live DB/API verification]

## 20. Cancellation Flow

Cancellation APIs include `POST /itineraries/cancel`, cancellation detail lookup, full-day cancellation charge calculation, hotel cancellation, and cancelled itinerary listing. [Verified from code]

Hotel voucher cancellation APIs are separate voucher-service routes under itinerary hotel-voucher/cancellation paths. [Verified from code]

`ConfirmedItineraryDetails.tsx` is the frontend file tied to confirmed detail and cancellation actions. [Verified from code]

`DVI2026042` and `DVI20260594` do not exercise cancellation side effects. [Verified from API output]

Cancellation tables and provider cancellation services need dedicated confirmed-plan evidence. [Needs live DB/API verification]

## 21. Debugging Checklist

Use this order when a timeline looks wrong:

1. Request payload.
2. `dvi_itinerary_route_details`.
3. `direct_to_next_visiting_place` / via route.
4. Hotspot candidate logs.
5. `dvi_itinerary_route_hotspot_details`.
6. `item_type = 4` attraction rows.
7. `hotspot_plan_own_way` manual rows.
8. Details API response.
9. Frontend rendering.

This order separates candidate filtering from final inserted hotspot evidence. [Inference]

## 22. Case Study: DVI2026042 / PLAN_ID=48

This itinerary is useful because it has 11 routes, mixed direct/non-direct flags, three via-route examples, one manual hotspot, hotel check-ins, vehicle rows, and a final drop row. [Verified from DB/script output]

Facts:

- Quote ID: `DVI2026042`. [Verified from DB/script output]
- Plan ID: `48`. [Verified from DB/script output]
- Route count: `11`. [Verified from DB/script output]
- Timeline row count: `110`. [Verified from DB/script output]
- `item_type = 4` attraction rows: `37`. [Verified from DB/script output]
- Manual hotspot rows: `1`. [Verified from DB/script output]
- Zero-attraction routes: none. [Verified from DB/script output]
- Via routes: `3422`, `3424`, and `3426`. [Verified from DB/script output]
- Manual hotspot: `Vivekanandar House` on route `3425`. [Verified from DB/script output]
- API returned 11 days, 2 vehicle rows, and `isConfirmed = false`. [Verified from API output]

What it covers:

- Long multi-route itinerary building. [Verified from DB/script output]
- Normal/direct-flag route variation, but not the Cochin -> Munnar Direct ON behavior. [Verified from DB/script output]
- Via-route usage. [Verified from DB/script output]
- Manual hotspot preservation. [Verified from DB/script output]
- Auto-built timeline rows. [Verified from DB/script output]
- Draft details API mapping. [Verified from API output]
- Vehicle payload depth. [Verified from API output]

What it does not cover:

- Confirmation side effects. [Needs live DB/API verification]
- Cancellation side effects. [Needs live DB/API verification]
- Provider-specific hotel booking/voucher payloads. [Needs live DB/API verification]
- Direct ON behavior for Cochin -> Munnar is covered separately by DVI20260594, not by DVI2026042. [Verified from live replay]

## 23. Case Study: Direct ON Cochin -> Munnar

Direct ON replay facts:

- Quote ID: `DVI20260594`. [Verified from live replay]
- Plan ID: `410`. [Verified from live replay]
- Direct ON route: `3439`. [Verified from live replay]
- Route chain: `3438 -> 3439 -> 3440 -> 3441 -> 3442 -> 3443`. [Verified from live replay]
- `3439` is `Cochin -> Munnar` with `direct_to_next_visiting_place = 1`. [Verified from DB/script output]

Expected behavior:

- Source-city Cochin hotspots should not be auto-selected on the direct leg. [Verified from code]
- Destination-city Munnar hotspots should be allowed on the direct day. [Verified from code]
- The next same-city Munnar day should not reserve or steal the direct day destination pool. [Verified from code]

Verified live replay behavior:

- Allowed destination hotspots on `3439`: `Eravikulam National Park ( closed in Feb & Mar)`, `Munnar Rose Garden`, `spice garden munnar`, and `Photo view point`. [Verified from live replay]
- Source Cochin hotspots were placed on previous Cochin day `3438`, not on direct day `3439`. [Verified from live replay]
- Next same-city Munnar day `3440` used a different Munnar set: `TATA Tea Museum`, `Echo Point`, `Mattupetty Dam & Lake`, `Kolukkumalai Tea Estate (Munnar)`, `Botanical Garden Munnar`, and `Blossam Hydal Park`. [Verified from live replay]

Cheeyappara / Valara nuance:

- `Cheeyappara Waterfalls` was not present in inspected live replay data. [Verified from live replay]
- `Valara Water Falls` was not present in inspected live replay data. [Verified from live replay]
- The older checker script that mentioned Cheeyappara as required is stale/conflicting. [Inference]
- Candidate trace logs are still needed before saying those hotspots were considered and rejected. [Needs builder trace verification]

Guard:

- Guard name: `DESTINATION_RESERVATION_DIRECT_ON_GUARD`. [Verified from code]
- This bug mattered because a direct day could otherwise lose destination hotspots to a following same-city day or show source/enroute hotspots on the wrong day. [Inference]
- Evidence still needed: builder candidate trace logs for Direct ON candidate filtering. [Needs builder trace verification]

## 24. Refactor Notes

Do not refactor behavior from this guide alone. Use the evidence boundary report first. [Inference]

Safe future refactor phases:

1. Documentation only. [Verified from code report]
2. Scripts/reporting only. [Verified from code report]
3. Constants extraction. [Verified from code report]
4. Details mapper helpers. [Verified from code report]
5. Manual hotspot flow extraction. [Verified from code report]
6. Candidate selection helper extraction. [Verified from code report]
7. Vehicle calculation extraction. [Verified from code report]
8. Regression scripts. [Verified from code report]

Do not rewrite the whole itinerary system before golden outputs and regression scripts exist. [Inference]

## 25. Evidence Appendix

Evidence files used:

- `tmp/docs-evidence/01-engine-map.md`
- `tmp/docs-evidence/02-api-route-map.md`
- `tmp/docs-evidence/03-timeline-builder-contract.md`
- `tmp/docs-evidence/04-details-api-mapper.md`
- `tmp/docs-evidence/05-risk-and-refactor-boundaries.md`
- `tmp/docs-evidence/06-dvi2026042-case-study.md`
- `tmp/docs-evidence/07-direct-on-behavior-evidence.md`
- `tmp/docs-evidence/07-direct-on-live-replay.md`
- `tmp/docs-evidence/dvi2026042-db-focus.txt`
- `tmp/docs-evidence/dvi2026042-full-db-evidence.txt`
- `tmp/docs-evidence/dvi2026042-details-api.json`
- `tmp/docs-evidence/direct-on-trigger-output.txt`
- `tmp/docs-evidence/direct-on-details-api.json`
- `tmp/docs-evidence/direct-on-db-evidence.txt`
- `tmp/docs-evidence/command-errors.md`
- `tmp/docs-evidence/direct-on-command-errors.md`

Known command-output caveats:

- Some first attempts failed from the wrong project root and were rerun successfully from `api.dvi.travel`. [Verified from script]
- Some details API captures begin with `Status: 200` before JSON because stdout was redirected. [Verified from script]
- When reusing these JSON files in scripts, strip non-JSON status lines before `JSON.parse()`. [Inference]
- Direct ON JSON parsing required stripping the status line and reading UTF-16 output. [Verified from script]
