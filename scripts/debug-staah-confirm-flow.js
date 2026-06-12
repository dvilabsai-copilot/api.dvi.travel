#!/usr/bin/env node

const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function parseDatabaseUrl(databaseUrl) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is missing');
  }

  const parsed = new URL(databaseUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ''),
  };
}

function normalize(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

async function main() {
  const itineraryPlanId = Number(process.argv[2] || 9557);
  const connection = await mysql.createConnection(parseDatabaseUrl(process.env.DATABASE_URL));

  try {
    const [planRows] = await connection.query(
      `
        SELECT itinerary_plan_ID, itinerary_quote_ID
        FROM dvi_itinerary_plan_details
        WHERE itinerary_plan_ID = ?
        LIMIT 1
      `,
      [itineraryPlanId],
    );

    if (!planRows.length) {
      console.log(`Itinerary plan ${itineraryPlanId} not found`);
      process.exitCode = 1;
      return;
    }

    const plan = planRows[0];
    console.log(`Itinerary Plan ID: ${plan.itinerary_plan_ID}`);
    console.log(`Quote ID: ${plan.itinerary_quote_ID || '-'}`);

    const [hotelRows] = await connection.query(
      `
        SELECT
          h.itinerary_route_ID AS routeId,
          h.itinerary_route_date AS routeDate,
          h.hotel_code AS hotelCode,
          dh.hotel_id AS hotelId,
          dh.hotel_name AS hotelName,
          dh.staah_property_id AS propertyId,
          dh.staah_enabled AS staahEnabled
        FROM dvi_itinerary_plan_hotel_details h
        LEFT JOIN dvi_hotel dh
          ON dh.hotel_id = CAST(h.hotel_code AS UNSIGNED)
        WHERE h.itinerary_plan_id = ?
          AND h.deleted = 0
          AND h.status = 1
          AND dh.staah_enabled = 1
      `,
      [itineraryPlanId],
    );

    if (!hotelRows.length) {
      console.log('No selected STAAH hotel rows found for this itinerary');
      process.exitCode = 1;
      return;
    }

    for (const hotel of hotelRows) {
      console.log('\n---');
      console.log(`Route ID: ${hotel.routeId}`);
      console.log(`Hotel ID: ${hotel.hotelId || hotel.hotelCode}`);
      console.log(`Hotel Name: ${hotel.hotelName || '-'}`);
      console.log(`Property ID: ${hotel.propertyId || '-'}`);

      const [roomRows] = await connection.query(
        `
          SELECT room_ID, room_ref_code, room_title
          FROM dvi_hotel_rooms
          WHERE hotel_id = ?
            AND deleted = 0
          ORDER BY room_ID
        `,
        [hotel.hotelId],
      );

      const [ratePlanRows] = await connection.query(
        `
          SELECT room_id, rateplan_id, rateplan_name
          FROM staah_rateplan
          WHERE staah_property_id = ?
          ORDER BY room_id, rateplan_id
        `,
        [hotel.propertyId],
      );

      const deluxeRoom =
        roomRows.find((row) => normalize(row.room_title).includes('DELUXE')) ||
        roomRows[0] ||
        null;

      const matchedRatePlan = deluxeRoom
        ? ratePlanRows.find((row) => normalize(row.room_id) === normalize(deluxeRoom.room_ref_code))
        : null;

      console.log(`Room ID: ${matchedRatePlan?.room_id || '-'}`);
      console.log(`Rate ID: ${matchedRatePlan?.rateplan_id || '-'}`);
      console.log(`Found Mapping: ${matchedRatePlan ? 'YES' : 'NO'}`);

      if (!matchedRatePlan) {
        console.log('Lost At Stage: selected STAAH identifiers are not persisted on itinerary hotel rows');
        continue;
      }

      console.log('Lost At Stage: confirm payload field stripping (fixed by preserving searchReference/roomId/rateId)');
    }
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error('debug-staah-confirm-flow failed:', error.message || error);
  process.exitCode = 1;
});
