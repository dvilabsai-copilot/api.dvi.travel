# Hotspot Lifecycle PHP -> NestJS Parity Blueprint (Architect Edition)

## Why this document exists
This is the implementation-grade blueprint for converting hotspot timeline logic from legacy PHP into NestJS without behavior drift.

The goal is not "close enough".
The goal is output and side-effect equivalence for the same database state and the same request.

## Canonical PHP anchors
- Conflict and modal-driven replacement:
  - itinerary-details-files-php/engine/ajax/ajax_latest_itineary_hotspot_distance_alert.php
- Build/rebuild orchestration:
  - itinerary-details-files-php/engine/ajax/ajax_latest_manage_itineary.php
- Core include function (travel + break + sightseeing + costs):
  - itinerary-details-files-php/controller/core/sql_functions.php
- Timeline rendering read-order:
  - itinerary-details-files-php/ajax_latest_itineary_step2_form.php

## Scope and non-scope

### In scope
1. First-time hotspot timeline construction.
2. Rebuild on suggested-order acceptance.
3. Replace flow with delete-and-add.
4. Replace flow with activity constraints.
5. Materialized timeline rows and dependent cost rows.

### Not in scope
1. Frontend component styling.
2. Non-hotspot financial formulas outside hotspot/activity impact.

## Parity axioms
1. Same candidate set.
2. Same candidate order.
3. Same acceptance/rejection decisions.
4. Same row write sequence.
5. Same dependent-row lifecycle.
6. Same read ordering.

If any one axiom diverges, visible API output eventually diverges.

## Mental model (important)
PHP does not treat timeline as a computed view at response time.

PHP materializes a timeline into persistent rows in dvi_itinerary_route_hotspot_details, then UI and API read those rows in deterministic order.

Therefore, NestJS parity requires parity in write-time behavior, not only read-time formatting.

## First-time build explained from zero

### What "first-time build" means
First-time build is when a route-day hotspot timeline is constructed from route context and hotspot inventory, with no assumption that existing timeline rows are valid.

In PHP this can occur:
1. During initial itinerary route generation.
2. During full recalculation actions where prior timeline rows are cleared.
3. During suggested-order confirmation flow.

### Inputs required for first-time build

#### A. Build identity
1. itinerary_plan_ID
2. itinerary_route_ID
3. logged_user_id
4. build mode context (initial, suggested-order, full-recalc)

#### B. Route context
1. itinerary_route_date
2. route_start_time
3. route_end_time
4. start_location_id
5. direct_to_next_visiting_place flag
6. next_visiting_location
7. starting location item type context

#### C. Via route context
1. via route location IDs
2. resolved via route names in route order
3. via anchor latitude/longitude when applicable

#### D. Traveller and pricing context
1. entry_ticket_required
2. total_adult
3. total_children
4. total_infants
5. nationality
6. assigned vehicle list with counts

#### E. Candidate hotspot source data
1. hotspot_ID
2. hotspot_name
3. hotspot_location (pipe-separated tokens)
4. hotspot_latitude
5. hotspot_longitude
6. hotspot_duration
7. hotspot_priority
8. hotspot timing availability for day-of-week

### Derived runtime inputs
1. dayOfWeekNumeric from itinerary_route_date.
2. starting cursor time from route start or prior boundary row.
3. starting cursor coordinates from source/destination/via anchor.
4. initial hotspot_order based on starting boundary branch.

## Data structures used in first-time build

### Candidate object (explicit NestJS shape)
```ts
interface HotspotCandidate {
  hotspotId: number;
  name: string;
  locationTokensRaw: string; // pipe separated source field
  latitude: number;
  longitude: number;
  durationHms: string; // HH:mm:ss
  priority: number;
  distanceFromCurrentAnchorKm: number;
  previousLocationAssigned: string;
}
```

### Group collections
1. sourceLocationHotspots: HotspotCandidate[]
2. viaRouteHotspotsByIndex: Record<number, HotspotCandidate[]>
3. destinationHotspots: HotspotCandidate[]
4. orderedHotspots: HotspotCandidate[]

### Mutable insertion cursor (must be a single object)
```ts
interface BuildCursorState {
  hotspotOrder: number;
  travelStartTimeHms: string;
  currentLat: number;
  currentLng: number;
  previousLocation: string;
  lastInsertedHotspotId?: number;
}
```

### Why cursor centralization matters
If you mutate start time or previous location in scattered helpers, parity bugs appear in:
1. distance calculations,
2. travel type choice,
3. operating-hours windows,
4. next hotspot ordering side effects.

## Matching and classification rules

### Location token normalization
PHP behavior implies normalize by trim + lowercase. NestJS must mirror this exactly.

