---
type: "query"
date: "2026-08-11T19:13:08.319030+00:00"
question: "Fix and verify TBO nested RATE_OPTION preview confirmation flow"
contributor: "graphify"
outcome: "useful"
source_nodes: ["TBOHotelProvider", "HotelIntentPreviewResponse", "TboHotelBookingService"]
---

# Q: Fix and verify TBO nested RATE_OPTION preview confirmation flow

## Answer

TBO uses stable provider/hotel/room selectionKey to re-resolve the current supplier BookingCode; regression proves an expired session token is replaced without changing the commercial room. Backend 66 hotel tests and frontend 28 hotel tests pass; both builds pass.

## Outcome

- Signal: useful

## Source Nodes

- TBOHotelProvider
- HotelIntentPreviewResponse
- TboHotelBookingService