/**
 * STAAH Booking Certification Test Script
 * Run this on the production server (whitelisted IP).
 *
 * Usage:
 *   node scripts/staah-booking-test.js
 *
 * Optional env overrides:
 *   STAAH_PROPERTY_ID=STAAHTESTHOTEL1
 *   STAAH_FETCH_URL=https://channelconnect.otaswitch.com/common-cgi/dviholidays/test/services.pl
 *   STAAH_BOOKING_URL=https://channels-stage.staah.net/booking/getapi/reservation/v2
 *   STAAH_ROOM_ID=DELUXEROOM
 *   STAAH_RATE_ID=CPPLAN
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Load .env if present
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const PROPERTY_ID = process.env.STAAH_PROPERTY_ID || 'STAAHTESTHOTEL1';
const API_KEY     = process.env.STAAH_API_KEY || 'Le4-E6F-1F2RB-xZ8a-Oms-jrXIQ-7w73FIH';
const ROOM_ID     = process.env.STAAH_ROOM_ID || 'DELUXEROOM';
const RATE_ID     = process.env.STAAH_RATE_ID || 'CPPLAN';
const FETCH_URL   = process.env.STAAH_FETCH_URL || 'https://channelconnect.otaswitch.com/common-cgi/dviholidays/test/services.pl';
const BOOKING_URL = process.env.STAAH_BOOKING_URL || 'https://reservation.otaswitch.com/getapi/reservation/v2';

const OUT_DIR = path.join(process.cwd(), `staah-booking-cert-${Date.now()}`);
fs.mkdirSync(OUT_DIR, { recursive: true });

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + (parsedUrl.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });

    req.on('error', reject);
    req.setTimeout(20000, () => {
      req.destroy(new Error('Request timeout after 20000ms'));
    });
    req.write(body);
    req.end();
  });
}

function saveEvidence(name, request, response) {
  const reqFile = path.join(OUT_DIR, `${name}_request.json`);
  const resFile = path.join(OUT_DIR, `${name}_response.json`);
  fs.writeFileSync(reqFile, JSON.stringify(request, null, 2), 'utf8');
  fs.writeFileSync(resFile, JSON.stringify({ status: response.status, body: response.body }, null, 2), 'utf8');
  console.log(`  Request  → ${reqFile}`);
  console.log(`  Response → ${resFile}`);
}

function nowIsoSeconds() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function formatLocalIsoSeconds(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
}

function nowIstIsoSeconds() {
  const now = new Date();
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return formatLocalIsoSeconds(istNow);
}

function toMoneyString(value) {
  return Number(value || 0).toFixed(2);
}

function makeBookingId(label) {
  return `DVI-CERT-${label.toUpperCase().replace(/\s+/g, '-')}-${Date.now()}`;
}

function buildGuestCount({
  adultCount = '2',
  childCount = '0',
  infantCount = '0',
}) {
  const guestCount = [];
  if (Number(adultCount || 0) > 0) {
    guestCount.push({
      AgeQualifyingCode: '10',
      Count: String(adultCount),
    });
  }
  if (Number(childCount || 0) > 0) {
    guestCount.push({
      AgeQualifyingCode: '8',
      Count: String(childCount),
    });
  }
  if (Number(infantCount || 0) > 0) {
    guestCount.push({
      AgeQualifyingCode: '7',
      Count: String(infantCount),
    });
  }
  return guestCount;
}

function buildRoomPayload(roomOptions) {
  const {
    arrivalDate,
    departureDate,
    roomId = ROOM_ID,
    roomName = 'Studio',
    rateId = RATE_ID,
    rateName = 'Test MK',
    amountAfterTax = '1200',
    totalTax = '120',
    basePriceAmountAfterTax = '1100',
    extraAdult = '1',
    extraChild = '0',
    extraAdultRate = '100',
    extraChildRate = '0',
    adultCount = '2',
    childCount = '0',
    infantCount = '0',
    salutation = 'Mr.',
    firstName = 'Test',
    lastName = 'Test',
    remarks = 'No Smoking',
    addons = [],
    fees = [],
  } = roomOptions;

  const roomAmountAfterTaxNum = Number(amountAfterTax || 0);
  const totalTaxNum = Number(totalTax || 0);
  const extraAdultNum = Number(extraAdult || 0);
  const extraChildNum = Number(extraChild || 0);
  const extraAdultRateNum = Number(extraAdultRate || 0);
  const extraChildRateNum = Number(extraChildRate || 0);
  const configuredBasePriceNum = Number(basePriceAmountAfterTax || 0);
  const extrasTotalNum = (extraAdultNum * extraAdultRateNum) + (extraChildNum * extraChildRateNum);
  const derivedBasePriceNum = Math.max(roomAmountAfterTaxNum - extrasTotalNum, 0);
  const configuredIsConsistent = Math.abs((configuredBasePriceNum + extrasTotalNum) - roomAmountAfterTaxNum) < 0.01;
  const effectiveBasePriceAfterTaxNum = configuredIsConsistent
    ? configuredBasePriceNum
    : derivedBasePriceNum;

  const roomTotalAmountAfterTaxNum = roomAmountAfterTaxNum + totalTaxNum;

  return {
    room: {
      arrival_date: arrivalDate,
      departure_date: departureDate,
      room_id: roomId,
      room_name: roomName,
      price: [
        {
          date: arrivalDate,
          rate_id: rateId,
          rate_name: rateName,
          amountaftertax: toMoneyString(effectiveBasePriceAfterTaxNum),
          extraGuests: {
            extraAdult: String(extraAdult),
            extraChild: String(extraChild),
            extraAdultRate: String(extraAdultRate),
            extraChildRate: String(extraChildRate),
          },
        },
      ],
      salutation: salutation,
      first_name: firstName,
      last_name: lastName,
      taxes: [
        {
          name: 'service charge',
          value: toMoneyString(totalTaxNum),
        },
      ],
      ...(addons.length > 0 ? { Addons: addons } : {}),
      ...(fees.length > 0 ? { fees } : {}),
      amountaftertax: toMoneyString(roomTotalAmountAfterTaxNum),
      remarks: remarks,
      GuestCount: buildGuestCount({
        adultCount,
        childCount,
        infantCount,
      }),
    },
    totals: {
      roomAmountAfterTaxNum,
      totalTaxNum,
      roomTotalAmountAfterTaxNum,
    },
  };
}

function buildReservationPayload(options) {
  const {
    reservationId,
    reservationDateTime,
    arrivalDate,
    departureDate,
    status,
    amountAfterTax = '1200',
    totalTax = '120',
    basePriceAmountAfterTax = '1100',
    extraAdult = '1',
    extraChild = '0',
    extraAdultRate = '100',
    extraChildRate = '0',
    adultCount = '2',
    remarks = 'Please Provide Wine Upon Checking and Do not Disturb',
    roomRemarks = 'No Smoking',
    rooms,
  } = options;

  const roomPayloads = Array.isArray(rooms) && rooms.length > 0
    ? rooms.map((room) => buildRoomPayload(room))
    : [
        buildRoomPayload({
          arrivalDate,
          departureDate,
          amountAfterTax,
          totalTax,
          basePriceAmountAfterTax,
          extraAdult,
          extraChild,
          extraAdultRate,
          extraChildRate,
          adultCount,
          remarks: roomRemarks,
        }),
      ];

  const totalAmountAfterTax = toMoneyString(
    roomPayloads.reduce((sum, entry) => sum + entry.totals.roomTotalAmountAfterTaxNum, 0),
  );
  const totalTaxAmount = toMoneyString(
    roomPayloads.reduce((sum, entry) => sum + entry.totals.totalTaxNum, 0),
  );
  const runtimeReservationDateTime = reservationDateTime || nowIstIsoSeconds();

  return {
    propertyid: PROPERTY_ID,
    apikey: API_KEY,
    action: 'reservation_info',
    version: '2',
    reservations: {
      reservation: [
        {
          reservation_datetime: runtimeReservationDateTime,
          propertyname: 'STAAH TEST',
          reservation_id: reservationId,
          payment_required: '15',
          payment_type: 'Hotel Collect',
          commissionamount: '0.00',
          discountamount: '0.00',
          deposit: '0.00',
          totalamountaftertax: totalAmountAfterTax,
          totaltax: totalTaxAmount,
          currencycode: 'INR',
          status: status,
          customer: {
            address: 'Ring Road',
            city: 'Surat',
            country: 'India',
            email: 'rk@staah.com',
            salutation: 'Mr.',
            first_name: 'Test',
            last_name: 'Test',
            remarks: remarks,
            telephone: '+91 97734 84053',
            zip: '395004',
          },
          paymentcarddetail: {
            CardHolderName: 'Test STAAH',
            CardType: 'MC',
            ExpireDate: '07/28',
            CardNumber: '4111111111111111',
            cvv: '123',
          },
          room: roomPayloads.map((entry) => entry.room),
          POS: 'TEST',
          extraData: [
            {
              name: 'Key',
              value: 'Value of key',
            },
          ],
        },
      ],
    },
  };
}

function buildArrInfoPayload(fromDate, toDate) {
  return {
    propertyid: PROPERTY_ID,
    apikey: API_KEY,
    room_id: ROOM_ID,
    rate_id: RATE_ID,
    action: 'ARR_info',
    from_date: fromDate,
    to_date: toDate,
    version: '2',
  };
}

async function runTest({ label, excelRow, endpointName, url, payload, bookingId }) {
  if (endpointName === 'booking') {
    const reservation = payload?.reservations?.reservation?.[0];
    if (reservation) {
      // Ensure runtime current datetime for each booking operation.
      reservation.reservation_datetime = nowIstIsoSeconds();
    }
  }

  console.log(`\n=== ${label} ===`);
  console.log(`POST ${url}`);
  console.log('Payload:', JSON.stringify(payload, null, 2));
  const requestedAt = nowIsoSeconds();
  try {
    const res = await postJson(url, payload);
    const pass = res.status === 200;
    console.log(`Status : ${res.status}  →  ${pass ? 'PASS ✓' : 'FAIL ✗'}`);
    console.log('Response:', JSON.stringify(res.body, null, 2));
    saveEvidence(label.toLowerCase().replace(/\s+/g, '_'), payload, res);
    return {
      label,
      excelRow,
      endpointName,
      requestedAt,
      bookingId: bookingId || '',
      request: payload,
      response: { status: res.status, body: res.body },
      status: res.status,
      pass,
      body: res.body,
    };
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    saveEvidence(label.toLowerCase().replace(/\s+/g, '_'), payload, { status: 'ERR', body: err.message });
    return {
      label,
      excelRow,
      endpointName,
      requestedAt,
      bookingId: bookingId || '',
      request: payload,
      response: { status: 'ERR', body: err.message },
      status: 'ERR',
      pass: false,
      body: err.message,
    };
  }
}

async function main() {
  console.log('STAAH Booking Certification Test');
  console.log('==================================');
  console.log(`Property ID : ${PROPERTY_ID}`);
  console.log(`API Key     : ${API_KEY}`);
  console.log(`Fetch URL   : ${FETCH_URL}`);
  console.log(`Booking URL : ${BOOKING_URL}`);
  console.log(`Room ID     : ${ROOM_ID}`);
  console.log(`Rate ID     : ${RATE_ID}`);
  console.log(`Output dir  : ${OUT_DIR}`);

  const results = [];

  const bookingId1 = makeBookingId('S1');
  const bookingId2 = makeBookingId('S2');
  const bookingId3 = makeBookingId('S3');
  const bookingId4 = makeBookingId('S4');
  const bookingId5 = makeBookingId('S5');
  const bookingId6 = makeBookingId('S6');

  const plan = [
    { label: 'S1_01_Pre-Book', row: 5, endpointName: 'fetch', url: FETCH_URL, bookingId: bookingId1, payload: buildArrInfoPayload('2026-07-20', '2026-07-20') },
    { label: 'S1_02_Confirm', row: 6, endpointName: 'booking', url: BOOKING_URL, bookingId: bookingId1, payload: buildReservationPayload({ reservationId: bookingId1, arrivalDate: '2026-07-20', departureDate: '2026-07-21', status: 'Confirm' }) },
    { label: 'S1_03_Pre-Modify', row: 7, endpointName: 'fetch', url: FETCH_URL, bookingId: bookingId1, payload: buildArrInfoPayload('2026-07-21', '2026-07-21') },
    { label: 'S1_04_Modify', row: 8, endpointName: 'booking', url: BOOKING_URL, bookingId: bookingId1, payload: buildReservationPayload({ reservationId: bookingId1, arrivalDate: '2026-07-21', departureDate: '2026-07-22', status: 'Modified' }) },
    { label: 'S1_05_Cancel', row: 9, endpointName: 'booking', url: BOOKING_URL, bookingId: bookingId1, payload: buildReservationPayload({ reservationId: bookingId1, arrivalDate: '2026-07-21', departureDate: '2026-07-22', status: 'Cancel' }) },

    { label: 'S2_01_Pre-Book', row: 10, endpointName: 'fetch', url: FETCH_URL, bookingId: bookingId2, payload: buildArrInfoPayload('2026-08-10', '2026-08-10') },
    { label: 'S2_02_Confirm', row: 11, endpointName: 'booking', url: BOOKING_URL, bookingId: bookingId2, payload: buildReservationPayload({ reservationId: bookingId2, arrivalDate: '2026-08-10', departureDate: '2026-08-11', status: 'Confirm', amountAfterTax: '1300', totalTax: '140', basePriceAmountAfterTax: '1100', extraAdult: '1', extraChild: '1', extraAdultRate: '100', extraChildRate: '100', adultCount: '3' }) },
    { label: 'S2_03_Pre-Modify', row: 12, endpointName: 'fetch', url: FETCH_URL, bookingId: bookingId2, payload: buildArrInfoPayload('2026-08-11', '2026-08-11') },
    { label: 'S2_04_Modify', row: 13, endpointName: 'booking', url: BOOKING_URL, bookingId: bookingId2, payload: buildReservationPayload({ reservationId: bookingId2, arrivalDate: '2026-08-11', departureDate: '2026-08-12', status: 'Modified', amountAfterTax: '1300', totalTax: '140', basePriceAmountAfterTax: '1100', extraAdult: '1', extraChild: '1', extraAdultRate: '100', extraChildRate: '100', adultCount: '3' }) },
    { label: 'S2_05_Cancel', row: 14, endpointName: 'booking', url: BOOKING_URL, bookingId: bookingId2, payload: buildReservationPayload({ reservationId: bookingId2, arrivalDate: '2026-08-11', departureDate: '2026-08-12', status: 'Cancel', amountAfterTax: '1300', totalTax: '140', basePriceAmountAfterTax: '1100', extraAdult: '1', extraChild: '1', extraAdultRate: '100', extraChildRate: '100', adultCount: '3' }) },

    { label: 'S3_01_Pre-Book', row: 15, endpointName: 'fetch', url: FETCH_URL, bookingId: bookingId3, payload: buildArrInfoPayload('2026-09-01', '2026-09-03') },
    { label: 'S3_02_Confirm', row: 16, endpointName: 'booking', url: BOOKING_URL, bookingId: bookingId3, payload: buildReservationPayload({ reservationId: bookingId3, arrivalDate: '2026-09-01', departureDate: '2026-09-03', status: 'Confirm', amountAfterTax: '2100', totalTax: '220', basePriceAmountAfterTax: '1900', adultCount: '2' }) },
    { label: 'S3_03_Pre-Modify', row: 17, endpointName: 'fetch', url: FETCH_URL, bookingId: bookingId3, payload: buildArrInfoPayload('2026-09-02', '2026-09-04') },
    { label: 'S3_04_Modify', row: 18, endpointName: 'booking', url: BOOKING_URL, bookingId: bookingId3, payload: buildReservationPayload({ reservationId: bookingId3, arrivalDate: '2026-09-02', departureDate: '2026-09-04', status: 'Modified', amountAfterTax: '2200', totalTax: '240', basePriceAmountAfterTax: '2000', adultCount: '2' }) },
    { label: 'S3_05_Cancel', row: 19, endpointName: 'booking', url: BOOKING_URL, bookingId: bookingId3, payload: buildReservationPayload({ reservationId: bookingId3, arrivalDate: '2026-09-02', departureDate: '2026-09-04', status: 'Cancel', amountAfterTax: '2200', totalTax: '240', basePriceAmountAfterTax: '2000', adultCount: '2' }) },

    { label: 'S4_01_Pre-Book', row: 20, endpointName: 'fetch', url: FETCH_URL, bookingId: bookingId4, payload: buildArrInfoPayload('2026-10-05', '2026-10-05') },
    { label: 'S4_02_Confirm', row: 21, endpointName: 'booking', url: BOOKING_URL, bookingId: bookingId4, payload: buildReservationPayload({ reservationId: bookingId4, arrivalDate: '2026-10-05', departureDate: '2026-10-06', status: 'Confirm', amountAfterTax: '2400', totalTax: '260', basePriceAmountAfterTax: '2200', adultCount: '4' }) },
    { label: 'S4_03_Pre-Modify', row: 22, endpointName: 'fetch', url: FETCH_URL, bookingId: bookingId4, payload: buildArrInfoPayload('2026-10-06', '2026-10-06') },
    { label: 'S4_04_Modify', row: 23, endpointName: 'booking', url: BOOKING_URL, bookingId: bookingId4, payload: buildReservationPayload({ reservationId: bookingId4, arrivalDate: '2026-10-06', departureDate: '2026-10-07', status: 'Modified', amountAfterTax: '2500', totalTax: '280', basePriceAmountAfterTax: '2300', adultCount: '4' }) },
    { label: 'S4_05_Cancel', row: 24, endpointName: 'booking', url: BOOKING_URL, bookingId: bookingId4, payload: buildReservationPayload({ reservationId: bookingId4, arrivalDate: '2026-10-06', departureDate: '2026-10-07', status: 'Cancel', amountAfterTax: '2500', totalTax: '280', basePriceAmountAfterTax: '2300', adultCount: '4' }) },

    { label: 'S5_01_Pre-Book', row: 25, endpointName: 'fetch', url: FETCH_URL, bookingId: bookingId5, payload: buildArrInfoPayload('2026-07-15', '2026-07-16') },
    {
      label: 'S5_02_Confirm_MultiRoom_Child_Infant',
      row: 26,
      endpointName: 'booking',
      url: BOOKING_URL,
      bookingId: bookingId5,
      payload: buildReservationPayload({
        reservationId: bookingId5,
        arrivalDate: '2026-07-15',
        departureDate: '2026-07-16',
        status: 'Confirm',
        rooms: [
          {
            arrivalDate: '2026-07-15',
            departureDate: '2026-07-16',
            amountAfterTax: '1200',
            totalTax: '120',
            basePriceAmountAfterTax: '1100',
            extraAdult: '0',
            extraChild: '1',
            extraAdultRate: '0',
            extraChildRate: '100',
            adultCount: '2',
            childCount: '1',
            infantCount: '0',
            roomName: 'Studio',
            remarks: 'Room 1: child with extra bed',
          },
          {
            arrivalDate: '2026-07-15',
            departureDate: '2026-07-16',
            amountAfterTax: '1100',
            totalTax: '110',
            basePriceAmountAfterTax: '1100',
            extraAdult: '0',
            extraChild: '0',
            extraAdultRate: '0',
            extraChildRate: '0',
            adultCount: '2',
            childCount: '1',
            infantCount: '1',
            roomName: 'Studio',
            remarks: 'Room 2: child without extra bed and infant',
          },
        ],
      }),
    },
    {
      label: 'S5_03_Cancel_MultiRoom_Child_Infant',
      row: 27,
      endpointName: 'booking',
      url: BOOKING_URL,
      bookingId: bookingId5,
      payload: buildReservationPayload({
        reservationId: bookingId5,
        arrivalDate: '2026-07-15',
        departureDate: '2026-07-16',
        status: 'Cancel',
        rooms: [
          {
            arrivalDate: '2026-07-15',
            departureDate: '2026-07-16',
            amountAfterTax: '1200',
            totalTax: '120',
            basePriceAmountAfterTax: '1100',
            extraAdult: '0',
            extraChild: '1',
            extraAdultRate: '0',
            extraChildRate: '100',
            adultCount: '2',
            childCount: '1',
            infantCount: '0',
            roomName: 'Studio',
            remarks: 'Room 1: child with extra bed',
          },
          {
            arrivalDate: '2026-07-15',
            departureDate: '2026-07-16',
            amountAfterTax: '1100',
            totalTax: '110',
            basePriceAmountAfterTax: '1100',
            extraAdult: '0',
            extraChild: '0',
            extraAdultRate: '0',
            extraChildRate: '0',
            adultCount: '2',
            childCount: '1',
            infantCount: '1',
            roomName: 'Studio',
            remarks: 'Room 2: child without extra bed and infant',
          },
        ],
      }),
    },

    { label: 'S6_01_Pre-Book', row: 28, endpointName: 'fetch', url: FETCH_URL, bookingId: bookingId6, payload: buildArrInfoPayload('2026-07-15', '2026-07-16') },
    {
      label: 'S6_02_Confirm_MultiDay_2Adults',
      row: 29,
      endpointName: 'booking',
      url: BOOKING_URL,
      bookingId: bookingId6,
      payload: buildReservationPayload({
        reservationId: bookingId6,
        arrivalDate: '2026-07-15',
        departureDate: '2026-07-17',
        status: 'Confirm',
        amountAfterTax: '2200',
        totalTax: '240',
        basePriceAmountAfterTax: '2200',
        extraAdult: '0',
        extraChild: '0',
        extraAdultRate: '0',
        extraChildRate: '0',
        adultCount: '2',
        roomRemarks: 'Two-night stay for two adults',
      }),
    },
    {
      label: 'S6_03_Cancel_MultiDay_2Adults',
      row: 30,
      endpointName: 'booking',
      url: BOOKING_URL,
      bookingId: bookingId6,
      payload: buildReservationPayload({
        reservationId: bookingId6,
        arrivalDate: '2026-07-15',
        departureDate: '2026-07-17',
        status: 'Cancel',
        amountAfterTax: '2200',
        totalTax: '240',
        basePriceAmountAfterTax: '2200',
        extraAdult: '0',
        extraChild: '0',
        extraAdultRate: '0',
        extraChildRate: '0',
        adultCount: '2',
        roomRemarks: 'Two-night stay for two adults',
      }),
    },
  ];

  for (const t of plan) {
    results.push(await runTest({
      label: t.label,
      excelRow: t.row,
      endpointName: t.endpointName,
      url: t.url,
      payload: t.payload,
      bookingId: t.bookingId,
    }));
  }

  // ─── Summary ──────────────────────────────────────────────────────
  console.log('\n\n================================');
  console.log('SUMMARY');
  console.log('================================');
  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass).length;
  for (const r of results) {
    console.log(`  ${r.pass ? '✓ PASS' : '✗ FAIL'} [${r.status}]  ${r.label}`);
  }
  console.log(`\nTotal: ${results.length} | Pass: ${pass} | Fail: ${fail}`);
  console.log(`Evidence folder: ${OUT_DIR}`);

  // Write summary JSON
  const summaryFile = path.join(OUT_DIR, 'summary.json');
  fs.writeFileSync(summaryFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    propertyId: PROPERTY_ID,
    fetchUrl: FETCH_URL,
    bookingUrl: BOOKING_URL,
    roomId: ROOM_ID,
    rateId: RATE_ID,
    results,
  }, null, 2), 'utf8');
  console.log(`Summary JSON  : ${summaryFile}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
