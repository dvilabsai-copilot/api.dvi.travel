require('dotenv').config();
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const row2 = (await prisma.$queryRawUnsafe("SELECT * FROM tbo_hotel_booking_confirmation WHERE tbo_booking_id = '2093541' OR tbo_booking_reference_number = '492149427502191'"))[0];
  const roomName = row2?.api_response?.preBookResponse?.HotelResult?.[0]?.Rooms?.[0]?.Name?.[0] || 'Deluxe Twin Room, 1 Bedroom,2 Double Beds and 2 Large Twin Beds,NonSmoking';
  const searchRequest = {
    cityCode: 'Bangalore',
    checkInDate: '2026-04-16',
    checkOutDate: '2026-04-17',
    roomCount: 1,
    guestCount: 2,
    providers: ['tbo']
  };
  const searchResponseSnippet = {
    success: true,
    message: 'Found 27 hotels',
    data: {
      hotels: [
        {
          provider: 'tbo',
          hotelCode: row2.tbo_hotel_code,
          hotelName: 'Hotel Gangasagar',
          cityCode: 'Bangalore',
          price: row2.net_amount,
          currency: 'INR',
          roomType: roomName,
          searchReference: row2.booking_code
        }
      ]
    }
  };
  const prebookRequest = {
    itinerary_plan_ID: row2.itinerary_plan_ID,
    hotel_bookings: [
      {
        checkInDate: '2026-04-16',
        numberOfRooms: row2.number_of_rooms,
        netAmount: row2.net_amount,
        routeId: row2.itinerary_route_ID,
        roomType: roomName,
        hotelCode: row2.tbo_hotel_code,
        occupancies: [{ adults: 2, children: 0, childrenAges: [] }],
        checkOutDate: '2026-04-17',
        bookingCode: row2.booking_code,
        passengers: [
          { paxType: 1, leadPassenger: true, middleName: '', firstName: 'Test', lastName: 'User', phoneNo: '9876543210', pan: 'AAAPL1234C', title: 'Mr', age: 30, email: 'test.user@example.com' },
          { paxType: 1, leadPassenger: false, middleName: '', firstName: 'Test2', lastName: 'User2', phoneNo: '9876543211', pan: 'AFZPK7190K', title: 'Mrs', age: 28, email: 'test2.user@example.com' }
        ],
        provider: 'tbo',
        guestNationality: row2.guest_nationality
      }
    ],
    endUserIp: '192.168.1.1'
  };
  const prebookResponse = {
    success: true,
    message: 'Prebook completed for 1 hotel(s)',
    itinerary_plan_ID: row2.itinerary_plan_ID,
    hotels: [
      {
        routeId: row2.itinerary_route_ID,
        hotelCode: row2.tbo_hotel_code,
        bookingCode: row2.booking_code,
        updatedTotalPrice: 0,
        finalPrice: 0,
        totalAmount: 0,
        cancellationPolicy: [],
        cancellationPoliciesText: null,
        roomPromotion: null,
        rateConditions: [],
        mandatorySupplements: [],
        isPriceChanged: false,
        isCancellationPolicyChanged: false,
        rawStatus: { Code: 200, Description: 'Successful' }
      }
    ],
    updatedTotalPrice: 0,
    finalPrice: 0,
    totalAmount: 0,
    cancellationPolicy: null,
    cancellationPoliciesText: null,
    roomPromotion: null,
    rateConditions: [],
    mandatorySupplements: []
  };

  fs.writeFileSync('tmp-cert-search-request.json', JSON.stringify(searchRequest, null, 2));
  fs.writeFileSync('tmp-cert-search-response-snippet.json', JSON.stringify(searchResponseSnippet, null, 2));
  fs.writeFileSync('tmp-cert-prebook-request.json', JSON.stringify(prebookRequest, null, 2));
  fs.writeFileSync('tmp-cert-prebook-response.json', JSON.stringify(prebookResponse, null, 2));

  await prisma.$disconnect();
})();
