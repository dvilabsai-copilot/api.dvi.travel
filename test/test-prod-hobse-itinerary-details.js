/*
 * Create itinerary from Justa city list and fetch itinerary detail endpoints from production.
 * Runs locally, calls production API.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const XLSX = require('xlsx');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();

const PROD_API_BASE_URL = process.env.PROD_API_BASE_URL || 'https://dvi.versile.in/api/v1';
const PROD_JWT_TOKEN = process.env.PROD_JWT_TOKEN || '';
const JUSTA_XLSX_PATH =
  process.env.JUSTA_XLSX_PATH || path.join(process.cwd(), 'Justa Active Hotels City Details.xlsx');

const JUSTA_CITY_LIMIT = Number(process.env.JUSTA_CITY_LIMIT || 5);
const AGENT_ID = Number(process.env.ITINERARY_AGENT_ID || 126);
const STAFF_ID = Number(process.env.ITINERARY_STAFF_ID || 0);
const VEHICLE_TYPE_ID = Number(process.env.ITINERARY_VEHICLE_TYPE_ID || 1);
const VEHICLE_COUNT = Number(process.env.ITINERARY_VEHICLE_COUNT || 1);

function ensurePreconditions() {
  if (!PROD_JWT_TOKEN) {
    throw new Error('Missing PROD_JWT_TOKEN in environment.');
  }

  if (!fs.existsSync(JUSTA_XLSX_PATH)) {
    throw new Error(`Justa workbook not found at: ${JUSTA_XLSX_PATH}`);
  }

  if (!Number.isFinite(JUSTA_CITY_LIMIT) || JUSTA_CITY_LIMIT < 2) {
    throw new Error('JUSTA_CITY_LIMIT must be a number >= 2.');
  }
}

function normalize(value) {
  return String(value || '').trim();
}

function canonicalCityName(city) {
  return normalize(city).split(',')[0].trim();
}

async function loadHotelCitiesFromDb() {
  const rows = await prisma.dvi_hotel.findMany({
    where: {
      status: 1,
      OR: [{ deleted: false }, { deleted: null }],
      hotel_city: { not: null },
    },
    select: { hotel_city: true },
  });

  const citySet = new Set();
  for (const row of rows) {
    const c = canonicalCityName(row.hotel_city || '');
    if (c) citySet.add(c.toLowerCase());
  }

  return citySet;
}

async function loadJustaCities() {
  const workbook = XLSX.readFile(JUSTA_XLSX_PATH);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('Workbook does not contain any sheets.');
  }

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    defval: '',
    raw: false,
  });

  const availableHotelCities = await loadHotelCitiesFromDb();

  const picked = [];
  const seen = new Set();

  for (const row of rows) {
    const rawCity = normalize(row['City Name']);
    const city = canonicalCityName(rawCity);
    if (!city) continue;

    const key = city.toLowerCase();
    if (seen.has(key)) continue;

    if (!availableHotelCities.has(key)) {
      continue;
    }

    seen.add(key);
    picked.push(city);

    if (picked.length >= JUSTA_CITY_LIMIT) break;
  }

  if (picked.length < 2) {
    throw new Error(
      'Need at least 2 Justa cities that exist in dvi_hotel to build itinerary routes.',
    );
  }

  return picked;
}

function formatIsoDate(date) {
  return new Date(date).toISOString().replace('Z', '+05:30');
}

function buildCreatePayload(cities) {
  const now = new Date();
  const tripStart = new Date(now);
  tripStart.setDate(now.getDate() + 30);

  const routeCount = cities.length;
  const noOfDays = routeCount;
  const noOfNights = Math.max(1, routeCount - 1);
  const tripEnd = new Date(tripStart);
  tripEnd.setDate(tripStart.getDate() + noOfNights);

  const arrivalPoint = cities[0];
  const departurePoint = cities[0];

  const routes = cities.map((city, index) => {
    const routeDate = new Date(tripStart);
    routeDate.setDate(tripStart.getDate() + index);

    return {
      location_name: city,
      next_visiting_location: index < cities.length - 1 ? cities[index + 1] : departurePoint,
      itinerary_route_date: formatIsoDate(routeDate),
      no_of_days: index + 1,
      no_of_km: '',
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    };
  });

  return {
    plan: {
      itinerary_plan_id: 0,
      agent_id: AGENT_ID,
      staff_id: STAFF_ID,
      location_id: 0,
      arrival_point: arrivalPoint,
      departure_point: departurePoint,
      itinerary_preference: 3,
      itinerary_type: 2,
      preferred_hotel_category: [2],
      hotel_facilities: [],
      trip_start_date: formatIsoDate(tripStart),
      trip_end_date: formatIsoDate(tripEnd),
      pick_up_date_and_time: formatIsoDate(tripStart),
      arrival_type: 1,
      departure_type: 1,
      no_of_nights: noOfNights,
      no_of_days: noOfDays,
      budget: 25000,
      entry_ticket_required: 0,
      guide_for_itinerary: 0,
      nationality: 101,
      food_type: 0,
      adult_count: 2,
      child_count: 0,
      infant_count: 0,
      special_instructions: 'Auto-generated from Justa cities for HOBSE production test',
    },
    routes,
    vehicles: [
      {
        vehicle_type_id: VEHICLE_TYPE_ID,
        vehicle_count: VEHICLE_COUNT,
      },
    ],
    travellers: [
      { room_id: 1, traveller_type: 1 },
      { room_id: 1, traveller_type: 1 },
    ],
  };
}

function extractPlanAndQuote(data) {
  const quoteId =
    data?.quoteId ||
    data?.itinerary_quote_ID ||
    data?.plan?.itinerary_quote_ID ||
    data?.data?.quoteId ||
    null;

  const planId =
    data?.itinerary_plan_ID ||
    data?.itinerary_plan_id ||
    data?.plan?.itinerary_plan_ID ||
    data?.plan?.itinerary_plan_id ||
    data?.data?.itinerary_plan_ID ||
    null;

  return { quoteId, planId };
}

async function callEndpoint(url, token) {
  return axios.get(url, {
    timeout: 120000,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}

async function createItineraryWithRetries(initialCities, createUrl) {
  let activeCities = [...initialCities];

  while (activeCities.length >= 2) {
    const payload = buildCreatePayload(activeCities);

    console.log(`\nPOST ${createUrl}`);
    console.log(`Trying route cities (${activeCities.length}): ${activeCities.join(' -> ')}`);

    try {
      const createRes = await axios.post(createUrl, payload, {
        timeout: 120000,
        headers: {
          Authorization: `Bearer ${PROD_JWT_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });

      return { createRes, activeCities, payload };
    } catch (error) {
      const status = error?.response?.status;
      const missingHotels = error?.response?.data?.missingHotels;

      if (status !== 400 || !Array.isArray(missingHotels) || missingHotels.length === 0) {
        throw error;
      }

      const missingSet = new Set(
        missingHotels
          .map((x) => canonicalCityName(x?.city || '').toLowerCase())
          .filter(Boolean),
      );

      const nextCities = activeCities.filter(
        (c) => !missingSet.has(canonicalCityName(c).toLowerCase()),
      );

      if (nextCities.length === activeCities.length) {
        throw error;
      }

      console.log(
        `Retrying without unavailable cities: ${Array.from(missingSet).join(', ')}`,
      );

      activeCities = nextCities;
    }
  }

  throw new Error('Unable to create itinerary: fewer than 2 cities left after removing unavailable cities.');
}

async function main() {
  ensurePreconditions();

  const cities = await loadJustaCities();

  console.log('\n=== PROD HOBSE ITINERARY TEST ===');
  console.log(`Base URL: ${PROD_API_BASE_URL}`);
  console.log(`Workbook: ${JUSTA_XLSX_PATH}`);
  console.log(`Initial cities (${cities.length}): ${cities.join(' -> ')}`);

  const createUrl = `${PROD_API_BASE_URL}/itineraries`;
  const { createRes, activeCities, payload } = await createItineraryWithRetries(cities, createUrl);

  console.log(`Create Status: ${createRes.status}`);
  console.log(`Final route cities (${activeCities.length}): ${activeCities.join(' -> ')}`);

  const { quoteId, planId } = extractPlanAndQuote(createRes.data);
  console.log(`Plan ID: ${planId || 'N/A'}`);
  console.log(`Quote ID: ${quoteId || 'N/A'}`);

  if (!quoteId) {
    throw new Error('Could not extract quoteId from create itinerary response.');
  }

  const detailsUrl = `${PROD_API_BASE_URL}/itineraries/details/${quoteId}`;
  const hotelDetailsUrl = `${PROD_API_BASE_URL}/itineraries/hotel_details/${quoteId}`;
  const roomDetailsUrl = `${PROD_API_BASE_URL}/itineraries/hotel_room_details/${quoteId}`;

  console.log(`\nGET ${detailsUrl}`);
  const detailsRes = await callEndpoint(detailsUrl, PROD_JWT_TOKEN);
  console.log(`Details Status: ${detailsRes.status}`);

  console.log(`\nGET ${hotelDetailsUrl}`);
  const hotelDetailsRes = await callEndpoint(hotelDetailsUrl, PROD_JWT_TOKEN);
  console.log(`Hotel Details Status: ${hotelDetailsRes.status}`);
  console.log(`Hotel Tabs: ${hotelDetailsRes.data?.hotelTabs?.length || 0}`);
  console.log(`Hotels: ${hotelDetailsRes.data?.hotels?.length || 0}`);

  console.log(`\nGET ${roomDetailsUrl}`);
  const roomDetailsRes = await callEndpoint(roomDetailsUrl, PROD_JWT_TOKEN);
  console.log(`Room Details Status: ${roomDetailsRes.status}`);
  console.log(`Rooms: ${roomDetailsRes.data?.rooms?.length || 0}`);

  const outDir = path.join(process.cwd(), 'test', 'production-request-response-logs');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `hobse-prod-itinerary-${quoteId}-${stamp}.json`);

  const output = {
    generatedAt: new Date().toISOString(),
    baseUrl: PROD_API_BASE_URL,
    cityChain: cities,
    request: {
      createUrl,
      payload,
    },
    responses: {
      create: createRes.data,
      details: detailsRes.data,
      hotelDetails: hotelDetailsRes.data,
      roomDetails: roomDetailsRes.data,
    },
  };

  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`\nSaved full output: ${outFile}`);
  console.log('\n=== DONE ===\n');
}

main()
  .catch((error) => {
    const status = error?.response?.status;
    const data = error?.response?.data;

    console.error('\n=== FAILED ===');
    console.error(error.message || error);
    if (status) console.error(`HTTP Status: ${status}`);
    if (data) {
      console.error('Response Data:');
      console.error(JSON.stringify(data, null, 2));
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
