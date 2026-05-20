# Hotspot Build Architecture (Implemented)

## 1) Scope and intent
This document describes the exact hotspot build behavior currently implemented in the backend scheduler.

Primary source flow:
- `TimelineBuilder.buildTimelineForPlan(...)`

Entry points that invoke this flow:
- `HotspotEngineService.rebuildRouteHotspots(...)`
- `ItinerariesService.deleteHotspot(...)` -> full rebuild
- `ItinerariesService.rebuildManualHotspotSet(...)` -> rebuild with manual protection and optional route scope

The goal is to describe implemented behavior only, including constraints, pass ordering, scoring, repair cycles, and final row generation.

## 2) Pipeline entry and transaction context
`HotspotEngineService.rebuildRouteHotspots(...)` performs these steps before invoking the builder:
1. Loads existing visit rows (`item_type = 4`) for the plan.
2. Extracts manual hotspots (`hotspot_plan_own_way = 1`, active only).
3. Deletes active hotspot timeline rows for full plan or scoped route.
4. Deletes parking charge rows unless `skipParking = true`.
5. Calls `buildTimelineForPlan(...)` with:
- `manualPlacementByRoute`
- optional `scopeToRouteId`
6. Applies post-build safety filtering and duplicate control before final insert.

Important service-level guarantees:
- Manual hotspots are preserved and marked protected during rebuild filtering.
- Route-scoped preview rebuild can avoid touching sibling routes and can skip parking writes.

## 3) Top-level builder orchestration
Inside `buildTimelineForPlan(...)`:
1. Loads plan header and active routes ordered by date then route id.
2. Applies route scoping if requested.
3. Computes same-city reservation map to avoid cross-route duplicate reselection.
4. Loads all hotspots once (global preload) for performance.
5. Loads all timing records once and builds `timingMap` for O(1) access.
6. Optionally primes distance helper global settings.
7. Initializes output buffers:
- `hotspotRows`
- `parkingRows`
8. Iterates route by route, constructing timeline rows in memory.

## 4) Route-level setup
For each route:
1. Derives `routeStartTime`, `routeEndTime`, and absolute second windows.
2. Handles overnight windows by adding 86400 when end is logically next day.
3. Computes strict last-route arrival deadline from departure datetime minus departure buffer (fallback to route end when absent).
4. Sets initial route location and coordinates from stored locations.
5. Initializes route-local ordering:
- Last route starts at order 2
- Other routes start at order 1

## 5) Candidate hotspot selection
Selection is done by `fetchSelectedHotspotsForRoute(...)`.

Implemented selection behavior:
1. Route context is loaded from route table.
2. Source and destination names are resolved using `dvi_stored_locations` (primary), with fallback lookups.
3. Day-of-week is normalized to PHP convention (`Monday=0..Sunday=6`).
4. Timing rows are loaded for that weekday but not used as hard prefilter for missing timing.
5. Route-level excluded hotspots (`excluded_hotspot_ids`) are filtered out.
6. Hotspots are bucketed by city match:
- `source`
- `destination`
- `via` (from via route details)
7. Distances for sorting are from travel-distance helper, not simple haversine approximation.
8. Bucket sorting is deterministic:
- priority asc (`0` treated as `9999`)
- distance asc
- id tie-break
9. Direct-route behavior:
- `direct_to_next_visiting_place = 1` -> destination bucket only
- otherwise -> source + via + destination (or source + via if destination skip requested)
10. De-dup key is `hotspot_ID + bucket` (same hotspot may appear in different buckets).
11. Returns normalized `SelectedHotspot` records with `matched_bucket`, `hotspot_priority`, `hotspot_distance`.

## 6) Day strategy switching
Builder has two strategy branches:
1. Day-1 special branch with different-city and arrival/defer logic.
2. Other-days branch with multi-pass scheduling and optimization cycles.

Additional day logic implemented:
- Same arrival and departure city with late departure can defer day-1 sightseeing.
- Day-1 direct/non-direct handling alters source/destination inclusion.
- Last-day logic for deferred day-1 sightseeing is supported.
- Same-city reserved hotspot filtering prevents re-auto-select across related routes.
- Existing manual hotspots are merged back into selected candidates and sorted by preferred manual order.

## 7) Other-days scheduler architecture
This is the core multi-pass engine where architect-level upgrades were applied.

### 7.1 Pass buckets
Candidates are split into:
1. Strict hotspots: priority 1..3
2. Filler hotspots: all others

Intercity adjustment:
- On large intercity idle windows, destination strict hotspots are prioritized before non-destination strict.

### 7.2 Pass sequence
Within each optimization cycle, pass order is:
1. `PASS_STRICT`
2. `PASS_FILLER_PRIMARY`
3. `PASS_DEFERRED_PRIMARY`
4. `PASS_REJECTED_RETRY`
5. `PASS_FILLER_SECONDARY`
6. `PASS_DEFERRED_SECONDARY`

### 7.3 New bounded optimization cycles
Two architect-level controls were added:
1. `MAX_SCHEDULER_OPTIMIZATION_CYCLES = 4`
2. `MAX_MUST_VISIT_REPAIR_ATTEMPTS = 2`

