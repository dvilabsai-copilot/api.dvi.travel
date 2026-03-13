# STAAH Doc Gap Report

Date: 2026-03-13
Scope: `src/modules/staah/*`, `test/staah-api.test.js`, generated `test/staah-*.txt`
Source references: `https://getapidoc.staah.net/` (v2), `https://getapidoc.staah.net/v1/`

## Exact Matches
- Authentication in body via `apikey`.
- Requests are `POST` JSON.
- `propertyid` is present in request body.
- `property_info` request contract is used on product info tests.
- `roomrate_info` request contract is used on rate-plan info tests.
- `reservation_info` request contract is used on reservation tests.
- Version tag is now `"2"` (string) for tested request payloads.
- Reservation acknowledgement response shape is array-like and includes booking status and `trackingId`.
- Push acknowledgment shape `{"status":"success|fail","error_desc":"..."}` is used.

## Exact Mismatches (Before This Change)
- Actions were custom/internal values:
  - `getProductInfo`, `getRatePlanInfo`, `reservation`
  - `inventoryUpdate`, `rateUpdate`, `restrictionUpdate`
  - `modifyReservation`, `cancelReservation`
- Version was `"v2"` instead of `"2"`.
- Reservation payload used `bookingid` in tests; now moved to `bookingId` in tests.

## Remaining Mismatches / Risks
- `/staah/modifyReservation` and `/staah/cancelReservation` are not shown as first-class v2 operations in the fetched docs snippets.
- `/staah/inventoryUpdate`, `/staah/rateUpdate`, `/staah/restrictionUpdate` are implemented as partner inbound push adapters, not STAAH pull (`ARR_info`, `year_info_ARR`) service calls.
- Current controller paths are partner-local API names, not STAAH test simulator endpoint names.

## Assumptions
- `version` must be string `"2"` across v2 requests.
- Product info action is strictly `property_info`.
- Room/rate info action is strictly `roomrate_info`.
- Reservation delivery action is strictly `reservation_info`.
- Push delta payload does not require an `action` field (based on pushed sample sections).
- Reservation inner schema fields beyond top-level (`reservations.reservation[]`) are treated as pass-through due incomplete sample expansion in fetched snippets.

## Custom Adapter Endpoints (Not STAAH-Native Names)
- `POST /api/v1/staah/productInfo` (adapts to STAAH `property_info` semantics).
- `POST /api/v1/staah/ratePlanInfo` (adapts to STAAH `roomrate_info` semantics).
- `POST /api/v1/staah/inventoryUpdate` (partner push adapter endpoint).
- `POST /api/v1/staah/rateUpdate` (partner push adapter endpoint).
- `POST /api/v1/staah/restrictionUpdate` (partner push adapter endpoint).
- `POST /api/v1/staah/reservation` (adapts to STAAH `reservation_info` semantics).
- `POST /api/v1/staah/modifyReservation` (adapter/custom extension).
- `POST /api/v1/staah/cancelReservation` (adapter/custom extension).

## What Was Changed Now
- Enforced strict DTO validation for:
  - `property_info` on product info.
  - `roomrate_info` on rate-plan info.
  - `reservation_info` on reservation delivery.
  - `version: "2"` across STAAH request DTOs.
- Updated test requests to use STAAH-native action names and `version: "2"`.
- Removed custom action names from push-like tests (`inventoryUpdate`, `rateUpdate`, `restrictionUpdate`) and custom reservation update/cancel tests.

## Certification Readiness Note
- This code now better matches STAAH request naming for product/rateplan/reservation and versioning.
- It is still an adapter-layer integration and not a 1:1 mirror of STAAH endpoint topology.
- Before certification, validate reservation inner payload field names against fully expanded official examples and confirm whether modify/cancel are supported in your agreed STAAH scope.
