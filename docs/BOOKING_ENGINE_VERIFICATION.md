# Booking Engine Verification

Verification date: 2026-04-09
Mode: verification-only (no executable logic changes in this pass)

## Rule-by-rule verification

| # | Requirement | Status | Exact files | Function or method | How it works now | Missing edge case |
|---|---|---|---|---|---|---|
| 1 | Arrival before 12 noon in same-city hotel => sightseeing first, then hotel after 2 PM | Implemented | api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts | buildTimelineForPlan | For first route, same-city stay before noon does not trigger forceNoSightseeingOnThisRoute, so hotspots are scheduled first; hotel segment is appended later; check-in time is clamped to >= 14:00 on same-city Day 1. | If no hotspots fit, flow still becomes direct-to-hotel (expected), but no explicit lunch break insertion. |
| 2 | Arrival after 12 noon in same-city hotel => hotel first, then sightseeing if possible | Implemented | api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts | buildTimelineForPlan | On Day 1 same-city stays, if arrival is after noon and hotel is within 20 km, the engine inserts hotel-first travel/check-in, enforces minimum 2 PM check-in, adds a 2-hour rest gap, then continues normal hotspot scheduling if time remains. | For >20 km, distance rule keeps hotel last by design. |
| 3 | Hotel in different city => sightseeing en route, hotel afterward | Implemented | api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts | buildTimelineForPlan, fetchSelectedHotspotsForRoute | Day-1 different-city path now explicitly prefers source/via (skip destination) for non-direct routes and still appends hotel segment afterward; direct routes remain safe and unchanged. | Direct routes can still intentionally minimize sightseeing based on route flag. |
| 4 | Hotel > 20 km from arrival => hotel last stop | Implemented | api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts | buildTimelineForPlan | Engine now computes Day-1 same-city arrival->hotel Haversine distance and applies explicit threshold logic; hotel-first branch is only eligible at <=20 km, so >20 km flows to hotel-last scheduling. | Depends on reliable arrival and hotel coordinates being present. |
| 5 | Hotel <= 20 km from arrival => hotel may be first, include ~2 hour rest gap | Implemented | api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts | buildTimelineForPlan | Added explicit Day-1 same-city <=20 km branch: hotel-first travel/check-in, enforce 2 PM check-in floor, add 2-hour rest row, then run hotspot scheduling with existing opening-hours and cutoff checks. | Branch currently applies to after-noon arrivals to preserve existing before-noon sightseeing-first behavior. |
| 6 | Same arrival/departure city with departure after 4 PM => defer local sightseeing to last day | Implemented | api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts | buildTimelineForPlan | shouldDeferDay1Sightseeing is computed from normalized same city + departure hour >=16; Day 1 local stay route can skip local hotspots and last-day route fetches local sightseeing set. | Heuristic depends on route city normalization; complex city aliases may misclassify. |
| 7 | Must-visit spots always prioritized | Partially implemented | api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts | fetchDay1TopPrioritySourceHotspots, fetchSelectedHotspotsForRoute | Priority sorting exists (hotspot_priority, with priority 0 pushed later) and day-1 top-priority selection exists. | No explicit must-visit flag/lock semantics; priority is used as proxy. |
| 8 | Closed must-visit spots deferred to next opening slot | Partially implemented | api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts | buildTimelineForPlan, checkHotspotOperatingHoursFromMap | Deferred hotspots now carry a mustVisitProxy flag (priority>0) and pass-2 retries sort must-visit proxies ahead of optional deferred hotspots. | No explicit must-visit DB field exists, so proxy behavior is used. |
| 9 | Optional closed spots skipped/deferred | Implemented | api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts | checkHotspotOperatingHoursFromMap, buildTimelineForPlan | If a hotspot is not open now but has nextWindowStart, it is deferred; if closed for the day, it is skipped. | None critical; behavior is generic and not optional-vs-must specific. |
| 10 | Proximity-based ranking exists | Implemented | api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts | fetchDay1TopPrioritySourceHotspots, fetchSelectedHotspotsForRoute | Distance from start location is calculated and used as secondary sorter after priority; travel-time calculations further influence schedule feasibility. | No explicit weighted score formula (+50/+30/+20) in active scheduler path. |
| 11 | Opening-hours logic is consistently used in generation | Implemented | api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts | checkHotspotOperatingHoursFromMap, buildTimelineForPlan | Day scheduling calls operating-hours checks before placing visits; handles open-all-time, closed, and next window defer. | Some fallback assumptions treat missing timings as open, which may differ from strict data policy. |
| 12 | On-the-way hotspot selection exists | Implemented | api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts | fetchSelectedHotspotsForRoute | Via-route rows are loaded from dvi_itinerary_via_route_details; matching hotspots are merged with source/destination pools using direct_to_next_visiting_place logic. | None major; quality depends on via location naming consistency. |
| 13 | Full-day trip suppresses conflicting local visits | Partially implemented | api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts | buildTimelineForPlan | Planner now checks optional metadata markers (`is_full_day_trip`, `full_day_trip`, `day_trip`, `is_day_trip`) and suppresses sightseeing when a reliable marker is present. | Current schema has no canonical persisted full-day field, so this depends on upstream metadata availability. |
| 14 | Houseboat stay disables sightseeing | Implemented | api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts | getHotelDetailsForRoute, buildTimelineForPlan | Houseboat is detected from hotel name/category text, exposed as isHouseboat, then forceNoSightseeingOnThisRoute suppresses hotspot selection for that route. | Detection is string-pattern based; may miss nonstandard category naming. |
| 15 | Activity duration and cost are added when supported | Implemented | api.dvi.travel/src/modules/itineraries/itineraries.service.ts | addActivity, previewActivityAddition, checkActivityTimingConflicts | addActivity derives duration from activity_duration, computes start/end, stores activity_amout and timing, and can shift downstream timeline when extended. | Automatic activity insertion during initial itinerary generation is not present (manual/add flow driven). |
| 16 | Guide cost logic is applied when supported | Partially implemented | api.dvi.travel/src/modules/itineraries/itinerary-details.service.ts; api.dvi.travel/src/modules/itineraries/itineraries.service.ts | getItineraryDetails, confirmQuotation clone block | itinerary-details aggregates guide/hotspot/activity amounts into costBreakdown fields, and confirmation flow persists related rows/costs. | Net payable currently uses subtotal = hotel + vehicle only, so non-hotel aggregates are not yet included in final payable math. |
| 17 | Daily KM limit is validated or enforced | Implemented | api.dvi.travel/src/modules/itineraries/itinerary-details.service.ts; api.dvi.travel/src/modules/itineraries/engines/itinerary-vehicles.engine.ts | getItineraryDetails, itinerary vehicles eligible-list update flow | Existing allowed/extra KM computations are reused; itinerary-details now emits a non-breaking planner warning (`kmLimitWarning`) when assigned vehicles exceed allowed KM/extra KM. | This is soft-warning enforcement, not hard blocking of itinerary creation. |
| 18 | Recent hotspot timing fixes are still preserved | Implemented | api.dvi.travel/src/modules/hotspots/hotspots.service.ts; api.dvi.travel/src/modules/itineraries/itinerary-details.service.ts | hotspot update operating-hours upsert block; itinerary details hotspot display mapping | open24hrs or closed24hrs days are persisted even with empty slots via synthetic 00:00-23:59 slot; itinerary details messaging includes closed on this day and outside operating hours plus Closed label. | None found in this verification pass. |

