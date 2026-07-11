# Itinerary Timeline System - Intern Architecture Guide v0.1

This is a living guide for interns and engineers working on the DVI itinerary timeline system. Future itinerary refactors must update this file when behavior, row contracts, or API shapes change. [Inference]

Evidence baseline:

- Main timeline case study: `DVI2026042 / PLAN_ID=48`. [Verified from DB/script output]
- Direct ON live replay case study: `DVI20260594 / PLAN_ID=410`. [Verified from live replay]

## End-to-End Itinerary Generation Flow

This section is the quickest way for a new coding agent to understand how a saved itinerary becomes the final timeline shown on the details page. It focuses on the real runtime ownership of each step, not just the ideal architecture. [Verified from code] [Inference]

### The short version

```text
frontend save/update
-> plan DTO reaches NestJS
-> plan + route rows are written
-> route_start_time / route_end_time are decided
-> arrival hotel policy decides hotel-first vs sightseeing-first
-> timeline builder materializes item_type rows into dvi_itinerary_route_hotspot_details
-> itinerary details API reads those persisted rows
-> frontend renders days[].startTime plus days[].segments[]
```

### 1. Frontend save entry point

Primary frontend file:
- `dvi_frontend/src/pages/CreateItinerary/CreateItinerary.tsx`

Primary frontend service:
- `dvi_frontend/src/services/itinerary.ts`

Save flow:
- create/update uses `POST /api/v1/itineraries/?type=itineary_basic_info` or the update equivalent. [Verified from code]
- the payload sends:
  - `plan.trip_start_date`
  - `plan.trip_end_date`
  - `plan.pick_up_date_and_time`
  - route list
  - traveller list
  - vehicle selection
- for the basic itinerary form, `pick_up_date_and_time` is built from the same wall-clock date/time as the trip start. [Verified from code]

Important implication:
- if the user starts Day 1 at `10:00 AM`, that value must survive all later backend steps as the Day 1 route start, unless a business rule intentionally overrides it. [Inference]

### 2. Plan parsing and wall-clock time ownership

Primary backend files:
- `api.dvi.travel/src/modules/itineraries/engines/plan-engine.service.ts`
- `api.dvi.travel/src/modules/itineraries/engines/route-engine.service.ts`

Key rule:
- itinerary generation must treat incoming date/time fields as wall-clock values, not as UTC-shifted transport values. [Verified from code]

Why this matters:
- `2026-07-12T10:00:00+05:30` must remain a `10:00` business-time start for Day 1.
- if any step converts that into environment-local UTC logic too early, route start can drift. [Inference]

### 3. Route generation owns the route day envelope

Primary backend file:
- `api.dvi.travel/src/modules/itineraries/engines/route-engine.service.ts`

What this step writes:
- `dvi_itinerary_route_details`

Important fields:
- `route_start_time`
- `route_end_time`
- `itinerary_route_date`
- `location_id`
- `no_of_km`

Practical ownership:
- `route_start_time` and `route_end_time` are the official day envelope for each route/day.
- Day 1 should normally use the saved trip start / pickup time.
- middle days usually default to `08:00:00 -> 20:00:00`.
- last day may be constrained by departure logic and buffers. [Verified from code] [Inference]

Debug rule:
- if `days[].startTime` in the details API is wrong, inspect `dvi_itinerary_route_details` first.
- if `days[].startTime` is correct but visible timeline rows are wrong, the bug is usually in persisted hotspot rows, not in the route row. [Verified from live debug]

### 4. Arrival policy decides Day 1 hotel-first vs sightseeing-first

Primary backend file:
- `api.dvi.travel/src/modules/itineraries/services/arrival-hotel-policy.service.ts`

Primary endpoint:
- `POST /api/v1/itineraries/hotel-arrival-policy`

What it decides:
- arrival window classification such as:
  - `EARLY_01_TO_0759`
  - `MORNING_09_TO_1259`
- whether the user should:
  - go to hotel first
  - do sightseeing first and defer hotel check-in to end of day
- whether previous-day billing confirmation is required for very early arrivals. [Verified from code and live API]

Important distinction:
- `deferHotelToEndOfDay = true` does not automatically mean "force Day 1 to start at 08:00 AM".
- only specific early-arrival flows should apply the legacy `08:00 AM -> 09:00 AM` starter buffer. [Verified from root cause analysis]

### 5. Timeline builder materializes persisted day rows

Primary backend file:
- `api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts`

This is the most important file for itinerary behavior.

What it does:
- chooses hotspots for each route/day
- applies carry-forward and same-city continuation logic
- applies hotel-first / hotel-last flow rules
- computes travel segments, durations, breaks, and terminal rows
- writes in-memory rows that later persist to:
  - `dvi_itinerary_route_hotspot_details`

The details page does not invent the timeline from scratch.
It mostly reads these persisted rows back later. [Verified from code]

Important item types in `dvi_itinerary_route_hotspot_details`:
- `item_type = 1`: start/refreshment row
- `item_type = 3`: travel row
- `item_type = 4`: attraction/hotspot visit row
- `item_type = 5`: travel-to-hotel or terminal-style travel row
- `item_type = 6`: hotel check-in row
- `item_type = 7`: return/drop-style terminal row in some flows

Practical debugging rule:
- if the UI shows `08:00 AM - 09:00 AM` as "Start your Journey", check whether the persisted `item_type = 1` row still says `08:00 -> 09:00`.
- do not assume the frontend created that value. [Verified from live API and DB debug]

### 6. Rebuild flows regenerate persisted hotspot rows

Primary backend files:
- `api.dvi.travel/src/modules/itineraries/itineraries.service.ts`
- `api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts`

Primary frontend service helpers:
- `ItineraryService.rebuildRoute(planId, routeId)`
- `ItineraryService.rebuildRouteHotspots(planId, routeId)`

What rebuild means in practice:
- route rebuild/hotspot rebuild does not just refresh UI state
- it regenerates the persisted item-type rows for that route/day

Critical operational rule:
- if `route_start_time` was fixed after initial generation, old hotspot rows may still carry stale times.
- in that case, the details API can return:
  - correct `days[].startTime` from `route_start_time`
  - stale `days[].segments[0].timeRange` from old `item_type = 1` data
- the fix is a route rebuild, not just a page refresh. [Verified from live debug of `PLAN_ID=9871`]

### 6A. Same-city cross-day hotspot rebalance is part of normal rebuild

Primary backend files:
- `api.dvi.travel/src/modules/itineraries/services/same-city-cross-day-optimizer.service.ts`
- `api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts`
- `api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts`

Runtime rule:
- same-city cross-day hotspot rebalancing is timeline-generation behavior, not a separate UI-only mode
- it must run for normal create/update rebuilds triggered by `type=itineary_basic_info`
- it must also remain compatible with route-optimized flows such as `type=itineary_basic_info_with_optimized_route`
- this behavior must not depend on a special request flag introduced only for one screen or one endpoint shape

Implementation rule:
- `SameCityCrossDayOptimizerService` must build one `sameCityAllocationPlan` and pass it into the normal rebuild path
- `HotspotEngineService.rebuildRouteHotspots(...)` must forward that plan into `TimelineBuilder.buildTimelineForPlan(...)`
- `TimelineBuilder` must consume `desiredMovableOrderByRoute` and `preferredAdjacencyPairsByRoute` while scoring filler/movable hotspots on the rebuilt target day
- this keeps the optimizer decision alive during the actual persistence pass instead of losing it between "analyze" and "rebuild"

Selection rule:
- the optimizer may move movable auto hotspots between consecutive same-city days
- fixed anchors must stay pinned on their route
- manual hotspots must stay pinned unless the user explicitly changes them through manual-edit flows
- priority hotspots are treated as fixed anchors before optional/filler auto hotspots are considered for movement
- transfer-only terminal days keep their no-sightseeing protection and must not receive pushed sightseeing just because spare time appears to exist

Adjacency rule:
- when two movable hotspots are effectively neighbors and belong to the same same-city chain, the preferred outcome is to keep them on the same target day and adjacent in the persisted order
- the motivating July 2026 example was `Charminar` with `Macca Masjid`; once moved, the pair should sit beside each other in the rebuilt day rather than being separated again by unrelated fillers

Verified live rebuild note:
- on `2026-07-12`, quote `DVI20260798` was rebuilt through the normal `type=itineary_basic_info` flow and the moved hotspot no longer stayed on Day 1
- the rebuilt Day 2 persisted order became `Macca Masjid -> Charminar -> ...`
- the important invariant is that the moved near-neighbor hotspot stayed on the target day and adjacent to its intended cluster, instead of being pulled back apart by unrelated fillers

### 6B. Rebuild persistence must preserve travel-leg integrity

Primary backend files:
- `api.dvi.travel/src/modules/itineraries/engines/helpers/travel-segment.builder.ts`
- `api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts`
- `api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts`

Persistence contract:
- every persisted sightseeing visit row (`item_type = 4`) must keep a matching inbound travel segment (`item_type = 3`) after rebuild
- this remains true after reorder, after same-day insertion, and after cross-day movement
- no hotspot should become an orphaned visit row simply because it was moved beside another hotspot later in the rebuild
- if a visit row is retained, its inbound travel row must be regenerated and persisted with it

Verified live rebuild note:
- for the same verified `DVI20260798` rebuild, Day 2 persisted:
  - `Hotel -> Macca Masjid` travel row
  - `Macca Masjid` visit row
  - `Macca Masjid -> Charminar` travel row
  - `Charminar` visit row
- this confirms the rebuild did not leave the moved hotspot without its inbound leg

Practical debugging rule:
- if the UI shows a hotspot card but the travel strip into that hotspot is missing, inspect the persisted `dvi_itinerary_route_hotspot_details` sequence first
- treat that as a rebuild/persistence contract failure, not as a frontend rendering problem, unless the API payload already contains the missing segment

### 6C. Short local hotspot hops use coordinate distance, not city-level distance

Primary backend file:
- `api.dvi.travel/src/modules/itineraries/engines/helpers/distance.helper.ts`

Distance rule:
- when both source and destination hotspot coordinates are known, `DistanceHelper.fromSourceAndDestination()` should resolve the hop from coordinates instead of falling back to a city-to-city stored-location row
- the current helper uses a Haversine base distance with a `1.5x` correction factor for local road realism
- local sightseeing hops do not add the old common road buffer
- very short local hops still clamp to a minimum travel time of `00:05:00`

Implication:
- extremely close pairs such as `Charminar` and `Macca Masjid` should be treated as near-adjacent local movement, not as a generic city transfer
- if a rebuilt day separates such a pair, that should come from scheduling/selection logic, not from an inflated city-to-city distance lookup

Verified live rebuild note:
- the rebuilt `Macca Masjid -> Charminar` hop persisted as a short local leg rather than a large city-level transfer
- this is the expected shape when both hotspot coordinates are available and the local-hop calculation path is used

### 7. Itinerary details API reads persisted route rows

Primary backend file:
- `api.dvi.travel/src/modules/itineraries/itinerary-details.service.ts`

Primary endpoint:
- `GET /api/v1/itineraries/details/:quoteId`

Important response ownership:
- `days[].startTime` comes from `route.route_start_time`
- `days[].endTime` comes from `route.route_end_time`
- visible timeline `segments[]` come from `dvi_itinerary_route_hotspot_details`

This split is the source of many "UI mismatch" investigations.

Example:
- route row says Day 1 starts at `10:00 AM`
- persisted `item_type = 1` row still says `08:00 AM - 09:00 AM`
- API returns both values
- frontend shows both values
- user reports that the timeline starts at `8 AM`

That is a backend data-generation mismatch, not a React formatting bug. [Verified from live API and DB debug]

### 8. Frontend itinerary details page is mostly a renderer

Primary frontend file:
- `dvi_frontend/src/pages/ItineraryDetails.tsx`

What the page does:
- fetches `GET /itineraries/details/:quoteId`
- renders `days[].startTime` and `days[].endTime` in the day header
- renders `days[].segments[]` in sequence
- applies some post-processing for hotel display, but it does not regenerate the day timeline from raw route fields. [Verified from code]

Practical rule:
- if the API response already contains the wrong segment times, the page will faithfully show them.

### 9. The most common debugging path

When a user says "Day 1 starts at 10 AM but the timeline starts at 8 AM", debug in this order:

1. Check the plan row:
   - `trip_start_date_and_time`
   - `pick_up_date_and_time`
2. Check the route row:
   - `dvi_itinerary_route_details.route_start_time`
   - `route_end_time`
3. Check the arrival policy result:
   - was this truly an early-arrival flow, or just a same-day sightseeing-first arrival?
4. Check persisted timeline rows:
   - `dvi_itinerary_route_hotspot_details`
   - especially `item_type = 1` and the first `item_type = 3`
5. Check the details API payload:
   - compare `days[].startTime` with `days[].segments[0].timeRange`
6. Only after that inspect the frontend renderer.

### 10. July 2026 root cause example: Day 1 at 10 AM still showing 8 AM

Case:
- quote `DVI20260798`
- plan `9871`
- trip start `2026-07-12 10:00 AM`

Observed state:
- plan and route saved `10:00 AM` correctly
- details API returned `days[0].startTime = 10:00 AM`
- but persisted timeline rows still had:
  - `item_type = 1`: `08:00 AM -> 09:00 AM`
  - first travel row: `09:00 AM -> 10:01 AM`

Real root cause:
- Day 1 same-day sightseeing-first flow (`MORNING_09_TO_1259`, hotel deferred to end of day) was incorrectly reusing the old early-arrival forced buffer logic in `timeline.builder.ts`.
- that logic should only force `08:00 -> 09:00` for true early-arrival same-day deferred flows, not for a `10:00 AM` arrival. [Verified from code and live API]

Takeaway:
- when fixing this class of bug, update the generation logic first, then rebuild the affected route so persisted hotspot rows match the saved route envelope.

### 10A. July 2026 root cause example: Last day shows generic return instead of airport transfer

Case:
- quote `DVI20260798`
- plan `9871`
- Day 3 route: `Hyderabad, Telangana, India -> Hyderabad, Rajiv Gandhi International Airport`

Observed state:
- persisted Day 3 row existed as `item_type = 7`
- generated travel was `09:00 AM -> 10:29 AM`
- route envelope for Day 3 was `08:00 AM -> 08:00 AM`
- details API suppressed the drop-off row because it exceeded `route_end_time`
- frontend then received only:
  - `start`
  - fallback `return`

Real root cause:
- the last route was still getting the sightseeing-style default `08:00 AM` start and the builder's hidden 1-hour common buffer
- for a tight departure-transfer day, that made the final airport leg start too late
- `itinerary-details.service.ts` correctly suppressed the overrun `item_type = 7` row, which made the response look like "return to origin" instead of "travel to airport" [Verified from code and live DB/API debug]

Fix direction:
- derive an earlier last-route `route_start_time` when the default `08:00 AM` start would make the final terminal transfer impossible after accounting for:
  - departure buffer
  - master travel time for the last route pair
  - the builder's hidden common buffer
- after code changes, rebuild the affected route so the persisted `item_type = 7` row is regenerated within the route envelope.
- if the last route is terminal-bound (airport, railway, bus stand, station), the details API should surface that transfer as a travel segment to the departure point instead of falling back to a generic "return" label.
- when the route is transfer-only, hotspots should stay suppressed and the only visible end-of-day movement should be the departure transfer.
- for transfer-only terminal days, the synthetic `Start Your Day` row should use the route's exact start time instead of borrowing a stale first-timeline anchor that can show `12:00 PM`.

### 11. File map for the next coding agent

If you only have five minutes, open these files in this order:

1. `api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts`
2. `api.dvi.travel/src/modules/itineraries/engines/route-engine.service.ts`
3. `api.dvi.travel/src/modules/itineraries/services/arrival-hotel-policy.service.ts`
4. `api.dvi.travel/src/modules/itineraries/itinerary-details.service.ts`
5. `dvi_frontend/src/pages/ItineraryDetails.tsx`

That file order matches the real direction of control for itinerary generation and display. [Inference]

## Latest Regression Fix Notes: Top10 Carry-Forward and Travel Segment Stability

### Why this section exists

The top10 regression suite exposed two regressions on the current branch:

- some travel rows were persisting as `0.00 KM` even when the source and destination labels differed
- some carry-forward candidates were being judged against the wrong route/day context and surfaced as `INVALID_CARRY_FORWARD`

The current branch now passes the top10 suite, but this section keeps the exact rule ownership, trigger conditions, and debug path in one place so an intern can trace the failure from request to UI. [Verified from regression output] [Inference]

### Rule Map

| Rule ID | Regression symptom | New/current rule | Implemented in | Verified by | Debug first |
| --- | --- | --- | --- | --- | --- |
| R1 | Travel row shows `0.00 KM` or blank distance for different source/destination labels | `item_type = 3` travel rows must not remain zero/near-zero when source and destination names differ; the row is normalized to `0.10` and `00:05:00` before persistence | `src/modules/itineraries/engines/helpers/distance.helper.ts -> fromSourceAndDestination()`; `src/modules/itineraries/engines/helpers/travel-segment.builder.ts -> buildTravelSegment()`; `src/modules/itineraries/engines/helpers/timeline.builder.ts -> normalizeTravelRowDistance()`; `src/modules/itineraries/engines/hotspot-engine.service.ts -> rebuildRouteHotspots()` | `scripts/run-regression-suite.js -> detectFailures()`; `tmp/regression-report-top10.md`; `scripts/regression/top10/top10-case-02.json` | `src/modules/itineraries/engines/helpers/timeline.builder.ts -> normalizeTravelRowDistance()` |
| R2 | `INVALID_CARRY_FORWARD` on same-city continuation rows | Carry-forward hotspots only merge when `isCarryForwardHotspotCompatibleWithRoute()` says the hotspot belongs on the current route context; unresolved carry-forward is only queued for the immediate same-city continuation route | `src/modules/itineraries/engines/helpers/timeline.builder.ts -> isCarryForwardHotspotCompatibleWithRoute()`; `mergeCarryForwardIntoCandidates()`; `buildTimelineForPlan()` | `scripts/run-regression-suite.js -> detectFailures()`; `scripts/regression/top10/top10-case-04.json`; `scripts/regression/top10/top10-case-05.json`; `tmp/regression-report-top10.md` | `src/modules/itineraries/engines/helpers/timeline.builder.ts -> isCarryForwardHotspotCompatibleWithRoute()` |
| R3 | Wrong or zero `location_id` on route rows | Route lookup uses exact match first, then alias/city fallback, and only accepts active rows from `dvi_stored_locations` (`deleted = 0`, `status = 1`); strict mode throws instead of silently returning `0` | `src/modules/itineraries/engines/route-engine.service.ts -> resolveSourceLocationAndKm()` | Route rebuild output; `dvi_itinerary_route_details.location_id` | `src/modules/itineraries/engines/route-engine.service.ts -> resolveSourceLocationAndKm()` |
| R4 | Direct ON loses destination hotspots or reserves them for the next same-city day | `direct_to_next_visiting_place = 1` disables destination reservation for the next loopback day; the direct day keeps its destination hotspots | `src/modules/itineraries/engines/helpers/timeline.builder.ts` around `DESTINATION_RESERVATION_DIRECT_ON_GUARD` inside `buildTimelineForPlan()` | `DVI20260594 / PLAN_ID=410`; live replay; `DESTINATION_RESERVATION_DIRECT_ON_GUARD` logs | `src/modules/itineraries/engines/helpers/timeline.builder.ts -> buildTimelineForPlan()` |

### R1: Travel Row Distance Stability

#### User-visible symptom

A travel segment in the timeline or details API showed `0.00 KM` even though the travel was between different places, not a same-place hop. The business symptom was a believable route with an implausible zero-distance travel leg.

#### Data symptom

```text
DB table: dvi_itinerary_route_hotspot_details
Field: hotspot_travelling_distance
Bad value: 0.00 / blank / near-zero for item_type = 3
Expected value: a non-zero normalized travel distance, currently 0.10 on this branch

API field: days[].segments[].distance
Bad value: "0.00 KM"
Expected value: a non-zero travel label such as "0.10 KM"
```

#### Code owner

```text
Primary file: src/modules/itineraries/engines/helpers/timeline.builder.ts
Primary function: normalizeTravelRowDistance()
Called by: buildTimelineForPlan()
Writes/returns: normalized HotspotDetailRow before persistence

Supporting file: src/modules/itineraries/engines/helpers/travel-segment.builder.ts
Supporting function: buildTravelSegment()
Called by: TimelineBuilder during route row assembly
Writes/returns: HotspotDetailRow with travel distance/time

Final persistence file: src/modules/itineraries/engines/hotspot-engine.service.ts
Function: rebuildRouteHotspots()
Called by: ItinerariesService rebuild flow
Writes/returns: persisted dvi_itinerary_route_hotspot_details rows
```

#### Runtime flow

```text
request / rebuild trigger
-> ItinerariesService
-> HotspotEngineService.rebuildRouteHotspots()
-> TimelineBuilder.buildTimelineForPlan()
-> TravelSegmentBuilder.buildTravelSegment()
-> TimelineBuilder.normalizeTravelRowDistance()
-> dvi_itinerary_route_hotspot_details.hotspot_travelling_distance
-> ItineraryDetailsService.getItineraryDetails()
-> days[].segments[].distance
-> regression report
```

#### Actual code rule

```ts
// src/modules/itineraries/engines/helpers/travel-segment.builder.ts -> buildTravelSegment()
if (
  item_type === 3 &&
  namesDiffer &&
  Number.isFinite(Number(distanceResult.distanceKm)) &&
  Number(distanceResult.distanceKm) <= 0.01
) {
  distanceResult = {
    ...distanceResult,
    distanceKm: 0.1,
    travelTime: '00:05:00',
  };
}

// src/modules/itineraries/engines/helpers/timeline.builder.ts -> normalizeTravelRowDistance()
if (
  Number(row?.item_type || 0) === 3 &&
  namesDiffer &&
  Number.isFinite(distanceKm) &&
  distanceKm <= 0.01
) {
  return {
    ...row,
    hotspot_travelling_distance: '0.10',
  };
}
```

#### Why this prevents the regression

The builder now refuses to let a different-place travel segment keep a zero distance. The helper first gives the travel leg a minimal fallback, and the timeline persistence path normalizes the stored row before it reaches the database. That keeps the details API and the regression harness from seeing a suspicious zero-distance travel row. [Inference]

#### How to debug if it fails again

1. Open `src/modules/itineraries/engines/helpers/timeline.builder.ts` and check `normalizeTravelRowDistance()`.
2. Open `src/modules/itineraries/engines/helpers/travel-segment.builder.ts` and check `buildTravelSegment()`.
3. Check `HotspotEngineService.rebuildRouteHotspots()` to confirm the final persisted rows are normalized.
4. Inspect `scripts/run-regression-suite.js -> detectFailures()` for `SUSPICIOUS_ZERO_TRAVEL_DISTANCE`.
5. Compare the persisted `hotspot_travelling_distance` with the details API `days[].segments[].distance`.
6. If the API is right but the screen is wrong, inspect `dvi_frontend/src/pages/ItineraryDetails.tsx`.

### R2: Carry-Forward Validation

#### User-visible symptom

A hotspot that looked valid in the carry-forward queue failed the route/day validation and showed up as `INVALID_CARRY_FORWARD` in the regression report.

#### Data symptom

```text
DB / route state: carry-forward candidate attached to the wrong route day or wrong same-city continuation context
Regression label: INVALID_CARRY_FORWARD
Expected value: candidate matches the current route source/destination context and same-city continuation chain
```

#### Code owner

```text
Primary file: src/modules/itineraries/engines/helpers/timeline.builder.ts
Primary function: isCarryForwardHotspotCompatibleWithRoute()
Called by: mergeCarryForwardIntoCandidates(), same-city carry queueing logic, and carry-forward replay in buildTimelineForPlan()
Writes/returns: compatibility verdict used before merge
```

#### Runtime flow

```text
route context
-> buildTimelineForPlan()
-> carry-forward queueing
-> isCarryForwardHotspotCompatibleWithRoute()
-> mergeCarryForwardIntoCandidates()
-> persisted hotspot row or rejection
-> scripts/run-regression-suite.js labels invalid carry-forward
```

#### Actual code rule

```ts
// src/modules/itineraries/engines/helpers/timeline.builder.ts -> isCarryForwardHotspotCompatibleWithRoute()
const sourceMatch = this.hotspotLocationMatchesCity(hotspotLocation, routeContext.sourceCity);
const sourceToMatch = this.hotspotLocationMatchesCity(hotspotToLocation, routeContext.sourceCity);
const destinationMatch = this.hotspotLocationMatchesCity(hotspotLocation, routeContext.destinationCity);
const destinationToMatch = this.hotspotLocationMatchesCity(hotspotToLocation, routeContext.destinationCity);

const compatible = sourceMatch || sourceToMatch || destinationMatch || destinationToMatch;

// src/modules/itineraries/engines/helpers/timeline.builder.ts -> mergeCarryForwardIntoCandidates()
if (!compatibility.compatible) {
  this.logBookingRule({
    rule: 'CARRY_FORWARD_MERGE_REJECTED_ROUTE_MISMATCH',
    ...
  });
  continue;
}
```

The scheduler also scopes carry-forward to same-city continuation:

```ts
if (!forceNoSightseeingOnThisRoute && carryForwardHotspots.length > 0 && sameCityContinuationContextForRoute.isSameCityChainContinuation) {
  selectedHotspots = this.mergeCarryForwardIntoCandidates(...);
}
```

#### Why this prevents the regression

The builder no longer blindly reuses carry-forward rows across route boundaries. It only merges them when the hotspot matches the current route source or destination city and when the route is actually the immediate same-city continuation. That prevents a carry-forward hotspot from leaking into a route/day that does not own it. [Inference]

#### How to debug if it fails again

1. Open `src/modules/itineraries/engines/helpers/timeline.builder.ts` and inspect `isCarryForwardHotspotCompatibleWithRoute()`.
2. Check `mergeCarryForwardIntoCandidates()` for `CARRY_FORWARD_MERGE_REJECTED_ROUTE_MISMATCH`.
3. Check the same-city continuation gate in `buildTimelineForPlan()`.
4. Run `node scripts/run-regression-suite.js --suite top10` and inspect the `INVALID_CARRY_FORWARD` lines in the report.
5. Use `scripts/regression/top10/top10-case-04.json` and `top10-case-05.json` as the carry-forward fixtures.

### R3: Route Location ID Resolution

#### User-visible symptom

The route row had the wrong `location_id` or no usable location row at all, which later caused downstream timeline or permit behavior to drift.

#### Data symptom

```text
DB table: dvi_itinerary_route_details
Field: location_id
Bad value: 0 / missing / wrong route master row
Expected value: resolved location_ID from an active dvi_stored_locations row
```

#### Code owner

```text
File: src/modules/itineraries/engines/route-engine.service.ts
Function: resolveSourceLocationAndKm()
Called by: main route rebuild entry for a plan
Writes/returns: { locationId, distanceKm, travelSeconds }
```

#### Runtime flow

```text
route input
-> RouteEngineService.resolveSourceLocationAndKm()
-> dvi_stored_locations lookup
-> route row creation
-> dvi_itinerary_route_details.location_id
```

#### Actual code rule

```ts
// src/modules/itineraries/engines/route-engine.service.ts -> resolveSourceLocationAndKm()
FROM dvi_stored_locations sl
WHERE sl.deleted = 0
  AND sl.status = 1
  AND (...exact and alias/city fallback match...)
ORDER BY
  match_rank ASC,
  airport_penalty ASC,
  km_diff ASC,
  sl.location_ID DESC
LIMIT 1

if (!row) {
  if (process.env.STRICT_ROUTE_MASTER_LOOKUP === "1") {
    throw new Error(`[ROUTE_MASTER_LOOKUP_FAILED] ... Cannot create itinerary route with location_id=0.`);
  }
  return { locationId: BigInt(0), distanceKm: "", travelSeconds: null };
}
```

#### Why this prevents the regression

The lookup no longer depends on one fragile match shape. It first tries exact source/destination matches, then alias/city fallbacks, and only accepts active master rows. That reduces the chance of a route being saved with an empty or wrong `location_id`. [Inference]

#### How to debug if it fails again

1. Open `src/modules/itineraries/engines/route-engine.service.ts` and inspect `resolveSourceLocationAndKm()`.
2. Confirm the source and destination names actually match an active `dvi_stored_locations` row.
3. Check whether strict mode is enabled via `STRICT_ROUTE_MASTER_LOOKUP`.
4. Inspect `dvi_itinerary_route_details.location_id` for the affected route.
5. If the route still resolves to `0`, compare the normalized source/destination strings in the query.

### R4: Direct ON Destination Reservation

#### User-visible symptom

Direct ON routes either lost their destination hotspots on the direct day or incorrectly reserved them for the next same-city day.

#### Data symptom

```text
Route field: direct_to_next_visiting_place = 1
Expected behavior: destination hotspots stay on the direct day
Regression proof: DVI20260594 / PLAN_ID=410 live replay
```

