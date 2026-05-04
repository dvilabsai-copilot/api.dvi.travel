# SMART_ITINERARY_ENGINE_GAP_ANALYSIS

## 0. Handoff Notes (May 2026)

This section captures the latest implemented changes so the next coding agent can continue work without re-discovery.

### 0.1 What Was Implemented

1. Add Hotspot modal now requires explicit user action for preview.
- Removed auto-preview of the first hotspot on modal open.
- User must click Preview from left pane (or search then Preview).
- Frontend file changed: [dvi_frontend/src/pages/ItineraryDetails.tsx](dvi_frontend/src/pages/ItineraryDetails.tsx).

2. Mistakenly deleted hotspots are now recoverable from left pane.
- Backend no longer suppresses route excluded hotspots in available list.
- This allows user to preview and re-add deleted hotspots directly.
- Backend file changed: [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts).

3. Manual conflict insertion performance path was improved.
- For force conflict insertion, service short-circuits slow adaptive exploration and inserts conflict rows directly.
- Manual hotspot delete transaction timeout was increased to avoid timeouts during rebuild-heavy flows.

4. New E2E coverage added for 4-hotspot sequence insertion.
- New spec: [dvi_frontend/tests/e2e/itinerary-hotspot-insert-4-sequence.spec.ts](dvi_frontend/tests/e2e/itinerary-hotspot-insert-4-sequence.spec.ts).
- Existing hotspot modal/replacement specs were stabilized to avoid hard failures when preview actions are unavailable in current data states.

### 0.2 Branches and PR Creation Links

Backend repo branch:
- `feature/hotspot-recovery-explicit-selection`
- PR create link: https://github.com/dvilabsai-copilot/api.dvi.travel/pull/new/feature/hotspot-recovery-explicit-selection

Frontend repo branch:
- `feature/hotspot-recovery-explicit-selection`
- PR create link: https://github.com/dvilabsai-copilot/dvi_frontend/pull/new/feature/hotspot-recovery-explicit-selection

Note: Branches are pushed. PR auto-creation via CLI was blocked in-session due missing `gh` auth.

### 0.3 Important Current Behavior

1. Route-level available hotspots are still source/destination pooled (not truly anchor-aware).
2. Hotspots already scheduled on other days are still suppressed from current day left pane.
3. Deleted hotspots on same route can now reappear and be re-added.

### 0.4 Remaining Product Gap (Not Yet Implemented)

The following items from this gap document remain open and should be treated as next-phase work:

1. Activity-first optimization pass.
2. True slot planner (morning/evening window model).
3. Global cross-day optimizer and defer/carry-forward strategy.
4. Unified feasibility contract and warning model at API level.
5. Optional hotspot pure gap-fill policy (strictly after priority hotspots).

### 0.5 Next Recommended Engineering Step

Implement anchor-aware availability endpoint behavior first (low risk, high UX value):

1. Build availability list based on clicked anchor context, not only route source/destination pool.
2. Keep "scheduled on another day" hotspots visible with explicit badge and action (Move or Add Again) instead of hard suppression.
3. Add deterministic integration tests for cross-day move/re-add flows.

## 1. Executive Summary

This review compares the DOCX specification in `Smart Itinerary Optimization Engine (2).docx` against the current NestJS + Prisma + MySQL implementation under `src/modules/itineraries/`.

Strict conclusion:

- Strict smart-optimization compliance: 0%.
- Reason: the current backend does not implement the DOCX contract as an end-to-end optimization engine. It does not do activity-first scheduling, does not run a strict slot planner, does not enforce a full priority-first optimizer across the whole day, does not perform global re-optimization after every change, and does not persist/load a JSON smart-itinerary artifact as described in the DOCX.

What is strong:

- There is a real itinerary timeline builder and rebuild pipeline.
- The system persists day-level route/hotspot rows in normalized tables instead of ephemeral memory only.
- It has practical scheduling rules for arrival, late arrival, houseboat suppression, hotel-first/hotel-last branching, operating-hour checks, manual hotspot protection, and route-end enforcement.
- It already exposes rebuild summaries and warning severities for hotspot rebuild operations.
- It supports UI-facing segment reconstruction and manual hotspot/activity workflows.

What is weak:

- Activities are not part of the primary scheduling pass.
- Priority handling is selection-oriented and rule-based, not a strict optimization policy.
- Optional hotspots are not treated purely as gap fillers.
- Slot planning is absent even though the DOCX requires morning/evening windows.
- Cross-day carry-forward exists only as partial scaffolding.
- Distance optimization is heuristic and local, not a documented optimizer.
- Warning levels exist only as rebuild metadata, not as a unified feasibility contract.
- Persistence is row-based rebuild persistence, not the DOCX JSON load/save strategy.

Why the current system is a `timeline builder + rebuild engine`, not a full optimization engine:

- `ItinerariesService.createPlan()` orchestrates persistence and then calls `HotspotEngineService.rebuildRouteHotspots()`.
- `HotspotEngineService.rebuildRouteHotspots()` deletes active hotspot rows, rebuilds them in memory through `TimelineBuilder.buildTimelineForPlan()`, filters conflicts, reinjects manual hotspots, and persists rows again.
- `ItineraryDetailsService.getItineraryDetails()` does not optimize; it reconstructs frontend segments from persisted rows.
- The dominant pattern is `persist rows -> rebuild rows -> render rows`, not `load full constraints -> solve itinerary -> persist solution + explanation`.

Observed test quote snapshot:

- Quote `DVI202604247` maps to `itinerary_plan_ID = 292`.
- Current persisted state for that quote contains 3 routes, 31 hotspot rows, 0 activity rows, 0 hotel rows, and 0 via-route rows.
- That snapshot confirms the current engine can produce a usable hotspot timeline, but it also confirms that activity-first and hotel-aware optimization are not guaranteed inputs to the main build.

## 2. Current Architecture (ACTUAL)

Actual runtime flow:

`DB tables -> ItinerariesService -> HotspotEngineService -> TimelineBuilder -> dvi_itinerary_route_hotspot_details persistence -> ItineraryDetailsService -> frontend segments`

Concrete code path:

1. Controller entrypoints live in `src/modules/itineraries/itineraries.controller.ts`.
2. `ItinerariesService.createPlan()` in `src/modules/itineraries/itineraries.service.ts` persists plan, routes, via routes, travellers, vehicles, hotels, then calls `this.hotspotEngine.rebuildRouteHotspots(...)`.
3. `HotspotEngineService.rebuildRouteHotspots()` in `src/modules/itineraries/engines/hotspot-engine.service.ts`:
   - loads existing hotspot rows
   - preserves manual hotspots
   - deletes active `dvi_itinerary_route_hotspot_details`
   - calls `this.timelineBuilder.buildTimelineForPlan(...)`
   - drops conflict rows
   - injects/protects manual hotspots
   - persists rebuilt hotspot and parking rows
   - returns `rebuildSummary` and `warnings`
4. `TimelineBuilder.buildTimelineForPlan()` in `src/modules/itineraries/engines/helpers/timeline.builder.ts` performs the actual sequencing logic for route rows.
5. `ItineraryDetailsService.getItineraryDetails()` in `src/modules/itineraries/itinerary-details.service.ts` reads persisted hotspot rows, activity rows, hotel rows, and via-route rows, then maps them into frontend `segments`.

Important functions and their roles:

- `ItinerariesService.createPlan()`
  Orchestrates initial build.
- `ItinerariesService.addHotspot()`, `deleteHotspot()`, `previewAddHotspot()`, `addActivity()`, `deleteActivity()`, `smartPreviewActivity()`
  Trigger localized mutation flows and then rebuild or preview the timeline.
- `HotspotEngineService.rebuildRouteHotspots()`
  Core rebuild coordinator.
- `TimelineBuilder.buildTimelineForPlan()`
  Core row scheduler.
- `TimelineBuilder.fetchSelectedHotspotsForRoute()` and `HotspotSelector.selectForRoute()`
  Candidate hotspot selection.
- `evaluateArrivalHotelPolicy()` in `src/modules/itineraries/services/arrival-hotel-policy.service.ts`
  Arrival-day hotel branching policy.
- `queueDeferredMustVisitHotspot()` in `src/modules/itineraries/engines/helpers/deferred-retry.helper.ts`
  Same-pass deferral helper for must-visit hotspots.
- `ItineraryDetailsService.getItineraryDetails()`
  Segment reconstruction for the API/frontend.

DB tables actually involved in this flow:

- `dvi_itinerary_plan_details`
- `dvi_itinerary_route_details`
- `dvi_itinerary_route_hotspot_details`
- `dvi_itinerary_route_hotspot_parking_charge`
- `dvi_hotspot_place`
- `dvi_hotspot_timing`
- `dvi_itinerary_route_activity_details`
- `dvi_itinerary_plan_hotel_details`
- `dvi_itinerary_via_route_details`

## 3. Actual Segment Building Flow

The persisted timeline is row-driven. The frontend segments are reconstructed from `dvi_itinerary_route_hotspot_details` rows.

Actual item type mapping:

- `1` -> start/buffer row
- `2` -> travel row from source to next location in legacy/response handling
- `3` -> travel row to hotspot or via route
- `4` -> attraction/hotspot stay
- `5` -> travel to hotel
- `6` -> hotel check-in
- `7` -> final drop/departure transfer

Important detail:

- The current builder mostly emits `1, 3, 4, 5, 6, 7`.
- `ItineraryDetailsService` still handles `item_type = 2`, which means the response layer supports legacy/current mixed row shapes.