## Exact files involved

- api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts
- api.dvi.travel/src/modules/itineraries/itineraries.service.ts
- api.dvi.travel/src/modules/itineraries/engines/itinerary-vehicles.engine.ts
- api.dvi.travel/src/modules/hotspots/hotspots.service.ts
- api.dvi.travel/src/modules/itineraries/itinerary-details.service.ts
- api.dvi.travel/prisma/schema.prisma

## Remaining gaps

1. Must-visit semantics remain priority-proxy driven because no explicit must-visit schema field exists.
2. Full-day trip suppression depends on upstream metadata keys; no canonical persisted full-day field exists in current schema.
3. KM handling is warning-based (soft enforcement), not hard-block validation in planner generation.
4. Non-hotel aggregates (guide/hotspot/activity) are exposed in response but not included in subtotal/net payable calculation.

## Safest next fixes

1. If product can provide a canonical must-visit flag in existing payload/table, map it directly and replace priority proxy semantics.
2. Add a canonical full-day/day-trip marker to route persistence (without new table) to make suppression deterministic.
3. Add optional strict-mode hard block for KM overrun if business flow requires enforcement instead of warning.

## Implementation Notes

- Preserved hotspot timing fixes exactly as-is:
   - open24hrs/closed24hrs persistence with empty slots in hotspots service
   - itinerary details closed/outside-hours messaging
- Distance-driven Day-1 same-city behavior now branches explicitly using computed arrival->hotel Haversine distance.
- Must-visit handling uses `hotspot_priority > 0` as safest proxy because no explicit must-visit field exists.
- Full-day suppression is implemented only when a reliable marker is present in route metadata keys; schema does not currently guarantee this field.
- No backend automated test harness is configured in this workspace (`package.json` has no test script and no `*.spec.ts`/`*.test.ts` files), so safe test additions were blocked without introducing new infrastructure.
