# STAAH Certification Safe Fields

## Safe to state publicly

Only items below are backed by current code plus verified request-contract docs already captured in this repository.

- Our publicly exposed route URLs:
  - `POST /api/v1/staah/productInfo`
  - `POST /api/v1/staah/ratePlanInfo`
  - `POST /api/v1/staah/reservation`
  - `POST /api/v1/staah/arrInfo`
  - `POST /api/v1/staah/yearInfoArr`
- HTTP method: `POST`
- Content type: `application/json`
- Authentication field in request body: `apikey`
- Exact supported request wrappers:
  - `action: "property_info"`
  - `action: "roomrate_info"`
  - `action: "reservation_info"`
  - `action: "ARR_info"`
  - `action: "year_info_ARR"`
- Exact version supported on verified request wrappers: `"2"`
- Required request fields on exact-contract wrappers where applicable:
  - `propertyid`
  - `apikey`
  - `action`
  - `version`
  - `room_id`
  - `rate_id`
  - `from_date`
  - `to_date`

## Adapter-only items

These exist in code but are adapter-defined, internal route naming, or not proven as official STAAH topology/response shapes.

- `inventoryUpdate`
- `rateUpdate`
- `restrictionUpdate`
- Internal route names such as `/api/v1/staah/productInfo`, `/api/v1/staah/ratePlanInfo`, `/api/v1/staah/arrInfo`, `/api/v1/staah/yearInfoArr`
- Adapter-defined response bodies for:
  - `productInfo`
  - `ratePlanInfo`
  - `arrInfo`
  - `yearInfoArr`
  - reservation inner item payload schema
- Custom adapter routes (not official STAAH v2):
  - `POST /api/v1/staah/custom/modifyReservation`
  - `POST /api/v1/staah/custom/cancelReservation`
  - legacy aliases retained for compatibility only:
    - `POST /api/v1/staah/modifyReservation`
    - `POST /api/v1/staah/cancelReservation`
- Adapter-defined pull response bodies built from local Prisma tables:
  - `staah_inventory`
  - `staah_rate`

## Not safe to claim yet

- Official STAAH response body shapes for any of the current STAAH routes
- Official response shape for `reservation_info` beyond verified wrapper-level acknowledgement array behavior
- Full reservation item schema inside `reservations.reservation[]`
- `modifyReservation` as an official STAAH operation
- `cancelReservation` as an official STAAH operation
- `inventoryUpdate`, `rateUpdate`, or `restrictionUpdate` as official standalone STAAH operations
- Production IP whitelist details unless verified in infra and agreed with STAAH
- Live credentials or live property IDs
- STAAH-owned service URLs unless supplied by STAAH
