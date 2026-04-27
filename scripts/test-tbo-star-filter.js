require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const SHARED_API_URL = 'https://sharedapi.tektravels.com';
const SEARCH_API_URL = 'https://affiliate.tektravels.com/HotelAPI';

const authPayload = {
  ClientId: process.env.TBO_CLIENT_ID || 'ApiIntegrationNew',
  UserName: process.env.TBO_USERNAME || 'Doview',
  Password: process.env.TBO_PASSWORD || 'Doview@12345',
  EndUserIp: process.env.TBO_END_USER_IP || '192.168.1.1',
};

const basicAuth = `Basic ${Buffer.from('TBOApi:TBOApi@123').toString('base64')}`;

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

function buildPayload(starRating, searchSeed) {
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
      MealType: '',
      OrderBy: 0,
      StarRating: starRating,
      HotelName: null,
    },
  };
}

async function runSearch(label, starRating, searchSeed) {
  const payload = buildPayload(starRating, searchSeed);
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

  const roomCount = hotels.reduce((acc, hotel) => acc + (Array.isArray(hotel.Rooms) ? hotel.Rooms.length : 0), 0);

  return {
    label,
    starRating,
    statusCode,
    statusDescription,
    hotelCount: hotels.length,
    roomCount,
    sampleHotelCodes: hotels.slice(0, 8).map((h) => h.HotelCode),
  };
}

async function main() {
  console.log('Authenticating with TBO...');
  const tokenId = await authenticate();
  console.log(`Authenticated. Token prefix: ${tokenId.slice(0, 8)}`);
  const searchSeed = loadCachedHotelCodes();
  console.log(`Using cached cityCode=${searchSeed.cityCode} with ${searchSeed.hotelCodes.split(',').length} hotel codes`);

  const cases = [
    ['All ratings', 0],
    ['1 star', 1],
    ['2 star', 2],
    ['3 star', 3],
    ['4 star', 4],
    ['5 star', 5],
  ];

  const results = [];
  for (const [label, starRating] of cases) {
    console.log(`Running search for ${label} (StarRating=${starRating})...`);
    results.push(await runSearch(label, starRating, searchSeed));
  }

  console.log(JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
}

main().catch((error) => {
  console.error('TBO star filter test failed');
  console.error(error?.response?.data || error);
  process.exit(1);
});