How rows are built today:

1. `TimelineBuilder.buildTimelineForPlan()` loads the plan, route rows, all hotspot masters, all timing rows, and hotel policy state.
2. It selects candidate hotspots per route.
3. It inserts a start/buffer row (`item_type = 1`) when applicable.
4. For each scheduled hotspot candidate, it creates:
   - one travel row (`item_type = 3`)
   - one hotspot stay row (`item_type = 4`)
5. At route end, for non-last routes, it appends:
   - travel to hotel (`item_type = 5`)
   - check-in (`item_type = 6`)
6. For the last route, it appends final drop/departure travel (`item_type = 7`).

Sorting behavior:

- Builder-side scheduling is order-driven through `hotspot_order` and absolute-second time calculations.
- `ItineraryDetailsService.getItineraryDetails()` then re-sorts generated `segments` chronologically because persisted rows are not always emitted in the same order as UI chronology.
- The response layer applies tie-breaking rules so travel and attraction rows render in a human-usable order.

Time handling behavior:

- The builder uses `route_start_time` and `route_end_time` from `dvi_itinerary_route_details` as the primary day envelope.
- It converts times to absolute seconds to avoid overnight wrap bugs.
- It checks route-end overflow before placing hotspot visits.
- It checks hotspot opening/closing windows using `dvi_hotspot_timing`.
- It waits until opening time if the hotspot opens later and still fits.
- It applies last-route departure buffer logic using `trip_end_date_and_time` and `departure_type`.
- It applies hotel arrival branching using `evaluateArrivalHotelPolicy()`.

Anchor insertion behavior:

- `ItineraryDetailsService.getItineraryDetails()` injects a placeholder segment with text `Click to Add Hotspot`.
- The helper `pushHotspotAnchorPlaceholder()` inserts these placeholders around travel legs.
- After segment sorting, placeholders are reinserted so the frontend gets stable hotspot insertion anchors instead of pure time-sorted rows.

## 4. Specification Expectations (FROM DOCX)

The DOCX expects a true smart-optimization engine with the following behaviors:

- Activity-first scheduling: activities are fixed appointments and the itinerary is built around them.
- Priority-first scheduling: priorities `1, 2, 3` are strict.
- Optional hotspots: priorities `4+` are for gap filling only.
- Strict time-fit rule: if a hotspot cannot fit fully, do not place it.
- Opening-hours enforcement: validate against opening time, closing time, visit duration, day availability, and travel buffer.
- Defer/skip logic: if a priority hotspot does not fit, defer to later slot or skip with explanation.
- Nearest-distance optimization: use nearest-neighbour or equivalent distance-aware routing for fillers.
- Slot-based planning: explicit morning slot (`08:00-14:00`) and evening slot (`16:00-20:00`) separated by gap time.
- Carry-forward logic: missed hotspots move to the next day and are reprocessed.
- Intercity logic: complete source-city work first, travel, then destination-city work if feasible.
- Via-route logic: treat via locations as explicit route nodes.
- Manual customization: add/remove/retime with system validation and full re-optimization.
- Warning levels: `Green`, `Yellow`, `Orange`, `Red`.
- Full re-optimization: any change should trigger a full solver pass.
- Persistence strategy: persist and reload a customized smart-itinerary JSON artifact.

## 5. GAP ANALYSIS TABLE