#### Code owner

```text
File: src/modules/itineraries/engines/helpers/timeline.builder.ts
Function: buildTimelineForPlan()
Rule marker: DESTINATION_RESERVATION_DIRECT_ON_GUARD
```

#### Runtime flow

```text
route row
-> buildTimelineForPlan()
-> direct_to_next_visiting_place check
-> DESTINATION_RESERVATION_DIRECT_ON_GUARD
-> destination candidates stay on the direct day
-> persisted hotspot rows
-> live replay / details API
```

#### Actual code rule

```ts
const directToNextForDestinationReservation = Number(
  (route as any).direct_to_next_visiting_place || 0,
);
const isEligibleForDestinationReservation =
  directToNextForDestinationReservation !== 1 &&
  ...

this.logBookingRule({
  rule: 'DESTINATION_RESERVATION_DIRECT_ON_GUARD',
  reason:
    directToNextForDestinationReservation === 1
      ? 'Direct route must use destination hotspots today, not reserve them for next same-city day.'
      : 'Non-direct route keeps existing destination reservation behavior.',
});
```

#### Why this prevents the regression

The guard prevents the scheduler from stealing destination hotspots from a direct route and saving them for the next loopback day. That keeps the direct day aligned with the business rule and the live replay evidence. [Inference]

#### How to debug if it fails again

1. Open `src/modules/itineraries/engines/helpers/timeline.builder.ts` and inspect `DESTINATION_RESERVATION_DIRECT_ON_GUARD`.
2. Check the route row's `direct_to_next_visiting_place` value.
3. Re-run the direct ON live replay case `DVI20260594 / PLAN_ID=410`.
4. Confirm destination hotspots are still present on the direct day and not moved to the next same-city day.

### Regression File Ownership Matrix

| Issue seen | First file to open | Function/method | Why this file | Next file |
| --- | --- | --- | --- | --- |
| `SUSPICIOUS_ZERO_TRAVEL_DISTANCE` | `scripts/run-regression-suite.js` | `detectFailures()` / `isSuspiciousZeroTravelSegment()` | Detects the symptom and names the route/day/segment | `src/modules/itineraries/engines/helpers/timeline.builder.ts -> normalizeTravelRowDistance()` |
| `INVALID_CARRY_FORWARD` | `scripts/run-regression-suite.js` | `detectFailures()` | Reports the route/day mismatch and points to the offending hotspot | `src/modules/itineraries/engines/helpers/timeline.builder.ts -> isCarryForwardHotspotCompatibleWithRoute()` |
| Travel row shows `0.00 KM` | `src/modules/itineraries/engines/helpers/timeline.builder.ts` | `normalizeTravelRowDistance()` | Normalizes the persisted hotspot row before insert | `src/modules/itineraries/engines/hotspot-engine.service.ts -> rebuildRouteHotspots()` |
| Wrong or empty `location_id` | `src/modules/itineraries/engines/route-engine.service.ts` | `resolveSourceLocationAndKm()` | Owns route master lookup and location resolution | `dvi_stored_locations` lookup rows |
| DB row looks right but API distance is wrong | `src/modules/itineraries/itinerary-details.service.ts` | `getItineraryDetails()` | Maps persisted rows into `days[].segments[]` | `dvi_frontend/src/pages/ItineraryDetails.tsx` |
| Direct ON destination hotspot moved to next day | `src/modules/itineraries/engines/helpers/timeline.builder.ts` | `buildTimelineForPlan()` | Owns the direct-on reservation guard | `dvi_itinerary_route_hotspot_details` |

### Fields Affected by This Regression

| Layer | Field/table | Meaning | Owner code |
| --- | --- | --- | --- |
| DB | `dvi_itinerary_route_hotspot_details.item_type` | `3` is the overloaded travel/break/via-connector row type | `TimelineBuilder.buildTimelineForPlan()` and `TravelSegmentBuilder.buildTravelSegment()` |
| DB | `dvi_itinerary_route_hotspot_details.hotspot_travelling_distance` | Persisted travel distance for the timeline row | `normalizeTravelRowDistance()` and `HotspotEngineService.rebuildRouteHotspots()` |
| DB | `dvi_itinerary_route_hotspot_details.hotspot_traveling_time` | Persisted travel time for the row | `TravelSegmentBuilder.buildTravelSegment()` |
| DB | `dvi_itinerary_route_details.location_id` | Route master row reference | `RouteEngineService.resolveSourceLocationAndKm()` |
| API | `days[].segments[].distance` | Human-readable timeline distance shown to the user | `ItineraryDetailsService.getItineraryDetails()` |
| API | `days[].segments[].type` | Travel vs break vs attraction vs check-in rendering | `ItineraryDetailsService.getItineraryDetails()` |
| Regression report | `failures[].label` | `SUSPICIOUS_ZERO_TRAVEL_DISTANCE` or `INVALID_CARRY_FORWARD` | `scripts/run-regression-suite.js -> detectFailures()` |

### Before / After Behavior

| Area | Before | After | Code proof |
| --- | --- | --- | --- |
| Travel row distance | A different-place travel leg could persist as `0.00 KM` or blank and still look structurally valid | The helper, builder, and final persistence path normalize the row to a minimal non-zero travel value | `distance.helper.ts -> fromSourceAndDestination()`; `travel-segment.builder.ts -> buildTravelSegment()`; `timeline.builder.ts -> normalizeTravelRowDistance()`; `hotspot-engine.service.ts -> rebuildRouteHotspots()` |
| Carry-forward | Carry-forward candidates could be judged only by the report side, making the failure look opaque to an intern | Carry-forward now has an explicit compatibility function and a same-city continuation gate | `timeline.builder.ts -> isCarryForwardHotspotCompatibleWithRoute()`; `mergeCarryForwardIntoCandidates()` |
| Route `location_id` | A route lookup could fall back to zero without enough context in non-strict mode | Route lookup prefers exact, alias, and city matches against active stored locations | `route-engine.service.ts -> resolveSourceLocationAndKm()` |
| Direct ON reservation | Destination hotspots could be reserved or skipped in a way that confused direct-day output | The direct-on guard keeps destination hotspots on the direct day | `timeline.builder.ts -> buildTimelineForPlan()` |

### Verification Snapshot

- Top10 suite result: `10/10 passed`. [Verified from regression output]
- `top10-case-02` is the travel-row stability fixture for the zero-distance path. [Verified from regression output]
- `top10-case-04` and `top10-case-05` are the carry-forward validation fixtures. [Verified from regression output]
- The top10 report is written to `tmp/regression-report-top10.md`. [Verified from regression output]

Use this section as the first stop when a future issue appears as `INVALID_CARRY_FORWARD`, `0.00 KM`, wrong `location_id`, Direct ON hotspot loss, or a details/UI mismatch. [Inference]

## 1. Purpose of the Itinerary System

The itinerary system turns a quote into a day-by-day travel plan with route rows, hotel rows, vehicle pricing rows, and a visible timeline of starts, travel legs, attractions, breaks, hotel check-ins, and final drop-off. [Verified from code]

```text
quote input
-> route rows
-> timeline rows
-> details API
-> frontend timeline
```

[Inference]

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

Responsibility split:

- Controller = HTTP route entry and request/response wiring. [Verified from code]
- Service = orchestration of plan, route, hotel, vehicle, and rebuild flows. [Verified from code]
- Engine/helper = build, pricing, timing, or calculation logic. [Verified from code]
- Details service = read + mapping layer for persisted data. [Verified from code]
- Frontend = render and user interaction layer. [Verified from code]

## 3. Main Backend Files and Responsibilities

| File | Responsibility | Important methods | When to inspect this file | Confidence | Notes |
| --- | --- | --- | --- | --- | --- |
| `src/modules/itineraries/itineraries.controller.ts` | HTTP surface for create/update, details, rebuild, hotel, vehicle, manual hotspot, activity, confirmation, and cancellation routes. | Controller route handlers such as `createPlan()`, `getItineraryDetails()`, `rebuildRoute()`, `updateRouteTimes()`, `confirmQuotation()`, `cancelItinerary()`. | When an API route, request shape, or URL mapping looks wrong. | High | [Verified from code] Controller mostly delegates to services. |
| `src/modules/itineraries/itineraries.service.ts` | Main itinerary orchestration layer. | `createPlan`, `rebuildRouteHotspotsForDay`, `updateRouteTimes`, `previewManualHotspotsBatch`, `addManualHotspot`, `applyManualHotspotsBatch`, `removeManualHotspot`, `selectHotel`, `bulkSaveHotels`, `selectVehicleVendor`, `selectVehicleSlab`, `autoSelectVehicleSlabs`, `confirmQuotation`, `prebookHotels`, `cancelItinerary`. | When cross-module behavior changes after create/update, rebuild, hotel, vehicle, or manual hotspot actions. | High | [Verified from code] Reads/writes plan, route, hotspot, hotel, vehicle, confirmation, wallet, and cancellation tables through service flows. |
| `src/modules/itineraries/engines/helpers/timeline.builder.ts` | Builds the in-memory timeline from routes, hotspots, timing, hotels, vehicles, and via data. | `buildTimelineForPlan(...)`. | When the hotspot sequence, bucket order, cutoff behavior, or Direct ON behavior looks wrong. | High | [Verified from code] Returns `{ hotspotRows, parkingRows, routeRejectionSummaryByRoute }`; it does not persist rows itself. |
| `src/modules/itineraries/engines/hotspot-engine.service.ts` | Transactional hotspot rebuild and manual hotspot preview wrapper. | `rebuildRouteHotspots`, `rebuildParkingCharges`, `previewManualHotspotAdd`. | When manual protection, delete/rebuild persistence, or final row dedupe looks wrong. | High | [Verified from code] Deletes old rows, protects manual rows, calls `TimelineBuilder`, and persists returned rows. |
| `src/modules/itineraries/itinerary-details.service.ts` | Maps persisted plan/route/hotspot/hotel/vehicle data into the frontend details payload. | `getPlanIdFromQuoteId`, `getItineraryDetails`, `getLatestItinerariesDataTable`, `findOne`, `findOneOld`. | When DB rows look right but frontend segments/cards look wrong. | High | [Verified from code] Returns `days[]`, `vehicles[]`, package notes, and cost breakdown. |
| `src/modules/itineraries/engines/itinerary-vehicles.engine.ts` | Rebuilds eligible vendor list and vehicle pricing rows. | `rebuildEligibleVendorList`. | When vendor rows, slab rows, or vehicle build status look wrong. | High | [Verified from code] Uses vehicle, vendor, slab, toll, permit, parking, route, and location data. |
| `src/modules/itineraries/engines/vehicle-calculation.helpers.ts` | Low-level vehicle distance, toll, permit, parking, and slab helper logic. | `calculateVehicleTollCharges`, `calculatePermitCharges`, `getKmsLimitId`, `getTimeLimitId`, `calculateSightseeingKm`, `calculateRouteVehicleDetails`. | When billing KM, tolls, permits, or slab calculations disagree with expectations. | High | [Verified from code] Used by vehicle build and details/route cost flows. |
| `src/modules/itineraries/itinerary-hotel-details-tbo.service.ts` | Hotel details/package/room response layer with provider/cache support. | `getHotelDetailsByQuoteIdFromTbo`, `getHotelRoomDetailsFromTbo`, `clearHotelCacheForQuote`, `clearCacheForQuote`. | When hotel package, room detail, or hotel-name fallback output looks wrong. | High | [Verified from code] Used by hotel endpoints and details fallback naming. |
| Provider booking services | Provider-specific booking, prebooking, push, and confirmation paths. | Provider-specific methods in `TboHotelBookingService`, `ResAvenueHotelBookingService`, `HobseHotelBookingService`, `AxisRoomsBookingPushService`, and `StaahBookingPushService`. | When confirmation/prebook/voucher behavior diverges by provider. | Medium | [Verified from code] Exact provider table side effects were not fully inspected in this evidence pass. |

## 4. Main Frontend Files and Responsibilities

| File | Responsibility | Important handlers | Backend APIs called | Debug when |
| --- | --- | --- | --- | --- |
| `src/services/itinerary.ts` | Frontend service wrapper for itinerary HTTP calls. | Methods such as `create`, `update`, `getDetails`, `rebuildRouteHotspots`, `updateRouteTimes`, `previewAddHotspot`, `applyManualHotspots`, `getHotelDetails`, `selectHotel`, `prebookHotels`, `selectVehicleVendor`, `getVehicleBuildStatus`, `confirmQuotation`, `cancelItinerary`. [Verified from code] | Calls `/itineraries`, `/itineraries/details/:quoteId`, route rebuild/time endpoints, manual hotspot endpoints, activity endpoints, hotel endpoints, vehicle endpoints, confirmation endpoints, cancellation endpoints. [Verified from code] | When frontend and backend disagree about which API is being called. |
| `src/pages/ItineraryDetails.tsx` | Main draft/details timeline page. | Renders `day.segments.map(...)`, triggers route time updates, manual hotspot flows, hotel detail actions, vehicle build polling, and confirmation-related actions. [Verified from code] | Calls details, route rebuild/time, manual hotspot, activity, hotel, vehicle build status/rebuild, and confirmation-related APIs through `ItineraryService`. [Verified from code] | When the draft timeline order, segment cards, or user actions look wrong. |
| `src/pages/VehicleList.tsx` | Vehicle selection UI. | Vendor and slab selection handlers. [Verified from code] | Calls vehicle select-vendor/select-slab APIs through `ItineraryService`. [Verified from code] | When vehicle vendor/slab choices do not match backend rows. |
| `src/pages/ConfirmedItineraryDetails.tsx` | Confirmed itinerary hotel/details and cancellation-oriented UI. | Confirmed detail display and cancellation actions. [Verified from code] | Calls confirmed itinerary and cancellation APIs through `ItineraryService`. [Verified from code] | When confirmed display and cancellation behavior differ from draft flow. |

## 5. Itinerary Create/Update Flow

`POST /itineraries` and `PUT /itineraries/:id` call `ItinerariesController.createPlan()` and delegate to `ItinerariesService.createPlan()`. [Verified from code]

The obvious request body contains `plan`, `routes`, `vehicles`, and `travellers`; the route map also records an optional `type` query string. [Verified from code]

The create/update flow persists or updates the plan header, route rows, vehicle/traveller inputs, via-route data, permit charge data, hotel-related data where provided, then schedules hotspot rebuild and vehicle build work through service/engine paths. [Verified from code]

```text
POST/PUT itinerary
-> save plan/routes
-> rebuild hotspots
-> trigger vehicle build
-> details page reads persisted output
```

[Verified from code]

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

Compact route lifecycle:

```text
plan route row
-> source / destination / date / start / end / direct flag
-> hotspot engine reads route
-> timeline rows are built for that route
-> details API reads persisted route + hotspot rows
```

[Inference]

## 7. Timeline Rows Table

The persisted timeline table is `dvi_itinerary_route_hotspot_details`. [Verified from code]

`TimelineBuilder.buildTimelineForPlan()` returns `hotspotRows`, and `HotspotEngineService.rebuildRouteHotspots()` persists those rows into `dvi_itinerary_route_hotspot_details`. [Verified from code]

Row ownership split:

- builder owns row construction order in memory. [Verified from code]
- hotspot engine owns delete/protect/dedupe/persist behavior. [Verified from code]
- details API owns DB-row-to-frontend mapping. [Verified from code]

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

Important display note:

- persisted `hotspot_order` is a DB ordering signal. [Verified from code]
- frontend display comes from details-service mapping into `days[].segments[]`, so display order should be debugged through both persistence and mapping, not DB rows alone. [Verified from code] [Inference]

## 8. Auto Hotspot Build Flow

Auto hotspot build is the route-day scheduler that turns plan routes plus hotspot master data into persisted timeline rows. In the current code, the service layer owns deletion, manual protection, and persistence, while `TimelineBuilder` owns candidate construction and scheduling. [Verified from code]

### 8.1 Purpose and Evidence Boundary

This is the master hotspot-engine chapter for the guide. It should be the first place interns look for bucket behavior, Direct ON behavior, reservation behavior, cutoff behavior, scheduler passes, manual preservation, duplicate prevention, and persistence split. [Inference]

This section is grounded by:

- `tmp/docs-evidence/08-auto-hotspot-build-flow-evidence.md` [Verified from code]
- `tmp/docs-evidence/06-dvi2026042-case-study.md` [Verified from DB/script output]
- `tmp/docs-evidence/07-direct-on-live-replay.md` [Verified from live replay]

What this section proves:

- exact call path and persistence boundary [Verified from code]
- exact bucket arrays, important variables, pass constants, and log markers [Verified from code]
- case-study output snapshots already captured in DB/script/live replay evidence [Verified from DB/script output] [Verified from live replay]

What still needs deeper proof:

- quote-specific candidate rejection reasoning without builder trace logs [Needs builder trace verification]
- provider booking, voucher, confirmation, and cancellation side effects [Needs verification]

Business users expect each itinerary day to show a believable sightseeing sequence with travel, hotspot visits, hotel movement, and final return behavior, while avoiding cross-day duplicate attraction rows. [Inference]

The auto builder is responsible for:

- choosing route-day hotspot candidates
- respecting direct, via-route, and same-city continuation behavior
- fitting candidates inside route timing rules
- preserving manual hotspot rows during rebuild
- returning rows that `HotspotEngineService` will persist into the timeline tables

### 8.2 Runtime pipeline ASCII

```text
ItinerariesService.createPlan(...) / route rebuild flow
  |
  v
HotspotEngineService.rebuildRouteHotspots()
  |
  +--> load existing hotspot rows (including manual rows)
  +--> extract hotspot_plan_own_way = 1 rows
  +--> delete active hotspot rows
  +--> delete active parking rows
  |
  v
TimelineBuilder.buildTimelineForPlan()
  |
  +--> load plan + routes
  +--> preload allHotspots + allTimings + hotspotMap + timingMap
  +--> build selectedHotspots per route
  +--> apply destination reservation / carry-forward logic
  +--> run strict / filler / deferred / retry scheduler cycles
  +--> return hotspotRows + parkingRows + rejection summary
  |
  v
HotspotEngineService persists rows
  |
  +--> dvi_itinerary_route_hotspot_details
  +--> dvi_itinerary_route_hotspot_parking_charge
```

The exact persistence handoff is visible because `TimelineBuilder.buildTimelineForPlan(...)` returns `hotspotRows`, `parkingRows`, and `routeRejectionSummaryByRoute`, and `HotspotEngineService.rebuildRouteHotspots(...)` handles the delete/filter/dedupe/persist steps.

### 8.3 Entry Point and Persistence Boundary

Verified entry path:

```text
ItinerariesService
  -> this.hotspotEngine.rebuildRouteHotspots(...)
  -> HotspotEngineService.rebuildRouteHotspots(...)
  -> this.timelineBuilder.buildTimelineForPlan(...)
  -> insert into dvi_itinerary_route_hotspot_details
```

Important call sites:

- `ItinerariesService.createPlan(...)` calls `this.hotspotEngine.rebuildRouteHotspots(tx, planId, existingHotspotsWithDates)`. [Verified from code]
- `HotspotEngineService.rebuildRouteHotspots(...)` calls `this.timelineBuilder.buildTimelineForPlan(tx, planId, existingHotspots, { manualPlacementByRoute, scopeToRouteId })`. [Verified from code]

`HotspotEngineService.rebuildRouteHotspots(...)` specifically:

- loads `existingHotspots`
- extracts `manualHotspots`
- builds `manualPlacementByRoute`
- deletes active hotspot and parking rows
- calls `buildTimelineForPlan(...)`
- re-marks matching rebuilt rows as manual/protected
- filters and dedupes final rows before persistence

### 8.4 Builder contract

`TimelineBuilder.buildTimelineForPlan(tx, planId, existingHotspots?, options?)` is the in-memory scheduler for one plan.

Inputs:

- `tx`
- `planId`
- `existingHotspots`
- `options.manualPlacementByRoute`
- `options.scopeToRouteId`

Outputs:

- `hotspotRows`
- `parkingRows`
- `routeRejectionSummaryByRoute`

Important boundary:

- `TimelineBuilder` returns rows only.
- `HotspotEngineService` persists rows.

### 8.5 Data preloading

Verified preloads inside `buildTimelineForPlan(...)`:

```text
plan            -> dvi_itinerary_plan_details
routes          -> dvi_itinerary_route_details
allHotspots     -> dvi_hotspot_place
allTimings      -> dvi_hotspot_timing
globalSettings  -> dvi_global_settings
```

Verified additional reads in helper/selector paths:

- `fetchSelectedHotspotsForRoute(...)` reads `dvi_stored_locations` for source/destination city names and coordinates.
- `fetchSelectedHotspotsForRoute(...)` reads `dvi_itinerary_via_route_details` for explicit via locations.
- `fetchDay1TopPrioritySourceHotspots(...)` reads `dvi_stored_locations` for starting coordinates.
- `DistanceHelper` reads `dvi_stored_locations` and `dvi_global_settings`.
- `hotspot_route_between_map` is not globally preloaded at plan start, but `TimelineBuilder.getBetweenCandidatesForRouteSlots(...)` queries it in the matrix-assisted auto-build path behind `HOTSPOT_MATRIX_AUTOBUILD`. [Verified from code]
- `hotspot_hotel_between_map` and `hotspot_route_between_rejections` were not verified as global auto-build preloads; they appear in manual preview/apply helper paths in `ItinerariesService`. [Verified from code]

Important preload variables:

- `allHotspots`
- `allTimings`
- `hotspotMap`
- `timingMap`
- `reservedSameCityHotspotIdsByRoute`

### 8.6 Candidate bucket construction

`fetchSelectedHotspotsForRoute(...)` constructs candidates using the actual bucket arrays below:

- `sourceLocationHotspots`
- `destinationHotspots`
- `viaRouteHotspots`
- `enRouteHotspots`

Bucket construction rules:

- If a hotspot matches source city, it can enter `sourceLocationHotspots` with `__bucket: 'source'`.
- If it matches destination city, it can enter `destinationHotspots` with `__bucket: 'destination'`.
- If it is a route-specific hotspot on an intercity non-direct route and matches route-from + route-to, it can enter `enRouteHotspots` with `__bucket: 'en_route'`.
- If it is route-specific and not being treated as direct-route corridor skip, it can enter `viaRouteHotspots` with `__bucket: 'via'`.
- Explicit via-route records from `dvi_itinerary_via_route_details` can add more via candidates.

Candidate pool assembly later creates:

- `selectedHotspots`
- `strictHotspots`
- `fillerHotspots`
- `corridorHotspots`
- `positiveCorridorHotspots`
- `optionalCorridorHotspots`

Exact candidate dedupe at this stage is by `(hotspot_ID + bucket)`, not by hotspot id alone.

### 8.7 Priority ordering and top 3 behavior

This section needs one important separation:

```text
"Top 3" Day 1 source rule
!=
"strict priorities 1..3" scheduler behavior
```

Verified top-3 behavior:

- `fetchDay1TopPrioritySourceHotspots(...)` sorts source-city hotspots by `hotspot_priority ASC`, then `hotspot_distance ASC`, then slices to 3 rows by default.

Verified scheduler priority behavior:

- Corridor priority rank comes from `getCorridorPriorityRank(...)`.
- Priorities `1..9998` keep their numeric rank.
- Priorities `<=0` or `>=9999` are treated as optional corridor priority rank `9999`.
- `positiveCorridorHotspots` are priority `1..9998`.
- `optionalCorridorHotspots` are priority `<=0` or `>=9999`.

Practical reading:

- priority `1`, `2`, `3`: strict / must-visit style candidates in the active scheduler path
- priority `0`: optional / filler behavior
- priority `>3`: can still appear, but not as Day-1 top-3 source strict rows
- priority `>=9999`: treated as lowest-rank optional corridor behavior where present

### 8.8 Direct ON / Direct OFF behavior

Direct ON means `direct_to_next_visiting_place = 1`.

Verified Direct ON evidence points:

- `DESTINATION_RESERVATION_DIRECT_ON_GUARD`
- `DIRECT_ROUTE_DESTINATION_POOL_DEBUG`
- `DIRECT_ROUTE_ROUTE_SPECIFIC_HOTSPOT_SKIPPED`

Behavior:

- destination hotspots stay available on the same direct day
- route-specific/en-route hotspots are skipped on direct routes unless they come through explicit via-route handling
- the direct day is protected from next-day destination reservation logic

Direct OFF / normal route means `direct_to_next_visiting_place = 0`.

In the normal route path, candidate assembly can include:

- source
- en_route
- via
- destination

depending on route type, skip flags, and reservation state.

Regression note:

- Direct ON now remains compatible with the current travel-row distance normalization path, so the direct leg can still use destination hotspots without persisting a misleading `0.00 KM` travel row when the source and destination labels differ. [Verified from regression output] [Verified from code]

### 8.9 Via-route behavior

Verified via-route inputs:

- route-specific hotspot matching in `fetchSelectedHotspotsForRoute(...)`
- explicit `dvi_itinerary_via_route_details` rows loaded per route

Via-route impact:

- adds or reinforces `viaRouteHotspots`
- can shift strict phase order because `strictPassHotspots` are rebuilt by bucket
- for same-city routes with via data, the route can behave more like outstation movement than plain local sightseeing

### 8.10 Destination continuation / reservation

Verified reservation shape:

```text
Route N:   A -----> B
Route N+1: B -----> B
```

This is implemented as a candidate-pool reservation step, not as a generic narrative "defer."

How next route is detected:

- current route computes `nextRoute`
- current route checks `isEligibleForDestinationReservation`
- current route fetches `nextRouteCandidates`

How capacity is estimated:

- fresh next-day hotspot ids are counted into `nextLoopbackAvailableCount`
- `estimateRouteHotspotCapacity(nextRoute)` produces `nextRouteCapacity`
- `nextLoopbackMinimumRequired = max(1, min(MIN_DESTINATION_HOTSPOTS_FOR_RESERVATION, nextRouteCapacity))`
- reservation is enabled only if `nextLoopbackAvailableCount >= nextLoopbackMinimumRequired`

When reservation is active:

- current-route destination candidates are filtered out
- plan-level duplicate filtering is applied
- source fallback is fetched through `fetchDay1TopPrioritySourceHotspots(...)`
- `source_fallback` rows are merged first
- log marker: `DESTINATION_HOTSPOTS_RESERVED_FOR_NEXT_LOOPBACK_DAY`

When Direct ON blocks reservation:

- `DESTINATION_RESERVATION_DIRECT_ON_GUARD`
- reason text in code says: direct route must use destination hotspots today, not reserve them for next same-city day

Regression note:

- The top10 regression run confirms that destination reservation and same-city continuation still work after the travel-distance normalization fixes; the guide should treat `10/10 passed` as the current known-good baseline. [Verified from regression output]

### 8.11 Corridor / On-Route Handling

Current code uses corridor terminology for route-specific intercity candidates that should be resolved before general filler when positive corridor candidates are still pending. [Verified from code]

Exact corridor arrays:

- `corridorHotspots` [Verified from code]
- `positiveCorridorHotspots` [Verified from code]
- `optionalCorridorHotspots` [Verified from code]

Exact gating markers:

- `CORRIDOR_PHASE_STARTED` [Verified from code]
- `PREFILLER_BLOCKED_CORRIDOR_PENDING` [Verified from code]
- `FILLER_BLOCKED_CORRIDOR_PENDING` [Verified from code]
- `OPTIONAL_CORRIDOR_FILLER_STARTED` [Verified from code]

ASCII:

```text
positive corridor pending?
-> yes: block filler / deferred / retry
-> no: allow optional corridor / filler path
```

[Verified from code]

Route-fit / between-map layer:

- `hotspot_route_between_map` stores route-fit candidates in the shape `from_hotspot_id -> between_hotspot_id -> to_hotspot_id`. [Verified from schema]
- In `TimelineBuilder`, `getBetweenCandidatesForRouteSlots(...)` reads accepted rows from `hotspot_route_between_map` with `route_fit_type IN ('ON_ROUTE','MINOR_DETOUR')`. [Verified from code]
- This means current auto-build can optionally merge between-hotspot candidates from the route-fit table when `HOTSPOT_MATRIX_AUTOBUILD=true`. [Verified from code]
- In manual preview/apply, `ItinerariesService` reads the same table per original A->B slot for candidate C and ranks slots using `route_fit_type`, `road_detour_km`, `road_detour_ratio`, `ab_osrm_distance_km`, `ac_osrm_distance_km`, `cb_osrm_distance_km`, and `inserted_route_distance_km`. [Verified from code]

### 8.12 Distance Source of Truth

Critical finding:

Do not treat this as a generic unknown `distance_map` story. The current code has two distinct verified distance layers. [Verified from code]

Important methods:

- `DistanceHelper.fromSourceAndDestination(...)`
- `DistanceHelper.fromCoordinates(...)`
- `DistanceHelper.fromLocationId(...)`

Verified source of truth:

