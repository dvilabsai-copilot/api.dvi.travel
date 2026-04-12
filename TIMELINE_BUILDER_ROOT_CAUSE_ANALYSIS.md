# ROOT CAUSE ANALYSIS: Timeline Builder Semantic Errors

## CORE PROBLEM: Wrapped-Time Logic in Calculations

**Location**: `timeline.builder.ts` and `time.helper.ts`

**Issue**: The code uses `secondsToTime()` which applies `% 86400` wrapping during intermediate calculations, not just at DB storage.

### Example of the Bug

```typescript
// Line 1210 in buildTimelineForPlan:
let absoluteVisitStartSeconds = currentTimeSeconds + travelDurationSeconds;
let timeAfterTravel = secondsToTime(absoluteVisitStartSeconds);  // ← WRAPS HERE!

// If absoluteVisitStartSeconds = 90000 (25 hours = 1:00:00 next day)
// secondsToTime(90000) returns "01:00:00" (wrapped!)
// But this loses the "it's tomorrow" information

// Then:
currentTime = timeAfterTravel;  // ← Now currentTime is "01:00:00" (wrapped)

// Next iteration uses this for distance calculation:
const projectedArrivalSeconds = absoluteVisitEndSeconds + travelToDestSeconds;
// But absoluteVisitEndSeconds was calculated from wrapped currentTime!
// So all abs olute time tracking is corrupted.
```

## FIVE CORRELATED BUGS

### Bug #1: TRAVEL Row Timing
**Symptom**: Travel row has incorrect start/end times  
**Root Cause**: `timeAfterTravel` is wrapped, loses absolute time context  
**Fix**: Keep absolute seconds throughout, only wrap at DB write

### Bug #2: TRAVEL_TO_HOTEL Reversed Times
**Symptom**: TRAVEL_TO_HOTEL has start > end (e.g., 20:36 - 20:00)  
**Root Cause**: Hotel start time calculated from already-wrapped times  
**Location**: Line 2289 `const hotelStartTime = currentTime;`  
**Fix**: Pass absolute execution time, not wrapped display time

### Bug #3: CHECKIN Wrong Time
**Symptom**: Checkin set to route_end_time instead of arrival time  
**Root Cause**: Using wrapped times for checkin calculation  
**Location**: Lines 2323-2333  
**Fix**: Use actual TRAVEL_TO_HOTEL end time for checkin

### Bug #4: Post-Route-End Rows Still Created
**Symptom**: Rows exceeding route_end_time persist to DB  
**Root Cause**: No route-end validation before createMany()  
**Location**: Missing validation before line 2376 (createMany call)  
**Fix**: Add validation gate before row persistence

### Bug #5: Semantic Inconsistency
**Symptom**: TRAVEL row created AFTER attraction in some flows  
**Root Cause**: Gap-filling logic (lines 1624-1700) inserts rows with fractional orders  
**Fix**: Ensure travel ALWAYS precedes attraction in final sorted output

---

## REQUIRED CHANGES TO timeline.builder.ts

### Change #1: Track Both Absolute and Wrapped Times

**Current (Wrong)**:
```typescript
let absoluteVisitStartSeconds = currentTimeSeconds + travelDurationSeconds;
let timeAfterTravel = secondsToTime(absoluteVisitStartSeconds);  // ← WRONG
currentTime = timeAfterTravel;  // ← Now absolute tracking is lost
```

**Fixed**:
```typescript
let absoluteVisitStartSeconds = currentTimeSeconds + travelDurationSeconds;
let absoluteVisitEndSeconds = absoluteVisitStartSeconds + hotspotDurationSeconds;

// Keep currentTime as SECONDS for all calculations
let currentTimeSeconds = absoluteVisitEndSeconds;

// Only wrap when DISPLAYING or RETURNING:
let timeAfterTravel = secondsToTime(wrapToDay(absoluteVisitStartSeconds));
let timeAfterSightseeing = secondsToTime(wrapToDay(absoluteVisitEndSeconds));

// Travel builder gets absolute seconds converted to time string
const travelStartTime = secondsToTime(wrapToDay(previousSegmentEndSeconds));
const travelEndTime = secondsToTime(wrapToDay(absoluteVisitStartSeconds));
```

### Change #2: Fix Hotel Travel Calculation

**Current (Wrong)**:
```typescript
const hotelStartTime = currentTime;  // ← This is wrapped!
const { row: toHotelRow, nextTime: tAfterHotel } =
  await this.hotelBuilder.buildToHotel(tx, {
    startTime: hotelStartTime,  // ← Wrapped time goes to builder!
    ...
  });
```

**Fixed**:
```typescript
// Use absolute seconds, only wrap for display
const hotelStartSeconds = currentTimeSeconds;  // ← ABSOLUTE
const hotelStartTime = secondsToTime(wrapToDay(hotelStartSeconds));

const { row: toHotelRow, nextTime: tAfterHotel } =
  await this.hotelBuilder.buildToHotel(tx, {
    startTime: hotelStartTime,
    startTimeSeconds: hotelStartSeconds,  // ← Also pass absolute for builder
    ...
  });

// Update absolute time tracking:
const hotelEndSeconds = /* calculated from buildToHotel result */;
currentTimeSeconds = hotelEndSeconds;
```

### Change #3: Fix Checkin Time Anchoring

