# STAAH Strict Audit

Date: 2026-03-13
Code reviewed:
- `src/modules/staah/staah.controller.ts`
- `src/modules/staah/staah.service.ts`
- `src/modules/staah/dto/*.ts`
- `test/staah-api.test.js`

Doc baseline used:
- STAAH ChannelConnect v2 (`property_info`, `roomrate_info`, `ARR_info`, `year_info_ARR`, `reservation_info`, push delta payload, `version: "2"`)
- STAAH v1 snippets for legacy/compat reference

## Endpoint Audit
| Endpoint | Our route | Our request body | Doc request shape | Match status | Gaps | Safe to put in Excel? yes/no |
| --- | --- | --- | --- | --- | --- | --- |
| Product information | `POST /api/v1/staah/productInfo` | `{ propertyid, apikey, action: "property_info", version: "2" }` | v2 Property Information: `{ propertyid, apikey, action: "property_info", version: "2" }` | Exact doc match | Route path is adapter route naming (not STAAH simulator URL), body contract matches | yes |
| Room/rate information | `POST /api/v1/staah/ratePlanInfo` | `{ propertyid, apikey, action: "roomrate_info", version: "2" }` | v2 Room & Rate: `{ propertyid, apikey, action: "roomrate_info", version: "2" }` | Exact doc match | Route naming is adapter choice, body contract matches | yes |
| ARI date-range pull | Not implemented as dedicated endpoint | N/A | v2 ARR date-range: `{ propertyid, apikey, room_id, rate_id, action: "ARR_info", from_date, to_date, version: "2" }` | Missing doc-native endpoint | No endpoint in code that accepts `action: "ARR_info"` with `from_date`/`to_date` as documented pull call | no |
| ARI full-year pull | Not implemented as dedicated endpoint | N/A | v2 full-year ARR: `{ propertyid, apikey, room_id, rate_id, action: "year_info_ARR", version: "2" }` | Missing doc-native endpoint | No endpoint in code that accepts `action: "year_info_ARR"` as documented pull call | no |
| Push data delta (partner inbound) | `POST /api/v1/staah/inventoryUpdate` | `{ propertyid, room_id, rate_id, apikey, version: "2", data: [{ start_date, end_date, free }] }` | v2 Push Data: `{ propertyid, room_id, rate_id, currency?, apikey, data:[...], trackingId?, version:"2" }` | Likely adapter over doc-native contract | Split into inventory-only structure; missing explicit `currency` and mixed ARI payload fields from full push sample | no |
| Push data delta (partner inbound) | `POST /api/v1/staah/rateUpdate` | `{ propertyid, room_id, rate_id, apikey, version: "2", data:[{ start_date, end_date, ...occupancyRates }] }` | v2 Push Data: unified `data[]` with rates/availability/restrictions per date | Likely adapter over doc-native contract | Split into rate-only endpoint; may diverge from unified push schema expected by STAAH | no |
| Push data delta (partner inbound) | `POST /api/v1/staah/restrictionUpdate` | `{ propertyid, room_id, rate_id, apikey, version: "2", data:[{ start_date, end_date, type, value }] }` | v2 Push Data: unified `data[]` with restrictions embedded per date item | Likely adapter over doc-native contract | Split restriction-only endpoint; lacks explicit evidence this exact standalone shape is accepted by STAAH | no |
| Reservation delivery wrapper | `POST /api/v1/staah/reservation` | `{ propertyid, apikey, action: "reservation_info", version: "2", reservations: { reservation:[...] }, trackingId? }` | v2 Reservations wrapper: same top-level keys | Exact doc match (wrapper) | Inner reservation item schema not strictly validated against complete STAAH sample fields | yes (wrapper only) |
| Reservation delivery item fields | `POST /api/v1/staah/reservation` | Example uses `{ bookingId, room_id, rate_id, checkIn, checkOut }` | v2 doc shows expanded reservation array but full field-level subset from snippet is incomplete in this audit context | Likely adapter over doc-native contract | Field casing/naming and required fields in `reservations.reservation[]` are not fully proven from currently extracted sample details | no |
| Modify reservation | `POST /api/v1/staah/modifyReservation` | `{ propertyid, apikey, version: "2", reservationId, data, trackingId? }` | Not confirmed in fetched v2 snippets as separate contract | Unverified custom extension | No confirmed STAAH v2 operation in this style from available snippets | no |
| Cancel reservation | `POST /api/v1/staah/cancelReservation` | `{ propertyid, apikey, version: "2", reservationId, data, trackingId? }` | Not confirmed in fetched v2 snippets as separate contract | Unverified custom extension | No confirmed STAAH v2 operation in this style from available snippets | no |

## Classification Summary
- Exact doc match:
  - Product information request wrapper
  - Room/rate information request wrapper
  - Reservation request wrapper (top-level)
- Likely adapter over doc-native contract:
  - Inventory/rate/restriction split endpoints (adapter split of push/ARI concerns)
  - Reservation inner item payload fields
- Unverified custom extension:
  - `modifyReservation`
  - `cancelReservation`

## Notes
- Current implementation is a practical adapter layer and no longer has obvious action/version mismatches for the core wrapper calls.
- Certification risk is now concentrated in ARI pull parity, push unified payload parity, and reservation item-field strictness.