Cycles 1 to 3 are the normal multi-pass optimization cycles.
Cycle 4 is the isolated same-city gap-fill cycle when the route qualifies for that branch.

Each cycle:
1. Re-runs all 6 passes.
2. Tracks whether cycle made progress.
3. Computes state hash:
- scheduled set
- deferred set
- rejected-retry set
- current time
4. Stops on must-visit satisfaction or bounded limit/steady-state.

### 7.4 Cycle-4 same-city gap fill branch
There is one special late-stage branch that runs for same-city routes during the final optimization cycle.

Trigger condition:
1. The scheduler reaches the final optimization cycle.
2. Source and destination are the same canonical city.

Implemented behavior:
1. Reads already persisted active hotspot visit rows for the current route.
2. Builds a route-local planned set from persisted rows plus already-built in-memory visit rows.
3. Prefilters candidates that are already persisted/planned on the route, already used on the previous same-city day, closed all days, or closed on the current visit day.
4. Sorts remaining candidates by:
- priority descending
- distance ascending
- hotspot id ascending
5. For each candidate:
- computes travel time from current position
- checks operating-hours fit
- optionally waits until next opening window if the wait still fits inside the route window
- rejects when the day is closed, the window is invalid, or the visit would overflow route end
6. On acceptance, writes travel, optional free-time, hotspot visit, and parking rows in the same way as the main scheduler.

Important contract:
- this branch does not reuse the general pass queues blindly
- it is an isolated same-city gap-fill pass designed to avoid re-adding hotspots that already exist on the current route or were consumed on the previous same-city day
- the branch is only a late-cycle backfill, not the primary selector

### 7.4 Explicit gap model hook
Implemented helper:
- `buildRemainingGapIntervals()`

Current behavior:
- Computes remaining interval from current route time to route end.
- Used in logging and filler score weighting.

### 7.5 Filler scoring (implemented)
Filler passes sort by `scoreFillerHotspot(...)` descending.

Score components:
1. Priority component: `priority * 10`
2. Bucket bias:
- destination: +18
- via: +8
- source/other: +0
3. Distance score: `max(0, 60 - floor(distanceKm))`
4. Wait score: `max(0, 80 - waitPenaltyMinutes)`
5. Window fit score: `min(50, floor(remainingGapSeconds / 900))`

This creates gap-aware and opening-time-aware filler ordering.

### 7.6 Must-visit guarantee and repair
After each cycle:
1. Finds unscheduled strict ids (priority 1..3 that are not added).
2. If none remain -> logs `MUST_VISIT_GUARANTEE_SATISFIED` and exits.
3. If no progress and repair attempts available:
- force-queues unscheduled strict into deferred and rejected-retry pools
- logs `MUST_VISIT_REPAIR_CYCLE_QUEUED`
4. If still unresolved at bounds or no progress:
- logs `MUST_VISIT_GUARANTEE_UNRESOLVED`
- exits loop

Note:
- Guarantee is represented as bounded best-effort with explicit unresolved signaling, not hard infeasible exception throwing.

## 8) Candidate feasibility checks per attempt
For each candidate in a pass, these checks are applied in sequence.

1. Duplicate guard:
- skip if hotspot already added in plan-level set

2. Bucket cutoff times:
- source cutoff: 12:00 (unless retry bypass flag)
- via cutoff: 19:00
- destination cutoff: 21:00

3. Hotspot master data existence check.

4. Travel and visit absolute-time projection:
- calculates travel duration and visit end in absolute seconds

5. Route-end gate:
- non-last routes use projected arrival-to-destination gate
- last route uses visit-end <= route-end gate

6. Operating-hours gate:
- checks with day-of-week timing windows
- allows bounded destination overrun relaxation (up to 15 minutes)

7. Large wait deferral:
- if strict pass and wait-to-open >= 90 min, queue deferred/retry and continue

8. Day-end re-check after wait-until-open adjustment.

9. Last-route departure deadline guard:
- ensures enough time remains to reach departure target

10. Closed/outside-window handling:
- closed day -> reject/defer
- outside window -> reject/retry/defer as applicable

Cycle-4 adds the same feasibility gates, but only after route-local persistence and previous-day same-city filtering have removed already-used candidates.

## 9) Row generation when candidate is accepted
On acceptance, rows are emitted in this order:
1. Travel row (`item_type = 3`)
2. Optional free-time break row if waiting gap >= 45 min
3. Hotspot visit row (`item_type = 4`)
4. Parking charge rows for the hotspot

State updates:
- add hotspot id to plan-level dedup set
- move current time and coordinates to the scheduled hotspot
- increment order after travel+visit pair

## 10) Trailing free-time behavior
After hotspot passes:
1. Computes trailing remaining gap.
2. Inserts free-time row if:
- gap >= 45 min
- route has at least one scheduled attraction row
3. Skips explicit all-day free-time row when no hotspots were scheduled.

## 11) Hotel segment behavior for non-last routes
If route is not last:
1. Builds travel-to-hotel row (`item_type = 5`)
2. Uses destination city for hotel travel distance
3. For deferred-hotel flow, can anchor hotel travel near end-of-day
4. Fixes hotel time anchoring to actual computed arrival time (with route-end clamp)
5. Builds check-in/close row (`item_type = 6`) at computed hotel arrival

