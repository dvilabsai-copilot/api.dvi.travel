const axios = require('axios');
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const base = 'http://127.0.0.1:4006/api/v1';
(async () => {
  fs.mkdirSync('verification-e2e', { recursive: true });

  const planId = 20;
  const routeId = 368;
  const checkInDate = '2026-04-16';
  const checkOutDate = '2026-04-17';

  const searchReq = {
    cityCode: 'Bangalore',
    checkInDate,
    checkOutDate,
    roomCount: 1,
    guestCount: 2,
    providers: ['hobse']
  };
  fs.writeFileSync('verification-e2e/1-search-request.json', JSON.stringify(searchReq, null, 2));
  const searchResp = await axios.post(`${base}/hotels/search`, searchReq, { timeout: 120000 });
  fs.writeFileSync('verification-e2e/1-search-response.json', JSON.stringify(searchResp.data, null, 2));
  const hotel = searchResp.data?.data?.hotels?.[0];
  if (!hotel) throw new Error('No hotels from search');

  const prebookReq = {
    itinerary_plan_ID: planId,
    hotel_bookings: [
      {
        provider: hotel.provider,
        routeId,
        hotelCode: String(hotel.hotelCode),
        bookingCode: String(hotel.searchReference),
        roomType: String(hotel.roomType || 'Superior Room'),
        checkInDate,
        checkOutDate,
        numberOfRooms: 1,
        guestNationality: 'IN',
        netAmount: Number(hotel.price || 0),
        passengers: [
          { title: 'Mr', firstName: 'Real', lastName: 'Flow', paxType: 1, leadPassenger: true, age: 34, phoneNo: '9876543210', panNo: 'ABCDE1234F', passportNo: 'N1234567' },
          { title: 'Mrs', firstName: 'Real', lastName: 'Flow', paxType: 1, leadPassenger: false, age: 30, phoneNo: '9876543210', panNo: 'ABCDE1234F', passportNo: 'N1234568' }
        ]
      }
    ],
    endUserIp: '127.0.0.1'
  };
  fs.writeFileSync('verification-e2e/2-prebook-request.json', JSON.stringify(prebookReq, null, 2));
  const prebookResp = await axios.post(`${base}/itineraries/hotels/prebook`, prebookReq, { timeout: 120000 });
  fs.writeFileSync('verification-e2e/2-prebook-response.json', JSON.stringify(prebookResp.data, null, 2));

  const confirmReq = {
    itinerary_plan_ID: planId,
    agent: 125,
    primary_guest_salutation: 'Mr',
    primary_guest_name: 'Real Flow',
    primary_guest_contact_no: '9876543210',
    primary_guest_age: '34',
    primary_guest_alternative_contact_no: '',
    primary_guest_email_id: 'real.flow@example.com',
    adult_name: ['Second Adult'],
    adult_age: ['30'],
    child_name: [],
    child_age: [],
    infant_name: [],
    infant_age: [],
    arrival_date_time: '16-04-2026 12:00 AM',
    arrival_place: 'Bangalore',
    arrival_flight_details: '',
    departure_date_time: '17-04-2026 12:00 AM',
    departure_place: 'Bangalore',
    departure_flight_details: '',
    price_confirmation_type: 'old',
    hotel_group_type: '1',
    hotel_bookings: prebookReq.hotel_bookings,
    primaryGuest: { salutation: 'Mr', name: 'Real Flow', phone: '9876543210', email: 'real.flow@example.com' },
    endUserIp: '127.0.0.1'
  };
  fs.writeFileSync('verification-e2e/3-confirm-request.json', JSON.stringify(confirmReq, null, 2));
  const confirmResp = await axios.post(`${base}/itineraries/confirm-quotation`, confirmReq, { timeout: 120000 });
  fs.writeFileSync('verification-e2e/3-confirm-response.json', JSON.stringify(confirmResp.data, null, 2));

  const confirmedRows = await prisma.$queryRawUnsafe('SELECT confirmed_itinerary_plan_ID, itinerary_plan_ID, agent_id, itinerary_quote_ID, itinerary_total_net_payable_amount, createdon FROM dvi_confirmed_itinerary_plan_details ORDER BY confirmed_itinerary_plan_ID DESC LIMIT 1');
  fs.writeFileSync('verification-e2e/4-db-confirmed-itinerary-last.json', JSON.stringify(confirmedRows, null, 2));

  const hobseRows = await prisma.$queryRawUnsafe('SELECT hobse_hotel_booking_confirmation_ID, plan_id, route_id, hotel_code, booking_id, booking_status, total_amount, check_in_date, check_out_date, created_at FROM hobse_hotel_booking_confirmation ORDER BY hobse_hotel_booking_confirmation_ID DESC LIMIT 1');
  fs.writeFileSync('verification-e2e/5-db-hobse-booking-last.json', JSON.stringify(hobseRows, null, 2));

  console.log('E2E_OK');
  console.log(JSON.stringify({
    quoteId: confirmResp.data?.quoteId,
    confirmedItineraryPlanId: confirmResp.data?.confirmed_itinerary_plan_ID,
    bookingResults: confirmResp.data?.bookingResults
  }, null, 2));

  await prisma.$disconnect();
})().catch(async (e) => {
  fs.writeFileSync('verification-e2e/3-confirm-response-error.json', JSON.stringify(e.response?.data || { message: e.message }, null, 2));
  console.log('E2E_ERR');
  console.log(JSON.stringify(e.response?.data || { message: e.message }, null, 2));
  await prisma.$disconnect();
  process.exit(1);
});
