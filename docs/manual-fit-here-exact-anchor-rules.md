# Manual Fit Here Exact Anchor Rules

## Purpose

This document defines the production rules for Manual Hotspot "Fit Here" exact-anchor preview and confirm.

Fit Here is not a global optimizer action. When a user clicks a specific gap in the itinerary, that clicked gap is authoritative.

## Core Rule

For exact-anchor Fit Here, the backend must insert the selected manual hotspot at the clicked anchor and rebuild the remaining itinerary sequentially in original route order.

The authoritative sequence is:

1. Keep all rows before the clicked anchor.
2. Insert selected manual hotspot at the clicked anchor.
3. Rebuild every existing hotspot after the anchor in original order.
4. For each next hotspot:
   - calculate travel from the previously kept stop
   - calculate attempted arrival time
   - calculate attempted end time
   - validate operating hours
   - validate route-end overflow
   - validate no overlap with previously kept rows
5. If the hotspot fits, keep it.
6. If the hotspot does not fit:
   - Priority 1 / Priority 2: stop with priority conflict; do not remove automatically
   - Priority 3: return as P3 conflict/removal candidate with proof
7. Removed or failed hotspot attempted time must come from the same sequential timeline where all previous kept hotspots are present.

## Example Rule

For this flow:

```txt
Meenakshi Temple
-> Dhanushkodi and Kothandarama Swamy Temple
-> Pamban Bridge
-> Ramanatha Swamy Temple / P2
-> Agni Teertham / P3
```

The backend must check:

1. Insert Dhanushkodi after Meenakshi.
2. Rebuild/check Pamban Bridge after Dhanushkodi.
3. Rebuild/check Ramanatha Swamy Temple after Pamban.
4. Rebuild/check Agni Teertham only after Ramanatha.

If Ramanatha is scheduled at:

```txt
5:23 PM - 6:23 PM
```

then Agni Teertham cannot be shown as:

```txt
5:42 PM - 6:12 PM
```

because that overlaps Ramanatha and comes from an invalid or stale simulation.

## Priority Rules

Priority 1 and Priority 2 are protected.

Priority 2 must be preserved before Priority 3 is tested.

Correct order:

```txt
Try/keep Pamban
-> try/keep Ramanatha/P2
-> then test Agni/P3
```

Priority 3 can only be marked removable after all previous higher-priority stops in the sequential rebuild have been tested and kept or validly failed.

## Removal Permission Rules

P3 removal and P1/P2 removal are separate.

```ts
allowP3Removal !== allowP1P2Removal
```

Rules:

- `allowP3Removal` may allow P3 removal candidate confirmation.
- `allowP1P2Removal` is the only flag that may allow protected P1/P2 removal exploration.
- `allowPriorityRemoval` must not be used as a broad permission because it may only mean a P3 hotspot exists in removed rows.
- P3 permission must never unlock P1/P2 removal.
- Preview mode must not unlock extra removal permissions.

## Attempted Time Rules

The attempted time displayed for a removed or failed hotspot must be evidence-based.

Do not show:

```txt
After insertion: X - Y
```

unless the time comes from the final exact-anchor sequential rebuild timeline.

If the time comes from an intermediate failed candidate, label it:

```txt
Attempted in failed simulation
```

Never show a removed hotspot attempted time that overlaps a kept hotspot.

## Reason Evidence Rules

A removed hotspot explanation must include structured proof.

Useful fields:

```ts
removalReasonCode
attemptedVisitTime
attemptedTimelineSource
isWithinOperatingHours
outsideOperatingMinutes
routeEndOverflowMinutes
routeEndOverflowBeforeRemoval
routeEndOverflowAfterRemoval
openingHourConflictCountBeforeRemoval
openingHourConflictCountAfterRemoval
removalImprovedFeasibility
```

Do not generate confident fallback text like:

```txt
The time is not the only issue...
```

unless route overflow or downstream conflict is numerically proven.

If no proof exists, use:

```txt
UNPROVEN_REMOVAL
```

and block confirmation for protected hotspots.

## Exact Anchor Strategy Rule

For exact-anchor Fit Here, the selected authoritative strategy must be:

```txt
exact_anchor_sequential_rebuild
```

These strategies must not become the selected authoritative exact-anchor result:

```txt
geo_nearest
opening_urgency
priority_then_opening
clicked_anchor_before
drop_p4_non_priority
```

They may be returned only as clearly labelled suggestions.

## Confirm Safety Rules

Confirm must use the removal policy saved in the preview cache.

Confirm must not upgrade permissions from the client payload.

Do not do this:

```ts
allowTopPriorityRemoval =
  entry.allowP3Removal === true ||
  entry.allowP1P2Removal === true ||
  payload.allowPriorityRemoval === true
```

Correct rule:

```ts
allowP3Removal = entry.allowP3Removal === true
allowP1P2Removal = entry.allowP1P2Removal === true
allowTopPriorityRemoval = entry.allowP1P2Removal === true
```

## Required Verification Cases

### Case 1 - No removal allowed

Payload:

```json
{
  "allowP3Removal": false,
  "allowP1P2Removal": false
}
```

Expected:

- No hotspot is marked removed.
- If P3 cannot fit, return conflict/needs approval, not removed.

### Case 2 - P3 removal allowed

Payload:

```json
{
  "allowP3Removal": true,
  "allowP1P2Removal": false
}
```

