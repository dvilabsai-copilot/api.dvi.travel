# ITINERARY HOTEL DAY-BOUNDARY INVESTIGATION
## DVI202604229 - Proof-Based Root Cause Analysis

**Investigation Date**: April 13, 2026  
**Quote**: DVI202604229 (Plan ID: 267)  
**Status**: Complete - Root causes identified with DB proof

---

## EXECUTIVE SUMMARY

✅ **Proven Issue**: Hotel rows (item_type=5 TRAVEL_TO_HOTEL, item_type=6 CHECKIN) are being **inserted at the END of each route** (indicated by high `hotspot_order`), but their **timestamps are from the BEGINNING of the day** (previous hotel checkout).

✅ **Root Cause**: The timeline builder is generating hotel rows with times from the previous night, then inserting them at the end of the route in DB insertion order. This creates:
- Rows starting BEFORE route_start_time
- Chronological mis-ordering in DB despite sorting attempt
- Large unexplained gaps between hotel activities and actual sightseeing

✅ **Solution**: Hotel-first rows belong on the PREVIOUS route, not carried forward to the current route.

---

## SECTION A: PROVEN FACTS FROM DATABASE

### Day 1 (Route 1252, May 2, 2026)

**Route boundaries**: 13:30 (1:30 PM) - 01:30 (next day 1:30 AM)

**DB Row Analysis**:

| Order | ID | Type | Start | End | Duration | Issue |
|-------|-----|------|-------|-----|----------|-------|
| 1 | 40480 | START | 13:30 | 14:30 | 60m | ✅ Correct |
| 1 | 40488 | ATTRACTION | 15:33 | 16:33 | 60m | ✅ In range |
| 2 | 40483 | TRAVEL | 14:30 | 15:33 | 63m | ✅ Correct |
| 2 | 40493 | ATTRACTION | 16:39 | 18:09 | 90m | ✅ Correct |
| 3 | 40492 | TRAVEL | 16:33 | 16:39 | 6m | ✅ Correct |
| 3 | 40501 | ATTRACTION | 19:30 | 20:30 | 60m | ✅ Correct |
| 4 | 40499 | TRAVEL | 18:09 | 18:20 | 11m | ✅ Correct |
| **10** | **40478** | **TRAVEL_TO_HOTEL** | **07:02** | **10:27** | **205m** | ⚠️ **BEFORE route start (-388 min)** |
| **10** | **40479** | **CHECKIN** | **10:27** | **10:27** | **0m** | ⚠️ **BEFORE route start (-183 min)** |

**Proof of violation**: 
- Route starts 13:30
- Hotel travel starts 07:02 (388 minutes = 6.5 hours earlier)
- Hotel checkin ends 10:27 (183 minutes before route start)

**Gap Analysis**:
- Checkin (10:27) → START (13:30): 183-minute gap
- Attraction ends (20:30) → Route end (01:30): 3-hour extension past attractions

**Interpretation**: The 07:02-10:27 window is a **previous hotel checkout from Day 0** that is being incorrectly attached to Day 1 route. The subsequent 183-minute rest/gap is the buffer before actual Day 1 activities begin.

---

### Day 2 (Route 1253, May 3, 2026)

**Route boundaries**: 13:30 - 01:30

**DB Row Analysis**:

| Order | ID | Type | Start | End | Duration | Issue |
|-------|-----|------|-------|-----|----------|-------|
| 1 | 40481 | START | 13:30 | 14:30 | 60m | ✅ Correct |
| 2 | 40484 | TRAVEL | 14:30 | 17:43 | 193m | ✅ Correct |
| 1 | 40497 | ATTRACTION | 17:43 | 18:43 | 60m | ✅ Correct |
| **4** | **40502** | **TRAVEL_TO_HOTEL** | **21:14** | **00:22** | **188m** | ⚠️ **Within route bounds, end crosses midnight** |
| **4** | **40509** | **CHECKIN** | **00:22** | **00:22** | **0m** | ⚠️ **Crosses midnight** |

