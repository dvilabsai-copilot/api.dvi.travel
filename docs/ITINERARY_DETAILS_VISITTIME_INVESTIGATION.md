# ITINERARY_DETAILS_VISITTIME_INVESTIGATION

Date: 2026-04-12
Target quoteId: DVI202604230
Target hotspotId: 13
Target routeHotspotId: 40060

## 1) High-level flow
Request path:
1. GET /api/v1/itineraries/details/:quoteId
2. Controller method: getItineraryDetails in src/modules/itineraries/itineraries.controller.ts
3. Service method: getItineraryDetails in src/modules/itineraries/itinerary-details.service.ts
4. Route-hotspot read query: raw SQL from dvi_itinerary_route_hotspot_details (item_type includes attraction rows)
5. Hotspot timing read: dvi_hotspot_timing rows loaded and grouped by hotspot ID
6. Response mapping: segments.push({ type: 'attraction', visitTime, timings, isConflict, ... })

## A. API flow (controller -> service -> query -> mapper)
Controller:
- File: src/modules/itineraries/itineraries.controller.ts
- Route decorator: @Get('details/:quoteId')
- Method: getItineraryDetails(quoteId, groupType)
- Call: this.detailsService.getItineraryDetails(quoteId, groupTypeNum)

Service:
- File: src/modules/itineraries/itinerary-details.service.ts
- Method: getItineraryDetails(quoteId, groupType?)
- Reads plan from dvi_itinerary_plan_details by itinerary_quote_ID
- Reads route list from dvi_itinerary_route_details
- Reads route hotspot rows via SQL:
  SELECT ... hotspot_start_time, hotspot_end_time, is_conflict, conflict_reason ...
  FROM dvi_itinerary_route_hotspot_details
  WHERE itinerary_plan_ID = ${planId}
    AND itinerary_route_ID = ${routeId}
    AND deleted = 0 AND status = 1
    AND (is_conflict = 0 OR hotspot_plan_own_way = 1)

Mapper:
- For item_type === 4 (attraction), visitTime starts as:
  startTimeText + ' - ' + endTimeText
- startTimeText/endTimeText come from this.formatTime(rh.hotspot_start_time/rh.hotspot_end_time)
- isConflict in response is direct mapping: (rh.is_conflict === 1)

## B. DB source of visitTime
Confirmed by direct DB query (script):
- Table: dvi_itinerary_route_hotspot_details
- Primary key: route_hotspot_ID
- Row route_hotspot_ID=40060 has:
  - itinerary_plan_ID = 268
  - itinerary_route_ID = 1238
  - hotspot_ID = 13
  - item_type = 4
  - hotspot_order = 6
  - hotspot_start_time = 1970-01-01 21:43:00 (TIME)
  - hotspot_end_time = 1970-01-01 02:43:00 (TIME)
  - hotspot_plan_own_way = 0
  - is_conflict = 0
  - conflict_reason = null
  - deleted = 0
  - status = 1

Route day window row:
- Table: dvi_itinerary_route_details
- itinerary_route_ID = 1238
- route_start_time = 08:00:00
- route_end_time = 20:00:00
- itinerary_route_date = 2026-05-02

Hotspot timing row:
- Table: dvi_hotspot_timing
- hotspot_ID = 13, hotspot_timing_day = 5
- hotspot_start_time = 09:00:00
- hotspot_end_time = 17:00:00
- hotspot_closed = 0
- hotspot_open_all_time = 0

Conclusion:
- 09:43 PM - 02:43 AM is already stored in DB route hotspot row.
- API is not inventing this range; it is reading and formatting stored TIME fields.

## C. Where visitTime is formatted
File: src/modules/itineraries/itinerary-details.service.ts
- formatTime() uses UTC hours/minutes to format TIME columns as hh:mm AM/PM.
- Attraction visitTime is built from route hotspot TIME fields:
  visitTimeDisplay = `${startTimeText} - ${endTimeText}`
- Final response carries visitTimeDisplay directly.

## D. Route/day timing validation path
Read-time (details API):
- No hard-block on day-end vs visitTime.
- Endpoint annotates some timing notes but does not drop invalid attraction rows.

Write-time (generation/rebuild):
- File: src/modules/itineraries/engines/helpers/timeline.builder.ts
- Route end baseline is built with routeEndSeconds.
- Conflict check compares projectedArrivalSeconds > routeEndSeconds.
- Problematic time calculations rely on helper functions that wrap at 24h.

Time helper behavior:
- File: src/modules/itineraries/engines/helpers/time.helper.ts
- secondsToTime() uses modulo 86400 (wraps clock after midnight).
- addSeconds()/addTimes() both return wrapped time-of-day, not absolute day timeline.

