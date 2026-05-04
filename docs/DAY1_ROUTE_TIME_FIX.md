# Day 1 Route Time Override Bug Fix

## Problem Statement

The itinerary rebuild engine was forcing Day 1 routes to start at 08:00 AM and end at 20:00 (8 PM) even when users manually updated route times via the API endpoint:

```
PATCH /api/v1/itineraries/:planId/route/:routeId/times
```

### Example Cases
- **Case 1**: User sets `startTime: 12:00:00`, `endTime: 20:00:00`  
  Expected: Timeline begins from 12 PM  
  Actual: Timeline forced to 08:00 AM - 20:00 PM

- **Case 2**: User sets `startTime: 13:00:00`, `endTime: 20:00:00`  
  Expected: Timeline begins from 1 PM  
  Actual: Timeline forced to 08:00 AM - 20:00 PM

## Root Cause

In `src/modules/itineraries/engines/helpers/timeline.builder.ts`:

**Lines 605-607** (REMOVED):
```typescript
// WRONG: Generic forced 08:00 override regardless of user intent
if (isFirstRoute && !isLastRoute && timeToSeconds(routeStartTime) > timeToSeconds('08:00:00')) {
  effectiveRouteStartTime = '08:00:00';
}
```

**Lines 623-630** (REMOVED):
```typescript
// WRONG: Generic forced 20:00 override regardless of user intent
if (isFirstRoute && !isLastRoute) {
  routeEndSeconds = timeToSeconds('20:00:00');
  if (routeEndSeconds < routeStartSeconds) {
    routeEndSeconds += 86400;
  }
}
```

### Why This Was Wrong

1. These overrides happened **before** the arrival policy evaluation
2. They ignored the **source of truth**: manually updated `route_start_time` and `route_end_time` in the database
3. They were meant as "PHP parity" but broke user control over custom times
4. They prevented legitimate use cases like:
   - Manual noon starts (post-lunch tourism)
   - Manual afternoon starts (evening tours)
   - Custom end times (flexible itineraries)

## Solution

### Change 1: Remove Generic Route Start Time Override

**File**: `src/modules/itineraries/engines/helpers/timeline.builder.ts`  
**Lines**: 605-630 (consolidated)

**BEFORE**:
```typescript
// PHP parity: first route scheduling starts at 08:00 for hotspot gating/walk,
// even when generated route_start_time is later (e.g., 12:00).
let effectiveRouteStartTime = routeStartTime;
if (isFirstRoute && !isLastRoute && timeToSeconds(routeStartTime) > timeToSeconds('08:00:00')) {
  effectiveRouteStartTime = '08:00:00';
}

// Use route's configured end time (no hardcoded cutoffs)
// Users can adjust end time as needed

let currentTime = effectiveRouteStartTime;
let routeEndSeconds = timeToSeconds(routeEndTime);

// Handle overnight routes: if end time < start time, add 24 hours to end
const routeStartSeconds = timeToSeconds(effectiveRouteStartTime);
if (routeEndSeconds < routeStartSeconds) {
  routeEndSeconds += 86400; // Add 24 hours in seconds
}

// DAY 1 SPECIAL: Override end time to 8 PM (20:00) for proper structure
if (isFirstRoute && !isLastRoute) {
  routeEndSeconds = timeToSeconds('20:00:00');
  if (routeEndSeconds < routeStartSeconds) {
    routeEndSeconds += 86400;
  }
}
```

**AFTER**:
```typescript
// RULE: Use saved routeStartTime and routeEndTime from database as source of truth.
// These are set by user manual edits via PATCH /api/v1/itineraries/:planId/route/:routeId/times
// Do NOT override with hardcoded times here.
// Conditional overrides (e.g., early-arrival deferred flow) are applied later after arrival policy evaluation.
let effectiveRouteStartTime = routeStartTime;

let currentTime = effectiveRouteStartTime;
let routeEndSeconds = timeToSeconds(routeEndTime);

// Handle overnight routes: if end time < start time, add 24 hours to end
const routeStartSeconds = timeToSeconds(effectiveRouteStartTime);
if (routeEndSeconds < routeStartSeconds) {
  routeEndSeconds += 86400; // Add 24 hours in seconds
}
```

### Key Changes

1. **Removed** generic `if (isFirstRoute && !isLastRoute && timeToSeconds(routeStartTime) > timeToSeconds('08:00:00'))` override
2. **Removed** generic `if (isFirstRoute && !isLastRoute)` route end time override
3. **Preserved** conditional 08:00 override for deferred flow (see below)

### Change 2: Preserve Conditional Override for Deferred Flow

The fix **keeps** the CONDITIONAL 08:00 override at lines 758-760:

