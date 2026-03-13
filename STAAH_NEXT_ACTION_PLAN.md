# STAAH Next Action Plan

Generated: 2026-03-13
Based on: full code inspection of `src/modules/staah/*`, `prisma/schema.prisma`, `test/staah-api.test.js`, `STAAH_STRICT_AUDIT.md`, `STAAH_DOC_GAP_REPORT.md`, `seed-staah-test-data.ts`

---

## 1. Current Exact Doc Matches

These items are confirmed from STAAH ChannelConnect v2 doc snippets and exactly match the current code.

| Item | Implementation | Match |
|---|---|---|
| Product info request wrapper | `PropertyInfoRequestDto`: `propertyid`, `apikey`, `action: "property_info"`, `version: "2"` | ✅ Exact doc match |
| Room/rate info request wrapper | `RatePlanInfoRequestDto`: `propertyid`, `apikey`, `action: "roomrate_info"`, `version: "2"` | ✅ Exact doc match |
| Reservation delivery request wrapper | `ReservationRequestDto`: `propertyid`, `apikey`, `action: "reservation_info"`, `version: "2"`, `reservations: { reservation: [] }` | ✅ Exact doc match (wrapper level) |
| apikey in request body | All DTOs include `apikey` field; guard validates `body.apikey` | ✅ Exact doc match |
| version as string `"2"` | All request DTOs enforce `@IsIn(['2'])` on `version` | ✅ Exact doc match |
| Push acknowledgment shape | All push endpoints return `{ status: "success" | "fail", error_desc: "" }` | ✅ Exact doc match |
| Reservation acknowledgment shape | Returns array: `[{ bookingId, status, error_desc }, { trackingId }]` | ✅ Exact doc match |

---

## 2. Current Adapter Endpoints

These are our **internal partner-facing adapter routes** — they are NOT STAAH-native endpoint paths/names.
The request body contracts are either doc-inspired (push data shape) or our own design.

| Adapter Route | Purpose | Notes |
|---|---|---|
| `POST /api/v1/staah/productInfo` | Adapter over STAAH `property_info` semantics | Route name is ours; body contract is doc match |
| `POST /api/v1/staah/ratePlanInfo` | Adapter over STAAH `roomrate_info` semantics | Route name is ours; body contract is doc match |
| `POST /api/v1/staah/inventoryUpdate` | Inbound push adapter for availability | Split single-concern endpoint; `data[]` shape doc-inspired but not proven as standalone STAAH contract |
| `POST /api/v1/staah/rateUpdate` | Inbound push adapter for rates | Same — split; `data[]` with occupancy-keyed rates is adapter design |
| `POST /api/v1/staah/restrictionUpdate` | Inbound push adapter for restrictions | Same — split; `data[]` with `type`/`value` fields is adapter design |
| `POST /api/v1/staah/reservation` | Adapter over STAAH `reservation_info` semantics | Wrapper matches doc; inner reservation item schema not fully verified |
| `POST /api/v1/staah/arrInfo` *(new)* | Adapter for `ARR_info` ARI date-range pull | Body matches verified STAAH v2 pull request contract |
| `POST /api/v1/staah/yearInfoArr` *(new)* | Adapter for `year_info_ARR` full-year pull | Body matches verified STAAH v2 pull request contract |

---

## 3. Current Unverified / Risky Areas

### 3.1 ARR_info — was missing, now added (Priority B)
- **Status before this change**: No dedicated endpoint. No DTO. No service method. Not in tests.
- **Status after this change**: Added `POST /api/v1/staah/arrInfo` — request body exactly matches verified doc contract.
- **Remaining risk**: Response format (what data we return from DB) is an adapter design; the exact shape STAAH expects in the pull response is not confirmed from fetched snippets.

### 3.2 year_info_ARR — was missing, now added (Priority B)
- **Status before this change**: No dedicated endpoint. Not in tests.
- **Status after this change**: Added `POST /api/v1/staah/yearInfoArr` — request body matches verified doc contract.
- **Remaining risk**: Same as ARR_info — response format is adapter-defined.

### 3.3 Push data split endpoints vs unified doc pattern
The STAAH v2 push doc shows a **unified** push payload with `data[]` containing mixed ARI fields.
Our implementation splits this into:
- `inventoryUpdate` for availability
- `rateUpdate` for rates
- `restrictionUpdate` for restrictions

These are practical adapter splits. They are **not confirmed as proper standalone contracts** that STAAH would actually send.

### 3.4 Reservation inner item field uncertainty
The `reservation.dto.ts` uses `reservations: Record<string, any>` — the wrapper structure is verified but individual field names inside `reservations.reservation[]` (e.g., `bookingId`, `room_id`, `rate_id`, `checkIn`, `checkOut`) are **not proven** against full official STAAH sample payloads.

### 3.5 modifyReservation and cancelReservation
- **Classification**: Unverified custom extension / adapter-custom
- **Status**: Kept in code for local business flow use (logging/storage)
- **Risk**: Not confirmed as first-class STAAH v2 operations in available doc snippets.
- **Action taken**: Code comments now explicitly label these as adapter/custom extensions.
- **Excel safety**: NOT safe to claim as official STAAH operations.

---

## 4. Required Code Fixes

### 4.1 ✅ Already correct — no change needed
- All core validated DTOs already enforce `@IsIn(['property_info'])`, `@IsIn(['roomrate_info'])`, `@IsIn(['reservation_info'])`, `@IsIn(['2'])`
- Guard correctly checks `body.apikey`
- All response shapes match STAAH push ack pattern

