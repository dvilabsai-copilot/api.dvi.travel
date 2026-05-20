#!/usr/bin/env node

require('dotenv').config();
const mysql = require('mysql2/promise');

function normalizeQuoteId(value) {
  return String(value || process.argv[2] || 'DVI202604247').trim();
}

function toHm(dateLike) {
  if (!dateLike) return 'N/A';
  const d = new Date(dateLike);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

async function main() {
  const quoteId = normalizeQuoteId(process.env.QUOTE_ID);

  const match = String(process.env.DATABASE_URL || '').match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  if (!match) {
    throw new Error('Invalid DATABASE_URL');
  }

  const conn = await mysql.createConnection({
    host: match[3],
    port: Number(match[4]),
    user: decodeURIComponent(match[1]),
    password: decodeURIComponent(match[2]),
    database: match[5],
  });

  const [planRows] = await conn.query(
    `SELECT itinerary_plan_ID, itinerary_quote_ID, createdon
     FROM dvi_itinerary_plan_details
     WHERE itinerary_quote_ID = ? AND deleted = 0
     ORDER BY itinerary_plan_ID DESC
     LIMIT 1`,
    [quoteId],
  );
  const plan = planRows[0] || null;

  if (!plan) {
    throw new Error(`Plan not found for quote ${quoteId}`);
  }

  console.log('=== Plan ===');
  console.table([plan]);

  const [routes] = await conn.query(
    `SELECT itinerary_route_ID, location_name, next_visiting_location, itinerary_route_date,
            route_start_time, route_end_time, excluded_hotspot_ids
     FROM dvi_itinerary_route_details
     WHERE itinerary_plan_ID = ? AND deleted = 0
     ORDER BY itinerary_route_date ASC, itinerary_route_ID ASC`,
    [Number(plan.itinerary_plan_ID)],
  );

  console.log('\n=== Routes ===');
  console.table(routes.map((route) => ({
    routeId: Number(route.itinerary_route_ID),
    date: route.itinerary_route_date,
    from: String(route.location_name || '').split('|')[0]?.trim() || '',
    to: String(route.next_visiting_location || '').split('|')[0]?.trim() || '',
    start: toHm(route.route_start_time),
    end: toHm(route.route_end_time),
    excludedCount: Array.isArray(route.excluded_hotspot_ids) ? route.excluded_hotspot_ids.length : 0,
  })));

  const routeIds = routes.map((route) => Number(route.itinerary_route_ID)).filter((id) => id > 0);
  const [hotspotRows] = routeIds.length > 0
    ? await conn.query(
        `SELECT itinerary_route_ID, route_hotspot_ID, hotspot_ID, hotspot_order,
                hotspot_plan_own_way, hotspot_start_time, hotspot_end_time
         FROM dvi_itinerary_route_hotspot_details
         WHERE itinerary_plan_ID = ? AND item_type = 4 AND deleted = 0
           AND itinerary_route_ID IN (${routeIds.map(() => '?').join(',')})
         ORDER BY itinerary_route_ID ASC, hotspot_order ASC, route_hotspot_ID ASC`,
        [Number(plan.itinerary_plan_ID), ...routeIds],
      )
    : [[]];

  const hotspotIds = Array.from(new Set(hotspotRows.map((row) => Number(row.hotspot_ID || 0)).filter((id) => id > 0)));
  const [hotspotMasters] = hotspotIds.length > 0
    ? await conn.query(
        `SELECT hotspot_ID, hotspot_name, hotspot_priority, hotspot_location
         FROM dvi_hotspot_place
         WHERE hotspot_ID IN (${hotspotIds.map(() => '?').join(',')})`,
        hotspotIds,
      )
    : [[]];
  const masterMap = new Map(hotspotMasters.map((row) => [Number(row.hotspot_ID), row]));

  console.log('\n=== Route Hotspots ===');
  console.table(hotspotRows.map((row) => {
    const master = masterMap.get(Number(row.hotspot_ID || 0));
    return {
      routeId: Number(row.itinerary_route_ID || 0),
      order: Number(row.hotspot_order || 0),
      hotspotId: Number(row.hotspot_ID || 0),
      name: master?.hotspot_name || 'Unknown',
      priority: Number(master?.hotspot_priority || 0),
      manual: Number(row.hotspot_plan_own_way || 0) === 1,
      start: toHm(row.hotspot_start_time),
      end: toHm(row.hotspot_end_time),
    };
  }));

  await conn.end();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Connection is created inside main and closed there after all queries complete.
  });