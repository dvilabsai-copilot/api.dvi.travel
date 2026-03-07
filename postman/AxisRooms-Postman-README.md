# AxisRooms Postman Collection README

This document describes `postman/AxisRooms-Full.postman_collection.json`, generated from actual NestJS AxisRooms code.

## Endpoints Included

### AxisRooms Public APIs
- `POST /api/v1/axisrooms/productInfo`
- `POST /api/v1/axisrooms/ratePlanInfo`
- `POST /api/v1/axisrooms/inventoryUpdate`
- `POST /api/v1/axisrooms/rateUpdate`
- `POST /api/v1/axisrooms/restrictionUpdate`

### AxisRooms Admin APIs
- `GET /api/v1/axisrooms/admin/hotels`
- `GET /api/v1/axisrooms/admin/hotels/export`

## Variables To Set Before Use

Collection variables:
- `baseUrl` (example: `http://localhost:4006`)
- `apiPrefix` (default from app bootstrap: `/api/v1`)
- `axisroomsApiKey` (must match `AXISROOMS_API_KEY` in backend env)
- `adminKey` (must match `ADMIN_EXPORT_KEY` in backend env)
- `propertyId`
- `roomId`
- `rateplanId`
- `startDate` (YYYY-MM-DD)
- `endDate` (YYYY-MM-DD)
- `updatedAfter` (ISO string for admin filters)
- `limit`
- `offset`
- `includeDetails` (`true` or `false`)

## Authentication Difference

- AxisRooms public APIs use request-body auth handled by `AxisRoomsApiKeyGuard`:
  - Body must include:
    - `auth.key = {{axisroomsApiKey}}`
- AxisRooms admin APIs use header auth handled by `AdminKeyGuard`:
  - Header must include:
    - `x-admin-key: {{adminKey}}`

## Example Execution Order

1. `productInfo`
2. `ratePlanInfo`
3. `inventoryUpdate`
4. `rateUpdate`
5. `restrictionUpdate`

Admin APIs can be run anytime after `adminKey` is configured.

## Notes

- Collection request bodies use exact DTO envelope shapes (`{ auth, propertyId }`, `{ auth, data: {...} }`, and `{ auth, data: [...] }`).
- `rateUpdate` sample includes editable occupancy keys (`SINGLE`, `DOUBLE`, `TRIPLE`, `EXTRABED`) as supported by dynamic DTO/service logic.
- Basic Postman tests are included:
  - verify HTTP 200
  - verify `status` field for JSON endpoints
  - store `roomId`/`rateplanId`/`propertyId` into collection variables when feasible
