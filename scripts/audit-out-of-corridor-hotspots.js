require('dotenv').config();
const mysql = require('mysql2/promise');

const PLAN_ID = Number(process.argv[2] || 418);
const DAY_NO = Number(process.argv[3] || 4);
const HOTSPOT_ID = Number(process.argv[4] || 592);

function parseDbUrl(url) {
  const match = String(url || '').match(/mysql:\/\/([^:]+):([^@]+)@([^:@/]+):(\d+)\/([^?]+)/);
  if (!match) {
    throw new Error('DATABASE_URL not set or not a valid mysql:// URL');
  }

  return {
    host: match[3],
    port: Number(match[4]),
    user: decodeURIComponent(match[1]),
    password: decodeURIComponent(match[2]),
    database: match[5],
  };
}

async function main() {
  const connection = await mysql.createConnection(parseDbUrl(process.env.DATABASE_URL));

  const [rows] = await connection.query(
    `
      SELECT
        r.itinerary_route_ID,
        r.no_of_days,
        r.location_name,
        r.next_visiting_location,
        rh.route_hotspot_ID,
        rh.hotspot_ID,
        hp.hotspot_name,
        hp.hotspot_location,
        hp.hotspot_to_location,
        rh.hotspot_order,
        rh.item_type,
        rh.deleted,
        rh.status
      FROM dvi_itinerary_route_details r
      JOIN dvi_itinerary_route_hotspot_details rh
        ON rh.itinerary_route_ID = r.itinerary_route_ID
      JOIN dvi_hotspot_place hp
        ON hp.hotspot_ID = rh.hotspot_ID
      WHERE r.itinerary_plan_ID = ?
        AND r.no_of_days = ?
        AND r.deleted = 0
        AND rh.deleted = 0
      ORDER BY rh.hotspot_order, rh.item_type
    `,
    [PLAN_ID, DAY_NO],
  );

  const offendingRows = rows.filter((row) => Number(row.hotspot_ID) === HOTSPOT_ID);

  console.log('[AuditOutOfCorridorHotspots] summary', {
    planId: PLAN_ID,
    dayNo: DAY_NO,
    hotspotId: HOTSPOT_ID,
    totalActiveRows: rows.length,
    offendingRowCount: offendingRows.length,
  });

  if (rows.length > 0) {
    console.table(
      rows.map((row) => ({
        routeId: Number(row.itinerary_route_ID),
        day: Number(row.no_of_days),
        route: `${row.location_name} -> ${row.next_visiting_location}`,
        hotspotId: Number(row.hotspot_ID),
        hotspotName: row.hotspot_name,
        hotspotLocation: row.hotspot_location,
        hotspotToLocation: row.hotspot_to_location,
        order: Number(row.hotspot_order),
        itemType: Number(row.item_type),
      })),
    );
  }

  if (offendingRows.length > 0) {
    console.error(
      `[FAIL] Active out-of-corridor row still exists for hotspot_ID=${HOTSPOT_ID} on plan ${PLAN_ID} day ${DAY_NO}.`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `[PASS] No active route-hotspot row exists for hotspot_ID=${HOTSPOT_ID} on plan ${PLAN_ID} day ${DAY_NO}.`,
    );
  }

  await connection.end();
}

main().catch((error) => {
  console.error('[AuditOutOfCorridorHotspots] failed:', error?.stack || error?.message || String(error));
  process.exit(1);
});
