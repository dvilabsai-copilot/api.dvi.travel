<!-- converted from Hobse API Live for DVI.docx -->

Hobse API Live for DVI
API Documentation Reference
URL: http://devdoc.hobse.com/
Access Token: DVIHolidays_API_USER_889
API Endpoints
- https://api.hobse.com/v1/htl/GetHotelList
- https://api.hobse.com/v1/htl/GetHotelRoomDetail
- https://api.hobse.com/v1/htl/GetAvailableRoomTariff
- https://api.hobse.com/v1/htl/CalculateReservationCost
- https://api.hobse.com/v1/htl/CreateBooking
- https://api.hobse.com/v1/htl/GetHotelRatePlanDetail
- https://api.hobse.com/v1/htl/SetBookingStatus
- https://api.hobse.com/v1/htl/GetHotelInfo
- https://api.hobse.com/v1/htl/GetBooking
- https://api.hobse.com/v1/htl/GetCityDetail

LIVE Credentials
Product Token: PbsDCcxq81gfo00DVIHl148eF0tT
Access Token: Ah825fs13pjP984DVIH0016vb1098
Client Token: C3g8K3b1wray989DVIT37od34r64r
LIVE Partner Data
PartnerId: a14fc9d3a3e31230
partnerTypeId: 4
partnerType: TA
PriceOwnerType: 2
tariffMode:B2B
priceOwnerType: 2
API Overview
The GetHotelList, GetHotelInfo and GetHotelRoomDetail APIs can be used to fetch the hotel information.
To get the tariff of all available hotels on any city for a given date range, GetAvailableRoomTariff API can be called. This API also accepts the tariff mode parameter as it can fetch you B2B or B2C tariff. This will also search based on the required number of rooms and the Pax requirement on each room. So the result will fetch only the rooms which are available on the given dates and can accommodate the Pax requirements along with the rates of the requested tariff mode. Hotels can be fetched based on CityId GetCityDetail API or individual hotel ids in hotelFilter array. If both CityId and hotelFilter array passed in the input, system will take hotelFilter array for processing.
Once after the user selected the required rooms, the CalculateReservationCost API can be called to arrive the final total price just before confirm the order. Then the CreateBooking can be called to make the reservation.
SetBookingStatus API can be used to Cancel the created booking. At any time, to know the details and status of the booking, you can use GetBooking API.

