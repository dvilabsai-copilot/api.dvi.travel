const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  authUrl:
    'https://api.travelboutiqueonline.com/SharedAPI/SharedData.svc/rest/Authenticate',
  hotelBaseUrl: 'https://affiliate.travelboutiqueonline.com/HotelAPI',
  codeBaseUrl: 'http://affiliate.travelboutiqueonline.com/TBOHolidays_HotelAPI',
  authClientId: 'tboprod',
  authUserName: 'IXMD112',
  authPassword: 'api-11#M$new',
  authEndUserIp: '134.209.145.185',
  hotelUserName: 'IXMD112',
  hotelPassword: 'api-11#M$new',
  hotelEndUserIp: '134.209.145.185',
  countryCode: 'IN',
  cityCode: '127343',
  cityNameFilter: 'Chennai',
  checkIn: '',
  checkOut: '',
  guestNationality: 'IN',
  paymentMode: 'Limit',
  noOfRooms: '1',
  outDir: 'tmp-prod-tbo-output',
};

function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function shiftDays(base, days) {
  const date = new Date(base);
  date.setDate(date.getDate() + days);
  return ymd(date);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeText(filePath, text) {
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function buildBasicAuth(user, password) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

function normalizeHeaders(headers) {
  const out = {};
  for (const [key, value] of headers.entries()) {
    out[key] = value;
  }
  return out;
}

async function sendJson({ label, url, method, headers, body, outputDir, index }) {
  const request = {
    label,
    method,
    url,
    headers,
    body,
  };

  const requestFile = path.join(outputDir, `${String(index).padStart(2, '0')}_${label}_request.json`);
  writeJson(requestFile, request);

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const responseText = await response.text();
  const responseJson = safeJsonParse(responseText);
  const responseData = {
    label,
    status: response.status,
    statusText: response.statusText,
    headers: normalizeHeaders(response.headers),
    bodyText: responseText,
    bodyJson: responseJson,
  };

  const responseFile = path.join(outputDir, `${String(index).padStart(2, '0')}_${label}_response.json`);
  writeJson(responseFile, responseData);

  return responseData;
}

function firstHotelCodesFromList(codeListJson, fallbackCodes) {
  const hotelResult = Array.isArray(codeListJson?.Hotels) ? codeListJson.Hotels : [];
  const codes = [];
  for (const hotel of hotelResult) {
    const code = String(hotel?.HotelCode || '').trim();
    if (code) codes.push(code);
    if (codes.length >= 2) break;
  }
  return codes.length ? codes.join(',') : fallbackCodes;
}

function firstBookingCode(searchJson) {
  const hotelResult = Array.isArray(searchJson?.HotelResult) ? searchJson.HotelResult : [];
  for (const hotel of hotelResult) {
    const rooms = Array.isArray(hotel?.Rooms) ? hotel.Rooms : [];
    for (const room of rooms) {
      const code = String(room?.BookingCode || '').trim();
      if (code) return code;
    }
  }
  return '';
}

async function main() {
  const now = new Date();
  const config = {
    authUrl: process.env.TBO_AUTH_URL || DEFAULTS.authUrl,
    hotelBaseUrl: process.env.TBO_HOTEL_BASE_URL || DEFAULTS.hotelBaseUrl,
    codeBaseUrl: process.env.TBO_CODE_BASE_URL || DEFAULTS.codeBaseUrl,
    authClientId: process.env.TBO_AUTH_CLIENT_ID || DEFAULTS.authClientId,
    authUserName: process.env.TBO_AUTH_USER_NAME || DEFAULTS.authUserName,
    authPassword: process.env.TBO_AUTH_PASSWORD || DEFAULTS.authPassword,
    authEndUserIp: process.env.TBO_AUTH_END_USER_IP || DEFAULTS.authEndUserIp,
    hotelUserName: process.env.TBO_HOTEL_USER_NAME || DEFAULTS.hotelUserName,
    hotelPassword: process.env.TBO_HOTEL_PASSWORD || DEFAULTS.hotelPassword,
    hotelEndUserIp: process.env.TBO_HOTEL_END_USER_IP || DEFAULTS.hotelEndUserIp,
    countryCode: process.env.TBO_COUNTRY_CODE || DEFAULTS.countryCode,
    cityCode: process.env.TBO_CITY_CODE || DEFAULTS.cityCode,
    cityNameFilter: process.env.TBO_CITY_NAME_FILTER || DEFAULTS.cityNameFilter,
    checkIn: process.env.TBO_CHECK_IN || DEFAULTS.checkIn || shiftDays(now, 15),
    checkOut: process.env.TBO_CHECK_OUT || DEFAULTS.checkOut || shiftDays(now, 16),
    guestNationality: process.env.TBO_GUEST_NATIONALITY || DEFAULTS.guestNationality,
    paymentMode: process.env.TBO_PAYMENT_MODE || DEFAULTS.paymentMode,
    noOfRooms: Number(process.env.TBO_NO_OF_ROOMS || DEFAULTS.noOfRooms || 1),
    outDir: process.env.TBO_OUTPUT_DIR || DEFAULTS.outDir,
    explicitHotelCodes: process.env.TBO_HOTEL_CODES || '',
  };

  const runDir = path.join(config.outDir, new Date().toISOString().replace(/[:.]/g, '-'));
  ensureDir(runDir);

  const steps = [];
  const baseHeaders = {
    Authorization: buildBasicAuth(config.hotelUserName, config.hotelPassword),
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  const authResponse = await sendJson({
    label: '01_auth',
    index: 1,
    url: config.authUrl,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: {
      ClientId: config.authClientId,
      UserName: config.authUserName,
      Password: config.authPassword,
      EndUserIp: config.authEndUserIp,
    },
    outputDir: runDir,
  });
  steps.push({
    step: 'auth',
    status: authResponse.bodyJson?.Status === 1 ? 'ok' : 'unexpected',
    statusCode: authResponse.status,
    bodyStatus: authResponse.bodyJson?.Status,
    tokenId: authResponse.bodyJson?.TokenId || null,
  });

  const countryResponse = await sendJson({
    label: '02_country_list',
    index: 2,
    url: `${config.codeBaseUrl}/CountryList`,
    method: 'GET',
    headers: baseHeaders,
    body: undefined,
    outputDir: runDir,
  });
  steps.push({
    step: 'country_list',
    status: countryResponse.bodyJson?.Status?.Code === 200 ? 'ok' : 'unexpected',
    statusCode: countryResponse.status,
    bodyStatus: countryResponse.bodyJson?.Status?.Code,
    countryCount: Array.isArray(countryResponse.bodyJson?.CountryList) ? countryResponse.bodyJson.CountryList.length : 0,
  });

  const cityResponse = await sendJson({
    label: '03_city_list',
    index: 3,
    url: `${config.codeBaseUrl}/CityList`,
    method: 'POST',
    headers: baseHeaders,
    body: { CountryCode: config.countryCode },
    outputDir: runDir,
  });
  const cityList = Array.isArray(cityResponse.bodyJson?.CityList) ? cityResponse.bodyJson.CityList : [];
  const matchedCity = cityList.find((city) =>
    String(city?.Name || '').toLowerCase().includes(String(config.cityNameFilter).toLowerCase()),
  );
  const selectedCityCode = matchedCity?.Code || config.cityCode;
  steps.push({
    step: 'city_list',
    status: cityResponse.bodyJson?.Status?.Code === 200 ? 'ok' : 'unexpected',
    statusCode: cityResponse.status,
    bodyStatus: cityResponse.bodyJson?.Status?.Code,
    cityCount: cityList.length,
    selectedCityCode,
    selectedCityName: matchedCity?.Name || null,
  });

  const hotelCodeResponse = await sendJson({
    label: '04_tbo_hotel_code_list',
    index: 4,
    url: `${config.codeBaseUrl}/TBOHotelCodeList`,
    method: 'POST',
    headers: baseHeaders,
    body: {
      CityCode: selectedCityCode,
      IsDetailedResponse: 'true',
    },
    outputDir: runDir,
  });
  const hotelList = Array.isArray(hotelCodeResponse.bodyJson?.Hotels) ? hotelCodeResponse.bodyJson.Hotels : [];
  const hotelCodes = firstHotelCodesFromList(hotelCodeResponse.bodyJson, config.explicitHotelCodes);
  steps.push({
    step: 'hotel_code_list',
    status: hotelCodeResponse.bodyJson?.Status?.Code === 200 ? 'ok' : 'unexpected',
    statusCode: hotelCodeResponse.status,
    bodyStatus: hotelCodeResponse.bodyJson?.Status?.Code,
    hotelCount: hotelList.length,
    hotelCodes,
  });

  const searchResponse = await sendJson({
    label: '05_search',
    index: 5,
    url: `${config.hotelBaseUrl}/Search`,
    method: 'POST',
    headers: baseHeaders,
    body: {
      CheckIn: config.checkIn,
      CheckOut: config.checkOut,
      HotelCodes: hotelCodes,
      GuestNationality: config.guestNationality,
      NoOfRooms: config.noOfRooms,
      PaxRooms: [
        {
          Adults: 1,
          Children: 0,
          ChildrenAges: [],
        },
      ],
      ResponseTime: 23,
      IsDetailedResponse: true,
    },
    outputDir: runDir,
  });
  const bookingCode = firstBookingCode(searchResponse.bodyJson);
  steps.push({
    step: 'search',
    status: searchResponse.bodyJson?.Status?.Code === 200 ? 'ok' : 'unexpected',
    statusCode: searchResponse.status,
    bodyStatus: searchResponse.bodyJson?.Status?.Code,
    hotelResultCount: Array.isArray(searchResponse.bodyJson?.HotelResult) ? searchResponse.bodyJson.HotelResult.length : 0,
    bookingCode,
  });

  const prebookResponse = await sendJson({
    label: '06_prebook',
    index: 6,
    url: `${config.hotelBaseUrl}/PreBook`,
    method: 'POST',
    headers: baseHeaders,
    body: {
      BookingCode: bookingCode,
      PaymentMode: config.paymentMode,
      GuestNationality: config.guestNationality,
      NoOfRooms: config.noOfRooms,
    },
    outputDir: runDir,
  });
  steps.push({
    step: 'prebook',
    status:
      prebookResponse.bodyJson?.Status?.Code === 200
        ? 'ok'
        : prebookResponse.bodyJson?.Status?.Code === 300
        ? 'insufficient_balance'
        : 'unexpected',
    statusCode: prebookResponse.status,
    bodyStatus: prebookResponse.bodyJson?.Status?.Code,
    description: prebookResponse.bodyJson?.Status?.Description || null,
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    runDir,
    config: {
      authUrl: config.authUrl,
      hotelBaseUrl: config.hotelBaseUrl,
      codeBaseUrl: config.codeBaseUrl,
      authClientId: config.authClientId,
      authUserName: config.authUserName,
      authEndUserIp: config.authEndUserIp,
      hotelUserName: config.hotelUserName,
      hotelEndUserIp: config.hotelEndUserIp,
      countryCode: config.countryCode,
      cityCode: config.cityCode,
      checkIn: config.checkIn,
      checkOut: config.checkOut,
      guestNationality: config.guestNationality,
      paymentMode: config.paymentMode,
      noOfRooms: config.noOfRooms,
    },
    steps,
  };

  writeJson(path.join(runDir, 'summary.json'), summary);

  const summaryLines = [];
  summaryLines.push('# TBO Live Probe');
  summaryLines.push('');
  summaryLines.push(`Generated at: ${summary.generatedAt}`);
  summaryLines.push(`Output directory: ${runDir}`);
  summaryLines.push('');
  summaryLines.push('## Result');
  for (const step of steps) {
    summaryLines.push(`- ${step.step}: ${step.status} (HTTP ${step.statusCode}, API ${step.bodyStatus ?? 'n/a'})`);
  }
  summaryLines.push('');
  summaryLines.push('## Auth Request');
  summaryLines.push('```json');
  summaryLines.push(JSON.stringify(
    {
      ClientId: config.authClientId,
      UserName: config.authUserName,
      Password: config.authPassword,
      EndUserIp: config.authEndUserIp,
    },
    null,
    2,
  ));
  summaryLines.push('```');
  summaryLines.push('');
  summaryLines.push('## Auth Response');
  summaryLines.push('```json');
  summaryLines.push(JSON.stringify(authResponse.bodyJson || authResponse.bodyText, null, 2));
  summaryLines.push('```');
  summaryLines.push('');
  summaryLines.push('## PreBook Request');
  summaryLines.push('```json');
  summaryLines.push(JSON.stringify(
    {
      BookingCode: bookingCode,
      PaymentMode: config.paymentMode,
      GuestNationality: config.guestNationality,
      NoOfRooms: config.noOfRooms,
    },
    null,
    2,
  ));
  summaryLines.push('```');
  summaryLines.push('');
  summaryLines.push('## PreBook Response');
  summaryLines.push('```json');
  summaryLines.push(JSON.stringify(prebookResponse.bodyJson || prebookResponse.bodyText, null, 2));
  summaryLines.push('```');

  writeText(path.join(runDir, 'summary.md'), summaryLines.join('\n'));

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error('[tbo-live-prod-probe] FAILED:', error && error.stack ? error.stack : String(error));
  process.exit(1);
});
