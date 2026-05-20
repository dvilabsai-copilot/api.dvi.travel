const fs = require('fs');

const BASE_URL = process.env.PROOF_BASE_URL || 'http://127.0.0.1:4010/api/v1';
const OUT_DIR = 'verification-e2e/cert-proof-final';

function writeJson(name, data) {
  fs.writeFileSync(`${OUT_DIR}/${name}`, JSON.stringify(data, null, 2));
}

function getTopMessage(payload) {
  if (!payload) return null;
  if (typeof payload.message === 'string') return payload.message;
  if (payload.body && typeof payload.body.message === 'string') return payload.body.message;
  if (typeof payload.error === 'string') return payload.error;
  if (payload.body && typeof payload.body.error === 'string') return payload.body.error;
  return null;
}

async function postJson(path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }

  return {
    status: response.status,
    ok: response.ok,
    body: parsed,
  };
}

function extractSearchLogHints() {
  const logPath = `${OUT_DIR}/server.log`;
  if (!fs.existsSync(logPath)) {
    return { noOfRoomsFilter: null, guestNationalityInLog: null };
  }

  const text = fs
    .readFileSync(logPath, 'utf8')
    .replace(/\x1b\[[0-9;]*m/g, '');
  const noOfRoomsMatches = Array.from(text.matchAll(/NoOfRooms\(Filter\):\s*(\d+)/g));
  const nationalityMatches = Array.from(text.matchAll(/GuestNationality:\s*([A-Z]{2})/g));

  const noOfRoomsFilter = noOfRoomsMatches.length
    ? Number(noOfRoomsMatches[noOfRoomsMatches.length - 1][1])
    : null;

  const guestNationalityInLog = nationalityMatches.length
    ? nationalityMatches[nationalityMatches.length - 1][1]
    : null;

  return { noOfRoomsFilter, guestNationalityInLog };
}

function bookingOutcome(confirmResponse) {
  const rows = confirmResponse?.body?.bookingResults;
  if (!Array.isArray(rows) || rows.length === 0) {
    return 'failed';
  }
  return rows.every((row) => row?.status === 'confirmed') ? 'success' : 'failed';
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
  writeJson('1-search-request.json', searchRequest);
  writeJson('1-search-response.json', searchResponse);

  const firstHotel = searchResponse?.body?.data?.hotels?.[0] || null;
  if (!firstHotel) {
    const staleOnlyRequest = {
      itinerary_plan_ID: 1,
      hotel_bookings: [
        {
          provider: 'tbo',
          routeId: 1,
          hotelCode: 'UNKNOWN',
          bookingCode: 'INVALID_BOOKING_CODE_FOR_SESSION_TEST',
          roomType: 'Any',
          checkInDate: searchRequest.checkInDate,
          checkOutDate: searchRequest.checkOutDate,
          numberOfRooms: 1,
          guestNationality: 'US',
          netAmount: 0,
          occupancies: [{ adults: 2, children: 0, childrenAges: [] }],
          passengers: [
            {
              title: 'Mr',
              firstName: 'Session',
              lastName: 'Tester',
              paxType: 1,
              leadPassenger: true,
              age: 30,
              phoneNo: '9876543210',
              pan: 'AAAPL1234C',
            },
          ],
        },
      ],
      endUserIp: '192.168.1.1',
    };

    const staleOnlyResponse = await postJson('/itineraries/hotels/prebook', staleOnlyRequest);
    writeJson('4-stale-session-prebook-request.json', staleOnlyRequest);
    writeJson('4-stale-session-prebook-response.json', staleOnlyResponse);

    const logHints = extractSearchLogHints();
    writeJson('proof-summary.json', {
      status: 'partial',
      reason: 'No hotels returned from search, so prebook/confirm could not be executed.',
      search: {
        httpStatus: searchResponse.status,
        guestNationalitySent: searchRequest.guestNationality,
        foundHotels: Number(searchResponse?.body?.data?.totalResults || 0),
        noOfRoomsUsed: logHints.noOfRoomsFilter,
      },
      prebook: null,
      confirm: null,
      staleSession: {
        httpStatus: staleOnlyResponse.status,
        message: getTopMessage(staleOnlyResponse.body),
      },
    });
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
  writeJson('2-prebook-request.json', prebookRequest);
  writeJson('2-prebook-response.json', prebookResponse);

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
  writeJson('3-confirm-request.json', confirmRequest);
  writeJson('3-confirm-response.json', confirmResponse);

  const staleSessionRequest = {
    itinerary_plan_ID: 1,
    hotel_bookings: [
      {
        provider: 'tbo',
        routeId: 1,
        hotelCode: String(firstHotel.hotelCode),
        bookingCode: 'INVALID_BOOKING_CODE_FOR_SESSION_TEST',
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
            firstName: 'Session',
            lastName: 'Tester',
            paxType: 1,
            leadPassenger: true,
            age: 30,
            phoneNo: '9876543210',
            pan: 'AAAPL1234C',
          },
          {
            title: 'Ms',
            firstName: 'Session',
            lastName: 'Verifier',
            paxType: 1,
            leadPassenger: false,
            age: 28,
            phoneNo: '9876543211',
            pan: 'AFZPK7190K',
          },
        ],
      },
    ],
    endUserIp: '192.168.1.1',
  };

  const staleSessionResponse = await postJson('/itineraries/hotels/prebook', staleSessionRequest);
  writeJson('4-stale-session-prebook-request.json', staleSessionRequest);
  writeJson('4-stale-session-prebook-response.json', staleSessionResponse);

  const prebookTrace = prebookResponse?.body?.hotels?.[0]?.certificationTrace?.prebookRequest || null;
  const prebookHotel = prebookResponse?.body?.hotels?.[0] || null;
  const logHints = extractSearchLogHints();

  const summary = {
    search: {
      httpStatus: searchResponse.status,
      guestNationalitySent: searchRequest.guestNationality,
      foundHotels: Number(searchResponse?.body?.data?.totalResults || 0),
      noOfRoomsUsed: logHints.noOfRoomsFilter,
      guestNationalitySeenInSearchLog: logHints.guestNationalityInLog,
    },
    prebook: {
      httpStatus: prebookResponse.status,
      paymentMode: prebookTrace?.PaymentMode || null,
      noOfRooms: prebookTrace?.NoOfRooms || null,
      mandatorySupplementsPresent: Array.isArray(prebookHotel?.mandatorySupplements)
        ? prebookHotel.mandatorySupplements.length > 0
        : false,
      cancellationPoliciesPresent: Array.isArray(prebookHotel?.cancellationPolicy)
        ? prebookHotel.cancellationPolicy.length > 0
        : false,
      message: getTopMessage(prebookResponse.body),
    },
    confirm: {
      httpStatus: confirmResponse.status,
      passengerTitlesSent: (confirmRequest.hotel_bookings[0]?.passengers || []).map((p) => p.title),
      outcome: bookingOutcome(confirmResponse),
      message: getTopMessage(confirmResponse.body),
    },
    staleSession: {
      httpStatus: staleSessionResponse.status,
      message: getTopMessage(staleSessionResponse.body),
    },
  };

  writeJson('proof-summary.json', summary);
}

main().catch((error) => {
  writeJson('proof-summary.json', {
    status: 'error',
    message: error?.message || 'Unknown error',
    stack: error?.stack || null,
  });
  process.exit(1);
});
