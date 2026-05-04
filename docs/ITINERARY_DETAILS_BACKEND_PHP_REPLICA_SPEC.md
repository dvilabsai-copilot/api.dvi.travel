# Itinerary Details Backend PHP Replica Spec

## Goal
Replicate legacy PHP itinerary-details behavior in NestJS for:
- `GET /itineraries/details/:quoteId`

This document defines the backend parity contract, calculation order, hotspot lifecycle behavior, and a NestJS implementation blueprint to avoid behavior drift.

## PHP Source of Truth
Use these legacy files as canonical references:
- `itinerary-details-files-php/ajax_latest_itineary_step2_form.php`
- `itinerary-details-files-php/itineary_latest_clipboard.php`
- `itinerary-details-files-php/controller/core/sql_functions.php`

## Current NestJS Target
Primary files:
- `api.dvi.travel/src/modules/itineraries/itineraries.controller.ts`
- `api.dvi.travel/src/modules/itineraries/itinerary-details.service.ts`

## Parity Principle (Non-Negotiable)
For this endpoint, parity means:
- Same data source selection
- Same ordering rules
- Same guard conditions
- Same rounding and totals
- Same add/delete side effects on timeline artifacts

Any optimization is acceptable only if output and side effects remain identical for the same input state.

## Endpoint Contract
### Route
- `GET /itineraries/details/:quoteId`

### Inputs
- `quoteId` from path (required)
- `groupType` from query (optional)
  - Default behavior must mirror PHP default group type flow when absent.

### Output
Return the existing response shape currently consumed by frontend, while making formula behavior match PHP.
Do not break existing keys unless versioned.

## Required PHP-Parity Rules

### 1. Plan and route loading
- Resolve itinerary plan by quote ID.
- Load route/day timeline and preserve item type semantics.

### 2. Cost helper parity
Mirror helper semantics from `sql_functions.php`:
- `total_hotspot_amount` = `SUM(hotspot_amout)` from route hotspot table, active rows only.
- `total_activity_amout` = `SUM(activity_amout)` from route activity table, active rows only.
- `total_hotel_amount` = `SUM(total_hotel_cost) + SUM(total_hotel_tax_amount)` filtered by `group_type`.
- `total_vehicle_amount` = assigned vehicle aggregate with PHP-equivalent quantity treatment.
- `TOTAL_ITINEARY_GUIDE_CHARGES` = `SUM(guide_cost)` from guide table.

### 3. Gross to net flow order
Maintain order:
1. Compute itinerary gross total.
2. Add guide charges.
3. Apply agent margin branch by `agent_margin_gst_type`:
   - Inclusive GST branch.
   - Exclusive GST branch.
4. Respect `incident_count` gating behavior from legacy flow.
5. Compute hotel margin aggregate and vehicle margin aggregate.
6. Apply itinerary margin discount percentage.
7. Produce final payable values with PHP-equivalent rounding behavior.

### 4. Vehicle KM parity
- Replace non-deterministic duplicate handling with deterministic grouped logic aligned to PHP meaning.
- Avoid undercount risk from max-only merges if PHP expects additive treatment.

### 5. Segment ordering parity
- Keep chronology stable with deterministic tie-breaking.
- Ensure item type transitions match PHP narrative order for the same plan/day.

### 6. Hotspot lifecycle parity (critical)
Even though the endpoint is read-focused, parity requires matching how timeline rows were built in PHP:
- Hotspot timeline is materialized in `dvi_itinerary_route_hotspot_details`.
- UI and API read this table ordered by `hotspot_order`, then `item_type`.
- Hotspot replacement deletes and rebuilds multiple dependent tables, not only hotspot rows.
- Item type semantics must be preserved:
  - `item_type = 3` travel or waiting segment
  - `item_type = 4` hotspot visit segment

If NestJS rebuild logic diverges, `GET /itineraries/details/:quoteId` will show subtle timeline differences.

## Hotspot Build and Replace: Canonical PHP Sequence

