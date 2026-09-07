<!-- converted from ChannelConnectAPI_Certification_TestCase V2_filled.xlsx -->

## Sheet: ARI Tests
| STAAH – ChannelConnect API Integration (V2) |  |  |  |  |
| --- | --- | --- | --- | --- |
| ARI Tests |  |  |  |  |
| Sr No | Description | Request Date Time (GMT +0) | Request | Response |
| 1 | Fetch Property Info                                              (using this API is not mandatory) | 2026-04-09 23:21:13 GMT | {"propertyid":"STAAHTESTHOTEL1","apikey":"Le4-E6F-1F2RB-xZ8a-Oms-jrXIQ-7w73FIH","action":"property_info","version":"2"} | {"checkintime":"02:00 pm","checkouttime":"12:00 am","child_age":"0","contactinfo":{"addressline":"Surat","city":"Adoni","country":"India","email":"uday@staah.com","fax":"","latitude":"21.17024","location":"Surat","longitude":"72.831061","state":"Andhra Pradesh","telephone":"9898989898","zip":"395009"},"currency":"AED","infant_age":"0","propertyname":"Test Property for Channel Connect Partners - Development","trackingId":"8242F0C5-69E8-49CF-8DBC-10167ABEB6D1"} |
| 2 | Fetch Mapping Info                                         (using this API is not mandatory)                                                |  |  |  |
| 3 | Fetch ARI for Single date |  |  |  |
| 4 | Fetch ARI for 28days(consider dates of consecutive months)
Eg. 15th Dec’24 – 14th Jan’25 |  |  |  |
| 5 | Fetch ARI for first 10 days of a month
Eg. 1st June’25 - 10th June’25 |  |  |  |
| 6 | Fetch ARI for Full Sync (1 year or whatever duration supported on the API) |  |  | Please share Response in a separate text file |
## Sheet: Booking Tests
| STAAH – ChannelConnect API Integration (V2) |  |  |  |  |  |  |
| --- | --- | --- | --- | --- | --- | --- |
| Booking Tests |  |  |  |  |  |  |
| Sr No | Booking ID / Reservation Id | Request Date Time (GMT +0) | Description | Status | Request | Response |
| 1 |  |  | Create a booking for Single Room - Single Rate Plan  | Pre-Book or Check availability before confirmation |  |  |
|  |  |  |  | Confirm |  |  |
|  |  |  |  | Pre-Book or Check availability before modification |  |  |
|  |  |  |  | Modify |  |  |
|  |  |  |  | Cancel |  |  |
| 2 |  |  | Create a booking for Single Room - Single Rate Plan - With an Extra Adult/Child (If Supported Extras) | Pre-Book or Check availability before confirmation |  |  |
|  |  |  |  | Confirm |  |  |
|  |  |  |  | Pre-Book or Check availability before modification  |  |  |
|  |  |  |  | Modify |  |  |
|  |  |  |  | Cancel |  |  |
| 3 |  |  | Create a booking for a Single Room - Multiple Rate Plans – Multiple Nights | Pre-Book or Check availability before confirmation |  |  |
|  |  |  |  | Confirm |  |  |
|  |  |  |  | Pre-Book or Check availability before modification |  |  |
|  |  |  |  | Modify |  |  |
|  |  |  |  | Cancel |  |  |
| 4 |  |  | Create a booking for Multiple Rooms - Multiple Rate Plans | Pre-Book or Check availability before confirmation |  |  |
|  |  |  |  | Confirm |  |  |
|  |  |  |  | Pre-Book or Check availability before modification |  |  |
|  |  |  |  | Modify |  |  |
|  |  |  |  | Cancel |  |  |