### 4.2 ✅ Done — ARR_info and year_info_ARR added (Priority B)
| File | Change |
|---|---|
| `src/modules/staah/dto/arr-info.dto.ts` | Created — `ArrInfoRequestDto`, `ArrInfoResponseDto` |
| `src/modules/staah/dto/year-info-arr.dto.ts` | Created — `YearInfoArrRequestDto`, `YearInfoArrResponseDto` |
| `src/modules/staah/staah.controller.ts` | Added `POST arrInfo` and `POST yearInfoArr` routes |
| `src/modules/staah/staah.service.ts` | Added `getArrInfo()` and `getYearInfoArr()` service methods |
| `src/modules/staah/constants/staah-messages.ts` | Added `ARR_INFO_NOT_FOUND`, `YEAR_INFO_ARR_NOT_FOUND` messages |
| `test/staah-api.test.js` | Added `testArrInfo()` and `testYearInfoArr()` test functions |

### 4.3 ✅ Done — adapter/custom labels added (Priority C)
| File | Change |
|---|---|
| `src/modules/staah/dto/modify-reservation.dto.ts` | Added JSDoc comment marking as adapter/custom |
| `src/modules/staah/dto/cancel-reservation.dto.ts` | Added JSDoc comment marking as adapter/custom |
| `src/modules/staah/staah.controller.ts` | Added route-level comments for modify/cancel |

---

## 5. Safe Values for Excel Integration Form

Only fill in these from our backend:

| Field | Value |
|---|---|
| Integration endpoint: Product Info | `https://api.dvi.travel/api/v1/staah/productInfo` |
| Integration endpoint: Rate Plan Info | `https://api.dvi.travel/api/v1/staah/ratePlanInfo` |
| Integration endpoint: Inventory Update (adapter) | `https://api.dvi.travel/api/v1/staah/inventoryUpdate` |
| Integration endpoint: Rate Update (adapter) | `https://api.dvi.travel/api/v1/staah/rateUpdate` |
| Integration endpoint: Restriction Update (adapter) | `https://api.dvi.travel/api/v1/staah/restrictionUpdate` |
| Integration endpoint: Reservation | `https://api.dvi.travel/api/v1/staah/reservation` |
| Integration endpoint: ARI Date-Range Pull (adapter) | `https://api.dvi.travel/api/v1/staah/arrInfo` |
| Integration endpoint: ARI Full-Year Pull (adapter) | `https://api.dvi.travel/api/v1/staah/yearInfoArr` |
| HTTP Method | `POST` (all endpoints) |
| Content-Type | `application/json` |
| Authentication method | API key in request body field `apikey` |
| Supported wrappers | `property_info`, `roomrate_info`, `reservation_info`, `ARR_info`, `year_info_ARR` |
| Response status model | `{ "status": "success" | "fail", "error_desc": "" }` |
| Push ack format | `{ "status": "success", "error_desc": "" }` |
| Reservation ack format | `[{ "bookingId": "...", "status": "success", "error_desc": "" }, { "trackingId": "..." }]` |

---

## 6. Fields NOT Safe to Fill Yet

These must NOT appear in any Excel/certification form until verified separately:

| Field | Why not safe |
|---|---|
| STAAH-provided service URL (test) | Must be provided by STAAH |
| STAAH-provided service URL (production) | Must be provided by STAAH |
| Whitelisted inbound IPs | Depends on infra/ops decision and STAAH side configuration |
| Live property ID / pilot property | Must be confirmed with STAAH and DVI business team |
| Live `apikey` credential | Must be issued by STAAH for production |
| Modify Reservation endpoint | NOT confirmed as official STAAH v2 contract |
| Cancel Reservation endpoint | NOT confirmed as official STAAH v2 contract |
| Reservation inner item field names | Not proven against full official STAAH sample payloads |
| Push `data[]` unified format claims | Our split push endpoints are adapter-designed, not proven as exact STAAH-expected format |
| ARR_info pull response body format | Our response format is adapter-defined; exact STAAH expected shape not confirmed |
| CTA/CTD/min-max-stay support | Not tested and not confirmed in any DTO or service logic |
| Retry SLA/failure notification | Operational decision not in backend |

---

## 7. Certification Readiness Checklist

| Item | Status |
|---|---|
| Core request wrappers match STAAH v2 doc | ✅ Yes |
| version `"2"` enforced in all request DTOs | ✅ Yes |
| apikey in body + guard protection | ✅ Yes |
| Push acknowledgment shape aligned | ✅ Yes |
| ARR_info pull endpoint implemented | ✅ Yes (new) |
| year_info_ARR pull endpoint implemented | ✅ Yes (new) |
| ARR_info pull response format verified | ⚠️ Adapter-defined; must confirm with STAAH |
| Push split endpoints proven as standalone STAAH contracts | ⚠️ Not confirmed — adapter design |
| Reservation inner item fields proven | ⚠️ Not proven — pass-through |
| modifyReservation is official STAAH v2 | ❌ Not confirmed — adapter/custom |
| cancelReservation is official STAAH v2 | ❌ Not confirmed — adapter/custom |
| IP whitelist configured for production | ⚠️ Configurable via `STAAH_ALLOWED_IPS` env var |
| Live credentials in place | ❌ Needs STAAH provisioning |
