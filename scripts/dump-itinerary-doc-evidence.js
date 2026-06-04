const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');

function loadEnvIfPresent(envPath) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
}

loadEnvIfPresent(path.resolve(__dirname, '..', '.env'));
loadEnvIfPresent(path.resolve(process.cwd(), '.env'));

function resolveDbConfig() {
  const databaseUrl = process.env.DATABASE_URL || process.env.MYSQL_URL || '';
  const parsedDatabaseUrl = databaseUrl ? new URL(databaseUrl) : null;

  const host = process.env.DB_HOST || parsedDatabaseUrl?.hostname || 'localhost';
  const port = Number.parseInt(process.env.DB_PORT || parsedDatabaseUrl?.port || '3306', 10);
  const user = process.env.DB_USERNAME || process.env.DB_USER || decodeURIComponent(parsedDatabaseUrl?.username || '');
  const password = process.env.DB_PASSWORD || process.env.DB_PASS || decodeURIComponent(parsedDatabaseUrl?.password || '');
  const database = process.env.DB_DATABASE || process.env.DB_NAME || parsedDatabaseUrl?.pathname?.replace(/^\//, '') || '';

  if (!user) {
    throw new Error('Missing required DB env value: DB_USERNAME or DB_USER');
  }
  if (!password) {
    throw new Error('Missing required DB env value: DB_PASSWORD');
  }
  if (!database) {
    throw new Error('Missing required DB env value: DB_DATABASE or DB_NAME');
  }
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid DB_PORT value: ${process.env.DB_PORT}`);
  }

  return {
    host,
    port,
    user,
    password,
    database,
    dateStrings: true,
  };
}

function getEnvOrArg(keys, cliArgs) {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && String(value).trim() !== '') {
      return String(value).trim();
    }
  }

  const positional = cliArgs.find((value) => value && !value.startsWith('-'));
  return positional ? String(positional).trim() : '';
}

function isNumericId(value) {
  return /^\d+$/.test(String(value || '').trim());
}

function formatValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function printSection(title) {
  console.log('');
  console.log(title);
  console.log('-'.repeat(title.length));
}

function trimText(value) {
  return String(value ?? '').trim();
}

function buildViaRouteSubquery() {
  return `
    SELECT
      itinerary_route_ID,
      GROUP_CONCAT(
        NULLIF(TRIM(itinerary_via_location_name), '')
        ORDER BY itinerary_via_route_ID
        SEPARATOR ' -> '
      ) AS via_route
    FROM dvi_itinerary_via_route_details
    WHERE deleted = 0
      AND status = 1
    GROUP BY itinerary_route_ID
  `;
}

async function resolvePlanId(connection, quoteId, explicitPlanId) {
  if (!quoteId && explicitPlanId) {
    return Number(explicitPlanId);
  }

  if (!quoteId) {
    if (explicitPlanId) {
      return Number(explicitPlanId);
    }
    throw new Error('Provide QUOTE_ID or PLAN_ID.');
  }

  const [rows] = await connection.query(
    `
      SELECT itinerary_plan_ID
      FROM dvi_itinerary_plan_details
      WHERE itinerary_quote_ID = ?
        AND deleted = 0
      ORDER BY itinerary_plan_ID DESC
      LIMIT 1
    `,
    [quoteId],
  );

  if (!rows.length) {
    throw new Error(`No itinerary plan found for QUOTE_ID=${quoteId}`);
  }

  return Number(rows[0].itinerary_plan_ID);
}

async function main() {
  const cliArgs = process.argv.slice(2);
  const quoteId = getEnvOrArg(['QUOTE_ID', 'ITINERARY_QUOTE_ID'], cliArgs);
  const planIdRaw = getEnvOrArg(['PLAN_ID', 'ITINERARY_PLAN_ID'], cliArgs);
  const planId = isNumericId(planIdRaw) ? Number(planIdRaw) : null;
  const resolvedQuoteId = quoteId || (isNumericId(planIdRaw) ? '' : planIdRaw);

  const connection = await mysql.createConnection(resolveDbConfig());

  try {
    const resolvedPlanId = await resolvePlanId(connection, resolvedQuoteId, planId);

    printSection('A. Plan Header');
    try {
      const [rows] = await connection.query(
        `
          SELECT
            itinerary_plan_ID,
            itinerary_quote_ID AS quote_id,
            agent_id,
            staff_id,
            arrival_location,
            departure_location,
            trip_start_date_and_time AS trip_start_date,
            trip_end_date_and_time AS trip_end_date,
            trip_start_date_and_time,
            trip_end_date_and_time,
            total_adult,
            total_children,
            total_infants,
            itinerary_preference,
            arrival_type,
            departure_type,
            status,
            deleted
          FROM dvi_itinerary_plan_details
          WHERE itinerary_plan_ID = ?;
        `,
        [resolvedPlanId],
      );
      console.table(rows);
    } catch (error) {
      console.warn(`Plan header query failed: ${error.message}`);
    }

    printSection('B. Routes');
    let routes = [];
    try {
      const [rows] = await connection.query(
        `
          SELECT
            r.itinerary_route_ID,
            r.itinerary_plan_ID,
            r.itinerary_route_date,
            r.no_of_days,
            r.location_name,
            r.next_visiting_location,
            r.direct_to_next_visiting_place,
            COALESCE(vr.via_route, '') AS via_route,
            r.route_start_time,
            r.route_end_time,
            r.no_of_km,
            r.location_id,
            r.status,
            r.deleted
          FROM dvi_itinerary_route_details r
          LEFT JOIN (
            ${buildViaRouteSubquery()}
          ) vr
            ON vr.itinerary_route_ID = r.itinerary_route_ID
          WHERE r.itinerary_plan_ID = ?
            AND r.deleted = 0
            AND r.status = 1
          ORDER BY r.itinerary_route_date, r.itinerary_route_ID;
        `,
        [resolvedPlanId],
      );
      routes = rows;
      console.table(rows);
    } catch (error) {
      console.warn(`Routes query failed: ${error.message}`);
    }

    printSection('C. Timeline Rows');
    let timelineRows = [];
    try {
      const [rows] = await connection.query(
        `
          SELECT
            r.itinerary_route_ID,
            r.no_of_days,
            r.location_name,
            r.next_visiting_location,
            r.direct_to_next_visiting_place,
            h.hotspot_order,
            h.item_type,
            h.hotspot_ID,
            hp.hotspot_name,
            hp.hotspot_location,
            hp.hotspot_to_location,
            hp.hotspot_priority,
            h.hotspot_start_time,
            h.hotspot_end_time,
            h.hotspot_traveling_time,
            h.hotspot_travelling_distance,
            h.hotspot_plan_own_way,
            h.allow_via_route,
            h.via_location_name,
            h.status,
            h.deleted
          FROM dvi_itinerary_route_details r
          LEFT JOIN dvi_itinerary_route_hotspot_details h
            ON h.itinerary_route_ID = r.itinerary_route_ID
            AND h.deleted = 0
            AND h.status = 1
          LEFT JOIN dvi_hotspot_place hp
            ON hp.hotspot_ID = h.hotspot_ID
          WHERE r.itinerary_plan_ID = ?
            AND r.deleted = 0
            AND r.status = 1
          ORDER BY r.itinerary_route_date, r.itinerary_route_ID, h.hotspot_order;
        `,
        [resolvedPlanId],
      );
      timelineRows = rows;
      console.table(rows);
    } catch (error) {
      console.warn(`Timeline rows query failed: ${error.message}`);
    }

    printSection('D. Item Type Counts');
    let itemTypeCounts = [];
    try {
      const [rows] = await connection.query(
        `
          SELECT
            item_type,
            COUNT(*) AS row_count
          FROM dvi_itinerary_route_hotspot_details
          WHERE itinerary_plan_ID = ?
            AND deleted = 0
            AND status = 1
          GROUP BY item_type
          ORDER BY item_type;
        `,
        [resolvedPlanId],
      );
      itemTypeCounts = rows;
      console.table(rows);
    } catch (error) {
      console.warn(`Item type counts query failed: ${error.message}`);
    }

    printSection('E. Hotel Rows');
    try {
      const [rows] = await connection.query(
        `
          SELECT
            itinerary_plan_hotel_details_ID,
            itinerary_plan_id,
            itinerary_route_id,
            itinerary_route_date,
            hotel_id,
            hotel_required,
            group_type,
            hotel_cancellation_status,
            status,
            deleted
          FROM dvi_itinerary_plan_hotel_details
          WHERE itinerary_plan_id = ?
          ORDER BY itinerary_route_date, itinerary_route_id, group_type;
        `,
        [resolvedPlanId],
      );
      console.table(rows);
    } catch (error) {
      console.warn(`Hotel rows query failed: ${error.message}`);
    }

    printSection('F. Vehicle Rows');
    try {
      const [rows] = await connection.query(
        `
          SELECT *
          FROM dvi_itinerary_plan_vendor_vehicle_details
          WHERE itinerary_plan_id = ?
          ORDER BY itinerary_route_date, itinerary_route_id, vehicle_type_id
          LIMIT 200;
        `,
        [resolvedPlanId],
      );
      console.table(rows);
    } catch (error) {
      console.warn(`Vehicle rows query warning: ${error.message}`);
    }

    printSection('G. Summary');
    const totalRoutes = routes.length;
    const totalTimelineRows = timelineRows.length;
    const directRoutes = routes.filter((route) => Number(route.direct_to_next_visiting_place || 0) === 1).map((route) => route.itinerary_route_ID);
    const viaRoutes = routes.filter((route) => trimText(route.via_route).length > 0).map((route) => route.itinerary_route_ID);
    const manualHotspotRowCount = timelineRows.filter((row) => Number(row.hotspot_plan_own_way || 0) === 1).length;
    const routesWithAttractionCounts = new Map();

    for (const row of timelineRows) {
      const routeId = Number(row.itinerary_route_ID || 0);
      if (!routesWithAttractionCounts.has(routeId)) {
        routesWithAttractionCounts.set(routeId, 0);
      }
      if (Number(row.item_type || 0) === 4) {
        routesWithAttractionCounts.set(routeId, routesWithAttractionCounts.get(routeId) + 1);
      }
    }

    const zeroAttractionRouteIds = routes
      .map((route) => Number(route.itinerary_route_ID))
      .filter((routeId) => (routesWithAttractionCounts.get(routeId) || 0) === 0);

    console.log(`QUOTE_ID=${resolvedQuoteId || ''}`);
    console.log(`PLAN_ID=${resolvedPlanId}`);
    console.log(`Total routes: ${totalRoutes}`);
    console.log(`Total timeline rows: ${totalTimelineRows}`);
    console.log('Item type counts:', itemTypeCounts);
    console.log(`Routes with direct_to_next_visiting_place = 1: ${directRoutes.length ? directRoutes.join(', ') : '(none)'}`);
    console.log(`Routes with via_route not empty: ${viaRoutes.length ? viaRoutes.join(', ') : '(none)'}`);
    console.log(`Manual hotspot row count where hotspot_plan_own_way = 1: ${manualHotspotRowCount}`);
    console.log(`Route IDs with zero item_type=4 attraction rows: ${zeroAttractionRouteIds.length ? zeroAttractionRouteIds.join(', ') : '(none)'}`);
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
