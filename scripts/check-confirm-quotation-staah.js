const url = 'http://127.0.0.1:4006/api/v1/itineraries/confirm-quotation';

const token =
  'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJpYXQiOjE3Nzk1NTA0MjgsImV4cCI6MTc4MDE1NTIyOH0.JpLZDctwv_ByjQz0owKkPH_bpqILp7fSQbqNhjHJdU4';

const payload = {
  itinerary_plan_ID: 381,
  agent: 8,
  primary_guest_salutation: 'Mr',
  primary_guest_name: 'test',
  primary_guest_contact_no: '23213',
  primary_guest_age: '34',
  primary_guest_alternative_contact_no: '',
  primary_guest_email_id: '',
  adult_name: [],
  adult_age: [],
  child_name: [],
  child_age: [],
  infant_name: [],
  infant_age: [],
  arrival_date_time: '29-05-2026 1:30 PM',
  arrival_place: 'Cochin International Airport',
  arrival_flight_details: '',
  departure_date_time: '01-06-2026 1:30 AM',
  departure_place: 'Cochin International Airport',
  departure_flight_details: '',
  price_confirmation_type: 'new',
  hotel_group_type: '1',
  hotel_bookings: [
    {
      occupancies: [{ adults: 1, children: 0, childrenAges: [] }],
      provider: 'staah',
      routeId: 4738,
      hotelCode: '44674',
      hotelName: 'STAAH TEST HOTEL',
      bookingCode: '44674',
      roomType: 'Deluxe Room - Test',
      checkInDate: '2026-05-29',
      checkOutDate: '2026-05-30',
      numberOfRooms: 1,
      guestNationality: 'IN',
      netAmount: 5460,
      passengers: [
        {
          title: 'Mr',
          firstName: 'test',
          lastName: 'test',
          nationality: 'IN',
          paxType: 1,
          leadPassenger: true,
          age: 34,
          phoneNo: '23213',
        },
      ],
    },
    {
      occupancies: [{ adults: 1, children: 0, childrenAges: [] }],
      provider: 'staah',
      routeId: 4739,
      hotelCode: '44674',
      hotelName: 'STAAH TEST HOTEL',
      bookingCode: '44674',
      roomType: 'Deluxe Room - Test',
      checkInDate: '2026-05-30',
      checkOutDate: '2026-05-31',
      numberOfRooms: 1,
      guestNationality: 'IN',
      netAmount: 5460,
      passengers: [
        {
          title: 'Mr',
          firstName: 'test',
          lastName: 'test',
          nationality: 'IN',
          paxType: 1,
          leadPassenger: true,
          age: 34,
          phoneNo: '23213',
        },
      ],
    },
  ],
  primaryGuest: {
    salutation: 'Mr',
    name: 'test',
    phone: '23213',
    email: '',
  },
  endUserIp: '139.5.249.155',
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