| Requirement | Expected (Doc) | Current Code | Status | Evidence | Gap | Fix |
| --- | --- | --- | --- | --- | --- | --- |
| Activity-first scheduling | Reserve activities first and build hotspot plan around them | Main builder never reads `dvi_itinerary_route_activity_details`; activities are added later by `ItinerariesService.addActivity()` | MISSING | `TimelineBuilder.buildTimelineForPlan()` schedules hotspots/hotels only; activity rows are handled after the fact in `ItinerariesService.addActivity()` | Primary engine ignores the strongest scheduling constraint | Add activity preload and slot reservation before hotspot selection |
| Priority-first scheduling (`1,2,3` strict) | Must preserve priority order globally | Selector buckets and sorts by priority, but scheduler is still route-local and opportunistic | PARTIAL | `timeline.hotspot-selector.ts` sorts by `hotspot_priority`; builder still places what fits in current pass | No strict guarantee that all `1,2,3` beat lower-priority fillers across the whole day | Introduce explicit priority-stage scheduler |
| Optional `4+` only for gap fill | Use low priorities only after strict priorities are placed | Current selection can include destination/source low-priority rows in normal candidate sets | PARTIAL | `HotspotSelector.selectForRoute()` merges full destination/source buckets, not only gap-fill leftovers | Filler hotspots can enter too early | Separate strict set and filler set |
| Strict time-fit rule | If it cannot fully fit, do not place | Builder rejects many overflow cases, but activity workflow extends hotspot windows and shifts downstream rows | PARTIAL | `ItinerariesService.addActivity()` updates `hotspot_end_time` and shifts subsequent rows instead of rejecting | System can absorb overflow instead of blocking impossible placements | Centralize a hard feasibility validator |
| Opening-hours enforcement | Always enforce opening/closing windows | Builder checks timings and can wait until opening; soft exceptions remain | PARTIAL | `TimelineBuilder.checkHotspotOperatingHoursFromMap()` path is active, but contains tolerance/softening branches | Enforcement is not uniformly hard and not activity-aware | Move to a single validator shared by all scheduling actions |
| Defer/skip logic | Defer strict priorities to next slot/day with explanation | Same-pass deferral exists for must-visit hotspots only | PARTIAL | `queueDeferredMustVisitHotspot()` only defers on `pass === 1` | No full cross-slot and cross-day defer strategy | Add deferred queue with slot/day state |
| Nearest-distance optimization | Use distance-aware scoring or greedy optimization | Uses travel-time/distance helpers and distance tie-breaks, not a formal optimizer | PARTIAL | `DistanceHelper`, `hotspot_distance`, and distance tie-breaks exist; no solver/scoring engine exists | No globally optimized visit order | Add optimizer module with explicit score function |
| Slot-based planning | Morning/evening slots with lunch/closure gap | Continuous route timeline only | MISSING | `getDayTimeSlot()` exists, but slot planning does not drive `buildTimelineForPlan()` | Spec-defined slot model is absent | Add slot allocator before row creation |
| Carry-forward logic | Missed hotspots move to next day and re-run | Carry-forward structures exist, but comments explicitly disable full cross-day queue parity | PARTIAL | `carryForwardHotspots` exists, but builder comments say `no cross-day hotspot carry-forward queue` | Missed priorities are not systematically migrated day-to-day | Persist deferred queue by plan/day |
| Intercity logic | Source city -> travel -> destination city -> hotel | Route/day handling supports city movement and destination arrival limits | PARTIAL | Route logic, arrival/departure policies, and last-route terminal guard exist | Still not a full source/destination optimizer; sequencing is rule-driven | Add explicit intercity planner stage |
| Via-route logic | Via locations treated as route nodes in scheduling | Via-route rows are persisted and rendered; scheduling support is limited to bucket inclusion and travel rows | PARTIAL | `ViaRoutesEngine.rebuildViaRoutes()` and `ItineraryDetailsService` use `dvi_itinerary_via_route_details` | Via routing exists, but not as first-class optimization constraints | Promote via nodes into optimizer graph |
| Manual customization | Add/remove/move with validation and full re-optimization | Manual hotspot add/remove/preview exists; rebuild is localized/protected, not full optimization | PARTIAL | `addHotspot()`, `deleteHotspot()`, `previewAddHotspot()`, `smartPreviewActivity()` exist | Manual actions do not run a global solver with full explanation | Route edits through a smart engine and change reporter |
| Warning levels | Unified Green/Yellow/Orange/Red feasibility model | Rebuild warning severities exist only for hotspot rebuild summary | PARTIAL | `RebuildWarningSeverity` and `buildRebuildReport()` emit colors | No unified API-level feasibility result across hotspots, activities, hotels, and KM | Add reporter layer and return feasibility block |
| Full re-optimization | Any change triggers full optimization | Many changes trigger rebuild, but rebuild is hotspot-row reconstruction, not constraint solving | PARTIAL | `deleteHotspot()` and activity deletion call `rebuildRouteHotspots()` | Rebuild is not equivalent to smart re-optimization | Replace rebuild entrypoints with smart-engine entrypoint |
| Persistence strategy | Save/load smart itinerary JSON | Current persistence is normalized row storage; JSON snapshot strategy not present | PARTIAL | `dvi_itinerary_route_hotspot_details` and related tables persist rows; DOCX JSON object is not stored | No reusable smart-itinerary artifact keyed by route/day/timing | Add persistence adapter for JSON snapshot + change log |
| KM limit enforcement | KM cap should constrain planning | Current API computes warnings only | MISSING | `ItineraryDetailsService` sets `kmLimitWarning`; scheduling code does not reject based on KM | KM is observational, not enforced | Add KM validator in scheduler |
| Houseboat logic | Disable sightseeing and keep travel/check-in only | Builder suppresses sightseeing when hotel is detected as houseboat | PARTIAL | `forceNoSightseeingOnThisRoute = !!hotelInfoForRoute?.isHouseboat` | Implemented as heuristic suppression, not as an explicit domain rule with reporting | Add validator + explicit rule result |

## 6. DEEP GAP ANALYSIS (VERY IMPORTANT)

### A. Activity-first scheduling

Doc expectation:

- Activities are hard constraints.
- Activity slots must be reserved before hotspot placement.
- Hotspots must be placed around activities, not the other way around.

Current behavior:

- `TimelineBuilder.buildTimelineForPlan()` does not query `dvi_itinerary_route_activity_details`.
- Activities are added later through `ItinerariesService.addActivity()`.
- When an activity is added, the service can extend a hotspot window and shift downstream rows.

Why this is wrong:

- The strongest constraints are excluded from the primary scheduling pass.
- The engine can create a day that is feasible only until an activity is added later.
- This is post-facto timeline mutation, not activity-first planning.

Where to fix:

- New smart engine entrypoint before hotspot selection.
- Scheduler should preload activities from `dvi_itinerary_route_activity_details` and lock their time ranges.

Pseudo code:

```text
for each routeDay:
  activityBlocks = loadActivities(routeDay)
  reserve(activityBlocks)
  freeWindows = subtract(routeWindow, activityBlocks)
  schedulePriorityHotspotsInto(freeWindows)
  fillRemainingWithOptionalHotspots(freeWindows)
```

### B. Strict time-fit enforcement

Doc rule:

- If a hotspot cannot fit, do not place it.

Current behavior:

- The builder rejects many candidates that exceed route end or terminal deadlines.
- The builder can also wait until opening time if the hotspot still fits.
- The activity path can extend hotspot windows and shift subsequent rows instead of rejecting.
- Rebuild warnings report drops and shifts after rebuild.

Why this is wrong:

- The spec wants hard feasibility as the default rule.
- Current logic mixes hard rejection with post-placement repair and shift-forward behavior.
- That makes the system harder to reason about and weakens guarantees.

Where to enforce:

- One shared feasibility validator called by:
  - initial build
  - manual hotspot add
  - manual hotspot move
  - activity add
  - route time change

Must vs optional handling:

- `P1-P3`: if not feasible in current slot, defer first; if still infeasible, skip with high-severity warning.
- `P4+`: if not feasible, skip immediately unless explicitly promoted by user.

Pseudo code:

```text
if !fitsWindow(candidate, window):
  if candidate.priority in [1,2,3]:
    defer(candidate)
  else:
    skip(candidate)
```

### C. Priority-first scheduler

Doc expectation:

- `P1`, `P2`, `P3` are strict.
- `P4+` are gap fillers only.

Current behavior:

- `HotspotSelector` sorts by priority and route buckets.
- Day-1 and route-specific rules can change which buckets are examined.
- Builder then iterates candidates and places what fits.

Why current behavior is not enough:

- Bucket selection is not equivalent to a strict scheduler.
- Optional hotspots can still enter normal candidate sets too early.
- There is no explicit stage saying `finish all feasible strict priorities before optional fillers`.

Where to fix:

- New `PriorityScheduler` module under the smart engine.

Proposed scoring / sorting logic:

```text
strictCandidates = hotspots where priority in [1,2,3]
fillerCandidates = hotspots where priority >= 4

schedule(strictCandidates ordered by priority asc, fit desc)
schedule(fillerCandidates ordered by score desc)
```

### D. Nearest-distance optimizer

Current limitation:

- Distance is used as helper data and as a tie-breaker.
- There is no explicit TSP-style or greedy-next-stop optimizer module.
- There is no documented global objective function.

Why that matters:

- A route can be feasible but still poor.
- The DOCX explicitly expects distance-aware filling after strict priorities.

Proposed scoring model:

```text
score =
  priorityWeight
  + distanceWeight
  + timeFitWeight
  + openingWindowWeight
```

Recommended interpretation:

- `priorityWeight`: dominant for `P1-P3`
- `distanceWeight`: dominant for `P4+`
- `timeFitWeight`: penalize tight or impossible insertions
- `openingWindowWeight`: reward candidates with stable operating windows

### E. Slot-based engine

Doc expectation:

- Morning slot: `08:00-14:00`
- Evening slot: `16:00-20:00`
- Midday gap handles lunch, closure windows, and travel buffer.

Current behavior:

- Time is scheduled continuously from route start to route end.
- Helper methods for slot naming exist, but slot boundaries do not drive actual scheduling.

Why this is wrong:

- The DOCX planning model is slot-based, not continuous only.
- Without slots, defer rules and filler logic become weaker and less explainable.

Where to fix:

- Add `SlotPlanner` that produces windows before hotspot placement.

Pseudo code:

```text
slots = [
  { type: MORNING, start: 08:00, end: 14:00 },
  { type: EVENING, start: 16:00, end: 20:00 }
]

for each slot:
  schedule strict priorities
  then fillers
```

### F. Carry-forward logic

Doc expectation:

- Missed hotspots move to the next day.
- The next day should retry them using the same rules.

Current behavior:

- `queueDeferredMustVisitHotspot()` supports same-pass deferral for must-visit items.
- `carryForwardHotspots` exists in `TimelineBuilder`.
- Builder comments also state that full cross-day carry-forward is not currently active.

Why this is only partial:

- The engine contains scaffolding, not a durable day-to-day deferred queue.
- There is no persisted `deferred -> next day -> retried -> resolved` lifecycle.

Where to fix:

- Persist deferred items with day/slot metadata.
- Feed them back into the next route-day before normal optional fillers.

### G. Warning system

Required by doc:

- `Green`: no impact
- `Yellow`: optional hotspots moved
- `Orange`: priority shifted
- `Red`: priority lost or blocked

Current behavior:

- `buildRebuildReport()` already emits `green/yellow/orange/red` severities.
- That warning system is limited to hotspot rebuild summary output.
- Activity preview returns warning arrays, but not the DOCX feasibility contract.

Why this is incomplete:

- There is no single user-facing `feasibility` object.
- There is no normalized warning model covering hotspots, activities, hotels, KM, and manual edits together.

Proposed API format:

```json
{
  "warnings": [
    {
      "code": "HOTSPOT_DROPPED",
      "severity": "RED",
      "message": "1 priority hotspot was dropped"
    }
  ],
  "feasibility": {
    "status": "RED"
  }
}
```

### H. Manual add/remove re-optimization

Current behavior:

- Manual hotspot APIs exist.
- Manual hotspots are protected during rebuild.
- Preview flows exist for hotspot movement and activity insertion.
- Localized rebuild logic can drop lower-priority hotspots to fit a fixed manual hotspot.

What is missing:

- Full-plan re-optimization after every manual edit.
- Unified explanation of what changed and why.
- Activity/hotel/via/KM-aware recomputation under one solver.

Current state summary:

- Current system = `preview + localized rebuild + protected manual persistence`
- Required system = `manual edit -> full optimizer -> validated result + changes + feasibility`

### I. KM limit enforcement

Current behavior:

- `ItineraryDetailsService` computes `kmLimitWarning`.
- That warning is based on travelled KM versus allowed KM.
- Scheduling does not stop or penalize itinerary generation when KM is exceeded.

Why this is wrong:

- The DOCX expectation is that constraints shape planning, not just reporting.
- A route can be returned as valid even when KM policy is already broken.

Where to fix:

- Add `KmValidator` during route-day scheduling and final feasibility evaluation.

### J. Houseboat logic

Expected behavior:

- Disable sightseeing.
- Keep only travel and check-in style behavior.

Current behavior:

- `TimelineBuilder` sets `forceNoSightseeingOnThisRoute = !!hotelInfoForRoute?.isHouseboat`.
- `isHouseboat` is derived from hotel/category text in `getHotelDetailsForRoute()`.

Assessment:

- This is partially implemented.
- The business rule exists, but detection is heuristic and reporting is limited.

What to improve:

- Add explicit houseboat domain flag in hotel persistence.
- Emit an explicit rule result in warnings/feasibility.

### K. Persistence strategy

Doc expectation:

- Persist a JSON smart-itinerary artifact.
- Reload it when route/day/timing match.

Current behavior:

- Persistence is table-driven:
  - route header in `dvi_itinerary_route_details`
  - timeline rows in `dvi_itinerary_route_hotspot_details`
  - activity overlays in `dvi_itinerary_route_activity_details`
  - hotel rows in `dvi_itinerary_plan_hotel_details`
  - via-route rows in `dvi_itinerary_via_route_details`
- This does persist itinerary state, but not as the DOCX JSON model.

Clarification:

- Yes, the DB is acting as persistence today.
- No, it is not acting as the DOCX-defined smart-itinerary persistence layer.

## 7. TARGET ARCHITECTURE

Recommended module layout:

```text
src/modules/itineraries/engines/
  smart-itinerary-engine.service.ts
  schedulers/
    activity-first.scheduler.ts
    priority.scheduler.ts
    slot.scheduler.ts
  validators/
    time-fit.validator.ts
    opening-hours.validator.ts
    km.validator.ts
    hotel-policy.validator.ts
  optimizers/
    nearest-neighbour.optimizer.ts
    route-score.optimizer.ts
  reporters/
    feasibility.reporter.ts
    change-reporter.ts
  persistence/
    smart-itinerary.persistence.ts
    smart-itinerary.snapshot.mapper.ts
```

Module responsibilities:

- `smart-itinerary-engine.service.ts`
  Single entrypoint for build, rebuild, preview, and apply.
- `activity-first.scheduler.ts`
  Loads and locks activities before hotspot placement.
- `priority.scheduler.ts`
  Schedules `P1-P3` first, then fillers.
- `slot.scheduler.ts`
  Converts route day into scheduling windows.
