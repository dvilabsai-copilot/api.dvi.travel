# Manual Fit Here Exact Anchor Rules

## Purpose

This document exists only for debugging exact-anchor preview and confirm issues.

It describes the current backend contract for:

- stale anchor detection
- route-scoped preview simulation
- exact-anchor rescue boundaries
- when preview is allowed to confirm

Use this together with:

- [manual-hotspot-reorder-and-removal-rules.md](C:/wamp64/www/dvi_fullstack/api.dvi.travel/docs/manual-hotspot-reorder-and-removal-rules.md)

## Exact anchor means

Exact anchor is the literal UI gap the user clicked.

Examples:

- before first attraction
- after a specific attraction
- between attraction and downstream travel-to-hotel leg

The backend must try this literal gap first.

If that literal gap is no longer valid because the route changed, backend must reject the request as stale.

## Current anchor resolution contract

Anchor resolution now checks the requested payload against the active route rows using:

- `afterRouteHotspotId`
- `afterHotspotId`
- `beforeRouteHotspotId`
- `beforeHotspotId`
- current active adjacency on the route

For `AFTER_START`, backend also checks whether the current first active route hotspot still matches the requested first hotspot.

## Stale anchor behavior

If any of the following is true, the request is stale:

- requested `afterRouteHotspotId` is no longer active on the route
- requested `beforeRouteHotspotId` is no longer active on the route
- requested `afterHotspotId` is no longer active on the route
- requested `beforeHotspotId` is no longer active on the route
- requested exact gap is no longer adjacent on the route
- `AFTER_START` points to an old first hotspot

Backend response:

- HTTP `409`
- code: `MANUAL_FIT_HERE_ANCHOR_STALE`

Backend payload should include:

- `reasons`
- `currentRouteHotspots`

## Route-scoped preview rule

Exact-anchor preview must simulate the clicked route only.

Allowed inputs for preview rebuild:

- active hotspot rows of the clicked route
- same-route manual placeholders
- selected manual hotspot being inserted

Forbidden:

- importing hotspot rows from sibling routes
- importing hotspot rows from another day of the same itinerary
- rebuilding from hidden DB rows that were not part of the clicked route timeline

This rule prevents preview outputs that look logically possible in the whole itinerary but are wrong for the specific clicked day.

## Visible timeline only rescue rule

If the clicked route already has visible attraction rows, exact-anchor rescue must stay rooted in that source array.

Do not widen rescue by reading extra persisted route attractions from DB and mixing them into the candidate array.

Fallback to active-route DB candidates is allowed only when:

- exact-anchor mode is active
- candidate array is empty
- source exact timeline has zero attractions

## Confirmability rule

Preview may be confirmable only when the finalized preview timeline is the same authoritative timeline we are willing to save.

That means:

- no stale anchor
- selected hotspot preserved
- final operating-hours validation passed
- final route-end validation passed
- final removal set is explicit

Preview must not be confirmable when:

- selected hotspot is still closed at attempted time
- result depends on leaked hotspots from other routes
- exact anchor was stale and backend silently mapped to another gap

## Confirm trust-preview rule

If preview returned `canConfirm=true`, confirm must trust that stored finalized preview timeline when both are true:

- preview source fingerprint is unchanged
- stored finalized preview snapshot is still internally valid

Confirm must not recompute the day and fail with:

- `MANUAL_INSERT_NO_LOW_PRIORITY_REMOVAL_AVAILABLE`
- `MANUAL_INSERT_EXCEEDS_DAY_END`

unless the stored preview snapshot itself is corrupted or missing.

If preview source changed after preview:

- reject as stale
- do not silently save into a different gap

## Selected hotspot closing rule

If selected hotspot is still outside operating hours in the final candidate:

- `resultType = SELECTED_HOTSPOT_CLOSED_AT_ATTEMPTED_TIME`
- `canConfirm = false`

This remains true even if other internal preview metadata looked ready.

