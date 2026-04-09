require('dotenv').config();
const http = require('http');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const token = process.env.TEST_AUTH_TOKEN || process.env.AUTH_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI5OCIsImVtYWlsIjoiZGVtb0BkdmkuY28uaW4iLCJyb2xlIjo0LCJhZ2VudElkIjo4LCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3NzQwNDk3MDUsImV4cCI6MTc3NDY1NDUwNX0.XAR4bE8Ua5iYR5eVUXlTtsxV20XtFsqyiAw5PUmsXHc';

const ARRIVAL_POINT = 'Chennai International Airport';
const DEPARTURE_POINT = 'Chennai International Airport';
const TRIP_START_ISO = '2026-04-28';
const TRIP_START_TIME = '08:00:00';
const IST_OFFSET = '+05:30';
const STAY_CITIES = ['Madurai', 'Rameswaram', 'Kodaikanal', 'Thekkady', 'Munnar'];

function addDays(dateStr, days) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + days);
  const nextYear = dt.getUTCFullYear();
  const nextMonth = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const nextDay = String(dt.getUTCDate()).padStart(2, '0');
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

function formatIST(dateStr, time) {
  return `${dateStr}T${time}${IST_OFFSET}`;
}

async function getActivitySummaryForCity(city) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT hp.hotspot_ID, hp.hotspot_name, COUNT(a.activity_id) AS activity_count
     FROM dvi_hotspot_place hp
     JOIN dvi_activity a
       ON a.hotspot_id = hp.hotspot_ID
      AND a.deleted = 0
      AND a.status = 1
     WHERE hp.deleted = 0
       AND hp.status = 1
       AND hp.hotspot_location LIKE CONCAT('%', ?, '%')
     GROUP BY hp.hotspot_ID, hp.hotspot_name
     ORDER BY activity_count DESC, hp.hotspot_name ASC`,
    city,
  );

  const hotspotCount = rows.length;
  const activityCount = rows.reduce((sum, row) => sum + Number(row.activity_count || 0), 0);
  return {
    city,
    hotspotCount,
    activityCount,
    hotspots: rows.map((row) => ({
      hotspotId: Number(row.hotspot_ID),
      hotspotName: String(row.hotspot_name || ''),
      activityCount: Number(row.activity_count || 0),
    })),
  };
}

async function assertRouteLegsExist(routePairs) {
  for (const pair of routePairs) {
    const row = await prisma.dvi_stored_locations.findFirst({
      where: {
        source_location: pair.source,
        destination_location: pair.destination,
        deleted: 0,
      },
      select: {
        source_location: true,
        destination_location: true,
        distance: true,
        duration: true,
      },
    });

    if (!row) {
      throw new Error(`Missing stored route leg: ${pair.source} -> ${pair.destination}`);
    }

    pair.distance = row.distance;
    pair.duration = row.duration;
  }
}

function buildRoutes(stayCities) {
  const routes = [];

  routes.push({
    location_name: ARRIVAL_POINT,
    next_visiting_location: stayCities[0],
    itinerary_route_date: formatIST(TRIP_START_ISO, '00:00:00'),
    no_of_days: 1,
    no_of_km: '',
    direct_to_next_visiting_place: 0,
    via_route: '',
    via_routes: [],
  });

  for (let index = 0; index < stayCities.length - 1; index += 1) {
    routes.push({
      location_name: stayCities[index],
      next_visiting_location: stayCities[index + 1],
      itinerary_route_date: formatIST(addDays(TRIP_START_ISO, index + 1), '00:00:00'),
      no_of_days: index + 2,
      no_of_km: '',
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    });
  }

  routes.push({
    location_name: stayCities[stayCities.length - 1],
    next_visiting_location: DEPARTURE_POINT,
    itinerary_route_date: formatIST(addDays(TRIP_START_ISO, stayCities.length), '00:00:00'),
    no_of_days: stayCities.length + 1,
    no_of_km: '',
    direct_to_next_visiting_place: 0,
    via_route: '',
    via_routes: [],
  });

  return routes;
}

async function createItinerary(requestBody) {
  const postData = JSON.stringify(requestBody);
  const options = {
    hostname: '127.0.0.1',
    port: 4006,
    path: '/api/v1/itineraries',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Length': Buffer.byteLength(postData),
    },
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if ((res.statusCode || 500) >= 400) {
          return reject(new Error(`Create itinerary failed with ${res.statusCode}: ${data}`));
        }

        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function main() {
  console.log('\n=== VALIDATING HIGH-ACTIVITY CITIES FROM DB ===');

  const summaries = [];
  for (const city of STAY_CITIES) {
    const summary = await getActivitySummaryForCity(city);
    summaries.push(summary);
    console.log(`- ${city}: ${summary.hotspotCount} hotspot(s), ${summary.activityCount} activity row(s)`);
    summary.hotspots.slice(0, 5).forEach((hotspot) => {
      console.log(`    • ${hotspot.hotspotName} (${hotspot.activityCount} activities)`);
    });
  }

  const weakCities = summaries.filter((summary) => summary.hotspotCount === 0 || summary.activityCount === 0);
  if (weakCities.length > 0) {
    throw new Error(`One or more cities have no activity-backed hotspots: ${weakCities.map((city) => city.city).join(', ')}`);
  }

  const routes = buildRoutes(STAY_CITIES);
  const routePairs = routes.map((route) => ({
    source: route.location_name,
    destination: route.next_visiting_location,
  }));

  console.log('\n=== VALIDATING ROUTE LEGS ===');
  await assertRouteLegsExist(routePairs);
  routePairs.forEach((pair) => {
    console.log(`- ${pair.source} -> ${pair.destination} (${pair.distance || 'n/a'} km, ${pair.duration || 'n/a'})`);
  });

  const noOfNights = STAY_CITIES.length;
  const noOfDays = noOfNights + 1;
  const tripEndDate = addDays(TRIP_START_ISO, noOfNights);

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
      budget: 40000,
      entry_ticket_required: 0,
      guide_for_itinerary: 0,
      nationality: 101,
      food_type: 0,
      adult_count: 2,
      child_count: 0,
      infant_count: 0,
      special_instructions: `Activity-dense itinerary across ${STAY_CITIES.join(', ')}`,
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

  console.log('\n=== CREATING ITINERARY ===');
  console.log(`Stay cities: ${STAY_CITIES.join(' -> ')}`);

  const response = await createItinerary(requestBody);
  console.log('\n=== CREATE ITINERARY RESPONSE ===');
  console.log(JSON.stringify(response, null, 2));
}

main()
  .catch((error) => {
    console.error('\nTrigger failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(process.exitCode || 0);
  });