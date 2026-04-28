# Filter Extension Analysis (Meal Plan + Hotel Category)

## Objective
Extend the same two filters currently used in itinerary hotel search flows to other hotel-related APIs, without changing implementation in this task.

## Assumption on "two filters"
This analysis assumes the two filters are:
1. Meal Plan filter (canonical codes: EP, CP, MAP, AP and mapped supplier meal type).
2. Hotel Category filter (star-based filtering + STD/Budget behavior currently treated as sub-3-star plus low-price subset).

If a different pair of filters is intended, keep this file structure and swap the filter definitions.

## Current Baseline (What Already Exists)

### Implemented strongly
- `GET /itineraries/hotel_details/:quoteId`
- `POST /itineraries/hotel_details/:quoteId/rebuild`

These already resolve itinerary plan preferences and apply:
- Meal-plan filtering controls.
- Star/category filtering.
- STD/Budget logic.
- DB cache read-path normalization for category values.

Primary implementation surface:
- `src/modules/itineraries/itinerary-hotel-details-tbo.service.ts`

### Implemented partially
- `POST /hotels/search`

Status:
- Supports `preferences.mealPlanCode`, `preferences.tboMealType`, and `preferences.starRatings`.
- Does not have a first-class STD/Budget preference contract in DTO/interface.
- Does not resolve itinerary-level category IDs to star/STD/Budget by itself.

Primary surfaces:
- `src/modules/hotels/controllers/hotel-search.controller.ts`
- `src/modules/hotels/services/hotel-search.service.ts`
- `src/modules/hotels/dto/hotel.dto.ts`
- `src/modules/hotels/interfaces/hotel-provider.interface.ts`

### Not yet aligned to the two-filter behavior
- `GET /itineraries/hotel_room_details/:quoteId`

Status:
- Fetches room details from supplier search path but does not currently pass itinerary meal/category preferences into room-details generation.
- Grouping/tiers exist, but filter parity with hotel_details is not guaranteed.

Primary surface:
- `src/modules/itineraries/itinerary-hotel-details-tbo.service.ts` (`getHotelRoomDetailsFromTbo` path)

## API Inventory and Recommended Scope

## Tier 1 (Must align now)
1. `GET /itineraries/hotel_room_details/:quoteId`
- Reason: Same quote/day hotel data family as `hotel_details`; UI expects parity.
- Expected outcome: Room-details result set should be generated from the same effective filtered supplier candidate pool as hotel-details.

2. Internal service calls that depend on room-details generation
- Reason: Several itinerary operations call `getHotelRoomDetailsFromTbo` internally.
- Expected outcome: No flow can bypass the two filters when obtaining room choices for a quote.

## Tier 2 (Should align)
1. `POST /hotels/search`
- Reason: Generic search endpoint should support same filter semantics when caller provides equivalent intent.
- Expected outcome: API contract can express category IDs / STD-Budget intent or a normalized preference object that maps to existing engine logic.

## Tier 3 (Out of scope or constrained)
1. `GET /itineraries/hotels/available/:routeId`
- Constraint: This endpoint is local DB distance-based availability; no supplier meal data context.
- Category filter can be added, meal-plan filter is not meaningful without supplier room-rate meal metadata.

2. `GET /itineraries/details/:quoteId`, clipboard/export endpoints
- These are aggregation/rendering APIs over already-selected/saved rows.
- Prefer display normalization only, not fresh supplier-side re-filtering at this layer.

## What Needs to Be Done (No Code)

### 1) Define a shared filter contract
Create one internal filter context shape used by all hotel fetch paths:
- `mealPlanCode?: EP|CP|MAP|AP`
- `tboMealType?: string`
- `starRatings?: number[]`
- `stdBudgetSelected?: boolean`
- Optional source metadata: `source: itinerary_plan | explicit_api_request`

Why:
- Prevent drift between `hotel_details`, `hotel_room_details`, and `hotels/search`.