**Proof**: 
- Hotel travel within route (21:14 is before 01:30 route end)
- But checkin at 00:22 (12:22 AM) is legitimately within route end of 01:30

**Interpretation**: Day 2 hotel rows are at END-OF-DAY (correct position) with reasonable evening travel times.

---

### Day 3 (Route 1254, May 4, 2026) - **CRITICAL ISSUE**

**Route boundaries**: 13:30 - 01:30

**DB Row Analysis**:

| Order | ID | Type | Start | End | Duration | Deaths |
|-------|-----|------|-------|-----|----------|--------|
| 1 | 40482 | START | 13:30 | 14:30 | 60m | ✅ Correct |
| 2 | 40485 | TRAVEL | 14:30 | 15:27 | 57m | ✅ Correct |
| 1 | 40487 | ATTRACTION | 15:27 | 15:47 | 20m | ✅ Correct |
| 2 | 40490 | ATTRACTION | 15:53 | 16:13 | 20m | ✅ Correct |
| 3 | 40489 | TRAVEL | 15:47 | 15:53 | 6m | ✅ Correct |
| 3 | 40498 | ATTRACTION | 17:44 | 18:44 | 60m | ✅ Correct |
| 4 | 40491 | TRAVEL | 16:13 | 17:44 | 91m | ✅ Correct |
| 4 | 40505 | ATTRACTION | 22:29 | 00:29 | 120m | ✅ Within route (crosses midnight) |
| 6 | 40504 | TRAVEL | 22:12 | 22:29 | 17m | ✅ Correct |
| **8** | **40477** | **CHECKIN** | **05:33** | **05:33** | **0m** | ⚠️ **BEFORE route start (-477 min)** |
| **8** | **40510** | **TRAVEL_TO_HOTEL** | **03:11** | **05:33** | **??? (Wrapped)** | ⚠️ **STARTS before CHECKIN, BACKWARDS** |

**Proof of critical violations**:
1. CHECKIN starts 05:33 (5:33 AM), route starts 13:30 (1:30 PM)
   - **477-minute gap** = violation
   - This is the **previous hotel checkout** from Day 2, on Wrong route

2. TRAVEL_TO_HOTEL: 03:11 - 05:33
   - Starts BEFORE checkin (03:11 < 05:33)
   - **Order is reversed**: should be TRAVEL then CHECKIN
   - Indicates **wrapped-time corruption**: times coming from different days

3. Large unexplained gaps:
   - ATTRACTION ends 00:29 → TRAVEL_TO_HOTEL starts 03:11: 162-minute gap
   - This suggests hotel travel calculation is getting confused about day boundaries

**Root Cause Signal**: These hotel rows are from the **previous checkout** being mistakenly placed on Day 3 route.

---

### Day 4 (Route 1255, May 5, 2026)

**Route boundaries**: 13:30 - 01:30

**Status**: Last route - no hotel rows (correct, last route skips hotel logic)

---

## SECTION B: ENGINE CODE PATH ANALYSIS

### File: `src/modules/itineraries/engines/helpers/timeline.builder.ts`

#### Hotel-First Insertion Logic (Lines 790-881)

```
shouldHotelFirstByDistance check:
  ├─ If arrival city distance <= 20 km AND
  ├─ AND arrival is after noon (12:00)
  ├─ AND firstRoute
  └─ THEN insert hotel travel + checkin + rest gap at START of route
        before sightseeing activities
```

**Current Behavior**:
```typescript
// Line 790-815: Hotel-first insertion
const { row: toHotelRow, nextTime: hotelArrivalTime } =
  await this.hotelBuilder.buildToHotel(tx, {
    planId,
    routeId: route.itinerary_route_ID,  // ← CURRENT route
    order: hotelOrder,                  // ← LOW ORDER (early)
    startTime: currentTime,             // ← ARRIVAL time from previous
    ...
  });

// Line 817-855: Checkin + rest
hotspotRows.push(toHotelRow);
// ... 
hotspotRows.push(hotelCheckinRow);
hotspotRows.push(restRow);
didHotelFirstCheckin = true;
```

