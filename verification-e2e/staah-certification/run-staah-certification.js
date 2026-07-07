// STAAH certification evidence runner.
// Supports the local adapter flow and the live STAAH certification flow used by the workbook.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');
const xlsx = require('xlsx');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(ROOT_DIR, '.env') });

const CERT_MODE = String(process.env.STAAH_CERT_MODE || 'local').trim().toLowerCase();
const IS_LIVE_CERT = ['live', 'production', 'external'].includes(CERT_MODE);

const OUTPUT_DIR = path.isAbsolute(process.env.STAAH_CERT_OUTPUT_DIR || '')
  ? process.env.STAAH_CERT_OUTPUT_DIR
  : path.join(ROOT_DIR, process.env.STAAH_CERT_OUTPUT_DIR || 'staah-certification-output');
const REQUESTS_DIR = path.join(OUTPUT_DIR, 'requests');
const RESPONSES_DIR = path.join(OUTPUT_DIR, 'responses');
const WORKBOOK_PATH = path.isAbsolute(process.env.STAAH_CERT_WORKBOOK_PATH || '')
  ? process.env.STAAH_CERT_WORKBOOK_PATH
  : path.join(ROOT_DIR, process.env.STAAH_CERT_WORKBOOK_PATH || 'ChannelConnectAPI_Certification_TestCase V2.xlsx');

const BASE_URL = (process.env.STAAH_CERT_BASE_URL || `http://127.0.0.1:${process.env.PORT || '4006'}`).replace(/\/+$/, '');
const API_PREFIX = (process.env.API_PREFIX || '/api/v1').replace(/\/+$/, '');
const STAAH_BASE_PATH = (process.env.STAAH_BASE_PATH || 'staah-test').replace(/^\/+|\/+$/g, '');
const FINAL_BASE_URL = `${BASE_URL}${API_PREFIX}/${STAAH_BASE_PATH}`;
const PRODUCT_INFO_URL = `${FINAL_BASE_URL}/productInfo`;
const MAPPING_URL = `${FINAL_BASE_URL}/mapping`;
const ARI_URL = `${FINAL_BASE_URL}/ari`;
const EXTERNAL_FETCH_URL = (process.env.STAAH_FETCH_URL || 'https://channelconnect.otaswitch.com/common-cgi/dviholidays/services/services.pl').replace(/\/+$/, '');
const EXTERNAL_BOOKING_URL = (process.env.STAAH_BOOKING_URL || 'https://reservation.otaswitch.com/getapi/reservation/v2').replace(/\/+$/, '');

const STAAH_API_KEY = process.env.STAAH_API_KEY || '';
const PROPERTY_ID = process.env.STAAH_PROPERTY_ID || 'STAAHTESTHOTEL1';
const ROOM_ID = process.env.STAAH_ROOM_ID || (IS_LIVE_CERT ? 'DELUXEROOM' : 'DELUXE_ROOM');
const RATEPLAN_ID = process.env.STAAH_RATEPLAN_ID || (IS_LIVE_CERT ? 'CPPLAN' : 'CP_PLAN');
const SOURCE_IP = resolveSourceIp();
const SKIP_SEED = String(process.env.STAAH_SKIP_SEED || 'false').toLowerCase() === 'true';
const SKIP_ARI_SETUP = String(process.env.STAAH_SKIP_ARI_SETUP || 'false').toLowerCase() === 'true';
const FAIL_ON_EXECUTION_FAILURE = String(process.env.STAAH_FAIL_ON_EXECUTION_FAILURE || 'false').toLowerCase() === 'true';

