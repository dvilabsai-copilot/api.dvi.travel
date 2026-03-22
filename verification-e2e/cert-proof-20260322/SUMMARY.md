# TBO Modal E2E Proof (2026-03-22)

## Scope Executed
- Triggered TBO from room-selection modal in itinerary details page for `DVI2026037`.
- Ran prebook from modal (`Run Prebook & Continue`).
- Ran final confirm from modal (`Confirm Booking`) after acknowledgement checkbox.

## Captured Evidence
- Prebook response: `1-prebook-response.json`
- Confirm request: `2-confirm-request.json`
- Confirm response: `3-confirm-response.json`

## Outcome
- Prebook API call succeeded with HTTP 201 and certification fields (including `PaymentMode=Limit`, `GuestNationality=IN`, `NoOfRooms`, `PaxRooms`).
- Confirm API call succeeded at API contract level with HTTP 201 and `message: Quotation confirmed successfully`.
- Booking provider result payload reported all three hotel bookings as failed due to provider-side state: `booking under process`.

## Notes
- This run validates modal trigger + payload/response alignment for prebook and final confirm submission.
- Provider booking failure appears operational/upstream and not a frontend trigger failure.