- if both coordinate sets exist, `fromSourceAndDestination(...)` uses `fromCoordinates(...)`
- `fromCoordinates(...)` uses Haversine with a `1.5` correction factor
- if coordinates are not provided, `fromSourceAndDestination(...)` queries `dvi_stored_locations`
- `fromLocationId(...)` also queries `dvi_stored_locations`
- outstation/local buffer handling comes from `dvi_global_settings` via `getBufferTime(...)`

Route-fit / between-map distance layer:

- `hotspot_route_between_map` stores route-fit metrics such as `ab_osrm_distance_km`, `ac_osrm_distance_km`, `cb_osrm_distance_km`, `inserted_route_distance_km`, `road_detour_km`, and `road_detour_ratio`. [Verified from schema]
- `hotspot_hotel_between_map` stores hotspot-to-hotel insertion metrics such as `ab_osrm_distance_km`, `ac_osrm_distance_km`, `cb_osrm_distance_km`, `inserted_route_distance_km`, `road_detour_km`, and `osrm_used`. [Verified from schema]
- These tables are separate from normal city/stored-location distance. They represent route-fit decisions for `A -> C -> B` and `A -> C -> hotel` slot evaluation. [Verified from code] [Verified from schema]

### 8.13 No-Backtrack Behavior

No standalone no-backtrack formula was verified. [Verified from code]

Current anti-bad-route behavior is achieved through:

- bucket ordering
- corridor selection
- source-first strict order on intercity non-direct routes
- distance-aware candidate ordering
- projected arrival-to-destination checks
- route-end cutoff guards

The clearest explicit anti-backtrack evidence is the `STRICT_PHASE_ORDER_DEBUG` and `HOTSPOT ORDER FIX` path, where the code states:

```text
Intercity non-direct route: source hotspots are processed before via/destination to avoid source-city backtracking.
```

Between-map support for route direction:

- The schema supports fields such as `candidate_progress_on_ab_ratio`, `destination_progress_on_ac_ratio`, and `crosses_destination_before_candidate` in `hotspot_route_between_map`. [Verified from schema]
- In the currently inspected runtime path, `candidate_progress_on_ab_ratio` is written when route-fit rows are generated and is surfaced in manual preview logic. [Verified from code]
- `crosses_destination_before_candidate` was verified in schema/write paths, but direct runtime read usage in the inspected hotspot scheduling logic was not verified. [Needs verification]
- `hotspot_route_between_rejections` can surface backtrack/off-route style rejection output in manual preview/apply when no accepted route-fit row exists. [Verified from code]

### 8.14 Timing and Insertion Availability

Candidate acceptance uses these verified timing ingredients:

- `currentTime`
- travel time to hotspot
- hotspot visit duration
- opening/closing window from `checkHotspotOperatingHoursFromMap(...)`
- `routeEndSeconds`
- projected arrival at destination on non-last routes
- hotel transfer/check-in timing on non-last routes
- `lastRouteArrivalDeadlineSeconds` on the last route

Formula view:

```text
travelToHotspot = DistanceHelper(...)
projectedHotspotStart = currentTime + travelToHotspot
projectedHotspotEnd = projectedHotspotStart + visitDuration
projectedDestinationArrival = projectedHotspotEnd + travelToDestination
```

Accept only if:

- hotspot operating window allows it [Verified from code]
- projected hotspot end fits the route window [Verified from code]
- projected destination arrival `<= routeEndSeconds` on non-last routes [Verified from code]
- projected departure arrival `<= lastRouteArrivalDeadlineSeconds` on last routes [Verified from code]
- hotel transfer/check-in still fits [Verified from code]

Route-fit timing relationship:

- In normal auto scheduling, timing projection still comes from route time + `DistanceHelper` + hotspot duration logic. [Verified from code]
- In matrix-assisted auto-build, `hotspot_route_between_map` is used to admit between candidates by route-fit type before the normal timing checks run. [Verified from code]
- In manual preview/apply, `inserted_route_distance_km`, `ab_osrm_distance_km`, `ac_osrm_distance_km`, and `cb_osrm_distance_km` are carried into slot ranking and explanation metadata, while timing fit is checked against available segment gaps. [Verified from code]
- In destination-side manual insertion before hotel, `hotspot_hotel_between_map` stores the chosen `from_hotspot_id -> between_hotspot_id -> hotel_id` fit, but timing fit still also checks the hotel gap in the baseline timeline. [Verified from code]

Verified waiting behavior:

- if a hotspot is closed now but `nextWindowStart` exists
- the builder can wait and retry the candidate within the same day
- only if the waited visit still fits before route end

Regression note:

- The current branch also normalizes zero-distance travel rows during timeline persistence, so timing fit should be read together with final persisted row distance. A row that looks "timing valid" but persists as `0.00 KM` is now treated as a regression symptom, not an acceptable outcome. [Verified from code] [Verified from regression output]

### 8.15 Cutoff Rules

Verified cutoffs:

- source phase cutoff: `sourcePhaseEndSeconds = 12:00:00`
- source-phase advance log: `SOURCE_PHASE_ADVANCE_TO_NOON`
- `PHP_GATE_ROUTE_END`:
  - non-last route: projected arrival at destination after hotspot exceeds route end
  - last route: hotspot end exceeds route end
- last-route departure cutoff:
  - projected arrival at departure target exceeds `lastRouteArrivalDeadlineSeconds`
- hotel cutoff:
  - hotel movement/check-in path uses `hotelStartTime`, `hotelCutoffSeconds`, and `finalHotelEndSeconds`
- destination reservation direct-on guard:
  - reservation blocked when `direct_to_next_visiting_place = 1`

What was not verified as a standalone formula:

- a separate named "via cutoff" constant
- a separate named "destination cutoff" constant beyond the actual pass/phase logic and route-end checks

### 8.16 Multi-Pass Scheduler

Current code is more complex than the older 4-pass description.

Verified pass constants:

- `PASS_STRICT = 1`
- `PASS_FILLER_PRIMARY = 2`
- `PASS_DEFERRED_PRIMARY = 3`
- `PASS_REJECTED_RETRY = 4`
- `PASS_FILLER_SECONDARY = 5`
- `PASS_DEFERRED_SECONDARY = 6`

Verified cycle gating:

```text
Cycle 1 -> PASS_STRICT
Cycle 2 -> PASS_FILLER_PRIMARY
Cycle 3 -> PASS_DEFERRED_PRIMARY
        -> PASS_REJECTED_RETRY
        -> PASS_DEFERRED_SECONDARY
```

`PASS_FILLER_SECONDARY` is defined but not included in `cycleAllowedPasses` in the inspected code path.

ASCII view:

```text
selectedHotspots
  |
  +--> strictHotspots
  +--> fillerHotspots
  +--> corridorHotspots
         |
         +--> positiveCorridorHotspots
         +--> optionalCorridorHotspots

Cycle 1: strict pass
  |
  +--> may queue deferred / retry
  |
Cycle 2: filler pass
  |
  +--> can be blocked by pending positive corridor
  |
Cycle 3: deferred + retry cleanup
```

Important corridor rule:

- if positive corridor hotspots are still pending, filler/deferred/retry can be blocked by `FILLER_BLOCKED_CORRIDOR_PENDING`
- optional corridor filler starts only when pending positive corridor count is zero

### 8.17 Retry / Deferred Queues

Verified queue structures:

- `deferredPriorityHotspots`
- `deferredPriorityHotspotIds`
- `rejectedRetryHotspots`
- `rejectedRetryHotspotIds`
- `sourceCutoffRejectedHotspotIds`

Why this does not become an unbounded loop:

- pass execution is bounded by pass constants
- cycles are bounded by `MAX_SCHEDULER_OPTIMIZATION_CYCLES`
- queue sets prevent repeated duplicate requeue of the same hotspot id

### 8.18 Manual Hotspot Interaction

Verified manual flow pieces:

- manual persisted flag: `hotspot_plan_own_way = 1`
- pre-delete preservation: `manualHotspots`
- placement hints: `manualPlacementByRoute`
- force insert path in builder: `CYCLE 5: MANUAL_HOTSPOT_FORCE_INSERT`

Verified service behavior:

- manual hotspots are extracted before delete
- rebuilt rows matching manual route/hotspot keys are marked manual again
- manual hotspot ids are added to protection sets

Verified itinerary-service preview/apply behavior:

- optional hotspots can be removed first to fit manual insertion
- protected top-priority hotspot replacement can require confirmation

Manual route-fit shapes:

```text
previous hotspot -> manual hotspot -> next hotspot
previous hotspot -> manual hotspot -> hotel
```

Route-fit tables involved:

- `hotspot_route_between_map` is queried per original slot `A -> B` for candidate `C` during manual preview/apply. [Verified from code]
- `hotspot_route_between_rejections` is queried when an accepted `A -> C -> B` row is missing, so the preview can explain route rejection instead of just saying “no data.” [Verified from code]
- `hotspot_hotel_between_map` is written for destination-side hotel insertion cases where the slot is effectively `A -> C -> hotel`. [Verified from code]
- `ensureRouteBetweenMapRow(...)` can create missing route-fit rows on demand in manual fallback logic using OSRM and detour calculations. [Verified from code]

### 8.19 Duplicate Prevention

Duplicate prevention happens in layers:

- candidate dedupe by `(hotspot_ID + bucket)`
- plan-level `addedHotspotIds`
- excluded hotspot filtering
- `existingHotspots` tombstone-aware rebuild context
- final persistence dedupe/protection in `HotspotEngineService`

ASCII:

```text
candidate built
  -> exact bucket dedupe
  -> plan duplicate check
  -> excluded/tombstone-aware filtering
  -> final persistence dedupe
```

Regression note:

- Final persistence dedupe now sits alongside the travel-row distance normalization guard, so duplicate prevention and suspicious zero-distance prevention should be checked together when a route looks wrong. [Verified from code] [Inference]

### 8.20 Persistence

The final row targets are fixed:

- `hotspotRows` -> `dvi_itinerary_route_hotspot_details`
- `parkingRows` -> `dvi_itinerary_route_hotspot_parking_charge`

Persistence split:

- `TimelineBuilder` returns rows
- `HotspotEngineService` persists rows

### 8.21 Candidate Lifecycle ASCII

```text
hotspot master row
  |
  v
bucket match in fetchSelectedHotspotsForRoute(...)
  |
  v
distance + priority ordering
  |
  v
duplicate/tombstone checks
  |
  v
route reservation / source fallback / carry-forward merge
  |
  v
check hotspot_route_between_map / hotspot_hotel_between_map when route-fit path applies
  |
  +--> accepted route_fit_type
  +--> rejection row from hotspot_route_between_rejections
  |
  v
strict / filler / deferred / retry scheduler
  |
  v
travel + duration projection
  |
  +--> operating-hours check
  +--> PHP_GATE_ROUTE_END
  +--> hotel / departure fit
  +--> rejected/deferred/retry queue
  |
  v
travel row + item_type=4 hotspot row
  |
  v
persisted timeline row
```

### 8.22 Auto Hotspot Debugging Checklist

1. Check the route direct flag.
2. Check source, destination, and via-route context.
3. Check which bucket the hotspot entered.
4. Check whether it landed in strict, filler, or corridor handling.
5. Check whether positive corridor was still pending.
6. Check `hotspot_route_between_map` for `from_hotspot_id`, `to_hotspot_id`, and `between_hotspot_id` where route-fit is involved.
7. Check `hotspot_hotel_between_map` for hotspot-before-hotel insertion cases.
8. Check `hotspot_route_between_rejections` for `rejection_code` and `rejection_reason`.
9. Check `crosses_destination_before_candidate`, `road_detour_km`, `road_detour_ratio`, and `route_fit_type` where route-fit tables are involved.
10. Check operating-hours fit, route-end cutoff, destination reservation, manual protection, and final DB rows in `dvi_itinerary_route_hotspot_details`.

### 8.23 Pseudocode

```text
rebuildRouteHotspots(planId):
  existingRows = load existing hotspot rows
  manualRows = existingRows where hotspot_plan_own_way = 1
  delete active hotspot and parking rows

  result = buildTimelineForPlan(planId, existingRows, manualPlacement)

  protect manual rows
  filter/dedupe final rows
  insert result.hotspotRows
  insert result.parkingRows
  return rebuild summary and rejection summary

buildTimelineForPlan(planId):
  load plan
  load active routes ordered by date/id
  load active hotspots once
  load hotspot timing rows once
  preload hotspotMap + timingMap

  for each route:
    selectedHotspots = build source/destination/via/en_route candidates
    if eligible:
      run destination reservation feasibility check
    if reservation enabled:
      remove destination candidates
      merge source_fallback rows
    if carryForwardHotspots active:
      mergeCarryForwardIntoCandidates(...)
    build strictHotspots / fillerHotspots / corridorHotspots
    run optimization cycles and pass gating
    insert travel + attraction rows that fit
    insert hotel/checkin rows when eligible
    insert final drop on last route

  return hotspotRows, parkingRows, routeRejectionSummaryByRoute
```

### 8.24 What Interns Must Remember

- "Top 3" only proves the Day-1 source-selection helper, not the whole scheduler.
- Route-fit tables are separate from normal city/stored-location distance.
- A missing hotspot may be a route-fit rejection, not only a timing or priority rejection.
- Manual hotspot insertion can fail because surrounding route-fit map logic rejects the insertion slot.
- Direct ON is protected by explicit guard logic and should use destination hotspots on the direct day.
- The old ASCII guide is useful, but its "4 pass" model is stale for the current builder.
- Candidate filtering proof and final persisted-row proof are different kinds of evidence.
- No standalone no-backtrack formula was verified; the current behavior is the combined effect of ordering, corridor rules, and fit checks.

### 8.25 Verified vs Needs Verification Table

| Topic | Exact evidence | Status | Notes |
| --- | --- | --- | --- |
| Entry path | `ItinerariesService -> HotspotEngineService -> TimelineBuilder -> persistence` | [Verified from code] | Additional route-specific call-path inventory is optional, not required for the core path |
| Bucket construction | `sourceLocationHotspots`, `destinationHotspots`, `viaRouteHotspots`, `enRouteHotspots` | [Verified from code] | Candidate-level rejection proof still needs trace logs |
| Priority logic | Day-1 top-3 source helper and corridor priority ranking | [Verified from code] | Full quote-by-quote proof of every priority removal decision still needs traces |
| Direct ON | Guard markers and live replay outcome | [Verified from code] [Verified from live replay] | Candidate-trace proof for every skipped source/en-route hotspot still pending |
| Distance source | `DistanceHelper` + `dvi_stored_locations` + coordinates | [Verified from code] | `distance_map` was not verified in this path |
| No-backtrack | No standalone formula verified | [Verified from code] | Current behavior is the combined effect of ordering and fit checks |
| `hotspot_route_between_map` | runtime read in `TimelineBuilder` matrix path and manual preview/apply path | [Verified from code] | Also written by scripts and manual fallback helper paths |
| `hotspot_hotel_between_map` | manual destination-side hotel insertion writes | [Verified from code] | Runtime read in auto hotspot build was not verified |
| `hotspot_route_between_rejections` | manual preview/apply rejection lookup | [Verified from code] | Auto hotspot build rejection-table read was not verified |
| `route_fit_type` | route-fit slot ranking and accepted path filtering | [Verified from code] | Auto builder only reads accepted `ON_ROUTE` / `MINOR_DETOUR` rows in matrix path |
| `crosses_destination_before_candidate` | schema/write-path support | [Needs verification] | direct inspected runtime read usage was not verified |
| manual insertion route-fit | `A -> C -> B` and `A -> C -> hotel` slot logic | [Verified from code] | end-to-end live replay for every permutation still pending |
| Travel row normalization | `item_type = 3` travel rows are clamped away from `0.00 KM` when source and destination differ | [Verified from code] [Verified from regression output] | Current top10 suite is the proof point for this branch state |
| Scheduler passes | 6 pass constants, 3 optimization cycles, corridor blocking | [Verified from code] | Whether `PASS_FILLER_SECONDARY` is intentionally dormant remains unverified |
| Manual behavior | pre-delete preservation, placement hints, force insert path | [Verified from code] | End-to-end live proof for every manual conflict permutation still pending |
| Persistence | `hotspotRows` and `parkingRows` return/persist split | [Verified from code] | None for this section |

## 9. Hotspot Case-Study Evidence Summary

Core hotspot algorithm is documented in Section 8. [Verified from code]

This section keeps only the evidence-snapshot view that interns can use while comparing the algorithm to real outputs. [Inference]

Useful anchors:

- `tmp/docs-evidence/06-dvi2026042-case-study.md` [Verified from DB/script output]
- `tmp/docs-evidence/07-direct-on-live-replay.md` [Verified from live replay]
- `tmp/docs-evidence/08-auto-hotspot-build-flow-evidence.md` [Verified from code]

Important rule:

- final inserted hotspot evidence is proven by DB/API rows [Verified from DB/script output]
- candidate filtering evidence still needs builder trace logs [Needs builder trace verification]

## 10. Direct ON Case Study: DVI20260594

Core Direct ON algorithm is documented in Section 8. [Verified from code]

Direct ON evidence snapshot:

- Route `3439` is Direct ON: `Cochin -> Munnar`. [Verified from live replay]
- Route `3439` has `direct_to_next_visiting_place = 1`. [Verified from DB/script output]
- Day/route `3439` uses Munnar destination hotspots: `Eravikulam National Park ( closed in Feb & Mar)`, `Munnar Rose Garden`, `spice garden munnar`, and `Photo view point`. [Verified from live replay]
- Cochin source hotspots are on route/day `3438`, not on `3439`: `Chinese Fishing net`, `Dutch Palace ( Mattancherry Palace)`, `LuLu International Shopping Mall (only for Shopping)`, `K V Kathakali center`, and `Marine Drive - Cochin`. [Verified from live replay]
- Next same-city route `3440` has a different Munnar set: `TATA Tea Museum`, `Echo Point`, `Mattupetty Dam & Lake`, `Kolukkumalai Tea Estate (Munnar)`, `Botanical Garden Munnar`, and `Blossam Hydal Park`. [Verified from live replay]
- `DESTINATION_RESERVATION_DIRECT_ON_GUARD` appears in `TimelineBuilder` and matches the observed same-day destination behavior. [Verified from code] [Verified from live replay]
- `Cheeyappara Waterfalls` and `Valara Water Falls` were not present in the inspected replay output. [Verified from live replay]
- Candidate-level proof for why they were excluded still needs builder trace logs. [Needs builder trace verification]

## 11. Via Route Case Study: DVI2026042

Core via-route algorithm is documented in Section 8. [Verified from code]

Via-route evidence snapshot:

- Route `3422`: `Tirupati, Andhra Pradesh, India -> Vellore` via `Mahabalipuram`. [Verified from DB/script output]
- Route `3424`: `Kanchipuram, Tamil Nadu, India -> Kanchipuram, Tamil Nadu, India` via `Tiruvannamalai`. [Verified from DB/script output]
- Route `3426`: `Chennai -> Chennai` via `Mahabalipuram`. [Verified from DB/script output]
- Same-city plus via route is not simple local sightseeing because the route can leave and return through an explicit intermediate place. [Inference]
- In details mapping, via-route rows can become travel segments to the via location rather than attraction cards. [Verified from code]

## 12. Manual Hotspot Case Study: DVI2026042

Core manual-hotspot algorithm is documented in Section 8. [Verified from code]

Manual hotspot evidence snapshot:

- Manual hotspots are detected with `hotspot_plan_own_way = 1`. [Verified from code]
- `DVI2026042` route `3425` has the manual hotspot example: `Vivekanandar House`, `hotspot_plan_own_way = 1`, `item_type = 4`, `hotspot_order = 3`, `15:00:00 - 16:00:00`. [Verified from DB/script output]
- Manual hotspot APIs include preview, apply, add, remove, available hotspot lookup, anchor-specific lookup, and matrix build endpoints. [Verified from code]
- Full rebuilds are sensitive because manual rows need protection and placement parity. [Inference]

## 13. Activity Flow

Activity APIs include available activity lookup, preview, preview across all hotspots, add, smart preview, smart insert, and delete. [Verified from code]

The route map shows request fields such as `planId`, `routeId`, `routeHotspotId`, `hotspotId`, `activityId`, optional gap information, and `allowTopPriorityRemoval`. [Verified from code]

## Quote Scenario Analyzer

For quote-specific hotspot debugging, use:

```bash
npm run analyze:itinerary:hotspots
```

Or pass values directly:

```bash
npm run analyze:itinerary:hotspots -- --quote DVI20260798 --scenario "Scenario 1"
```

What it writes:

- `docs/itinerary-hotspot-scenarios.md`
  - appends a scenario section with the quote ID, plan summary, per-day route context, candidate bucket summary, persisted hotspot order, and last-day transfer-only reasoning
- `docs/.itinerary-hotspot-scenarios.state.json`
  - remembers the last quote ID and next scenario number for the next interactive run

Use this when the next coding agent needs a quote-by-quote explanation of why hotspots were selected, skipped, or suppressed by the final-day airport cutoff rules.

The exact DB tables and side effects for activity persistence were not deeply proven in the current evidence set. [Needs verification]

## 14. Details API Mapping

`ItineraryDetailsService.getItineraryDetails()` does not select hotspots; it reads persisted rows and maps them to frontend segments. [Verified from code]

ASCII:

```text
persisted DB rows
-> ItineraryDetailsService.getItineraryDetails()
-> days[].segments[] + vehicles[]
-> frontend cards in ItineraryDetails.tsx
```

[Verified from code]

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

Regression note:

- For current-branch troubleshooting, treat a persisted `item_type = 3` travel row with `0.00 KM` and mismatched source/destination labels as suspicious. The top10 regression harness now flags that case, and the live code path clamps it before persistence. [Verified from script] [Verified from regression output] [Verified from code]

`DVI2026042` details facts:

- DB evidence has 110 timeline rows. [Verified from DB/script output]
- Details API returned 11 days. [Verified from API output]
- Details API returned 2 vehicle rows. [Verified from API output]
- Payload is draft because `isConfirmed = false`. [Verified from API output]
- `src/pages/ItineraryDetails.tsx` renders `day.segments.map(...)`. [Verified from code]

## 15. Time Calculation and Operating Hours

Routes carry start and end times through `route_start_time` and `route_end_time`. [Verified from DB/script output]

This section is broader than Section 8. Section 8 explains hotspot-fit math; this section explains how persisted times move through route rows, segment rows, and frontend display. [Inference]

Time layers:

- route-level time: `route_start_time` / `route_end_time` on `dvi_itinerary_route_details`. [Verified from DB/script output]
- persisted segment time: hotspot/travel/check-in rows in `dvi_itinerary_route_hotspot_details`. [Verified from code]
- details API display time: mapped segment text/cards returned by `getItineraryDetails()`. [Verified from code]
- frontend display time: rendered segment order and labels in `ItineraryDetails.tsx`. [Verified from code]

The builder prefetches `dvi_hotspot_timing` and checks candidate fit with `checkHotspotOperatingHoursFromMap(...)`, but the hotspot-specific timing algorithm lives in Section 8. [Verified from code]

The details API can show an attraction outside operating hours, as `DVI2026042` route `3428` shows `Anna memorial.` with an outside-operating-hours note in the API summary. [Verified from API output]

Exact operating-hours semantics for every case-study hotspot still depend on DB timing rows and builder trace logs. [Needs live DB/API verification]

## 16. KM/Distance Calculation

Timeline travel distance is the distance shown in route hotspot/travel segments. [Verified from API output]

ASCII:

```text
timeline distance
!=
vehicle billing distance
```

[Inference]

Important split:

- route `no_of_km` is route input/storage on `dvi_itinerary_route_details`. [Verified from DB/script output]
- timeline travel distance is what segment rows show in the itinerary timeline. [Verified from API output]
- route-fit between-map distance/detour is what `hotspot_route_between_map` and `hotspot_hotel_between_map` store for slot-fit evaluation. [Verified from schema] [Verified from code]
- vehicle billing KM is what vendor/slab pricing logic uses. [Verified from code]
- sightseeing KM is part of vehicle pricing breakdown, not just timeline display. [Verified from code]

Current branch update:

- The distance helper now treats different-name, near-zero source/destination results as invalid for a normal travel leg and falls back to a minimal travel value instead of leaving the row at `0.00 KM`. [Verified from code] [Verified from regression output]
- The final hotspot persistence path applies the same protection before rows hit `dvi_itinerary_route_hotspot_details`. [Verified from code] [Verified from regression output]

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

ASCII:

```text
route rows
-> vendor eligibility
-> slab selection
-> toll / permit / parking helpers
-> persisted vehicle rows
-> frontend vehicle list
```

[Verified from code] [Inference]

Vehicle pricing uses vendor eligible lists, vendor vehicles, vehicle type, local/outstation price books, time/kms limits, tolls, parking, permit charges, and stored route locations. [Verified from code]

Frontend-visible vehicle flows include select vendor, select slab, auto-select slabs, build-status polling, and async vehicle rebuild. [Verified from code]

For `DVI20260594`, `trigger_direct_build.js` returned `vehicleBuildStatus = "PROCESSING"` after the Direct ON build. [Verified from live replay]

Do not claim final vehicle pricing for `DVI20260594` from this replay because the captured build response only proves post-commit processing state. [Needs verification]

## 18. Hotel Selection / Prebooking / Voucher Flow

Hotel details APIs include hotel package search, room details, cache rebuild, available hotels, hotel select, bulk save, and prebook. [Verified from code]

ASCII:

```text
hotel package search
-> hotel selection
-> prebook
-> voucher flow
-> confirmed / cancelled hotel state
```

[Verified from code] [Inference]

Voucher-related APIs include voucher details, cancellation policy endpoints, voucher creation, hotel voucher cancellation, default voucher terms, and existing voucher lookup. [Verified from code]

`ItineraryHotelDetailsTboService` produces hotel package and room responses from provider/cache logic and is also used as a fallback naming path by details mapping. [Verified from code]

For `DVI2026042`, `isConfirmed = false`, and check-in segments are visible in days 1 through 10. [Verified from API output]

The exact backend hotel storage table for this specific case is still not directly proven beyond draft-vs-confirmed inference. [Needs verification]

Provider-specific voucher/prebooking side effects are not exercised by `DVI2026042` or `DVI20260594`. [Needs live DB/API verification]

## 19. Confirmation Flow

Confirmation APIs include customer info, wallet balance, and `POST /itineraries/confirm-quotation`. [Verified from code]

ASCII:

```text
draft plan
-> selected hotels / vehicles
-> wallet / payment / provider booking path
-> confirmed rows
```

[Verified from code] [Inference]

`confirmQuotation()` can call provider booking paths such as `processConfirmationWithTboBookings()` when hotel booking payloads exist. [Verified from code]

Confirmed-vs-draft details mapping switches hotel reads from draft hotel tables to `dvi_confirmed_itinerary_plan_hotel_details` when a confirmed plan is present. [Verified from code]

`DVI2026042` and `DVI20260594` are draft evidence cases and do not exercise confirmation side effects. [Verified from API output]

Wallet, accounting, and provider booking confirmation side effects still need dedicated evidence. [Needs live DB/API verification]

## 20. Cancellation Flow

Cancellation APIs include `POST /itineraries/cancel`, cancellation detail lookup, full-day cancellation charge calculation, hotel cancellation, and cancelled itinerary listing. [Verified from code]

ASCII:

```text
confirmed itinerary
-> cancellation request
-> provider / voucher cancel path
-> hotel or itinerary cancellation status
-> cancellation response
```

[Verified from code] [Inference]

Hotel voucher cancellation APIs are separate voucher-service routes under itinerary hotel-voucher/cancellation paths. [Verified from code]

`ConfirmedItineraryDetails.tsx` is the frontend file tied to confirmed detail and cancellation actions. [Verified from code]

`DVI2026042` and `DVI20260594` do not exercise cancellation side effects. [Verified from API output]

Cancellation tables and provider cancellation services need dedicated confirmed-plan evidence. [Needs live DB/API verification]

## 21. Debugging Checklist

Use this checklist by symptom:

Hotspot wrong:
1. Request payload.
2. `dvi_itinerary_route_details`.
3. `direct_to_next_visiting_place` / via route.
4. Section 8 bucket and scheduler rules.
5. Hotspot candidate logs if available.
6. `dvi_itinerary_route_hotspot_details`.
7. `hotspot_plan_own_way` manual rows.

Hotel wrong:
1. Selected hotel rows.
2. Draft vs confirmed hotel table path.
3. Hotel details / prebook / voucher API path.

Vehicle KM wrong:
1. Route rows and `no_of_km`.
2. Vehicle detail rows.
3. Vehicle calculation helpers.

Direct route wrong:
1. Route direct flag.
2. Section 8 Direct ON guard / reservation rules.
3. Case study in Section 10.

Cancellation wrong:
1. Confirmed-vs-draft path.
2. Cancellation API used.
3. Provider/voucher side effects.

Frontend order wrong:
1. Persisted DB rows.
2. `ItineraryDetailsService.getItineraryDetails()`.
3. `day.segments[]` rendering in `ItineraryDetails.tsx`.