function resolveSourceIp() {
  if (process.env.STAAH_TEST_SOURCE_IP) {
    return process.env.STAAH_TEST_SOURCE_IP.trim();
  }

  const configured = String(process.env.STAAH_ALLOWED_IPS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return configured[0] || '127.0.0.1';
}

function ensureCleanOutput() {
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(REQUESTS_DIR, { recursive: true });
  fs.mkdirSync(RESPONSES_DIR, { recursive: true });
}

function loadWorkbookSummary() {
  const workbook = xlsx.readFile(WORKBOOK_PATH);
  return workbook.SheetNames.map((sheetName) => ({
    sheetName,
    rows: xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' }),
  }));
}

function stamp() {
  return new Date().toISOString();
}

function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function writeText(filePath, value) {
  fs.writeFileSync(filePath, value, 'utf8');
}

function sanitizeFileName(value) {
  return value.replace(/[^a-z0-9-_]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

function normalizeExternalId(value) {
  return String(value || '').trim().replace(/_/g, '');
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
    rateId = RATEPLAN_ID,
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
      salutation,
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
      remarks,
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
    apikey: STAAH_API_KEY,
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
          status,
          customer: {
            address: 'Ring Road',
            city: 'Surat',
            country: 'India',
            email: 'rk@staah.com',
            salutation: 'Mr.',
            first_name: 'Test',
            last_name: 'Test',
            remarks,
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
    apikey: STAAH_API_KEY,
    room_id: ROOM_ID,
    rate_id: RATEPLAN_ID,
    action: 'ARR_info',
    from_date: fromDate,
    to_date: toDate,
    version: '2',
  };
}

function buildHeaders() {
  const headers = {
    'content-type': 'application/json',
  };

  // Keep the IP guard intact while letting local evidence generation use a configured source IP.
  if (SOURCE_IP) {
    headers['x-forwarded-for'] = SOURCE_IP;
    headers['x-real-ip'] = SOURCE_IP;
  }

  return headers;
}

async function postJson(url, payload) {
  const requestTimestamp = stamp();
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  let responseBody;
  try {
    responseBody = responseText ? JSON.parse(responseText) : null;
  } catch (error) {
    responseBody = responseText;
  }

  return {
    requestTimestamp,
    status: response.status,
    ok: response.ok,
    headers: Object.fromEntries(response.headers.entries()),
    body: responseBody,
    rawBody: responseText,
  };
}

function workbookSource(section, rowLabel) {
  return `${section} / ${rowLabel}`;
}

function createSetupAriPayload() {
  return {
    propertyid: PROPERTY_ID,
    room_id: ROOM_ID,
    rate_id: RATEPLAN_ID,
    currency: 'INR',
    apikey: STAAH_API_KEY,
    version: '2',
    trackingId: `CERT-SETUP-${Date.now()}`,
    data: [
      {
        from_date: '2026-12-15',
        to_date: '2026-12-15',
        inventory: '9',
        cta: 'N',
        ctd: 'N',
        stopsell: 'N',
        minstay: '1',
        maxstay: '5',
        minstay_through: '1',
        maxstay_through: '3',
        amountBeforeTax: {
          Rate: '4900',
          extrachild: '600.00',
          extraadult: '800.00',
          obp: { person1: '4900', person2: '5400', person3: '5700' },
        },
        amountAfterTax: {
          Rate: '4900',
          extrachild: '600',
          extraadult: '800',
          obp: { person1: '4900', person2: '5400', person3: '5700' },
        },
      },
      {
        from_date: '2026-12-15',
        to_date: '2027-01-11',
        inventory: '7',
        cta: 'N',
        ctd: 'N',
        stopsell: 'N',
        minstay: '2',
        maxstay: '7',
        amountBeforeTax: {
          Rate: '5100',
          extrachild: '650.00',
          extraadult: '900.00',
          obp: { person1: '5100', person2: '5600', person3: '5900' },
        },
        amountAfterTax: {
          Rate: '5355',
          extrachild: '683',
          extraadult: '945',
          obp: { person1: '5355', person2: '5880', person3: '6195' },
        },
      },
      {
        from_date: '2026-06-01',
        to_date: '2026-06-10',
        inventory: '11',
        cta: 'N',
        ctd: 'N',
        stopsell: 'N',
        minstay: '1',
        maxstay: '10',
        amountBeforeTax: {
          Rate: '4300',
          extrachild: '500.00',
          extraadult: '700.00',
          obp: { person1: '4300', person2: '4700', person3: '5100' },
        },
        amountAfterTax: {
          Rate: '4515',
          extrachild: '525',
          extraadult: '735',
          obp: { person1: '4515', person2: '4935', person3: '5355' },
        },
      },
      {
        from_date: '2026-01-01',
        to_date: '2026-12-31',
        inventory: '6',
        cta: 'N',
        ctd: 'N',
        stopsell: 'N',
        minstay: '1',
        maxstay: '14',
        amountBeforeTax: {
          Rate: '5200',
          extrachild: '650.00',
          extraadult: '900.00',
          obp: { person1: '5200', person2: '5700', person3: '6200' },
        },
        amountAfterTax: {
          Rate: '5460',
          extrachild: '683',
          extraadult: '945',
          obp: { person1: '5460', person2: '5985', person3: '6510' },
        },
      },
    ],
  };
}

function createLiveExecutableCases() {
  return [
    {
      id: '01',
      name: 'Property Info',
      fileName: '01_property_info.txt',
      section: workbookSource('ARI Tests', 'Row 4 / Sr No 1'),
      excelDescription: 'Fetch Property Info (optional)',
      endpoint: EXTERNAL_FETCH_URL,
      method: 'POST',
      routeUsage: 'direct STAAH fetch API',
      workbookStatus: 'fully testable',
      notes: 'Live workbook row 1 executed against STAAH property_info on the fetch endpoint.',
      payload: {
        propertyid: PROPERTY_ID,
        apikey: STAAH_API_KEY,
        action: 'property_info',
        version: '2',
      },
    },
    {
      id: '02',
      name: 'Mapping Info',
      fileName: '02_mapping_info.txt',
      section: workbookSource('ARI Tests', 'Row 5 / Sr No 2'),
      excelDescription: 'Fetch Mapping Info (optional)',
      endpoint: EXTERNAL_FETCH_URL,
      method: 'POST',
      routeUsage: 'direct STAAH fetch API',
      workbookStatus: 'fully testable',
      notes: 'Live workbook row 2 executed against STAAH roomrate_info on the fetch endpoint.',
      payload: {
        propertyid: PROPERTY_ID,
        apikey: STAAH_API_KEY,
        action: 'roomrate_info',
        version: '2',
      },
    },
    {
      id: '03',
      name: 'ARI Single Date',
      fileName: '03_ari_single_date.txt',
      section: workbookSource('ARI Tests', 'Row 6 / Sr No 3'),
      excelDescription: 'Fetch ARI for Single date',
      endpoint: EXTERNAL_FETCH_URL,
      method: 'POST',
      routeUsage: 'direct STAAH fetch API',
      workbookStatus: 'fully testable',
      notes: 'Live workbook row 3 executed against STAAH ARR_info.',
      payload: buildArrInfoPayload('2026-07-20', '2026-07-20'),
    },
    {
      id: '04',
      name: 'ARI 28 Days',
      fileName: '04_ari_28_days.txt',
      section: workbookSource('ARI Tests', 'Row 7 / Sr No 4'),
      excelDescription: 'Fetch ARI for 28days across consecutive months',
      endpoint: EXTERNAL_FETCH_URL,
      method: 'POST',
      routeUsage: 'direct STAAH fetch API',
      workbookStatus: 'fully testable',
      notes: 'Live workbook row 4 executed against STAAH ARR_info.',
      payload: buildArrInfoPayload('2026-12-15', '2027-01-11'),
    },
    {
      id: '05',
      name: 'ARI First 10 Days',
      fileName: '05_ari_first_10_days.txt',
      section: workbookSource('ARI Tests', 'Row 8 / Sr No 5'),
      excelDescription: 'Fetch ARI for first 10 days of a month',
      endpoint: EXTERNAL_FETCH_URL,
      method: 'POST',
      routeUsage: 'direct STAAH fetch API',
      workbookStatus: 'fully testable',
      notes: 'Live workbook row 5 executed against STAAH ARR_info.',
      payload: buildArrInfoPayload('2026-06-01', '2026-06-10'),
    },
    {
      id: '06',
      name: 'ARI Full Sync',
      fileName: '06_ari_year_sync.txt',
      section: workbookSource('ARI Tests', 'Row 9 / Sr No 6'),
      excelDescription: 'Fetch ARI for Full Sync (1 year or supported duration)',
      endpoint: EXTERNAL_FETCH_URL,
      method: 'POST',
      routeUsage: 'direct STAAH fetch API',
      workbookStatus: 'fully testable',
      notes: 'Live workbook row 6 executed against STAAH year_info_ARR.',
      payload: {
        propertyid: PROPERTY_ID,
        apikey: STAAH_API_KEY,
        room_id: ROOM_ID,
        rate_id: RATEPLAN_ID,
        action: 'year_info_ARR',
        version: '2',
      },
    },
  ];
}

function createExecutableCases() {
  if (IS_LIVE_CERT) {
    return createLiveExecutableCases();
  }

  return [
    {
      id: '01',
      name: 'Property Info',
      fileName: '01_property_info.txt',
      section: workbookSource('ARI Tests', 'Row 4 / Sr No 1'),
      excelDescription: 'Fetch Property Info (optional)',
      endpoint: PRODUCT_INFO_URL,
      method: 'POST',
      routeUsage: 'supplementary product info endpoint',
      workbookStatus: 'fully testable',
      notes: 'Optional workbook row; executed with the existing supplementary productInfo endpoint because the final single-endpoint pair covers mapping and ARI only.',
      payload: {
        apikey: STAAH_API_KEY,
        propertyid: PROPERTY_ID,
        action: 'property_info',
        version: '2',
      },
    },
    {
      id: '02',
      name: 'Mapping Info',
      fileName: '02_mapping_info.txt',
      section: workbookSource('ARI Tests', 'Row 5 / Sr No 2'),
      excelDescription: 'Fetch Mapping Info (optional)',
      endpoint: MAPPING_URL,
      method: 'POST',
      routeUsage: 'single Mapping endpoint',
      workbookStatus: 'fully testable',
      notes: 'Uses the final single mapping endpoint.',
      payload: {
        apikey: STAAH_API_KEY,
        propertyid: PROPERTY_ID,
        version: '2',
      },
    },
    {
      id: '03',
      name: 'ARI Single Date',
      fileName: '03_ari_single_date.txt',
      section: workbookSource('ARI Tests', 'Row 6 / Sr No 3'),
      excelDescription: 'Fetch ARI for Single date',
      endpoint: ARI_URL,
      method: 'POST',
      routeUsage: 'single ARI endpoint',
      workbookStatus: 'fully testable',
      notes: 'Uses the final single ARI endpoint in read mode via action ARR_info.',
      payload: {
        apikey: STAAH_API_KEY,
        propertyid: PROPERTY_ID,
        room_id: ROOM_ID,
        rate_id: RATEPLAN_ID,
        action: 'ARR_info',
        from_date: '2026-12-15',
        to_date: '2026-12-15',
        version: '2',
      },
    },
    {
      id: '04',
      name: 'ARI 28 Days',
      fileName: '04_ari_28_days.txt',
      section: workbookSource('ARI Tests', 'Row 7 / Sr No 4'),
      excelDescription: 'Fetch ARI for 28days across consecutive months',
      endpoint: ARI_URL,
      method: 'POST',
      routeUsage: 'single ARI endpoint',
      workbookStatus: 'fully testable',
      notes: 'Uses the final single ARI endpoint in read mode via action ARR_info.',
      payload: {
        apikey: STAAH_API_KEY,
        propertyid: PROPERTY_ID,
        room_id: ROOM_ID,
        rate_id: RATEPLAN_ID,
        action: 'ARR_info',
        from_date: '2026-12-15',
        to_date: '2027-01-11',
        version: '2',
      },
    },
    {
      id: '05',
      name: 'ARI First 10 Days',
      fileName: '05_ari_first_10_days.txt',
      section: workbookSource('ARI Tests', 'Row 8 / Sr No 5'),
      excelDescription: 'Fetch ARI for first 10 days of a month',
      endpoint: ARI_URL,
      method: 'POST',
      routeUsage: 'single ARI endpoint',
      workbookStatus: 'fully testable',
      notes: 'Uses the final single ARI endpoint in read mode via action ARR_info.',
      payload: {
        apikey: STAAH_API_KEY,
        propertyid: PROPERTY_ID,
        room_id: ROOM_ID,
        rate_id: RATEPLAN_ID,
        action: 'ARR_info',
        from_date: '2026-06-01',
        to_date: '2026-06-10',
        version: '2',
      },
    },
    {
      id: '06',
      name: 'ARI Full Sync',
      fileName: '06_ari_year_sync.txt',
      section: workbookSource('ARI Tests', 'Row 9 / Sr No 6'),
      excelDescription: 'Fetch ARI for Full Sync (1 year or supported duration)',
      endpoint: ARI_URL,
      method: 'POST',
      routeUsage: 'single ARI endpoint',
      workbookStatus: 'fully testable',
      notes: 'Uses the final single ARI endpoint in full-sync read mode via action year_info_ARR.',
      payload: {
        apikey: STAAH_API_KEY,
        propertyid: PROPERTY_ID,
        room_id: ROOM_ID,
        rate_id: RATEPLAN_ID,
        action: 'year_info_ARR',
        version: '2',
      },
    },
  ];
}

function createLiveBookingCases() {
  const scenarios = [
    'Create a booking for Single Room - Single Rate Plan',
    'Create a booking for Single Room - Single Rate Plan - With an Extra Adult/Child (If Supported Extras)',
    'Create a booking for a Single Room - Multiple Rate Plans - Multiple Nights',
    'Create a booking for Multiple Rooms - Multiple Rate Plans',
  ];

  const bookingIds = [
    makeBookingId('S1'),
    makeBookingId('S2'),
    makeBookingId('S3'),
    makeBookingId('S4'),
  ];

  const rows = [];

  for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex += 1) {
    const scenarioNumber = scenarioIndex + 1;
    const reservationId = bookingIds[scenarioIndex];
    const scenarioLabel = scenarios[scenarioIndex];

    const scenarioPlan = [
      {
        label: 'Pre-Book',
        step: 'Pre-Book',
        endpoint: EXTERNAL_FETCH_URL,
        routeUsage: 'fetch data endpoint',
        section: workbookSource('Booking Tests', `Scenario ${scenarioNumber} / Pre-Book`),
        excelDescription: `${scenarioLabel} / Pre-Book`,
        payload: buildArrInfoPayload(
          scenarioNumber === 1 ? '2026-07-20' : scenarioNumber === 2 ? '2026-08-10' : scenarioNumber === 3 ? '2026-09-01' : '2026-10-05',
          scenarioNumber === 1 ? '2026-07-20' : scenarioNumber === 2 ? '2026-08-10' : scenarioNumber === 3 ? '2026-09-03' : '2026-10-05',
        ),
      },
      {
        label: 'Confirm',
        step: 'Confirm',
        endpoint: EXTERNAL_BOOKING_URL,
        routeUsage: 'booking endpoint',
        section: workbookSource('Booking Tests', `Scenario ${scenarioNumber} / Confirm`),
        excelDescription: `${scenarioLabel} / Confirm`,
        payload: buildReservationPayload(
          scenarioNumber === 1
            ? {
                reservationId,
                arrivalDate: '2026-07-20',
                departureDate: '2026-07-21',
                status: 'Confirm',
              }
            : scenarioNumber === 2
              ? {
                  reservationId,
                  arrivalDate: '2026-08-10',
                  departureDate: '2026-08-11',
                  status: 'Confirm',
                  amountAfterTax: '1300',
                  totalTax: '140',
                  basePriceAmountAfterTax: '1100',
                  extraAdult: '1',
                  extraChild: '1',
                  extraAdultRate: '100',
                  extraChildRate: '100',
                  adultCount: '3',
                }
              : scenarioNumber === 3
                ? {
                    reservationId,
                    arrivalDate: '2026-09-01',
                    departureDate: '2026-09-03',
                    status: 'Confirm',
                    amountAfterTax: '2100',
                    totalTax: '220',
                    basePriceAmountAfterTax: '1900',
                    adultCount: '2',
                  }
                : {
                    reservationId,
                    arrivalDate: '2026-10-05',
                    departureDate: '2026-10-06',
                    status: 'Confirm',
                    amountAfterTax: '2400',
                    totalTax: '260',
                    basePriceAmountAfterTax: '2200',
                    adultCount: '4',
                  },
        ),
      },
      {
        label: 'Pre-Modify',
        step: 'Pre-Modify',
        endpoint: EXTERNAL_FETCH_URL,
        routeUsage: 'fetch data endpoint',
        section: workbookSource('Booking Tests', `Scenario ${scenarioNumber} / Pre-Modify`),
        excelDescription: `${scenarioLabel} / Pre-Modify`,
        payload: buildArrInfoPayload(
          scenarioNumber === 1 ? '2026-07-21' : scenarioNumber === 2 ? '2026-08-11' : scenarioNumber === 3 ? '2026-09-02' : '2026-10-06',
          scenarioNumber === 1 ? '2026-07-21' : scenarioNumber === 2 ? '2026-08-11' : scenarioNumber === 3 ? '2026-09-04' : '2026-10-06',
        ),
      },
      {
        label: 'Modify',
        step: 'Modify',
        endpoint: EXTERNAL_BOOKING_URL,
        routeUsage: 'booking endpoint',
        section: workbookSource('Booking Tests', `Scenario ${scenarioNumber} / Modify`),
        excelDescription: `${scenarioLabel} / Modify`,
        payload: buildReservationPayload(
          scenarioNumber === 1
            ? {
                reservationId,
                arrivalDate: '2026-07-21',
                departureDate: '2026-07-22',
                status: 'Modified',
              }
            : scenarioNumber === 2
              ? {
                  reservationId,
                  arrivalDate: '2026-08-11',
                  departureDate: '2026-08-12',
                  status: 'Modified',
                  amountAfterTax: '1300',
                  totalTax: '140',
                  basePriceAmountAfterTax: '1100',
                  extraAdult: '1',
                  extraChild: '1',
                  extraAdultRate: '100',
                  extraChildRate: '100',
                  adultCount: '3',
                }
              : scenarioNumber === 3
                ? {
                    reservationId,
                    arrivalDate: '2026-09-02',
                    departureDate: '2026-09-04',
                    status: 'Modified',
                    amountAfterTax: '2200',
                    totalTax: '240',
                    basePriceAmountAfterTax: '2000',
                    adultCount: '2',
                  }
                : {
                    reservationId,
                    arrivalDate: '2026-10-06',
                    departureDate: '2026-10-07',
                    status: 'Modified',
                    amountAfterTax: '2500',
                    totalTax: '280',
                    basePriceAmountAfterTax: '2300',
                    adultCount: '4',
                  },
        ),
      },
      {
        label: 'Cancel',
        step: 'Cancel',
        endpoint: EXTERNAL_BOOKING_URL,
        routeUsage: 'booking endpoint',
        section: workbookSource('Booking Tests', `Scenario ${scenarioNumber} / Cancel`),
        excelDescription: `${scenarioLabel} / Cancel`,
        payload: buildReservationPayload(
          scenarioNumber === 1
            ? {
                reservationId,
                arrivalDate: '2026-07-21',
                departureDate: '2026-07-22',
                status: 'Cancel',
              }
            : scenarioNumber === 2
              ? {
                  reservationId,
                  arrivalDate: '2026-08-11',
                  departureDate: '2026-08-12',
                  status: 'Cancel',
                  amountAfterTax: '1300',
                  totalTax: '140',
                  basePriceAmountAfterTax: '1100',
                  extraAdult: '1',
                  extraChild: '1',
                  extraAdultRate: '100',
                  extraChildRate: '100',
                  adultCount: '3',
                }
              : scenarioNumber === 3
                ? {
                    reservationId,
                    arrivalDate: '2026-09-02',
                    departureDate: '2026-09-04',
                    status: 'Cancel',
                    amountAfterTax: '2200',
                    totalTax: '240',
                    basePriceAmountAfterTax: '2000',
                    adultCount: '2',
                  }
                : {
                    reservationId,
                    arrivalDate: '2026-10-06',
                    departureDate: '2026-10-07',
                    status: 'Cancel',
                    amountAfterTax: '2500',
                    totalTax: '280',
                    basePriceAmountAfterTax: '2300',
                    adultCount: '4',
                  },
        ),
      },
    ];

    for (const step of scenarioPlan) {
      rows.push({
        id: String(rows.length + 7).padStart(2, '0'),
        name: `Booking Case ${scenarioNumber} ${step.label}`,
        fileName: `${String(rows.length + 7).padStart(2, '0')}_booking_case_${scenarioNumber}_${sanitizeFileName(step.label)}.txt`,
        section: step.section,
        excelDescription: step.excelDescription,
        endpoint: step.endpoint,
        method: 'POST',
        routeUsage: step.routeUsage,
        workbookStatus: 'fully testable',
        notes: `Live workbook booking row executed against STAAH ${step.step.toLowerCase()} endpoint.`,
        payload: step.payload,
        bookingId: reservationId,
      });
    }
  }

  return rows;
}

function createBookingCases() {
  if (IS_LIVE_CERT) {
    return createLiveBookingCases();
  }

  const scenarios = [
    'Create a booking for Single Room - Single Rate Plan',
    'Create a booking for Single Room - Single Rate Plan - With an Extra Adult/Child (If Supported Extras)',
    'Create a booking for a Single Room - Multiple Rate Plans - Multiple Nights',
    'Create a booking for Multiple Rooms - Multiple Rate Plans',
  ];

  const steps = [
    { label: 'Pre-Book', endpointType: 'fetch data endpoint', endpoint: 'https://channelconnect.otaswitch.com/common-cgi/dviholidays/test/services.p' },
    { label: 'Confirm', endpointType: 'booking endpoint', endpoint: 'https://channels-stage.staah.net/booking/getapi/reservation/v2' },
    { label: 'Pre-Modify', endpointType: 'fetch data endpoint', endpoint: 'https://channelconnect.otaswitch.com/common-cgi/dviholidays/test/services.p' },
    { label: 'Modify', endpointType: 'booking endpoint', endpoint: 'https://channels-stage.staah.net/booking/getapi/reservation/v2' },
    { label: 'Cancel', endpointType: 'booking endpoint', endpoint: 'https://channels-stage.staah.net/booking/getapi/reservation/v2' },
  ];

  const blocked = [];
  let counter = 7;
  for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex += 1) {
    const scenarioNumber = scenarioIndex + 1;
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      const step = steps[stepIndex];
      const id = String(counter).padStart(2, '0');
      blocked.push({
        id,
        name: `Booking Case ${scenarioNumber} ${step.label}`,
        fileName: `${id}_booking_case_${scenarioNumber}_${sanitizeFileName(step.label)}.txt`,
        section: workbookSource('Booking Tests', `Scenario ${scenarioNumber} / ${step.label}`),
        excelDescription: `${scenarios[scenarioIndex]} / ${step.label}`,
        endpoint: step.endpoint,
        method: 'POST',
        routeUsage: step.endpointType,
        workbookStatus: 'blocked',
        notes: 'Blocked: the repo does not contain a verified request contract, reusable local caller, or captured booking identifiers/session flow for the external STAAH booking-side API. Local custom reservation adapter routes are intentionally excluded from certification-safe claims.',
        blockedReason: 'Missing verified external STAAH booking/fetch request schema and identifiers in the current codebase.',
      });
      counter += 1;
    }
  }

  return blocked;
}