**Current (Wrong)**:
```typescript
// Uses route-end-time cutoff
const hotelCutoffSeconds = routeEndSeconds;
const adjustedHotelRow.hotspot_end_time = TimeConverter.toDate(secondsToTime(hotelCutoffSeconds));
```

**Fixed**:
```typescript
// Use actual travel end time (arrival at hotel)
const hotelArrivalSeconds = /* from hotelBuilder result, absolute */;
const checkinTime = secondsToTime(wrapToDay(hotelArrivalSeconds));

// Enforce cutoff ONLY if arrival exceeds route end
let finalCheckinSeconds = hotelArrivalSeconds;
if (hotelArrivalSeconds > routeEndSeconds) {
  finalCheckinSeconds = routeEndSeconds;
  // Log this as violation
}

adjustedHotelRow.hotspot_end_time = TimeConverter.toDate(secondsToTime(wrapToDay(finalCheckinSeconds)));
```

### Change #4: Add Route-End Validation Before Write

**Location**: After line 2370 (before createMany),  add:

```typescript
// Validate all rows before persistence
const validatedRows: HotspotDetailRow[] = [];
for (const row of hotspotRows) {
  const startSeconds = row.hotspot_start_time ? timeToSeconds(row.hotspot_start_time) : 0;
  const endSeconds = row.hotspot_end_time ? timeToSeconds(row.hotspot_end_time) : 0;
  
  // Check if row exceeds route end
  if (endSeconds > routeEndSeconds && row.item_type !== 7) { // Allow DROP_OFF
    console.log(`[TimelineBuilder][PROOF] Route-end violation detected`, {
      routeId: row.itinerary_route_ID,
      itemType: row.item_type,
      rowEndSeconds: endSeconds,
      routeEndSeconds,
      excessMinutes: Math.floor((endSeconds - routeEndSeconds) / 60),
    });
    
    // Mark as conflict instead of silently persisting
    row.is_conflict = 1;
    row.conflict_reason = `Row end time exceeds route_end_time by ${Math.floor((endSeconds - routeEndSeconds) / 60)} minutes`;
  }
  
  validatedRows.push(row);
}

// Then persist validatedRows instead of hotspotRows
```

### Change #5: Refactor currentTime Tracking

**Pattern**: Replace all uses of wrapping in intermediate calculations:

```typescript
// OLD PATTERN:
let currentTime = "09:00:00";  // ← String
// ... calculation ...
currentTime = addSeconds(currentTime, 3600);  // addSeconds wraps!

// NEW PATTERN:
let currentTimeSeconds = timeToSeconds("09:00:00");  // ← Absolute number
// ... calculation ...
currentTimeSeconds += 3600;  // ← Just arithmetic
// Convert to time string ONLY when needed:
const displayTime = secondsToTime(wrapToDay(currentTimeSeconds));
const absoluteTime = currentTimeSeconds;  // Keep absolute reference
```

---

## IMPLEMENTATION PRIORITY

1. **CRITICAL**: Change #1 - Stop wrapping during calculations (affects everything)
2. **CRITICAL**: Change #2 - Fix hotel travel start time
3. **CRITICAL**: Change #3 - Fix checkin anchoring
4. **HIGH**: Change #4 - Add route-end validation
5. **HIGH**: Change #5 - Systemize absolute time tracking

---

## SUCCESS CRITERIA

After implementing all changes:

1. ✅ No `currentTime` variable exists as wrapped string
2. ✅ All `currentTime` is tracked in seconds (absolute)
3. ✅ Time strings (`HH:MM:SS`) only created for:
   - Arguments to builders (who expect string format)
   - Database persistence (via TimeConverter.toDate)
   - Debug logging
4. ✅ All distance calculations use absolute seconds
5. ✅ TRAVEL_TO_HOTEL has start <= end
6. ✅ CHECKIN time = TRAVEL_TO_HOTEL end time
7. ✅ No rows exceed route_end_time without is_conflict flag
8. ✅ TRAVEL row always created before ATTRACTION row in final DB

---

## MANDATORY DEBUG LOGS

Add `[TimelineBuilder][PROOF]` logs at:

1. **Line ~1210**: Travel time calculation
   ```typescript
   console.log('[TimelineBuilder][PROOF] Travel time calculation', {
     routeId,
     hotspotId,
     segmentNumber,
     previousEndAbsolute: previousSegmentEndSeconds,
     travelDuration: travelDurationSeconds,
     computedArrivalAbsolute: absoluteVisitStartSeconds,
     wrappedForDB: secondsToTime(wrapToDay(absoluteVisitStartSeconds)),
   });
   ```

2. **Line ~2289**: Hotel travel
   ```typescript
   console.log('[TimelineBuilder][PROOF] Hotel travel calculation', {
     routeId,
     lastAttractionEnd: currentTimeSeconds,
     hotelTravelStart: hotelStartSeconds,
     hotelTravelEnd: hotelArrivalSeconds,
     wrappedForDB: secondsToTime(wrapToDay(hotelArrivalSeconds)),
   });
   ```

3. **Line ~2325**: Checkin
   ```typescript
   console.log('[TimelineBuilder][PROOF] Checkin anchoring', {
     routeId,
     hotelArrivalAbsolute: hotelArrivalSeconds,
     checkinTime: secondsToTime(wrapToDay(finalCheckinSeconds)),
     routeEndSeconds,
     violation: finalCheckinSeconds > routeEndSeconds,
   });
   ```
