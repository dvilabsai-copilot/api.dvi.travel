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

## Review correction update — 2026-07-31

The follow-up review identified defects in the first partial implementation.
Those defects were corrected in the current working tree as follows.

### Corrected defects

- Rate options are expanded into exact candidates before eligibility checks.
  CP eligibility now carries the CP rate identity and CP full-stay price; it
  cannot retain the cheaper EP price from the parent hotel object.
- Logical-stay availability is merged from every `routeIds` source and a
  child-route one-night rate is rejected when the stay requires multiple
  nights without full-stay coverage.
- Incomplete packages preserve selected/offline stays and return
  `UNAVAILABLE` stay results with reasons. `totalPrice` is `null` and
  `partialTotal` is used for the available-stay subtotal.
- Stay construction now uses stable stay groups, parent route IDs, dates, and
  destination IDs where present. Alleppey/Alappuzha aliases are normalized;
  explicit departure, transit, and activity-only routes are excluded.
- Recommendation diversity compares all previous packages and exposes
  repeated physical hotels, repeated exact options, duplicate-in-package
  hotels, and source group numbers.
- DFS first-N Cartesian enumeration was replaced with bounded deterministic
  beam search.
- Target scoring uses the previous actual total multiplied by 1.10 and an
  explicit below-target penalty.
- Availability normalization distinguishes live availability from offline
  approval, and offline candidates may be selectable even when they are not
  live-bookable.
- Category normalization accepts structured numeric/star values and does not
  extract arbitrary digits from unrelated text.
- Zero/missing distance is `UNKNOWN`, not a valid 0 km distance. Distance
  status/reference fields are returned when supplier metadata provides them.
- The API response now exposes algorithm version, stay-level package metadata,
  target/partial totals, route IDs, stay keys, and incomplete-stay rows.
- The frontend renders partial totals, target totals, stable logical stay keys,
  selectable offline approval options, and unknown meal plans without EP
  fallback.
- Expanded rate options never inherit parent-hotel totals or nightly prices;
  parent pricing is used only when the hotel object itself is one exact rate.
- Partial recommendations can return bounded alternatives for available stays
  while retaining the unavailable stay row in every package.
- Beam-search diversity tie-breaking uses exact identity-set membership, and
  target arithmetic stays in integer cents until response formatting.
- Recommendation-tab changes are immediate; no artificial 500 ms loader is used
  for a local tab switch.

### Additional tests

The actual test file is now present at:

```text
api.dvi.travel/test/hotel-recommendation-package.test.ts
dvi_frontend/src/test/hotel-recommendation-v2-ui.test.ts
```

Coverage includes exact rate-option pricing, parent/child route resolution,
partial packages, stable stay construction, offline selectability, category
normalization, unknown distance, feature-flag defaulting, beam-search target
selection, deterministic shuffled input, and fewer-than-four package behavior.

### Reproducible verification

```text
Backend build: npm.cmd run build
Backend focused suite: npx.cmd tsx --test test/hotel-recommendation-package.test.ts test/itinerary-hotel-room-category.test.ts test/hotel-availability-snapshot.test.ts test/offline-hotel-approval.test.ts test/itinerary-selection-workflow.test.ts test/staah-room-selection.test.ts
Result: 48 passed, 0 failed

Frontend build: npm.cmd run build
Frontend focused suite: npm.cmd test -- --run src/test/hotel-recommendation-v2-ui.test.ts src/test/offline-hotel-flow.test.ts src/test/itinerary-details.utils.test.ts src/test/hotelStayDates.utils.test.ts
Result: 17 passed, 0 failed
```

### Remaining risks

- The feature flag still defaults to v1. Enable v2 consistently for a search
  run with `HOTEL_RECOMMENDATION_ALGORITHM=v2`; do not change it mid-request.
- Algorithm version is logged and returned in the response, but a dedicated
  persisted snapshot column/migration has not been added in this change.
- Provider-specific upstream coordinate enrichment and full supplier
  certification still require environment/database verification.
- Full create-itinerary-to-refresh Playwright/Chrome verification remains
  blocked for localhost by the browser security policy; no bypass was used.
- The uploaded archive used for external review may not contain the complete
  backend test directory; the current working repository does contain the
  focused tests listed above.

Do not describe this as production-ready until those remaining persistence,
supplier, and browser-E2E risks are closed.