### 2) Centralize preference resolution
Extract and reuse itinerary preference resolution logic (currently concentrated in TBO itinerary hotel-details service):
- Parse `preferred_hotel_category` IDs.
- Map IDs via `dvi_hotel_category` to stars + STD/Budget flags.
- Resolve meal preference from `meal_plan_code` and fallback flags.

Why:
- One resolver for all APIs avoids duplicate behavior and repeated bugs (for example category ID leaks like 13/14).

### 3) Reuse one post-search enforcement step
For any API that returns supplier hotel candidates:
- Apply category enforcement post-provider response.
- Apply STD/Budget low-price subset logic consistently.
- Keep supplier request hints (like StarRating/MealType) as optimization only, not sole enforcement.

Why:
- Supplier-level filters are inconsistent in practice; parity depends on local enforcement.

### 4) Align room-details generation with hotel-details filters
For `hotel_room_details` generation:
- Build the same effective filtered candidate set as hotel-details before room shaping/tiering.
- Ensure route-level and cached-path logic does not bypass filter context.

Why:
- Prevent mismatch where list API shows filtered hotels but room API shows unfiltered alternatives.

### 5) Extend public DTOs where needed (if product requires external control)
For `POST /hotels/search`:
- Option A: Keep current fields and add clear mapping docs for category semantics.
- Option B: Add explicit `categoryIds` and/or `stdBudgetSelected` in preferences.

Why:
- Generic search should not require callers to reverse-engineer itinerary internals.

## Data and Schema Considerations

1. Category master dependencies
- Behavior depends on `dvi_hotel_category` labels/codes for star and STD/Budget detection.
- Must enforce strict mapping rules and fallback behavior when labels are malformed.

2. Legacy category IDs in payloads
- Continue normalizing legacy ID-like values (for example 13, 14) in all read paths where category is surfaced.

3. Meal-plan toggle behavior
- Respect global meal-plan search toggle consistently across APIs that perform supplier search.

## Non-Functional Requirements

1. Backward compatibility
- Existing endpoints must preserve response shape.
- New preference fields in DTOs should be optional.

2. Observability
- Add consistent logs: resolved meal plan, resolved stars, stdBudget flag, before/after candidate counts.

3. Cache correctness
- Any cache key for supplier result sets should include effective filter context if result set depends on filters.

## Testing Strategy (Before/After)

## Contract tests
1. Quote with meal plan set only.
2. Quote with star categories only.
3. Quote with STD/Budget only.
4. Quote with stars + STD/Budget together.

## Parity tests
1. Compare `hotel_details` vs `hotel_room_details` for same quote and route(s):
- Filtered hotel IDs should align by group intent.
- Room results should be a subset of filtered hotel candidates.

## Regression tests
1. Verify no category ID leakage (for example 13*) in API payload fields intended as star display values.
2. Verify meal labels remain canonical/normalized where expected.

## Rollout Plan

1. Phase 1
- Refactor-only: extract shared resolver + shared filter application utility.
- No endpoint behavior change intended.

2. Phase 2
- Wire shared filter flow into `hotel_room_details` path.
- Validate parity against `hotel_details`.

3. Phase 3
- Extend `hotels/search` contract semantics (if required) and document usage.

4. Phase 4
- Optional scoped additions for route-local availability endpoint (category only), if product needs it.

## Risks and Mitigations

1. Risk: Filter divergence between APIs after future edits.
- Mitigation: one shared resolver + one shared enforcement utility + parity tests in CI.

2. Risk: Over-filtering causes empty results for certain routes.
- Mitigation: preserve current fallback strategy and explicitly log fallback reason.

3. Risk: Cached stale data appears unfiltered.
- Mitigation: include effective filter context in cache invalidation/read strategy where applicable.

## Recommended Next Decision
Choose one of these implementation scopes before coding:
1. Minimal: apply parity only to `hotel_room_details`.
2. Standard: `hotel_room_details` + explicit contract cleanup for `hotels/search`.
3. Full: standard scope + category-only behavior for `hotels/available/:routeId`.
