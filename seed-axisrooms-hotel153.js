/**
 * seed-axisrooms-hotel153.js
 * Seeds inventory + rate data for hotel 153 (MUNNAR QUEEN / AX_DVI_HOTEL_153)
 * via the AxisRooms inbound API endpoints, then checks the rate plan rows.
 *
 * Usage: node seed-axisrooms-hotel153.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const API_BASE = 'http://127.0.0.1:4006/api/v1';
const AUTH_KEY = 'axis_C3g8K3b1wray989DVih37od3314r6444';
const PROPERTY_ID = 'AX_DVI_HOTEL_153';
const HOTEL_ID = 153;

// Rooms: room_ref_code and a default rateplanId to seed
const ROOMS = [
  { roomId: 'DVIRHON666981', room_id: 189, label: 'Honey Moon',   extRateplanId: '12' },
  { roomId: 'DVIREXE136214', room_id: 190, label: 'Executive A',  extRateplanId: '13' },
  { roomId: 'DVIRSUI200245', room_id: 191, label: 'Suite',        extRateplanId: '12' },
  { roomId: 'DVIRLUX836022', room_id: 192, label: 'Luxury',       extRateplanId: '12' },
  { roomId: 'DVIREXE771617', room_id: 193, label: 'Executive B',  extRateplanId: '12' },
  { roomId: 'DVIREXE96359',  room_id: 497, label: 'Executive C',  extRateplanId: '12' },
];

const START_DATE = '2026-05-01';
const END_DATE   = '2026-12-31';
const FREE_COUNT = 5;

// Rates to seed per room
const RATES = { SINGLE: 2500, DOUBLE: 3200, TRIPLE: 4200, EXTRABED: 800 };

async function post(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function seedInventory(roomId) {
  return post('/axisrooms/inventoryUpdate', {
    auth: { key: AUTH_KEY },
    data: {
      propertyId: PROPERTY_ID,
      roomId,
      inventory: [{ startDate: START_DATE, endDate: END_DATE, free: FREE_COUNT }],
    },
  });
}

async function seedRates(roomId, rateplanId) {
  return post('/axisrooms/rateUpdate', {
    auth: { key: AUTH_KEY },
    data: {
      propertyId: PROPERTY_ID,
      roomId,
      rateplanId,
      rate: [{ startDate: START_DATE, endDate: END_DATE, ...RATES }],
    },
  });
}

  // External rateplan IDs as AxisRooms knows them (externalRateplanId in CANONICAL_HOTEL_RATE_PLANS)
  // CP=12, EP=15, MAP=13, AP=14
  const EXTERNAL_RATEPLAN_CP  = '12';
  const EXTERNAL_RATEPLAN_MAP = '13';

async function main() {
  console.log('==========================================================');
  console.log('  AxisRooms Seed: Hotel 153 (MUNNAR QUEEN)');
  console.log('==========================================================\n');

  // 1) Fetch rate plans for hotel 153 rooms so we know the rateplanId
  const ratePlans = await prisma.$queryRawUnsafe(`
    SELECT rp.room_id, rp.rateplan_id, rp.axisrooms_room_id, rp.rateplan_name
    FROM dvi_hotel_room_rate_plan rp
    WHERE rp.hotel_id = ${HOTEL_ID}
    ORDER BY rp.room_id
  `);

  if (ratePlans.length === 0) {
    console.warn('⚠️  No rate plans found for hotel 153. Axisrooms room_id linkage may be missing.');
    console.warn('   Rate seeding will attempt with default rateplanId = "CP_PLAN".');
  } else {
    console.log('📋 Existing rate plans for hotel 153:');
    for (const rp of ratePlans) {
      console.log(`   room_id=${rp.room_id}  rateplan_id=${rp.rateplan_id}  axisrooms_room_id=${rp.axisrooms_room_id ?? '(null)'}  name=${rp.name}`);
      console.log(`   room_id=${rp.room_id}  rateplan_id=${rp.rateplan_id}  axisrooms_room_id=${rp.axisrooms_room_id ?? '(null)'}  name=${rp.rateplan_name}`);
    }
    console.log();
  }

  // Build map: room_id -> first rateplan_id (prefer one with axisrooms_room_id set)
  const roomRatePlanMap = {};
  for (const rp of ratePlans) {
    const rid = Number(rp.room_id);
    if (!roomRatePlanMap[rid]) roomRatePlanMap[rid] = String(rp.rateplan_id || 'CP_PLAN');
    // prefer axisrooms-linked plan if available
    if (rp.axisrooms_room_id) roomRatePlanMap[rid] = String(rp.rateplan_id || 'CP_PLAN');
  }

  // 2) Seed inventory + rates per room
  for (const room of ROOMS) {
     const rateplanId = room.extRateplanId;
     process.stdout.write(`🏨 ${room.label} (${room.roomId}) rateplan=${rateplanId} ... `);

    const invRes = await seedInventory(room.roomId);
    if (invRes.status >= 200 && invRes.status < 300) {
      const ok = invRes.json?.status === 'success';
      process.stdout.write(ok ? `INV ✅  ` : `INV ⚠️ (${invRes.json?.message})  `);
    } else {
      process.stdout.write(`INV ❌(${invRes.status}: ${JSON.stringify(invRes.json)})  `);
    }

    const rateRes = await seedRates(room.roomId, rateplanId);
    if (rateRes.status >= 200 && rateRes.status < 300) {
      const ok = rateRes.json?.status === 'success';
      console.log(ok ? `RATE ✅` : `RATE ⚠️ (${rateRes.json?.message})`);
    } else {
      console.log(`RATE ❌(${rateRes.status}: ${JSON.stringify(rateRes.json)})`);
    }
  }

  // 3) Verify DB
  console.log('\n📊 DB Verification:');

  const availRows = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) AS cnt FROM dvi_hotel_room_availability
    WHERE hotel_id = ${HOTEL_ID} AND source = 'axisrooms'
  `);
  console.log(`   dvi_hotel_room_availability  source='axisrooms': ${availRows[0].cnt} rows`);

  const occRows = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) AS cnt FROM dvi_hotel_occupancy_rate
    WHERE hotel_id = ${HOTEL_ID} AND source = 'axisrooms'
  `);
  console.log(`   dvi_hotel_occupancy_rate     source='axisrooms': ${occRows[0].cnt} rows`);

  const rpRows = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) AS cnt FROM dvi_hotel_room_rate_plan
    WHERE hotel_id = ${HOTEL_ID} AND axisrooms_room_id IS NOT NULL
  `);
  console.log(`   dvi_hotel_room_rate_plan     axisrooms_room_id NOT NULL: ${rpRows[0].cnt} rows`);

  // 4) Check if a Munnar itinerary exists to test with
  console.log('\n🗺️  Searching for itineraries with Munnar route...');
  const munnarItineraries = await prisma.$queryRawUnsafe(`
      SELECT DISTINCT p.itinerary_quote_ID AS quote_id,
                      r.itinerary_route_date AS route_date,
                      r.itinerary_route_ID AS route_id,
                      r.location_name AS destination
      FROM dvi_itinerary_plan_details p
      JOIN dvi_itinerary_route_details r ON r.itinerary_plan_ID = p.itinerary_plan_ID
      WHERE (
        LOWER(r.location_name) LIKE '%munnar%'
      )
      AND r.itinerary_route_date >= '2026-05-01'
      AND p.deleted = 0 AND r.deleted = 0
      ORDER BY r.itinerary_route_date
    LIMIT 5
  `);

  if (munnarItineraries.length > 0) {
    console.log('   Found Munnar itineraries:');
    for (const row of munnarItineraries) {
      console.log(`   quote_id=${row.quote_id}  route_id=${row.route_id}  destination=${row.destination}  route_date=${row.route_date}`);
    }
    // Write best quoteId to a file for the playwright test
    const best = munnarItineraries[0];
    require('fs').writeFileSync('munnar-test-fixture.json', JSON.stringify({
      quoteId: best.quote_id,
      routeDate: best.route_date instanceof Date
        ? best.route_date.toISOString().slice(0, 10)
        : String(best.route_date).slice(0, 10),
      routeId: Number(best.route_id),
    }, null, 2));
    console.log(`\n✅ Wrote munnar-test-fixture.json for quoteId=${best.quote_id}`);
  } else {
      console.log('   ⚠️  No Munnar itineraries found with itinerary_route_date >= 2026-05-01');
    console.log('   You may need to create one in the UI, or adjust the date filter.');
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  prisma.$disconnect();
  process.exit(1);
});