Expected:

- P2 is preserved if it fits.
- P3 is tested only after P2.
- P3 may be removed only with exact attempted time and proof.
- P1/P2 removal is not allowed.

### Case 3 - Ramanatha valid, Agni tested after it

If Ramanatha is:

```txt
5:23 PM - 6:23 PM
```

and Agni comes after Ramanatha, Agni attempted time must be after:

```txt
6:23 PM + Ramanatha to Agni travel time
```

### Case 4 - Stale timeline protection

Do not show:

```txt
Ramanatha: 5:23 PM - 6:23 PM
Agni: 5:42 PM - 6:12 PM
```

as if both belong to the same preview.

This must fail verification.

## Developer Checklist

Before merging any Fit Here logic change:

- [ ] Exact-anchor preview uses `exact_anchor_sequential_rebuild`.
- [ ] Original order after anchor is preserved.
- [ ] P2 is checked before P3.
- [ ] P3 attempted time is calculated after previous kept stop.
- [ ] No removed hotspot time overlaps a kept hotspot.
- [ ] P3 permission does not unlock P1/P2.
- [ ] Confirm uses cached preview policy.
- [ ] UI labels failed simulation time correctly.
- [ ] Backend build passes.
- [ ] Frontend build passes.
- [ ] The Dhanushkodi -> Pamban -> Ramanatha -> Agni replay passes.



**Plan**

1. Define one source of truth for manual fit.
   Create a single “patched timeline” result in backend for preview/apply. This object must contain:
   - exact clicked anchor
   - inserted hotspot
   - actually removed hotspot ids
   - final ordered timeline rows
   - confirm requirements
   Every UI section must read from this one result only.

2. Stop using optimizer-style rebuild for manual fit.
   In `Fit Here`, do not run broad reshuffle behavior after insertion/removal. Instead:
   - start from current visible route/day timeline
   - patch in the manual hotspot at the clicked gap
   - if needed, patch out only eligible non-manual hotspots
   - recalculate only sequential travel/times for remaining rows
   This keeps manual actions surgical.

3. Enforce strict removal rules.
   Backend removal logic should:
   - never remove manual hotspots
   - never remove selected hotspot
   - only try same-route non-manual hotspots
   - try them in configured priority order
   - stop once a valid fit is found
   - if no valid non-manual removal set works, then return cannot fit
   This matches what you asked earlier.

4. Make finalized preview timeline derive only from the patched result.
   The timeline shown in preview must be built from:
   - baseline current day rows
   - minus actual removed ids
   - plus inserted hotspot at clicked anchor
   - plus recomputed travel legs
   If `Alagar Koyil` is marked removed, it must not appear anywhere in finalized timeline.

5. Align confirm button and checkbox behavior with actual removals.
   Button state should come from the same patched result:
   - if confirmable and removals exist, show acknowledgement checkboxes
   - if no removals exist, no checkbox gating
   - if conflict-only, show conflict CTA only
   - never disable confirm because of hidden or missing acknowledgement requirements
   UI truth and backend truth must match.

6. Use the main timeline’s travel-time calculation engine, not preview-specific shortcuts.
   Preview travel legs should be generated using the same travel/distance logic as the main itinerary timeline. That means:
   - same source rows
   - same route matrix / duration logic
   - same waiting-time handling rules
   - same formatting rules
   This fixes the “2.5 hours in preview vs 5 hours in main timeline” issue.

7. Separate “manual remove” from “smart refill/reoptimize” in main timeline too.
   For the main day timeline:
   - manual delete should only delete that hotspot
   - do not auto-refill with other hotspots
   - do not reshuffle day unless a separate smart optimize action is invoked
   This keeps manual editing predictable.

8. Unify preview and apply.
   Confirm must save exactly the same patched timeline shown in preview:
   - same removed hotspots
   - same insertion position
   - same travel legs
   - same times
   Apply should not recompute a different version unless the source timeline changed after preview, in which case preview should be invalidated and recalculated.

9. Add safety validation.
   Before returning preview/apply result, backend should validate:
   - removed ids are absent from final timeline
   - selected hotspot is present if confirmable
   - timeline order is monotonic
   - no stale travel rows point to removed hotspots
   - confirm requirements exactly match removal set
   If validation fails, reject preview instead of showing mixed truth.

10. Update Playwright coverage around your real scenarios.
   Add tests for:
   - manual insert fits directly
   - manual insert fits after removing non-manual hotspot
   - removed hotspot disappears from finalized preview
   - confirm button enabled only when expected
   - checkbox shown when removal acknowledgement is required
   - preview and saved itinerary match
   - no reshuffle after manual remove
   - no reshuffle after manual insert except affected travel chain

**Implementation order I would follow**

1. Backend patched-timeline contract
2. Backend exact removal + no-reshuffle logic
3. Backend preview/apply unification
4. Frontend render only patched timeline
5. Frontend checkbox/confirm cleanup
6. Playwright scenarios for Gandhamadhana, Agni, Dhanushkodi, Ariyamaan

**Expected outcome**

After this change, `Fit Here` will behave like a precise manual editor:
- insert at exact gap
- remove only allowed non-manual hotspot if needed
- no hidden reshuffle
- preview matches apply
- confirm state is understandable and consistent

If you want, next I can start implementing this in the safest order with backend first.