Risk:
- After-midnight end times can appear numerically small (e.g., 02:43) and incorrectly compare as if earlier in the same day.

## E. Hotspot timing validation path
In itinerary details mapper (read-time):
- Checks if visit fits any opening window:
  arrivalMins >= opStart && departureMins <= opEnd
- This is done with minutes-from-midnight only.
- For overnight visits like 21:43 -> 02:43, departureMins=163, so condition can pass incorrectly against 09:00-17:00 because 163 <= 1020.

Observed in proof logs:
- timingValidationExecuted: true
- timingValidationPassed: true
- formattedVisitTimeInResponse: 09:43 PM - 02:43 AM
- hotspotAllowedTimings: 09:00 AM - 05:00 PM

This proves validation executed but used non-absolute minute comparison that mishandles overnight ranges.

## F. Why invalid value was returned
Proven:
1. API reads raw hotspot_start_time/hotspot_end_time from DB row 40060.
2. API formats that directly into visitTime.
3. API includes row because filter is (is_conflict = 0 OR hotspot_plan_own_way = 1), and row has is_conflict=0.
4. Read-time timing check is advisory and currently treats overnight windows incorrectly, so it can report pass.
5. No read-time enforcement removes this row even when day end/hotspot window are violated.

## G. Stored bad data vs read-time transform
Proven result:
- Bad schedule is stored in DB already.
- API reflects stored values.
- API response is not the primary origin of 09:43 PM - 02:43 AM.

## H. Recommended minimal safe fix
1. Write-path guard (primary):
- In timeline/generation conflict checks, use absolute timeline minutes/seconds (carry day offset) instead of wrapped HH:MM:SS comparisons.
- Prevent persisting hotspot_start_time/hotspot_end_time windows that cross day end unless route explicitly supports overnight.

2. Read-path guard (secondary safety net):
- In itinerary-details.service, when validating visit vs opening window and route day end, normalize ranges to absolute windows (if end < start, treat end += 24h).
- If invalid, either:
  - set isConflict=true with conflictReason, or
  - exclude attraction row from response (based on business rule).

3. Conflict integrity:
- Ensure rows violating route/day or hotspot timings cannot remain is_conflict=0.

## I. Regression risks
- Existing itineraries with overnight rows may suddenly become conflicted/hidden.
- Any legitimate overnight feature (if supported) needs explicit flag handling to avoid false conflicts.
- Vehicle/parking/day-distance computations relying on wrapped times may need aligned absolute-time logic.

## 2) DB proof summary
Script used: api.dvi.travel/scripts/debug-itinerary-hotspot-visit-time.js
Key outputs:
- DB row stores 09:43 PM - 02:43 AM (route_hotspot_ID=40060)
- Route day end is 08:00 PM (route 1238)
- Hotspot timing window is 09:00 AM - 05:00 PM (hotspot 13)
- API response hotspot object returns same visitTime and isConflict=false

## 3) API proof summary
Instrumented logs (temporary):
- [ItineraryDetails][PROOF] raw row shows hotspot_start_time/hotspot_end_time from SQL query
- [TimingValidation][PROOF] shows validation executed=true and passed=true for target row
- [VisitTime][PROOF] final attraction segment emitted with visitTime 09:43 PM - 02:43 AM and isConflict=false

## 4) Validation proof summary
- Day-end and opening-window checks are present but implemented with wrapped time-of-day arithmetic in critical places.
- This allows overnight-shaped windows to compare incorrectly and bypass conflict marking.

## 5) Root cause statement (proof level)
Root cause is considered PROVEN only for these facts:
- Invalid visit window exists in persisted DB row.
- Details API reads and returns it directly.
- Timing validation in details path executes but passes incorrectly for overnight-shaped range using same-day minute comparisons.

Potential upstream write-path cause is HIGHLY LIKELY but not fully proven for this exact row creation event in this run (write path was instrumented, but this investigation did not regenerate row 40060).

## 6) Files created/modified
Created:
- api.dvi.travel/scripts/debug-itinerary-hotspot-visit-time.js
- ITINERARY_DETAILS_VISITTIME_INVESTIGATION.md

Modified (temporary proof logs):
- api.dvi.travel/src/modules/itineraries/itinerary-details.service.ts
- api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts

## CONFIRMED FACTS
- Route hotspot row 40060 stores hotspot_start_time=21:43 and hotspot_end_time=02:43.
- Route 1238 ends at 20:00.
- Hotspot 13 timing for route day is 09:00-17:00.
- API returns visitTime 09:43 PM - 02:43 AM and isConflict=false for hotspot 13 / routeHotspotId 40060.
- Details API builds visitTime from DB start/end fields.