### containsLocation semantics
1. Split hotspot_location by pipe.
2. Normalize tokens.
3. Exact token match against normalized target location.

### containsViaRouteLocation semantics
1. Iterate via route names in route order.
2. Return first matching via index.
3. False means no via-route match.

### Grouping outcome
A candidate can enter source, via, destination groups based on token matches and flow branch.
Parity requires preserving PHP grouping intent for each action type.

## Sorting contract (do not improvise)

Within each group, sort by:
1. non-zero priority before zero priority,
2. ascending priority among non-zero,
3. distance tie-break.

Then flatten in group order dictated by route mode and via presence.

## First-time build algorithm (step-by-step)

### Phase 0: Bootstrap
1. Load route + plan context.
2. Resolve dayOfWeekNumeric.
3. Resolve entry-ticket and traveller context.
4. Resolve starting anchor and initial hotspot_order.

### Phase 1: Candidate collection
1. Query eligible hotspots for the route/day.
2. Attach preliminary distance from current anchor.
3. Build candidate objects.

### Phase 2: Candidate classification
1. Source match check.
2. Destination match check.
3. Via-route index check.
4. Populate group arrays/maps.

### Phase 3: Ordered candidate assembly
1. Sort source group.
2. Sort each via index bucket.
3. Sort destination group.
4. Flatten into orderedHotspots.
5. Assign previousLocationAssigned across final sequence.

### Phase 4: Materialization reset
In full rebuild mode:
1. Delete route hotspot rows for item_type IN (3,4).
2. Delete hotspot entry cost rows for route.
3. Delete activity rows when flow requires full regeneration.
4. Delete activity entry cost rows where coupled.
5. Delete hotspot parking rows.

All steps inside one DB transaction.

### Phase 5: Include loop (core)
For each candidate:
1. Determine travel location type (local/outstation).
2. Calculate distance + travel duration.
3. Compute travel end time.
4. Compute visit end time using hotspot duration.
5. Validate constraints:
   - does not exceed route end
   - operating hours available
   - monotonic time
6. If valid and not duplicate:
   - insert item_type=3 travel row
   - insert/update/delete break row (item_type=3, allow_break_hours=1) as needed
   - insert item_type=4 sightseeing row
   - insert traveller-wise hotspot entry rows when entry required
   - insert parking charges for assigned vehicles
   - advance cursor state

### Phase 6: Finalize
1. Ensure timeline reads are always SQL ordered by hotspot_order then item_type.
2. Return success or validation errors consistent with PHP behavior.

## Replace flows (difference from first-time build)

### Replace hotspots
Input:
1. delete_hotspot_ID[]
2. itinerary_plan_ID
3. itinerary_route_ID
4. new_hotspot_ID

Execution:
1. Delete dependent rows scoped to delete_hotspot_ID[].
2. Build candidate set = remaining hotspots + new hotspot.
3. Reuse exact same include engine as first-time build.

### Replace hotspots with activity
Same concept, but activity conflict resolution adds extra pruning and activity coupling checks before rebuilding.

## Row-level write contract

### Primary timeline table
dvi_itinerary_route_hotspot_details fields that impact parity:
1. itinerary_plan_ID
2. itinerary_route_ID
3. item_type
4. hotspot_order
5. hotspot_ID
6. hotspot_traveling_time
7. hotspot_travelling_distance
8. hotspot_start_time
9. hotspot_end_time
10. allow_break_hours
11. allow_via_route
12. via_location_name

### Dependent tables
1. dvi_itinerary_route_hotspot_entry_cost_details
2. dvi_itinerary_route_hotspot_parking_charge
3. dvi_itinerary_route_activity_details
4. dvi_itinerary_route_activity_entry_cost_details

## NestJS architecture recommendation

### Services
1. itinerary-hotspot-lifecycle.service.ts
2. itinerary-hotspot-candidate-builder.service.ts
3. itinerary-hotspot-include-engine.service.ts
4. itinerary-hotspot-pricing-writer.service.ts
5. itinerary-hotspot-repository.ts

### DTOs
```ts
type BuildMode = 'initial-build' | 'suggested-order-build' | 'replace-build' | 'replace-with-activity-build';

interface BuildHotspotTimelineInput {
  itineraryPlanId: number;
  itineraryRouteId: number;
  actorId: number;
  mode: BuildMode;
  replace?: {
    deleteHotspotIds: number[];
    newHotspotId: number;
  };
}

interface BuildContext {
  routeDate: string;
  dayOfWeekNumeric: number;
  routeStartTime: string;
  routeEndTime: string;
  directToNextVisitingPlace: boolean;
  startAnchor: {
    lat: number;
    lng: number;
    location: string;
    hotspotOrderStart: number;
  };
  traveller: {
    totalAdult: number;
    totalChildren: number;
    totalInfants: number;
    nationality: number;
    entryTicketRequired: boolean;
  };
}
```

