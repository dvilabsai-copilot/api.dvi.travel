# STAAH Integration Notes

## Backend endpoint URLs to fill in Excel

Base API domain provided for sheet entry: `https://api.dvi.travel`

Product Info:
https://api.dvi.travel/staah/productInfo

Rate Plan Info:
https://api.dvi.travel/staah/ratePlanInfo

Inventory Update:
https://api.dvi.travel/staah/inventoryUpdate

Rate Update:
https://api.dvi.travel/staah/rateUpdate

Restriction Update:
https://api.dvi.travel/staah/restrictionUpdate

Reservation:
https://api.dvi.travel/staah/reservation

Modify Reservation:
https://api.dvi.travel/staah/modifyReservation
(ADAPTER/CUSTOM EXTENSION — NOT a confirmed official STAAH v2 operation. Do not include in Excel/certification forms.)

Cancel Reservation:
https://api.dvi.travel/staah/cancelReservation
(ADAPTER/CUSTOM EXTENSION — NOT a confirmed official STAAH v2 operation. Do not include in Excel/certification forms.)

ARI Date-Range Pull (ARR_info — adapter; request body = exact STAAH v2 doc contract):
https://api.dvi.travel/staah/arrInfo

ARI Full-Year Pull (year_info_ARR — adapter; request body = exact STAAH v2 doc contract):
https://api.dvi.travel/staah/yearInfoArr

Note: Current NestJS global prefix in this codebase is `/api/v1`, so runtime URLs are currently:
`https://api.dvi.travel/api/v1/staah/...`

## Fields that backend can fill in Excel

- Integration endpoint URLs listed above
- HTTP method: `POST` (all STAAH endpoints implemented)
- Content type: `application/json` (JSON request/response DTO flow)
- Authentication method: API key in request body, validated by guard (`STAAH_API_KEY`)
- Optional source restriction: IP whitelist via `STAAH_ALLOWED_IPS`
- Response status model: payload status (`success` or `failure`) with HTTP `200` response code

## Fields that still require STAAH or business input

- STAAH service endpoint URL (test)
- STAAH booking endpoint URL (test)
- STAAH service endpoint URL (production)
- STAAH booking endpoint URL (production)
- Whitelisted outbound IPs to share with STAAH
- Confirmed pilot property/property ID for certification
- Live property mapping list and onboarding order
- Final certification credentials/API key from STAAH
- Reservation payload contract details expected in production (create/modify/cancel format)
- Confirmation of CTA/CTD/min-max-stay-through rule coverage requirements
- Retry and failure-notification operational ownership (email/SLA)
