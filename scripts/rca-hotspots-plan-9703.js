require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const mysql = require('mysql2/promise');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const { normalizeCityName } = require('../src/modules/itineraries/utils/city-normalization.util.ts');

const PLAN_ID = Number(process.env.PLAN_ID || 9703);

function parseMysqlUrl(url) {
  const normalized = String(url || '').replace(/^mysql:\/\//i, 'http://');
  const parsed = new URL(normalized);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ''),
  };
}

async function getColumns(conn, table) {
  const [rows] = await conn.query(`SHOW COLUMNS FROM ${table}`);
  return rows.map((row) => String(row.Field));
}

function pickExisting(columns, candidates) {
  for (const name of candidates) {
    if (columns.includes(name)) return name;
  }
  return null;
}

async function main() {
  const conn = await mysql.createConnection(parseMysqlUrl(process.env.DATABASE_URL));

  const routeHotspotColumns = await getColumns(conn, 'dvi_itinerary_route_hotspot_details');
  const routeHotspotIdCol = pickExisting(routeHotspotColumns, ['itinerary_route_hotspot_ID', 'route_hotspot_ID']);
  const routeHotspotOrderCol = pickExisting(routeHotspotColumns, ['route_hotspot_order', 'hotspot_order']);
  const routeHotspotDurationCol = pickExisting(routeHotspotColumns, ['hotspot_duration', 'hotspot_traveling_time']);

  console.log(`RCA for plan ${PLAN_ID}`);

  console.log('\n[A] Plan row');
  const [planRows] = await conn.query(
    `SELECT
      itinerary_plan_ID,
      itinerary_quote_ID,
      itinerary_preference,
      itinerary_type,
      location_id,
      arrival_location,
      departure_location,
      trip_start_date_and_time,
      trip_end_date_and_time,
      no_of_days,
      no_of_nights
    FROM dvi_itinerary_plan_details
    WHERE itinerary_plan_ID = ?`,
    [PLAN_ID],
  );
  console.log(JSON.stringify(planRows, null, 2));

  console.log('\n[B] Route rows');
  const [routeRows] = await conn.query(
    `SELECT
      itinerary_route_ID,
      itinerary_plan_ID,
      itinerary_route_date,
      no_of_days,
      location_id,
      location_name,
      next_visiting_location,
      direct_to_next_visiting_place,
      no_of_km,
      status,
      deleted
    FROM dvi_itinerary_route_details
    WHERE itinerary_plan_ID = ?
    ORDER BY itinerary_route_date, itinerary_route_ID`,
    [PLAN_ID],
  );
  console.log(JSON.stringify(routeRows, null, 2));

  console.log('\n[C] Route-hotspot rows');
  const [routeHotspotRows] = await conn.query(
    `SELECT
      ${routeHotspotIdCol} AS itinerary_route_hotspot_ID,
      itinerary_plan_ID,
      itinerary_route_ID,
      hotspot_ID,
      ${routeHotspotOrderCol} AS route_hotspot_order,
      ${routeHotspotDurationCol} AS hotspot_duration,
      item_type,
      deleted,
      status
    FROM dvi_itinerary_route_hotspot_details
    WHERE itinerary_plan_ID = ?
    ORDER BY itinerary_route_ID, ${routeHotspotOrderCol}, ${routeHotspotIdCol}`,
    [PLAN_ID],
  );
  console.log(JSON.stringify(routeHotspotRows, null, 2));

  console.log('\n[D] Stored location lookup candidates');
  const locationTerms = [
    'Bangalore',
    'Bengaluru',
    'Bangalore International Airport',
    'Tirupathi',
    'Tirupati',
    'Tirupati Airport',
  ];
  for (const term of locationTerms) {
    const like = `%${term}%`;
    const [rows] = await conn.query(
      `SELECT
        location_ID,
        source_location,
        destination_location,
        source_location_city AS source_city,
        destination_location_city AS destination_city,
        status,
        deleted
      FROM dvi_stored_locations
      WHERE
        source_location LIKE ?
        OR destination_location LIKE ?
        OR source_location_city LIKE ?
        OR destination_location_city LIKE ?
      ORDER BY location_ID DESC
      LIMIT 25`,
      [like, like, like, like],
    );
    console.log(`TERM=${term}`);
    console.log(JSON.stringify(rows, null, 2));
  }

  console.log('\n[E] Hotspot master candidates');
  const [hotspotMasterRows] = await conn.query(
    `SELECT
      hotspot_ID,
      hotspot_name,
      hotspot_location,
      hotspot_priority,
      hotspot_duration,
      status,
      deleted
    FROM dvi_hotspot_place
    WHERE deleted = 0
      AND status = 1
      AND (
        hotspot_location LIKE '%Tirupati%'
        OR hotspot_location LIKE '%Tirupathi%'
        OR hotspot_location LIKE '%Bangalore%'
        OR hotspot_location LIKE '%Bengaluru%'
      )
    ORDER BY hotspot_location, hotspot_priority, hotspot_ID`,
  );
  console.log(JSON.stringify(hotspotMasterRows, null, 2));

  console.log('\n[F] Spelling / alias normalization');
  const aliasSamples = [
    'Tirupathi',
    'Tirupati',
    'Bangalore, International Airport',
    'Bangalore',
    'Bengaluru',
  ];
  console.log(
    JSON.stringify(
      aliasSamples.map((value) => ({
        input: value,
        normalized: normalizeCityName(value),
      })),
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        'tirupathi -> tirupati': normalizeCityName('tirupathi') === 'tirupati',
        'tirupathy -> tirupati': normalizeCityName('tirupathy') === 'tirupati',
        'bangalore -> bengaluru': normalizeCityName('bangalore') === 'bengaluru',
      },
      null,
      2,
    ),
  );

  await conn.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
