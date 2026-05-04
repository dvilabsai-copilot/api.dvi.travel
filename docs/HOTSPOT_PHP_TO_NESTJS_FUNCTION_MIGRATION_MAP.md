# Hotspot PHP -> NestJS Function Migration Map (No-Diff Execution Plan)

## Purpose
This document is the execution companion to the parity blueprint.
It maps legacy PHP hotspot lifecycle logic to concrete NestJS targets in the current api.dvi.travel codebase and breaks implementation into verifiable tickets.

## Reference docs
- HOTSPOT_LIFECYCLE_PHP_TO_NESTJS_PARITY_GUIDE.md
- ITINERARY_DETAILS_BACKEND_PHP_REPLICA_SPEC.md

## Source-of-truth PHP blocks
1. includeHotspotInItinerary(...) in controller/core/sql_functions.php (around line 15071)
2. getTravelLocationType(...) in controller/core/sql_functions.php (around line 7520)
3. containsViaRouteLocation(...) in controller/core/sql_functions.php (around line 15749)
4. containsLocation(...) in controller/core/sql_functions.php (around line 15771)
5. sortHotspots(...) in controller/core/sql_functions.php (around line 15919)
6. confirm_replace_hotspots handler in engine/ajax/ajax_latest_manage_itineary.php (around line 24059)
7. confirm_replace_hotspots_with_activity handler in engine/ajax/ajax_latest_manage_itineary.php (around line 25152)
8. proceed_with_suggested_order_itinerary_route_hotspot trigger in engine/ajax/ajax_latest_itineary_hotspot_distance_alert.php (around line 159)

## Existing NestJS targets in current repo
1. src/modules/itineraries/engines/itinerary-hotspots.engine.ts
2. src/modules/itineraries/engines/hotspot-engine.service.ts
3. src/modules/itineraries/engines/helpers/timeline.builder.ts
4. src/modules/itineraries/engines/helpers/timeline.hotspot-selector.ts
5. src/modules/itineraries/engines/helpers/timeline.operating-hours.ts
6. src/modules/itineraries/engines/helpers/parking-charge.builder.ts
7. src/modules/itineraries/utils/itinerary.utils.ts
8. src/modules/itineraries/itinerary-details.service.ts
9. src/modules/itineraries/itineraries.controller.ts

## Migration table (PHP block -> NestJS owner)

| PHP block | Parity responsibility | NestJS target file | Target method to implement/align | Must preserve |
|---|---|---|---|---|
| getTravelLocationType | local vs outstation travel mode | src/modules/itineraries/utils/itinerary.utils.ts | resolveTravelLocationType(previousLocation, hotspotLocation) | token normalization + same branch choice |
| containsLocation | source/destination token matching | src/modules/itineraries/engines/helpers/timeline.hotspot-selector.ts | containsLocationTokenized(hotspotLocation, target) | trim/lowercase + exact token semantics |
| containsViaRouteLocation | via-route index matching | src/modules/itineraries/engines/helpers/timeline.hotspot-selector.ts | findViaRouteIndex(hotspotLocation, viaRouteNames) | first-match index by via order |
| sortHotspots | candidate ordering comparator | src/modules/itineraries/engines/helpers/timeline.hotspot-selector.ts | sortHotspotCandidates(candidates) | priority zero rule + distance tie-break |
| includeHotspotInItinerary | full include engine (travel/break/visit/cost writes) | src/modules/itineraries/engines/helpers/timeline.builder.ts | includeCandidateWithParity(tx, state, context, candidate) | write order, checks, cursor updates |
| confirm_replace_hotspots | delete cascade + rebuild | src/modules/itineraries/engines/hotspot-engine.service.ts | replaceHotspotsAndRebuild(input) | scoped deletes + same rebuild core |
| confirm_replace_hotspots_with_activity | activity-constrained replace | src/modules/itineraries/engines/hotspot-engine.service.ts | replaceHotspotsWithActivityAndRebuild(input) | activity delete scope and rebuild parity |
| proceed_with_suggested_order... | full route rebuild trigger | src/modules/itineraries/engines/itinerary-hotspots.engine.ts | rebuildHotspots({ planId, routeId? }) alignment | same flow path as PHP suggested-order |
| timeline read ordering | deterministic output order | src/modules/itineraries/itinerary-details.service.ts | day segment assembler ordering | hotspot_order asc then item_type asc |

## Ticketized execution plan

## Ticket HN-01: Build context parity loader
### Owner
Backend core

### Files
1. src/modules/itineraries/engines/itinerary-hotspots.engine.ts
2. src/modules/itineraries/utils/itinerary.utils.ts

### Work
1. Build one context loader that resolves all first-build inputs:
   - route date/time, start anchor, via route names, traveller context, entry-ticket flags.
2. Emit dayOfWeekNumeric exactly matching PHP mapping.

### Acceptance criteria
1. Context snapshot for same plan/route matches PHP-resolved values.
2. Unit test covers source anchor and via anchor branches.

## Ticket HN-02: Candidate matching and grouping parity
### Owner
Timeline helper