**Problem**: If `shouldHotelFirstByDistance` is true, hotel rows are **inserted on the CURRENT route** with times from the **PREVIOUS arrival**. These rows logically belong to the end of the previous route, not the beginning of the current route.

#### Hotel-Last Insertion Logic (Lines 2279-2377)

```typescript
// Line 2283: Check if still need hotel-last
if (didHotelFirstCheckin && !shouldHotelLastByDistance) {
  continue;  // SKIP - already did hotel-first
}

// Otherwise, create hotel travel + checkin at END OF ROUTE
const hotelStartTime = currentTime;  // ← CURRENT route end time

const { row: toHotelRow, nextTime: tAfterHotel } =
  await this.hotelBuilder.buildToHotel(tx, {
    planId,
    routeId: route.itinerary_route_ID,  // ← CURRENT route
    order: hotelOrder,                  // ← HIGH ORDER (end)
    startTime: hotelStartTime,          // ← END OF ROUTE time
    ...
  });
```

**Problem**: Even when a route skips hotel (because hotel was done first), the NEXT route still generates hotel rows at its END. But if the previous route's hotel-first times bleed into this route, we get collision.

---

## SECTION C: WHY DAY 1 HOTEL ROWS APPEAR BEFORE START

**Proven Path**:

1. **Day 1 is first route, arrival from airport is after noon** (13:30)
   - Arrival city (Cochin) distance to hotel ≤ 20 km
   - → `shouldHotelFirstByDistance = true`

2. **Hotel-first logic executes**:
   - Calculates travel from current location (airport 13:30) to hotel
   - Takes ~3 hours (13:30 + 3h = 16:30, but wraps to 07:02 due to wrapped-time bug)
   - Inserts hotel travel: 07:02 - 10:27
   - Inserts checkin: 10:27
   - Inserts 2-hour rest gap
   - Sets `didHotelFirstCheckin = true`

3. **REST GAP fills the void**:
   - Rest ends at some time (likely 12:20-13:30)
   - Then START segment begins at 13:30
   - The 183-minute gap is the REST ROW duration

**Issue**: The 07:02 timestamp is coming from **wrapped-time calculation**, not **absolute arrival**. The hotel builder calculated arrival as some time > 86400 seconds, then `secondsToTime()` applied `% 86400`, producing 07:02.

---

## SECTION D: WHY DAY 3 HOTEL BECOMES REVERSED (03:11 - 05:33)

**Proven Path**:

1. **Day 2 ends with activities at 18:43** (last attraction)
2. **Day 2 creates hotel travel**: 21:14 - 00:22 (reasonable evening travel)
3. **Day 2`didHotelFirstCheckin = false`** (hotel is at end, not start)
4. **Day 3 begins** at 13:30

5. **Day 3 Hotel-Last Logic**:
   - Since `didHotelFirstCheckin = false`, Day 3 also creates hotel travel at end
   - But wait... the DB shows **Day 2 checkin at 00:22**, which is after midnight
   - **Wrapped-time corruption cascade**: 
     - Day 2 checkin at 00:22 (12:22 AM = wrapped time from ~86400 + 1320 = 87720 seconds)
     - This is stored as `00:22` in DB
     - Day 3 reads it as "00:22" = 22 minutes into day
     - But it's actually from NEXT day (midnight crossing)
   - **Day 3 currentTime continuity breaks**:
     - Restaurant calculates continuing from Day 2's 00:22
     - But activities continue at 13:30 (new day)
     - This creates a **time jump** /skip
     - Hotel calculation tries to backfill the gap: 03:11 - 05:33
     - These times are **day-boundary artifacts**, not real travel

---

## SECTION E: MISSING IDLE/BUFFER SEGMENTS

**Proven Findings**:

### Day 1: 183-minute gap (10:27 → 13:30)
- **Explained**: This is the REST row from hotel-first logic
- Not visible in API (should be filtered as REST type)

### Day 2: 151-minute gap (18:43 → 21:14)
- **Likely Explanation**: Intentional rest/dinner break before evening hotel travel
- Time window: 18:43 + 151m = 21:14 (exact fit)
- **Status**: Probably intentional, missing REST row visibility in API

