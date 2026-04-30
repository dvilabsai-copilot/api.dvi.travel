const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const prisma = new PrismaClient();

function parseArgs(argv) {
  const args = { cityCode: '', dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (token === '--city' && argv[i + 1]) {
      args.cityCode = String(argv[i + 1]).trim();
      i += 1;
      continue;
    }
  }
  if (!args.cityCode && argv[2] && !argv[2].startsWith('--')) {
    args.cityCode = String(argv[2]).trim();
  }
  return args;
}

function getStaticAuth() {
  const username = process.env.TBO_STATIC_USERNAME || 'TBOStaticAPITest';
  const password =
    process.env.TBO_STATIC_PASSWORD ||
    process.env.TBO_STATIC_API_PASSWORD ||
    process.env.TBO_STATIC_PASS ||
    '';

  if (!password) {
    throw new Error(
      'Missing TBO static API password. Set TBO_STATIC_PASSWORD (or TBO_STATIC_API_PASSWORD) in environment.',
    );
  }

  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function parseStarRating(starValue) {
  const text = String(starValue || '').toLowerCase().trim();
  if (!text) return 0;
  if (text.includes('five')) return 5;
  if (text.includes('four')) return 4;
  if (text.includes('three')) return 3;
  if (text.includes('two')) return 2;
  if (text.includes('one')) return 1;
  const parsed = Number(text.replace(/[^0-9]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function fetchHotelCodeList(cityCode) {
  const baseUrl = process.env.TBO_STATIC_BASE_URL || 'http://api.tbotechnology.in/TBOHolidays_HotelAPI';
  const response = await axios.post(
    `${baseUrl}/TBOHotelCodeList`,
    {
      CityCode: cityCode,
      IsDetailedResponse: 'true',
    },
    {
      timeout: 60000,
      headers: {
        'Content-Type': 'application/json',
        Authorization: getStaticAuth(),
      },
    },
  );

  const hotels = Array.isArray(response.data?.Hotels) ? response.data.Hotels : [];
  const codeList = Array.isArray(response.data?.HotelCodeList) ? response.data.HotelCodeList : [];

  if (hotels.length > 0) {
    return hotels;
  }

  return codeList.map((row) => ({
    HotelCode: String(row?.HotelCode || row?.hotelCode || row || '').trim(),
    HotelName: String(row?.HotelName || row?.hotelName || '').trim() || null,
    Address: String(row?.Address || '').trim() || null,
    CityName: String(row?.CityName || '').trim() || null,
    HotelRating: row?.HotelRating || row?.StarRating || 0,
  }));
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function upsertHotels(rows) {
  // Limit parallelism to avoid overloading DB while keeping the sync reasonably fast.
  const batches = chunk(rows, 100);
  for (const batch of batches) {
    await Promise.all(
      batch.map((row) =>
        prisma.tbo_hotel_master.upsert({
          where: { tbo_hotel_code: row.tbo_hotel_code },
          update: {
            tbo_city_code: row.tbo_city_code,
            hotel_name: row.hotel_name,
            hotel_address: row.hotel_address,
            city_name: row.city_name,
            star_rating: row.star_rating,
            status: row.status,
          },
          create: row,
        }),
      ),
    );
  }
}

async function main() {
  const { cityCode, dryRun } = parseArgs(process.argv);
  if (!cityCode) {
    throw new Error('City code is required. Example: node scripts/sync-missing-tbo-hotels-by-city.js --city 127343');
  }

  console.log(`CityCode: ${cityCode}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'WRITE'}`);

  const beforeCount = await prisma.tbo_hotel_master.count({
    where: { tbo_city_code: cityCode },
  });
  console.log(`Before count (tbo_hotel_master): ${beforeCount}`);

  const apiHotels = await fetchHotelCodeList(cityCode);
  const normalized = apiHotels
    .map((h) => ({
      tbo_hotel_code: String(h?.HotelCode || '').trim(),
      hotel_name: h?.HotelName ? String(h.HotelName).trim() : null,
      hotel_address: h?.Address ? String(h.Address).trim() : null,
      city_name: h?.CityName ? String(h.CityName).trim() : null,
      star_rating: parseStarRating(h?.HotelRating),
      tbo_city_code: cityCode,
      status: 1,
    }))
    .filter((h) => h.tbo_hotel_code);

  const uniqueMap = new Map();
  for (const h of normalized) {
    if (!uniqueMap.has(h.tbo_hotel_code)) {
      uniqueMap.set(h.tbo_hotel_code, h);
    }
  }
  const uniqueHotels = [...uniqueMap.values()];
  console.log(`TBOHotelCodeList returned: ${uniqueHotels.length}`);

  const existingRows = await prisma.tbo_hotel_master.findMany({
    where: { tbo_city_code: cityCode },
    select: { tbo_hotel_code: true },
  });
  const existingSet = new Set(existingRows.map((r) => String(r.tbo_hotel_code).trim()));

  const missing = uniqueHotels.filter((h) => !existingSet.has(h.tbo_hotel_code));
  console.log(`Missing in DB: ${missing.length}`);

  const missingCodes = missing.map((h) => h.tbo_hotel_code);
  const globalMatches =
    missingCodes.length > 0
      ? await prisma.tbo_hotel_master.findMany({
          where: { tbo_hotel_code: { in: missingCodes } },
          select: { tbo_hotel_code: true, tbo_city_code: true },
        })
      : [];
  const globalMap = new Map(globalMatches.map((row) => [String(row.tbo_hotel_code).trim(), String(row.tbo_city_code).trim()]));

  let willInsert = 0;
  let willReassign = 0;
  for (const code of missingCodes) {
    const existingCity = globalMap.get(code);
    if (!existingCity) {
      willInsert += 1;
      continue;
    }
    if (existingCity !== cityCode) {
      willReassign += 1;
    }
  }

  console.log(`Will insert new codes: ${willInsert}`);
  console.log(`Will reassign from other cities: ${willReassign}`);

  if (!dryRun && missing.length > 0) {
    await upsertHotels(missing);
    console.log(`Upserted rows: ${missing.length}`);
  }

  const afterCount = await prisma.tbo_hotel_master.count({
    where: { tbo_city_code: cityCode },
  });
  console.log(`After count (tbo_hotel_master): ${afterCount}`);

  console.log('Done.');
}

main()
  .catch((error) => {
    console.error(`FAILED: ${error?.message || error}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
