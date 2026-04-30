/**
 * Fetch TBO hotel codes from static API, search in batches of 100, and group by price tiers.
 *
 * Flow:
 * 1) POST /TBOHotelCodeList
 * 2) Split hotel codes into batches of 100
 * 3) POST /HotelAPI/Search for each batch
 * 4) Aggregate results and group hotels by price (Budget/Mid-Range/Premium/Luxury)
 *
 * Usage:
 *   node scripts/tbo-codelist-batch-search-group-by-price.js
 *
 * Optional env vars:
 *   CITY_CODE=127067
 *   SEARCH_CITY_CODE=127067
 *   CHECK_IN=2026-05-10
 *   CHECK_OUT=2026-05-11
 *   GUEST_NATIONALITY=IN
 *   ADULTS=2
 *   CHILDREN=0
 *   BATCH_SIZE=100
 *   CONCURRENCY=5
 *   TBO_STATIC_USERNAME=TBOStaticAPITest
 *   TBO_STATIC_PASSWORD=...
 *   TBO_API_USERNAME=...
 *   TBO_API_PASSWORD=...
 */

const path = require('path');
const fs = require('fs');
const axios = require('axios');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const STATIC_BASE = process.env.TBO_STATIC_BASE_URL || 'http://api.tbotechnology.in/TBOHolidays_HotelAPI';
const SEARCH_URL = process.env.TBO_SEARCH_URL || 'https://affiliate.tektravels.com/HotelAPI/Search';

const STATIC_USERNAME = process.env.TBO_STATIC_USERNAME || 'TBOStaticAPITest';
const STATIC_PASSWORD = process.env.TBO_STATIC_PASSWORD || process.env.TBO_STATIC_API_PASSWORD || '';
const API_USERNAME = process.env.TBO_API_USERNAME || process.env.TBO_USERNAME || '';
const API_PASSWORD = process.env.TBO_API_PASSWORD || process.env.TBO_PASSWORD || '';

const CITY_CODE = String(process.env.CITY_CODE || '127067');
const SEARCH_CITY_CODE = String(process.env.SEARCH_CITY_CODE || CITY_CODE);
const GUEST_NATIONALITY = String(process.env.GUEST_NATIONALITY || 'IN');
const ADULTS = Number(process.env.ADULTS || 2);
const CHILDREN = Number(process.env.CHILDREN || 0);
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 100);
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);

