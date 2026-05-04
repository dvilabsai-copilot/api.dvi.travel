# ENGINE FIX: CODE LOCATIONS & EXACT CHANGES

## BEFORE (Original HEAD)

```typescript
// src/modules/itineraries/engines/hotspot-engine.service.ts (ORIGINAL)

async rebuildRouteHotspots(
  tx: Tx, 
  planId: number, 
  existingHotspotsFromService?: any[]
): Promise<any> {
  
  // Delete old rows
  await deleteMany({ itinerary_plan_ID: planId, deleted: 0 });
  
  // Build timeline (no manual hotspot handling)
  const { hotspotRows, parkingRows } = 
    await this.timelineBuilder.buildTimelineForPlan(tx, planId, existingHotspots);
  
  // Map rows - NO SORTING!
  const dbHotspotRows = hotspotRows.map(row => ({
    ...row,
    is_conflict: row.isConflict ? 1 : 0,
  }));
  
  // Persist directly
  await tx.dvi_itinerary_route_hotspot_details.createMany({
    data: dbHotspotRows  // ← ROWS IN INSERTION ORDER!
  });
  
  return { shiftedItems, droppedItems };
}
```

**Key Issue**: No sorting happens. Rows are persisted in whatever order TimelineBuilder returns them (insertion order, not chronological).

---

## AFTER (New Implementation)

```typescript
// src/modules/itineraries/engines/hotspot-engine.service.ts (FIXED)

async rebuildRouteHotspots(
  tx: Tx, 
  planId: number, 
  existingHotspotsFromService?: any[],
  options?: { /* manual hotspot options */ }
): Promise<any> {
  
  // Step 1: Delete old rows
  await deleteMany({ itinerary_plan_ID: planId, deleted: 0 });
  
  // Step 2: Build timeline
  const { hotspotRows, parkingRows } = 
    await this.timelineBuilder.buildTimelineForPlan(tx, planId, existingHotspots);
  
  // Step 3: [NEW] Extract manual hotspots before deletion (lines 47-60)
  const manualHotspots = existingHotspots.filter(h => 
    h.hotspot_plan_own_way === 1 && h.deleted === 0
  );
  
  // Step 4: [NEW] Inject manual hotspots back with proper timing (lines 250-430)
  if (manualHotspots.length > 0) {
    // Re-insert manual hotspots at correct chronological position
    // Assign real arrival times based on last visit in route
    // Preserve manual hotspot selections
  }
  
  // Step 5: [NEW] Deduplicate final rows (lines 441-465)
  const dedupenedRows = [...filteredHotspotRows];
  // Remove exact duplicates (same route + type + hotspot + timing)
  
  // Step 6: [NEW] SORT BY CHRONOLOGICAL TIMESTAMP! (lines 472-493)
  const item TypePriority: Record<number, number> = {
    1: 0,  // START
    3: 1,  // TRAVEL
    4: 2,  // ATTRACTION
    5: 3,  // HOTEL_TRAVEL
    6: 4,  // CHECKIN
  };
  
  const sortedRows = [...dedupenedRows].sort((a, b) => {
    const aTime = a.hotspot_start_time ? new Date(a.hotspot_start_time).getTime() : 0;
    const bTime = b.hotspot_start_time ? new Date(b.hotspot_start_time).getTime() : 0;
    
    // Primary: sort by time (chronological)
    if (aTime !== bTime) {
      return aTime - bTime;  // ← CHRONOLOGICAL SORT
    }
    
    // Tie-breaker: when times equal, sort by type priority
    const aPriority = itemTypePriority[a.item_type] ?? 99;
    const bPriority = itemTypePriority[b.item_type] ?? 99;
    return aPriority - bPriority;  // ← TYPE PRECEDENCE
  });
  
  // Step 7: [NEW] Reassign hotspot_order after sort (lines 500-517)
  const routeOrdering = new Map<number, number>();
  for (const row of sortedRows) {
    if (row.item_type === 4) { // Only attractions
      const routeId = row.itinerary_route_ID;
      if (!routeOrdering.has(routeId)) {
        routeOrdering.set(routeId, 1);
      }
      const currentOrder = routeOrdering.get(routeId)!;
      row.hotspot_order = currentOrder;  // ← SEQUENTIAL 1,2,3...
      routeOrdering.set(routeId, currentOrder + 1);
    }
  }
  
  // Step 8: Map rows (SORTED!) and persist
  const dbHotspotRows = sortedRows.map(row => ({
    // Strip UI fields
    ...dbRow,
    is_conflict: isConflict ? 1 : 0,
  }));
  
  // Persist SORTED rows!
  await tx.dvi_itinerary_route_hotspot_details.createMany({
    data: dbHotspotRows  // ← ROWS IN CHRONOLOGICAL ORDER!
  });
  
  return { shiftedItems, droppedItems };
}
```

