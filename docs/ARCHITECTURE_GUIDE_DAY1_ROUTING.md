# Day 1 Route Time Architecture Guide

## Design Principle: Source of Truth Hierarchy

The timeline builder follows a strict **source of truth hierarchy**:

```
1. DATABASE: Saved route times (route_start_time, route_end_time)
   ↓ applied by user via PATCH /api/v1/itineraries/:planId/route/:routeId/times
   
2. POLICY EVALUATION: Arrival policy checks (early-arrival, deferred flow)
   ↓ computed from trip context and billing decisions
   
3. CONDITIONAL OVERRIDES: Deferred flow buffer (08:00-09:00 for early arrivals)
   ↓ only if (enforceStrictDay1EarlyArrivalDeferredFlow === true)
   
4. TIMELINE BUILDING: Use effective times for schedule construction
   ↓ hotspot scheduling, hotel insertion, gap filling
   
5. FINAL VALIDATION: Check all rows fit within [route_start_time, route_end_time]
   ↓ guarantees no segments exceed route bounds
```

### Why This Order Matters

| Level | Type | Controlled By | User Can Override |
|-------|------|---------------|------------------|
| Database | Facts | PATCH endpoint | ✅ YES (manual edit) |
| Policy | Rules | Arrival policy service | ❌ NO (system rules) |
| Conditional | Gates | Policy evaluation result | ❌ NO (automated) |
| Building | Logic | TimelineBuilder algorithm | ❌ NO (system logic) |
| Validation | Bounds | Database values | ✅ YES (via PATCH) |

---

## Code Flow in TimelineBuilder

### Section A: Read & Initialize (Lines 585-620)

```typescript
// Read saved times from database (USER CONTROL)
let routeStartTime = /* ...parse route.route_start_time... */
let routeEndTime = /* ...parse route.route_end_time... */

// Use them directly (NO generic overrides)
let effectiveRouteStartTime = routeStartTime;
let currentTime = effectiveRouteStartTime;
let routeEndSeconds = timeToSeconds(routeEndTime);
```

**Principle**: Database is source of truth. No modifications here.

### Section B: Arrival Policy Evaluation (Lines 680-750)

```typescript
const evaluatedArrivalPolicy = 
  isFirstRoute && isArrivalCityStayRoute && tripStartForPolicy
    ? evaluateArrivalHotelPolicy({
        isArrivalDay: arrivalDayForPolicy,
        arrivalMinutes: arrivalMinutesForPolicy,
        // ... policy parameters
      })
    : null;

const enforceStrictDay1EarlyArrivalDeferredFlow =
  suppressHotelInsertionUntilEndOfDay;
```

**Principle**: System evaluates policies based on trip context, not user choice.

### Section C: Conditional Override (Lines 758-760)

```typescript
if (enforceStrictDay1EarlyArrivalDeferredFlow) {
  // Hard policy rule: Day-1 deferred hotel flow must begin with 08:00-09:00 buffer.
  effectiveRouteStartTime = '08:00:00';
}
```

**Principle**: ONLY override if a specific, evaluated condition is true.

### Section D: Timeline Building (Lines 800-2100)

```typescript
// Use effectiveRouteStartTime throughout
let currentTime = effectiveRouteStartTime;

// Build refreshment, travel, hotspot, hotel segments
// All time calculations use currentTime
// All gate checks use routeStartSeconds and routeEndSeconds
```

**Principle**: Timeline engine trusts the effective times set once.

### Section E: Final Validation (Lines 2840-2920)

```typescript
// Check all rows fit within original route bounds
const routeStartSeconds = timeToSeconds(route.route_start_time);
const routeEndSeconds = timeToSeconds(route.route_end_time);

for (const row of hotspotRows) {
  if (row.hotspot_start_time > routeEndSeconds) {
    // ✗ REJECT: row exceeds route end time
  }
  if (row.hotspot_start_time < routeStartSeconds) {
    // ✓ WARN: row before route start (e.g., previous-day checkout)
  }
}
```

**Principle**: Validate against original database values, not effective overrides.

---

## Anti-Pattern: What NOT to Do

### ❌ Bad Pattern: Generic Forced Override

```typescript
// WRONG - removed from lines 605-607
if (isFirstRoute && !isLastRoute && timeToSeconds(routeStartTime) > timeToSeconds('08:00:00')) {
  effectiveRouteStartTime = '08:00:00';  // Ignores user input
}
```

