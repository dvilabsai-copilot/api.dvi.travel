# Complete Manual Hotspot Timeline Integration Fix

## Overview
This fix addresses critical issues where manual hotspots (user-selected attractions) were not being properly integrated into the rebuilt timeline, resulting in duplicate rows, out-of-order timelines, and placeholder values remaining in the persisted database.

---

## Latest Updates (May 2026)

The following production behavior updates were implemented after the original timeline-integration fix.

### 1) Explicit User Selection in Add Hotspot Modal (Frontend)

**Change**: Removed automatic preview of the first hotspot when opening the Add Hotspot modal.

**Previous behavior**:
- Modal opened
- First hotspot was auto-selected and auto-previewed
- Right pane immediately showed "Calculating selected slot..." and "Confirm Add to Itinerary (1)" even without user action

**Current behavior**:
- Modal opens with no selected hotspot
- User must explicitly choose a hotspot by searching or scrolling and clicking Preview
- Confirm button remains disabled until explicit selection/preview

**File changed**:
- `dvi_frontend/src/pages/ItineraryDetails.tsx`

### 2) Recovery for Mistakenly Deleted Hotspots (Backend)

**Change**: Excluded (deleted) hotspots are no longer suppressed from the available hotspots list.

**Reason**:
- Users who accidentally deleted a hotspot could not see it in the left pane to restore it.
- Recovery required route rebuild, which was unintuitive.

**Current behavior**:
- Deleted hotspots can appear again in left pane Add Hotspot list.
- UI can show "Deleted from timeline" badge and user can preview/re-add directly.
- Apply flow still handles exclusion-list cleanup when the user adds the hotspot again.

**File changed**:
- `api.dvi.travel/src/modules/itineraries/itineraries.service.ts`

### 3) Confirmed User-Facing Outcome

- No auto-preview side effects on modal open.
- "Calculating selected slot..." appears only after explicit Preview action.
- Mistakenly deleted hotspots are recoverable from the same Add Hotspot modal flow.

---

## Root Causes Identified

### Bug #1: Old Placeholder Rows Not Deleted Before Persistence
**File**: `src/modules/itineraries/engines/hotspot-engine.service.ts` - `rebuildRouteHotspots()`

**Problem**: Manual hotspots were created as placeholder rows with `hotspot_order=999` and dummy timestamps (`1970-01-01T00:00:00Z`). After the injection logic added them to the rebuilt timeline, the **old placeholder rows were never deleted**. This left stale data in the database.

**Fix**: Added deletion of old manual placeholder rows before persisting the final rebuilt timeline:
```typescript
// Delete old active manual placeholder rows before persisting
if (manualHotspotIds.size > 0) {
  await (tx as any).dvi_itinerary_route_hotspot_details.deleteMany({
    where: {
      itinerary_plan_ID: planId,
      hotspot_ID: { in: manualIdArray },
      hotspot_plan_own_way: 1,
      deleted: 0,
    },
  });
}
```

### Bug #2: Final Timeline Not Deduped
**File**: `src/modules/itineraries/engines/hotspot-engine.service.ts` - `rebuildRouteHotspots()`

**Problem**: After injection logic added manual hotspots to the filtered rows, exact duplicates could exist (same route, same hotspot_id, same timing). These were persisted as multiple rows for the same stop.

**Fix**: Added deduping logic using a Map keyed by `route+item_type+hotspot_id+timing`:
```typescript
const dedupeMap = new Map<string, any>();
for (const row of filteredHotspotRows) {
  const dedupKey = `${routeId}|${itemType}|${hotspotId}|${startTime}|${endTime}`;
  if (!dedupeMap.has(dedupKey)) {
    dedupeMap.set(dedupKey, row);
  }
}
const dedupenedRows = Array.from(dedupeMap.values());
```

### Bug #3: Final Timeline Not Sorted Chronologically
**File**: `src/modules/itineraries/engines/hotspot-engine.service.ts` - `rebuildRouteHotspots()`

