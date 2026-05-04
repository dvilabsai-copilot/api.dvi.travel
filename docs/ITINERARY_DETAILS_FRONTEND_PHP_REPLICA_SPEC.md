# Itinerary Details Frontend PHP Replica Spec

## Goal
Replicate the legacy PHP itinerary-details user behavior in React while consuming:
- `GET /itineraries/details/:quoteId`
- `GET /itineraries/hotel_details/:quoteId`

This spec focuses on frontend parity for timeline rendering, cost display, and group-type behavior.

## PHP UX Source of Truth
Primary legacy page behavior comes from:
- `itinerary-details-files-php/ajax_latest_itineary_step2_form.php`
- `itinerary-details-files-php/itineary_latest_clipboard.php`

## React Target
Primary frontend files:
- `dvi_frontend/src/pages/ItineraryDetails.tsx`
- `dvi_frontend/src/services/itinerary.ts`

## Functional Parity Requirements

### 1. Data fetch and refresh behavior
- Initial load must fetch details for `:quoteId` and corresponding hotel options.
- Group-type tab changes must refetch details with `groupType` and refresh only dependent sections.
- Prevent stale data crossover between old and new group selection.

### 2. Timeline parity (day and segment rendering)
Render segments so output narrative matches PHP intent:
- start/day-start
- travel
- break/via-route logic
- hotspot attraction
- travel-to-hotel/checkin
- hotspot add CTA near tail flow where applicable
- return/end blocks

Maintain deterministic ordering when timestamps are equal.

### 3. Travel and time display parity
- Use backend-provided normalized ranges.
- Do not reorder on frontend in a way that conflicts with backend parity logic.
- Preserve visible from/to labels and distance details as shown in PHP narrative order.

### 4. Cost panel parity
Display cost components in the same business order as PHP-derived backend values:
1. Base component totals (hotel, vehicle, hotspot, activity, guide)
2. Margin/GST effects
3. Discount adjustments
4. Final payable

Frontend must not recompute business-critical totals independently.

### 5. Visibility rules
- Show rows only when value is meaningful, matching legacy visibility intent.
- Keep zero-value suppression consistent across tabs and refreshes.

### 6. Interaction safety
- Existing interactions (preview, hotspot/activity insert flows, modals) must remain functional.
- Parity changes must not break edit workflows.

## UI Contract Expectations

### Required details payload fields (logical)
- day/segment sequence ready for render
- per-segment type and narrative fields
- cost breakdown fields already finalized by backend
- stable identifiers for key list rendering

### Frontend responsibility boundary
- Format and present data
- Trigger correct refetches
- Avoid domain formula ownership

## Implementation Plan

### Step A: Harden fetch orchestration
In `ItineraryDetails.tsx`:
- centralize load flow by quote ID + group type
- cancel or ignore stale responses during rapid tab changes
- preserve UI state that should survive refetch

### Step B: Lock segment rendering map
- Maintain explicit map from segment type to component block.
- Keep fallback rendering for unknown types (safe no-crash placeholder).

### Step C: Cost rendering cleanup
- Render backend totals without frontend math overrides.
- Keep display formatting deterministic (currency, decimals, labels).

### Step D: Add frontend tests
Add tests for:
- group-type refetch behavior
- segment order stability in render
- zero-value visibility rules
- final payable rendering consistency

## Acceptance Criteria
- For same quote ID and group type, frontend sequence and totals match PHP-equivalent backend output.
- Group switching does not leak previous group totals or segments.
- No regressions in existing itinerary interactions.

## Validation Checklist
- [ ] Initial page load parity verified on sample quotes
- [ ] Group-type switching parity verified
- [ ] Segment chronology verified against backend response
- [ ] Cost section labels/order verified
- [ ] Existing modal and edit interactions regression-tested
