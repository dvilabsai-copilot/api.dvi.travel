# Booking Engine E2E Results

Date: 2026-04-09

## Run Summary

- Seed script: `dvi_frontend/tests/e2e/seed-booking-test-data.ts`
- Env file generated: `dvi_frontend/.env.e2e`
- Playwright command:
  - `npx playwright test tests/e2e/booking-engine-validation.spec.ts --project=chromium`
- Result:
  - Passed: 6
  - Failed: 0
  - Skipped: 3

## Scenario-Wise Result

1. Arrival before 12 noon + same-city hotel
- Status: PASS
- Quote: `DVI2026041`
- Key assertions:
  - Day 1 attraction appears before check-in
  - Check-in is not before 2 PM

2. Arrival after 12 noon + same-city hotel + <=20km
- Status: SKIP (data limitation)
- Quote: `DVI20260417`
- Key assertions executed:
  - Check-in exists and is not before 2 PM
- Skip reason:
  - Selected quote has no post-hotel sightseeing rows, so rest-gap verification against post-hotel attraction timing is not possible.

3. Arrival after 12 noon + same-city hotel + >20km
- Status: SKIP (data limitation)
- Quote: `DVI20260418`
- Skip reason:
  - Selected quote has no sightseeing rows; hotel-last ordering vs attractions cannot be asserted.

4. Different-city hotel on Day 1
- Status: PASS
- Quote: `DVI20260321`
- Key assertions:
  - Attractions appear before hotel check-in
  - Travel segments exist before hotel check-in

5. Closed hotspot handling
- Status: PASS
- Quote: `DVI2026024`
- Key assertions:
  - Closed/opening-hours annotation appears in attraction visit-time text
  - Deferred-order deterministic check passed with expected hotspot id env value

6. Houseboat stay (suppression behavior)
- Status: PASS
- Quote: `DVI20260416`
- Key assertions:
  - Day 1 has no attraction segments
  - Check-in segment exists

7. KM limit warning
- Status: PASS
- Quote: `DVI20260321`
- Key assertions:
  - `costBreakdown.kmLimitWarning` exists in itinerary details API
  - Itinerary details page loads for the same quote

8. Guide total aggregation
- Status: SKIP (data limitation)
- Quote: `DVI20260419`
- Skip reason:
  - Selected quote has no guide rows (`totalGuideCost <= 0`), so guide aggregation cannot be validated from available API data.

## Backend [BOOKING_RULE] Log Validation

Expected grouped log types:
- `HOTEL_DISTANCE_BRANCH`
- `REST_GAP_INSERTED`
- `HOTSPOT_DEFERRED`
- `HOUSEBOAT_SUPPRESSION`
- `KM_LIMIT_WARNING`
- `GUIDE_AGGREGATION`

Observed status:
- Temporary `[BOOKING_RULE]` logs are instrumented in backend source and exercised by API calls.
- Captured from dedicated backend run on port `4010` (BOOKING_DEBUG enabled):
  - `HOTEL_DISTANCE_BRANCH`: 0
  - `REST_GAP_INSERTED`: 0
  - `HOTSPOT_DEFERRED`: 0
  - `HOUSEBOAT_SUPPRESSION`: 0
  - `KM_LIMIT_WARNING`: 3
  - `GUIDE_AGGREGATION`: 3
- Note: this run captured itinerary-details rule logs; planner-branch log groups above were not emitted in observed requests for this seeded dataset.

## Mismatches / Gaps

1. Same-city after-noon scenarios generated in this environment frequently produce no attraction rows, preventing full assertion of post-hotel and hotel-last ordering against attractions.
2. No API endpoint currently exists to seed route guide rows directly; guide aggregation scenario remains data-dependent unless DB-level test seeding is introduced.

## Edge Cases Detected

1. Itinerary details can legitimately contain Day 1 check-in with zero attractions for certain generated same-city after-noon plans.
2. Must-visit deferred priority assertion is deterministic only when `E2E_BOOKING_RULE_EXPECTED_MUST_VISIT_FIRST_HOTSPOT_ID` is set.

## Auto-Seeding Output

Generated `.env.e2e` values:
- `E2E_BOOKING_RULE_QUOTE_BEFORE_NOON_SAME_CITY=DVI2026041`
- `E2E_BOOKING_RULE_QUOTE_AFTER_NOON_SAME_CITY_WITHIN_20KM=DVI20260417`
- `E2E_BOOKING_RULE_QUOTE_AFTER_NOON_SAME_CITY_BEYOND_20KM=DVI20260418`
- `E2E_BOOKING_RULE_QUOTE_DAY1_DIFFERENT_CITY=DVI20260321`
- `E2E_BOOKING_RULE_QUOTE_CLOSED_HOTSPOT_DEFERRED=DVI2026024`
- `E2E_BOOKING_RULE_QUOTE_HOUSEBOAT=DVI20260416`
- `E2E_BOOKING_RULE_QUOTE_KM_WARNING=DVI20260321`
- `E2E_BOOKING_RULE_QUOTE_GUIDE_TOTAL=DVI20260419`
- `E2E_BOOKING_RULE_EXPECTED_MUST_VISIT_FIRST_HOTSPOT_ID=27`
- `BOOKING_DEBUG=true`
