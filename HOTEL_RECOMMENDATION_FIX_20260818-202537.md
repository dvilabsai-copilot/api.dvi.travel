# Hotel Recommendation Reset Fix

**Recorded:** 2026-08-18 20:25:37 +05:30  
**Itinerary:** `DVI20260847`  
**Endpoint:** `POST /api/v1/itineraries/hotel_details/DVI20260847/reset`  
**Environment:** Local development only

## Symptom

The itinerary category was saved as `3*`, but Chrome continued displaying old `2*` automatic hotel selections. The database showed:

```text
preferred_hotel_category = 3
active hotel rows = category 2 for several routes
```

## Before

### Category-change rebuild condition

Hotel rows were rebuilt only when route data changed:

```ts
const shouldRebuildRouteData = !isPlanUpdate || routeChanged;

if (shouldRebuildRouteData && (
  dto.plan.itinerary_preference === 1 ||
  dto.plan.itinerary_preference === 3
)) {
  await this.hotelEngine.rebuildPlanHotels(
    planId,
    tx,
    userId,
  );
}
```

A category-only edit could therefore update the plan category while leaving the previous hotel-selection rows active.

### Reset persistence source

Reset selected the group-neutral inventory as its persistence source:

```ts
const liveInventoryRows = liveResponse.hotelAvailability?.sharedHotelInventory
  || liveResponse.hotels;

let rows = this.normalizeRowsToCurrentRouteDates(
  [...sourceRows, ...offlineRows],
  routes,
);
```

`sharedHotelInventory` intentionally removes recommendation-group selection metadata. Using it alone meant the persistence layer could not receive the exact authoritative G1/G2/G3/G4 candidate.

## After

### Category, meal-plan, and room-count changes rebuild hotel rows

```ts
export function shouldRebuildHotelData(result: {
  routeChanged?: boolean;
  roomCountChanged?: boolean;
  mealPlanChanged?: boolean;
  hotelCategoryChanged?: boolean;
} | null | undefined): boolean {
  return Boolean(
    result?.routeChanged ||
    result?.roomCountChanged ||
    result?.mealPlanChanged ||
    result?.hotelCategoryChanged,
  );
}

const shouldRebuildRouteData = !isPlanUpdate || routeChanged;
const shouldRebuildHotelRows = shouldRebuildHotelData({
  routeChanged: shouldRebuildRouteData,
  hotelCategoryChanged,
  mealPlanChanged,
  roomCountChanged,
});

if (shouldRebuildHotelRows && (
  dto.plan.itinerary_preference === 1 ||
  dto.plan.itinerary_preference === 3
)) {
  await this.hotelEngine.rebuildPlanHotels(
    planId,
    tx,
    userId,
  );
}
```

### Reset carries authoritative recommendation rows separately

```ts
const authoritativeRecommendationRows = this.filterSearchableLiveRows(
  this.normalizeRowsToCurrentRouteDates(
    this.extractAuthoritativeRecommendationRows(liveResponse),
    routes,
  ),
  searchableRouteIds,
);

let rows = this.normalizeRowsToCurrentRouteDates(
  [...sourceRows, ...offlineRows, ...authoritativeRecommendationRows],
  routes,
);
```

The authoritative rows are extracted only from group-scoped rows:

```ts
private extractAuthoritativeRecommendationRows(response: any): any[] {
  const rows = Array.isArray(response?.hotels) ? response.hotels : [];

  return rows.filter((row: any) => {
    const groupType = Number(row?.groupType || row?.group_type || 0);

    return groupType >= 1 && groupType <= 4 && (
      row?.authoritativeRecommendation === true ||
      row?.autoSelectionCandidate === true
    );
  });
}
```

The shared inventory remains group-neutral. It is not category-filtered and remains available for manual browsing in all four groups.

## Regression tests added

```ts
test('reset keeps authoritative group rows separate from shared inventory rows', () => {
  const service = new HotelAvailabilitySnapshotService({} as any, {} as any, {} as any);
  const rows = (service as any).extractAuthoritativeRecommendationRows({
    hotels: [
      { groupType: 0, hotelCode: 'shared' },
      { groupType: 1, hotelCode: 'g1', authoritativeRecommendation: true },
      { groupType: 2, hotelCode: 'g2', autoSelectionCandidate: true },
      { groupType: 3, hotelCode: 'g3', authoritativeRecommendation: false },
      { groupType: 4, hotelCode: 'g4', authoritativeRecommendation: true },
    ],
  });

  assert.deepEqual(rows.map((row: any) => row.hotelCode), ['g1', 'g2', 'g4']);
});
```

```ts
test('hotel rows rebuild when category changes without a route change', () => {
  assert.equal(shouldRebuildHotelData({
    routeChanged: false,
    hotelCategoryChanged: true,
  }), true);
});
```

## Local verification

```text
Backend focused hotel tests: 115 passed, 0 failed
Backend build: passed
Frontend focused tests: 9 passed, 0 failed
Frontend build: passed
Chrome local reset: passed
```

Chrome after reset displayed Group 1 selections as `3*`, including:

```text
Munnar       AURUM RESORT -3*
Thekkady     JUNGLE PARK RESORT -3*
Alleppey     HAVELI BACKWATER RESORT -3*
Madurai      JC Residency -3*
```

The active database rows no longer contained the previous Group 1 `2*` selections.

## Deployment status

```text
No commit, push, PR, staging deployment, or production deployment was performed.
```

