# Hotel Prompt Implementation Status

Date: 2026-07-31
Branch: `codex/vehicle-recovery-hotel-merge-20260728`

This document records what has been implemented from the hotel-distribution,
pricing, recommendation, meal-plan, and multi-night requirements in the hotel
architecture prompt. It is intentionally explicit about partial work; items
listed as remaining are not claimed as complete.

## Scope

Only hotel recommendation, meal-plan, and related hotel UI logic was changed.
Vehicle logic was not changed.

## Implemented

### Recommendation package generation

- Added `HotelRecommendationPackageService`.
- Groups consecutive nights at the same destination into one logical hotel
  stay.
- Preserves `stayKey`, `routeIds`, parent route identity, and provider/rate
  identity.
- Builds complete packages from real eligible options rather than selecting
  hotels by array position.
- Uses the cheapest complete package as the first recommendation.
- Targets approximately 10% progression for subsequent recommendations while
  selecting only real, distinct combinations.
- Does not manufacture four different recommendations when only one real
  combination exists.
- Uses bounded combination generation to avoid unbounded search.

Implementation:

```text
api.dvi.travel/src/modules/itineraries/services/hotel-recommendation-package.service.ts
```

### Eligibility and availability safeguards

The v2 generator rejects candidates that are:

- not bookable or explicitly non-selectable;
- expired;
- marked unavailable, stale, or not bookable;
- outside the configured maximum distance;
- outside the requested category;
- missing the required meal plan.

Live options are preferred. Offline options are considered only when a stay
has no eligible live option in the supplied availability set.

Distance configuration:

```env
MAX_RECOMMENDED_HOTEL_DISTANCE_KM=15
HOTEL_RECOMMENDATION_REQUIRE_DISTANCE=true
```

When `HOTEL_RECOMMENDATION_REQUIRE_DISTANCE` is false, a missing distance is
allowed for compatibility with providers that do not return distance data.

### Meal-plan rules

- Canonical plans remain `CP`, `EP`, `MAP`, and `AP` where applicable.
- Unknown or non-meal text is no longer silently converted to EP.
- Requested meal plans are matched exactly during filtering.
- Structured rate-option meal data is preferred over room-name text.
- Added `HotelMealPlanPolicyService`.
- Alleppey/Alappuzha houseboat inventory requires AP.
- Houseboat detection uses structured accommodation/property metadata and tags,
  with a controlled legacy-name fallback.
- No business-rule fallback between incompatible meal plans is enabled.

Implementation:

```text
api.dvi.travel/src/modules/itineraries/services/hotel-meal-plan-policy.service.ts
api.dvi.travel/src/modules/hotels/hotel-rate-plans.ts
```

### Feature flag and rollback

The new package generator is behind a feature flag. Existing behavior remains
the default for rollback safety:

```env
HOTEL_RECOMMENDATION_ALGORITHM=v2
```

Any value other than `v2` uses the existing v1 package generation path.

### Frontend corrections

- Missing/unknown meal plans are shown as `UNKNOWN`, not EP.
- A rate with a mismatched meal plan is shown as unavailable for the requested
  plan instead of receiving a misleading green selected badge.
- Removed the duplicate room-selection setter that caused a Vite warning.

Implementation:

```text
dvi_frontend/src/pages/hotel-list/MealPlanCell.tsx
dvi_frontend/src/pages/hotel-list/hotelList.utils.ts
dvi_frontend/src/pages/HotelList.tsx
```

### Room-category compatibility

The room-category service now tolerates provider room details when optional
room-master relations are absent from a test fixture, while continuing to use
the database models when they are available. This keeps provider room options
usable without changing vehicle behavior.

## Verification completed

- Backend production build: passed.
- Frontend production build: passed.
- Backend focused/regression tests: 37 passed, 0 failed.
- Frontend focused tests: 14 passed, 0 failed.
- Added focused recommendation tests covering:
  - logical multi-night stays;
  - exact CP filtering;
  - unknown meal text;
  - distance boundary;
  - houseboat AP policy;
  - distinct-package behavior.

Test file:

```text
api.dvi.travel/test/hotel-recommendation-package.test.ts
```

## Not yet complete from the full prompt

These items remain separate work and should not be treated as completed by the
commits listed below:

- Full refresh/reset availability contract and reconciliation flow, including
  old-rate/new-rate comparison popups and automatic replacement rules.
- Complete persisted snapshot schema/unique-constraint audit and migration
  verification against the live database.
- Full explicit availability-state payload and restriction UX across every
  supplier path.
- Full API contract migration for all recommendation/group/stay endpoints.
- Complete recommendation response adaptation for every existing frontend
  table/card shape when logical stays contain multiple route IDs.
- Full Playwright create-itinerary-to-refresh end-to-end test.
- Live Chrome verification: the localhost reload was blocked by the browser
  security policy, and no policy bypass was used.
- Production supplier certification and rate-quality verification for every
  supplier and destination.

## Commits

Backend:

```text
2be2370e Implement strict hotel recommendation eligibility
```

Frontend:

```text
63d706d Prevent misleading hotel meal plan display
```

Documentation:

```text
8f20eb23 Document hotel recommendation implementation
```

No commits were pushed to the remote.
