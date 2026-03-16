const fs = require('fs');

const BASE_URL = 'http://127.0.0.1:4010/api/v1';
const OUT_DIR = 'verification-e2e/cert-proof-20260316';

async function postJson(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const searchRequest = {
    cityCode: 'Bangalore',
    checkInDate: '2026-04-16',
    checkOutDate: '2026-04-17',
    roomCount: 1,
    guestCount: 2,
    guestNationality: 'US',
    providers: ['tbo'],
  };

  const searchResponse = await postJson('/hotels/search', searchRequest);
  fs.writeFileSync(`${OUT_DIR}/1-search-request.json`, JSON.stringify(searchRequest, null, 2));
  fs.writeFileSync(`${OUT_DIR}/1-search-response.json`, JSON.stringify(searchResponse, null, 2));

  const firstHotel = searchResponse.body?.data?.hotels?.[0];
  if (!firstHotel) {
    fs.writeFileSync(
      `${OUT_DIR}/proof-summary.json`,
      JSON.stringify(
        {
          status: 'failed',
          reason: 'No hotels returned from search',
          searchResponse,
        },
        null,
        2,
      ),
    );
    return;
  }

  const prebookRequest = {
    itinerary_plan_ID: 1,
    hotel_bookings: [
      {
        provider: 'tbo',
        routeId: 1,
        hotelCode: String(firstHotel.hotelCode),
        bookingCode: String(firstHotel.searchReference || firstHotel.bookingCode),
        roomType: String(firstHotel.roomType || 'Standard Room'),
        checkInDate: searchRequest.checkInDate,
        checkOutDate: searchRequest.checkOutDate,
        numberOfRooms: 1,
        guestNationality: 'US',
        netAmount: Number(firstHotel.price || 0),
        occupancies: [{ adults: 2, children: 0, childrenAges: [] }],
        passengers: [
          {
            title: 'Mr',
            firstName: 'Proof',
            middleName: '',
            lastName: 'UserOne',
            email: 'proof.one@example.com',
            paxType: 1,
            leadPassenger: true,
            age: 33,
            phoneNo: '9876543210',
            pan: 'AAAPL1234C',
          },
          {
            title: 'Ms',
            firstName: 'Proof',
            middleName: '',
            lastName: 'UserTwo',
            email: 'proof.two@example.com',
            paxType: 1,
            leadPassenger: false,
            age: 29,
            phoneNo: '9876543211',
            pan: 'AFZPK7190K',
          },
        ],
      },
    ],
    endUserIp: '192.168.1.1',
  };

  const prebookResponse = await postJson('/itineraries/hotels/prebook', prebookRequest);
  fs.writeFileSync(`${OUT_DIR}/2-prebook-request.json`, JSON.stringify(prebookRequest, null, 2));
  fs.writeFileSync(`${OUT_DIR}/2-prebook-response.json`, JSON.stringify(prebookResponse, null, 2));

  const confirmRequest = {
    itinerary_plan_ID: 1,
    agent: 125,
    primary_guest_salutation: 'Mr',
    primary_guest_name: 'Proof Primary',
    primary_guest_contact_no: '9876543210',
    primary_guest_age: '33',
    primary_guest_alternative_contact_no: '',
    primary_guest_email_id: 'proof.primary@example.com',
    adult_name: [],
    adult_age: [],
    child_name: [],
    child_age: [],
    infant_name: [],
    infant_age: [],
    arrival_date_time: '16-04-2026 09:00 AM',
    arrival_place: 'Bangalore',
    arrival_flight_details: '',
    departure_date_time: '17-04-2026 07:00 PM',
    departure_place: 'Bangalore',
    departure_flight_details: '',
    price_confirmation_type: 'old',
    hotel_group_type: '1',
    hotel_bookings: prebookRequest.hotel_bookings,
    endUserIp: '192.168.1.1',
  };

  const confirmResponse = await postJson('/itineraries/confirm-quotation', confirmRequest);
  fs.writeFileSync(`${OUT_DIR}/3-confirm-request.json`, JSON.stringify(confirmRequest, null, 2));
  fs.writeFileSync(`${OUT_DIR}/3-confirm-response.json`, JSON.stringify(confirmResponse, null, 2));

  const prebookTrace = prebookResponse.body?.hotels?.[0]?.certificationTrace?.prebookRequest || null;
  const prebookMetaShown = {
    hasRateConditions: Array.isArray(prebookResponse.body?.hotels?.[0]?.rateConditions),
    hasMandatorySupplements: Array.isArray(prebookResponse.body?.hotels?.[0]?.mandatorySupplements),
    hasCancellationPolicy: Array.isArray(prebookResponse.body?.hotels?.[0]?.cancellationPolicy),
    hasRawStatus: !!prebookResponse.body?.hotels?.[0]?.rawStatus,
  };

  const summary = {
    search: {
      httpStatus: searchResponse.status,
      guestNationalitySent: searchRequest.guestNationality,
      foundHotels: Number(searchResponse.body?.data?.totalResults || 0),
    },
    prebook: {
      httpStatus: prebookResponse.status,
      paymentMode: prebookTrace?.PaymentMode || null,
      noOfRooms: prebookTrace?.NoOfRooms || null,
      guestNationalityInPrebookPayload: prebookTrace?.GuestNationality || null,
      paxRooms: prebookTrace?.PaxRooms || null,
      metadataShown: prebookMetaShown,
    },
    booking: {
      httpStatus: confirmResponse.status,
      paxTitlesSent: confirmRequest.hotel_bookings[0].passengers.map((p) => p.title),
      outcome:
        Array.isArray(confirmResponse.body?.bookingResults) &&
        confirmResponse.body.bookingResults.every((item) => item?.status === 'confirmed')
          ? 'success'
          : 'handled-failure',
      responseMessage:
        confirmResponse.body?.message || confirmResponse.body?.error || confirmResponse.body?.raw || null,
      bookingResults: confirmResponse.body?.bookingResults || null,
    },
  };

  fs.writeFileSync(`${OUT_DIR}/4-proof-summary.json`, JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  fs.writeFileSync(
    `${OUT_DIR}/4-proof-summary.json`,
    JSON.stringify({ status: 'error', message: err.message, stack: err.stack }, null, 2),
  );
  process.exit(1);
});
