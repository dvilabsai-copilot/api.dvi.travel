# IMPLEMENTATION_PLAN.md

## 1. Executive Summary
This plan stabilizes itinerary optimization behavior with minimum-risk, incremental changes on top of the existing architecture (controller -> service -> engine -> timeline builder), without endpoint churn or schema changes in early steps.

What this plan will fix:
- preview hotspot side-effect risk
- manual hotspot frontend/backend endpoint parity
- delete-activity rebuild gap
- priority and scoring semantics drift
- formal optimization flow: top priority 1/2/3 first, then nearest-distance chaining
- activity as blocking schedule items with reroute-first behavior
- morning/evening defer behavior consistency
- direct/via parity and recalculation trigger consistency
- multi-day carry-forward behavior

What will remain unchanged during initial stabilization:
- primary itinerary endpoint surface in [api.dvi.travel/src/modules/itineraries/itineraries.controller.ts](api.dvi.travel/src/modules/itineraries/itineraries.controller.ts)
- frontend page structure in [dvi_frontend/src/pages/ItineraryDetails.tsx](dvi_frontend/src/pages/ItineraryDetails.tsx)
- Prisma schema in [api.dvi.travel/prisma/schema.prisma](api.dvi.travel/prisma/schema.prisma) for Steps 1-9

Highest-risk bugs first:
1. Preview hotspot writes during preview flow
2. Activity delete without full re-optimization
3. Priority/scoring mismatch that can reorder business-critical hotspots

## 2. Confirmed Issues to Address

### P0 critical
- Preview add-hotspot path can persist temporary row in preview flow: [api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts](api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts)
- Delete activity does not force full timeline re-optimization: [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts)
- Priority/scoring semantics are inconsistent with intended business rule precedence: [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.scoring.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.scoring.ts), [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts)

### P1 important
- Frontend manual hotspot wrapper points to generic add endpoint instead of manual-hotspot endpoint: [dvi_frontend/src/services/itinerary.ts](dvi_frontend/src/services/itinerary.ts)
- Direct visit toggle behavior in create flow cannot restore Yes state: [dvi_frontend/src/pages/CreateItinerary/RouteDetailsBlock.tsx](dvi_frontend/src/pages/CreateItinerary/RouteDetailsBlock.tsx)
- Morning/evening defer behavior exists but is not formalized into clear, testable policy paths: [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts), [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.operating-hours.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.operating-hours.ts)
- Rebuild trigger consistency across user actions needs hardening in UI and service orchestration: [dvi_frontend/src/pages/ItineraryDetails.tsx](dvi_frontend/src/pages/ItineraryDetails.tsx), [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts)

### P2 enhancement
- Multi-day carry-forward behavior requires explicit policy and validation matrix despite partial implementation already present
- Reusable customization template persistence is absent and should be added only after parity stabilization

## 3. Exact File-Level Change Plan