**Why bad**:
1. Unconditional (doesn't check any policy or context)
2. Generic (applies to all cases)
3. Silently ignores user data (no warning)
4. Contradicts source-of-truth principle

### ❌ Bad Pattern: Hardcoded End Times

```typescript
// WRONG - removed from lines 623-630
if (isFirstRoute && !isLastRoute) {
  routeEndSeconds = timeToSeconds('20:00:00');  // Ignores user input
}
```

**Why bad**:
1. Business rules should be in arrival policy, not hardcoded
2. Prevents flexible end times
3. No justification check
4. Breaks "source of truth" for end times

### ❌ Bad Pattern: Override Before Policy Check

```typescript
// WRONG - doing before evaluateArrivalPolicy()
let effectiveTime = routeStartTime;
if (someCondition) {
  effectiveTime = '08:00:00';
}

// THEN check policy
const policy = evaluateArrivalPolicy({...});
```

**Why bad**:
1. Policy evaluation uses wrong time as input
2. Overrides applied unconditionally
3. Hard to reason about (two sources of truth)

---

## Correct Pattern: Conditional Override Based on Policy

```typescript
// ✅ CORRECT - follows the hierarchy
let effectiveRouteStartTime = routeStartTime;  // Database is truth

// Evaluate policy
const policy = evaluateArrivalPolicy({...});
const shouldApplyDeferredBuffer = policy && policy.deferHotelToEndOfDay;

// THEN conditionally override (ONLY if justified by policy)
if (shouldApplyDeferredBuffer) {
  effectiveRouteStartTime = '08:00:00';
}

// Use effective time
let currentTime = effectiveRouteStartTime;
```

**Why good**:
1. Policy is checked first
2. Override is conditional
3. Reason is clear (policy decision)
4. Audit trail: can see WHY override happened

---

## Key Variables and Their Roles

| Variable | Type | Set By | Used For | Can Change |
|----------|------|--------|----------|-----------|
| `routeStartTime` | string | Database read | Initial baseline | NO (in this section) |
| `routeEndTime` | string | Database read | Final validation | NO (in this section) |
| `effectiveRouteStartTime` | string | Baseline + policy | Timeline building | YES (if policy) |
| `currentTime` | string | effectiveRouteStartTime updated in loop | Segment scheduling | YES (updated in loop) |
| `routeStartSeconds` | number | effectiveRouteStartTime | Gap calculations | NO (constant) |
| `routeEndSeconds` | number | routeEndTime | Boundary checks | NO (constant) |

---

## Test Case Examples

### Test 1: Manual Override Respected

```typescript
// GIVEN: User manually sets route times
routeStartTime = '12:00:00'
routeEndTime = '20:00:00'
policy = sightseeing-first (not deferred)

// THEN
effectiveRouteStartTime == '12:00:00' ✓
timeline begins at 12 PM ✓
no forced 08:00 reset ✓
```

### Test 2: Policy Override Applied

```typescript
// GIVEN: Early arrival (04:00) with deferred flow
routeStartTime = '04:00:00'
enforceStrictDay1EarlyArrivalDeferredFlow = true

// THEN
effectiveRouteStartTime == '08:00:00' ✓ (policy applied)
timeline has 08:00-09:00 buffer ✓
first sightseeing at 09:00 AM ✓
```

### Test 3: Invalid Case (Previous Bug)

```typescript
// GIVEN: User sets 12:00 start, early-arrival NOT deferred
routeStartTime = '12:00:00'
policy = null (no early arrival)
enforceStrictDay1EarlyArrivalDeferredFlow = false

// OLD (BUGGY):
if (isFirstRoute && routeStartTime > '08:00:00') {
  effectiveRouteStartTime = '08:00:00'  // ✗ IGNORES USER!
}

// NEW (FIXED):
effectiveRouteStartTime = routeStartTime  // ✓ RESPECTS USER!
// Only override if policy says so (it doesn't here)
if (enforceStrictDay1EarlyArrivalDeferredFlow) {
  // Not executed
}
```

---

## Decision Tree: When to Override effectiveRouteStartTime

```
START
│
├─ Is this first route?
│  └─ NO → Use routeStartTime (no overrides for non-first routes)
│
├─ Is this a same-city arrival stay?
│  └─ NO → Use routeStartTime (only override for arrival-city stays)
│
├─ Did arrival policy evaluation run?
│  └─ NO → Use routeStartTime (no policy = no override)
│
├─ Does policy say to defer hotel to end?
│  └─ NO → Use routeStartTime (policy doesn't require deferred buffer)
│
└─ YES, all conditions met
   └─ OVERRIDE: effectiveRouteStartTime = '08:00:00'
      Reason: Deferred flow requires morning buffer
      Verified: enforceStrictDay1EarlyArrivalDeferredFlow === true
      Side effects:
        - firstSightseeingMovementTime = '09:00:00'
        - bufferTime = 1 hour (08:00-09:00)
        - Refreshment row created
```

---

## Error Scenarios & Safeguards

### Scenario 1: Row Exceeds Route End Time

```typescript
// VALIDATION (Section E, lines 2880+)
if (rowEndTime > routeEndSeconds) {
  throw new Error(`Row ${rowId} exceeds route end time`);
}

// WHY: Uses original routeEndTime from database
// WHY NOT: Uses effective override (ignores temporary adjustments)
// RESULT: Catches logic errors in timeline building
```

### Scenario 2: Overnight Route (End < Start)

```typescript
// HANDLING (lines 614-616, 2860-2862)
if (routeEndSeconds < routeStartSeconds) {
  routeEndSeconds += 86400;  // Add 24 hours
}

// WHY: Handles routes that cross midnight
// SAFE: Uses both effective start and actual end time
// RESULT: Correctly spans two calendar days
```

### Scenario 3: Early Arrival Deferred Flow with Manual Late Start

```typescript
// INPUT
routeStartTime = '12:00:00'
arrivalTime = '04:00:00'
policy = deferred flow

// LOGIC
effectiveRouteStartTime = '12:00:00'  // User override
if (enforceStrictDay1EarlyArrivalDeferredFlow) {
  effectiveRouteStartTime = '08:00:00'  // Policy override
}

// RESULT: Policy override wins (08:00), user override ignored
// REASON: Policy is generated, user is manual input
// HIERARCHY: Policy > User (when user manual time contradicts policy)  
// THIS IS CORRECT: Policy constraints take precedence
```

---

## Design Lessons for Maintainers

### 1. Respect Source of Truth

Database is always the first source of truth. Only override if:
- A system rule (policy) requires it
- The override is conditional (checked before applying)
- The reason is auditable (logged somewhere)

### 2. One Place for Business Rules

Route time constraints should be in:
- **Arrival policy service** (what times are allowed)
- **Timeline builder** (how to apply those times)

NOT in:
- Hardcoded magic numbers (08:00, 20:00)
- Generic if-statements (if first route, force override)

### 3. Conditional Over Generic

Good:
```typescript
if (policy.requiresEarlyBuffer) {
  effectiveTime = '08:00:00';
}
```

Bad:
```typescript
if (isFirstRoute && timeAfterNoon) {
  effectiveTime = '08:00:00';
}
```

### 4. Validate Against Original, Not Effective

```typescript
// CORRECT: Check against original database times
routeStart = database.route_start_time
routeEnd = database.route_end_time

// NOT this:
routeStart = effectiveRouteStartTime  // Could be overridden!
```

This prevents cascading errors where an override breaks validation.

### 5. Document Overrides Clearly

Every place that changes a time should say WHY:

```typescript
// ✓ Good comment
if (enforceStrictDay1EarlyArrivalDeferredFlow) {
  // Hard policy rule: Day-1 deferred hotel flow must begin with 08:00-09:00 buffer.
  effectiveRouteStartTime = '08:00:00';
}

// ✗ Bad comment (no reason)
if (isFirstRoute && !isLastRoute) {
  effectiveRouteStartTime = '08:00:00';
}
```

---

## Future Enhancements

### 1. Configurable Buffer Time

Currently hardcoded to 08:00-09:00. Could become configurable:

```typescript
// NEW: Read from settings
const deferredFlowStartTime = settings.day1_deferred_flow_start_time || '08:00:00';
const firstSightseeingTime = settings.day1_first_sightseeing_time || '09:00:00';

if (enforceStrictDay1EarlyArrivalDeferredFlow) {
  effectiveRouteStartTime = deferredFlowStartTime;
  firstSightseeingMovementTime = firstSightseeingTime;
}
```

### 2. Per-Quote Route Time Exception

Allow business logic to accept route times outside normal bounds:

```typescript
const allowCustomRouteTimes = quote.planFlags?.allowCustomTimes === true;

if (allowCustomRouteTimes) {
  effectiveRouteStartTime = routeStartTime;  // Trust user
} else {
  // Apply standard constraints
}
```

### 3. Arrival Policy Versioning

Track which policy version was applied to enable rollbacks:

```typescript
const appliedPolicy = {
  version: 'arrival-policy-v2.1',
  ruleName: 'EARLY_ARRIVAL_DEFERRED_FLOW',
  startTime: '08:00:00',
  appliedDate: new Date(),
};
```

---

## Summary for Code Reviewers

When reviewing changes to Day 1 route times:

**✅ Approve**:
- Changes that respect database values as primary source
- Conditional overrides with clear justification
- Tests covering early-arrival deferred flow
- Backwards-compatible changes

**❌ Reject**:
- New hardcoded time constants
- Generic overrides without condition checks
- Changes that ignore user manual edits
- Removal of the deferred flow logic

**⚠️ Question**:
- Any new override without comment explaining why
- Changes to Section E (final validation) logic
- Modifications to arrival policy integration
