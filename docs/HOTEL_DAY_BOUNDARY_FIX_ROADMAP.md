# HOTEL DAY-BOUNDARY BUGS: IMPLEMENTATION ROADMAP
## DVI202604229 - Proof-Based Fix Strategy

---

## QUICK SUMMARY

**Proven Root Cause**: Hotel rows (item_type=5/6) from previous-night checkout are being **attached to the current-day route** with **timestamps from before current-day start**.

**Example**:
- Day 1 starts 13:30 (1:30 PM)
- But hotel checkin row exists at 10:27 (10:27 AM)
- This is checkout from **Day 0** (before trip starts), wrongly placed on Day 1

**Impact**: API returns incorrect event sequence, missing start segments.

---

## IMMEDIATE FIX (Low Risk, Deploy Today)

### Task 1: Mark problem rows in engine

**File**: `src/modules/itineraries/engines/helpers/timeline.builder.ts`  
**Lines**: 2439-2477 (validation loop at end of buildTimelineForPlan)

**Add this check in validation loop**:

```typescript
// Validate each row
for (const row of hotspotRows) {
  const routeId = row.itinerary_route_ID;
  const routeStartSeconds = routeStartTimesMap.get(routeId);
  
  // NEW: Check if hotel row appears before route start
  if ((row.item_type === 5 || row.item_type === 6) && routeStartSeconds) {
    const rowStartString = TimeConverter.fromDate(row.hotspot_start_time);
    const rowStartSeconds = timeToSeconds(rowStartString);
    
    if (rowStartSeconds < routeStartSeconds) {
      // Mark as conflict: hotel-first row from previous hotel stay
      row.isConflict = true;
      row.conflictReason = 'HOTEL_ROW_BEFORE_ROUTE_START_SKIP_IN_API';
    }
  }
  
  // ... existing validation code ...
}
```

### Task 2: Filter marked rows in API response

**File**: `src/modules/itineraries/itinerary-details.service.ts`  
**Location**: In segment building loop where rows are converted to segments

**Add this filter**:

```typescript
// When iterating through hotspot rows for a route:
for (const rh of hotspotRowsForRoute) {
  // Skip hotel rows marked as pre-route-start conflict
  if (
    rh.isConflict &&
    rh.conflictReason?.includes?.('HOTEL_ROW_BEFORE_ROUTE_START')
  ) {
    continue;  // Don't create segment for this row
  }
  
  // ... rest of segment building ...
}
```

### Task 3: Test and deploy

```bash
npm run build
npm run test:itinerary-details
git add -A
git commit -m "hotfix: filter pre-route-start hotel rows from API response"
```

**Expected Result**:
- Day 1 API response starts with START segment (13:30), not hotel
- Day 1 and Day 3 checkin violations resolved
- Maintains DB integrity (rows stay marked for audit)

---

## PROPER FIX (High Risk, Schedule for Next Sprint)

### Root Problem
The timeline builder inserts hotel-first rows (from previous checkout) on the **current route** when it should attach them to the **previous route**.

### Solution Architecture

```
BEFORE (Current, Wrong):
┌─ Route 0 (Day 0):  airline → arrival
├─ Route 1 (Day 1):  [HOTEL_CHECKOUT] + [REST_GAP] + [START] + [ATTRACTIONS]
│                    ↑ Wrong place! Should end route 0
│
└─ Route 2 (Day 2):  [START] + [ATTRACTIONS]
                     (no hotel because route 1 did hotel-first)

AFTER (Correct):
┌─ Route 0 (Day 0):  airline → arrival → [HOTEL_CHECKOUT] + [REST_GAP]
│                                       ↑ Correct end-of-day
├─ Route 1 (Day 1):  [START] + [ATTRACTIONS]
│
└─ Route 2 (Day 2):  [START] + [ATTRACTIONS]
                     (hotel-first logic NOT triggered, hotel-last at proper end)
```

### Implementation Plan

**Phase 1: Separate Hotel-First From Route Assignment**
```typescript
// Instead of:
if (shouldHotelFirstByDistance) {
  hotspotRows.push(hotelRows);  // WRONG: adds to current route
  didHotelFirstCheckin = true;
}

// Do:
if (shouldHotelFirstByDistance && !isFirstRoute) {
  // Add hotel rows to PREVIOUS route, not current
  hotelRowsForPreviousRoute.push(...hotelRows);
  didHotelFirstCheckin = true;
}
```

**Phase 2: Track Route Context for Row Insertion**
- Add `targetRouteId` param to hotel builder
- Allow rows to be assigned to different route than builder's own `routeId`

**Phase 3: Refactor currentTime Continuity**
- Use absolute seconds internally for all calculations
- Only wrap when storing to DB
- Initialize each route's `currentTime` from previous route's end_time (unwrapped)