### A. Trigger and conflict resolution
1. User attempts hotspot add.
2. PHP checks overlap/operating-hour conflicts.
3. Conflict modal presents "Yes, Delete and Add".
4. On confirm, PHP posts:
   - `delete_hotspot_ID[]`
   - `itinerary_plan_ID`
   - `itinerary_route_ID`
   - `new_hotspot_ID`

### B. Replace handler side effects
Handler: `ajax_latest_manage_itineary.php?type=confirm_replace_hotspots`

Actions in order:
1. Delete selected hotspot activities.
2. Delete selected hotspot activity entry costs.
3. Delete selected hotspot parking charges.
4. Delete selected hotspot entry costs.
5. Delete selected hotspot timeline rows.
6. Recompute candidate hotspot set = existing non-deleted + new hotspot.
7. Rebuild ordered hotspot timeline.
8. Reinsert dependent entry-cost and parking rows.

### C. Include-hotspot insertion contract
Core helper: `includeHotspotInItinerary(...)`

For each hotspot candidate, PHP does:
1. Compute travel type (local/outstation) from previous location.
2. Compute distance and travel duration.
3. Compute projected travel-end and visit-end time.
4. Validate:
   - route end-time constraint
   - hotspot operating-hour availability
   - time monotonicity (end >= start)
5. If valid and not already added:
   - Insert `item_type=3` travel row
   - Optionally insert/update `allow_break_hours=1` break row
   - Insert `item_type=4` hotspot visit row
   - Insert traveler-wise entry costs (if entry required)
   - Insert hotspot parking charges by assigned vehicles
6. Update "current cursor" for next hotspot:
   - current start time
   - current lat/lng
   - previous location

## Data Structures and Grouping Behavior

### In-memory structures used before DB materialization
PHP groups candidate hotspots into:
- source location group
- via-route matched group
- destination group

Then applies:
- `containsLocation(...)`
- `containsViaRouteLocation(...)` (returns via index order)
- `sortHotspots(...)` (priority-first, distance tie-break)
- previous-location assignment across groups

Only after this grouping/sorting does PHP write timeline rows.

### Persisted structures (must remain in sync)
- `dvi_itinerary_route_hotspot_details` (timeline core)
- `dvi_itinerary_route_activity_details`
- `dvi_itinerary_route_hotspot_entry_cost_details`
- `dvi_itinerary_route_activity_entry_cost_details`
- `dvi_itinerary_route_hotspot_parking_charge`

## NestJS Parity Architecture

### Recommended module boundaries
- `ItineraryDetailsReadService`
  - composes final response for `GET /itineraries/details/:quoteId`
- `ItineraryHotspotLifecycleService`
  - owns replace/rebuild semantics
- `ItineraryCostParityService`
  - owns gross/net and GST/margin logic
- `ItineraryParityRepository`
  - central query layer for parity-critical reads/writes

### Transaction policy
All hotspot replace/rebuild operations must run inside a single DB transaction:
1. delete dependent rows
2. rebuild hotspot timeline rows
3. rebuild derived rows (entry costs/parking)
4. commit

On failure, rollback everything. Partial writes will cause timeline diffs.

### Ordering contract in NestJS
Every timeline read used by itinerary details must order by:
1. `hotspot_order` ASC
2. `item_type` ASC

Do not replace this with application-level sort unless it is byte-equivalent.

## PHP-to-NestJS Function Mapping

| PHP concept | NestJS target method | Notes |
|---|---|---|
| `getTravelLocationType` | `resolveTravelLocationType(previous, current)` | Normalize location tokenization exactly as PHP |
| `containsLocation` | `containsLocationTokenized(hotspotLocation, target)` | Case/trim normalization required |
| `containsViaRouteLocation` | `findViaRouteIndex(hotspotLocation, viaRoute[])` | Return first ordered match index |
| `sortHotspots` | `sortHotspotCandidates(candidates)` | Preserve priority-zero behavior and distance tie-break |
| `includeHotspotInItinerary` | `includeHotspotCandidate(ctx, candidate, tx)` | Must own all checks + inserts |
| replace handler | `replaceHotspotsAndRebuild(input, tx)` | Delete cascade + rebuild flow |

## Implementation Skeleton (NestJS)

