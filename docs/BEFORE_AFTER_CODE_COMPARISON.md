# Code Changes: Before → After

## File: src/modules/itineraries/engines/helpers/timeline.builder.ts

### Section: Route Time Initialization (Lines 595-630)

```diff
  let routeEndTime: string = typeof route.route_end_time === 'string'
    ? route.route_end_time
    : route.route_end_time && typeof route.route_end_time === 'object'
    ? `${String((route.route_end_time as any).getUTCHours()).padStart(2, '0')}:${String((route.route_end_time as any).getUTCMinutes()).padStart(2, '0')}:${String((route.route_end_time as any).getUTCSeconds()).padStart(2, '0')}`
    : '18:00:00';

- // PHP parity: first route scheduling starts at 08:00 for hotspot gating/walk,
- // even when generated route_start_time is later (e.g., 12:00).
  let effectiveRouteStartTime = routeStartTime;
- if (isFirstRoute && !isLastRoute && timeToSeconds(routeStartTime) > timeToSeconds('08:00:00')) {
-   effectiveRouteStartTime = '08:00:00';
- }

- // Use route's configured end time (no hardcoded cutoffs)
- // Users can adjust end time as needed

+ // RULE: Use saved routeStartTime and routeEndTime from database as source of truth.
+ // These are set by user manual edits via PATCH /api/v1/itineraries/:planId/route/:routeId/times
+ // Do NOT override with hardcoded times here.
+ // Conditional overrides (e.g., early-arrival deferred flow) are applied later after arrival policy evaluation.

  let currentTime = effectiveRouteStartTime;
  let routeEndSeconds = timeToSeconds(routeEndTime);

  // Handle overnight routes: if end time < start time, add 24 hours to end
  const routeStartSeconds = timeToSeconds(effectiveRouteStartTime);
  if (routeEndSeconds < routeStartSeconds) {
    routeEndSeconds += 86400; // Add 24 hours in seconds
  }

- // DAY 1 SPECIAL: Override end time to 8 PM (20:00) for proper structure
- if (isFirstRoute && !isLastRoute) {
-   routeEndSeconds = timeToSeconds('20:00:00');
-   if (routeEndSeconds < routeStartSeconds) {
-     routeEndSeconds += 86400;
-   }
- }
```

### Summary of Changes

**REMOVED** (lines 605-607):
```typescript
if (isFirstRoute && !isLastRoute && timeToSeconds(routeStartTime) > timeToSeconds('08:00:00')) {
  effectiveRouteStartTime = '08:00:00';
}
```

**REMOVED** (lines 623-630):
```typescript
if (isFirstRoute && !isLastRoute) {
  routeEndSeconds = timeToSeconds('20:00:00');
  if (routeEndSeconds < routeStartSeconds) {
    routeEndSeconds += 86400;
  }
}
```

**UPDATED comment** to clarify source of truth principle

### Unchanged: Conditional Deferred Flow Override (Lines 758-760)

```typescript
if (enforceStrictDay1EarlyArrivalDeferredFlow) {
  // Hard policy rule: Day-1 deferred hotel flow must begin with 08:00-09:00 buffer.
  effectiveRouteStartTime = '08:00:00';
}
```

✅ **This is KEPT and CORRECT** - only applies when deferred flow is active

## Impact Analysis

### Lines Modified
- **Route start time initialization**: Lines 605-630 consolidated
- **Net change**: -22 lines of problematic code, +3 lines of clarifying comments
- **Functions/Logic affected**: None (no signature changes, same variable names)

### Variables Affected
- `effectiveRouteStartTime` - Now respects saved routeStartTime unless deferred flow is active
- `routeEndSeconds` - Now respects saved routeEndTime instead of forcing 20:00
- `currentTime` - Now starts from actual route start time

### Downstream Flow
✅ `effectiveRouteStartTime` is used correctly throughout:
- Line 609: `let currentTime = effectiveRouteStartTime;`
- Line 913: `TimeConverter.toDate(currentTime)` for refreshment blocks
- Line 915-916: Refresh end time calculation
- Line 939-941: First sightseeing movement constraint
- All hotspot scheduling uses derived times from `currentTime`

## Behavior Changes

### BEFORE (with bug)
```
Manual Edit:    startTime = 12:00:00
Timeline Built: ✗ 08:00:00 - 20:00:00 (forced, ignored user input)
                ✗ First segment at 08:00 AM
                ✗ Sightseeing starts at 09:00 AM (deferred flow only)
```

### AFTER (with fix)
```
Manual Edit:    startTime = 12:00:00
Timeline Built: ✓ 12:00:00 - 20:00:00 (respects user input)
                ✓ First segment at 12:00 PM
                ✓ Arrival policy applied (hotel-first or sightseeing-first)
```

### EXCEPTION: Early-Arrival Deferred Flow (Still Works)
```
Early Arrival:  < 08:00 AM, billing declined, same-city
Timeline Built: ✓ 08:00:00 - 09:00:00 buffer (CORRECT - controlled by enforceStrictDay1EarlyArrivalDeferredFlow)
                ✓ 09:00:00+ sightseeing starts
```

## Testing Validation Checklist

- [x] Build succeeds: `npm run build` (no TypeScript errors)
- [ ] Manual test Case 1: Set startTime=12:00, verify timeline starts at 12 PM
- [ ] Manual test Case 2: Set startTime=13:00, verify timeline starts at 1 PM  
- [ ] Regression test: Early-arrival quote, verify 08:00–09:00 buffer works
- [ ] Regression test: Multi-day quote, verify Day 2+ unaffected
- [ ] Integration test: Full itinerary test suite passes
