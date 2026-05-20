# Fresh Itinerary E2E Proof (DVI20260315)

## Run Scope
- Itinerary quote: DVI20260315
- Itinerary plan ID: 32
- Flow executed from UI modal: Confirm Quotation -> Run Prebook & Continue -> Confirm Booking

## Prebook Result
- Endpoint: POST /api/v1/itineraries/hotels/prebook
- HTTP status: 201
- Message: Prebook completed for 3 hotel(s)
- Certification trace present with expected keys:
  - PaymentMode = Limit
  - GuestNationality = IN
  - NoOfRooms
  - PaxRooms

## Confirm Result
- Endpoint: POST /api/v1/itineraries/confirm-quotation
- HTTP status: 201
- Message: Quotation confirmed successfully
- Confirmed itinerary plan ID: 147
- Booking results: 3/3 hotels confirmed
  - Route 432 -> bookingId 2097731
  - Route 433 -> bookingId 2097732
  - Route 434 -> bookingId 2097733

## Evidence Files
- 0-e2e-capture.json
- 1-prebook-request.json
- 2-prebook-response.json
- 3-confirm-request.json
- 4-confirm-response.json