function getDates() {
  if (process.env.CHECK_IN && process.env.CHECK_OUT) {
    return { checkIn: process.env.CHECK_IN, checkOut: process.env.CHECK_OUT };
  }

  const checkIn = new Date();
  checkIn.setDate(checkIn.getDate() + 20);
  const checkOut = new Date(checkIn);
  checkOut.setDate(checkOut.getDate() + 1);

  const ymd = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  return { checkIn: ymd(checkIn), checkOut: ymd(checkOut) };
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function getStaticAuth() {
  if (!STATIC_PASSWORD) {
    throw new Error('Missing TBO static password. Set TBO_STATIC_PASSWORD in .env');
  }
  return `Basic ${Buffer.from(`${STATIC_USERNAME}:${STATIC_PASSWORD}`).toString('base64')}`;
}

function getSearchAuth() {
  if (!API_USERNAME || !API_PASSWORD) {
    throw new Error('Missing TBO affiliate credentials. Set TBO_API_USERNAME and TBO_API_PASSWORD in .env');
  }
  return `Basic ${Buffer.from(`${API_USERNAME}:${API_PASSWORD}`).toString('base64')}`;
}

async function fetchHotelCodeList(cityCode) {
  const response = await axios.post(
    `${STATIC_BASE}/TBOHotelCodeList`,
    { CityCode: String(cityCode), IsDetailedResponse: 'true' },
    {
      timeout: 60000,
      headers: {
        'Content-Type': 'application/json',
        Authorization: getStaticAuth(),
      },
    },
  );

  const hotels = Array.isArray(response.data?.Hotels) ? response.data.Hotels : [];
  const listOnly = Array.isArray(response.data?.HotelCodeList) ? response.data.HotelCodeList : [];

  if (hotels.length > 0) {
    return hotels
      .map((h) => ({
        hotelCode: String(h.HotelCode || h.hotelCode || '').trim(),
        hotelName: String(h.HotelName || h.hotelName || '').trim(),
      }))
      .filter((h) => h.hotelCode);
  }

  return listOnly
    .map((item) => {
      if (typeof item === 'string' || typeof item === 'number') {
        return { hotelCode: String(item).trim(), hotelName: '' };
      }
      return {
        hotelCode: String(item?.HotelCode || item?.hotelCode || '').trim(),
        hotelName: String(item?.HotelName || item?.hotelName || '').trim(),
      };
    })
    .filter((h) => h.hotelCode);
}

async function searchBatch(batchCodes, params) {
  const payload = {
    CheckIn: params.checkIn,
    CheckOut: params.checkOut,
    HotelCodes: batchCodes.join(','),
    CityCode: params.searchCityCode,
    GuestNationality: params.guestNationality,
    PaxRooms: [
      {
        Adults: params.adults,
        Children: params.children,
        ChildrenAges: [],
      },
    ],
    ResponseTime: 23,
    IsDetailedResponse: true,
    Filters: {
      Refundable: false,
      NoOfRooms: 0,
      MealType: '',
      OrderBy: 0,
      StarRating: 0,
      HotelName: null,
    },
  };

  const response = await axios.post(SEARCH_URL, payload, {
    timeout: 90000,
    headers: {
      'Content-Type': 'application/json',
      Authorization: getSearchAuth(),
    },
  });

  const status = response.data?.Status;
  const statusCode = typeof status === 'object' ? status?.Code : status;

  if (statusCode !== 200) {
    const desc = typeof status === 'object' ? status?.Description : 'Unknown status';
    return { hotels: [], statusCode, description: desc };
  }

  return {
    hotels: Array.isArray(response.data?.HotelResult) ? response.data.HotelResult : [],
    statusCode,
    description: 'Success',
  };
}

function extractHotelPrice(hotel) {
  const roomPrices = [];
  const rooms = Array.isArray(hotel?.Rooms) ? hotel.Rooms : [];

  for (const room of rooms) {
    const candidate =
      room?.NetAmount ??
      room?.TotalFare ??
      room?.Price ??
      room?.PublishedPriceRoundedOff ??
      room?.PublishedPrice;

    const num = Number(candidate);
    if (Number.isFinite(num) && num > 0) {
      roomPrices.push(num);
    }
  }

  if (!roomPrices.length) {
    return null;
  }

  return Math.min(...roomPrices);
}

function groupByPriceTiers(hotels) {
  const unique = new Map();

  for (const hotel of hotels) {
    const code = String(hotel?.HotelCode || '').trim();
    if (!code) continue;

    const price = extractHotelPrice(hotel);
    if (price === null) continue;

    const existing = unique.get(code);
    if (!existing || price < existing.price) {
      unique.set(code, {
        hotelCode: code,
        hotelName: String(hotel?.HotelName || '').trim(),
        cityCode: String(hotel?.CityCode || '').trim(),
        price,
      });
    }
  }

  const sorted = [...unique.values()].sort((a, b) => a.price - b.price);

  const tiers = [
    { groupType: 1, label: 'Budget', hotels: [] },
    { groupType: 2, label: 'Mid-Range', hotels: [] },
    { groupType: 3, label: 'Premium', hotels: [] },
    { groupType: 4, label: 'Luxury', hotels: [] },
  ];

  const n = sorted.length;
  if (n === 0) return tiers;

  for (let i = 0; i < n; i++) {
    const tierIndex = Math.min(Math.floor((i / n) * 4), 3);
    tiers[tierIndex].hotels.push(sorted[i]);
  }

  return tiers;
}

async function mapWithConcurrency(items, limit, handler) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;

      try {
        results[current] = await handler(items[current], current);
      } catch (error) {
        results[current] = { error: error?.message || String(error) };
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, limit) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  const { checkIn, checkOut } = getDates();

  console.log('=== TBO Batch Search From CodeList ===');
  console.log(`CityCode (CodeList): ${CITY_CODE}`);
  console.log(`CityCode (Search): ${SEARCH_CITY_CODE}`);
  console.log(`Date range: ${checkIn} -> ${checkOut}`);
  console.log(`Batch size: ${BATCH_SIZE}`);

  const codeRows = await fetchHotelCodeList(CITY_CODE);
  const hotelCodes = codeRows.map((r) => r.hotelCode);

  console.log(`Hotel codes returned by TBOHotelCodeList: ${hotelCodes.length}`);

  if (!hotelCodes.length) {
    throw new Error('No hotel codes returned from TBOHotelCodeList');
  }

  const batches = chunkArray(hotelCodes, BATCH_SIZE);
  console.log(`Total search batches: ${batches.length}`);

  const batchResults = await mapWithConcurrency(batches, CONCURRENCY, async (batch, index) => {
    const result = await searchBatch(batch, {
      checkIn,
      checkOut,
      searchCityCode: SEARCH_CITY_CODE,
      guestNationality: GUEST_NATIONALITY,
      adults: ADULTS,
      children: CHILDREN,
    });

    const size = batch.length;
    const found = Array.isArray(result.hotels) ? result.hotels.length : 0;
    console.log(
      `Batch ${index + 1}/${batches.length} - sent ${size} codes, status=${result.statusCode}, hotels=${found}`,
    );

    return {
      batchIndex: index + 1,
      sentCodes: size,
      statusCode: result.statusCode,
      statusDescription: result.description,
      hotels: result.hotels || [],
    };
  });

  const successfulBatches = batchResults.filter((r) => !r.error && r.statusCode === 200);
  const failedBatches = batchResults.filter((r) => r.error || r.statusCode !== 200);
  const allHotels = successfulBatches.flatMap((r) => r.hotels || []);
  const tiers = groupByPriceTiers(allHotels);

  const summary = {
    cityCodeFromCodeList: CITY_CODE,
    cityCodeUsedForSearch: SEARCH_CITY_CODE,
    checkIn,
    checkOut,
    hotelCodesReturned: hotelCodes.length,
    expectedBatchesAt100: Math.ceil(hotelCodes.length / 100),
    actualBatchSize: BATCH_SIZE,
    batchesSent: batches.length,
    successfulBatches: successfulBatches.length,
    failedBatches: failedBatches.length,
    rawHotelRowsFromSearch: allHotels.length,
    uniqueHotelsWithPrice: tiers.reduce((acc, t) => acc + t.hotels.length, 0),
    priceGroups: tiers.map((t) => ({
      groupType: t.groupType,
      label: t.label,
      count: t.hotels.length,
      minPrice: t.hotels.length ? t.hotels[0].price : null,
      maxPrice: t.hotels.length ? t.hotels[t.hotels.length - 1].price : null,
    })),
  };

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(process.cwd(), `tbo-batch-search-grouped-${stamp}.json`);
  const payload = {
    summary,
    failedBatches,
    priceGroups: tiers,
  };

  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`\nSaved output: ${outPath}`);
}

main().catch((error) => {
  console.error('FAILED:', error?.message || error);
  process.exit(1);
});
