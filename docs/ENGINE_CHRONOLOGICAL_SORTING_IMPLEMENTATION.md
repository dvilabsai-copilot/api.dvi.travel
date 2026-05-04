# EXPERIMENTAL: ENGINE-LEVEL CHRONOLOGICAL SORTING IMPLEMENTATION (Phase 2)

**Commit**: a954ab4  
**Branch**: `itinerary-segment-chronological-fix`  
**Affected Quote**: DVI202604230  
**Date**: 2025 Implementation Build  

---

## 🎯 Objective

Move chronological sorting from API read-layer to **engine write-path**, ensuring database persists rows in semantically correct order rather than insertion order.

---

## ✅ WHAT WAS IMPLEMENTED

### 1. Engine-Level Chronological Sorting

**File**: `src/modules/itineraries/engines/hotspot-engine.service.ts`  
**Function**: `rebuildRouteHotspots()`  
**Lines**: 472-493

The engine now:
1. Collects all hotspot rows from timeline builder
2. **Deduplicates** exact duplicates (same route + type + hotspot + timing)
3. **Sorts chronologically** by `hotspot_start_time` (ascending)
4. **Priority tiebreaker** when times are equal:
   - START (1) → TRAVEL_INTRA (3) → ATTRACTION (4) → TRAVEL_TO_HOTEL (5) → HOTEL_CHECKIN (6)
5. **Reassigns `hotspot_order`** sequentially per route after sort
6. **Persists** the sorted array via `createMany()`

### 2. Manual Hotspot Preservation

**Lines**: 250-430

- Extracts pre-existing manual hotspots (hotspot_plan_own_way=1) before deletion
- Reinserts them at correct chronological position within timeline
- Preserves manual hotspot IDs across rebuild
- Assigns proper `hotspot_order` based on final sorted position

### 3. Timeline Builder Integration

**Files Modified**:
- `helpers/timeline.builder.ts` — Row generation
- `helpers/timeline.enricher.ts` — Row enrichment
- `helpers/timeline.hotspot-selector.ts` — Hotspot selection
- `helpers/timeline.scoring.ts` — Scoring for conflict resolution

These helpers now support the engine's sorting and deduplication logic.

---

## 📊 DATABASE IMPACT

### Before Fix
```
Route 1242 DB Order (insertion):
1. START          08:00-09:00
2. TRAVEL         09:00-09:30
3. ATTRACTION     09:30-10:30
4. TRAVEL         10:30-10:44  
5. ATTRACTION     10:44-11:44
... (same route order)

Row order matches insertion sequence, not necessarily chronological sequence.
```

### After Fix (Expected)
```
Route 1242 DB Order (chronological):
1. START          08:00-09:00
2. TRAVEL         09:00-09:30
3. ATTRACTION     09:30-10:30
4. TRAVEL         10:30-10:44  
5. ATTRACTION     10:44-11:44
... (sorted by hotspot_start_time)

hotspot_order: 1, 2, 1, 3, 2... (sequential per item_type=4)
```

---

## 🧪 TESTING PLAN

### Step 1: Rebuild DVI202604230 via API

The local `hotspot-engine.service.ts` is now deployed. To trigger the fix:

**Option A - Via Itinerary API** (if rebuild endpoint exists):
```bash
POST /api/itineraries/rebuild/{itineraryId}
Body: { "planId": 268 }
```

**Option B - Trigger from Service**:
```javascript
// In ItinerariesService
const result = await this.hotspotEngine.rebuildRouteHotspots(tx, 268);
```

**Option C - Direct Database Query** (verify after API call):
```sql
SELECT route_hotspot_ID, itinerary_route_ID, item_type, hotspot_order,  hotspot_start_time, hotspot_end_time
FROM dvi_itinerary_route_hotspot_details
WHERE itinerary_plan_ID = 268 AND deleted = 0
ORDER BY itinerary_route_ID ASC, route_hotspot_ID ASC;
```

### Step 2: Verify Chronological Order

Run the debug script:
```bash
npx ts-node api.dvi.travel/debug-engine-row-order.ts
```

**Expected Output for Route 1242**:
- All segments listed in chronological time order
- No "out of order" warnings
- `hotspot_order` values sequential for attractions

**Expected Output for Route 1243**:
- All segments in chronological order
- ⚠️ **NOTE**: DROP_OFF may STILL exceed route_end_time (Route-end validation not yet implemented)

### Step 3: Verify hotspot_order Assignment

```sql
SELECT itinerary_route_ID, item_type, hotspot_order, hotspot_start_time
FROM dvi_itinerary_route_hotspot_details  
WHERE itinerary_plan_ID = 268 AND item_type = 4 AND deleted = 0
ORDER BY itinerary_route_ID, hotspot_order;
```

Should show: 1, 2, 3, 4, 5... (sequential per route)

### Step 4: Check API Response

Call itinerary-details endpoint:
```bash
GET /api/itineraries/details/268
```