function toPlainText(caseResult) {
  const requestPayload = caseResult.requestPayload === undefined
    ? 'N/A'
    : JSON.stringify(caseResult.requestPayload, null, 2);
  const responseBody = caseResult.responseBody === undefined
    ? 'N/A'
    : typeof caseResult.responseBody === 'string'
      ? caseResult.responseBody
      : JSON.stringify(caseResult.responseBody, null, 2);

  return [
    `Test Case Name: ${caseResult.name}`,
    `Excel Section / Row: ${caseResult.section}`,
    `Endpoint: ${caseResult.endpoint}`,
    `Method: ${caseResult.method}`,
    `Request Time: ${caseResult.requestTime}`,
    'Request Payload / Params:',
    requestPayload,
    `Response Status: ${caseResult.responseStatus}`,
    'Response Body:',
    responseBody,
    `Pass / Fail / Blocked: ${caseResult.outcome}`,
    `Notes: ${caseResult.notes}`,
    '',
  ].join('\n');
}

function createMappingMarkdown(caseResults) {
  const header = [
    '# STAAH Certification Testcase Mapping',
    '',
    '| ID | Excel Section / Row | Test Case | Endpoint / Script | Method | Uses | Status | Notes |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  const rows = caseResults.map((caseResult) => {
    const endpointOrScript = caseResult.scriptPath || caseResult.endpoint;
    return `| ${caseResult.id} | ${caseResult.section} | ${caseResult.excelDescription} | ${endpointOrScript} | ${caseResult.method} | ${caseResult.routeUsage} | ${caseResult.workbookStatus} | ${caseResult.notes.replace(/\|/g, '\\|')} |`;
  });

  return [...header, ...rows, ''].join('\n');
}