### Files
1. src/modules/itineraries/engines/helpers/timeline.hotspot-selector.ts

### Work
1. Implement containsLocationTokenized.
2. Implement findViaRouteIndex.
3. Group candidates into source/via/destination collections.
4. Preserve via index order for flattening.

### Acceptance criteria
1. Unit tests for pipe-delimited token matching pass.
2. Via route index test verifies first matching index behavior.

## Ticket HN-03: Sorting comparator parity
### Owner
Timeline helper

### Files
1. src/modules/itineraries/engines/helpers/timeline.hotspot-selector.ts

### Work
1. Implement comparator identical to PHP sortHotspots semantics:
   - non-zero priority before zero
   - lower priority first
   - distance tie-break

### Acceptance criteria
1. Snapshot tests using fixed candidate fixtures match expected order.
2. Regression test for priority=0 behavior.

## Ticket HN-04: Include engine parity (core)
### Owner
Hotspot lifecycle engine

### Files
1. src/modules/itineraries/engines/helpers/timeline.builder.ts
2. src/modules/itineraries/engines/helpers/timeline.operating-hours.ts
3. src/modules/itineraries/engines/helpers/parking-charge.builder.ts

### Work
1. Build includeCandidateWithParity with explicit cursor state.
2. Perform checks in same order:
   - route end-time
   - operating hours
   - monotonic time
   - duplicate protections
3. Insert rows in same sequence:
   - item_type=3 travel
   - optional break row (allow_break_hours=1)
   - item_type=4 visit
   - entry-cost rows
   - parking rows

### Acceptance criteria
1. Insert sequence test validates exact row type order.
2. Rejection tests for operating-hour and route-end limits pass.
3. Cursor advancement test passes for multi-hotspot chain.

## Ticket HN-05: Replace flow parity
### Owner
Hotspot engine service

### Files
1. src/modules/itineraries/engines/hotspot-engine.service.ts

### Work
1. Implement replaceHotspotsAndRebuild input contract.
2. Implement delete cascade scoped to hotspot ID set:
   - activity rows
   - activity entry cost rows
   - parking rows
   - hotspot entry rows
   - hotspot timeline rows
3. Rebuild via same core include engine as first build.

### Acceptance criteria
1. Transaction rollback test ensures no partial state on failure.
2. Replace with N hotspot IDs preserves expected survivors + new hotspot.

## Ticket HN-06: Replace-with-activity parity
### Owner
Hotspot engine service

### Files
1. src/modules/itineraries/engines/hotspot-engine.service.ts

### Work
1. Add replace-with-activity variant with activity conflict handling.
2. Reuse same include engine.

### Acceptance criteria
1. Activity-constrained scenario reproduces PHP-equivalent timeline.
2. Dependent activity cost rows remain consistent.

## Ticket HN-07: Read-path ordering and response parity
### Owner
Itinerary details

### Files
1. src/modules/itineraries/itinerary-details.service.ts

### Work
1. Enforce timeline read order by hotspot_order, item_type.
2. Ensure segment assembler retains PHP narrative sequence.

### Acceptance criteria
1. Day timeline output order matches PHP fixture snapshots.
2. No random ordering under equal-time rows.

## Ticket HN-08: Parity harness and diff tooling
### Owner
QA + backend

### Files
1. src/modules/itineraries/test-rebuild.ts
2. src/modules/itineraries/debug-hotspots.ts

### Work
1. Add table-level diff command for five core tables.
2. Add API-level diff for GET /itineraries/details/:quoteId.
3. Store fixture baselines for first-build and replace-build scenarios.

### Acceptance criteria
1. Diff report is deterministic and CI-runnable.
2. Build fails if row-level or sequence-level diff exceeds zero tolerance.

## Explicit method contracts (recommended)
```ts
interface BuildHotspotTimelineInput {
  itineraryPlanId: number;
  itineraryRouteId: number;
  actorId: number;
  mode: 'initial-build' | 'suggested-order-build' | 'replace-build' | 'replace-with-activity-build';
  replace?: {
    deleteHotspotIds: number[];
    newHotspotId: number;
  };
}

interface BuildCursorState {
  hotspotOrder: number;
  travelStartTimeHms: string;
  currentLat: number;
  currentLng: number;
  previousLocation: string;
}
```

## Method call graph (target shape)
1. itineraries.controller -> itinerary service command endpoint
2. itinerary service -> hotspot-engine.service orchestrator
3. hotspot-engine.service -> timeline builder core include engine
4. timeline builder -> operating-hours helper + pricing writers
5. itinerary-details.service -> read assembled timeline ordered by hotspot_order/item_type

## Release gate checklist
1. First-build parity: pass
2. Replace parity: pass
3. Replace-with-activity parity: pass
4. Table-level diffs: zero
5. API-level diffs: zero for signed-off fixtures
6. Transaction rollback tests: pass

## Final sign-off criteria
Migration is complete only when:
1. no sequence diff,
2. no timing diff,
3. no dependent row lifecycle diff,
4. no pricing side-effect diff,
across approved fixture set.