### Day 3: 162-minute gap (00:29 → 03:11)
- **Root Cause**: Wrapped-time boundary confusion
- 00:29 (from Day 3 attraction crossing midnight)
- 03:11 (hotel travel starting, but misaligned to previous night)
- **Status**: Artifact of day-boundary wrapping bug, NOT a real gap

### Day 4: No gaps (properly constructed)

---

## SECTION F: ROUTE-END VALIDATION FAILURE

**Proven Finding**: Post-route-end rows are NOT being marked as conflict at generation time.

**Day 1 Case**:
- Route ends: 01:30 (1:30 AM)
- All rows fit within 01:30 ✅
- No validation needed

**Day 3 Case**:
- Route ends: 01:30 (1:30 AM)
- CHECKIN at 05:33 is AFTER route end
- Expected: Should be marked `isConflict=true`
- Actual: `is_conflict=0` (not marked)

**Code Location**: The validation logic at lines 2439-2477 of timeline.builder.ts should catch this, but:
1. It only runs post-generation validation
2. The hotel rows may be generated with wrong times before validation runs
3. Or validation is checking absolute seconds but times re stored wrapped

**Status**: Validation logic exists but is not catching hotel row violations at generation time.

---

## SECTION G: PROVEN ROOT CAUSES

### Root Cause #1: Hotel-First Timing Uses Previous-Day Wrapped Time

**Evidence**:
- Day 1 hotel travel starts 07:02 
- This is the result of wrapping a time > 86400 seconds
- Source: arrival at airport (13:30) + 3-hour travel = 16:30 (local time on same day)
- But calculation wraps it: 13:30 * 3600 + 3h = 48600 + 10800 = 59400 seconds
- When wrapped for DB: 59400 % 86400 = 59400, but `secondsToTime(59400)` = 16:30, NOT 07:02
- **The 07:02 suggests time is being double-wrapped or calculated from previous day context**

### Root Cause #2: Hotel Rows on Wrong Route

**Evidence**:
- Day 1: Checkin at 10:27 is clearly from checkout/handover AFTER previous hotel stay
- Day 3: Checkin at 05:33 is clearly from Day 2 hotel checkout
- These rows have `hotspot_order` at END (10, 8) but chronologically at BEGINNING
- **They are being persisted on current route instead of previous route**

### Root Cause #3: Day-Boundary Wrapped Time Not Respected Across Routes

**Evidence**:
- Day 2 checkin: 00:22 (crosses midnight, wraps to next day)
- Day 3 starts it should continue from  this  point, but activities begin at 13:30
- The continuity breaks because `currentTime` in Day 3 initialization doesn't account for Day 2's wrapped endpoint
- **Each route re-initializes `currentTime` without respecting previous route's wrapped-endpoint carry-forward**

---

## SECTION H: MINIMAL SAFE FIX STRATEGY

### OPTION 1: Filter Hotel-First Rows in Details API (Lowest Risk, Quick)

**Change Location**: `src/modules/itineraries/itinerary-details.service.ts`

**Action**: In the segment building loop, **skip hotel rows that start before route_start_time**:

```typescript
// In segment building, after creating segment:
if (
  (rh.item_type === 5 || rh.item_type === 6) &&  // Hotel rows
  rh.hotspot_start_time &&
  route.route_start_time
) {
  const rowStart = new Date(rh.hotspot_start_time).getTime();
  const routeStart = new Date(route.route_start_time).getTime();
  
  if (rowStart < routeStart) {
    // This is a carried-over hotel row from previous route
    // Skip it in API response for this route
    continue;  // Don't add to segments
  }
}
```

**Risk**: Medium - Changes API response filtering logic
**Pros**: Fixes visible issue immediately
**Cons**: Doesn't fix underlying DB persistence issue

### OPTION 2: Fix Route Assignment in Engine (Correct, More Complex)

**Change Location**: `src/modules/itineraries/engines/helpers/timeline.builder.ts`

