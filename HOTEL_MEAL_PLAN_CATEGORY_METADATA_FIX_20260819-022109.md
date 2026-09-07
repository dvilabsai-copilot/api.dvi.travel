# Hotel Meal-Plan and Category Metadata Fix

Date: 2026-08-19 02:21:09 Asia/Calcutta
Scope: local backend/frontend verification only. No commit, push, PR, merge, or deployment.

## Problem

Reset could choose a cheaper CP rate over a valid requested MAP rate in the same category because category selection sorted by price before applying meal-plan preference. The final persisted response also omitted requested-category and fallback metadata, so rows could contain `selectedCategory` while `requestedCategory` was null.

## Before

```ts
const candidates = options
  .filter(option => this.categoryNumber(option.hotel) === category)
  .sort((a, b) => a.priceCents - b.priceCents);

const base = candidates[0].priceCents;
const threshold = Math.ceil(base * slot.multiplier);
const selected = candidates.find(candidate => candidate.priceCents >= threshold);
```

```ts
const hotelRow = {
  ...hotel,
  selectedPrice: hotel.selectedPrice,
  selectedRateOptionId: hotel.selectedRateOptionId,
};
```

The first block allowed a cheaper CP candidate to beat MAP. The second block did not copy category metadata into the response/persisted row.

## After

```ts
const categoryCandidates = options
  .filter(option => this.categoryNumber(option.hotel) === category)
  .sort(deterministicPriceAndIdentityOrder);

const bestMealPlanRank = Math.min(
  ...categoryCandidates.map(candidate => candidate.mealPlanRank),
);
const candidates = categoryCandidates.filter(
  candidate => candidate.mealPlanRank === bestMealPlanRank,
);

const base = candidates[0].priceCents;
const threshold = Math.ceil(base * slot.multiplier);
const selected =
  candidates.find(candidate => candidate.priceCents >= threshold && !usedHotels.has(candidate.hotelKey)) ??
  candidates.find(candidate => candidate.priceCents >= threshold) ??
  (candidates.length === 1 ? candidates[0] : undefined);
```

Meal-plan preference is now applied inside the requested category before multiplier/target pricing. Category preference remains stronger than meal-plan preference. A single valid rate remains selectable for all recommendation groups.

```ts
const hotelRow = {
  ...hotel,
  selectedPrice: hotel.selectedPrice,
  selectedRateOptionId: hotel.selectedRateOptionId,
  requestedCategory: Number(hotel.requestedCategory || 0) || null,
  selectedCategory: Number(hotel.selectedCategory || hotel.category || 0) || null,
  categoryFallbackApplied: Boolean(hotel.categoryFallbackApplied),
  categoryFallbackReason: hotel.categoryFallbackReason || null,
};
```

The authoritative selected source option and persisted/read decorators now carry the same metadata through the reset response and saved snapshot.

## Local verification

- Backend focused suites: **110 passed, 0 failed**.
- Backend TypeScript build: **passed**.
- Frontend hotel tests: **18 passed, 0 failed**.
- Frontend Vite production build: **passed**.
- `git diff --check`: passed; only CRLF conversion warnings were reported.
- Temporary target debug-log scan: no matches.
- Graphify refreshed successfully: 30,926 nodes and 69,288 edges.

## Reset and Chrome verification

After local reset for plan `10124` / itinerary `DVI20260847`:

| Stay | Group 1 | Group 2 | Group 3 | Group 4 |
|---|---|---|---|---|
| Alleppey, 2026-08-25 | HAVELI BACKWATER RESORT, MAP | Paloma Back Water Resort, MAP | Paloma Back Water Resort, MAP | Pagoda Resorts, MAP |
| Kovalam, 2026-08-26 | JEEVAN BEACH RESORT, CP fallback | JEEVAN BEACH RESORT, CP fallback | JEEVAN BEACH RESORT, CP fallback | JEEVAN BEACH RESORT, CP fallback |
| Rameswaram, 2026-08-28 | Daiwik Hotels Rameswaram, CP fallback | same TBO hotel, CP fallback | same TBO hotel, CP fallback | same TBO hotel, CP fallback |

Chrome showed the requested MAP rate for Alleppey in all four groups. Kovalam showed the expected offline CP fallback with `MAP requested — price unavailable.` Rameswaram retained its TBO CP fallback behavior.

Persisted reset data recorded requested category `3`, selected category `2`, and fallback `true` for the Kovalam lower-category selections. Alleppey retained requested category `3` and MAP selections; the unavailable group recorded the lower-category fallback metadata.

## Remaining known repository condition

The full frontend lint command has pre-existing repository-wide failures (1,144 errors and 94 warnings); the focused hotel tests and production build pass. No deployment was performed.