| Order | Planned Change | Files to Modify | Type | Risk | Depends On |
|---|---|---|---|---|---|
| 1 | Preview isolation hardening | [api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts](api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts), [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts), [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), TESTING.md (new or existing at repo root) | backend + docs + test-doc | High | None |
| 2 | Manual hotspot endpoint parity | [dvi_frontend/src/services/itinerary.ts](dvi_frontend/src/services/itinerary.ts), [dvi_frontend/src/pages/ItineraryDetails.tsx](dvi_frontend/src/pages/ItineraryDetails.tsx), [api.dvi.travel/src/modules/itineraries/itineraries.controller.ts](api.dvi.travel/src/modules/itineraries/itineraries.controller.ts) | frontend parity fix + backend verification | Medium | 1 |
| 3 | Delete-activity full reroute | [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts), [dvi_frontend/src/pages/ItineraryDetails.tsx](dvi_frontend/src/pages/ItineraryDetails.tsx) | bug fix + business-rule alignment | High | 1 |
| 4 | Scoring/priority normalization | [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.scoring.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.scoring.ts), [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts), [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.hotspot-selector.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.hotspot-selector.ts) | business-rule alignment + architecture refactor (targeted) | High | 3 |
| 5 | Formal optimization flow (1/2/3 then nearest chain) | [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts), [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.hotspot-selector.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.hotspot-selector.ts), [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.scoring.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.scoring.ts) | business-rule alignment | High | 4 |
| 6 | Activity blocking + reroute/warn policy | [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts), [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts), [dvi_frontend/src/pages/ItineraryDetails.tsx](dvi_frontend/src/pages/ItineraryDetails.tsx), [dvi_frontend/src/services/itinerary.ts](dvi_frontend/src/services/itinerary.ts) | bug fix + business-rule alignment | High | 5 |
| 7 | Morning/evening defer model hardening | [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.operating-hours.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.operating-hours.ts), [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts) | business-rule alignment | Medium | 5 |
| 8 | Direct/via parity + rebuild triggers | [api.dvi.travel/src/modules/itineraries/engines/route-engine.service.ts](api.dvi.travel/src/modules/itineraries/engines/route-engine.service.ts), [api.dvi.travel/src/modules/itineraries/engines/via-routes.engine.ts](api.dvi.travel/src/modules/itineraries/engines/via-routes.engine.ts), [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts), [dvi_frontend/src/pages/CreateItinerary/RouteDetailsBlock.tsx](dvi_frontend/src/pages/CreateItinerary/RouteDetailsBlock.tsx), [dvi_frontend/src/pages/CreateItinerary/helpers/useItineraryRoutes.ts](dvi_frontend/src/pages/CreateItinerary/helpers/useItineraryRoutes.ts), [dvi_frontend/src/pages/ItineraryDetails.tsx](dvi_frontend/src/pages/ItineraryDetails.tsx) | frontend parity fix + business-rule alignment | Medium | 7 |
| 9 | Multi-day carry-forward support completion | [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts), [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts) | business-rule alignment + architecture refactor (targeted) | High | 8 |
| 10 | Customization template persistence | [api.dvi.travel/prisma/schema.prisma](api.dvi.travel/prisma/schema.prisma), [api.dvi.travel/src/modules/itineraries/itineraries.controller.ts](api.dvi.travel/src/modules/itineraries/itineraries.controller.ts), [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts), [dvi_frontend/src/services/itinerary.ts](dvi_frontend/src/services/itinerary.ts), [dvi_frontend/src/pages/ItineraryDetails.tsx](dvi_frontend/src/pages/ItineraryDetails.tsx) | persistence enhancement + API extension | Medium | 9 |

## 4. Recommended Implementation Phases

### Step 1: Preview hotspot safety fix
- Change type: bug fix
- Objective: guarantee preview endpoints have zero persistent side effects.
- Why needed: current preview path creates a hotspot row during preview.
- Exact likely files: [api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts](api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts), [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts), [dvi_frontend/src/services/itinerary.ts](dvi_frontend/src/services/itinerary.ts) (contract verification only), TESTING.md (new or existing at repo root).
- DB schema change required: No.
- Regression risk: High (timeline builder expects persisted-like inputs).
- Suggested validation:
1. Run preview add-hotspot twice; confirm no extra rows persist in route hotspot table.
2. Confirm preview response still includes conflicts/timeline payload.
3. Confirm actual add-hotspot still persists exactly once.

### Step 2: Frontend manual hotspot endpoint alignment
- Change type: frontend parity fix
- Objective: align addManualHotspot call path to dedicated manual-hotspot backend endpoint.
- Why needed: wrapper currently points to generic add endpoint.
- Exact likely files: [dvi_frontend/src/services/itinerary.ts](dvi_frontend/src/services/itinerary.ts), [dvi_frontend/src/pages/ItineraryDetails.tsx](dvi_frontend/src/pages/ItineraryDetails.tsx), [api.dvi.travel/src/modules/itineraries/itineraries.controller.ts](api.dvi.travel/src/modules/itineraries/itineraries.controller.ts) (verify contracts only).
- DB schema change required: No.
- Regression risk: Medium.
- Suggested validation:
1. Add manual hotspot from ItineraryDetails.
2. Verify correct endpoint hits and persistence flags.
3. Verify remove manual hotspot still works.

### Step 3: Delete-activity full reroute/rebuild
- Change type: bug fix + business-rule alignment
- Objective: ensure deleting activity triggers full route/day recalculation.
- Why needed: current flow only deletes row and updates timestamp.
- Exact likely files: [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts), [api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts](api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts), [dvi_frontend/src/pages/ItineraryDetails.tsx](dvi_frontend/src/pages/ItineraryDetails.tsx).
- DB schema change required: No.
- Regression risk: High.
- Suggested validation:
1. Delete activity in middle of day.
2. Verify downstream items are reoptimized, not just left-shifted blindly.
3. Verify no conflict flags regress.

