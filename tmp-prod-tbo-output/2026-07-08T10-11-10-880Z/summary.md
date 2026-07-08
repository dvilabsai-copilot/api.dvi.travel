# TBO Live Probe

Generated at: 2026-07-08T10:11:20.104Z
Output directory: tmp-prod-tbo-output/2026-07-08T10-11-10-880Z

## Result
- auth: ok (HTTP 200, API 1)
- country_list: ok (HTTP 200, API 200)
- city_list: ok (HTTP 200, API 200)
- hotel_code_list: ok (HTTP 200, API 200)
- search: ok (HTTP 200, API 200)
- prebook: insufficient_balance (HTTP 200, API 300)

## Auth Request
```json
{
  "ClientId": "tboprod",
  "UserName": "IXMD112",
  "Password": "api-11#M$new",
  "EndUserIp": "134.209.145.185"
}
```

## Auth Response
```json
{
  "Status": 1,
  "TokenId": "6d2e7f46-a0f3-4bd7-87ab-b6cfbdffab1c",
  "Error": {
    "ErrorCode": 0,
    "ErrorMessage": ""
  },
  "Member": {
    "FirstName": "SRINIVASA RAO",
    "LastName": "VEMURI",
    "Email": "vsr@dvi.co.in",
    "MemberId": 45854,
    "AgencyId": 42002,
    "LoginName": "IXMD112",
    "LoginDetails": "Login Success at#@ 08/07/2026 02:52:13 #@ IPAddress: 172.16.3.93",
    "isPrimaryAgent": false
  }
}
```

## PreBook Request
```json
{
  "BookingCode": "1011647!TB!2!TB!59a45c31-7ab5-11f1-93ff-3603d97837fd!TB!N!TB!AFF!",
  "PaymentMode": "Limit",
  "GuestNationality": "IN",
  "NoOfRooms": 1
}
```

## PreBook Response
```json
{
  "Status": {
    "Code": 300,
    "Description": "Insufficient Balance."
  },
  "HotelResult": [
    {
      "HotelCode": "1011647",
      "Currency": "INR",
      "Rooms": [
        {
          "Name": [
            "Club Double Room"
          ],
          "BookingCode": "1011647!TB!2!TB!59a45c31-7ab5-11f1-93ff-3603d97837fd!TB!N!TB!AFF!",
          "Inclusion": "Room Only",
          "DayRates": [
            [
              {
                "BasePrice": 4666.96
              }
            ]
          ],
          "TotalFare": 4965.35,
          "TotalTax": 298.39,
          "NetAmount": 4965.3484833,
          "NetTax": 298.3865483000001,
          "CancelPolicies": [
            {
              "FromDate": "07-07-2026 00:00:00",
              "ChargeType": "Fixed",
              "CancellationCharge": 0
            },
            {
              "FromDate": "22-07-2026 00:00:00",
              "ChargeType": "Fixed",
              "CancellationCharge": 4943.62
            }
          ],
          "MealType": "Room_Only",
          "IsRefundable": true,
          "WithTransfers": false,
          "LastCancellationDeadline": "21-07-2026 23:59:59",
          "PriceBreakUp": [
            {
              "RoomRate": 4539.37,
              "RoomTax": 275.4200000000001,
              "ServiceFee": 127.591935,
              "TaxBreakup": [
                {
                  "TaxType": "Tax_IGST",
                  "TaxableAmount": 127.591935,
                  "TaxPercentage": 18,
                  "TaxAmount": 22.9665483
                }
              ]
            }
          ]
        }
      ],
      "RateConditions": [
        "Early check out will attract full cancellation charge unless otherwise specified",
        "Guests below 18 years of age NOT allowed",
        "Children allowed",
        "Unmarried couples NOT allowed",
        "Bachelors are allowed",
        "Alcohol consumption NOT allowed within the premises",
        "Food from outside NOT allowed within the premises",
        "Non-Veg NOT allowed within the premises",
        "All government COVID-19 guidelines for Food Hygiene followed",
        "Aadhar, Passport and Drivers License are acceptable ID Proofs",
        "Pets NOT allowed within the premises",
        "Smoking NOT allowed within the premises",
        "Visitors NOT allowed within the premises",
        "Private parties or events are allowed at the property",
        "Guests can pay by Debit/ Credit Card (VISA & Mastercard)",
        "Government aligned quarantine protocol being followed",
        "Property staff understands all hygiene guidelines",
        "All common areas are fully sanitized regularly",
        "All rooms are fully sanitized between two stays",
        "Contactless room service option available",
        "Guests who have fever are not allowed",
        "Property is Elderly-friendly/Disabled-friendly",
        "Extra charges may be applicable for 'Gala Dinner' on Christmas Eve (24th December), Christmas Day (25th December) and New Year's Eve (31st December). These can be paid directly at the property."
      ]
    }
  ],
  "ValidationInfo": {
    "PanMandatory": false,
    "PassportMandatory": false,
    "CorporateBookingAllowed": false,
    "PanCountRequired": 0,
    "SamePaxNameAllowed": true,
    "SpaceAllowed": true,
    "SpecialCharAllowed": false,
    "PaxNameMinLength": 1,
    "PaxNameMaxLength": 35,
    "CharLimit": true,
    "PackageFare": false,
    "PackageDetailsMandatory": false,
    "DepartureDetailsMandatory": false,
    "GSTAllowed": true,
    "CrpPANMandatory": false,
    "IsAgencyOwnPANAllowed": false
  }
}
```