**Phase 4: Test Comprehensive Coverage**
- Multi-day itineraries with hotel-first triggers
- Day-boundary wrapping (checkins crossing midnight)
- Different arrival times (morning, afternoon, evening)
-  Different hotel selection methods

### Risk Mitigation
- Feature flag: `HOTEL_FIRST_FIX_ENABLED` (default off until proven)
- Logging: `[HotelAssignment][PROOF]` at all decision points
- Regression tests: Existing itineraries must produce same API output

---

## ALTERNATIVE: Accept Current Behavior With Documentation

If hotel-first logic is business-required despite wrong route assignment:

```markdown
### Documented Limitation

The system creates hotel-first rows on the current route when an arrival 
qualifies for immediate checkin (late afternoon arrival, short distance).

**These rows represent previous-hotel handover**, not current-day activities.

**API Filter Applied**: Pre-route-start hotel rows are excluded from API 
to prevent confusion in frontend display.

**Future Fix**: Route assignment will be corrected in Sprint N.
```

---

## TESTING CHECKLIST

After implementing the immediate fix:

```bash
# 1. Build and compile
npm run build

# 2. Test the specific quote
npx ts-node debug-hotel-day-boundary-issues.ts DVI202604229

# Expected output:
#  Day 1: CHECKIN and TRAVEL_TO_HOTEL marked isConflict=true
#  Day 3: CHECKIN marked isConflict=true  
#  Day 2: No conflicts (hotel at legitimate evening)
#  Day 4: No conflicts (no hotel, last route)

# 3. Verify API response
curl http://localhost:3000/api/v1/itineraries/details/DVI202604229 \
  -H "X-Debug-Quote: 267" | jq '.days[0].segments[0]'

# Expected: First segment is START, not TRAVEL_TO_HOTEL

# 4. Regression: Check other quotes
npx ts-node debug-hotel-day-boundary-issues.ts DVI202604230  # Known good
npx ts-node debug-hotel-day-boundary-issues.ts DVI202604228  # Old quote

# 5. Unit tests
npm run test:unit -- itinerary-details.service  
npm run test:e2e -- /itineraries/details
```

---

## DEPLOYMENT STRATEGY

**Option A: Hotfix (Immediate)**
```
- Deploy immediate fix only
- Verify with DVI202604229
- Monitor logs for other affected quotes
- Schedule proper fix for next sprint
```

**Option B: Full Fix (More Preparation)**
```
- Implement both immediate + proper fix
- Comprehensive testing (1-2 days)
- High confidence before deploy
```

### Recommendation
**Start with Option A today**, schedule proper fix implementation for next sprint.

---

## FILES INVOLVED

### Files to Modify
- `src/modules/itineraries/engines/helpers/timeline.builder.ts` (validation loop)
- `src/modules/itineraries/itinerary-details.service.ts` (API filtering)

### Files to Reference
- `ITINERARY_HOTEL_DAY_BOUNDARY_INVESTIGATION.md` (full analysis)
- `debug-hotel-day-boundary-issues.ts` (validation script)

### No Files to Delete
- Keep all investigation artifacts for audit trail

---

## FREQUENTLY ASKED QUESTIONS

**Q: Why does hotel-first logic run on Day 1 but not Day 2?**  
A: Check is `shouldHotelFirstByDistance && isFirstRoute`. Day 2 is not first route, so hotel-last logic runs instead.

**Q: Why is the timestamp 07:02 when hotel travel should be around 16:00?**  
A: Wrapped-time bug: `timeToSeconds()` with modulo operation is corrupting the absolute time calculation. This is separate from the route-assignment issue.

**Q: Do these bad rows affect pricing/confirmation?**  
A: Unknown. Need to check if downstream systems (vehicle selection, costing, confirmation) use `isConflict` flag.

**Q: Can we just delete the bad rows from DB?**  
A: No. They're in customer's database. Deleting hides the problem. Better to mark and filter.

---

## SUCCESS CRITERIA

✅ **Immediate Fix Complete When**:
- Compilation succeeds with no TypeScript errors
- DB still contains hotel rows (with isConflict=true)
- API response no longer shows pre-route-start hotel rows
- DVI202604229 Day 1 response starts with START segment
- DVI202604229 Day 3 response starts with START segment
-Other quotes still render correctly (regression test)

✅ **Proper Fix Complete When**:
- Hotel-first rows are assigned to previous route
- No rows exist with isConflict set due to day-boundary
- Multi-day itinerary traversal in DB shows correct route ownership
- Wrapping/absolute-seconds separation is clear throughout builder
- Comprehensive testing passes for various arrival times/distances

---

## FINAL NOTES

This investigation proved that:
1. **database is NOT corrupted** - rows have correct times, just wrong route assignment
2. **sorting alone cannot fix it** - the row generation itself is flawed
3. **source-of-truth must be fixed** - not API layer patches

The hotel day-boundary bugs are real and impactful, but they're fixable without cascading changes. Start with the immediate filter, then do the proper refactor.