### Step 4: Normalize scoring / priority semantics
- Change type: business-rule alignment
- Objective: make scoring deterministic and aligned to business priority order.
- Why needed: helper comment/formula mismatch can cause unintended ordering.
- Exact likely files: [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.scoring.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.scoring.ts), [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts), [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.hotspot-selector.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.hotspot-selector.ts).
- DB schema change required: No.
- Regression risk: High.
- Suggested validation:
1. Fixed sample route with known priority mix (1/2/3/0/4+).
2. Verify 1/2/3 locked first, then nearest chain for rest.
3. Verify deterministic repeat across runs.

### Step 5: Formalize optimization flow for top 1/2/3 then nearest chaining
- Change type: business-rule alignment + architecture refactor (targeted)
- Objective: encode explicit two-stage selection pipeline.
- Why needed: current logic is diffuse and hard to verify.
- Exact likely files: [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts), [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.hotspot-selector.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.hotspot-selector.ts), [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.scoring.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.scoring.ts).
- DB schema change required: No.
- Regression risk: High.
- Suggested validation:
1. Verify stage-1 picks top priorities before flexible candidates.
2. Verify stage-2 distance chain begins from last fixed node.
3. Compare before/after route ordering for non-priority hotspots.

### Step 6: Add activity-aware rerouting/warning logic
- Change type: business-rule alignment
- Objective: treat activities as blocking schedule items that can trigger reroute; optional hotspots yield first; warn if top-priority hotspots still impossible.
- Why needed: current add/delete behavior is mostly local and can violate business intent.
- Exact likely files: [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts), [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts), [dvi_frontend/src/pages/ItineraryDetails.tsx](dvi_frontend/src/pages/ItineraryDetails.tsx), [dvi_frontend/src/services/itinerary.ts](dvi_frontend/src/services/itinerary.ts).
- DB schema change required: No (initially; warnings can ride existing response payload).
- Regression risk: High.
- Suggested validation:
1. Add long activity near midday; verify reroute of remaining hotspots.
2. Verify optional hotspots are dropped before top-priority hotspots.
3. Verify warning appears only when top-priority still cannot fit after reroute.

### Step 7: Add morning/evening defer model
- Change type: business-rule alignment
- Objective: standardize first-half/second-half defer rules and ensure deferred hotspots are reconsidered correctly.
- Why needed: behavior exists but is hard to reason about and validate.
- Exact likely files: [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.operating-hours.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.operating-hours.ts), [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts).
- DB schema change required: No.
- Regression risk: Medium.
- Suggested validation:
1. Morning-only hotspot arriving late morning should defer and retry evening if valid.
2. Evening-only hotspot should not block morning chain.
3. Deferred list must clear deterministically by day end.

### Step 8: Improve direct/via parity and route rebuild triggers
- Change type: frontend parity fix + business-rule alignment
- Objective: ensure direct destination skips source sightseeing, via routes are represented in planning, and route triggers rebuild consistently after user edits.
- Why needed: direct toggle/UI parity and backend comments indicate drift.
- Exact likely files: [dvi_frontend/src/pages/CreateItinerary/RouteDetailsBlock.tsx](dvi_frontend/src/pages/CreateItinerary/RouteDetailsBlock.tsx), [dvi_frontend/src/pages/CreateItinerary/helpers/useItineraryRoutes.ts](dvi_frontend/src/pages/CreateItinerary/helpers/useItineraryRoutes.ts), [dvi_frontend/src/pages/CreateItinerary/CreateItinerary.tsx](dvi_frontend/src/pages/CreateItinerary/CreateItinerary.tsx), [api.dvi.travel/src/modules/itineraries/engines/route-engine.service.ts](api.dvi.travel/src/modules/itineraries/engines/route-engine.service.ts), [api.dvi.travel/src/modules/itineraries/engines/via-routes.engine.ts](api.dvi.travel/src/modules/itineraries/engines/via-routes.engine.ts), [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts), [dvi_frontend/src/pages/ItineraryDetails.tsx](dvi_frontend/src/pages/ItineraryDetails.tsx).
- DB schema change required: No.
- Regression risk: Medium.
- Suggested validation:
1. Direct route day should skip source hotspot selection.
2. Via route additions should appear in travel segments and impact timing.
3. Day start/end updates should always trigger full re-optimization.