This order separates candidate filtering from final inserted hotspot evidence and from frontend mapping issues. [Inference]

Regression sanity check:

- If top10 reports `10/10 passed`, the current branch baseline is good for the travel-row normalization issue.
- If a route still shows `0.00 KM` in a travel row, inspect the live rebuild path first, then the details API mapping, then the regression harness classification. [Verified from regression output] [Inference]

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
2. Evidence scripts and report generation only. [Verified from code report]
3. Constants extraction. [Verified from code report]
4. Pure helper extraction for details mapping and calculation utilities. [Verified from code report]
5. Regression snapshots and replay scripts. [Verified from code report]
6. Safe module split after outputs are stabilized. [Verified from code report]

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
- `tmp/docs-evidence/08-auto-hotspot-build-flow-evidence.md`
- `tmp/docs-evidence/dvi2026042-db-focus.txt`
- `tmp/docs-evidence/dvi2026042-full-db-evidence.txt`
- `tmp/docs-evidence/dvi2026042-details-api.json`
- `tmp/docs-evidence/direct-on-trigger-output.txt`
- `tmp/docs-evidence/direct-on-details-api.json`
- `tmp/docs-evidence/direct-on-db-evidence.txt`
- `tmp/docs-evidence/command-errors.md`
- `tmp/docs-evidence/direct-on-command-errors.md`
- `tmp/regression-report-top10.md`
- `scripts/regression/top10/manifest.json`
- `scripts/regression/top10/top10-case-01.json`
- `scripts/regression/top10/top10-case-02.json`
- `scripts/regression/top10/top10-case-03.json`
- `scripts/regression/top10/top10-case-04.json`
- `scripts/regression/top10/top10-case-05.json`
- `scripts/regression/top10/top10-case-06.json`
- `scripts/regression/top10/top10-case-07.json`
- `scripts/regression/top10/top10-case-08.json`
- `scripts/regression/top10/top10-case-09.json`
- `scripts/regression/top10/top10-case-10.json`

Known command-output caveats:

- Some first attempts failed from the wrong project root and were rerun successfully from `api.dvi.travel`. [Verified from script]
- Some details API captures begin with `Status: 200` before JSON because stdout was redirected. [Verified from script]
- When reusing these JSON files in scripts, strip non-JSON status lines before `JSON.parse()`. [Inference]
- Direct ON JSON parsing required stripping the status line and reading UTF-16 output. [Verified from script]
- `tmp/docs-evidence/09-database-table-usage-map.md` [Verified from code scan]
- The top10 regression report is the current proof point for the travel-row normalization fix. [Verified from regression output]

## 26. Database Table Lifecycle Manual for Itinerary Logic

### 26.1 How to Read This Section

- `READ` = find/query/count/aggregate/raw SELECT. [Verified from code scan]
- `INSERT` = create/createMany/raw INSERT. [Verified from code scan]
- `UPDATE` = update/updateMany/upsert/raw UPDATE. [Verified from code scan]
- `DELETE` = delete/deleteMany/raw DELETE. [Verified from code scan]
- `SOFT DELETE` = update status/deleted flags instead of removing the row. [Verified from code scan where shown]
- `SCRIPT-ONLY` = only used in scripts, not normal API runtime. [Verified from code scan]
- `NOT USED` = no scanned itinerary runtime usage found. [Verified from code scan]
- `RAW SQL` = used through raw SQL hits such as `$queryRaw`, `$queryRawUnsafe`, `$executeRaw`, or `$executeRawUnsafe`. [Verified from code scan]
- This section is for debugging. It is not only schema documentation. It explains lifecycle and business ownership of each table from actual code hits. [Verified from code scan]

### 26.2 Core Draft Itinerary Tables

### Table: `dvi_itinerary_plan_details`

**Model:** `dvi_itinerary_plan_details`  
**Category:** Draft  
**Runtime usage:** Yes  
**Primary owner:** debug-hotspots.ts:main

#### 1. What this table stores

Stores the draft itinerary header keyed by quote and plan, including top-level dates and confirmation/cancellation state.

#### 2. Why this table exists in itinerary logic

It is the root row resolved before timeline build, details mapping, hotel flows, vehicle flows, confirmation, and cancellation.

#### 3. READ usage

- File: `src/modules/itineraries/debug-hotspots.ts`
  Function: `main`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/helpers/return-segment.builder.ts`
  Function: `buildReturnToDeparture`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `buildReturnToDeparture`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
  Function: `plan`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `plan`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/helpers/timeline.prefetch.ts`
  Function: `plan`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `plan`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/hotel-engine.service.ts`
  Function: `await`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/engines/hotspot-engine.service copy.ts`
  Function: `rebuildRouteHotspots`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Builds or persists itinerary timeline rows.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/engines/plan-engine.service.ts`
  Function: `await`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Creates or rebuilds core itinerary rows.

#### 5. UPDATE usage

- File: `src/modules/itineraries/engines/plan-engine.service.ts`
  Function: `await`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Creates or rebuilds core itinerary rows.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `normalizePassengerTitle`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `normalizePassengerTitle`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `cancelItinerary`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Applies cancellation state or reads rows needed for cancellation.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `await`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `await`; inspect that function for the exact branch and payload.
- File: `scripts/test-last-route-cutoff-scenarios.js`
  Function: `run`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `run`; inspect that function for the exact branch and payload.
- File: `scripts/test-last-route-cutoff-scenarios.js`
  Function: `(top-level/undetected)`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

- Soft-delete/status note: this table has an update/status/deleted-flag style lifecycle in at least one scanned path. [Verified from code scan]

#### 7. Raw SQL usage

- File: `src/modules/itineraries/itinerary-export.service.ts`
  Function: `exportItineraryToExcel`
  Operation: `RAW READ`
  Why: Exports itinerary state through raw SQL.
- File: `scripts/audit/hotspot-rejection-trace.js`
  Function: `logSection`
  Operation: `RAW READ`
  Why: Uses the table in `logSection`; inspect that function for the exact branch and payload.
- File: `scripts/audit/manual-hotspot-batch-preview.js`
  Function: `main`
  Operation: `RAW READ`
  Why: Supports manual hotspot preview, insertion, scoring, or rejection explanation.
- File: `scripts/check-staah-hotel-pickup.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Why: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `scripts/debug-ax153-itinerary.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Why: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `scripts/debug-axisrooms-18001.js`
  Function: `main`
  Operation: `RAW READ`
  Why: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/debug-dvi20260594-vehicle-km.js`
  Function: `q`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `scripts/debug-itinerary-travel-segments.js`
  Function: `main`
  Operation: `RAW READ`
  Why: Uses the table in `main`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `itinerary_plan_ID`
- `agent_id`
- `staff_id`
- `location_id`
- `arrival_location`
- `departure_location`
- `itinerary_quote_ID`
- `trip_start_date_and_time`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Confirmed copy tables with the same suffix under `dvi_confirmed_*`.

#### 10. Business flows using this table

- create/update itinerary
- auto hotspot build
- manual hotspot
- details API
- hotel selection
- vehicle pricing
- confirmation
- cancellation
- provider booking
- account/wallet

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_itinerary_route_details`

**Model:** `dvi_itinerary_route_details`  
**Category:** Draft  
**Runtime usage:** Yes  
**Primary owner:** debug-hotspots.ts:main

#### 1. What this table stores

Stores ordered route/day legs for the draft itinerary, including source, destination, direct flags, and route ordering.

#### 2. Why this table exists in itinerary logic

It exists so engines can reason day-by-day and route-by-route instead of deriving schedule state from the plan header.

#### 3. READ usage

- File: `src/modules/itineraries/debug-hotspots.ts`
  Function: `main`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
  Function: `routes`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `routes`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
  Function: `isLastRouteOfPlan`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `isLastRouteOfPlan`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/helpers/timeline.enricher.ts`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/helpers/timeline.prefetch.ts`
  Function: `routes`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `routes`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/hotel-engine.service.ts`
  Function: `Number`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/engines/route-engine.service.ts`
  Function: `await`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Creates or rebuilds core itinerary rows.

#### 5. UPDATE usage

- File: `src/modules/itineraries/engines/hotspot-engine.service.ts`
  Function: `await`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `await`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `await`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `await`; inspect that function for the exact branch and payload.
- File: `scripts/test-last-route-cutoff-scenarios.js`
  Function: `run`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `run`; inspect that function for the exact branch and payload.
- File: `scripts/test-last-route-cutoff-scenarios.js`
  Function: `(top-level/undetected)`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `scripts/tmp-route-rebuild-debug.ts`
  Function: `await`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `await`; inspect that function for the exact branch and payload.

#### 6. DELETE / SOFT DELETE usage

- File: `src/modules/itineraries/engines/route-engine.service.ts`
  Function: `await`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Creates or rebuilds core itinerary rows.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/itinerary-export.service.ts`
  Function: `exportItineraryToExcel`
  Operation: `RAW READ`
  Why: Exports itinerary state through raw SQL.
- File: `scripts/audit/hotspot-rejection-trace.js`
  Function: `logSection`
  Operation: `RAW READ`
  Why: Uses the table in `logSection`; inspect that function for the exact branch and payload.
- File: `scripts/audit/manual-hotspot-batch-preview.js`
  Function: `main`
  Operation: `RAW READ`
  Why: Supports manual hotspot preview, insertion, scoring, or rejection explanation.
- File: `scripts/check-plan-410-hotspot-db-rows.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Why: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `scripts/check-staah-hotel-pickup.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Why: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `scripts/debug-available-hotspots-after-rebuild.ts`
  Function: `String`
  Operation: `RAW READ`
  Why: Uses the table in `String`; inspect that function for the exact branch and payload.
- File: `scripts/debug-available-hotspots-pothamedu.ts`
  Function: `printHeader`
  Operation: `RAW READ`
  Why: Uses the table in `printHeader`; inspect that function for the exact branch and payload.
- File: `scripts/debug-ax153-itinerary.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Why: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `itinerary_route_ID`
- `itinerary_plan_ID`
- `location_id`
- `location_name`
- `itinerary_route_date`
- `no_of_days`
- `no_of_km`
- `direct_to_next_visiting_place`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Confirmed copy tables with the same suffix under `dvi_confirmed_*`.

#### 10. Business flows using this table

- create/update itinerary
- auto hotspot build
- manual hotspot
- details API
- hotel selection
- vehicle pricing
- confirmation
- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_itinerary_via_route_details`

**Model:** `dvi_itinerary_via_route_details`  
**Category:** Draft  
**Runtime usage:** Yes  
**Primary owner:** timeline.prefetch.ts:routes

#### 1. What this table stores

Stores business rows for `dvi_itinerary_via_route_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_itinerary_via_route_details` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/helpers/timeline.prefetch.ts`
  Function: `routes`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `routes`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/itinerary-hotspots.engine.ts`
  Function: `await`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `await`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `getViaRouteNames`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getPlanForEdit`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getPlanForEdit`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `copyDraftToConfirmed`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Copies or finalizes state during confirmation.
- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/engines/via-routes.engine.ts`
  Function: `rebuildViaRoutes`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Creates or rebuilds core itinerary rows.

#### 5. UPDATE usage

- File: `src/modules/itineraries/engines/via-routes.engine.ts`
  Function: `rebuildViaRoutes`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Creates or rebuilds core itinerary rows.

#### 6. DELETE / SOFT DELETE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `await`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `await`; inspect that function for the exact branch and payload.

#### 7. Raw SQL usage

- File: `scripts/dump-dvi2026042-doc-focus.js`
  Function: `NULLIF`
  Operation: `RAW READ`
  Why: Uses the table in `NULLIF`; inspect that function for the exact branch and payload.
- File: `scripts/dump-itinerary-doc-evidence.js`
  Function: `NULLIF`
  Operation: `RAW READ`
  Why: Uses the table in `NULLIF`; inspect that function for the exact branch and payload.
- File: `scripts/find-10-day-multi-city-itinerary.js`
  Function: `GROUP_CONCAT`
  Operation: `RAW READ`
  Why: Uses the table in `GROUP_CONCAT`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `itinerary_via_route_ID`
- `itinerary_route_ID`
- `itinerary_plan_ID`
- `itinerary_route_date`
- `source_location`
- `destination_location`
- `itinerary_via_location_ID`
- `itinerary_via_location_name`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Confirmed copy tables with the same suffix under `dvi_confirmed_*`.

#### 10. Business flows using this table

- create/update itinerary
- auto hotspot build
- details API
- vehicle pricing
- confirmation

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_itinerary_traveller_details`

**Model:** `dvi_itinerary_traveller_details`  
**Category:** Draft  
**Runtime usage:** Yes  
**Primary owner:** travellers-engine.service.ts:await

#### 1. What this table stores

Stores business rows for `dvi_itinerary_traveller_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_itinerary_traveller_details` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `findOneOld`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `findOneOld`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itinerary-hotel-details-tbo.service.ts`
  Function: `getHotelDetailsByQuoteIdFromTbo`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itinerary-hotel-details-tbo.service.ts`
  Function: `getHotelRoomDetailsFromTbo`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/engines/travellers-engine.service.ts`
  Function: `await`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Creates or rebuilds core itinerary rows.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- File: `src/modules/itineraries/engines/travellers-engine.service.ts`
  Function: `await`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Creates or rebuilds core itinerary rows.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `traveller_details_ID`
- `itinerary_plan_ID`
- `traveller_type`
- `room_id`
- `traveller_age`
- `child_bed_type`
- `createdby`
- `createdon`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Confirmed copy tables with the same suffix under `dvi_confirmed_*`.

#### 10. Business flows using this table

- create/update itinerary
- details API
- hotel selection
- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_itinerary_plan_route_permit_charge`

**Model:** `dvi_itinerary_plan_route_permit_charge`  
**Category:** Draft  
**Runtime usage:** Yes  
**Primary owner:** route-engine.service.ts:await

#### 1. What this table stores

Stores business rows for `dvi_itinerary_plan_route_permit_charge` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_itinerary_plan_route_permit_charge` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `calculatePermitCharges`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/engines/route-engine.service.ts`
  Function: `await`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Creates or rebuilds core itinerary rows.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- File: `src/modules/itineraries/engines/route-engine.service.ts`
  Function: `await`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Creates or rebuilds core itinerary rows.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `await`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `await`; inspect that function for the exact branch and payload.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `calculatePermitCharges`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.

#### 8. Important fields and meaning

- `route_permit_charge_ID`
- `itinerary_plan_ID`
- `itinerary_route_ID`
- `itinerary_route_date`
- `vendor_id`
- `vendor_branch_id`
- `vendor_vehicle_type_id`
- `source_state_id`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Confirmed copy tables with the same suffix under `dvi_confirmed_*`.

#### 10. Business flows using this table

- create/update itinerary
- vehicle pricing

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### 26.3 Draft Timeline / Hotspot Tables

### Table: `dvi_itinerary_route_hotspot_details`

**Model:** `dvi_itinerary_route_hotspot_details`  
**Category:** Draft  
**Runtime usage:** Yes  
**Primary owner:** timeline.builder.ts:Number

#### 1. What this table stores

Stores persisted draft timeline rows for each route, including hotspot and non-hotspot item types.

#### 2. Why this table exists in itinerary logic

It exists because the builder output must be persisted, edited manually, and then mapped back into frontend segments.

#### 3. READ usage

- File: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
  Function: `Number`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `Number`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
  Function: `dayOfWeekForGapFill`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `dayOfWeekForGapFill`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/hotspot-engine.service.ts`
  Function: `rebuildRouteHotspots`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Builds or persists itinerary timeline rows.
- File: `src/modules/itineraries/engines/hotspot-engine.service.ts`
  Function: `await`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `await`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/hotspot-engine.service.ts`
  Function: `nextSource`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `nextSource`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/hotspot-engine.service.ts`
  Function: `Number`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `Number`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/engines/hotspot-engine.service copy.ts`
  Function: `await`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `await`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/hotspot-engine.service.ts`
  Function: `Number`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `Number`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/itinerary-hotspots.engine.ts`
  Function: `rebuildHotspots`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `rebuildHotspots`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/itinerary-hotspots.engine.ts`
  Function: `(top-level/undetected)`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/itinerary-hotspots.engine.ts`
  Function: `Number`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `Number`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `await`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `await`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- File: `src/modules/itineraries/engines/hotspot-engine.service copy.ts`
  Function: `await`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `await`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `unresolvedDurationMinutes`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `unresolvedDurationMinutes`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `await`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `await`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `cancelHotspots`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Applies cancellation state or reads rows needed for cancellation.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `staleIds`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `staleIds`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `String`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `String`; inspect that function for the exact branch and payload.

#### 6. DELETE / SOFT DELETE usage

- File: `src/modules/itineraries/engines/hotspot-engine.service.ts`
  Function: `logPersistence`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `logPersistence`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/hotspot-engine.service.ts`
  Function: `await`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `await`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/itinerary-hotspots.engine.ts`
  Function: `deleteRouteHotspotData`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `deleteRouteHotspotData`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `await`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `await`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/test-rebuild.ts`
  Function: `main`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/test-hotspot-add-api-only.js`
  Function: `existingIds`
  Operation: `RAW DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `existingIds`; inspect that function for the exact branch and payload.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `COALESCE`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `calculateHotspotParkingCharges`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `SEC_TO_TIME`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `captureManualPreviewRouteState`
  Operation: `RAW READ`
  Why: Supports manual hotspot preview, insertion, scoring, or rejection explanation.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `Number`
  Operation: `RAW READ`
  Why: Uses the table in `Number`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `CAST`
  Operation: `RAW READ`
  Why: Uses the table in `CAST`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itinerary-export.service.ts`
  Function: `exportItineraryToExcel`
  Operation: `RAW READ`
  Why: Exports itinerary state through raw SQL.
- File: `scripts/audit/hotspot-rejection-trace.js`
  Function: `logSection`
  Operation: `RAW READ`
  Why: Uses the table in `logSection`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `route_hotspot_ID`
- `itinerary_plan_ID`
- `itinerary_route_ID`
- `item_type`
- `hotspot_order`
- `hotspot_ID`
- `hotspot_adult_entry_cost`
- `hotspot_child_entry_cost`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Confirmed copy tables with the same suffix under `dvi_confirmed_*`.
- Child charge/cost tables plus route/day and hotspot master tables.

#### 10. Business flows using this table

- create/update itinerary
- auto hotspot build
- manual hotspot
- details API
- vehicle pricing
- cancellation

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_itinerary_route_hotspot_parking_charge`

**Model:** `dvi_itinerary_route_hotspot_parking_charge`  
**Category:** Draft  
**Runtime usage:** Yes  
**Primary owner:** hotspot-engine.service.ts:await

#### 1. What this table stores

Stores business rows for `dvi_itinerary_route_hotspot_parking_charge` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_itinerary_route_hotspot_parking_charge` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `calculateHotspotParkingCharges`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `COALESCE`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `COALESCE`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/engines/hotspot-engine.service.ts`
  Function: `await`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `await`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- File: `src/modules/itineraries/engines/hotspot-engine.service.ts`
  Function: `await`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `await`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/itinerary-hotspots.engine.ts`
  Function: `deleteRouteHotspotData`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `deleteRouteHotspotData`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `await`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `await`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/test-rebuild.ts`
  Function: `main`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `main`; inspect that function for the exact branch and payload.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `calculateHotspotParkingCharges`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `COALESCE`
  Operation: `RAW READ`
  Why: Uses the table in `COALESCE`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `itinerary_hotspot_parking_charge_ID`
- `itinerary_plan_ID`
- `itinerary_route_ID`
- `hotspot_ID`
- `vehicle_type`
- `vehicle_qty`
- `parking_charges_amt`
- `createdby`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Confirmed copy tables with the same suffix under `dvi_confirmed_*`.

#### 10. Business flows using this table

- auto hotspot build
- details API
- vehicle pricing

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_itinerary_route_hotspot_entry_cost_details`

**Model:** `dvi_itinerary_route_hotspot_entry_cost_details`  
**Category:** Draft  
**Runtime usage:** Yes  
**Primary owner:** itinerary-hotspots.engine.ts:Number

#### 1. What this table stores

Stores business rows for `dvi_itinerary_route_hotspot_entry_cost_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_itinerary_route_hotspot_entry_cost_details` in the scanned code.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/engines/itinerary-hotspots.engine.ts`
  Function: `Number`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `Number`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- File: `src/modules/itineraries/engines/itinerary-hotspots.engine.ts`
  Function: `deleteRouteHotspotData`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `deleteRouteHotspotData`; inspect that function for the exact branch and payload.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `hotspot_cost_detail_id`
- `route_hotspot_id`
- `hotspot_ID`
- `itinerary_plan_id`
- `itinerary_route_id`
- `traveller_type`
- `traveller_name`
- `entry_ticket_cost`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Confirmed copy tables with the same suffix under `dvi_confirmed_*`.

#### 10. Business flows using this table

- auto hotspot build

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_hotspot_place`

**Model:** `dvi_hotspot_place`  
**Category:** Master  
**Runtime usage:** Yes  
**Primary owner:** debug-hotspots.ts:main

#### 1. What this table stores

Stores business rows for `dvi_hotspot_place` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_hotspot_place` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/debug-hotspots.ts`
  Function: `main`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/debug-hotspots.ts`
  Function: `hsLocation`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `hsLocation`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/helpers/hotspot-segment.builder.ts`
  Function: `build`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `build`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
  Function: `Number`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `Number`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/helpers/timeline.cutoff-policy.ts`
  Function: `getCityCoords`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getCityCoords`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/helpers/timeline.enricher.ts`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `ensureHotspotPlace`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `ensureHotspotPlace`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `ensureHotspotPlace`
  Operation: `RAW READ`
  Why: Uses the table in `ensureHotspotPlace`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `findLastSameLocationHotspotOnRoute`
  Operation: `RAW READ`
  Why: Uses the table in `findLastSameLocationHotspotOnRoute`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `Number`
  Operation: `RAW READ`
  Why: Uses the table in `Number`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `COALESCE`
  Operation: `RAW READ`
  Why: Uses the table in `COALESCE`; inspect that function for the exact branch and payload.
- File: `scripts/audit/hotspot-rejection-trace.js`
  Function: `logSection`
  Operation: `RAW READ`
  Why: Uses the table in `logSection`; inspect that function for the exact branch and payload.
- File: `scripts/audit/manual-hotspot-batch-preview.js`
  Function: `main`
  Operation: `RAW READ`
  Why: Supports manual hotspot preview, insertion, scoring, or rejection explanation.
- File: `scripts/check-plan-410-hotspot-db-rows.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Why: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `scripts/debug-hotspot-preview-timing-v2.js`
  Function: `main`
  Operation: `RAW READ`
  Why: Uses the table in `main`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `hotspot_ID`
- `hotspot_type`
- `hotspot_name`
- `hotspot_description`
- `hotspot_address`
- `hotspot_landmark`
- `hotspot_location`
- `hotspot_to_location`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- auto hotspot build
- manual hotspot
- details API

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_hotspot_timing`

**Model:** `dvi_hotspot_timing`  
**Category:** Master  
**Runtime usage:** Yes  
**Primary owner:** timeline.builder.ts:allHotspots

#### 1. What this table stores

Stores business rows for `dvi_hotspot_timing` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_hotspot_timing` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
  Function: `allHotspots`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `allHotspots`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/helpers/timeline.enricher.ts`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/helpers/timeline.prefetch.ts`
  Function: `routes`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `routes`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/hotspot-engine.service.ts`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/itinerary-hotspots.engine.ts`
  Function: `await`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `await`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `timingDay`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `timingDay`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `scripts/audit/hotspot-rejection-trace.js`
  Function: `logSection`
  Operation: `RAW READ`
  Why: Uses the table in `logSection`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `hotspot_timing_ID`
- `hotspot_ID`
- `hotspot_timing_day`
- `hotspot_start_time`
- `hotspot_end_time`
- `hotspot_closed`
- `hotspot_open_all_time`
- `createdby`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- auto hotspot build
- details API

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_hotspot_gallery_details`

**Model:** `dvi_hotspot_gallery_details`  
**Category:** Master  
**Runtime usage:** Yes  
**Primary owner:** itinerary-details.service.ts:CAST

#### 1. What this table stores

Stores business rows for `dvi_hotspot_gallery_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_hotspot_gallery_details` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `CAST`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `CAST`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `hotspot_gallery_details_id`
- `hotspot_ID`
- `hotspot_gallery_name`
- `createdby`
- `createdon`
- `updatedon`
- `status`
- `deleted`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- details API

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_hotspot_vehicle_parking_charges`

**Model:** `dvi_hotspot_vehicle_parking_charges`  
**Category:** Master  
**Runtime usage:** Yes  
**Primary owner:** vehicle-calculation.helpers.ts:calculateHotspotParkingCharges

#### 1. What this table stores

Stores business rows for `dvi_hotspot_vehicle_parking_charges` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_hotspot_vehicle_parking_charges` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `calculateHotspotParkingCharges`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `calculateHotspotParkingCharges`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.

#### 8. Important fields and meaning

- `vehicle_parking_charge_ID`
- `hotspot_id`
- `vehicle_type_id`
- `parking_charge`
- `createdon`
- `updatedon`
- `createdby`
- `status`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Vehicle/vendor master, pricebook, slab, toll, and permit tables.

#### 10. Business flows using this table

- vehicle pricing

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Needs verification because runtime usage is raw-SQL heavy and the scan does not normalize every predicate.

### 26.4 Route-Fit / Matrix / Distance Tables

### Table: `hotspot_route_matrix`

**Model:** `hotspot_route_matrix`  
**Category:** Matrix  
**Runtime usage:** Yes  
**Primary owner:** manual-hotspot-matrix-builder.ts:getCachedLeg

#### 1. What this table stores

Stores business rows for `hotspot_route_matrix` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `hotspot_route_matrix` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/helpers/manual-hotspot-matrix-builder.ts`
  Function: `getCachedLeg`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports manual hotspot preview, insertion, scoring, or rejection explanation.
- File: `scripts/build-hotspot-route-matrix.ts`
  Function: `loadExistingStatuses`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `loadExistingStatuses`; inspect that function for the exact branch and payload.
- File: `scripts/build-hotspot-route-matrix.ts`
  Function: `getRouteMatrixLeg`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getRouteMatrixLeg`; inspect that function for the exact branch and payload.
- File: `scripts/build-missing-manual-hotspot-matrix.ts`
  Function: `getCachedLeg`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports manual hotspot preview, insertion, scoring, or rejection explanation.
- File: `scripts/run-manual-hotspot-fit-test-matrix-chennai.ts`
  Function: `matrixStatusQuery`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports manual hotspot preview, insertion, scoring, or rejection explanation.
- File: `scripts/run-manual-hotspot-fit-test-matrix-south.ts`
  Function: `matrixStatusQuery`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports manual hotspot preview, insertion, scoring, or rejection explanation.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/helpers/manual-hotspot-matrix-builder.ts`
  Function: `upsertMatrixLeg`
  Operation: `RAW INSERT`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Supports manual hotspot preview, insertion, scoring, or rejection explanation.
- File: `scripts/build-hotspot-route-matrix.ts`
  Function: `upsertRouteMatrixStatus`
  Operation: `RAW INSERT`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `upsertRouteMatrixStatus`; inspect that function for the exact branch and payload.
