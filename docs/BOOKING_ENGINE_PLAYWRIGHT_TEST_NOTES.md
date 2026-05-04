# Booking Engine Playwright Test Notes

## Coverage

Implemented in [dvi_frontend/tests/e2e/booking-engine-validation.spec.ts](dvi_frontend/tests/e2e/booking-engine-validation.spec.ts):

1. Arrival before noon + same-city hotel
- Validates Day 1 attraction appears before check-in
- Validates check-in is not before 2 PM

2. Arrival after noon + same-city + hotel within 20 km
- Validates hotel check-in appears before first attraction
- Validates check-in is not before 2 PM
- Validates inferred >= 2-hour gap between check-in and first attraction when post-hotel attractions exist

3. Arrival after noon + same-city + hotel beyond 20 km
- Validates attraction appears before check-in (hotel not forced first)
- Validates end-of-day tail remains hotel-oriented (checkin/travel tail)

4. Different-city Day 1 hotel
- Validates attractions are scheduled before check-in
- Validates travel segments exist before hotel check-in

5. Closed hotspot handling
- 5a validates presence of closed/opening-hours annotations (`opens at`, `outside operating hours`, `closed on this day`)
- 5b optional deterministic assertion for mustVisitProxy retry order using an expected hotspot id env var

6. Houseboat stay
- Validates Day 1 has no attraction segments and has check-in segment(s)

7. KM limit warning
- Validates API exposes `costBreakdown.kmLimitWarning` for over-limit data
- Performs practical UI smoke load of itinerary-details page for same quote

8. Guide total aggregation
- Validates API exposes `costBreakdown.totalGuideCost > 0`
- Validates UI renders `Total Guide Cost`

## Temporary Backend Debug Logs Added

Prefix: `[BOOKING_RULE]`

Planner logs added in [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts):
- `HOTEL_DISTANCE_BRANCH`
- `DAY1_BRANCH_SELECTED`
- `HOTEL_FIRST_SELECTED`
- `HOTEL_LAST_RULE_APPLIED`
- `CHECKIN_CLAMP_APPLIED` (`hotel_first` / `hotel_last` context)
- `REST_GAP_INSERTED`
- `POST_HOTEL_SIGHTSEEING_PASS`
- `EN_ROUTE_SIGHTSEEING_BRANCH`
- `HOUSEBOAT_SUPPRESSION`
- `FULL_DAY_MARKER_DETECTED`
- `HOTSPOT_DEFERRED`
- `MUST_VISIT_RETRY_PRIORITY`

Details logs added in [api.dvi.travel/src/modules/itineraries/itinerary-details.service.ts](api.dvi.travel/src/modules/itineraries/itinerary-details.service.ts):
- `KM_LIMIT_WARNING`
- `GUIDE_AGGREGATION`

All debug logs are temporary and clearly marked for cleanup.

## Required Environment Variables

General:
- `E2E_BASE_URL` (default `http://localhost:8080`)
- `E2E_API_BASE_URL` (default `http://127.0.0.1:4006/api/v1`)
- `E2E_HOTSPOT_USER` / `E2E_HOTSPOT_PASSWORD` (or `E2E_VENDOR_USER` / `E2E_VENDOR_PASSWORD`)

Scenario quote IDs:
- `E2E_BOOKING_RULE_QUOTE_BEFORE_NOON_SAME_CITY`
- `E2E_BOOKING_RULE_QUOTE_AFTER_NOON_SAME_CITY_WITHIN_20KM`
- `E2E_BOOKING_RULE_QUOTE_AFTER_NOON_SAME_CITY_BEYOND_20KM`
- `E2E_BOOKING_RULE_QUOTE_DAY1_DIFFERENT_CITY`
- `E2E_BOOKING_RULE_QUOTE_CLOSED_HOTSPOT_DEFERRED`
- `E2E_BOOKING_RULE_QUOTE_HOUSEBOAT`
- `E2E_BOOKING_RULE_QUOTE_KM_WARNING`
- `E2E_BOOKING_RULE_QUOTE_GUIDE_TOTAL`

Optional deterministic must-visit ordering assertion:
- `E2E_BOOKING_RULE_EXPECTED_MUST_VISIT_FIRST_HOTSPOT_ID`

## How To Run

From [dvi_frontend](dvi_frontend):

```bash
npm run e2e -- tests/e2e/booking-engine-validation.spec.ts
```

Or run only chromium project explicitly:

```bash
npx playwright test tests/e2e/booking-engine-validation.spec.ts --project=chromium
```

## Backend Logs To Watch

In backend terminal output while generating/retrieving itinerary:
- `[BOOKING_RULE]` entries listed above

Suggested quick filter (PowerShell):

```powershell
Get-Content server-logs-live.txt -Wait | Select-String "\[BOOKING_RULE\]"
```

## Known Test-Data Limitations

- Scenario 2 rest-gap validation is inferred from check-in time to first attraction start in itinerary-details segments; rest rows are not rendered as dedicated segment types.
- Scenario 5b (mustVisitProxy retry order) needs deterministic seeded quote data and explicit expected hotspot id env var.
- KM warning is API-validated; current UI has no dedicated km warning label assertion in this spec beyond page load practicality.
- If a scenario env quote id is missing, the corresponding test is skipped with a clear message.

## Latest Execution Snapshot

- Date: 2026-04-09
- Command: `npx playwright test tests/e2e/booking-engine-validation.spec.ts --project=chromium`
- Result summary:
	- Passed: 0
	- Failed: 0
	- Skipped: 9
- Primary blocker for execution coverage: scenario quote-id env vars were not provided in this run, so all scenario tests were skipped by design.