### Step 9: Add multi-day carry-forward support
- Change type: business-rule alignment + architecture refactor (targeted)
- Objective: formalize overflow handoff of unvisited candidates to subsequent day(s) with deterministic rules.
- Why needed: partial behavior exists but parity is not guaranteed.
- Exact likely files: [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts), [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts).
- DB schema change required: No for initial implementation (derive from existing route/hotspot state); maybe Yes later if explicit carry-forward state must persist across edits.
- Regression risk: High.
- Suggested validation:
1. Saturated day N should spill eligible non-visited candidates to day N+1.
2. Top-priority preservation should still hold across days.
3. Rebuild should remain deterministic for same inputs.

### Step 10: Add reusable customization template persistence
- Change type: persistence enhancement
- Objective: save and reapply itinerary customization profiles after core parity stabilization.
- Why needed: currently missing capability, explicitly deferred by business priority.
- Exact likely files: [api.dvi.travel/prisma/schema.prisma](api.dvi.travel/prisma/schema.prisma), [api.dvi.travel/src/modules/itineraries/itineraries.controller.ts](api.dvi.travel/src/modules/itineraries/itineraries.controller.ts), [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts), [dvi_frontend/src/services/itinerary.ts](dvi_frontend/src/services/itinerary.ts), [dvi_frontend/src/pages/ItineraryDetails.tsx](dvi_frontend/src/pages/ItineraryDetails.tsx).
- DB schema change required: Yes (new template table(s) and mapping table likely needed).
- Regression risk: Medium.
- Suggested validation:
1. Save template from customized itinerary.
2. Reapply to similar itinerary and compare resulting constraints/selection.
3. Ensure template apply does not bypass normal validation and rebuild logic.

## 5. API Impact Analysis

Endpoints likely unchanged (contract stable):
- Hotspot/activity preview/add/delete and route rebuild/time-update endpoints in [api.dvi.travel/src/modules/itineraries/itineraries.controller.ts](api.dvi.travel/src/modules/itineraries/itineraries.controller.ts)
- Existing create itinerary route payload contracts in [dvi_frontend/src/pages/CreateItinerary/CreateItinerary.tsx](dvi_frontend/src/pages/CreateItinerary/CreateItinerary.tsx)

Endpoints needing internal behavior change only:
- Preview hotspot add behavior should become side-effect free.
- Delete activity should trigger full re-optimization path.
- Rebuild and route time update should enforce same deterministic optimization policy.

Endpoints that may require request/response contract changes:
- Activity preview/add may need richer warning payload (for top-priority impossible cases) if current fields are insufficient.
- Template persistence (Step 10) requires new API endpoints.

Frontend services/components that must stay in sync:
- [dvi_frontend/src/services/itinerary.ts](dvi_frontend/src/services/itinerary.ts)
- [dvi_frontend/src/pages/ItineraryDetails.tsx](dvi_frontend/src/pages/ItineraryDetails.tsx)
- [dvi_frontend/src/pages/CreateItinerary/RouteDetailsBlock.tsx](dvi_frontend/src/pages/CreateItinerary/RouteDetailsBlock.tsx)
- [dvi_frontend/src/pages/CreateItinerary/helpers/useItineraryRoutes.ts](dvi_frontend/src/pages/CreateItinerary/helpers/useItineraryRoutes.ts)

## 6. Prisma / Database Impact Analysis
Current models sufficient as-is for Steps 1-9:
- [api.dvi.travel/prisma/schema.prisma](api.dvi.travel/prisma/schema.prisma) models dvi_itinerary_route_details, dvi_itinerary_route_hotspot_details, dvi_itinerary_route_activity_details, dvi_itinerary_via_route_details, dvi_hotspot_timing, dvi_activity_time_slot_details.

Fields likely needing reinterpretation (not schema change):
- dvi_itinerary_route_details.excluded_hotspot_ids: treat strictly as user-removed exclusions, not engine-temporary state.
- dvi_itinerary_route_details.direct_to_next_visiting_place: unify frontend toggle and backend selection behavior.
- dvi_itinerary_route_hotspot_details.item_type and hotspot_plan_own_way: align manual vs engine-selected semantics.
- dvi_itinerary_route_hotspot_details.is_conflict/conflict_reason: retain for warning surfaces.

Genuinely missing persistence needed later:
- Reusable customization templates (template header + template rules/items).
- Optional explicit carry-forward state table only if deterministic recomputation from existing state proves insufficient.

Whether new tables are needed:
- Template persistence: Yes, likely new tables required.
- Carry-forward: Not required initially; evaluate after Step 9 implementation and test outcomes.

## 7. Testing Strategy
Planned matrix (manual + automated where practical):