If selected hotspot is closed only because earlier same-route blockers pushed it too late, exact-anchor rescue must try upstream blocker removal first before keeping this final blocked state.

Current enforced rescue flow:

1. stay inside the clicked route-scoped attraction array
2. identify attractions before the selected hotspot
3. try nearest eligible blocker removal first
4. then try cumulative upstream blocker removals if needed
5. rebuild the selected hotspot and downstream sequence after each attempt
6. accept the first candidate that clears:
   - selected hotspot operating-hours conflict
   - route-end overflow
   - selected-opening conflict metadata

Current non-goal:

- removed blockers are not yet reinserted later in a second-pass gap search
- rescue currently prefers a stable selected-hotspot fit over deferred re-add attempts

## Debugging playbook

When a user says "preview is wrong", check these in order:

1. Dump current active route hotspot rows for the clicked route.
2. Compare them with payload `afterRouteHotspotId` and `beforeRouteHotspotId`.
3. Verify whether preview result contains any hotspot not present in the clicked route set.
4. Verify selected hotspot attempted visit time against operating hours.
5. Verify removed hotspot IDs are all from the same route-scoped source array.

## Known fixed cases

### Case A: stale route-hotspot gap on route 8171

Expected result:

- reject with `409 MANUAL_FIT_HERE_ANCHOR_STALE`

Not allowed:

- silently re-anchor to another gap
- generic fake success
- generic cannot-fit without explaining staleness

### Case B: route 8175 preview leaking Ramanatha and Agni

Ground truth route `8175` hotspot set:

- `28` Alagar Koyil & Palamuthircholai Murugan Temple
- `40` Pamban Bridge

Selected insert:

- `41` APJ Abdul Kalam National Memorial

Not allowed preview:

```text
Ramanatha -> Pamban -> APJ -> Agni -> Hotel
```

Why not allowed:

- `Ramanatha` and `Agni` are not part of the clicked route scope

Correct preview shape:

- some combination of `28`, `40`, `41`
- plus travel/hotel rows derived from that same route
- minus allowed removals if needed

### Case C: route 8154 exact-anchor selected-closing rescue for Munnar

Ground truth:

- selected hotspot `898 = Munnar`
- operating hours `08:00 AM - 10:00 AM`

Historical wrong result:

- preview still showed `Echo Point` or `Mattupetty Dam and Lake` before `Munnar`
- selected hotspot reached at `11:17 AM` or `12:17 PM`
- backend returned a final selected-closing block even though earlier blockers were removable

Correct behavior now:

- direct exact-anchor rescue removes eligible upstream blockers from the same clicked route
- selected hotspot is rebuilt earlier
- first travel leg is recalculated if the removed blocker used to be the first visible stop
- response becomes confirmable only if selected hotspot is now within operating hours

Verified fixed examples:

- `After Echo Point`:
  - remove `Echo Point`
  - `Munnar` moves to morning fit
- `After Mattupetty Dam and Lake`:
  - remove `Mattupetty Dam and Lake`
  - remove `Echo Point`
  - `Munnar` moves to morning fit

### Case D: preview-confirm mismatch on confirmable routes

Historical bug:

- preview showed confirmable finalized timeline
- confirm reran fit logic
- confirm failed with route-end or removal-plan errors

Correct behavior now:

- confirm reuses trusted finalized preview snapshot
- confirm succeeds when route fingerprint is unchanged

Live replays that passed:

- plan `9825`, route `8154`, selected hotspot `898`, anchor `After Echo Point`
- plan `9822`, route `8119`, before-first-attraction sweep
- plan `9824`, route `8140`, before-first-attraction sweep

## Regression script

Preview-only:

```bash
npm run verify:manual-fit:sweep
```

Preview-plus-confirm:

```bash
npm run verify:manual-fit:sweep:confirm
```

This script intentionally records:

- stale-anchor `409`
- selected-closed preview outcomes
- confirm `409`
- confirm success rate for `canConfirm=true`
