# TBO Hotel Certification Summary (8 Cases)

Generated At: 2026-03-20T06:56:35.858Z
Verdict: READY
Passed Cases: 8
Failed Cases: 0

## Case Results

| Case | Auth | Search | PreBook | Book | GetBookingDetail | Cancel |
|---|---|---|---|---|---|---|
| 1 | success | success | success | success | success | success |
| 2 | success | success | success | success | success | success |
| 3 | success | success | success | success | success | success |
| 4 | success | success | success | success | success | success |
| 5 | success | success | success | success | success | success |
| 6 | success | success | success | success | success | success |
| 7 | success | success | success | success | success | success |
| 8 | success | success | success | success | success | success |

## Runtime Value Chaining

- TokenId is extracted from Authentication and reused in GetBookingDetail and Cancel payloads where executed.
- TraceId, BookingCode, BookingId, ConfirmationNo, NetAmount, AgencyId are extracted and persisted per case.

## Cancel Flow

- Backend provider cancel method detected: yes
- Backend hotels cancel endpoint detected: yes
- Cancel step uses real BookingId + TokenId and stores exact request/response.

## Issues / Blockers

- Postman certification chain and backend public routes are not 1:1 for the full external-provider sequence; this run keeps provider-level flow for evidence parity.
