# Objective

Implement parity patches so React + NestJS itinerary details behavior matches legacy PHP rules used in:
- itinerary-details-files-php/ajax_latest_itineary_step2_form.php
- itinerary-details-files-php/itineary_latest_clipboard.php

Do this without changing project architecture.

# Non-Negotiable Constraints

- Preserve existing module/component structure.
- Apply incremental safe patches only.
- Do not break unrelated itinerary, hotel, vehicle, or confirmed flows.
- Keep endpoint contracts backward compatible.
- If a rule is still ambiguous after code comparison (for example aggregate qty semantics), mark it explicitly as Ambiguous and gate with feature flag/logging.

# Primary Files To Modify

Backend:
- api.dvi.travel/src/modules/itineraries/itinerary-details.service.ts
- api.dvi.travel/src/modules/itineraries/itineraries.controller.ts (only if minimal request validation is needed)

Frontend:
- dvi_frontend/src/pages/ItineraryDetails.tsx
- dvi_frontend/src/services/itinerary.ts (only if query behavior changes)

Legacy references:
- itinerary-details-files-php/ajax_latest_itineary_step2_form.php
- itinerary-details-files-php/itineary_latest_clipboard.php

# Required Behavior Fixes

1) Cost parity layer in backend
- Add a dedicated internal calculator in itinerary-details.service.ts that reproduces legacy cost flow order:
  - base itinerary gross + guide charges using helper-equivalent aggregates:
    - hotspot = SUM(hotspot_amout)
    - activity = SUM(activity_amout)
    - hotel = SUM(total_hotel_cost) + SUM(total_hotel_tax_amount) filtered by group_type
    - vehicle = SUM(vehicle_grand_total) with assigned filters, then qty application per legacy behavior
    - guide charges = SUM(guide_cost)
  - agent margin with gst_type branching
  - incident_count gating before applying margin/GST (as in legacy clipboard logic)
  - hotel margin aggregation by group type
  - assigned-vehicle margin aggregation
  - itinerary margin discount application
- Keep current response fields; add optional diagnostic fields only if needed.

2) Remove hardcoded additional margin assumptions
- Current service block uses fixed percentage/day-limit constants.
- Replace with authoritative source (DB/global settings) or gate with explicit fallback and warning logs.

3) Fix duplicate vehicle KM semantics
- Replace Math.max based duplicate merge for route KM rows with deterministic grouped logic matching legacy intent.
- Add tests for duplicate-row plans.

4) Preserve and verify item_type timeline semantics
- Keep explicit item_type handling (1/2/3/4/5/6/7).
- Ensure sort/tie behavior does not alter expected travel-attraction chronology for legacy sample plans.

5) Keep groupType behavior stable
- Maintain default draft group_type=1 behavior when groupType query is absent.
- Ensure groupType change in frontend refetches details safely without breaking hotel selection state.

# Implementation Steps

Step A. Add parity calculator function
- In itinerary-details.service.ts create a private method, example name: buildLegacyParityCostBreakdown(planId, groupType).
- This method should isolate formulas and return a structured object used to build costBreakdown.

Step B. Add trace logs for validation mode
- Add compact logs behind a debug flag for:
  - base amounts
  - gst branch selected
  - margin totals
  - margin discount applied
  - final net payable

Step C. Replace KM duplicate merge logic
- Refactor route KM aggregation to deterministic grouping and explicit sum/selection rule.
- Add comments documenting rationale and expected DB shape.

Step D. Add regression tests
- Add service-level tests for:
  - gst_type inclusive/exclusive branch behavior
  - incident_count zero/non-zero branch behavior
  - margin discount application
  - duplicate KM rows
  - segment order stability for item_type transitions

Step E. Frontend compatibility checks
- Confirm ItineraryDetails.tsx renders existing fields unchanged.
- Avoid introducing required new frontend fields unless backend also provides defaults.

# Acceptance Criteria

- For a controlled sample of quote IDs, backend returns stable:
  - segment order
  - travel from/to/time ranges
  - costBreakdown totals
  - net payable
- No regressions in hotel tabs/groupType interactions.
- No regressions in delete/add hotspot/activity workflows.
- All remaining ambiguous rules are labeled Ambiguous in code comments and logs until validated.
- Any remaining formula ambiguity (especially vehicle qty multiplication interpretation) is labeled Ambiguous in code comments/logs until validated by sample quote diffs.

# Verified Legacy Helper Baseline

Use these verified helper definitions as the parity source of truth:
- getITINEARY_COST_DETAILS in itinerary-details-files-php/controller/core/sql_functions.php (total hotspot/activity/hotel/vehicle and gross total branches).
- getITINEARY_TOTAL_GUIDE_CHARGES_DETAILS in itinerary-details-files-php/controller/core/sql_functions.php (TOTAL_ITINEARY_GUIDE_CHARGES branch).

Implementation expectation:
- Do not use approximation-only formulas for these helper branches.
- Mirror legacy branch order first, then add guarded improvements only behind feature flags.

# Safety Checklist Before Merge

- Run TypeScript checks for backend and frontend.
- Run targeted tests for itinerary details service.
- Validate at least 3 sample quote IDs manually against legacy output snapshots.
- Ensure no changes to unrelated modules.