```typescript
const enforceStrictDay1EarlyArrivalDeferredFlow = suppressHotelInsertionUntilEndOfDay;

if (enforceStrictDay1EarlyArrivalDeferredFlow) {
  // Hard policy rule: Day-1 deferred hotel flow must begin with 08:00-09:00 buffer.
  effectiveRouteStartTime = '08:00:00';
}
```

**This is correct** because:
- Only applies when `enforceStrictDay1EarlyArrivalDeferredFlow === true`
- Controlled by arrival policy evaluation (not generic condition)
- Runs AFTER manual times are read from database
- Respects the user's explicit control for deferred flow scenarios

## Test Scenarios

### Scenario 1A: Sightseeing-first with manual noon start
```
Input:
  - startTime = 12:00:00
  - endTime = 20:00:00
  - Arrival policy: NOT deferred flow

Expected Output:
  ✓ Timeline begins from 12:00 PM
  ✓ First segment respects manual start time
  ✓ No forced 08:00 reset
```

### Scenario 1B: Hotel-first with manual afternoon start
```
Input:
  - startTime = 13:00:00
  - endTime = 20:00:00
  - Arrival policy: NOT deferred flow

Expected Output:
  ✓ Timeline begins from 1:00 PM
  ✓ Hotel/check-in logic follows 1 PM anchor
  ✓ No forced 08:00 reset
```

### Scenario 2: Early-arrival deferred flow (EXCEPTION CASE)
```
Input:
  - routeStartTime = 04:00:00
  - Arrival time < 08:00 AM
  - Previous-day billing declined
  - Same-city stay

Expected Output:
  ✓ enforceStrictDay1EarlyArrivalDeferredFlow = true
  ✓ effectiveRouteStartTime reset to 08:00 (CORRECT BEHAVIOR)
  ✓ 08:00–09:00 buffer still works
  ✓ First sightseeing from 09:00 AM still works
```

### Scenario 3: Last route
```
Input:
  - Route is departure/final transfer
  - routeStartTime = any value

Expected Output:
  ✓ Uses actual routeStartTime without override
  ✓ isLastRoute check prevents generic overrides
```

### Scenario 4: Multi-day itinerary Day 2+
```
Input:
  - isFirstRoute = false
  - routeStartTime = any value

Expected Output:
  ✓ No generic override applies
  ✓ Uses actual routeStartTime
```

## Regression Safety

### What Still Works (No Regressions)

1. **Early-arrival deferred flow**
   - Still gets 08:00 override (controlled by `enforceStrictDay1EarlyArrivalDeferredFlow`)
   - Still gets 09:00 first sightseeing (via `firstSightseeingMovementTime`)
   - No breaks to existing early-arrival quotes

2. **Hotspot scheduling**
   - Uses `effectiveRouteStartTime` for bucket cutoffs
   - Uses `routeStartSeconds` for gap calculations
   - All time-based gating still works

3. **Hotel insertion**
   - Uses arrival policy evaluation
   - Uses distance-based logic
   - All flows (hotel-first, hotel-last, deferred) still work

4. **Final validation**
   - Lines 2840+ use stored route times to validate no segments exceed route bounds
   - Independent of `effectiveRouteStartTime` overrides
   - Correctly rejects any rows outside [route_start_time, route_end_time]

### Testing Confidence

The fix is **low-risk** because:
- Only removes generic overrides (which were causing the bug)
- Keeps conditional override for legitimate deferred flow
- Doesn't change any other time-based logic
- Final validation layer is independent

## Files Changed

| File | Change | Lines |
|------|--------|-------|
| `timeline.builder.ts` | Remove generic overrides | 605-630 |
| Test validation | Added scenario tests | N/A |

## Commit Message

```
fix: respect user-updated route times instead of forcing 08:00/20:00

BREAKING: Removes generic Day 1 route time overrides that were breaking
manual route time edits via PATCH /api/v1/itineraries/:planId/route/:routeId/times

BEHAVIOR CHANGE:
- Day 1 timelines now use actual saved route times as source of truth
- Manual noon/afternoon starts now respected (no forced 08:00 reset)
- Custom end times now respected (no forced 20:00 override)

PRESERVED:
- Early-arrival deferred flow still gets 08:00–09:00 buffer
- Hotspot scheduling logic unchanged
- All arrival policy evaluations work correctly
- Final validation still checks route time bounds

Fixes: quotes with manual route time updates now rebuild correctly
```

## Verification Steps

1. **Build**: `npm run build` ✓ No TypeScript errors
2. **Manual Test**: Set `route_start_time = 12:00:00`, rebuild, verify timeline starts at 12 PM
3. **Regression Test**: Run early-arrival quotes, verify 08:00–09:00 buffer still works
4. **Integration Test**: Run full itinerary test suite for Day 1 quotes