```ts
async replaceHotspotsAndRebuild(input: ReplaceHotspotsInput): Promise<void> {
  await this.db.$transaction(async (tx) => {
    await this.repo.deleteHotspotDependents(tx, input.planId, input.routeId, input.deleteHotspotIds);

    const ctx = await this.repo.loadRebuildContext(tx, input.planId, input.routeId, input.newHotspotId);
    const candidates = this.builder.buildOrderedCandidates(ctx);

    await this.repo.deleteRouteTimelineRows(tx, input.planId, input.routeId, [3, 4]);

    const state = this.builder.createInsertionState(ctx);
    for (const candidate of candidates) {
      await this.builder.includeHotspotCandidate(tx, state, candidate);
    }
  });
}
```

## Parity Guardrails Checklist

### Time and duration
- Keep all internal time arithmetic in `HH:mm:ss` semantics.
- Avoid implicit timezone conversions.
- Preserve same start/end inclusivity logic as PHP comparisons.

### Numeric and rounding
- Amounts should match PHP branch behavior before final rounding.
- Only round at equivalent stage used by PHP.

### Duplicate prevention
- Preserve "already added" checks before inserts.
- Do not dedupe in a way PHP does not do.

### Break rows
- Preserve `allow_break_hours` creation/update/delete behavior.
- Break row should remain `item_type=3` with same order semantics.

### Dependent table lifecycle
- Any deletion of hotspots must clean activity, entry-cost, and parking rows in same transaction.

## Validation Strategy (No-Diff Proof)

### Golden dataset approach
For selected quote IDs:
1. Capture PHP output snapshot for itinerary details.
2. Run NestJS output snapshot on same DB state.
3. Compare:
   - timeline sequence (`item_type`, `hotspot_order`, start/end)
   - per-day totals
   - grand totals and payable amounts

### SQL-level parity checks
After replace operation, compare table state between PHP-run and Nest-run for:
- `dvi_itinerary_route_hotspot_details`
- `dvi_itinerary_route_activity_details`
- `dvi_itinerary_route_hotspot_entry_cost_details`
- `dvi_itinerary_route_activity_entry_cost_details`
- `dvi_itinerary_route_hotspot_parking_charge`

### Recommended automated tests
- Unit tests for grouping/sorting helpers.
- Unit tests for time-window guard checks.
- Integration tests for replace flow transaction atomicity.
- Endpoint snapshot tests for `GET /itineraries/details/:quoteId`.

## Implementation Plan

## Implementation Plan

### Step A: Add dedicated parity calculator
In `itinerary-details.service.ts`, implement an isolated method such as:
- `buildPhpParityCostBreakdown(planId, groupType)`

This method should own all financial formulas and return typed intermediate values and final totals.

### Step B: Keep API shape stable
- Map parity outputs back to existing response fields.
- Add optional debug fields only behind a flag.

### Step C: Add validation logging
Behind a debug flag, log:
- component totals (hotel, vehicle, hotspot, activity, guide)
- selected GST branch
- margin components
- discount amount
- final rounded payable

### Step D: Add tests
Create service tests for:
- GST inclusive/exclusive branch parity
- incident_count gating
- vehicle quantity and duplicate KM behavior
- final payable rounding
- segment order stability
- hotspot replace/delete rebuild parity
- item type ordering parity (`3` then `4` per hotspot order)

## Acceptance Criteria
- Same quote ID and group type produce parity-aligned totals against PHP baseline.
- Segment sequence and travel narrative are stable for sampled plans.
- Hotspot replacement side effects match PHP across all dependent tables.
- No regression in existing frontend contract.

## Rollout Safety
- Keep behavior behind a parity feature flag until validated on sample quote IDs.
- Compare at least 3 representative plans (short trip, multi-day trip, high-activity trip).
- Remove flag only after parity sign-off.

## Deliverables Checklist
- [ ] Parity calculator method in service
- [ ] Endpoint uses parity outputs
- [ ] Hotspot lifecycle service mirrors PHP replace/rebuild flow
- [ ] Transactional delete+rebuild implementation
- [ ] Test suite for cost and ordering parity
- [ ] Debug comparison logs for PHP vs Nest outputs
- [ ] Validation report for sampled quote IDs
