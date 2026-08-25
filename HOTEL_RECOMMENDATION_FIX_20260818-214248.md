# Hotel Recommendation and Kovalam Offline Inventory Fix

**Created:** 2026-08-18 21:42:48 +05:30  
**Scope:** Local investigation and documentation only  
**Repositories:** `api.dvi.travel`, `dvi_frontend`

## Problem

For a requested category such as 3★, category filtering could remove valid fallback categories from the recommendation candidate pool. In addition, recommendation persistence preferred distinct hotels but could leave later groups without a selected hotel when only one valid property remained.

For Kovalam city `48387`, the local database contains these active local/offline properties:

- Aadisaktthi Resorts & Spa — 3★
- Gokulam Grand Turtle on the Beach — 4★
- JEEVAN BEACH RESORT — STD/2★
- Ocean Bay Beach Resort Kovalam — Budget
- The Byke Puja Samudra Beach Resort — 3★

There were no date-specific rows in `dvi_hotel_room_availability` covering 2026-08-26; these local properties have active room-master records instead.

## Before

### Category candidate filtering

```ts
if (categories.size > 0) {
  const category = this.categoryNumber(candidate);
  if (!category || !categories.has(category)) {
    return {
      ok: false,
      reason: `Category ${this.normalizedCategory(candidate)} is not in the requested category set.`,
    };
  }
}
```

### Automatic selection

```ts
const candidates = evaluation.options.filter(
  (option) => this.categoryNumber(option.hotel) === slot.category,
);

const selected = candidates.find(
  (candidate) =>
    candidate.priceCents >= threshold &&
    !used.has(this.physicalIdentity(candidate.hotel)),
);

if (!selected) return;
```

### Persistence diversity rule

```ts
const option = sortedOptions.find(
  (candidate) => !reserved.has(hotelIdentity(candidate)),
);

if (!option) continue;
```

This made diversity a hard availability requirement.

## After

### Category candidate filtering

```ts
if (categories.size > 0) {
  const category = this.categoryNumber(candidate);
  if (!category) {
    return {
      ok: false,
      reason: `Category ${this.normalizedCategory(candidate)} is not a supported star category.`,
    };
  }
}
```

All supported categories remain in the shared inventory. Categories now affect automatic selection only.

### Deterministic category fallback

```ts
private categoryFallbackOrder(targetCategory: number): number[] {
  const supported = [2, 3, 4, 5];
  return [
    targetCategory,
    ...supported.filter((category) => category < targetCategory).sort((a, b) => b - a),
    ...supported.filter((category) => category > targetCategory),
  ];
}

const selected = unused || candidates.find(
  (candidate) => candidate.priceCents >= threshold,
);

const fallbackSelected = selected || (
  category !== slot.category ? candidates[0] : undefined
);
```

The selected hotel carries:

```ts
{
  requestedCategory,
  selectedCategory,
  categoryFallbackApplied,
  categoryFallbackReason,
}
```

### Persistence diversity rule

```ts
const distinctOption = sortedOptions.find(
  (candidate) => !reserved.has(hotelIdentity(candidate)),
);

// Distinct properties are preferred, but reuse is allowed when the
// route has no remaining distinct eligible property.
const option = distinctOption || sortedOptions[0];
```

This allows the same valid fallback hotel to populate multiple recommendation groups when no distinct valid alternative exists.

### TBO live-rate normalization

```ts
isLiveRate: true,
isLiveBookable: Boolean(realBookingCode && formattedTotalFare > 0),
isBookable: Boolean(realBookingCode && formattedTotalFare > 0),
isSelectable: Boolean(realBookingCode && formattedTotalFare > 0),
availabilityStatus:
  realBookingCode && formattedTotalFare > 0
    ? 'LIVE_AVAILABLE'
    : 'NO_AVAILABILITY',
```

Valid TBO rates with a real booking code and positive fare are therefore eligible for recommendation selection.

## Local verification recorded

- Recommendation package tests: 29 passing.
- Hotel availability snapshot tests: 59 passing.
- Itinerary persistence tests: 16 passing.
- Backend build: passing.
- Database inspection: Kovalam local/offline inventory confirmed as listed above.
- No commit, push, merge, or deployment was performed for this documentation request.

## Follow-up cleanup

Temporary diagnostic logs used during local debugging must be removed from source before the implementation is considered ready for commit:

```text
DEBUG_KOVALAM_OPTIONS
DEBUG_KOVALAM_PACKAGES
DEBUG_SHARED_MATCH
DEBUG_RECONCILE_KOVALAM
```