**Key Fix**: All rows are sorted by `hotspot_start_time` with type priority before `createMany()`. Database now receives rows in semantic order, not insertion order.

---

## SPECIFIC CODE SECTIONS

### Section 1: Manual Hotspot Extraction (Lines 47-60)

```typescript
// EXTRACT MANUAL HOTSPOTS BEFORE DELETION
const manualHotspots = existingHotspots.filter((h: any) => 
  Number(h.hotspot_plan_own_way || 0) === 1 && Number(h.deleted || 0) === 0
);

const manualHotspotIds = new Set(
  manualHotspots.map((h: any) => Number(h.hotspot_ID || 0))
);

console.log('[ManualHotspot][rebuildRouteHotspots] extracted manual hotspots', {
  planId,
  manualHotspotCount: manualHotspots.length,
  manualHotspotIds: Array.from(manualHotspotIds),
});
```

**Purpose**: Preserve user manual hotspot selections across engine rebuild.

### Section 2: Deduplication (Lines 441-465)

```typescript
const dedupeMap = new Map<string, any>();
const beforeDedupeCount = filteredHotspotRows.length;

for (const row of filteredHotspotRows as any[]) {
  const routeId = Number(row.itinerary_route_ID || 0);
  const itemType = Number(row.item_type || 0);
  const hotspotId = Number(row.hotspot_ID || 0);
  const startTime = row.hotspot_start_time ? new Date(row.hotspot_start_time).getTime() : 0;
  const endTime = row.hotspot_end_time ? new Date(row.hotspot_end_time).getTime() : 0;
  
  const dedupKey = `${routeId}|${itemType}|${hotspotId}|${startTime}|${endTime}`;
  
  if (!dedupeMap.has(dedupKey)) {
    dedupeMap.set(dedupKey, row);
  }
}

const dedupenedRows = Array.from(dedupeMap.values());
```

**Purpose**: Remove exact duplicate rows before sorting.

### Section 3: CHRONOLOGICAL SORTING (Lines 472-493)

```typescript
// 5.7) SORT final timeline rows by hotspot_start_time ASC (chronological)
// Item type priority when times are equal: 1 < 3 < 4 < 5 < 6
const itemTypePriority: Record<number, number> = {
  1: 0, // START
  3: 1, // TRAVEL
  4: 2, // ATTRACTION
  5: 3, // HOTEL_TRAVEL
  6: 4, // CHECKIN
};

const sortedRows = [...dedupenedRows].sort((a: any, b: any) => {
  const aTime = a.hotspot_start_time ? new Date(a.hotspot_start_time).getTime() : 0;
  const bTime = b.hotspot_start_time ? new Date(b.hotspot_start_time).getTime() : 0;
  
  if (aTime !== bTime) {
    return aTime - bTime; // Chronological ✅
  }
  
  // Same time: sort by item_type priority
  const aPriority = itemTypePriority[Number(a.item_type || 0)] ?? 99;
  const bPriority = itemTypePriority[Number(b.item_type || 0)] ?? 99;
  
  return aPriority - bPriority;
});

console.log('[...] sorted final rows by timestamp', {
  planId,
  rowCount: sortedRows.length,
});
```

**PURPOSE**: **THIS IS THE CORE FIX!** Ensures all rows are sorted chronologically before persistence.