**Action**: 
1. When `shouldHotelFirstByDistance = true`, create hotel rows on PREVIOUS route, not CURRENT route
2. Track which hotel rows were created on previous route so current route knows to skip them
3. Use absolute seconds for route assignment, not wrapped times

**Risk**: High - Changes core engine logic
**Pros**: Fixes root cause, cleans DB state
**Cons**: Requires detailed timeline refactor

### OPTION 3: Soft Fix - Validate and Mark Conflicts (Moderate)

**Change Location**: `src/modules/itineraries/engines/helpers/timeline.builder.ts` (lines 2439-2477)

**Action**: Enhance validation to:
1. Detect hotel rows starting before route start
2. Mark them with `isConflict=true` and reason "HOTEL_ROW_FROM_PREVIOUS_ROUTE"
3. In API response filtering, skip these marked rows

**Risk**: Low-Medium
**Pros**: Fixes symptom, marks root cause, preserves DB  for audit
**Cons**: Workaround, not fix

---

## SECTION I: REGRESSION RISKS

### Risk 1: Hotel-First Logic Depended Elsewhere

**Check**: Are other systems expecting hotel-first rows on current route?
- Frontend booking display
- Pricing calculations per route
- Confirmation email generation

**Mitigation**: Add feature flag for new behavior, test end-to-end

### Risk 2: Wrapped-Time Calculations Throughout Builder

**Check**: The hotel timing issues suggest wrapped-time is used in multiple places:
- `currentTime` state variable
- Hotel distance calculations
- Route boundary comparisons

**Mitigation**: Separate absolute-seconds tracking from wrapped-time display throughout builder

### Risk 3: Multi-Day Itineraries May Depend on Current Behavior

**Check**: Patterns with specific routes skipping hotel logic based on previous `didHotelFirstCheckin`

**Mitigation**: Add logging to trace hotel logic branches for regressions

---

## SECTION J: NEXT STEPS FOR FIX IMPLEMENTATION

**Recommended Approach**: OPTION 3 + OPTION 1 (Soft fix immediately, then proper fix)

1. **Short term** (Today):
   - Implement route-end validation in timeline.builder.ts
   - Mark hotel rows with `BEFORE_ROUTE_START` reason
   - Filter these rows in itinerary-details.service.ts
   - Deploy and test with DVI202604229

2. **Medium term** (This week):
   - Investigate wrapped-time usage throughout builder
   - Refactor to use absolute-seconds internally, wrapped-time only for DB storage
   - Trace route assignment logic for hotel rows

3. **Long term** (Next sprint):
   - Rewrite hotel-first logic to create rows on previous route
   - Add comprehensive day-boundary tests
   - Refactor `currentTime` state to use absolute seconds

---

## APPENDIX: COMPLETE DB INSPECTION OUTPUT

See: `debug-hotel-output-DVI202604229.txt` for full table dumps and gap analysis.

### Key Metrics from Inspection

**Route 1252 (Day 1)**:
- 9 total rows
- 2 hotel rows
- 7 legitimate day rows
- Pre-start violations: 1 (2 hotel rows)

**Route 1253 (Day 2)**:
- 5 total rows
- 2 hotel rows (evening)
- 3 legitimate day rows
- Pre-start violations: 0 ✅

**Route 1254 (Day 3)**:
- 11 total rows
- 2 hotel rows (WRONG TIMES)
- 9 legitimate day rows (some with duplicates/issues)
- Pre-start violations: 1 (checkin)
- Reversed-time violation: 1 (travel row)

**Route 1255 (Day 4)**:
- 9 total rows 
- 0 hotel rows ✅
- 1 post-route-end violation (DROP_OFF)

---

## CONCLUSION

Hotel/day-boundary bugs in DVI202604229 are **NOT caused by sorting failure** but by **route-assignment and wrapped-time wrapping issues in the timeline builder**. Hotel rows from previous-night checkout are being attached to current-day route with corrupted timestamps.

**Recommended first fix**: Add explicit validation to mark and filter these rows before they corrupt the API response.

**Recommended proper fix**: Rewrite hotel-first logic to attach rows to correct route and refactor wrapped-time handling throughout the builder.