**Problem**: After deduping, rows were still in arbitrary order. Travel rows could appear after attractions, breaking the chronological sequence.

**Fix**: Added sorting by `hotspot_start_time` ASC, with item_type priority for same-time rows:
```typescript
const itemTypePriority: Record<number, number> = {
  1: 0, // refreshment/start
  3: 1, // travel
  4: 2, // attraction
  5: 3, // hotel travel
  6: 4, // hotel/checkin
};

const sortedRows = [...dedupenedRows].sort((a, b) => {
  const aTime = a.hotspot_start_time ? new Date(a.hotspot_start_time).getTime() : 0;
  const bTime = b.hotspot_start_time ? new Date(b.hotspot_start_time).getTime() : 0;
  if (aTime !== bTime) return aTime - bTime;
  // Same time: sort by item_type priority
  const aPriority = itemTypePriority[Number(a.item_type || 0)] ?? 99;
  const bPriority = itemTypePriority[Number(b.item_type || 0)] ?? 99;
  return aPriority - bPriority;
});
```

### Bug #4: hotspot_order Not Reassigned After Operations
**File**: `src/modules/itineraries/engines/hotspot-engine.service.ts` - `rebuildRouteHotspots()`

**Problem**: After sorting, order values were stale and non-sequential. Manual hotspots could still have `order=999`.

**Fix**: Reassigned `hotspot_order` sequentially per-route after final sort:
```typescript
const routeOrdering = new Map<number, number>();
for (const row of sortedRows) {
  const routeId = Number(row.itinerary_route_ID || 0);
  const itemType = Number(row.item_type || 0);
  
  if (itemType === 4) { // Only hotspot visits get order
    if (!routeOrdering.has(routeId)) routeOrdering.set(routeId, 1);
    const currentOrder = routeOrdering.get(routeId)!;
    row.hotspot_order = currentOrder;
    routeOrdering.set(routeId, currentOrder + 1);
  }
}
```

### Bug #5: Success Path Returning Wrong Branch Data
**File**: `src/modules/itineraries/engines/hotspot-engine.service.ts` - `previewManualHotspotAdd()`

**Problem**: Both success and fallback branches were using different data sources:
- Success branch: Should read from persisted rebuilt rows only
- Fallback branch: Was calling old `buildTimelineForPlan()` which didn't have the fix

**Fix**: 
- **Success branch**: Now reads **directly from persisted DB** (which contains the deduped/sorted/rebuilt timeline from `rebuildRouteHotspots()`)
- **Fallback branch**: Reads persisted rows and marks hotspot as conflict (`isConflict=true`, `conflictReason='Manual insertion could not fit in schedule.'`)
- Both branches validate that the selected hotspot exists and doesn't have placeholder values

### Bug #6: Synthetic "Forced Insert" Rows Added on Fallback
**File**: `src/modules/itineraries/itineraries.service.ts` - `previewManualHotspot()`

**Problem**: When adaptive scheduling failed (`adaptive.scheduled===false`), the code was adding a synthetic "Forced insert" row with fake times to the timeline. This was duplicating the hotspot in the result.

**Fix**: Removed the entire `if (!adaptive.scheduled) { ... add synthetic row ... }` block. The fallback branch of `previewManualHotspotAdd()` now properly returns the hotspot marked as conflict.

### Bug #7: addManualHotspot() Not Validating Success State
**File**: `src/modules/itineraries/itineraries.service.ts` - `addManualHotspot()`

**Problem**: When `adaptive.scheduled===true` but the hotspot was missing from the result snapshot, the code would silently fall back to reading from the persisted DB (which might have stale/placeholder values).

**Fix**: Added explicit validation that throws an error if adaptive succeeded but hotspot is missing:
```typescript
if (adaptive.scheduled && !snapped) {
  throw new Error(
    `Adaptive insertion succeeded but newHotspot is missing from resolved snapshot. ` +
    `Indicates a bug in the rebuild process.`
  );
}
```

