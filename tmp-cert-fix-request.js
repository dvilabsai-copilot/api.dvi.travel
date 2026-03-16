require('dotenv').config();
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const row1 = (await prisma.$queryRawUnsafe("SELECT * FROM dvi_confirmed_itinerary_plan_details WHERE confirmed_itinerary_plan_ID = 129"))[0];
  const row2 = (await prisma.$queryRawUnsafe("SELECT * FROM tbo_hotel_booking_confirmation WHERE tbo_booking_id = '2093541' OR tbo_booking_reference_number = '492149427502191'"))[0];
  const roomName = row2?.api_response?.preBookResponse?.HotelResult?.[0]?.Rooms?.[0]?.Name?.[0] || 'Deluxe Twin Room, 1 Bedroom,2 Double Beds and 2 Large Twin Beds,NonSmoking';
  const toYMD = (d) => {
    const dt = new Date(d);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const day = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const confirmRequest = {
    itinerary_plan_ID: row2.itinerary_plan_ID,
    agent: row1.agent_id,
    primary_guest_salutation: 'Mr',
    primary_guest_name: 'TBO Cert User',
    primary_guest_contact_no: '9876543210',
    primary_guest_age: '30',
    primary_guest_alternative_contact_no: '',
    primary_guest_email_id: 'tbo.cert@example.com',
    adult_name: [],
    adult_age: [],
    child_name: [],
    child_age: [],
    infant_name: [],
    infant_age: [],
    arrival_date_time: '16-04-2026 9:00 AM',
    arrival_place: 'Bangalore',
    arrival_flight_details: '',
    departure_date_time: '17-04-2026 7:00 PM',
    departure_place: 'Bangalore',
    departure_flight_details: '',
    price_confirmation_type: 'old',
    hotel_group_type: '1',
    hotel_bookings: [{
      provider: 'tbo',
      routeId: row2.itinerary_route_ID,
      hotelCode: row2.tbo_hotel_code,
      bookingCode: row2.booking_code,
      roomType: roomName,
      checkInDate: toYMD(row2.check_in_date),
      checkOutDate: toYMD(row2.check_out_date),
      numberOfRooms: row2.number_of_rooms,
      guestNationality: row2.guest_nationality,
      netAmount: row2.net_amount,
      occupancies: [{ adults: 2, children: 0, childrenAges: [] }],
      passengers: [
        { title: 'Mr', firstName: 'Test', middleName: '', lastName: 'User', email: 'test.user@example.com', paxType: 1, leadPassenger: true, age: 30, phoneNo: '9876543210', pan: row2?.api_response?.persistenceSnapshot?.panDetails?.[0] || 'AAAPL1234C' },
        { title: 'Mrs', firstName: 'Test2', middleName: '', lastName: 'User2', email: 'test2.user@example.com', paxType: 1, leadPassenger: false, age: 28, phoneNo: '9876543211', pan: row2?.api_response?.persistenceSnapshot?.panDetails?.[1] || 'AFZPK7190K' }
      ]
    }],
    endUserIp: '192.168.1.1'
  };
  fs.writeFileSync('tmp-cert-confirm-request.json', JSON.stringify(confirmRequest, null, 2));
  await prisma.$disconnect();
})();