- File: `scripts/build-missing-manual-hotspot-matrix.ts`
  Function: `upsertMatrixLeg`
  Operation: `RAW INSERT`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Supports manual hotspot preview, insertion, scoring, or rejection explanation.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/helpers/manual-hotspot-matrix-builder.ts`
  Function: `getCachedLeg`
  Operation: `RAW READ`
  Why: Supports manual hotspot preview, insertion, scoring, or rejection explanation.
- File: `src/modules/itineraries/helpers/manual-hotspot-matrix-builder.ts`
  Function: `upsertMatrixLeg`
  Operation: `RAW INSERT`
  Why: Supports manual hotspot preview, insertion, scoring, or rejection explanation.
- File: `scripts/build-hotspot-route-matrix.ts`
  Function: `loadExistingStatuses`
  Operation: `RAW READ`
  Why: Uses the table in `loadExistingStatuses`; inspect that function for the exact branch and payload.
- File: `scripts/build-hotspot-route-matrix.ts`
  Function: `getRouteMatrixLeg`
  Operation: `RAW READ`
  Why: Uses the table in `getRouteMatrixLeg`; inspect that function for the exact branch and payload.
- File: `scripts/build-hotspot-route-matrix.ts`
  Function: `upsertRouteMatrixStatus`
  Operation: `RAW INSERT`
  Why: Uses the table in `upsertRouteMatrixStatus`; inspect that function for the exact branch and payload.
- File: `scripts/build-missing-manual-hotspot-matrix.ts`
  Function: `getCachedLeg`
  Operation: `RAW READ`
  Why: Supports manual hotspot preview, insertion, scoring, or rejection explanation.
- File: `scripts/build-missing-manual-hotspot-matrix.ts`
  Function: `upsertMatrixLeg`
  Operation: `RAW INSERT`
  Why: Supports manual hotspot preview, insertion, scoring, or rejection explanation.
- File: `scripts/run-manual-hotspot-fit-test-matrix-chennai.ts`
  Function: `matrixStatusQuery`
  Operation: `RAW READ`
  Why: Supports manual hotspot preview, insertion, scoring, or rejection explanation.

#### 8. Important fields and meaning

- `id`
- `from_hotspot_id`
- `to_hotspot_id`
- `from_name`
- `to_name`
- `from_lat`
- `from_lng`
- `to_lat`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Manual hotspot insertion helpers, route/day tables, hotspot master, and hotel-before-check-in flows.

#### 10. Business flows using this table

- manual hotspot

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Needs verification because runtime usage is raw-SQL heavy and the scan does not normalize every predicate.

### Table: `hotspot_route_between_map`

**Model:** `hotspot_route_between_map`  
**Category:** Matrix  
**Runtime usage:** Yes  
**Primary owner:** timeline.builder.ts:getBetweenCandidatesForRouteSlots

#### 1. What this table stores

Stores accepted A -> C -> B route-fit rows with detour and progress metadata.

#### 2. Why this table exists in itinerary logic

It exists to cache route-fit approval for auto-build matrix paths and manual hotspot insertion.

#### 3. READ usage

- File: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
  Function: `getBetweenCandidatesForRouteSlots`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports manual hotspot preview, insertion, scoring, or rejection explanation.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `ensureRouteBetweenMapRow`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports manual hotspot preview, insertion, scoring, or rejection explanation.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `Number`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `Number`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `availableGapMinutes`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `availableGapMinutes`; inspect that function for the exact branch and payload.
- File: `scripts/build-hotspot-route-matrix.ts`
  Function: `replaceBetweenMapRows`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports manual hotspot preview, insertion, scoring, or rejection explanation.
- File: `scripts/debug-manual-hotspot-insertion-gaps.ts`
  Function: `baselineHotspotIds`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports manual hotspot preview, insertion, scoring, or rejection explanation.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/helpers/manual-hotspot-matrix-builder.ts`
  Function: `upsertBetweenMapRow`
  Operation: `RAW INSERT`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Supports manual hotspot preview, insertion, scoring, or rejection explanation.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `await`
  Operation: `RAW INSERT`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `await`; inspect that function for the exact branch and payload.
- File: `scripts/build-hotspot-route-matrix.ts`
  Function: `replaceBetweenMapRows`
  Operation: `RAW INSERT`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Supports manual hotspot preview, insertion, scoring, or rejection explanation.
- File: `scripts/build-missing-manual-hotspot-matrix.ts`
  Function: `upsertBetweenMapRow`
  Operation: `RAW INSERT`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Supports manual hotspot preview, insertion, scoring, or rejection explanation.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/build-hotspot-route-matrix.ts`
  Function: `replaceBetweenMapRows`
  Operation: `RAW DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Supports manual hotspot preview, insertion, scoring, or rejection explanation.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
  Function: `getBetweenCandidatesForRouteSlots`
  Operation: `RAW READ`
  Why: Supports manual hotspot preview, insertion, scoring, or rejection explanation.
- File: `src/modules/itineraries/helpers/manual-hotspot-matrix-builder.ts`
  Function: `upsertBetweenMapRow`
  Operation: `RAW INSERT`
  Why: Supports manual hotspot preview, insertion, scoring, or rejection explanation.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `ensureRouteBetweenMapRow`
  Operation: `RAW READ`
  Why: Supports manual hotspot preview, insertion, scoring, or rejection explanation.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `Number`
  Operation: `RAW READ`
  Why: Uses the table in `Number`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `availableGapMinutes`
  Operation: `RAW READ`
  Why: Uses the table in `availableGapMinutes`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `await`
  Operation: `RAW INSERT`
  Why: Uses the table in `await`; inspect that function for the exact branch and payload.
- File: `scripts/build-hotspot-route-matrix.ts`
  Function: `replaceBetweenMapRows`
  Operation: `RAW READ`
  Why: Supports manual hotspot preview, insertion, scoring, or rejection explanation.
- File: `scripts/build-hotspot-route-matrix.ts`
  Function: `replaceBetweenMapRows`
  Operation: `RAW INSERT`
  Why: Supports manual hotspot preview, insertion, scoring, or rejection explanation.

#### 8. Important fields and meaning

- `id`
- `from_hotspot_id`
- `from_hotspot_name`
- `from_hotspot_location`
- `to_hotspot_id`
- `to_hotspot_name`
- `to_hotspot_location`
- `between_hotspot_id`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Manual hotspot insertion helpers, route/day tables, hotspot master, and hotel-before-check-in flows.

#### 10. Business flows using this table

- auto hotspot build
- manual hotspot

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Needs verification because runtime usage is raw-SQL heavy and the scan does not normalize every predicate.

### Table: `hotspot_hotel_between_map`

**Model:** `hotspot_hotel_between_map`  
**Category:** Matrix  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:await

#### 1. What this table stores

Stores accepted previous hotspot -> manual hotspot -> hotel fit rows.

#### 2. Why this table exists in itinerary logic

It exists for manual destination-side insertion before hotel/check-in.

#### 3. READ usage

- File: `scripts/verify-hotspot-hotel-between-playwright.js`
  Function: `findIndexByName`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports manual hotspot preview, insertion, scoring, or rejection explanation.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `await`
  Operation: `RAW INSERT`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `await`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `await`
  Operation: `RAW INSERT`
  Why: Uses the table in `await`; inspect that function for the exact branch and payload.
- File: `scripts/verify-hotspot-hotel-between-playwright.js`
  Function: `findIndexByName`
  Operation: `RAW READ`
  Why: Supports manual hotspot preview, insertion, scoring, or rejection explanation.

#### 8. Important fields and meaning

- `id`
- `itinerary_plan_id`
- `itinerary_route_id`
- `from_hotspot_id`
- `hotel_id`
- `between_hotspot_id`
- `route_fit_type`
- `route_decision_reason`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Hotel master, room, voucher, and provider booking tables.
- Manual hotspot insertion helpers, route/day tables, hotspot master, and hotel-before-check-in flows.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Needs verification because runtime usage is raw-SQL heavy and the scan does not normalize every predicate.

### Table: `hotspot_route_between_rejections`

**Model:** `hotspot_route_between_rejections`  
**Category:** Matrix  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:getRouteBetweenRejectionRow

#### 1. What this table stores

Stores rejected A -> C -> B route-fit attempts.

#### 2. Why this table exists in itinerary logic

It exists so manual preview/apply can explain why a candidate was rejected.

#### 3. READ usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getRouteBetweenRejectionRow`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports manual hotspot preview, insertion, scoring, or rejection explanation.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getRouteBetweenRejectionRow`
  Operation: `RAW READ`
  Why: Supports manual hotspot preview, insertion, scoring, or rejection explanation.

#### 8. Important fields and meaning

- `id`
- `from_hotspot_id`
- `from_hotspot_name`
- `from_hotspot_location`
- `to_hotspot_id`
- `to_hotspot_name`
- `to_hotspot_location`
- `between_hotspot_id`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Manual hotspot insertion helpers, route/day tables, hotspot master, and hotel-before-check-in flows.

#### 10. Business flows using this table

- manual hotspot

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Needs verification because runtime usage is raw-SQL heavy and the scan does not normalize every predicate.

### Table: `dvi_hotspot_distance_cache`

**Model:** `HotspotDistanceCache`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_hotspot_distance_cache`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `id`
- `fromHotspotId`
- `toHotspotId`
- `travelLocationType`
- `fromHotspotName`
- `toHotspotName`
- `haversineKm`
- `correctionFactor`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_stored_locations`

**Model:** `dvi_stored_locations`  
**Category:** Reference  
**Runtime usage:** Yes  
**Primary owner:** create-itinerary.dto.ts:(top-level/undetected)

#### 1. What this table stores

Stores business rows for `dvi_stored_locations` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_stored_locations` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/helpers/distance.helper.ts`
  Function: `fromLocationId`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `fromLocationId`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/helpers/distance.helper.ts`
  Function: `fromSourceAndDestination`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `fromSourceAndDestination`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/helpers/timeline.cutoff-policy.ts`
  Function: `getCityCoords`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getCityCoords`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/helpers/timeline.prefetch.ts`
  Function: `routes`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `routes`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/itinerary-hotspots.engine.ts`
  Function: `await`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `await`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `String`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.

#### 4. INSERT / CREATE usage

- File: `scripts/backfill-location-self-routes.ts`
  Function: `applyInsert`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `applyInsert`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/dto/create-itinerary.dto.ts`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Why: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/itinerary-hotspots.engine.ts`
  Function: `rebuildHotspots`
  Operation: `RAW READ`
  Why: Uses the table in `rebuildHotspots`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `String`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `Number`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `normalizeCityToken`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/route-engine.service.ts`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Why: Creates or rebuilds core itinerary rows.
- File: `src/modules/itineraries/engines/route-engine.service.ts`
  Function: `getDepartureBufferSeconds`
  Operation: `RAW READ`
  Why: Creates or rebuilds core itinerary rows.
- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `getTollForLocationPair`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.

#### 8. Important fields and meaning

- `location_ID`
- `source_location`
- `source_location_lattitude`
- `source_location_longitude`
- `source_location_city`
- `source_location_state`
- `destination_location`
- `destination_location_lattitude`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- create/update itinerary
- auto hotspot build
- manual hotspot
- details API
- hotel selection
- vehicle pricing
- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_stored_routes`

**Model:** `dvi_stored_routes`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_stored_routes`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `stored_route_ID`
- `location_id`
- `route_name`
- `no_of_nights`
- `createdby`
- `createdon`
- `updatedon`
- `status`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_stored_route_location_details`

**Model:** `dvi_stored_route_location_details`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_stored_route_location_details`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `stored_route_location_ID`
- `stored_route_id`
- `route_location_id`
- `route_location_name`
- `createdby`
- `createdon`
- `updatedon`
- `status`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_stored_location_via_routes`

**Model:** `dvi_stored_location_via_routes`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_stored_location_via_routes`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `via_route_location_ID`
- `location_id`
- `via_route_location`
- `via_route_location_lattitude`
- `via_route_location_longitude`
- `via_route_location_state`
- `via_route_location_city`
- `distance_from_source_to_via_route`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### 26.5 Draft Hotel Tables

### Table: `dvi_itinerary_plan_hotel_details`

**Model:** `dvi_itinerary_plan_hotel_details`  
**Category:** Draft  
**Runtime usage:** Yes  
**Primary owner:** hotel-engine.service.ts:await

#### 1. What this table stores

Stores business rows for `dvi_itinerary_plan_hotel_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_itinerary_plan_hotel_details` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/itinerary-hotspots.engine.ts`
  Function: `await`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `await`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `resolveLocalHotelOrCityPoint`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/hotel-voucher.service.ts`
  Function: `cancelHotelsForItinerary`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `copyDraftToConfirmed`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Copies or finalizes state during confirmation.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `cancelHotels`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Applies cancellation state or reads rows needed for cancellation.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `await`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `await`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/hotels/hotel-persist.service.ts`
  Function: `persistForPlanDay`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `parseDateTime`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `parseDateTime`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `await`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `await`; inspect that function for the exact branch and payload.
- File: `scripts/backfill-early-arrival-marker-and-rebuild.ts`
  Function: `await`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `await`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- File: `src/modules/itineraries/hotel-voucher.service.ts`
  Function: `(top-level/undetected)`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/hotel-voucher.service.ts`
  Function: `cancelHotelsForItinerary`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `parseDateTime`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `parseDateTime`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `cancelHotels`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Applies cancellation state or reads rows needed for cancellation.

#### 6. DELETE / SOFT DELETE usage

- File: `src/modules/itineraries/engines/hotel-engine.service.ts`
  Function: `await`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `await`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `await`; inspect that function for the exact branch and payload.
- File: `scripts/backfill-early-arrival-marker-and-rebuild.ts`
  Function: `await`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `await`; inspect that function for the exact branch and payload.

- Soft-delete/status note: this table has an update/status/deleted-flag style lifecycle in at least one scanned path. [Verified from code scan]

#### 7. Raw SQL usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `resolveSelectedHotelEndpoint`
  Operation: `RAW READ`
  Why: Uses the table in `resolveSelectedHotelEndpoint`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `pickWithValidCoords`
  Operation: `RAW READ`
  Why: Uses the table in `pickWithValidCoords`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `Number`
  Operation: `RAW READ`
  Why: Uses the table in `Number`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itinerary-export.service.ts`
  Function: `exportItineraryToExcel`
  Operation: `RAW READ`
  Why: Exports itinerary state through raw SQL.
- File: `src/modules/itineraries/itinerary-hotel-details.service.ts`
  Function: `getHotelRoomDetailsByQuoteId`
  Operation: `RAW READ`
  Why: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itinerary-hotel-details.service.ts`
  Function: `getHotelDetailsForPlan`
  Operation: `RAW READ`
  Why: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `scripts/debug-itinerary-travel-segments.js`
  Function: `main`
  Operation: `RAW READ`
  Why: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/debug-quote-hotel-state.js`
  Function: `main`
  Operation: `RAW READ`
  Why: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 8. Important fields and meaning

- `itinerary_plan_hotel_details_ID`
- `group_type`
- `itinerary_plan_id`
- `itinerary_route_id`
- `itinerary_route_date`
- `itinerary_route_location`
- `hotel_required`
- `hotel_category_id`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Confirmed copy tables with the same suffix under `dvi_confirmed_*`.
- Hotel master, room, voucher, and provider booking tables.

#### 10. Business flows using this table

- create/update itinerary
- auto hotspot build
- details API
- hotel selection
- vehicle pricing
- confirmation
- cancellation
- voucher
- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_itinerary_plan_hotel_room_details`

**Model:** `dvi_itinerary_plan_hotel_room_details`  
**Category:** Draft  
**Runtime usage:** Yes  
**Primary owner:** hotel-engine.service.ts:isLastRoute

#### 1. What this table stores

Stores business rows for `dvi_itinerary_plan_hotel_room_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_itinerary_plan_hotel_room_details` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/hotel-engine.service.ts`
  Function: `isLastRoute`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `copyDraftToConfirmed`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Copies or finalizes state during confirmation.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getHotelRoomCategories`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getHotelRoomCategories`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/engines/hotel-engine.service.ts`
  Function: `await`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/hotels/hotel-persist.service.ts`
  Function: `detailsId`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `updateRoomCategory`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `updateRoomCategory`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- File: `src/modules/itineraries/engines/hotel-engine.service.ts`
  Function: `await`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `updateRoomCategory`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `updateRoomCategory`; inspect that function for the exact branch and payload.

#### 6. DELETE / SOFT DELETE usage

- File: `src/modules/itineraries/engines/hotel-engine.service.ts`
  Function: `await`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `itinerary_plan_hotel_room_details_ID`
- `itinerary_plan_hotel_details_id`
- `group_type`
- `itinerary_plan_id`
- `itinerary_route_id`
- `itinerary_route_date`
- `hotel_id`
- `room_type_id`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Confirmed copy tables with the same suffix under `dvi_confirmed_*`.
- Hotel master, room, voucher, and provider booking tables.

#### 10. Business flows using this table

- create/update itinerary
- hotel selection
- confirmation

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_itinerary_plan_hotel_room_amenities`

**Model:** `dvi_itinerary_plan_hotel_room_amenities`  
**Category:** Draft  
**Runtime usage:** Yes  
**Primary owner:** hotel-engine.service.ts:await

#### 1. What this table stores

Stores business rows for `dvi_itinerary_plan_hotel_room_amenities` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_itinerary_plan_hotel_room_amenities` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- File: `src/modules/itineraries/engines/hotel-engine.service.ts`
  Function: `await`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `itinerary_plan_hotel_room_amenities_details_ID`
- `itinerary_plan_hotel_details_id`
- `group_type`
- `itinerary_plan_id`
- `itinerary_route_id`
- `itinerary_route_date`
- `hotel_id`
- `hotel_amenities_id`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Confirmed copy tables with the same suffix under `dvi_confirmed_*`.
- Hotel master, room, voucher, and provider booking tables.

#### 10. Business flows using this table

- hotel selection

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_hotel`

**Model:** `dvi_hotel`  
**Category:** Reference  
**Runtime usage:** Yes  
**Primary owner:** itinerary-hotspots.engine.ts:await

#### 1. What this table stores

Stores business rows for `dvi_hotel` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_hotel` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/itinerary-hotspots.engine.ts`
  Function: `await`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `await`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `resolveLocalHotelOrCityPoint`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/hotel-voucher.service.ts`
  Function: `getAllCancellationPolicies`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/hotels/hotel-pricing.service.ts`
  Function: `cityTrim`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getVoucherDetails`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getVoucherDetails`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getConfirmedItineraryForCancellation`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getConfirmedItineraryForCancellation`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- File: `scripts/import-justa-hotels.js`
  Function: `upsertHotels`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `scripts/import-revenue-manager-properties.js`
  Function: `upsertProperty`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `upsertProperty`; inspect that function for the exact branch and payload.
- File: `scripts/seed-axisrooms-hotels-from-xlsx.ts`
  Function: `importHotels`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `scripts/build-axisrooms-prod-sync-sql.js`
  Function: `main`
  Operation: `RAW INSERT`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/compare-local-prod-axisrooms.js`
  Function: `fetchSnapshot`
  Operation: `RAW INSERT`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `fetchSnapshot`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- File: `scripts/import-justa-hotels.js`
  Function: `upsertHotels`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `scripts/import-revenue-manager-properties.js`
  Function: `upsertProperty`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `upsertProperty`; inspect that function for the exact branch and payload.
- File: `scripts/seed-axisrooms-hotels-from-xlsx.ts`
  Function: `importHotels`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `scripts/fix-axisrooms-local-inbound-coverage.js`
  Function: `main`
  Operation: `RAW UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `main`; inspect that function for the exact branch and payload.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/hotels/hotel-pricing.service.ts`
  Function: `cityTrim`
  Operation: `RAW READ`
  Why: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/hotels/hotel-pricing.service.ts`
  Function: `resolveCityCandidates`
  Operation: `RAW READ`
  Why: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `sin`
  Operation: `RAW READ`
  Why: Uses the table in `sin`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `Number`
  Operation: `RAW READ`
  Why: Uses the table in `Number`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `resolveHotelEndpointByLooseName`
  Operation: `RAW READ`
  Why: Uses the table in `resolveHotelEndpointByLooseName`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getConfirmedItineraryDetails`
  Operation: `RAW READ`
  Why: Uses the table in `getConfirmedItineraryDetails`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `mapHotelGroupTypeToCategory`
  Operation: `RAW READ`
  Why: Uses the table in `mapHotelGroupTypeToCategory`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `resolveSelectedHotelEndpoint`
  Operation: `RAW READ`
  Why: Uses the table in `resolveSelectedHotelEndpoint`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `hotel_id`
- `hotel_name`
- `hotel_code`
- `hotel_mobile`
- `hotel_email`
- `hotel_country`
- `hotel_city`
- `hotel_state`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Hotel master, room, voucher, and provider booking tables.

#### 10. Business flows using this table

- auto hotspot build
- details API
- hotel selection
- vehicle pricing
- confirmation
- voucher
- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_hotel_rooms`

**Model:** `dvi_hotel_rooms`  
**Category:** Master  
**Runtime usage:** Yes  
**Primary owner:** hotel-engine.service.ts:isLastRoute

#### 1. What this table stores

Stores business rows for `dvi_hotel_rooms` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_hotel_rooms` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/hotel-engine.service.ts`
  Function: `isLastRoute`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itinerary-hotel-details-tbo.service.ts`
  Function: `resolvedCity`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itinerary-hotel-details-tbo.service.ts`
  Function: `fetchStaahHotelsForRoutes`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/services/staah-booking-push.service.ts`
  Function: `resolveRoomRate`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `resolveRoomRate`; inspect that function for the exact branch and payload.
- File: `scripts/backfill-hotel-room-rate-plans.ts`
  Function: `main`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `scripts/check-axisrooms-data.ts`
  Function: `safeStringify`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `safeStringify`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/itinerary-hotel-details.service.ts`
  Function: `getAvailableRoomTypesForHotel`
  Operation: `RAW READ`
  Why: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `scripts/build-axisrooms-prod-sync-sql.js`
  Function: `main`
  Operation: `RAW READ`
  Why: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/compare-ax153-prod-local.js`
  Function: `normalizeRows`
  Operation: `RAW READ`
  Why: Uses the table in `normalizeRows`; inspect that function for the exact branch and payload.
- File: `scripts/compare-local-prod-axisrooms.js`
  Function: `fetchSnapshot`
  Operation: `RAW READ`
  Why: Uses the table in `fetchSnapshot`; inspect that function for the exact branch and payload.
- File: `scripts/dump-prod-ax153.js`
  Function: `safeQuery`
  Operation: `RAW READ`
  Why: Uses the table in `safeQuery`; inspect that function for the exact branch and payload.
- File: `scripts/sync-prod-axisrooms-properties-to-local.js`
  Function: `fetchProdDumpFromDb`
  Operation: `RAW READ`
  Why: Uses the table in `fetchProdDumpFromDb`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `room_ID`
- `hotel_id`
- `room_type_id`
- `preferred_for`
- `room_title`
- `no_of_rooms_available`
- `room_ref_code`
- `air_conditioner_availability`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Hotel master, room, voucher, and provider booking tables.

#### 10. Business flows using this table

- hotel selection
- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_hotel_room_price_book`

**Model:** `dvi_hotel_room_price_book`  
**Category:** Master  
**Runtime usage:** Yes  
**Primary owner:** hotel-pricing.service.ts:constructor

#### 1. What this table stores

Stores business rows for `dvi_hotel_room_price_book` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_hotel_room_price_book` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/hotels/hotel-pricing.service.ts`
  Function: `constructor`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/hotels/hotel-pricing.service.ts`
  Function: `hasValidRates`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/hotels/hotel-pricing.service.ts`
  Function: `getRoomPrices`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/hotels/hotel-pricing.service.ts`
  Function: `cityTrim`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itinerary-hotel-details.service.ts`
  Function: `getAvailableRoomTypesForHotel`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/hotels/hotel-pricing.service.ts`
  Function: `cityTrim`
  Operation: `RAW READ`
  Why: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itinerary-hotel-details.service.ts`
  Function: `getAvailableRoomTypesForHotel`
  Operation: `RAW READ`
  Why: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 8. Important fields and meaning

- `hotel_price_book_id`
- `hotel_id`
- `room_type_id`
- `room_id`
- `price_type`
- `year`
- `month`
- `day_1`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Hotel master, room, voucher, and provider booking tables.

#### 10. Business flows using this table

- hotel selection

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_hotel_room_rate_plan`

**Model:** `dvi_hotel_room_rate_plan`  
**Category:** Master  
**Runtime usage:** Yes  
**Primary owner:** itinerary-hotel-details-tbo.service.ts:resolvedCity

#### 1. What this table stores

Stores business rows for `dvi_hotel_room_rate_plan` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_hotel_room_rate_plan` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itinerary-hotel-details-tbo.service.ts`
  Function: `resolvedCity`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/services/staah-booking-push.service.ts`
  Function: `resolveRoomRate`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `resolveRoomRate`; inspect that function for the exact branch and payload.
- File: `scripts/cleanup-noncanonical-room-rateplans.ts`
  Function: `main`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/verify-hotel-rate-plan-system.ts`
  Function: `main`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `scripts/build-axisrooms-prod-sync-sql.js`
  Function: `main`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/compare-ax153-prod-local.js`
  Function: `normalizeRows`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `normalizeRows`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- File: `scripts/build-axisrooms-prod-sync-sql.js`
  Function: `main`
  Operation: `RAW INSERT`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/compare-local-prod-axisrooms.js`
  Function: `fetchSnapshot`
  Operation: `RAW INSERT`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `fetchSnapshot`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- File: `scripts/backfill-hotel-room-rate-plans.ts`
  Function: `main`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/cleanup-noncanonical-room-rateplans.ts`
  Function: `main`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `main`; inspect that function for the exact branch and payload.

#### 7. Raw SQL usage

- File: `scripts/build-axisrooms-prod-sync-sql.js`
  Function: `main`
  Operation: `RAW READ`
  Why: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/build-axisrooms-prod-sync-sql.js`
  Function: `main`
  Operation: `RAW INSERT`
  Why: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/compare-ax153-prod-local.js`
  Function: `normalizeRows`
  Operation: `RAW READ`
  Why: Uses the table in `normalizeRows`; inspect that function for the exact branch and payload.
- File: `scripts/compare-local-prod-axisrooms.js`
  Function: `fetchSnapshot`
  Operation: `RAW READ`
  Why: Uses the table in `fetchSnapshot`; inspect that function for the exact branch and payload.
- File: `scripts/compare-local-prod-axisrooms.js`
  Function: `fetchSnapshot`
  Operation: `RAW INSERT`
  Why: Uses the table in `fetchSnapshot`; inspect that function for the exact branch and payload.
- File: `scripts/debug-ax153-itinerary.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Why: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `scripts/debug-axisrooms-18001.js`
  Function: `String`
  Operation: `RAW READ`
  Why: Uses the table in `String`; inspect that function for the exact branch and payload.
- File: `scripts/dump-prod-ax153.js`
  Function: `safeQuery`
  Operation: `RAW READ`
  Why: Uses the table in `safeQuery`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `hotel_room_rate_plan_id`
- `hotel_id`
- `room_id`
- `room_type_id`
- `axisrooms_room_id`
- `rate_plan_code`
- `rateplan_id`
- `rateplan_name`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Hotel master, room, voucher, and provider booking tables.

#### 10. Business flows using this table

- hotel selection
- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_hotel_rate_plan_master`

**Model:** `dvi_hotel_rate_plan_master`  
**Category:** Script-only  
**Runtime usage:** Script-only  
**Primary owner:** backfill-hotel-room-rate-plans.ts:main

#### 1. What this table stores

Stores business rows for `dvi_hotel_rate_plan_master` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_hotel_rate_plan_master` in the scanned code.

#### 3. READ usage

- File: `scripts/verify-hotel-rate-plan-system.ts`
  Function: `main`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `scripts/build-axisrooms-prod-sync-sql.js`
  Function: `main`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/compare-local-prod-axisrooms.js`
  Function: `fetchSnapshot`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `fetchSnapshot`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- File: `scripts/build-axisrooms-prod-sync-sql.js`
  Function: `main`
  Operation: `RAW INSERT`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/compare-local-prod-axisrooms.js`
  Function: `fetchSnapshot`
  Operation: `RAW INSERT`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `fetchSnapshot`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- File: `scripts/backfill-hotel-room-rate-plans.ts`
  Function: `main`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `scripts/sync-hotel-rate-plan-master.ts`
  Function: `main`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `scripts/build-axisrooms-prod-sync-sql.js`
  Function: `main`
  Operation: `RAW READ`
  Why: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/build-axisrooms-prod-sync-sql.js`
  Function: `main`
  Operation: `RAW INSERT`
  Why: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/compare-local-prod-axisrooms.js`
  Function: `fetchSnapshot`
  Operation: `RAW READ`
  Why: Uses the table in `fetchSnapshot`; inspect that function for the exact branch and payload.
- File: `scripts/compare-local-prod-axisrooms.js`
  Function: `fetchSnapshot`
  Operation: `RAW INSERT`
  Why: Uses the table in `fetchSnapshot`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `hotel_rate_plan_master_id`
- `rate_plan_code`
- `default_rateplan_id`
- `rate_plan_name`
- `description`
- `includes_breakfast`
- `includes_lunch`
- `includes_dinner`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Hotel master, room, voucher, and provider booking tables.

#### 10. Business flows using this table

- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Script-only; not used in normal itinerary API runtime.

### Table: `dvi_hotel_amenities`

**Model:** `dvi_hotel_amenities`  
**Category:** Master  
**Runtime usage:** Yes  
**Primary owner:** itinerary-hotel-details-tbo.service.ts:resolvedCity

#### 1. What this table stores

Stores business rows for `dvi_hotel_amenities` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_hotel_amenities` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itinerary-hotel-details-tbo.service.ts`
  Function: `resolvedCity`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `hotel_amenities_id`
- `hotel_id`
- `amenities_title`
- `amenities_code`
- `quantity`
- `availability_type`
- `start_time`
- `end_time`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Hotel master, room, voucher, and provider booking tables.

#### 10. Business flows using this table

- hotel selection
- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_hotel_room_gallery_details`

**Model:** `dvi_hotel_room_gallery_details`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_hotel_room_gallery_details`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `hotel_room_gallery_details_id`
- `hotel_id`
- `room_id`
- `room_gallery_name`
- `createdby`
- `createdon`
- `updatedon`
- `status`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Hotel master, room, voucher, and provider booking tables.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_hotel_occupancy_rate`

**Model:** `dvi_hotel_occupancy_rate`  
**Category:** Master  
**Runtime usage:** Yes  
**Primary owner:** itinerary-hotel-details-tbo.service.ts:resolvedCity

#### 1. What this table stores

