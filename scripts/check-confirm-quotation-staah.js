const url = 'http://127.0.0.1:4006/api/v1/itineraries/confirm-quotation';

const token =
  'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3ODE5ODM0MDAsImV4cCI6MTc4MjU4ODIwMH0.ZRHsuU2WNWvDoNezigUPAMtpkdfaMcdY3pzFaN_0Utc';

const payload = {
  itinerary_plan_ID: 9694,
  agent: 8,
  primary_guest_salutation: 'Mr',
  primary_guest_name: 'test ',
  primary_guest_contact_no: '3333',
  primary_guest_age: '33',
  primary_guest_alternative_contact_no: '',
  primary_guest_email_id: '',
  adult_name: [],
  adult_age: [],
  child_name: [],
  child_age: [],
  infant_name: [],
  infant_age: [],
  arrival_date_time: '15-07-2026 1:30 PM',
  arrival_place: 'Cochin International Airport',
  arrival_flight_details: '',
  departure_date_time: '18-07-2026 1:30 AM',
  departure_place: 'Cochin',
  departure_flight_details: '',
  price_confirmation_type: 'new',
  primaryGuest: {
    salutation: 'Mr',
    name: 'test ',
    phone: '3333',
    email: '',
  },
  endUserIp: '139.5.249.234',
  hotel_group_type: '1',
  hotel_bookings: [
    {
      occupancies: [{ adults: 2, children: 1, childrenAges: [7] }],
      provider: 'staah',
      routeId: 6818,
      hotelCode: '44588',
      hotelName: 'STAAH TEST HOTEL',
      bookingCode: 'STAAH-STAAHTESTHOTEL1-SUITE_ROOM-MAP_PLAN-20260715',
      roomType: 'Suite Room',
      checkInDate: '2026-07-15',
      checkOutDate: '2026-07-16',
      numberOfRooms: 1,
      guestNationality: 'IN',
      netAmount: 1208,
      passengers: [
        {
          title: 'Mr',
          firstName: 'test',
          lastName: 'test',
          nationality: 'IN',
          paxType: 1,
          leadPassenger: true,
          age: 33,
          phoneNo: '3333',
        },
      ],
    },
    {
      occupancies: [{ adults: 2, children: 1, childrenAges: [7] }],
      provider: 'staah',
      routeId: 6819,
      hotelCode: '44588',
      hotelName: 'STAAH TEST HOTEL',
      bookingCode: 'STAAH-STAAHTESTHOTEL1-SUITE_ROOM-MAP_PLAN-20260716',
      roomType: 'Suite Room',
      checkInDate: '2026-07-16',
      checkOutDate: '2026-07-17',
      numberOfRooms: 1,
      guestNationality: 'IN',
      netAmount: 1208,
      passengers: [
        {
          title: 'Mr',
          firstName: 'test',
          lastName: 'test',
          nationality: 'IN',
          paxType: 1,
          leadPassenger: true,
          age: 33,
          phoneNo: '3333',
        },
      ],
    },
  ],
  selected_hotel_route_ids: [6818, 6819],
  external_stay_route_ids: [],
};

(async () => {
  try {
    console.log('--- REQUEST URL ---');
    console.log(url);

    console.log('\n--- REQUEST PAYLOAD ---');
    console.log(JSON.stringify(payload, null, 2));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        Authorization: token,
      },
      body: JSON.stringify(payload),
    });

    const raw = await response.text();

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }

    console.log('\n--- HTTP STATUS ---');
    console.log(response.status, response.statusText);

    console.log('\n--- FULL RESPONSE ---');
    console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));

    console.log(
      `\nRESULT: ${
        response.ok && data && data.success ? 'SUCCESS' : 'FAILURE'
      } - confirm-quotation ${response.ok ? 'responded' : 'failed'}`
    );
  } catch (error) {
    console.error('\nRESULT: FAILURE - request error');
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  }
})();