## INFERENCES
- The invalid API value is a read-through of persisted invalid schedule.
- Wrapped time-of-day arithmetic likely allowed invalid values to be persisted without conflict.

## UNPROVEN ASSUMPTIONS
- Exact historical operation that produced row 40060 (auto generation vs manual add vs rebuild) was not replayed in this run.
- Write-path instrumented logs for this exact row creation were not captured in this run.

## EXACT WRITER OF ROW 40060
CONFIRMED FACTS:
- Writer function that persisted route hotspot timeline rows is `rebuildRouteHotspots` in `src/modules/itineraries/engines/hotspot-engine.service.ts`.
- Persistence statement is `dvi_itinerary_route_hotspot_details.createMany({ data: dbHotspotRows })`.
- Row 40060 shape exactly matches this writer payload pattern: item_type=4, paired travel row item_type=3, timeline fields (`hotspot_traveling_time`, `hotspot_start_time`, `hotspot_end_time`, `is_conflict`, `conflict_reason`) and batch-identical `createdon` with neighboring route rows.
- DB evidence captured by script (`scripts/prove-routehotspot-40060-write-path.js`) shows row 40060 and adjacent rows share `createdon=2026-04-12T11:21:39.000Z`, consistent with one rebuild batch insert.

PROVEN ROOT CAUSE (writer identity):
- Row 40060 was inserted by `HotspotEngineService.rebuildRouteHotspots` through `createMany`, with row values built upstream in `TimelineBuilder.buildTimelineForPlan` and `HotspotSegmentBuilder.build`.

## EXACT CALCULATION CHAIN
CONFIRMED FACTS (from runtime `[VisitTimeCalc][PROOF]` and DB rows):
- Previous segment end: `20:36:00`
- Travel duration to hotspot 13: `4020` seconds (`01:07:00`)
- Hotspot duration: `18000` seconds (`05:00:00` from hotspot master)
- Computed visit start raw: `74160 + 4020 = 78180` seconds -> `21:43:00`
- Computed visit end raw: `78180 + 18000 = 96180` seconds
- Stored TIME wraps at 24h: `96180 % 86400 = 9780` -> `02:43:00`
- Stored row fields are exactly `hotspot_start_time=21:43:00` and `hotspot_end_time=02:43:00`.

Modulo/wrap proof:
- Runtime log explicitly shows `moduloWrapApplied: true` for this hotspot write.
- Helper path used in writer chain is `addSeconds` -> `secondsToTime` (`% 86400`) in `src/modules/itineraries/engines/helpers/time.helper.ts`.

## EXACT REASON CONFLICT WAS NOT SET
CONFIRMED FACTS (from runtime `[ConflictDecision][PROOF]`):
- Route end seconds: `72000` (`20:00:00`)
- Wrapped sightseeing end seconds used by day-1 logic: `9780` (`02:43:00`)
- Travel-to-destination seconds: `8880`
- Projected arrival seconds used in comparison: `9780 + 8880 = 18660`
- Decision condition in day-1 path: `projectedArrivalSeconds > routeEndSeconds`
- Evaluated result: `18660 > 72000` -> `false`.
- Therefore `hasTimeConflict=false` and row persisted with `is_conflict=0`.

Operating-hours check that also passed incorrectly:
- Visit start/end used: `21:43:00` and `02:43:00`
- Open window used: `09:00:00 - 17:00:00`
- Condition used: `visitStartSeconds >= opStartSeconds && visitEndSeconds <= opEndSeconds`
- Evaluated as true because `78180 >= 32400` and `9780 <= 61200`.

Exact incorrect condition behavior:
- Both conflict and operating checks used wrapped same-day seconds (no absolute overnight normalization in this day-1 path).
- Overnight visit end became numerically small (`9780`), causing both checks to pass.

## PROVEN CAUSE VS PREVIOUS INFERENCE
CONFIRMED FACTS:
- Writer is now proven: `rebuildRouteHotspots -> createMany`.
- Exact numeric chain for `21:43 -> 02:43` is proven from runtime logs and row values.
- Exact decision that left `is_conflict=0` is proven with logged comparison values.

PROVEN ROOT CAUSE:
- In the day-1 write path, overnight-wrapped time-of-day seconds are compared directly against route/day constraints.
- Because wrapped end/projection values are reused as same-day values, invalid overnight visits can be persisted as non-conflict (`is_conflict=0`).

STILL UNPROVEN ITEMS:
- None for the target behavior chain (writer, inputs, calculation, and conflict decision are all proven).
