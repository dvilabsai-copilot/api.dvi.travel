# Hotel API Flow

This note describes the current hotel-details flow for itineraries and the live provider behavior we observed for `DVI20260793`.

## 1. Entry Point

The UI calls:

```http
GET /api/v1/itineraries/hotel_details/:quoteId
```

Example:

```http
GET /api/v1/itineraries/hotel_details/DVI20260793
```

The controller forwards the request to `ItineraryHotelDetailsTboService`.

## 2. Provider Flow

The service builds hotel packages in this order:

1. TBO search
2. HOBSE search if `HOBSE_SEARCH_ENABLED=1`
3. ResAvenue search
4. AxisRooms merge
5. STAAH merge

Relevant environment flags from local `.env`:

- `HOTEL_FETCH_AXIS_ONLY=false`
- `HOTEL_FETCH_TBO_ONLY=false`
- `HOBSE_SEARCH_ENABLED=1`
- `SHOW_HOTEL_MARGINS=false`

## 3. What Happened For `DVI20260793`

Request payload used by the itinerary builder:

```json
{
  "plan": {
    "itinerary_plan_id": 9866,
    "trip_start_date": "2026-07-12T12:00:00+05:30",
    "trip_end_date": "2026-07-14T12:00:00+05:30",
    "adult_count": 2,
    "child_count": 0,
    "nationality": 101
  },
  "routes": [
    { "location_name": "Madurai Airport", "next_visiting_location": "Rameswaram" },
    { "location_name": "Rameswaram", "next_visiting_location": "Rameswaram" },
    { "location_name": "Rameswaram", "next_visiting_location": "Madurai Airport" }
  ]
}
```

Observed final response:

```json
{
  "totalHotels": 106,
  "hotelTabs": 4,
  "providers": ["tbo", "hobse"]
}
```

So for this quote:

- TBO returned the bulk of the hotels.
- HOBSE returned 2 hotels.
- ResAvenue returned 0 hotels in the final merged result.

## 4. Direct Provider Checks

I probed the provider search endpoint directly with the same local server.

### ResAvenue

```http
POST /api/v1/hotels/search
```

Body:

```json
{
  "cityCode": "Rameswaram",
  "checkInDate": "2026-07-12",
  "checkOutDate": "2026-07-13",
  "roomCount": 1,
  "guestCount": 2,
  "adultCount": 2,
  "childCount": 0,
  "guestNationality": "IN",
  "providers": ["resavenue"]
}
```

Result:

```json
{
  "success": true,
  "message": "Found 0 hotels"
}
```

I also tested `Madurai Airport` with `providers: ["resavenue"]` and got the same result: `0 hotels`.

Why it returned zero for the traced hotel:

- The search does reach ResAvenue and gets back property details, inventory, and rate plans.
- For `Vinayaga by Poppys Rameswaram` (`resavenue_hotel_code = 20`), the live inventory response included:

```json
{
  "InvCode": 66,
  "Inventory": [
    { "Date": "2026-07-12", "InvCount": 0 },
    { "Date": "2026-07-13", "InvCount": 0 },
    { "Date": "2026-07-14", "InvCount": 3 }
  ]
}
```

- The provider’s availability check requires all stay dates to have inventory.
- Because the stay range `2026-07-12` to `2026-07-14` includes `2026-07-13` with `InvCount: 0`, `findAvailableRooms()` returns no rooms and the hotel is excluded.

So the zero-result is coming from live availability, not from the API call being skipped.

### HOBSE

Same endpoint, but with `providers: ["hobse"]` and `cityCode: "Rameswaram"`:

```json
{
  "success": true,
  "message": "Found 0 hotels"
}
```

The HOBSE API itself is live and does return tariff data for the same city. A direct probe of `GetAvailableRoomTariff` for `cityId=379` and hotel `fe1d1c893b009365` returned `success=true`, `totalRecords=1`, with room options for `juSTa Sarang Rameshwaram`.

If the provider search returns zero in the app, the most likely reason is the local provider run hitting the 45s timeout while waiting on the tariff call, not a missing upstream response.

#### Postman-ready HOBSE request

`POST https://api.hobse.com/v1/htl/GetAvailableRoomTariff`

Headers:

```http
Content-Type: application/x-www-form-urlencoded
```

Body type: `x-www-form-urlencoded`

Key: `params`

```json
{
  "hobse": {
    "version": "1.0",
    "datetime": "2026-07-10T14:37:09.810+05:30",
    "clientToken": "<HOBSE_CLIENT_TOKEN>",
    "accessToken": "<HOBSE_ACCESS_TOKEN>",
    "productToken": "<HOBSE_PRODUCT_TOKEN>",
    "request": {
      "method": "htl/GetAvailableRoomTariff",
      "data": {
        "sessionId": "DVI-1783694229811",
        "fromDate": "2026-07-12",
        "toDate": "2026-07-14",
        "cityId": "379",
        "priceOwnerType": "2",
        "partnerId": "<HOBSE_PARTNER_ID>",
        "partnerTypeId": "<HOBSE_PARTNER_TYPE_ID>",
        "tariffMode": "B2B",
        "roomData": [
          {
            "adultCount": "2",
            "childCount": "0",
            "infantCount": "0"
          }
        ],
        "hotelFilter": [
          {
            "hotelId": "fe1d1c893b009365"
          }
        ],
        "resultType": "json"
      }
    }
  }
}
```

Successful response excerpt:

```json
{
  "hobse": {
    "version": "1.0",
    "response": {
      "status": {
        "success": "true",
        "code": "200",
        "message": "Result returned successfully"
      },
      "totalRecords": 1,
      "data": [
        {
          "hotelId": "fe1d1c893b009365",
          "hotelName": "juSTa Sarang Rameshwaram",
          "cityName": "Rameswaram",
          "starCategory": "4",
          "roomOptions": [
            {
              "roomName": "Premium Room",
              "ratePlanName": "European Plan",
              "availableRooms": "18",
              "ratesData": [
                {
                  "roomCost": "9240.00",
                  "taxes": "462.00",
                  "totalCostWithTax": "9702.00",
                  "totalPax": 2
                }
              ]
            }
          ]
        }
      ]
    }
  }
}
```

#### ResAvenue inventory dates for the traced hotel

For `Vinayaga by Poppys Rameswaram` (`resavenue_hotel_code = 20`), the live inventory response shows:

- `2026-07-12` has inventory on some room types
- `2026-07-13` is `InvCount: 0` on all traced room types
- `2026-07-14` has inventory on some room types

That means the full stay `2026-07-12` to `2026-07-14` cannot pass the provider’s availability check, because every night must have inventory.

## 5. Conclusion

The provider code is being called.

- HOBSE is enabled and returns a real hotel for `Rameswaram`.
- ResAvenue is called by the flow, but the provider search returns zero hotels for the tested cities, so nothing from ResAvenue makes it into the final itinerary hotel response.

If we want, the next step is to inspect why ResAvenue is returning zero for `Rameswaram` and `Madurai Airport`:

- city-to-master matching
- category filtering
- missing/empty active rooms or rates
- upstream ResAvenue availability
