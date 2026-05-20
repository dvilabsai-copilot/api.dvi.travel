# STAAH 100 Percent Gap Report

Date: 2026-03-13
Basis: direct inspection of `src/modules/staah/*`, `src/modules/axisrooms/*`, `src/main.ts`, `src/app.module.ts`, `prisma/schema.prisma`, `test/staah-api.test.js`, `STAAH_STRICT_AUDIT.md`, `STAAH_DOC_GAP_REPORT.md`, `STAAH_NEXT_ACTION_PLAN.md`, `STAAH_INTEGRATION_NOTES.md`

## 1. Exact request-contract matches

Only the items below are fully proven from current code plus the verified STAAH v2 request baseline already captured in repo docs.

- `POST /api/v1/staah/productInfo`
  Classification: EXACT STAAH REQUEST CONTRACT via adapter route name
  Verified request body: `{ propertyid, apikey, action: "property_info", version: "2" }`
- `POST /api/v1/staah/ratePlanInfo`
  Classification: EXACT STAAH REQUEST CONTRACT via adapter route name
  Verified request body: `{ propertyid, apikey, action: "roomrate_info", version: "2" }`
- `POST /api/v1/staah/reservation`
  Classification: EXACT STAAH REQUEST CONTRACT at wrapper level via adapter route name
  Verified top-level request body: `{ propertyid, apikey, action: "reservation_info", version: "2", reservations: { reservation: [] } }`
- `POST /api/v1/staah/arrInfo`
  Classification: EXACT STAAH REQUEST CONTRACT via adapter route name
  Verified request body: `{ propertyid, apikey, room_id, rate_id, action: "ARR_info", from_date, to_date, version: "2" }`
- `POST /api/v1/staah/yearInfoArr`
  Classification: EXACT STAAH REQUEST CONTRACT via adapter route name
  Verified request body: `{ propertyid, apikey, room_id, rate_id, action: "year_info_ARR", version: "2" }`
- Shared wrapper guarantees
  Verified in DTOs and tests: `propertyid` required, `apikey` required, exact `action` literal enforced where applicable, exact `version: "2"` enforced where applicable

## 2. Adapter endpoints

These are internal partner-facing adapter routes or adapter abstractions. They must not be described as official STAAH endpoint topology.

- `POST /api/v1/staah/productInfo`
  Adapter route name. Request wrapper matches verified STAAH request contract, but response body is adapter-defined.
- `POST /api/v1/staah/ratePlanInfo`
  Adapter route name. Request wrapper matches verified STAAH request contract, but response body is adapter-defined.
- `POST /api/v1/staah/reservation`
  Adapter route name. Top-level request wrapper matches verified STAAH request contract, but reservation item schema and acknowledgement schema are not fully proven.
- `POST /api/v1/staah/arrInfo`
  Adapter route name. Request wrapper matches verified STAAH request contract, but response body is adapter-defined from local `staah_inventory` and `staah_rate` tables.
- `POST /api/v1/staah/yearInfoArr`
  Adapter route name. Request wrapper matches verified STAAH request contract, but response body is adapter-defined from local `staah_inventory` and `staah_rate` tables.
- `POST /api/v1/staah/inventoryUpdate`
  ADAPTER ENDPOINT. Split availability push flow; not proven as official standalone STAAH operation.
- `POST /api/v1/staah/rateUpdate`
  ADAPTER ENDPOINT. Split rate push flow; not proven as official standalone STAAH operation.
- `POST /api/v1/staah/restrictionUpdate`
  ADAPTER ENDPOINT. Split restriction push flow; not proven as official standalone STAAH operation.

## 3. Custom/unverified flows

- `POST /api/v1/staah/modifyReservation`
  Classification: CUSTOM / UNVERIFIED EXTENSION
  Status: kept exposed for local business flow logging/storage
  Verified risk: not proven from STAAH v2 docs as an official first-class operation
- `POST /api/v1/staah/cancelReservation`
  Classification: CUSTOM / UNVERIFIED EXTENSION
  Status: kept exposed for local business flow logging/storage
  Verified risk: not proven from STAAH v2 docs as an official first-class operation
- Reservation inner payload fields in `reservations.reservation[]`
  Classification: partially unverified
  Current code now enforces wrapper presence and array structure, but does not claim the full item schema is proven
- Product, rate-plan, ARR, year-ARR, and reservation acknowledgement response bodies
  Classification: adapter-defined / not fully proven official STAAH response schemas

## 4. Remaining gaps to reach 100 percent

- Official STAAH response schema is still not proven for:
  - `productInfo`
  - `ratePlanInfo`
  - `ARR_info`
  - `year_info_ARR`
  - reservation acknowledgement array items
- Full reservation item schema inside `reservations.reservation[]` is still not proven from official STAAH docs
- `inventoryUpdate`, `rateUpdate`, and `restrictionUpdate` remain adapter endpoints, not proven official STAAH operations
- `modifyReservation` and `cancelReservation` remain publicly exposed custom flows; they must stay excluded from certification and Excel statements unless STAAH explicitly confirms them
- Route names remain internal adapter routes, not STAAH simulator or STAAH-owned endpoint names
- Certification-safe docs existed, but the project needed a stronger explicit split between exact request-contract matches, adapter-only items, and unsafe claims
- Negative validation coverage was incomplete before this pass; added now for action/version/wrapper/date-range rejection cases

## 5. Exact files requiring changes

- `src/modules/staah/dto/reservation.dto.ts`
  Tighten wrapper validation to require `reservations.reservation[]` while keeping reservation item schema minimally scoped to proven/currently used fields
- `src/modules/staah/staah.service.ts`
  Reject `ARR_info` requests where `from_date > to_date` with HTTP 400
- `src/modules/staah/dto/modify-reservation.dto.ts`
  Preserve optional custom `data` payload under global whitelist validation
- `src/modules/staah/dto/cancel-reservation.dto.ts`
  Preserve optional custom `data` payload under global whitelist validation
- `src/modules/staah/dto/product-info.dto.ts`
  Add explicit note that response DTO is adapter-defined, not proven official STAAH response schema
- `src/modules/staah/dto/rate-plan-info.dto.ts`
  Add explicit note that response DTO is adapter-defined, not proven official STAAH response schema
- `src/modules/staah/constants/staah-messages.ts`
  Add explicit invalid ARR date-range message
- `test/staah-api.test.js`
  Add negative validation tests for wrong action, wrong version, missing reservation wrapper/array, invalid ARR dates, and invalid ARR date order
- `STAAH_CERTIFICATION_SAFE_FIELDS.md`
  Create certification-safe wording split