## 12) Last-route departure return behavior
If route is last:
1. Iteratively trims latest attractions if needed so departure deadline can still be met.
2. Builds final return-to-departure travel row (`item_type = 7`) anchored against deadline.

## 13) Final validation pass
Before returning rows:
1. Rebuilds route start/end second maps.
2. Runs parity-mode checks for rows crossing route end.
3. Runs day-boundary check for hotel rows before route start.
4. Logs proof diagnostics when debug proof mode is enabled.
5. Returns in-memory `hotspotRows` and `parkingRows`.

Note:
- Validation in current parity mode logs anomalies; it does not force conflict mutation or hard-stop the build.

## 14) Manual hotspot integration contract
Manual hotspots are integrated in two layers.

Builder layer:
1. Existing manual rows are merged into selected candidates.
2. Preferred manual placement order can override order.

Engine layer:
1. Manual hotspots are added to protected hotspot set during filtering.
2. Protected rows are retained through conflict/duplicate cleanup.

Manual rebuild path options supported:
- `protectedHotspotIds`
- `anchorOrderByRoute`
- `preferredManualPlacementByRoute`
- `scopeToRouteId`
- `skipParking`

## 15) Delete hotspot rebuild contract
`deleteHotspot(...)` behavior:
1. Resolves route hotspot id or hotspot id to actual hotspot.
2. Deletes all related timeline rows for that hotspot in the route.
3. Deletes linked activity rows.
4. Adds hotspot id to route exclusion list.
5. Triggers full `rebuildRouteHotspots(...)`.
6. Rebuilds parking charges after transaction.

## 16) Architect-level changes that were implemented in this cycle
Implemented now:
1. Bounded optimization cycles for scheduling convergence.
2. Explicit gap interval helper and usage.
3. Gap-aware filler scoring.
4. Must-visit bounded repair stage.
5. Explicit must-visit guarantee outcome logging.
6. Multi-pass order preserved as strict -> filler -> deferred -> retry -> filler -> deferred.
7. Late-cycle same-city gap-fill branch with persistence-aware duplicate rejection.

## 17) Explicit boundaries of current implementation
Implemented as bounded best-effort architecture, with these limits:
1. Gap model currently uses remaining route window abstraction, not full disjoint interval packing across arbitrary internal holes.
2. Repair stage currently force-queues unscheduled strict hotspots; it does not perform explicit row eviction/swap optimization of already scheduled fillers.
3. Final feasibility is surfaced via booking-rule logs, not as hard API failure contract.

4. The cycle-4 branch is intentionally route-scoped and persistence-aware; it is not a global reoptimizer and does not retroactively reshuffle the whole route to make a rejected hotspot fit.

These boundaries are intentional in current code and should be considered current-state architecture, not missing runtime defects.

## 18) Quick pseudocode aligned to current implementation
```text
for each route in plan:
  setup route window, deadline, location state
  selected = fetchSelectedHotspotsForRoute(...)
  selected = apply same-city reservation filter
  selected = merge manual candidates and preferred ordering

  if day1 special branch:
    run day1 scheduling behavior
  else:
    split selected into strict and filler
    init deferred/retry queues

    for optimizationCycle in 1..MAX_SCHEDULER_OPTIMIZATION_CYCLES:
      run 6 passes in fixed order
      each candidate runs full feasibility gate chain
      accepted candidate emits travel+optional break+visit+parking

      if all strict scheduled: success and break
      if no progress and repair attempts left: enqueue strict for repair
      else if no progress or cycle limit: unresolved and break

    if route is same-city and final optimization cycle is active:
      run isolated persistence-aware gap-fill pass
      skip candidates already persisted/planned on route
      reject if closed day, outside operating window, or route end overflows
      accept only when travel + visit fits inside remaining route window

    add trailing free-time when needed

  if not last route:
    emit travel-to-hotel + check-in rows
  else:
    trim if needed and emit return-to-departure row

run final parity validations
return hotspotRows + parkingRows
```

## 19) Files that define this architecture
- `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- `src/modules/itineraries/engines/hotspot-engine.service.ts`
- `src/modules/itineraries/itineraries.service.ts`
- `src/modules/itineraries/engines/helpers/deferred-retry.helper.ts`

Implementation anchors for the cycle-4 branch:
- `src/modules/itineraries/engines/helpers/timeline.builder.ts` around the `CYCLE4_SAME_CITY_GAP_FILL_*` logging block
- `hotspot-debug-server.log` lines where `CYCLE4_SAME_CITY_GAP_FILL_START` and `CYCLE4_SAME_CITY_GAP_FILL_REJECTED` are emitted

## 20) Recommended usage notes for future maintainers
1. Keep pass-order and cycle bounds stable unless retuning with regression tests.
2. Treat manual protection and exclusion-list semantics as hard contracts.
3. When extending repair logic, preserve bounded runtime and explicit unresolved signaling.
4. If adding strict hard-fail behavior, do it behind a feature flag to preserve parity flows.
