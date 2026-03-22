require('dotenv').config();
const http = require('http');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI5OCIsImVtYWlsIjoiZGVtb0BkdmkuY28uaW4iLCJyb2xlIjo0LCJhZ2VudElkIjo4LCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3NzQwNDk3MDUsImV4cCI6MTc3NDY1NDUwNX0.XAR4bE8Ua5iYR5eVUXlTtsxV20XtFsqyiAw5PUmsXHc';

const ARRIVAL_POINT = 'Chennai International Airport';
const DEPARTURE_POINT = 'Chennai International Airport';
const TRIP_START_ISO = '2026-04-26';
const TRIP_START_TIME = '08:00:00';
const IST_OFFSET = '+05:30';
const MAX_STAYS = 4;

// Returns 'YYYY-MM-DD' shifted by `days` days, using pure UTC arithmetic to
// avoid any local-timezone drift on the Windows host.
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const ny = dt.getUTCFullYear();
  const nm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const nd = String(dt.getUTCDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

function formatIST(dateStr, time) {
  return `${dateStr}T${time}${IST_OFFSET}`;
}

async function main() {
  // ── Step 1: Fetch TBO-supported cities from dvi_hotel ──────────────────────
  console.log('\n=== FETCHING TBO-SUPPORTED CITIES FROM DB ===');

  // hotel_city stores either a numeric TBO city code (e.g. "733") OR a plain
  // city name (e.g. "Madurai"). Only the plain-name rows can be used directly
  // as route location_name values; numeric codes cannot be resolved because
  // dvi_cities.tbo_city_code is unpopulated. Filter to rows whose hotel_city
  // contains at least one letter (i.e. is a readable city name).
  const cityGroups = await prisma.$queryRawUnsafe(
    "SELECT hotel_city, COUNT(hotel_id) AS hotel_count " +
    "FROM dvi_hotel " +
    "WHERE status = 1 " +
    "  AND (deleted = 0 OR deleted IS NULL) " +
    "  AND tbo_hotel_code IS NOT NULL " +
    "  AND tbo_hotel_code != '' " +
    "  AND hotel_city IS NOT NULL " +
    "  AND hotel_city != '' " +
    "  AND hotel_city REGEXP '[A-Za-z]' " +
    "GROUP BY hotel_city " +
    "ORDER BY hotel_count DESC"
  );

  const tboCities = cityGroups.map(g => ({
    city: String(g.hotel_city).trim(),
    count: Number(g.hotel_count),
  }));

  console.log(`Found ${tboCities.length} TBO-supported city(ies):`);
  tboCities.forEach(c => console.log(`  - ${c.city} (${c.count} TBO hotel(s))`));

  if (tboCities.length === 0) {
    console.error('\n❌ No TBO-supported cities found in dvi_hotel.');
    console.error('   Ensure rows exist with status=1, deleted=0/null, tbo_hotel_code not empty.');
    process.exit(1);
  }

  // ── Step 2: Select stay cities (up to MAX_STAYS) ───────────────────────────
  const selectedCities = tboCities.slice(0, MAX_STAYS).map(c => c.city);
  const noOfNights = selectedCities.length;
  const noOfDays = noOfNights + 1;
  const tripEndDate = addDays(TRIP_START_ISO, noOfNights);

  console.log(`\n=== SELECTED CITIES FOR THIS ITINERARY (${noOfNights} night(s)) ===`);
  selectedCities.forEach((c, i) => console.log(`  Stay ${i + 1}: ${c}`));

  // ── Step 3: Build routes ───────────────────────────────────────────────────
  // Pattern: ArrivalPoint → city[0] → city[1] → … → city[N-1] → DeparturePoint
  const routes = [];

  // Day 1: arrival point → first stay city
  routes.push({
    location_name: ARRIVAL_POINT,
    next_visiting_location: selectedCities[0],
    itinerary_route_date: formatIST(TRIP_START_ISO, '00:00:00'),
    no_of_days: 1,
    no_of_km: '',
    direct_to_next_visiting_place: 0,
    via_route: '',
    via_routes: [],
  });

  // Days 2..N: city-to-city legs
  for (let i = 0; i < selectedCities.length - 1; i++) {
    routes.push({
      location_name: selectedCities[i],
      next_visiting_location: selectedCities[i + 1],
      itinerary_route_date: formatIST(addDays(TRIP_START_ISO, i + 1), '00:00:00'),
      no_of_days: i + 2,
      no_of_km: '',
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    });
  }

  // Final day: last stay city → departure point
  routes.push({
    location_name: selectedCities[noOfNights - 1],
    next_visiting_location: DEPARTURE_POINT,
    itinerary_route_date: formatIST(tripEndDate, '00:00:00'),
    no_of_days: noOfDays,
    no_of_km: '',
    direct_to_next_visiting_place: 0,
    via_route: '',
    via_routes: [],
  });

  // ── Step 4: Build full request body ───────────────────────────────────────
  const requestBody = {
    plan: {
     
      agent_id: 126,
      staff_id: 0,
      location_id: 0,
      arrival_point: ARRIVAL_POINT,
      departure_point: DEPARTURE_POINT,
      itinerary_preference: 3,
      itinerary_type: 2,
      preferred_hotel_category: [2],
      hotel_facilities: [],
      trip_start_date: formatIST(TRIP_START_ISO, TRIP_START_TIME),
      trip_end_date: formatIST(tripEndDate, '12:00:00'),
      pick_up_date_and_time: formatIST(TRIP_START_ISO, TRIP_START_TIME),
      arrival_type: 1,
      departure_type: 1,
      no_of_nights: noOfNights,
      no_of_days: noOfDays,
      budget: 15000,
      entry_ticket_required: 0,
      guide_for_itinerary: 0,
      nationality: 101,
      food_type: 0,
      adult_count: 1,
      child_count: 0,
      infant_count: 0,
      special_instructions: '',
    },
    routes,
    vehicles: [
      { vehicle_type_id: 20, vehicle_count: 1 },
      { vehicle_type_id: 1, vehicle_count: 1 },
    ],
    travellers: [
      { room_id: 1, traveller_type: 1 },
      { room_id: 1, traveller_type: 1 },
    ],
  };

  // ── Step 5: Log payload summary before sending ────────────────────────────
  console.log('\n=== PAYLOAD SUMMARY ===');
  console.log(`  trip_start_date : ${requestBody.plan.trip_start_date}`);
  console.log(`  trip_end_date   : ${requestBody.plan.trip_end_date}`);
  console.log(`  no_of_nights    : ${requestBody.plan.no_of_nights}`);
  console.log(`  no_of_days      : ${requestBody.plan.no_of_days}`);
  console.log(`  Routes (${routes.length}):`);
  routes.forEach(r =>
    console.log(`    Day ${r.no_of_days}: ${r.location_name} → ${r.next_visiting_location}`)
  );

  // ── Step 6: POST to itineraries API ───────────────────────────────────────
  console.log('\n=== TRIGGERING ITINERARY OPTIMIZATION (TBO cities) ===');
  console.log('Sending POST request to http://127.0.0.1:4006/api/v1/itineraries\n');

  const postData = JSON.stringify(requestBody);
  const options = {
    hostname: '127.0.0.1',
    port: 4006,
    path: '/api/v1/itineraries',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Content-Length': Buffer.byteLength(postData),
    },
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      console.log(`\n✅ Response Status: ${res.statusCode}\n`);

      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        console.log('=== RESPONSE ===');
        try {
          const parsed = JSON.parse(data);
          console.log(JSON.stringify(parsed, null, 2));
        } catch (e) {
          console.log(data);
        }
        console.log('\n✅ Done! Log file should be in tmp/ directory');
        console.log('Run: node read_latest_log.js\n');
        resolve();
      });
    });

    req.on('error', (error) => {
      console.error('❌ Error:', error.message);
      reject(error);
    });

    console.log('Writing request body...');
    req.write(postData);
    req.end();
    console.log('Request sent! Waiting for response...\n');
  });
}

main()
  .catch((error) => {
    console.error('❌ Fatal error:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(process.exitCode || 0);
  });