### Section 4: HOTSPOT_ORDER Reassignment (Lines 500-517)

```typescript
// 5.9) REASSIGN hotspot_order sequentially after sort
const routeOrdering = new Map<number, number>();
for (const row of sortedRows as any[]) {
  const routeId = Number(row.itinerary_route_ID || 0);
  const itemType = Number(row.item_type || 0);
  
  if (itemType === 4) { // Only hotspot visits get order
    if (!routeOrdering.has(routeId)) {
      routeOrdering.set(routeId, 1);
    }
    const currentOrder = routeOrdering.get(routeId)!;
    row.hotspot_order = currentOrder;  // ← 1, 2, 3, 4, 5...
    routeOrdering.set(routeId, currentOrder + 1);
  }
}
```

**Purpose**: Assign sequential `hotspot_order` values (1, 2, 3...) after sorting, ensuring DB reflects chronological order.

### Section 5: Database Persistence (Lines 522-597)

```typescript
// 6) Insert hotspot details (using the final sorted, deduped, normalized rows)
const dbHotspotRows = sortedRows.map(row => {
  const { 
    isConflict, 
    conflictReason, 
    isManual, 
    type, 
    text, 
    timeRange, 
    locationId,
    ...dbRow 
  } = row as any;
  
  return {
    ...dbRow,
    is_conflict: isConflict ? 1 : 0,
    conflict_reason: conflictReason || null,
  };
});

// PERSIST SORTED ROWS!
await (tx as any).dvi_itinerary_route_hotspot_details.createMany({
  data: dbHotspotRows,
});
```

**Purpose**: Save the chronologically-sorted rows to database.

---

## IMPACT ON DVI202604230

### Day 1 (Route 1242)

**Before Fix**:
```
DB insertion order (original):
1. START
2. TRAVEL_INTRA (actual time 09:00)
3. ATTRACTION (actual time 09:30)  ← Wrong order if inserted differently
4. TRAVEL_INTRA
5. ATTRACTION
... (depends on timeline builder order)
```

**After Fix**:
```
DB insertion order (sorted) ✅:
1. START          08:00-09:00
2. TRAVEL_INTRA   09:00-09:30  ← Guaranteed before attraction
3. ATTRACTION     09:30-10:30  ← Guaranteed in order
4. TRAVEL_INTRA   10:30-10:44
5. ATTRACTION     10:44-11:44
... (strict chronological order)
```

### Day 2 (Route 1243)

**Before Fix**:
```
DB rows may appear in any order;
API layer applies sorting to response
```

**After Fix**:
```
DB rows already in chronological order
API layer sorting no longer needed (can remove later)
⚠️ Still needs: Route-end validation for DROP_OFF (Fix #2)
```

---

## COMPILATION & VALIDATION

```bash
❯ npm run build
✅ tsc -p tsconfig.json
   (No errors - TypeScript successful)

❯ git diff --stat
📊 9 files changed, 4693 insertions(+), 356 deletions(-)

❯ git commit -m "feat: Engine-level chronological sorting..."
✅ Commit fadd22e successful
```

---

## TESTING VERIFICATION

Ran debug script on DVI202604230:

```bash
❯ npx ts-node debug-engine-row-order.ts

Route 1242 (13 hotspots):
✅ All checks passed for this route

Route 1243 (9 hotspots):
⚠️ ISSUES FOUND:
  - DROP_OFF exceeds route_end_time by 81 minutes  ← Fix #2 needed
```

**Conclusion**: Chronological sorting is ready. ✅ Remaining fixes are independent.

---

## SUMMARY

| Change | Before | After | Impact |
|--------|--------|-------|--------|
| Row order | Insertion | Chronological | ✅ Semantic correctness |
| hotspot_order | Inconsistent | Sequential 1,2,3... | ✅ DB integrity |
| API sorting need | Required | Optional | ✅ Code simplification |
| Manual hotspots | Lost | Preserved | ✅ User selections |
| Route-end rows | N/A | Still unfiltered | ⏳ Fix #2 pending |
| Hotel timing | N/A | Still backward | ⏳ Fix #3 pending |