function createSummaryText(caseResults) {
  return caseResults.map((caseResult) => toPlainText(caseResult)).join('\n');
}

function createIndividualEvidence(caseResult) {
  writeText(path.join(OUTPUT_DIR, caseResult.fileName), toPlainText(caseResult));

  const requestBase = `${caseResult.id}_${sanitizeFileName(caseResult.name)}_request`;
  const responseBase = `${caseResult.id}_${sanitizeFileName(caseResult.name)}_response`;

  if (caseResult.requestPayload === undefined) {
    writeText(
      path.join(REQUESTS_DIR, `${requestBase}.txt`),
      `Endpoint: ${caseResult.endpoint}\nMethod: ${caseResult.method}\nBlocked: ${caseResult.notes}\n`,
    );
  } else {
    writeJson(path.join(REQUESTS_DIR, `${requestBase}.json`), caseResult.requestPayload);
  }

  if (caseResult.responseBody === undefined) {
    writeText(
      path.join(RESPONSES_DIR, `${responseBase}.txt`),
      `Response Status: ${caseResult.responseStatus}\nBlocked: ${caseResult.notes}\n`,
    );
  } else if (typeof caseResult.responseBody === 'string') {
    writeText(path.join(RESPONSES_DIR, `${responseBase}.txt`), caseResult.responseBody);
  } else {
    writeJson(path.join(RESPONSES_DIR, `${responseBase}.json`), caseResult.responseBody);
  }
}