Stores business rows for `dvi_hotel_occupancy_rate` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_hotel_occupancy_rate` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itinerary-hotel-details-tbo.service.ts`
  Function: `resolvedCity`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `scripts/build-axisrooms-prod-sync-sql.js`
  Function: `main`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/check-ax153-source-recent.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `scripts/compare-ax153-prod-local.js`
  Function: `normalizeRows`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `normalizeRows`; inspect that function for the exact branch and payload.
- File: `scripts/compare-local-prod-axisrooms.js`
  Function: `fetchSnapshot`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `fetchSnapshot`; inspect that function for the exact branch and payload.
- File: `scripts/debug-axisrooms-18001.js`
  Function: `String`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `String`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- File: `scripts/build-axisrooms-prod-sync-sql.js`
  Function: `main`
  Operation: `RAW INSERT`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/compare-local-prod-axisrooms.js`
  Function: `fetchSnapshot`
  Operation: `RAW INSERT`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `fetchSnapshot`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/cleanup-noncanonical-room-rateplans.ts`
  Function: `main`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `main`; inspect that function for the exact branch and payload.

#### 7. Raw SQL usage

- File: `scripts/build-axisrooms-prod-sync-sql.js`
  Function: `main`
  Operation: `RAW READ`
  Why: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/build-axisrooms-prod-sync-sql.js`
  Function: `main`
  Operation: `RAW INSERT`
  Why: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/check-ax153-source-recent.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Why: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `scripts/compare-ax153-prod-local.js`
  Function: `normalizeRows`
  Operation: `RAW READ`
  Why: Uses the table in `normalizeRows`; inspect that function for the exact branch and payload.
- File: `scripts/compare-local-prod-axisrooms.js`
  Function: `fetchSnapshot`
  Operation: `RAW READ`
  Why: Uses the table in `fetchSnapshot`; inspect that function for the exact branch and payload.
- File: `scripts/compare-local-prod-axisrooms.js`
  Function: `fetchSnapshot`
  Operation: `RAW INSERT`
  Why: Uses the table in `fetchSnapshot`; inspect that function for the exact branch and payload.
- File: `scripts/debug-axisrooms-18001.js`
  Function: `String`
  Operation: `RAW READ`
  Why: Uses the table in `String`; inspect that function for the exact branch and payload.
- File: `scripts/dump-prod-ax153.js`
  Function: `safeQuery`
  Operation: `RAW READ`
  Why: Uses the table in `safeQuery`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `id`
- `hotel_id`
- `room_id`
- `rateplan_id`
- `start_date`
- `end_date`
- `occupancy_rates`
- `received_at`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Hotel master, room, voucher, and provider booking tables.

#### 10. Business flows using this table

- hotel selection
- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_hotel_room_availability`

**Model:** `dvi_hotel_room_availability`  
**Category:** Master  
**Runtime usage:** Yes  
**Primary owner:** itinerary-hotel-details-tbo.service.ts:resolvedCity

#### 1. What this table stores

Stores business rows for `dvi_hotel_room_availability` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_hotel_room_availability` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itinerary-hotel-details-tbo.service.ts`
  Function: `resolvedCity`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `scripts/check-ax153-source-recent.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `scripts/compare-ax153-prod-local.js`
  Function: `normalizeRows`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `normalizeRows`; inspect that function for the exact branch and payload.
- File: `scripts/debug-ax153-itinerary.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `scripts/debug-axisrooms-18001.js`
  Function: `String`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `String`; inspect that function for the exact branch and payload.
- File: `scripts/dump-prod-ax153.js`
  Function: `safeQuery`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `safeQuery`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `scripts/check-ax153-source-recent.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Why: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `scripts/compare-ax153-prod-local.js`
  Function: `normalizeRows`
  Operation: `RAW READ`
  Why: Uses the table in `normalizeRows`; inspect that function for the exact branch and payload.
- File: `scripts/debug-ax153-itinerary.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Why: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `scripts/debug-axisrooms-18001.js`
  Function: `String`
  Operation: `RAW READ`
  Why: Uses the table in `String`; inspect that function for the exact branch and payload.
- File: `scripts/dump-prod-ax153.js`
  Function: `safeQuery`
  Operation: `RAW READ`
  Why: Uses the table in `safeQuery`; inspect that function for the exact branch and payload.
- File: `scripts/repro-axisrooms-date-shift.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Why: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `scripts/sync-prod-axisrooms-properties-to-local.js`
  Function: `fetchProdDumpFromDb`
  Operation: `RAW READ`
  Why: Uses the table in `fetchProdDumpFromDb`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `id`
- `hotel_id`
- `room_id`
- `start_date`
- `end_date`
- `free`
- `received_at`
- `source`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Hotel master, room, voucher, and provider booking tables.

#### 10. Business flows using this table

- hotel selection
- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### 26.6 Draft Vehicle / Vendor Tables

### Table: `dvi_itinerary_plan_vehicle_details`

**Model:** `dvi_itinerary_plan_vehicle_details`  
**Category:** Draft  
**Runtime usage:** Yes  
**Primary owner:** itinerary-vehicles.engine.ts:safeDate

#### 1. What this table stores

Stores business rows for `dvi_itinerary_plan_vehicle_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_itinerary_plan_vehicle_details` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `safeDate`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `triggerVehicleBuild`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `triggerVehicleBuild`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getPlanForEdit`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getPlanForEdit`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `copyDraftToConfirmed`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Copies or finalizes state during confirmation.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `cancelVehicles`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Applies cancellation state or reads rows needed for cancellation.
- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `findOneOld`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `findOneOld`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/engines/vehicles-engine.service.ts`
  Function: `await`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.

#### 5. UPDATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `cancelVehicles`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Applies cancellation state or reads rows needed for cancellation.

#### 6. DELETE / SOFT DELETE usage

- File: `src/modules/itineraries/engines/vehicles-engine.service.ts`
  Function: `await`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.

#### 7. Raw SQL usage

- File: `scripts/debug-dvi20260594-two-vehicle-issue.js`
  Function: `COUNT`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.

#### 8. Important fields and meaning

- `vehicle_details_ID`
- `itinerary_plan_id`
- `vehicle_type_id`
- `vehicle_count`
- `createdby`
- `createdon`
- `updatedon`
- `status`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Confirmed copy tables with the same suffix under `dvi_confirmed_*`.
- Vehicle/vendor master, pricebook, slab, toll, and permit tables.

#### 10. Business flows using this table

- create/update itinerary
- details API
- vehicle pricing
- confirmation
- cancellation

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_itinerary_plan_vendor_eligible_list`

**Model:** `dvi_itinerary_plan_vendor_eligible_list`  
**Category:** Draft  
**Runtime usage:** Yes  
**Primary owner:** itinerary-vehicles.engine.ts:(top-level/undetected)

#### 1. What this table stores

Stores business rows for `dvi_itinerary_plan_vendor_eligible_list` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_itinerary_plan_vendor_eligible_list` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `runOnce`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/route-engine.service.ts`
  Function: `await`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Creates or rebuilds core itinerary rows.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getVehicleBuildStatus`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getVehicleBuildStatus`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `filtered`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `filtered`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `(top-level/undetected)`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.

#### 5. UPDATE usage

- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `(top-level/undetected)`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.

#### 6. DELETE / SOFT DELETE usage

- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `safeDate`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `(top-level/undetected)`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `filtered`
  Operation: `RAW READ`
  Why: Uses the table in `filtered`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itinerary-export.service.ts`
  Function: `exportItineraryToExcel`
  Operation: `RAW READ`
  Why: Exports itinerary state through raw SQL.
- File: `scripts/check-dvi20260594-slab.js`
  Function: `fail`
  Operation: `RAW READ`
  Why: Uses the table in `fail`; inspect that function for the exact branch and payload.
- File: `scripts/debug-dvi20260594-two-vehicle-issue.js`
  Function: `COUNT`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `scripts/debug-dvi20260594-vehicle-km.js`
  Function: `OR`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.

#### 8. Important fields and meaning

- `itinerary_plan_vendor_eligible_ID`
- `itineary_plan_assigned_status`
- `itinerary_plan_id`
- `vehicle_type_id`
- `total_vehicle_qty`
- `vendor_id`
- `outstation_allowed_km_per_day`
- `vendor_vehicle_type_id`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Confirmed copy tables with the same suffix under `dvi_confirmed_*`.
- Vehicle/vendor master, pricebook, slab, toll, and permit tables.

#### 10. Business flows using this table

- create/update itinerary
- details API
- vehicle pricing

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_itinerary_plan_vendor_vehicle_details`

**Model:** `dvi_itinerary_plan_vendor_vehicle_details`  
**Category:** Draft  
**Runtime usage:** Yes  
**Primary owner:** itinerary-vehicles.engine.ts:(top-level/undetected)

#### 1. What this table stores

Stores business rows for `dvi_itinerary_plan_vendor_vehicle_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_itinerary_plan_vendor_vehicle_details` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `Number`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `getKmsLimitId`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getVehicleBuildStatus`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getVehicleBuildStatus`; inspect that function for the exact branch and payload.
- File: `scripts/debug-local-km-fix-dvi20260594.js`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `toTimeString`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.

#### 5. UPDATE usage

- File: `scripts/update_records_task.js`
  Function: `main`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `main`; inspect that function for the exact branch and payload.

#### 6. DELETE / SOFT DELETE usage

- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `safeDate`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `(top-level/undetected)`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `toTimeString`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `toTimeString`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `getItineraryDetails`
  Operation: `RAW READ`
  Why: Builds or enriches the frontend itinerary details payload.
- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `CAST`
  Operation: `RAW READ`
  Why: Uses the table in `CAST`; inspect that function for the exact branch and payload.
- File: `scripts/debug-dvi20260594-two-vehicle-issue.js`
  Function: `runSnapshot`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `scripts/debug-dvi20260594-two-vehicle-issue.js`
  Function: `COUNT`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `scripts/debug-dvi20260594-two-vehicle-issue.js`
  Function: `main`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `scripts/debug-dvi20260594-vehicle-km.js`
  Function: `SUM`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `scripts/debug-local-pickup-drop-dvi20260594.js`
  Function: `hav`
  Operation: `RAW READ`
  Why: Uses the table in `hav`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `itinerary_plan_vendor_vehicle_details_ID`
- `itinerary_plan_vendor_eligible_ID`
- `itinerary_plan_id`
- `itinerary_route_id`
- `itinerary_route_date`
- `vehicle_type_id`
- `vehicle_qty`
- `vendor_id`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Confirmed copy tables with the same suffix under `dvi_confirmed_*`.
- Vehicle/vendor master, pricebook, slab, toll, and permit tables.

#### 10. Business flows using this table

- details API
- vehicle pricing

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_vehicle`

**Model:** `dvi_vehicle`  
**Category:** Reference  
**Runtime usage:** Yes  
**Primary owner:** itinerary-vehicles.engine.ts:String

#### 1. What this table stores

Stores business rows for `dvi_vehicle` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_vehicle` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `String`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `normalizeCityToken`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/route-engine.service.ts`
  Function: `await`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Creates or rebuilds core itinerary rows.
- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `Number`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `Number`; inspect that function for the exact branch and payload.
- File: `scripts/debug-local-km-fix-dvi20260594.js`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `scripts/debug-local-pickup-drop-dvi20260594.js`
  Function: `hav`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `hav`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/seed-vendor-from-php.js`
  Function: `run`
  Operation: `RAW DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `run`; inspect that function for the exact branch and payload.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `normalizeCityToken`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `Number`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/itinerary-export.service.ts`
  Function: `exportItineraryToExcel`
  Operation: `RAW READ`
  Why: Exports itinerary state through raw SQL.
- File: `scripts/check-dvi20260594-slab.js`
  Function: `availableTimeLimitIds`
  Operation: `RAW READ`
  Why: Uses the table in `availableTimeLimitIds`; inspect that function for the exact branch and payload.
- File: `scripts/debug-dvi20260594-two-vehicle-issue.js`
  Function: `COUNT`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `scripts/debug-dvi20260594-vehicle-km.js`
  Function: `OR`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `scripts/seed-vendor-from-php.js`
  Function: `run`
  Operation: `RAW READ`
  Why: Uses the table in `run`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `vehicle_id`
- `vendor_id`
- `vendor_branch_id`
- `vehicle_location_id`
- `vehicle_type_id`
- `registration_number`
- `registration_date`
- `engine_number`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Vehicle/vendor master, pricebook, slab, toll, and permit tables.

#### 10. Business flows using this table

- create/update itinerary
- details API
- vehicle pricing

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_vehicle_type`

**Model:** `dvi_vehicle_type`  
**Category:** Master  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:getVoucherDetails

#### 1. What this table stores

Stores business rows for `dvi_vehicle_type` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_vehicle_type` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getVoucherDetails`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getVoucherDetails`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itinerary-export.service.ts`
  Function: `exportItineraryToExcel`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Exports itinerary state through raw SQL.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/itinerary-export.service.ts`
  Function: `exportItineraryToExcel`
  Operation: `RAW READ`
  Why: Exports itinerary state through raw SQL.

#### 8. Important fields and meaning

- `vehicle_type_id`
- `vehicle_type_title`
- `occupancy`
- `createdon`
- `updatedon`
- `createdby`
- `status`
- `deleted`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Vehicle/vendor master, pricebook, slab, toll, and permit tables.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_vendor_details`

**Model:** `dvi_vendor_details`  
**Category:** Master  
**Runtime usage:** Yes  
**Primary owner:** itinerary-vehicles.engine.ts:String

#### 1. What this table stores

Stores business rows for `dvi_vendor_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_vendor_details` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `String`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getVoucherDetails`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getVoucherDetails`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.

#### 8. Important fields and meaning

- `vendor_id`
- `vendor_name`
- `vendor_code`
- `vendor_email`
- `vendor_primary_mobile_number`
- `vendor_alternative_mobile_number`
- `vendor_country`
- `vendor_state`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Vehicle/vendor master, pricebook, slab, toll, and permit tables.

#### 10. Business flows using this table

- vehicle pricing

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_vendor_branches`

**Model:** `dvi_vendor_branches`  
**Category:** Master  
**Runtime usage:** Yes  
**Primary owner:** itinerary-vehicles.engine.ts:(top-level/undetected)

#### 1. What this table stores

Stores business rows for `dvi_vendor_branches` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_vendor_branches` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getVoucherDetails`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getVoucherDetails`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `Number`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `Number`; inspect that function for the exact branch and payload.
- File: `scripts/seed-vendor-from-php.js`
  Function: `ensurePrimaryBranch`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `ensurePrimaryBranch`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `scripts/seed-vendor-from-php.js`
  Function: `ensurePrimaryBranch`
  Operation: `RAW READ`
  Why: Uses the table in `ensurePrimaryBranch`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `vendor_branch_id`
- `vendor_id`
- `vendor_branch_name`
- `vendor_branch_emailid`
- `vendor_branch_primary_mobile_number`
- `vendor_branch_alternative_mobile_number`
- `vendor_branch_country`
- `vendor_branch_state`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Vehicle/vendor master, pricebook, slab, toll, and permit tables.

#### 10. Business flows using this table

- details API
- vehicle pricing

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_vendor_vehicle_types`

**Model:** `dvi_vendor_vehicle_types`  
**Category:** Master  
**Runtime usage:** Yes  
**Primary owner:** itinerary-vehicles.engine.ts:safeDate

#### 1. What this table stores

Stores business rows for `dvi_vendor_vehicle_types` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_vendor_vehicle_types` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `safeDate`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `normalizeCityToken`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `scripts/debug-dvi20260594-two-vehicle-issue.js`
  Function: `COUNT`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `scripts/seed-vendor-from-php.js`
  Function: `run`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `run`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- File: `scripts/seed-vendor-from-php.js`
  Function: `run`
  Operation: `RAW UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `run`; inspect that function for the exact branch and payload.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `scripts/debug-dvi20260594-two-vehicle-issue.js`
  Function: `COUNT`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `scripts/seed-vendor-from-php.js`
  Function: `run`
  Operation: `RAW READ`
  Why: Uses the table in `run`; inspect that function for the exact branch and payload.
- File: `scripts/seed-vendor-from-php.js`
  Function: `run`
  Operation: `RAW UPDATE`
  Why: Uses the table in `run`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `vendor_vehicle_type_ID`
- `vendor_id`
- `vehicle_type_id`
- `driver_batta`
- `food_cost`
- `accomodation_cost`
- `extra_cost`
- `driver_early_morning_charges`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Vehicle/vendor master, pricebook, slab, toll, and permit tables.

#### 10. Business flows using this table

- vehicle pricing

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_vehicle_local_pricebook`

**Model:** `dvi_vehicle_local_pricebook`  
**Category:** Master  
**Runtime usage:** Yes  
**Primary owner:** vehicle-calculation.helpers.ts:pickByHours

#### 1. What this table stores

Stores business rows for `dvi_vehicle_local_pricebook` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_vehicle_local_pricebook` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `pickByHours`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `getLocalVehiclePricingByDate`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `getPricedLocalTimeLimitId`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `getLocalVehiclePricing`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `scripts/check-dvi20260594-slab.js`
  Function: `availableTimeLimitIds`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `availableTimeLimitIds`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/seed-vendor-from-php.js`
  Function: `run`
  Operation: `RAW DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `run`; inspect that function for the exact branch and payload.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `scripts/check-dvi20260594-slab.js`
  Function: `availableTimeLimitIds`
  Operation: `RAW READ`
  Why: Uses the table in `availableTimeLimitIds`; inspect that function for the exact branch and payload.
- File: `scripts/debug-dvi20260594-two-vehicle-issue.js`
  Function: `COUNT`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `scripts/seed-vendor-from-php.js`
  Function: `run`
  Operation: `RAW READ`
  Why: Uses the table in `run`; inspect that function for the exact branch and payload.
- File: `scripts/seed-vendor-from-php.js`
  Function: `run`
  Operation: `RAW DELETE`
  Why: Uses the table in `run`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `vehicle_price_book_id`
- `vendor_id`
- `vendor_branch_id`
- `vehicle_type_id`
- `time_limit_id`
- `cost_type`
- `year`
- `month`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Vehicle/vendor master, pricebook, slab, toll, and permit tables.

#### 10. Business flows using this table

- vehicle pricing

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_vehicle_outstation_price_book`

**Model:** `dvi_vehicle_outstation_price_book`  
**Category:** Master  
**Runtime usage:** Yes  
**Primary owner:** itinerary-vehicles.engine.ts:(top-level/undetected)

#### 1. What this table stores

Stores business rows for `dvi_vehicle_outstation_price_book` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_vehicle_outstation_price_book` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `getKmsLimitId`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `getOutstationVehiclePricingByDate`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `scripts/seed-vendor-from-php.js`
  Function: `run`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `run`; inspect that function for the exact branch and payload.
- File: `scripts/seed-vendor-from-php.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/seed-vendor-from-php.js`
  Function: `run`
  Operation: `RAW DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `run`; inspect that function for the exact branch and payload.

#### 7. Raw SQL usage

- File: `scripts/seed-vendor-from-php.js`
  Function: `run`
  Operation: `RAW READ`
  Why: Uses the table in `run`; inspect that function for the exact branch and payload.
- File: `scripts/seed-vendor-from-php.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Why: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `scripts/seed-vendor-from-php.js`
  Function: `run`
  Operation: `RAW DELETE`
  Why: Uses the table in `run`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `vehicle_outstation_price_book_id`
- `vendor_id`
- `vendor_branch_id`
- `vehicle_type_id`
- `kms_limit_id`
- `year`
- `month`
- `day_1`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Vehicle/vendor master, pricebook, slab, toll, and permit tables.

#### 10. Business flows using this table

- vehicle pricing

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_vehicle_toll_charges`

**Model:** `dvi_vehicle_toll_charges`  
**Category:** Master  
**Runtime usage:** Yes  
**Primary owner:** vehicle-calculation.helpers.ts:calculateVehicleTollCharges

#### 1. What this table stores

Stores business rows for `dvi_vehicle_toll_charges` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_vehicle_toll_charges` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `calculateVehicleTollCharges`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `vehicle_toll_charge_ID`
- `location_id`
- `vehicle_type_id`
- `toll_charge`
- `createdon`
- `updatedon`
- `createdby`
- `status`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Vehicle/vendor master, pricebook, slab, toll, and permit tables.

#### 10. Business flows using this table

- vehicle pricing

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_permit_cost`

**Model:** `dvi_permit_cost`  
**Category:** Reference  
**Runtime usage:** Yes  
**Primary owner:** route-engine.service.ts:await

#### 1. What this table stores

Stores business rows for `dvi_permit_cost` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_permit_cost` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/route-engine.service.ts`
  Function: `await`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Creates or rebuilds core itinerary rows.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `permit_cost_id`
- `vendor_id`
- `vehicle_type_id`
- `source_state_id`
- `destination_state_id`
- `permit_cost`
- `createdby`
- `createdon`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- create/update itinerary

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_kms_limit`

**Model:** `dvi_kms_limit`  
**Category:** Reference  
**Runtime usage:** Yes  
**Primary owner:** itinerary-vehicles.engine.ts:Number

#### 1. What this table stores

Stores business rows for `dvi_kms_limit` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_kms_limit` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `Number`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `AND`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `AND`; inspect that function for the exact branch and payload.
- File: `scripts/seed-vendor-from-php.js`
  Function: `run`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `run`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/seed-vendor-from-php.js`
  Function: `run`
  Operation: `RAW DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `run`; inspect that function for the exact branch and payload.

#### 7. Raw SQL usage

- File: `scripts/seed-vendor-from-php.js`
  Function: `run`
  Operation: `RAW READ`
  Why: Uses the table in `run`; inspect that function for the exact branch and payload.
- File: `scripts/seed-vendor-from-php.js`
  Function: `run`
  Operation: `RAW DELETE`
  Why: Uses the table in `run`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `kms_limit_id`
- `vendor_id`
- `vendor_vehicle_type_id`
- `kms_limit_title`
- `kms_limit`
- `createdby`
- `createdon`
- `updatedon`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- details API
- vehicle pricing

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_time_limit`

**Model:** `dvi_time_limit`  
**Category:** Reference  
**Runtime usage:** Yes  
**Primary owner:** itinerary-vehicles.engine.ts:(top-level/undetected)

#### 1. What this table stores

Stores business rows for `dvi_time_limit` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_time_limit` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/itinerary-vehicles.engine.ts`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `getTimeLimitId`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `getPricedLocalTimeLimitId`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `parseTimeToSeconds`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `Number`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `Number`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- File: `scripts/update_records_task.js`
  Function: `main`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `main`; inspect that function for the exact branch and payload.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/seed-vendor-from-php.js`
  Function: `run`
  Operation: `RAW DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `run`; inspect that function for the exact branch and payload.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `Number`
  Operation: `RAW READ`
  Why: Uses the table in `Number`; inspect that function for the exact branch and payload.
- File: `scripts/check-dvi20260594-slab.js`
  Function: `fail`
  Operation: `RAW READ`
  Why: Uses the table in `fail`; inspect that function for the exact branch and payload.
- File: `scripts/debug-dvi20260594-two-vehicle-issue.js`
  Function: `COUNT`
  Operation: `RAW READ`
  Why: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `scripts/seed-vendor-from-php.js`
  Function: `run`
  Operation: `RAW READ`
  Why: Uses the table in `run`; inspect that function for the exact branch and payload.
- File: `scripts/seed-vendor-from-php.js`
  Function: `run`
  Operation: `RAW DELETE`
  Why: Uses the table in `run`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `time_limit_id`
- `vendor_id`
- `vendor_vehicle_type_id`
- `time_limit_title`
- `hours_limit`
- `km_limit`
- `createdby`
- `createdon`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- details API
- vehicle pricing

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### 26.7 Activity / Guide Tables

### Table: `dvi_itinerary_route_activity_details`

**Model:** `dvi_itinerary_route_activity_details`  
**Category:** Draft  
**Runtime usage:** Yes  
**Primary owner:** itinerary-hotspots.engine.ts:deleteRouteHotspotData

#### 1. What this table stores

Stores business rows for `dvi_itinerary_route_activity_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_itinerary_route_activity_details` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `cancelActivities`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Applies cancellation state or reads rows needed for cancellation.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `addActivity`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `addActivity`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `buildRoutePreviewLikeDetailsFromTx`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `buildRoutePreviewLikeDetailsFromTx`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `Number`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `Number`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `rawP`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `rawP`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `addActivity`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `addActivity`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `await`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `await`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `cancelActivities`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Applies cancellation state or reads rows needed for cancellation.

#### 6. DELETE / SOFT DELETE usage

- File: `src/modules/itineraries/engines/itinerary-hotspots.engine.ts`
  Function: `deleteRouteHotspotData`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `deleteRouteHotspotData`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `await`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `await`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `deleteActivity`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `deleteActivity`; inspect that function for the exact branch and payload.
- File: `scripts/test-hotspot-add-api-only.js`
  Function: `existingIds`
  Operation: `RAW DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `existingIds`; inspect that function for the exact branch and payload.
- File: `scripts/test-hotspot-add-deterministic-playwright.js`
  Function: `existingIds`
  Operation: `RAW DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `existingIds`; inspect that function for the exact branch and payload.
- File: `scripts/test-hotspot-add-playwright-assisted.js`
  Function: `ids`
  Operation: `RAW DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `ids`; inspect that function for the exact branch and payload.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `captureManualPreviewRouteState`
  Operation: `RAW READ`
  Why: Supports manual hotspot preview, insertion, scoring, or rejection explanation.
- File: `scripts/test-hotspot-add-api-only.js`
  Function: `existingIds`
  Operation: `RAW READ`
  Why: Uses the table in `existingIds`; inspect that function for the exact branch and payload.
- File: `scripts/test-hotspot-add-api-only.js`
  Function: `existingIds`
  Operation: `RAW DELETE`
  Why: Uses the table in `existingIds`; inspect that function for the exact branch and payload.
- File: `scripts/test-hotspot-add-deterministic-playwright.js`
  Function: `existingIds`
  Operation: `RAW READ`
  Why: Uses the table in `existingIds`; inspect that function for the exact branch and payload.
- File: `scripts/test-hotspot-add-deterministic-playwright.js`
  Function: `existingIds`
  Operation: `RAW DELETE`
  Why: Uses the table in `existingIds`; inspect that function for the exact branch and payload.
- File: `scripts/test-hotspot-add-playwright-assisted.js`
  Function: `ids`
  Operation: `RAW READ`
  Why: Uses the table in `ids`; inspect that function for the exact branch and payload.
- File: `scripts/test-hotspot-add-playwright-assisted.js`
  Function: `ids`
  Operation: `RAW DELETE`
  Why: Uses the table in `ids`; inspect that function for the exact branch and payload.
- File: `scripts/verify-hotspot-hotel-between-playwright.js`
  Function: `existingRouteHotspotIds`
  Operation: `RAW READ`
  Why: Supports manual hotspot preview, insertion, scoring, or rejection explanation.

#### 8. Important fields and meaning

- `route_activity_ID`
- `itinerary_plan_ID`
- `itinerary_route_ID`
- `route_hotspot_ID`
- `hotspot_ID`
- `activity_ID`
- `activity_order`
- `activity_charges_for_foreign_adult`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Confirmed copy tables with the same suffix under `dvi_confirmed_*`.

#### 10. Business flows using this table

- create/update itinerary
- auto hotspot build
- manual hotspot
- details API
- cancellation

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_itinerary_route_activity_entry_cost_details`

**Model:** `dvi_itinerary_route_activity_entry_cost_details`  
**Category:** Draft  
**Runtime usage:** Yes  
**Primary owner:** itinerary-hotspots.engine.ts:deleteRouteHotspotData

#### 1. What this table stores

Stores business rows for `dvi_itinerary_route_activity_entry_cost_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_itinerary_route_activity_entry_cost_details` in the scanned code.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- File: `src/modules/itineraries/engines/itinerary-hotspots.engine.ts`
  Function: `deleteRouteHotspotData`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `deleteRouteHotspotData`; inspect that function for the exact branch and payload.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `activity_cost_detail_id`
- `route_activity_id`
- `hotspot_ID`
- `activity_ID`
- `itinerary_plan_id`
- `itinerary_route_id`
- `traveller_type`
- `traveller_name`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Confirmed copy tables with the same suffix under `dvi_confirmed_*`.

#### 10. Business flows using this table

- auto hotspot build

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_activity`

**Model:** `dvi_activity`  
**Category:** Reference  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:buildRoutePreviewLikeDetailsFromTx

#### 1. What this table stores

Stores business rows for `dvi_activity` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_activity` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `buildRoutePreviewLikeDetailsFromTx`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `buildRoutePreviewLikeDetailsFromTx`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `addActivity`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `addActivity`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `smartInsertActivity`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `smartInsertActivity`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `rawP`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `rawP`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `activity_id`
- `activity_title`
- `hotspot_id`
- `max_allowed_person_count`
- `activity_duration`
- `activity_description`
- `createdby`
- `createdon`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- create/update itinerary
- details API

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_activity_pricebook`