The response should:
- ✅ Have segments already in chronological order (no API sorting applied)
- ✅ Map to DB row order (not require API's sort hack from Phase 1)

---

## ⚠️ KNOWN ISSUES (NOT YET FIXED)

### Issue #1: POST-ROUTE-END DROP_OFF
**Status**: ❌ Not fixed in engine  
**Current State**: Route 1243 has DROP_OFF (20:20-21:21) exceeding route_end_time (20:00) by 81 minutes  
**Location**: Currently filtered in API response layer (lines 1450-1483 in `itinerary-details.service.ts`)  
**Needs**: Engine-level validation before createMany()

### Issue #2: Hotel Travel Reversed Times
**Status**: ❌ Not fixed in engine  
**Current State**: TRAVEL_TO_HOTEL persisted as (20:36 - 20:00), start > end  
**Location**: Currently anchored in API response layer (lines 1398-1412)  
**Needs**: Timeline builder to calculate correct arrival-based times

### Issue #3: Manual Hotspot Duration
**Status**: ⚠️ Partial - Code notes "END TIME EQUALS START TIME - THIS IS A BUG"  
**Location**: Lines 380-385 in `hotspot-engine.service.ts`  
**Note**: Manual hotspots inserted with zero duration (manualEndTime = manualStartTime)

---

## 📋 REMAINING PHASE 2 TASKS

### Task 1: Route-End Time Validation ⏳
**Priority**: HIGH  
**Scope**: Filter/mark rows that exceed route_end_time BEFORE persistence  
**Location**: `hotspot-engine.service.ts` - Add validation after sort, before createMany  
**Code**: Check each row's `hotspot_end_time` against route's `route_end_time`  
**Action**: Either mark `is_conflict=1` or skip row entirely

### Task 2: Hotel Travel Semantics ⏳
**Priority**: HIGH  
**Scope**: Fix TRAVEL_TO_HOTEL row timing to use actual arrival  
**Location**: `helpers/timeline.builder.ts` - Travel row generation  
**Current Issue**: Uses constant travel time, not actual arrival  
**Action**: Extract arrival time from route segment data, use for both start and end of travel

### Task 3: Timing Validation Safeguards ⏳
**Priority**: MEDIUM  
**Scope**: Ensure no row has end_time < start_time before DB write  
**Location**: `hotspot-engine.service.ts` - Validate before createMany  
**Current Issue**: Hotel travel can have reversed times due to route boundary wrapping  
**Action**: Add validation step to detect and log/fix reversed times

### Task 4: Remove API Sorting Hack ⏳
**Priority**: LOW (after tasks 1-3 validated)  
**Scope**: Remove sorting code from `itinerary-details.service.ts` (lines 1646-1690)  
**Condition**: Only safe to remove once engine sorting is deployed and verified  
**Note**: Keep as safety net until confident in engine fix

---

## 🔍 CODE LOCATIONS

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| Engine entry point | hotspot-engine.service.ts | 24-70 | Main function, delete old rows |
| Timeline build | hotspot-engine.service.ts | 75-85 | Call timeline builder |
| Conflict detection | hotspot-engine.service.ts | 100-200 | Identify conflicts |
| Manual extraction | hotspot-engine.service.ts | 47-60 | Extract manual hotspots |
| Manual reinsertion | hotspot-engine.service.ts | 250-430 | Reinsert at correct position |
| Deduplication | hotspot-engine.service.ts | 441-465 | Remove exact duplicates |
| **SORTING** | **hotspot-engine.service.ts** | **472-493** | **Chronological sort** ✅ |
| hotspot_order reassignkey | hotspot-engine.service.ts | 500-517 | Sequential per route |
| Database write | hotspot-engine.service.ts | 522-597 | createMany persistence |

---

## 📝 DEPLOYMENT NOTES

1. **Current Status**: Code is committed but NOT YET TESTED with full itinerary rebuild
2. **Required Test**: Run debug script after engine changes deployed
3. **Risk Level**: MEDIUM - Large refactoring of hotspot engine
4. **Rollback Plan**: Can revert commit a954ab4 if issues found
5. **Safety Net**: API read-layer sorting still active (lines 1646-1690)

---

## 🚀 NEXT STEPS

1. Deploy engine code to staging/development environment
2. Run debug script: `npx ts-node debug-engine-row-order.ts`
3. Verify DVI202604230 rows persisted in chronological order
4. Implement Tasks 1-3 (route-end, hotel semantics, timing validation)
5. Re-test after each task
6. Remove API workaround once all engine tasks complete

---

## 📌 RELATED DOCUMENTATION

- **Phase 1 Fix**: [ITINERARY_SEGMENT_FIX_IMPLEMENTATION_COMPLETE.md](ITINERARY_SEGMENT_FIX_IMPLEMENTATION_COMPLETE.md) - API read-layer sorting
- **Root Cause Analysis**: [ITINERARY_FINAL_SEGMENT_FIX_PLAN.md](ITINERARY_FINAL_SEGMENT_FIX_PLAN.md) - Problem identification
- **Quick Reference**: [ITINERARY_SEGMENT_FIX_QUICK_REFERENCE.md](ITINERARY_SEGMENT_FIX_QUICK_REFERENCE.md) - Deployment guide

---

## ✨ SUMMARY

This commit implements **ONE OF FOUR** engine-level fixes requested:

| Fix | Status | Location |
|-----|--------|----------|
| 1. Chronological Sorting | ✅ **DONE** | Engine write-path (sortedRows) |
| 2. Route-End Validation | ⏳ TODO | Engine validation before write |
| 3. Hotel Semantics | ⏳ TODO | Timeline builder row generation |
| 4. Timing Safeguards | ⏳ TODO | Engine validation pass |

**The database is now positioned to write rows in correct semantic order. Remaining fixes address boundary violations and semantic accuracy.**