- `time-fit.validator.ts`
  Hard feasibility checks.
- `opening-hours.validator.ts`
  Unified timing and opening-window validation.
- `km.validator.ts`
  Enforces KM policy.
- `hotel-policy.validator.ts`
  Encapsulates arrival, late-arrival, houseboat, and hotel-first/hotel-last branching.
- `nearest-neighbour.optimizer.ts`
  Local greedy selection for optional candidates.
- `route-score.optimizer.ts`
  Multi-factor scoring.
- `feasibility.reporter.ts`
  Produces Green/Yellow/Orange/Red response.
- `change-reporter.ts`
  Produces added/removed/shifted/deferred/skipped diffs.
- `smart-itinerary.persistence.ts`
  Persists JSON snapshot plus normalized row projections.
- `smart-itinerary.snapshot.mapper.ts`
  Maps solver output to DB rows and API DTOs.

## 8. PROPOSED ALGORITHM

```text
generateSmartItinerary(input):
  1. load constraints
  2. place activities first
  3. schedule P1, P2, P3
  4. defer if needed
  5. fill gaps with nearest P4+
  6. validate time
  7. validate opening hours
  8. validate KM
  9. build warnings
  10. persist
  11. return segments
```

Expanded pseudo code:

```text
loadPlan(planId)
loadRoutes(planId)
loadHotspots(routeDays)
loadActivities(routeDays)
loadHotels(planId)
loadViaRoutes(planId)

for each routeDay:
  windows = buildDaySlots(routeDay)
  reserveActivities(windows, routeDay.activities)

  strict = sortByPriority(routeDay.hotspots where priority in [1,2,3])
  optional = scoreByDistance(routeDay.hotspots where priority >= 4)

  place(strict, windows)
  deferUnplacedStrict(routeDay)
  fill(optional, windows)

  validateRouteDayTime(routeDay)
  validateOpeningHours(routeDay)
  validateKm(routeDay)

report = buildWarningsAndChanges(allRouteDays)
snapshot = persistSnapshot(planId, allRouteDays, report)
rows = persistOperationalRows(planId, allRouteDays)
return buildApiResponse(snapshot, rows, report)
```

## 9. DB MAPPING

- `dvi_itinerary_plan_details`
  Plan-level header. Holds quote ID, arrival/departure, trip timing, party size, and itinerary preference.
- `dvi_itinerary_route_details`
  Day/route envelope. Holds route date, route start/end time, source, destination, and excluded hotspot IDs.
- `dvi_itinerary_route_hotspot_details`
  Operational timeline rows. Holds item type, order, hotspot linkage, travel distance, start/end time, and conflict/manual flags.
- `dvi_hotspot_place`
  Hotspot master. Holds location, duration, coordinates, and priority.
- `dvi_hotspot_timing`
  Operating-hours master for hotspot/day validation.
- `dvi_itinerary_route_activity_details`
  Activity overlay rows tied to hotspot windows. Current engine treats this as an add-on, not primary input.
- `dvi_itinerary_plan_hotel_details`
  Hotel recommendation/selection persistence. Also used by arrival-day billing and hotel policy logic.
- `dvi_itinerary_via_route_details`
  Persisted via nodes for route travel chain and response output.

## 10. API RESPONSE DESIGN

Recommended response contract:

```json
{
  "segments": [],
  "warnings": [],
  "changes": {
    "added": [],
    "removed": [],
    "shifted": [],
    "deferred": [],
    "skipped": []
  },
  "feasibility": {
    "status": "GREEN|YELLOW|ORANGE|RED"
  }
}
```

Why this is needed:

- Current APIs return useful but fragmented data.
- The next developer and AI agents need one stable response that separates timeline, warnings, and change explanation.

## 11. MIGRATION PLAN

Phase 1 -> strict time validation

- Add shared hard-feasibility validator.
- Remove post-placement overflow acceptance for impossible insertions.

Phase 2 -> priority scheduler

- Separate strict priorities from optional fillers.
- Enforce `P1-P3` before any `P4+` gap fill.

Phase 3 -> activity-first

- Load `dvi_itinerary_route_activity_details` before hotspot scheduling.
- Convert activities into locked windows.

Phase 4 -> optimizer

- Add explicit route scoring and nearest-neighbour optimizer.
- Promote via routes and intercity nodes into the route graph.

Phase 5 -> warnings

- Unify rebuild, activity, KM, hotel, and feasibility warnings.
- Expose `GREEN|YELLOW|ORANGE|RED` at API level.

Phase 6 -> persistence

- Add smart-itinerary JSON snapshot storage.
- Keep normalized row persistence for current downstream compatibility.

## 12. TEST PLAN

Real test cases that should exist before rollout:

- Closed hotspot
  A hotspot is closed on the selected day. Expected: do not place; defer or skip with warning.