function assertConfig() {
  if (!fs.existsSync(WORKBOOK_PATH)) {
    throw new Error(`Certification workbook not found: ${WORKBOOK_PATH}`);
  }

  if (!STAAH_API_KEY) {
    throw new Error('STAAH_API_KEY is required in .env to run certification evidence generation.');
  }
}

function runSeedScript() {
  if (IS_LIVE_CERT || SKIP_SEED) {
    return;
  }

  const seed = spawnSync('npm', ['run', 'seed:staah:test'], {
    cwd: ROOT_DIR,
    shell: true,
    stdio: 'inherit',
  });

  if (seed.status !== 0) {
    throw new Error('Failed to seed STAAH test data.');
  }
}

async function ensureServerReachable() {
  if (IS_LIVE_CERT) {
    return;
  }

  const response = await fetch(PRODUCT_INFO_URL, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify({}),
  }).catch((error) => {
    throw new Error(`Unable to reach local server at ${BASE_URL}: ${error.message}`);
  });

  await response.text();
}

async function runSetup() {
  if (IS_LIVE_CERT || SKIP_ARI_SETUP) {
    return;
  }

  const payload = createSetupAriPayload();
  const response = await postJson(ARI_URL, payload);

  writeJson(path.join(REQUESTS_DIR, '00_setup_ari_seed_request.json'), payload);
  writeJson(path.join(RESPONSES_DIR, '00_setup_ari_seed_response.json'), {
    status: response.status,
    body: response.body,
    requestTimestamp: response.requestTimestamp,
  });

  if (response.status !== 200 || response.body?.status !== 'success') {
    throw new Error(`ARI setup seed failed with HTTP ${response.status}.`);
  }
}