## Core engine pseudocode (single source of truth)
```ts
async function buildHotspotTimeline(input: BuildHotspotTimelineInput): Promise<void> {
  await db.$transaction(async (tx) => {
    const context = await repo.loadBuildContext(tx, input);

    if (input.mode === 'replace-build' || input.mode === 'replace-with-activity-build') {
      await repo.deleteReplaceScopeDependents(tx, input);
    }

    const candidates = await candidateBuilder.collectAndOrderCandidates(tx, context, input);

    await repo.deleteRouteTimelineArtifactsForRebuild(tx, context, input.mode);

    const state = includeEngine.initializeCursor(context);

    for (const candidate of candidates) {
      await includeEngine.tryIncludeCandidate(tx, state, context, candidate);
    }
  });
}
```

## Constraint and decision matrix

### Candidate acceptance
Accept candidate only when all are true:
1. candidate visit end time <= route_end_time
2. operating hours function returns true
3. calculated end time >= current start time
4. duplicate protections pass

### Break row handling
1. If waiting gap exists between travel end and hotspot open slot:
   - upsert break row with allow_break_hours=1
2. If no waiting gap and break row exists:
   - delete break row

### Entry-cost row generation
1. Enabled only when entry_ticket_required=1
2. For each traveller type and traveller index
3. Use nationality branch for domestic vs foreign pricing
4. Persist per-traveller entry rows

## Error semantics to preserve
1. hotspot_operating_hours_not_available
2. exceeds_route_end_time
3. something_went_wrong

Do not collapse these into a generic error if parity workflows depend on client-side branching.

## Transaction boundaries and guarantees
One route-day rebuild should be one transaction.

Guarantees required:
1. No partial timeline rows.
2. No orphan dependent rows.
3. No mixed-old/mixed-new state if include loop fails mid-way.

## Known mismatch traps and mitigations

### Trap 1: Timezone leakage
Mitigation:
1. Use local time arithmetic for HH:mm:ss parity paths.
2. Do not parse into Date with timezone conversion unless normalized.

### Trap 2: Sorting drift
Mitigation:
1. Implement explicit comparator identical to PHP semantics.
2. Add comparator unit snapshots.

### Trap 3: Hidden duplicate behavior changes
Mitigation:
1. Preserve pre-insert duplicate checks from PHP behavior.
2. Keep duplicate scope consistent (plan, route, hotspot, item_type where applicable).

### Trap 4: Incorrect delete scope
Mitigation:
1. Write delete methods with strict where clauses.
2. Validate affected row counts in debug mode.

### Trap 5: Cursor mutation split across services
Mitigation:
1. Centralize cursor updates in include engine only.

## Validation harness (mandatory)

### Table-level parity checks
For each test quote/day, compare sorted rows across:
1. dvi_itinerary_route_hotspot_details
2. dvi_itinerary_route_hotspot_entry_cost_details
3. dvi_itinerary_route_hotspot_parking_charge
4. dvi_itinerary_route_activity_details
5. dvi_itinerary_route_activity_entry_cost_details

### API-level parity checks
Compare GET response fields:
1. segment ordering
2. travel time ranges
3. distances
4. hotspot blocks
5. totals impacted by hotspot/activity rows

### Scenario matrix
1. no via route + direct destination false
2. via route present + direct destination true
3. operating-hours rejection case
4. route-end-time rejection case
5. break-row insertion case
6. replace flow with multiple delete hotspots
7. replace-with-activity flow
8. entry ticket off
9. entry ticket on (domestic)
10. entry ticket on (foreign)

## Engineering rollout plan

### Sprint 1
1. Build helper parity functions.
2. Implement candidate builder + comparator tests.
3. Implement cursor state model.

### Sprint 2
1. Implement include engine and row writers.
2. Implement transaction-wrapped initial build.
3. Implement replace flows on top of same engine.

### Sprint 3
1. Add parity harness and golden fixtures.
2. Run differential validation against PHP.
3. Fix residual mismatches and lock snapshots.

## Definition of done
Conversion is done only when:
1. table-level parity passes for agreed fixtures,
2. API-level parity passes for same fixtures,
3. replace and first-build both pass,
4. no critical diff remains in sequence, timing, or costing.

## Quick checklist for implementers
1. Did you model first-time build inputs completely?
2. Did you preserve grouping and sorting rules exactly?
3. Did you centralize cursor state updates?
4. Did you keep travel/break/visit row semantics?
5. Did you preserve dependent delete and reinsert lifecycle?
6. Did you enforce transaction atomicity?
7. Did you prove no-diff with fixtures?