- Must-visit conflict
  Two `P1` hotspots cannot both fit. Expected: defer logic, explicit Red/Orange reporting.
- Activity overlap
  Add a fixed-time activity that overlaps a hotspot window. Expected: solver rebuilds around activity or rejects.
- Departure after 4 PM
  Same arrival and departure city with late departure. Expected: last day planning respects terminal deadline and buffer.
- Hotel near/far
  Arrival-day hotel-first/hotel-last branching based on hotel distance and arrival policy.
- KM overflow
  Route exceeds allowed KM. Expected: planner blocks or downgrades feasibility, not warning only.
- Manual add/remove
  Add and remove hotspot, then confirm returned changes and feasibility report are correct.
- Houseboat day
  Houseboat route suppresses sightseeing and keeps only travel/check-in style output.
- Via-route day
  Source -> via -> destination route preserves via node in optimization and response.
- Carry-forward
  Day 1 missed `P1` hotspot must be retried before Day 2 fillers.

Use quote `DVI202604247` as a baseline regression case because it currently has:

- 3 routes
- 31 hotspot rows
- 0 activities
- 0 hotels
- 0 via routes

That makes it useful as a clean hotspot-only rebuild baseline before adding activity/hotel/via scenarios.

## 13. DEVELOPER NOTES

For each major gap, recommended implementation surface:

- Activity-first scheduling
  Implement in new `smart-itinerary-engine.service.ts` and `activity-first.scheduler.ts`.
  Avoid breaking current `ItinerariesService.addActivity()` callers until the new engine is wired in.
  Suggested function names: `loadRouteActivities()`, `reserveActivityWindows()`, `buildFreeWindows()`.

- Strict time validation
  Implement in `validators/time-fit.validator.ts`.
  Avoid duplicating time checks across builder, activity service, and preview service.
  Suggested function names: `canPlaceCandidate()`, `rejectOrDeferCandidate()`.

- Priority scheduler
  Implement in `schedulers/priority.scheduler.ts`.
  Avoid reusing route bucket rules as a substitute for strict scheduling.
  Suggested function names: `scheduleStrictPriorities()`, `scheduleOptionalFillers()`.

- Distance optimizer
  Implement in `optimizers/route-score.optimizer.ts` and `optimizers/nearest-neighbour.optimizer.ts`.
  Avoid embedding scoring logic directly inside `TimelineBuilder`.
  Suggested function names: `scoreCandidate()`, `pickNextNearestOptional()`.

- Slot planning
  Implement in `schedulers/slot.scheduler.ts`.
  Avoid continuous-time-only logic for all future work.
  Suggested function names: `buildDaySlots()`, `splitAroundLunchAndClosures()`.

- Carry-forward
  Implement in `persistence/smart-itinerary.persistence.ts` plus scheduler integration.
  Avoid ephemeral in-memory-only deferred lists.
  Suggested function names: `persistDeferredHotspots()`, `loadDeferredHotspotsForRouteDay()`.

- Warning system
  Implement in `reporters/feasibility.reporter.ts` and `reporters/change-reporter.ts`.
  Avoid returning separate ad-hoc warning arrays per feature.
  Suggested function names: `buildFeasibilityStatus()`, `buildChangeSet()`.

- Manual customization
  Keep current endpoints, but route them into the smart engine.
  Avoid direct row mutation followed by narrow rebuild as the final architecture.
  Suggested function names: `applyManualHotspotAddition()`, `applyManualHotspotRemoval()`, `applyManualMove()`.

- KM enforcement
  Implement in `validators/km.validator.ts`.
  Avoid keeping KM as read-only reporting logic in `ItineraryDetailsService`.
  Suggested function names: `validateKmBudget()`, `computeKmPenalty()`.

- Houseboat logic
  Move detection to explicit hotel metadata instead of regex-only detection.
  Suggested function names: `isHouseboatStay()`, `applyHouseboatSuppression()`.

- Persistence strategy
  Add DTOs for smart-engine persistence.
  Suggested DTOs:
  - `SmartItinerarySnapshotDto`
  - `SmartItineraryWarningDto`
  - `SmartItineraryChangeSetDto`
  - `SmartItineraryFeasibilityDto`
  - `SmartItinerarySegmentDto`

What to avoid breaking:

- Current row persistence to `dvi_itinerary_route_hotspot_details`
- Current frontend segment expectations from `ItineraryDetailsService`
- Current manual hotspot APIs
- Current activity add/delete APIs until the new engine fully replaces them
- Current arrival-hotel policy behavior unless intentionally migrated into a validator layer

Final architectural position:

- Keep the existing builder and response mapper as compatibility layers during migration.
- Do not keep adding smart-optimization rules directly into `TimelineBuilder`.
- Introduce a new smart engine above the current builder, then gradually reduce the builder to a row projection layer.