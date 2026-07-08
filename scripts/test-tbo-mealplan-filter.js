require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const SHARED_API_URL = process.env.TBO_SHARED_API_URL || 'https://api.travelboutiqueonline.com/SharedAPI';
const SEARCH_API_URL = process.env.TBO_SEARCH_API_URL || 'https://affiliate.travelboutiqueonline.com/HotelAPI';

const authPayload = {
  ClientId: process.env.TBO_CLIENT_ID || 'tboprod',
  UserName: process.env.TBO_USERNAME || 'IXMD112',
  Password: process.env.TBO_PASSWORD || 'api-11#M$new',
  EndUserIp: process.env.TBO_END_USER_IP || '134.209.145.185',
};

const basicAuth = `Basic ${Buffer.from(`${process.env.TBO_STATIC_USERNAME || process.env.TBO_USERNAME || 'IXMD112'}:${process.env.TBO_STATIC_PASSWORD || process.env.TBO_PASSWORD || 'api-11#M$new'}`).toString('base64')}`;

async function authenticate() {
  const response = await axios.post(
    `${SHARED_API_URL}/SharedData.svc/rest/Authenticate`,
    authPayload,
    {
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    },
  );

  if (response.data?.Status !== 1 || !response.data?.TokenId) {
    throw new Error(
      `TBO auth failed: ${response.data?.Error?.ErrorMessage || JSON.stringify(response.data)}`,
    );
  }

  return response.data.TokenId;
}

function classifyInclusion(inclusion) {
  const value = String(inclusion || '').trim().toUpperCase();

  if (!value || value === '-' || value === 'ROOM ONLY') return 'EP';
  if (value.includes('BREAKFAST') && value.includes('LUNCH') && value.includes('DINNER')) return 'AP';
  if (
    (value.includes('BREAKFAST') && value.includes('LUNCH')) ||
    (value.includes('BREAKFAST') && value.includes('DINNER')) ||
    (value.includes('LUNCH') && value.includes('DINNER'))
  ) {
    return 'MAP';
  }
  if (value.includes('BREAKFAST')) return 'CP';
  return 'UNKNOWN';
}

function loadCachedHotelCodes() {
  const cachePath = path.join(__dirname, '..', 'tbo-search-request-response-latest.json');
  const raw = fs.readFileSync(cachePath, 'utf8');
  const parsed = JSON.parse(raw);
  const cityCode = parsed?.tboSearchApi?.outboundProviderPayloadSummary?.cityCode;
  const csv = parsed?.tboSearchApi?.outboundProviderPayloadSummary?.hotelCodesCsv;

  const hotelCodes = String(csv || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 100)
    .join(',');

  if (!cityCode || !hotelCodes) {
    throw new Error('Could not load cached TBO city/hotel codes from tbo-search-request-response-latest.json');
  }

  return {
    cityCode: String(cityCode),
    hotelCodes,
  };
}

function buildPayload(mealType, searchSeed) {
  return {
    CheckIn: '2026-05-15',
    CheckOut: '2026-05-16',
    HotelCodes: searchSeed.hotelCodes,
    CityCode: searchSeed.cityCode,
    GuestNationality: 'IN',
    PaxRooms: [
      {
        Adults: 2,
        Children: 0,
        ChildrenAges: [],
      },
    ],
    ResponseTime: 23.0,
    IsDetailedResponse: true,
    Filters: {
      Refundable: false,
      NoOfRooms: 0,
      MealType: mealType,
      OrderBy: 0,
      StarRating: 0,
      HotelName: null,
    },
  };
}

async function runSearch(label, mealType, searchSeed) {
  const payload = buildPayload(mealType, searchSeed);
  const response = await axios.post(`${SEARCH_API_URL}/Search`, payload, {
    timeout: 45000,
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth,
    },
  });

  const statusObj = response.data?.Status;
  const statusCode = typeof statusObj === 'object' ? statusObj?.Code : statusObj;
  const statusDescription = typeof statusObj === 'object' ? statusObj?.Description : '';
  const hotels = Array.isArray(response.data?.HotelResult) ? response.data.HotelResult : [];

  const inclusionCounts = new Map();
  const classifiedCounts = new Map();
  let roomCount = 0;

  for (const hotel of hotels) {
    for (const room of hotel.Rooms || []) {
      roomCount += 1;
      const inclusion = String(room.Inclusion || '-').trim() || '-';
      inclusionCounts.set(inclusion, (inclusionCounts.get(inclusion) || 0) + 1);

      const classification = classifyInclusion(inclusion);
      classifiedCounts.set(classification, (classifiedCounts.get(classification) || 0) + 1);
    }
  }

  return {
    label,
    mealType,
    statusCode,
    statusDescription,
    hotelCount: hotels.length,
    roomCount,
    inclusionCounts: Object.fromEntries([...inclusionCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)),
    classifiedCounts: Object.fromEntries([...classifiedCounts.entries()].sort((a, b) => b[1] - a[1])),
  };
}

async function main() {
  console.log('Authenticating with TBO...');
  const tokenId = await authenticate();
  console.log(`Authenticated. Token prefix: ${tokenId.slice(0, 8)}`);
  const searchSeed = loadCachedHotelCodes();
  console.log(`Using cached cityCode=${searchSeed.cityCode} with ${searchSeed.hotelCodes.split(',').length} hotel codes`);

  const cases = [
    ['All meals', ''],
    ['Breakfast', 'Breakfast'],
    ['RoomOnly', 'RoomOnly'],
    ['HalfBoard', 'HalfBoard'],
    ['FullBoard', 'FullBoard'],
  ];

  const results = [];
  for (const [label, mealType] of cases) {
    console.log(`Running search for ${label} (MealType=${mealType || '<empty>'})...`);
    results.push(await runSearch(label, mealType, searchSeed));
  }

  console.log(JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
}

main().catch((error) => {
  console.error('TBO meal plan test failed');
  console.error(error?.response?.data || error);
  process.exit(1);
});