| Scenario | Core Assertion | Primary Files Under Test | Priority |
|---|---|---|---|
| Preview isolation | Preview never persists DB rows | [api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts](api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts), [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts) | P0 |
| Add hotspot | Add persists exactly once and rebuilds deterministically | [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts), [dvi_frontend/src/pages/ItineraryDetails.tsx](dvi_frontend/src/pages/ItineraryDetails.tsx) | P0 |
| Delete hotspot | Exclusion persisted and timeline recalculated | [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts) | P0 |
| Add activity | Activity blocks schedule and reroutes as needed | [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts), [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts) | P0 |
| Delete activity | Full reroute/rebuild after removal | [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts) | P0 |
| Start/end time update | Full re-optimization always triggered | [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts), [dvi_frontend/src/pages/ItineraryDetails.tsx](dvi_frontend/src/pages/ItineraryDetails.tsx) | P1 |
| Direct destination | Source sightseeing skipped when direct flag enabled | [api.dvi.travel/src/modules/itineraries/engines/route-engine.service.ts](api.dvi.travel/src/modules/itineraries/engines/route-engine.service.ts), [dvi_frontend/src/pages/CreateItinerary/RouteDetailsBlock.tsx](dvi_frontend/src/pages/CreateItinerary/RouteDetailsBlock.tsx) | P1 |
| Via route | Via segments affect timing/selection correctly | [api.dvi.travel/src/modules/itineraries/engines/via-routes.engine.ts](api.dvi.travel/src/modules/itineraries/engines/via-routes.engine.ts), [dvi_frontend/src/pages/CreateItinerary/helpers/useItineraryRoutes.ts](dvi_frontend/src/pages/CreateItinerary/helpers/useItineraryRoutes.ts) | P1 |
| Morning/evening defer | Defer and retry behavior is deterministic | [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts), [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.operating-hours.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.operating-hours.ts) | P1 |
| Top-priority preservation | 1/2/3 prioritized before nearest chain | [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.scoring.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.scoring.ts), [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts) | P0 |
| Multi-day carry-forward | Overflow candidates move to next day correctly | [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts) | P1 |
| Customization template reuse | Saved template reapplies consistently | Planned Step 10 files | P2 |

## 8. Safe Execution Order
Safest implementation order:
1. Step 1 (preview isolation): contains highest integrity risk and can corrupt planning data if left open.
2. Step 2 (manual endpoint alignment): low surface-area parity fix reduces UI/backend ambiguity before deeper logic updates.
3. Step 3 (delete-activity full rebuild): closes major inconsistency in schedule mutations.
4. Step 4 and Step 5 together (scoring + formal two-stage selection): establish deterministic core optimizer before advanced policies.
5. Step 6 (activity-aware rerouting): build on stable optimizer semantics.
6. Step 7 (defer model): refine timing policies once core ordering is stable.
7. Step 8 (direct/via parity and trigger consistency): synchronize route semantics across create/edit flows.
8. Step 9 (multi-day carry-forward): add cross-day logic after same-day determinism is stable.
9. Step 10 (template persistence): defer to post-parity to avoid locking unstable behavior into reusable templates.

Rationale:
- Front-load data integrity and determinism.
- Defer schema/API expansion until behavior parity is stable.
- Keep endpoint contracts stable through Steps 1-9.

## 9. Out of Scope for Initial Stabilization
- New UI redesigns unrelated to itinerary parity.
- Broad module rewrites outside itinerary optimization path.
- Prisma schema changes for non-template features.
- Performance tuning unrelated to correctness/determinism.
- Template persistence implementation before parity completion.

## 10. Next Immediate Copilot Prompt
Use this exact prompt next:

"Implement Step 1 only: fix preview hotspot side effects only.

Context:
- Workspace root: c:/wamp64/www/dvi_fullstack
- Relevant files:
  - api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts
  - api.dvi.travel/src/modules/itineraries/itineraries.service.ts
  - dvi_frontend/src/services/itinerary.ts (verify no contract break)

Requirements:
1) Make the smallest safe backend change so preview hotspot flow has zero persistent DB side effects.
2) Do not implement any other step from IMPLEMENTATION_PLAN.md.
3) Do not change business logic beyond preview isolation.
4) Do not change Prisma schema.
5) Keep endpoint contracts unchanged unless absolutely required.
6) At the end, list all changed files.
7) Create or update TESTING.md in repo root with manual test cases for preview isolation:
   - preview add hotspot twice does not persist rows
   - preview returns expected timeline/conflicts
   - actual add hotspot still persists correctly

Validation:
- Run targeted checks and report results.
- Stop after Step 1."