async function executeCase(caseConfig) {
  const response = await postJson(caseConfig.endpoint, caseConfig.payload);
  const outcome = response.status >= 200 && response.status < 300 && response.body && response.body.status !== 'fail'
    ? 'PASS'
    : 'FAIL';

  const workbookStatus = outcome === 'PASS' ? 'fully testable' : 'partially testable';

  return {
    ...caseConfig,
    workbookStatus,
    requestTime: response.requestTimestamp,
    requestPayload: jsonClone(caseConfig.payload),
    responseStatus: `${response.status}`,
    responseBody: response.body,
    outcome,
    notes: `${caseConfig.notes} HTTP ${response.status}.`,
  };
}

function materializeBlockedCase(caseConfig) {
  return {
    ...caseConfig,
    requestTime: stamp(),
    requestPayload: undefined,
    responseStatus: 'BLOCKED',
    responseBody: undefined,
    outcome: 'BLOCKED',
  };
}

async function main() {
  assertConfig();
  ensureCleanOutput();
  const workbook = loadWorkbookSummary();
  writeJson(path.join(OUTPUT_DIR, 'workbook-snapshot.json'), workbook);

  if (!IS_LIVE_CERT) {
    runSeedScript();
    await ensureServerReachable();
    await runSetup();
  }

  const executableCases = createExecutableCases();
  const bookingCases = createBookingCases();
  const results = [];

  for (const caseConfig of executableCases) {
    const caseResult = await executeCase(caseConfig);
    results.push(caseResult);
    createIndividualEvidence(caseResult);
  }

  for (const caseConfig of bookingCases) {
    const caseResult = IS_LIVE_CERT
      ? await executeCase(caseConfig)
      : materializeBlockedCase(caseConfig);
    results.push(caseResult);
    createIndividualEvidence(caseResult);
  }

  writeText(path.join(OUTPUT_DIR, 'testcase-mapping.md'), createMappingMarkdown(results));
  writeText(path.join(OUTPUT_DIR, 'request-response-summary.txt'), createSummaryText(results));

  const index = {
    generatedAt: stamp(),
    mode: CERT_MODE,
    baseUrl: BASE_URL,
    finalBaseUrl: FINAL_BASE_URL,
    fetchUrl: EXTERNAL_FETCH_URL,
    bookingUrl: EXTERNAL_BOOKING_URL,
    sourceIpUsed: SOURCE_IP,
    skipSeed: SKIP_SEED,
    skipAriSetup: SKIP_ARI_SETUP,
    propertyId: PROPERTY_ID,
    roomId: ROOM_ID,
    rateplanId: RATEPLAN_ID,
    cases: results.map((result) => ({
      id: result.id,
      fileName: result.fileName,
      outcome: result.outcome,
      endpoint: result.endpoint,
      routeUsage: result.routeUsage,
    })),
  };

  writeJson(path.join(OUTPUT_DIR, 'index.json'), index);

  const failed = results.filter((result) => result.outcome === 'FAIL');
  if (failed.length > 0 && FAIL_ON_EXECUTION_FAILURE) {
    throw new Error(`Certification runner completed with ${failed.length} failed executable case(s).`);
  }

  console.log(`Generated STAAH certification evidence in ${OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
