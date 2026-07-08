# TBO Live Verification Report

Date run: `2026-07-08`

## What was verified

- `CityList` returns live cities with the production credentials.
- `TBOHotelCodeList` returns live hotel codes for the selected city.
- `Search` returns live hotel availability and pricing.
- `PreBook` reaches the live endpoint, but the account currently returns `Insufficient Balance`.

## Request Summary

### 1. CityList

- Request: `POST https://affiliate.travelboutiqueonline.com/TBOHolidays_HotelAPI/CityList`
- Body: `{"CountryCode":"IN"}`
- Auth: live production credentials
- Result:
  - `Status.Code = 200`
  - `CityList.length = 1089`
  - Selected city: `Chennai, Tamil Nadu`
  - Selected city code: `127343`

### 2. TBOHotelCodeList

- Request: `POST https://affiliate.travelboutiqueonline.com/TBOHolidays_HotelAPI/TBOHotelCodeList`
- Body: `{"CityCode":"127343","IsDetailedResponse":"true"}`
- Auth: live production credentials
- Result:
  - `Status.Code = 200`
  - `Hotels.length = 1493`

### 3. Search

- Request: `POST https://affiliate.travelboutiqueonline.com/HotelAPI/Search`
- Body:

```json
{
  "CheckIn": "2026-07-23",
  "CheckOut": "2026-07-24",
  "HotelCodes": "<live hotel code batch from CityList/TBOHotelCodeList>",
  "GuestNationality": "IN",
  "PaxRooms": [
    {
      "Adults": 1,
      "Children": 0,
      "ChildrenAges": []
    }
  ],
  "ResponseTime": 23,
  "IsDetailedResponse": true
}
```

- Auth: live production credentials
- Result:
  - `Status.Code = 200`
  - `HotelResult.length = 22`
  - Cheapest returned rate in the sample: `HotelCode = 1061654`, `TotalFare = 1971.55`

### 4. PreBook

- Request: `POST https://affiliate.travelboutiqueonline.com/HotelAPI/PreBook`
- Body:

```json
{
  "BookingCode": "1061654!TB!1!TB!a6a76770-7aa3-11f1-8e9e-ae3aafbd0549!TB!N!TB!AFF!",
  "PaymentMode": "Limit",
  "GuestNationality": "IN",
  "NoOfRooms": 1
}
```

- Auth: live production credentials
- Result:
  - `Status.Code = 300`
  - `Description = "Insufficient Balance."`

## Conclusion

- Live city lookup is working.
- Live hotel code lookup is working.
- Live search is working.
- PreBook is reaching the live API correctly, but the account balance is not sufficient for the tested rate.

## Notes

- The Postman collection has been updated to use variables for:
  - `CountryCode`
  - `CityCode`
  - `CheckIn`
  - `CheckOut`
  - `HotelCodes`
  - `BookingCode`
  - `PaymentMode`
  - `GuestNationality`
  - `NoOfRooms`
- The collection now inherits the live production auth for the CityList, HotelCodeList, Search, and PreBook flow.