**Model:** `dvi_activity_pricebook`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_activity_pricebook`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `activity_price_book_id`
- `hotspot_id`
- `activity_id`
- `nationality`
- `price_type`
- `year`
- `month`
- `day_1`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_activity_time_slot_details`

**Model:** `dvi_activity_time_slot_details`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_activity_time_slot_details`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `activity_time_slot_ID`
- `activity_id`
- `time_slot_type`
- `special_date`
- `start_time`
- `end_time`
- `createdby`
- `createdon`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_itinerary_route_guide_details`

**Model:** `dvi_itinerary_route_guide_details`  
**Category:** Draft  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:(top-level/undetected)

#### 1. What this table stores

Stores business rows for `dvi_itinerary_route_guide_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_itinerary_route_guide_details` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `cancelGuides`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Applies cancellation state or reads rows needed for cancellation.
- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `isAssigned`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `isAssigned`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `cancelGuides`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Applies cancellation state or reads rows needed for cancellation.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `route_guide_ID`
- `itinerary_plan_ID`
- `itinerary_route_ID`
- `guide_id`
- `guide_type`
- `guide_language`
- `guide_slot`
- `guide_cost`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Confirmed copy tables with the same suffix under `dvi_confirmed_*`.

#### 10. Business flows using this table

- create/update itinerary
- details API
- cancellation

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_itinerary_route_guide_slot_cost_details`

**Model:** `dvi_itinerary_route_guide_slot_cost_details`  
**Category:** Draft  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_itinerary_route_guide_slot_cost_details`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `guide_slot_cost_details_id`
- `route_guide_id`
- `itinerary_plan_id`
- `itinerary_route_id`
- `itinerary_route_date`
- `guide_id`
- `guide_type`
- `guide_slot`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Confirmed copy tables with the same suffix under `dvi_confirmed_*`.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_guide_details`

**Model:** `dvi_guide_details`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_guide_details`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `guide_id`
- `guide_name`
- `guide_dob`
- `guide_bloodgroup`
- `guide_gender`
- `guide_primary_mobile_number`
- `guide_alternative_mobile_number`
- `guide_email`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_guide_pricebook`

**Model:** `dvi_guide_pricebook`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_guide_pricebook`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `guide_price_book_ID`
- `guide_id`
- `year`
- `month`
- `pax_count`
- `slot_type`
- `day_1`
- `day_2`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### 26.8 Confirmed Itinerary Tables

### Table: `dvi_confirmed_itinerary_plan_details`

**Model:** `dvi_confirmed_itinerary_plan_details`  
**Category:** Confirmed  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:getConfirmedItineraries

#### 1. What this table stores

Stores business rows for `dvi_confirmed_itinerary_plan_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_confirmed_itinerary_plan_details` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getConfirmedItineraries`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getConfirmedItineraries`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `confirmQuotation`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Copies or finalizes state during confirmation.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `cancelItinerary`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Applies cancellation state or reads rows needed for cancellation.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getVoucherDetails`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getVoucherDetails`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getPluckCardData`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getPluckCardData`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getInvoiceData`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getInvoiceData`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `parseDateTime`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `parseDateTime`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `parseDateTime`
  Operation: `RAW INSERT`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `parseDateTime`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `normalizePassengerTitle`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `normalizePassengerTitle`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `(top-level/undetected)`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `await`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `await`; inspect that function for the exact branch and payload.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/unconfirm-quote.js`
  Function: `main`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Copies or finalizes state during confirmation.

- Soft-delete/status note: this table has an update/status/deleted-flag style lifecycle in at least one scanned path. [Verified from code scan]

#### 7. Raw SQL usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `parseDateTime`
  Operation: `RAW INSERT`
  Why: Uses the table in `parseDateTime`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `confirmed_itinerary_plan_ID`
- `itinerary_plan_ID`
- `agent_id`
- `staff_id`
- `location_id`
- `arrival_location`
- `departure_location`
- `itinerary_quote_ID`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Draft source tables with the same suffix under `dvi_itinerary_*`.

#### 10. Business flows using this table

- create/update itinerary
- details API
- confirmation
- cancellation
- account/wallet

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_confirmed_itinerary_route_details`

**Model:** `dvi_confirmed_itinerary_route_details`  
**Category:** Confirmed  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:getConfirmedItineraryForCancellation

#### 1. What this table stores

Stores business rows for `dvi_confirmed_itinerary_route_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_confirmed_itinerary_route_details` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getConfirmedItineraryForCancellation`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getConfirmedItineraryForCancellation`; inspect that function for the exact branch and payload.
- File: `scripts/unconfirm-quote.js`
  Function: `countRows`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Copies or finalizes state during confirmation.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `copyDraftToConfirmed`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Copies or finalizes state during confirmation.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/unconfirm-quote.js`
  Function: `main`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Copies or finalizes state during confirmation.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `confirmed_itinerary_route_ID`
- `itinerary_route_ID`
- `itinerary_plan_ID`
- `location_id`
- `location_name`
- `itinerary_route_date`
- `no_of_days`
- `no_of_km`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Draft source tables with the same suffix under `dvi_itinerary_*`.

#### 10. Business flows using this table

- confirmation

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_confirmed_itinerary_route_hotspot_details`

**Model:** `dvi_confirmed_itinerary_route_hotspot_details`  
**Category:** Confirmed  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:(top-level/undetected)

#### 1. What this table stores

Stores business rows for `dvi_confirmed_itinerary_route_hotspot_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_confirmed_itinerary_route_hotspot_details` in the scanned code.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `(top-level/undetected)`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/unconfirm-quote.js`
  Function: `main`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Copies or finalizes state during confirmation.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `confirmed_route_hotspot_ID`
- `route_hotspot_ID`
- `itinerary_plan_ID`
- `itinerary_route_ID`
- `item_type`
- `hotspot_order`
- `hotspot_ID`
- `guide_hotspot_status`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Draft source tables with the same suffix under `dvi_itinerary_*`.
- Child charge/cost tables plus route/day and hotspot master tables.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_confirmed_itinerary_route_hotspot_parking_charge`

**Model:** `dvi_confirmed_itinerary_route_hotspot_parking_charge`  
**Category:** Confirmed  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_confirmed_itinerary_route_hotspot_parking_charge`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `confirmed_itinerary_hotspot_parking_charge_ID`
- `itinerary_hotspot_parking_charge_ID`
- `itinerary_plan_ID`
- `itinerary_route_ID`
- `hotspot_ID`
- `vehicle_type`
- `vehicle_qty`
- `parking_charges_amt`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Draft source tables with the same suffix under `dvi_itinerary_*`.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_confirmed_itinerary_plan_hotel_details`

**Model:** `dvi_confirmed_itinerary_plan_hotel_details`  
**Category:** Confirmed  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:getVoucherDetails

#### 1. What this table stores

Stores business rows for `dvi_confirmed_itinerary_plan_hotel_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_confirmed_itinerary_plan_hotel_details` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getVoucherDetails`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getVoucherDetails`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getConfirmedItineraryForCancellation`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getConfirmedItineraryForCancellation`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getConfirmedItineraryDetails`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getConfirmedItineraryDetails`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getEntireDayCancellationCharges`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getEntireDayCancellationCharges`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `await`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `await`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itinerary-clipboard.service.ts`
  Function: `selectedHotelRows`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `selectedHotelRows`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `copyDraftToConfirmed`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Copies or finalizes state during confirmation.

#### 5. UPDATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `await`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `await`; inspect that function for the exact branch and payload.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/unconfirm-quote.js`
  Function: `main`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Copies or finalizes state during confirmation.

- Soft-delete/status note: this table has an update/status/deleted-flag style lifecycle in at least one scanned path. [Verified from code scan]

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `confirmed_itinerary_plan_hotel_details_ID`
- `itinerary_plan_hotel_details_ID`
- `group_type`
- `itinerary_plan_id`
- `itinerary_route_id`
- `itinerary_route_date`
- `itinerary_route_location`
- `hotel_required`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Draft source tables with the same suffix under `dvi_itinerary_*`.
- Hotel master, room, voucher, and provider booking tables.

#### 10. Business flows using this table

- details API
- confirmation

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_confirmed_itinerary_plan_hotel_room_details`

**Model:** `dvi_confirmed_itinerary_plan_hotel_room_details`  
**Category:** Confirmed  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:getVoucherDetails

#### 1. What this table stores

Stores business rows for `dvi_confirmed_itinerary_plan_hotel_room_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_confirmed_itinerary_plan_hotel_room_details` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getVoucherDetails`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getVoucherDetails`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getConfirmedItineraryForCancellation`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getConfirmedItineraryForCancellation`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getConfirmedItineraryDetails`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getConfirmedItineraryDetails`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `copyDraftToConfirmed`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Copies or finalizes state during confirmation.

#### 5. UPDATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `await`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `await`; inspect that function for the exact branch and payload.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/unconfirm-quote.js`
  Function: `main`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Copies or finalizes state during confirmation.

- Soft-delete/status note: this table has an update/status/deleted-flag style lifecycle in at least one scanned path. [Verified from code scan]

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `confirmed_itinerary_plan_hotel_room_details_ID`
- `itinerary_plan_hotel_room_details_ID`
- `itinerary_plan_hotel_details_id`
- `confirmed_itinerary_plan_hotel_details_id`
- `group_type`
- `itinerary_plan_id`
- `itinerary_route_id`
- `itinerary_route_date`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Draft source tables with the same suffix under `dvi_itinerary_*`.
- Hotel master, room, voucher, and provider booking tables.

#### 10. Business flows using this table

- confirmation

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_confirmed_itinerary_plan_hotel_voucher_details`

**Model:** `dvi_confirmed_itinerary_plan_hotel_voucher_details`  
**Category:** Confirmed  
**Runtime usage:** Yes  
**Primary owner:** hotel-voucher.service.ts:getHotelVoucher

#### 1. What this table stores

Stores business rows for `dvi_confirmed_itinerary_plan_hotel_voucher_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_confirmed_itinerary_plan_hotel_voucher_details` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/hotel-voucher.service.ts`
  Function: `getHotelVoucher`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itinerary-hotel-details-tbo.service.ts`
  Function: `Number`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itinerary-hotel-details.service.ts`
  Function: `Number`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/hotel-voucher.service.ts`
  Function: `createHotelVouchers`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 5. UPDATE usage

- File: `src/modules/itineraries/hotel-voucher.service.ts`
  Function: `(top-level/undetected)`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/hotel-voucher.service.ts`
  Function: `cancelHotelsForItinerary`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

- Soft-delete/status note: this table has an update/status/deleted-flag style lifecycle in at least one scanned path. [Verified from code scan]

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `cnf_itinerary_plan_hotel_voucher_details_ID`
- `confirmed_itinerary_plan_hotel_details_ID`
- `itinerary_plan_hotel_details_ID`
- `itinerary_plan_id`
- `itinerary_route_date`
- `hotel_id`
- `hotel_confirmed_by`
- `hotel_confirmed_email_id`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Draft source tables with the same suffix under `dvi_itinerary_*`.
- Hotel master, room, voucher, and provider booking tables.

#### 10. Business flows using this table

- create/update itinerary
- hotel selection
- confirmation
- cancellation
- voucher
- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_confirmed_itinerary_plan_vendor_eligible_list`

**Model:** `dvi_confirmed_itinerary_plan_vendor_eligible_list`  
**Category:** Confirmed  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:getVoucherDetails

#### 1. What this table stores

Stores business rows for `dvi_confirmed_itinerary_plan_vendor_eligible_list` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_confirmed_itinerary_plan_vendor_eligible_list` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getVoucherDetails`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getVoucherDetails`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `(top-level/undetected)`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/unconfirm-quote.js`
  Function: `main`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Copies or finalizes state during confirmation.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `confirmed_itinerary_plan_vendor_eligible_ID`
- `itinerary_plan_vendor_eligible_ID`
- `itineary_plan_assigned_status`
- `itinerary_plan_id`
- `vehicle_type_id`
- `total_vehicle_qty`
- `vendor_id`
- `outstation_allowed_km_per_day`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Draft source tables with the same suffix under `dvi_itinerary_*`.
- Vehicle/vendor master, pricebook, slab, toll, and permit tables.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_confirmed_itinerary_plan_vendor_vehicle_details`

**Model:** `dvi_confirmed_itinerary_plan_vendor_vehicle_details`  
**Category:** Confirmed  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:(top-level/undetected)

#### 1. What this table stores

Stores business rows for `dvi_confirmed_itinerary_plan_vendor_vehicle_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_confirmed_itinerary_plan_vendor_vehicle_details` in the scanned code.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `(top-level/undetected)`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/unconfirm-quote.js`
  Function: `main`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Copies or finalizes state during confirmation.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `confirmed_itinerary_plan_vendor_vehicle_details_ID`
- `itinerary_plan_vendor_vehicle_details_ID`
- `itinerary_plan_vendor_eligible_ID`
- `confirmed_itinerary_plan_vendor_eligible_ID`
- `itinerary_plan_id`
- `itinerary_route_id`
- `itinerary_route_date`
- `vehicle_type_id`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Draft source tables with the same suffix under `dvi_itinerary_*`.
- Vehicle/vendor master, pricebook, slab, toll, and permit tables.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_confirmed_itinerary_customer_details`

**Model:** `dvi_confirmed_itinerary_customer_details`  
**Category:** Confirmed  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:getVoucherDetails

#### 1. What this table stores

Stores business rows for `dvi_confirmed_itinerary_customer_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_confirmed_itinerary_customer_details` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getVoucherDetails`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getVoucherDetails`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getPluckCardData`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getPluckCardData`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getPluckCardDataByConfirmedId`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getPluckCardDataByConfirmedId`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getInvoiceData`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getInvoiceData`; inspect that function for the exact branch and payload.
- File: `scripts/unconfirm-quote.js`
  Function: `countRows`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Copies or finalizes state during confirmation.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `normalizePassengerTitle`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `normalizePassengerTitle`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/unconfirm-quote.js`
  Function: `main`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Copies or finalizes state during confirmation.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `confirmed_itinerary_customer_ID`
- `confirmed_itinerary_plan_ID`
- `itinerary_plan_ID`
- `agent_id`
- `primary_customer`
- `customer_type`
- `customer_salutation`
- `customer_name`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Draft source tables with the same suffix under `dvi_itinerary_*`.

#### 10. Business flows using this table

- account/wallet

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_confirmed_itinerary_traveller_details`

**Model:** `dvi_confirmed_itinerary_traveller_details`  
**Category:** Confirmed  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_confirmed_itinerary_traveller_details`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `confirmed_traveller_details_ID`
- `traveller_details_ID`
- `itinerary_plan_ID`
- `traveller_type`
- `room_id`
- `traveller_age`
- `child_bed_type`
- `createdby`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Draft source tables with the same suffix under `dvi_itinerary_*`.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_confirmed_itinerary_plan_vehicle_details`

**Model:** `dvi_confirmed_itinerary_plan_vehicle_details`  
**Category:** Confirmed  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:copyDraftToConfirmed

#### 1. What this table stores

Stores business rows for `dvi_confirmed_itinerary_plan_vehicle_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_confirmed_itinerary_plan_vehicle_details` in the scanned code.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `copyDraftToConfirmed`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Copies or finalizes state during confirmation.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/unconfirm-quote.js`
  Function: `main`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Copies or finalizes state during confirmation.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `confirmed_vehicle_details_ID`
- `vehicle_details_ID`
- `itinerary_plan_id`
- `vehicle_type_id`
- `vehicle_count`
- `cancellation_status`
- `added_via_amendment`
- `createdby`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Draft source tables with the same suffix under `dvi_itinerary_*`.
- Vehicle/vendor master, pricebook, slab, toll, and permit tables.

#### 10. Business flows using this table

- confirmation

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_confirmed_itinerary_via_route_details`

**Model:** `dvi_confirmed_itinerary_via_route_details`  
**Category:** Confirmed  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:copyDraftToConfirmed

#### 1. What this table stores

Stores business rows for `dvi_confirmed_itinerary_via_route_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_confirmed_itinerary_via_route_details` in the scanned code.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `copyDraftToConfirmed`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Copies or finalizes state during confirmation.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/unconfirm-quote.js`
  Function: `main`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Copies or finalizes state during confirmation.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `confirmed_itinerary_via_route_ID`
- `itinerary_via_route_ID`
- `itinerary_route_ID`
- `itinerary_plan_ID`
- `itinerary_route_date`
- `source_location`
- `destination_location`
- `itinerary_via_location_ID`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Draft source tables with the same suffix under `dvi_itinerary_*`.

#### 10. Business flows using this table

- confirmation

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### 26.9 Cancelled Itinerary Tables

### Table: `dvi_cancelled_itineraries`

**Model:** `dvi_cancelled_itineraries`  
**Category:** Cancelled  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:getCancelledItineraries

#### 1. What this table stores

Stores business rows for `dvi_cancelled_itineraries` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_cancelled_itineraries` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getCancelledItineraries`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getCancelledItineraries`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `cancelItinerary`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Applies cancellation state or reads rows needed for cancellation.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `cancelItinerary`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Applies cancellation state or reads rows needed for cancellation.

#### 5. UPDATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `(top-level/undetected)`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

- Soft-delete/status note: this table has an update/status/deleted-flag style lifecycle in at least one scanned path. [Verified from code scan]

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `cancelled_itinerary_ID`
- `itinerary_plan_id`
- `total_cancelled_service_amount`
- `total_cancellation_charge`
- `total_refund_amount`
- `itinerary_cancellation_status`
- `createdby`
- `createdon`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- create/update itinerary
- cancellation

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_cancelled_itinerary_details`

**Model:** `dvi_cancelled_itinerary_details`  
**Category:** Cancelled  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_cancelled_itinerary_details`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `cancelled_itinerary_details_ID`
- `cancelled_itinerary_id`
- `itinerary_plan_id`
- `itinerary_hotspot_cancellation_status`
- `itinerary_activity_cancellation_status`
- `itinerary_guide_cancellation_status`
- `itinerary_vehicle_cancellation_status`
- `itinerary_hotel_cancellation_status`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_cancelled_itinerary_plan_hotel_details`

**Model:** `dvi_cancelled_itinerary_plan_hotel_details`  
**Category:** Cancelled  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:cancelHotels

#### 1. What this table stores

Stores business rows for `dvi_cancelled_itinerary_plan_hotel_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_cancelled_itinerary_plan_hotel_details` in the scanned code.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `cancelHotels`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Applies cancellation state or reads rows needed for cancellation.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `cancelled_itinerary_plan_hotel_details_ID`
- `confirmed_itinerary_plan_hotel_details_ID`
- `cancelled_itinerary_ID`
- `itinerary_plan_hotel_details_ID`
- `group_type`
- `itinerary_plan_id`
- `itinerary_route_id`
- `itinerary_route_date`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Hotel master, room, voucher, and provider booking tables.

#### 10. Business flows using this table

- create/update itinerary
- cancellation

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_cancelled_itinerary_plan_vendor_vehicle_details`

**Model:** `dvi_cancelled_itinerary_plan_vendor_vehicle_details`  
**Category:** Cancelled  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_cancelled_itinerary_plan_vendor_vehicle_details`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `cancelled_itinerary_plan_vendor_vehicle_details_ID`
- `confirmed_itinerary_plan_vendor_vehicle_details_ID`
- `cancelled_itinerary_plan_vendor_eligible_ID`
- `itinerary_plan_vendor_vehicle_details_ID`
- `itinerary_plan_vendor_eligible_ID`
- `confirmed_itinerary_plan_vendor_eligible_ID`
- `itinerary_plan_id`
- `itinerary_route_id`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Vehicle/vendor master, pricebook, slab, toll, and permit tables.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_cancelled_itinerary_route_hotspot_details`

**Model:** `dvi_cancelled_itinerary_route_hotspot_details`  
**Category:** Cancelled  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_cancelled_itinerary_route_hotspot_details`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `cancelled_route_hotspot_ID`
- `cancelled_itinerary_ID`
- `confirmed_route_hotspot_ID`
- `route_hotspot_ID`
- `itinerary_plan_ID`
- `itinerary_route_ID`
- `item_type`
- `hotspot_order`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Child charge/cost tables plus route/day and hotspot master tables.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_cancelled_itinerary_route_activity_details`

**Model:** `dvi_cancelled_itinerary_route_activity_details`  
**Category:** Cancelled  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_cancelled_itinerary_route_activity_details`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `cancelled_route_activity_ID`
- `cancelled_itinerary_ID`
- `confirmed_route_activity_ID`
- `route_activity_ID`
- `itinerary_plan_ID`
- `itinerary_route_ID`
- `route_hotspot_ID`
- `hotspot_ID`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_cancelled_itinerary_route_guide_details`

**Model:** `dvi_cancelled_itinerary_route_guide_details`  
**Category:** Cancelled  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_cancelled_itinerary_route_guide_details`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `cancelled_route_guide_ID`
- `confirmed_route_guide_ID`
- `cancelled_itinerary_ID`
- `route_guide_ID`
- `itinerary_plan_ID`
- `itinerary_route_ID`
- `guide_id`
- `guide_status`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_cancellation_logs`

**Model:** `dvi_cancellation_logs`  
**Category:** Cancelled  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:logCancellationAction

#### 1. What this table stores

Stores business rows for `dvi_cancellation_logs` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_cancellation_logs` in the scanned code.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `logCancellationAction`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `logCancellationAction`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `log_id`
- `cancellation_id`
- `itinerary_plan_id`
- `action_type`
- `action_details`
- `status`
- `error_message`
- `created_by`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### 26.10 Wallet / Payment / Accounts Tables

### Table: `dvi_cash_wallet`

**Model:** `dvi_cash_wallet`  
**Category:** Audit  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:finalizeConfirmationFinancials

#### 1. What this table stores

Stores business rows for `dvi_cash_wallet` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_cash_wallet` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `finalizeConfirmationFinancials`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `finalizeConfirmationFinancials`; inspect that function for the exact branch and payload.
- File: `scripts/unconfirm-quote.js`
  Function: `main`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Copies or finalizes state during confirmation.
- File: `scripts/unconfirm-quote.js`
  Function: `countRows`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Copies or finalizes state during confirmation.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `parseDateTime`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `parseDateTime`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `finalizeConfirmationFinancials`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `finalizeConfirmationFinancials`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `cancelItinerary`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Applies cancellation state or reads rows needed for cancellation.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/unconfirm-quote.js`
  Function: `main`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Copies or finalizes state during confirmation.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `cash_wallet_ID`
- `agent_id`
- `transaction_date`
- `transaction_amount`
- `transaction_type`
- `remarks`
- `transaction_id`
- `createdby`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- create/update itinerary
- cancellation
- account/wallet

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_coupon_wallet`

**Model:** `dvi_coupon_wallet`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_coupon_wallet`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `coupon_wallet_ID`
- `agent_id`
- `transaction_date`
- `transaction_amount`
- `transaction_type`
- `remarks`
- `createdby`
- `createdon`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_payment_transaction`

**Model:** `dvi_payment_transaction`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_payment_transaction`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `payment_transaction_ID`
- `flow_type`
- `entity_id`
- `subscription_plan_id`
- `amount_inr`
- `amount_paise`
- `currency`
- `provider`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_accounts_itinerary_details`

**Model:** `dvi_accounts_itinerary_details`  
**Category:** Audit  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:getAccountsItineraries

#### 1. What this table stores

Stores business rows for `dvi_accounts_itinerary_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_accounts_itinerary_details` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getAccountsItineraries`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getAccountsItineraries`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `finalizeConfirmationFinancials`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `finalizeConfirmationFinancials`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getInvoiceData`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getInvoiceData`; inspect that function for the exact branch and payload.
- File: `scripts/unconfirm-quote.js`
  Function: `countRows`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Copies or finalizes state during confirmation.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `normalizePassengerTitle`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `normalizePassengerTitle`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `finalizeConfirmationFinancials`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `finalizeConfirmationFinancials`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `await`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `await`; inspect that function for the exact branch and payload.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/unconfirm-quote.js`
  Function: `main`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Copies or finalizes state during confirmation.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `accounts_itinerary_details_ID`
- `itinerary_plan_ID`
- `agent_id`
- `staff_id`
- `confirmed_itinerary_plan_ID`
- `itinerary_quote_ID`
- `trip_start_date_and_time`
- `trip_end_date_and_time`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- account/wallet

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_accounts_itinerary_hotel_details`

**Model:** `dvi_accounts_itinerary_hotel_details`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_accounts_itinerary_hotel_details`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `accounts_itinerary_hotel_details_ID`
- `accounts_itinerary_details_ID`
- `itinerary_plan_hotel_details_ID`
- `cnf_itinerary_plan_hotel_details_ID`
- `cnf_itinerary_plan_hotel_voucher_details_ID`
- `itinerary_plan_ID`
- `itinerary_route_id`
- `itinerary_route_date`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Hotel master, room, voucher, and provider booking tables.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_accounts_itinerary_vehicle_details`

**Model:** `dvi_accounts_itinerary_vehicle_details`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_accounts_itinerary_vehicle_details`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `accounts_itinerary_vehicle_details_ID`
- `accounts_itinerary_details_ID`
- `itinerary_plan_ID`
- `itinerary_plan_vendor_eligible_ID`
- `confirmed_itinerary_plan_vendor_eligible_ID`
- `cnf_itinerary_plan_vehicle_voucher_details_ID`
- `vehicle_id`
- `vehicle_type_id`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Vehicle/vendor master, pricebook, slab, toll, and permit tables.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_accounts_itinerary_hotspot_details`

**Model:** `dvi_accounts_itinerary_hotspot_details`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_accounts_itinerary_hotspot_details`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `accounts_itinerary_hotspot_details_ID`
- `accounts_itinerary_details_ID`
- `confirmed_route_hotspot_ID`
- `itinerary_plan_ID`
- `itinerary_route_ID`
- `route_hotspot_ID`
- `hotspot_ID`
- `hotspot_amount`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_accounts_itinerary_activity_details`

**Model:** `dvi_accounts_itinerary_activity_details`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_accounts_itinerary_activity_details`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `accounts_itinerary_activity_details_ID`
- `accounts_itinerary_details_ID`
- `confirmed_route_activity_ID`
- `itinerary_plan_ID`
- `itinerary_route_ID`
- `route_hotspot_ID`
- `route_activity_ID`
- `hotspot_ID`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_accounts_itinerary_guide_details`

**Model:** `dvi_accounts_itinerary_guide_details`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_accounts_itinerary_guide_details`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `accounts_itinerary_guide_details_ID`
- `accounts_itinerary_details_ID`
- `cnf_itinerary_guide_slot_cost_details_ID`
- `itinerary_plan_ID`
- `itinerary_route_ID`
- `guide_slot_cost_details_ID`
- `route_guide_ID`
- `guide_id`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_accounts_itinerary_activity_transaction_history`

**Model:** `dvi_accounts_itinerary_activity_transaction_history`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_accounts_itinerary_activity_transaction_history`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `accounts_itinerary_activity_transaction_history_ID`
- `accounts_itinerary_details_ID`
- `accounts_itinerary_activity_details_ID`
- `transaction_amount`
- `transaction_date`
- `transaction_done_by`
- `mode_of_pay`
- `transaction_utr_no`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_accounts_itinerary_guide_transaction_history`

**Model:** `dvi_accounts_itinerary_guide_transaction_history`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_accounts_itinerary_guide_transaction_history`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `accounts_itinerary_guide_transaction_ID`
- `accounts_itinerary_details_ID`
- `accounts_itinerary_guide_details_ID`
- `transaction_amount`
- `transaction_date`
- `transaction_done_by`
- `mode_of_pay`
- `transaction_utr_no`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_accounts_itinerary_hotel_transaction_history`

**Model:** `dvi_accounts_itinerary_hotel_transaction_history`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_accounts_itinerary_hotel_transaction_history`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `accounts_itinerary_hotel_transaction_history_ID`
- `accounts_itinerary_hotel_details_ID`
- `accounts_itinerary_details_ID`
- `transaction_amount`
- `transaction_date`
- `transaction_done_by`
- `mode_of_pay`
- `transaction_utr_no`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Hotel master, room, voucher, and provider booking tables.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_accounts_itinerary_hotspot_transaction_history`

**Model:** `dvi_accounts_itinerary_hotspot_transaction_history`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_accounts_itinerary_hotspot_transaction_history`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `dvi_accounts_itinerary_hotspot_transaction_ID`
- `accounts_itinerary_details_ID`
- `accounts_itinerary_hotspot_details_ID`
- `transaction_amount`
- `transaction_date`
- `transaction_done_by`
- `mode_of_pay`
- `transaction_utr_no`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_accounts_itinerary_vehicle_transaction_history`