### Bug #8: Added Verification That Manual Hotspots Are Properly Persisted
**File**: `src/modules/itineraries/engines/hotspot-engine.service.ts` - `rebuildRouteHotspots()`

**Problem**: Even after fixes, there was no verification that manual hotspots were properly persisted with real values.

**Fix**: Added post-persistence verification that manually hotspots have:
- Real `hotspot_order` (not 999)
- Real timestamps (not 1970-01-01)

Throws an error if verification fails, preventing silent data corruption.

## Changed Files

### 1. `src/modules/itineraries/engines/hotspot-engine.service.ts`

**Method: `rebuildRouteHotspots()`**
- Added: Old placeholder manual row deletion (lines ~370-385)
- Added: Final timeline deduping (lines ~387-429)
- Added: Chronological sorting with item_type priority (lines ~431-468)
- Added: Sequential hotspot_order reassignment (lines ~470-491)
- Added: Manual hotspot persistence verification (lines ~530-560)
- **Result**: Clean, deduplicated, sorted, and normalized timeline before persistence

**Method: `previewManualHotspotAdd()`**
- Enhanced success branch: Validates selected hotspot exists and has real values (lines ~703-753)
- Fixed fallback branch: Reads persisted rows, marks as conflict, no synthetic rows (lines ~755-818)
- **Result**: Both branches return accurate timeline from persisted state

### 2. `src/modules/itineraries/itineraries.service.ts`

**Method: `previewManualHotspot()`**
- Removed: Synthetic "Forced insert" row injection on fallback
- **Result**: No duplicate hotspots in preview result

**Method: `addManualHotspot()`**
- Added: Explicit validation that adaptive success state matches snapshot state
- **Result**: Fails fast if rebuild inconsistency detected

## Business Logic Preserved

1. **Manual hotspots remain user-selected**: `hotspot_plan_own_way=1` flag preserved
2. **Priority semantics unchanged**: Auto hotspots with priority > 3 can be removed to fit manual
3. **Adaptive scheduling**: Still attempts to find valid timing
4. **Fallback behavior**: Marks as conflict but returns for user confirmation
5. **Preview rollback**: Preview transaction still rolls back, only confirm persists

## Validation and Testing

Created verification script: `verify-manual-hotspot-fix.ts`

Tests verify:
1. ✅ No placeholder `order=999` in final results
2. ✅ Real timestamps (year > 1970) in final results
3. ✅ Timeline sorted chronologically
4. ✅ No duplicate hotspots
5. ✅ Travel rows before attractions at same time

Run with: `npx ts-node verify-manual-hotspot-fix.ts`

## Expected Outcomes

### Before Fix
- Manual hotspot appeared with `order=999` and `start_time=1970-01-01T00:00:00Z`
- Duplicate Santhome rows in timeline
- Travel row appearing after attraction row
- Preview/confirm/details endpoints returning different states

### After Fix
- Manual hotspot has real `order` (1-10 typically) and real timestamps
- Manual hotspot appears **exactly once** in timeline
- Strict chronological ordering maintained
- Travel row always before attraction row
- Preview, confirm, and details return matching states

## Integration Points

The fix touches the complete hotspot timeline flow:

```
ensureManualHotspotRow() → manual placeholder created
         ↓
previewManualHotspot() → calls adaptive insertion
         ↓
runAdaptiveManualHotspotInsertion() → calls rebuildRouteHotspots()
         ↓
rebuildRouteHotspots() → [FIXED] delete old rows, dedupe, sort, reassign order
         ↓
previewManualHotspotAdd() → [FIXED] read from persisted rebuilt timeline
         ↓
addManualHotspot() → [FIXED] validate success, extract from persisted state
```

All endpoints now return consistent, properly-ordered timelines with manual hotspots fully integrated.