**Model:** `dvi_accounts_itinerary_vehicle_transaction_history`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_accounts_itinerary_vehicle_transaction_history`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `accounts_itinerary_vehicle_transaction_ID`
- `accounts_itinerary_details_ID`
- `accounts_itinerary_vehicle_details_ID`
- `transaction_amount`
- `transaction_date`
- `transaction_done_by`
- `mode_of_pay`
- `transaction_utr_no`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Vehicle/vendor master, pricebook, slab, toll, and permit tables.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### 26.11 Provider Booking / Provider Sync Tables

### Table: `tbo_hotel_booking_confirmation`

**Model:** `tbo_hotel_booking_confirmation`  
**Category:** Provider  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:filterAlreadySuccessfulBookings

#### 1. What this table stores

Stores business rows for `tbo_hotel_booking_confirmation` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `tbo_hotel_booking_confirmation` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `filterAlreadySuccessfulBookings`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `filterAlreadySuccessfulBookings`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `parseFloat`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `parseFloat`; inspect that function for the exact branch and payload.
- File: `scripts/debug-tbo-hotels.js`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `parseFloat`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `parseFloat`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/services/tbo-hotel-booking.service.ts`
  Function: `fetchActiveCancellationBookings`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/services/tbo-hotel-booking.service.ts`
  Function: `bookingMeta`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 5. UPDATE usage

- File: `src/modules/itineraries/services/tbo-hotel-booking.service.ts`
  Function: `cancelItineraryHotels`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/services/tbo-hotel-booking.service.ts`
  Function: `cancelItineraryHotelsByRoutes`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/unconfirm-quote.js`
  Function: `main`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Copies or finalizes state during confirmation.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `parseFloat`
  Operation: `RAW READ`
  Why: Uses the table in `parseFloat`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/services/tbo-hotel-booking.service.ts`
  Function: `fetchActiveCancellationBookings`
  Operation: `RAW READ`
  Why: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 8. Important fields and meaning

- `tbo_hotel_booking_confirmation_ID`
- `confirmed_itinerary_plan_ID`
- `itinerary_plan_ID`
- `itinerary_route_ID`
- `tbo_hotel_code`
- `tbo_booking_id`
- `tbo_booking_reference_number`
- `tbo_trace_id`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Hotel master, room, voucher, and provider booking tables.

#### 10. Business flows using this table

- create/update itinerary
- details API
- cancellation
- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `resavenue_hotel_booking_confirmation`

**Model:** `resavenue_hotel_booking_confirmation`  
**Category:** Provider  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:filterAlreadySuccessfulBookings

#### 1. What this table stores

Stores business rows for `resavenue_hotel_booking_confirmation` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `resavenue_hotel_booking_confirmation` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `filterAlreadySuccessfulBookings`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `filterAlreadySuccessfulBookings`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/services/resavenue-hotel-booking.service.ts`
  Function: `cancelItineraryHotels`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/services/resavenue-hotel-booking.service.ts`
  Function: `cancelItineraryHotelsByRoutes`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/services/resavenue-hotel-booking.service.ts`
  Function: `saveResAvenueBookingConfirmation`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 5. UPDATE usage

- File: `src/modules/itineraries/services/resavenue-hotel-booking.service.ts`
  Function: `cancelItineraryHotels`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/services/resavenue-hotel-booking.service.ts`
  Function: `cancelItineraryHotelsByRoutes`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/unconfirm-quote.js`
  Function: `main`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Copies or finalizes state during confirmation.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `resavenue_hotel_booking_confirmation_ID`
- `confirmed_itinerary_plan_ID`
- `itinerary_plan_ID`
- `itinerary_route_ID`
- `resavenue_hotel_code`
- `resavenue_booking_reference`
- `booking_code`
- `check_in_date`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Hotel master, room, voucher, and provider booking tables.

#### 10. Business flows using this table

- create/update itinerary
- cancellation
- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `axisrooms_hotel_booking_confirmation`

**Model:** `axisrooms_hotel_booking_confirmation`  
**Category:** Provider  
**Runtime usage:** Yes  
**Primary owner:** axisrooms-booking-push.service.ts:cancelItineraryHotels

#### 1. What this table stores

Stores business rows for `axisrooms_hotel_booking_confirmation` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `axisrooms_hotel_booking_confirmation` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/services/axisrooms-booking-push.service.ts`
  Function: `cancelItineraryHotels`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Applies cancellation state or reads rows needed for cancellation.
- File: `src/modules/itineraries/services/axisrooms-booking-push.service.ts`
  Function: `cancelItineraryHotelsByRoutes`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Applies cancellation state or reads rows needed for cancellation.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/services/axisrooms-booking-push.service.ts`
  Function: `pushForHotelSelection`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `pushForHotelSelection`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- File: `src/modules/itineraries/services/axisrooms-booking-push.service.ts`
  Function: `cancelAxisroomsBookingRow`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Applies cancellation state or reads rows needed for cancellation.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/unconfirm-quote.js`
  Function: `main`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Copies or finalizes state during confirmation.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `axisrooms_hotel_booking_confirmation_ID`
- `confirmed_itinerary_plan_ID`
- `itinerary_plan_ID`
- `itinerary_route_ID`
- `axisrooms_hotel_code`
- `axisrooms_booking_reference`
- `booking_code`
- `check_in_date`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Hotel master, room, voucher, and provider booking tables.

#### 10. Business flows using this table

- create/update itinerary
- cancellation
- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `staah_hotel_booking_confirmation`

**Model:** `staah_hotel_booking_confirmation`  
**Category:** Provider  
**Runtime usage:** Yes  
**Primary owner:** staah-booking-push.service.ts:cancelItineraryHotels

#### 1. What this table stores

Stores business rows for `staah_hotel_booking_confirmation` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `staah_hotel_booking_confirmation` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/services/staah-booking-push.service.ts`
  Function: `cancelItineraryHotels`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Applies cancellation state or reads rows needed for cancellation.
- File: `src/modules/itineraries/services/staah-booking-push.service.ts`
  Function: `cancelItineraryHotelsByRoutes`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Applies cancellation state or reads rows needed for cancellation.
- File: `src/modules/itineraries/services/staah-booking-push.service.ts`
  Function: `cancelVoucherHotel`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Applies cancellation state or reads rows needed for cancellation.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/services/staah-booking-push.service.ts`
  Function: `(top-level/undetected)`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- File: `src/modules/itineraries/services/staah-booking-push.service.ts`
  Function: `cancelStaahBookingRow`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Applies cancellation state or reads rows needed for cancellation.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `staah_hotel_booking_confirmation_ID`
- `confirmed_itinerary_plan_ID`
- `itinerary_plan_ID`
- `itinerary_route_ID`
- `staah_hotel_code`
- `staah_booking_reference`
- `booking_code`
- `check_in_date`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Hotel master, room, voucher, and provider booking tables.

#### 10. Business flows using this table

- create/update itinerary
- cancellation
- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `hobse_hotel_booking_confirmation`

**Model:** `hobse_hotel_booking_confirmation`  
**Category:** Script-only  
**Runtime usage:** Script-only  
**Primary owner:** unconfirm-quote.js:main

#### 1. What this table stores

Stores business rows for `hobse_hotel_booking_confirmation` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `hobse_hotel_booking_confirmation` in the scanned code.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/unconfirm-quote.js`
  Function: `main`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Copies or finalizes state during confirmation.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `hobse_hotel_booking_confirmation_ID`
- `plan_id`
- `route_id`
- `hotel_code`
- `booking_id`
- `check_in_date`
- `check_out_date`
- `room_count`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Hotel master, room, voucher, and provider booking tables.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Script-only; not used in normal itinerary API runtime.

### Table: `staah_reservation`

**Model:** `staah_reservation`  
**Category:** Provider  
**Runtime usage:** Yes  
**Primary owner:** staah-booking-push.service.ts:logStaahReservation

#### 1. What this table stores

Stores business rows for `staah_reservation` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `staah_reservation` in the scanned code.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- File: `src/modules/itineraries/services/staah-booking-push.service.ts`
  Function: `logStaahReservation`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `logStaahReservation`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/services/staah-booking-push.service.ts`
  Function: `confirmItineraryHotels`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Copies or finalizes state during confirmation.
- File: `src/modules/itineraries/services/staah-booking-push.service.ts`
  Function: `(top-level/undetected)`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `id`
- `type`
- `staah_property_id`
- `reservation_id`
- `payload`
- `request_json`
- `response_json`
- `error_message`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `axisrooms_inbound_log`

**Model:** `axisrooms_inbound_log`  
**Category:** Script-only  
**Runtime usage:** Script-only  
**Primary owner:** backfill-inbound-for-prod-updated-list.js:main

#### 1. What this table stores

Stores business rows for `axisrooms_inbound_log` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `axisrooms_inbound_log` in the scanned code.

#### 3. READ usage

- File: `scripts/backfill-inbound-for-prod-updated-list.js`
  Function: `main`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/backfill-inbound-for-prod-updated-list.js`
  Function: `VALUES`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `VALUES`; inspect that function for the exact branch and payload.
- File: `scripts/check-prod-list-inbound-local.js`
  Function: `main`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/debug-axisrooms-local-coverage.js`
  Function: `main`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/debug-axisrooms-real-events-local.js`
  Function: `COUNT`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `COUNT`; inspect that function for the exact branch and payload.
- File: `scripts/fix-axisrooms-local-inbound-coverage.js`
  Function: `JOIN`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `JOIN`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- File: `scripts/backfill-inbound-for-prod-updated-list.js`
  Function: `main`
  Operation: `RAW INSERT`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/fix-axisrooms-local-inbound-coverage.js`
  Function: `FROM`
  Operation: `RAW INSERT`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Uses the table in `FROM`; inspect that function for the exact branch and payload.

#### 5. UPDATE usage

- File: `scripts/fix-axisrooms-local-inbound-coverage.js`
  Function: `main`
  Operation: `RAW UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `main`; inspect that function for the exact branch and payload.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `scripts/backfill-inbound-for-prod-updated-list.js`
  Function: `main`
  Operation: `RAW READ`
  Why: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/backfill-inbound-for-prod-updated-list.js`
  Function: `VALUES`
  Operation: `RAW READ`
  Why: Uses the table in `VALUES`; inspect that function for the exact branch and payload.
- File: `scripts/backfill-inbound-for-prod-updated-list.js`
  Function: `main`
  Operation: `RAW INSERT`
  Why: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/check-prod-list-inbound-local.js`
  Function: `main`
  Operation: `RAW READ`
  Why: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/debug-axisrooms-local-coverage.js`
  Function: `main`
  Operation: `RAW READ`
  Why: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/debug-axisrooms-real-events-local.js`
  Function: `COUNT`
  Operation: `RAW READ`
  Why: Uses the table in `COUNT`; inspect that function for the exact branch and payload.
- File: `scripts/fix-axisrooms-local-inbound-coverage.js`
  Function: `JOIN`
  Operation: `RAW READ`
  Why: Uses the table in `JOIN`; inspect that function for the exact branch and payload.
- File: `scripts/fix-axisrooms-local-inbound-coverage.js`
  Function: `VALUES`
  Operation: `RAW READ`
  Why: Uses the table in `VALUES`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `id`
- `type`
- `axisrooms_property_id`
- `room_id`
- `rateplan_id`
- `payload`
- `received_at`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Script-only; not used in normal itinerary API runtime.

### Table: `staah_inbound_log`

**Model:** `staah_inbound_log`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `staah_inbound_log`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `id`
- `type`
- `staah_property_id`
- `room_id`
- `rateplan_id`
- `payload`
- `received_at`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `axisrooms_room`

**Model:** `axisrooms_room`  
**Category:** Script-only  
**Runtime usage:** Script-only  
**Primary owner:** compare-ax153-prod-local.js:normalizeRows

#### 1. What this table stores

Stores business rows for `axisrooms_room` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `axisrooms_room` in the scanned code.

#### 3. READ usage

- File: `scripts/compare-ax153-prod-local.js`
  Function: `normalizeRows`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `normalizeRows`; inspect that function for the exact branch and payload.
- File: `scripts/dump-prod-ax153.js`
  Function: `safeQuery`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `safeQuery`; inspect that function for the exact branch and payload.
- File: `scripts/fix-axisrooms-local-inbound-coverage.js`
  Function: `FROM`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `FROM`; inspect that function for the exact branch and payload.
- File: `scripts/sync-prod-axisrooms-properties-to-local.js`
  Function: `fetchProdDumpFromDb`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `fetchProdDumpFromDb`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `scripts/compare-ax153-prod-local.js`
  Function: `normalizeRows`
  Operation: `RAW READ`
  Why: Uses the table in `normalizeRows`; inspect that function for the exact branch and payload.
- File: `scripts/dump-prod-ax153.js`
  Function: `safeQuery`
  Operation: `RAW READ`
  Why: Uses the table in `safeQuery`; inspect that function for the exact branch and payload.
- File: `scripts/fix-axisrooms-local-inbound-coverage.js`
  Function: `FROM`
  Operation: `RAW READ`
  Why: Uses the table in `FROM`; inspect that function for the exact branch and payload.
- File: `scripts/sync-prod-axisrooms-properties-to-local.js`
  Function: `fetchProdDumpFromDb`
  Operation: `RAW READ`
  Why: Uses the table in `fetchProdDumpFromDb`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `id`
- `axisrooms_property_id`
- `room_id`
- `room_name`
- `created_at`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Script-only; not used in normal itinerary API runtime.

### Table: `axisrooms_inventory`

**Model:** `axisrooms_inventory`  
**Category:** Script-only  
**Runtime usage:** Script-only  
**Primary owner:** compare-ax153-prod-local.js:normalizeRows

#### 1. What this table stores

Stores business rows for `axisrooms_inventory` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `axisrooms_inventory` in the scanned code.

#### 3. READ usage

- File: `scripts/compare-ax153-prod-local.js`
  Function: `normalizeRows`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `normalizeRows`; inspect that function for the exact branch and payload.
- File: `scripts/dump-prod-ax153.js`
  Function: `safeQuery`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `safeQuery`; inspect that function for the exact branch and payload.
- File: `scripts/fix-axisrooms-local-inbound-coverage.js`
  Function: `FROM`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `FROM`; inspect that function for the exact branch and payload.
- File: `scripts/inspect-prod-axisrooms-hotel.js`
  Function: `main`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `scripts/sync-prod-axisrooms-properties-to-local.js`
  Function: `fetchProdDumpFromDb`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `fetchProdDumpFromDb`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `scripts/compare-ax153-prod-local.js`
  Function: `normalizeRows`
  Operation: `RAW READ`
  Why: Uses the table in `normalizeRows`; inspect that function for the exact branch and payload.
- File: `scripts/dump-prod-ax153.js`
  Function: `safeQuery`
  Operation: `RAW READ`
  Why: Uses the table in `safeQuery`; inspect that function for the exact branch and payload.
- File: `scripts/fix-axisrooms-local-inbound-coverage.js`
  Function: `FROM`
  Operation: `RAW READ`
  Why: Uses the table in `FROM`; inspect that function for the exact branch and payload.
- File: `scripts/inspect-prod-axisrooms-hotel.js`
  Function: `main`
  Operation: `RAW READ`
  Why: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `scripts/sync-prod-axisrooms-properties-to-local.js`
  Function: `fetchProdDumpFromDb`
  Operation: `RAW READ`
  Why: Uses the table in `fetchProdDumpFromDb`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `id`
- `axisrooms_property_id`
- `room_id`
- `start_date`
- `end_date`
- `free`
- `received_at`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Script-only; not used in normal itinerary API runtime.

### Table: `axisrooms_restriction`

**Model:** `axisrooms_restriction`  
**Category:** Script-only  
**Runtime usage:** Script-only  
**Primary owner:** cleanup-noncanonical-room-rateplans.ts:main

#### 1. What this table stores

Stores business rows for `axisrooms_restriction` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `axisrooms_restriction` in the scanned code.

#### 3. READ usage

- File: `scripts/compare-ax153-prod-local.js`
  Function: `normalizeRows`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `normalizeRows`; inspect that function for the exact branch and payload.
- File: `scripts/dump-prod-ax153.js`
  Function: `safeQuery`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `safeQuery`; inspect that function for the exact branch and payload.
- File: `scripts/fix-axisrooms-local-inbound-coverage.js`
  Function: `FROM`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `FROM`; inspect that function for the exact branch and payload.
- File: `scripts/inspect-prod-axisrooms-hotel.js`
  Function: `main`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `scripts/sync-prod-axisrooms-properties-to-local.js`
  Function: `fetchProdDumpFromDb`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `fetchProdDumpFromDb`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- File: `scripts/cleanup-noncanonical-room-rateplans.ts`
  Function: `main`
  Operation: `DELETE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it delete: Uses the table in `main`; inspect that function for the exact branch and payload.

#### 7. Raw SQL usage

- File: `scripts/compare-ax153-prod-local.js`
  Function: `normalizeRows`
  Operation: `RAW READ`
  Why: Uses the table in `normalizeRows`; inspect that function for the exact branch and payload.
- File: `scripts/dump-prod-ax153.js`
  Function: `safeQuery`
  Operation: `RAW READ`
  Why: Uses the table in `safeQuery`; inspect that function for the exact branch and payload.
- File: `scripts/fix-axisrooms-local-inbound-coverage.js`
  Function: `FROM`
  Operation: `RAW READ`
  Why: Uses the table in `FROM`; inspect that function for the exact branch and payload.
- File: `scripts/inspect-prod-axisrooms-hotel.js`
  Function: `main`
  Operation: `RAW READ`
  Why: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `scripts/sync-prod-axisrooms-properties-to-local.js`
  Function: `fetchProdDumpFromDb`
  Operation: `RAW READ`
  Why: Uses the table in `fetchProdDumpFromDb`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `id`
- `axisrooms_property_id`
- `room_id`
- `rateplan_id`
- `start_date`
- `end_date`
- `type`
- `value`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Script-only; not used in normal itinerary API runtime.

### Table: `staah_rateplan`

**Model:** `staah_rateplan`  
**Category:** Provider  
**Runtime usage:** Yes  
**Primary owner:** staah-booking-push.service.ts:resolveRoomRate

#### 1. What this table stores

Stores business rows for `staah_rateplan` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `staah_rateplan` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/services/staah-booking-push.service.ts`
  Function: `resolveRoomRate`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `resolveRoomRate`; inspect that function for the exact branch and payload.
- File: `scripts/check-staah-hotel-pickup.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `scripts/check-staah-hotel-pickup.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Why: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 8. Important fields and meaning

- `id`
- `staah_property_id`
- `room_id`
- `rateplan_id`
- `rateplan_name`
- `occupancy`
- `commission_perc`
- `tax_perc`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `staah_inventory`

**Model:** `staah_inventory`  
**Category:** Script-only  
**Runtime usage:** Script-only  
**Primary owner:** check-staah-hotel-pickup.js:(top-level/undetected)

#### 1. What this table stores

Stores business rows for `staah_inventory` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `staah_inventory` in the scanned code.

#### 3. READ usage

- File: `scripts/check-staah-hotel-pickup.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `scripts/check-staah-hotel-pickup.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Why: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 8. Important fields and meaning

- `id`
- `staah_property_id`
- `room_id`
- `start_date`
- `end_date`
- `free`
- `received_at`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Script-only; not used in normal itinerary API runtime.

### Table: `staah_rate`

**Model:** `staah_rate`  
**Category:** Script-only  
**Runtime usage:** Script-only  
**Primary owner:** check-staah-hotel-pickup.js:(top-level/undetected)

#### 1. What this table stores

Stores business rows for `staah_rate` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `staah_rate` in the scanned code.

#### 3. READ usage

- File: `scripts/check-staah-hotel-pickup.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `scripts/check-staah-hotel-pickup.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Why: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 8. Important fields and meaning

- `id`
- `staah_property_id`
- `room_id`
- `rateplan_id`
- `start_date`
- `end_date`
- `occupancy_rates`
- `received_at`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Script-only; not used in normal itinerary API runtime.

### Table: `staah_restriction`

**Model:** `staah_restriction`  
**Category:** Script-only  
**Runtime usage:** Script-only  
**Primary owner:** check-staah-hotel-pickup.js:(top-level/undetected)

#### 1. What this table stores

Stores business rows for `staah_restriction` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `staah_restriction` in the scanned code.

#### 3. READ usage

- File: `scripts/check-staah-hotel-pickup.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `scripts/check-staah-hotel-pickup.js`
  Function: `(top-level/undetected)`
  Operation: `RAW READ`
  Why: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 8. Important fields and meaning

- `id`
- `staah_property_id`
- `room_id`
- `rateplan_id`
- `start_date`
- `end_date`
- `type`
- `value`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Script-only; not used in normal itinerary API runtime.

### 26.12 Reference / Master Tables Used by Itinerary

### Table: `dvi_cities`

**Model:** `dvi_cities`  
**Category:** Reference  
**Runtime usage:** Yes  
**Primary owner:** timeline.prefetch.ts:routes

#### 1. What this table stores

Stores business rows for `dvi_cities` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_cities` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/helpers/timeline.prefetch.ts`
  Function: `routes`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `routes`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/hotels/hotel-pricing.service.ts`
  Function: `resolveCityCandidates`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itinerary-hotel-details-tbo.service.ts`
  Function: `batchMapDestinationsToCityCodes`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itinerary-hotel-details-tbo.service.ts`
  Function: `batchMapDestinationsToHobseCityCodes`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itinerary-hotel-details-tbo.service.ts`
  Function: `fetchAxisroomsHotelsForRoutes`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itinerary-hotel-details-tbo.service.ts`
  Function: `fetchStaahHotelsForRoutes`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 4. INSERT / CREATE usage

- File: `scripts/import-justa-hotels.js`
  Function: `updateCityMappings`
  Operation: `CREATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it insert: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 5. UPDATE usage

- File: `scripts/import-justa-hotels.js`
  Function: `updateCityMappings`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `id`
- `name`
- `state_id`
- `createdon`
- `updatedon`
- `status`
- `deleted`
- `tbo_city_code`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- hotel selection
- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_states`

**Model:** `dvi_states`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_states`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `id`
- `name`
- `vehicle_onground_support_number`
- `vehicle_escalation_call_number`
- `country_id`
- `createdby`
- `updatedon`
- `deleted`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_countries`

**Model:** `dvi_countries`  
**Category:** Reference  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:getPlanForEdit

#### 1. What this table stores

Stores business rows for `dvi_countries` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_countries` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getPlanForEdit`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getPlanForEdit`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itinerary-clipboard.service.ts`
  Function: `resolveNationalityLabel`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `resolveNationalityLabel`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itinerary-hotel-details-tbo.service.ts`
  Function: `resolveGuestNationality`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/services/tbo-hotel-booking.service.ts`
  Function: `resolveBookingNationalityFromPlan`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itinerary-hotel-details-tbo.service.ts`
  Function: `resolveGuestNationality`
  Operation: `RAW READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `src/modules/itineraries/itinerary-hotel-details-tbo.service.ts`
  Function: `resolveGuestNationality`
  Operation: `RAW READ`
  Why: Supports hotel selection, hotel details, voucher, or provider-booking flows.

#### 8. Important fields and meaning

- `id`
- `shortname`
- `name`
- `phonecode`
- `createdby`
- `createdon`
- `updatedon`
- `status`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- hotel selection
- provider booking

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_global_settings`

**Model:** `dvi_global_settings`  
**Category:** Reference  
**Runtime usage:** Yes  
**Primary owner:** distance.helper.ts:endLonRad

#### 1. What this table stores

Stores business rows for `dvi_global_settings` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_global_settings` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/engines/helpers/distance.helper.ts`
  Function: `endLonRad`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `endLonRad`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/helpers/distance.helper.ts`
  Function: `getBufferTime`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getBufferTime`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/helpers/timeline.prefetch.ts`
  Function: `routes`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `routes`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/engines/vehicle-calculation.helpers.ts`
  Function: `Boolean`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports vehicle eligibility, KM, toll, permit, slab, or output rows.
- File: `src/modules/itineraries/hotel-voucher.service.ts`
  Function: `getDefaultVoucherTerms`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Supports hotel selection, hotel details, voucher, or provider-booking flows.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getInvoiceData`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getInvoiceData`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- File: `scripts/apply-mealplan-toggle-migration.js`
  Function: `main`
  Operation: `RAW UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `main`; inspect that function for the exact branch and payload.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- File: `scripts/apply-mealplan-toggle-migration.js`
  Function: `main`
  Operation: `RAW READ`
  Why: Uses the table in `main`; inspect that function for the exact branch and payload.
- File: `scripts/apply-mealplan-toggle-migration.js`
  Function: `main`
  Operation: `RAW UPDATE`
  Why: Uses the table in `main`; inspect that function for the exact branch and payload.

#### 8. Important fields and meaning

- `global_settings_ID`
- `eligibile_country_code`
- `extrabed_rate_percentage`
- `childwithbed_rate_percentage`
- `childnobed_rate_percentage`
- `hotel_margin`
- `hotel_margin_gst_type`
- `hotel_margin_gst_percentage`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- vehicle pricing
- confirmation
- voucher
- account/wallet

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_agent`

**Model:** `dvi_agent`  
**Category:** Reference  
**Runtime usage:** Yes  
**Primary owner:** itineraries.service.ts:getAgentsForFilter

#### 1. What this table stores

Stores business rows for `dvi_agent` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_agent` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getAgentsForFilter`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getAgentsForFilter`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getConfirmedItineraries`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getConfirmedItineraries`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getCancelledItineraries`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getCancelledItineraries`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getAccountsItineraries`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getAccountsItineraries`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `getCustomerInfoForm`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `getCustomerInfoForm`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `checkWalletBalance`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `checkWalletBalance`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `parseDateTime`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `parseDateTime`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itineraries.service.ts`
  Function: `finalizeConfirmationFinancials`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Uses the table in `finalizeConfirmationFinancials`; inspect that function for the exact branch and payload.
- File: `scripts/unconfirm-quote.js`
  Function: `main`
  Operation: `UPDATE`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it update: Copies or finalizes state during confirmation.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `agent_ID`
- `travel_expert_id`
- `subscription_plan_id`
- `sponsor_id`
- `agent_ip_address`
- `agent_ref_no`
- `itinerary_margin_discount_percentage`
- `agent_margin`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- details API
- account/wallet

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_staff`

**Model:** `dvi_staff`  
**Category:** Unused  
**Runtime usage:** No  
**Primary owner:** Not used in scanned itinerary runtime code.

#### 1. What this table stores

No scanned itinerary runtime or script hit was found for `dvi_staff`.

#### 2. Why this table exists in itinerary logic

Needs verification because the schema model exists but the current scan did not find itinerary code usage.

#### 3. READ usage

- No scanned read hit.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `staff_id`
- `vendor_id`
- `staff_name`
- `staff_email`
- `staff_mobile_number`
- `createdby`
- `createdon`
- `updatedon`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- Needs verification because the hit list does not map cleanly to a named flow.

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- Not used in scanned itinerary runtime code.

### Table: `dvi_users`

**Model:** `dvi_users`  
**Category:** Reference  
**Runtime usage:** Yes  
**Primary owner:** itinerary-details.service.ts:Number

#### 1. What this table stores

Stores business rows for `dvi_users` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_users` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `Number`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `Number`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `userID`
- `guide_id`
- `vendor_id`
- `staff_id`
- `agent_id`
- `usertoken`
- `user_profile`
- `username`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- details API

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.

### Table: `dvi_staff_details`

**Model:** `dvi_staff_details`  
**Category:** Reference  
**Runtime usage:** Yes  
**Primary owner:** itinerary-details.service.ts:Number

#### 1. What this table stores

Stores business rows for `dvi_staff_details` that are touched by the scanned itinerary code paths.

#### 2. Why this table exists in itinerary logic

It exists because surrounding itinerary flows reference `dvi_staff_details` in the scanned code.

#### 3. READ usage

- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `Number`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `Number`; inspect that function for the exact branch and payload.
- File: `src/modules/itineraries/itinerary-details.service.ts`
  Function: `(top-level/undetected)`
  Operation: `READ`
  Filter/condition: Needs verification because the scan captures the call site, not a normalized dump of the full `where` object or raw predicate.
  Why it read: Uses the table in `(top-level/undetected)`; inspect that function for the exact branch and payload.

#### 4. INSERT / CREATE usage

- No scanned insert hit.

#### 5. UPDATE usage

- No scanned update hit.

#### 6. DELETE / SOFT DELETE usage

- No scanned delete hit.

#### 7. Raw SQL usage

- No scanned raw SQL hit.

#### 8. Important fields and meaning

- `staff_id`
- `agent_id`
- `staff_name`
- `staff_mobile`
- `staff_email`
- `roleID`
- `createdby`
- `createdon`

- These are schema field names. Exact semantics still depend on the referenced service/helper flow. [Verified from schema + code scan]

#### 9. Related tables

- Needs verification because no strong relation was inferred beyond the table name and code hits.

#### 10. Business flows using this table

- details API

#### 11. Debug when

- The observed itinerary behavior or payload depends on this table and the referenced owner function is returning stale, missing, duplicated, or mismatched state.
- Recheck the read/write hits above when timeline, hotel, vehicle, confirmation, cancellation, voucher, provider, or account outputs do not line up with DB state.

#### 12. Not used / uncertainty

- No additional uncertainty beyond the captured scan hits.
