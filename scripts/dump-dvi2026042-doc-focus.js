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

function printSection(title) {
  console.log('');
  console.log(title);
  console.log('-'.repeat(title.length));
}

function trimText(value) {
  return String(value ?? '').trim();
}

function hasValue(value) {
  return trimText(value).length > 0;
}

async function resolvePlanId(connection, quoteId, explicitPlanId) {
  if (quoteId) {
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

  if (explicitPlanId) {
    return Number(explicitPlanId);
  }

  throw new Error('Provide QUOTE_ID or PLAN_ID.');
}

async function fetchSingleRow(connection, sql, params) {
  const [rows] = await connection.query(sql, params);
  return rows;
}

async function main() {
  const cliArgs = process.argv.slice(2);
  const defaultQuoteId = 'DVI2026042';
  const defaultPlanId = '48';

  const quoteInput = getEnvOrArg(['QUOTE_ID', 'ITINERARY_QUOTE_ID'], cliArgs) || defaultQuoteId;
  const planInput = getEnvOrArg(['PLAN_ID', 'ITINERARY_PLAN_ID'], cliArgs) || defaultPlanId;
  const planFromArg = isNumericId(planInput) ? Number(planInput) : null;

  const connection = await mysql.createConnection(resolveDbConfig());

  try {
    const resolvedPlanId = await resolvePlanId(connection, quoteInput, planFromArg);
    const [planRows] = await connection.query(
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

    printSection('A. Full Route List');
    const [routeRows] = await connection.query(
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
        ) vr
          ON vr.itinerary_route_ID = r.itinerary_route_ID
        WHERE r.itinerary_plan_ID = ?
          AND r.deleted = 0
          AND r.status = 1
        ORDER BY r.itinerary_route_date, r.itinerary_route_ID;
      `,
      [resolvedPlanId],
    );
    console.table(routeRows);

    const focusRouteIds = [3422, 3424, 3426];

    printSection('B. Via Route Evidence');
    for (const routeId of focusRouteIds) {
      const route = routeRows.find((item) => Number(item.itinerary_route_ID) === routeId);
      console.log('');
      console.log(`Route ${routeId}`);
      if (!route) {
        console.log('Route not found.');
        continue;
      }

      console.log(`Day: ${route.no_of_days}`);
      console.log(`Source: ${route.location_name}`);
      console.log(`Destination: ${route.next_visiting_location}`);
      console.log(`Direct flag: ${route.direct_to_next_visiting_place}`);
      console.log(`via_route: ${route.via_route || ''}`);

      const [timelineRows] = await connection.query(
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
            h.allow_via_route,
            h.via_location_name,
            h.hotspot_plan_own_way,
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
            AND r.itinerary_route_ID = ?
            AND r.deleted = 0
            AND r.status = 1
          ORDER BY h.hotspot_order, h.route_hotspot_ID;
        `,
        [resolvedPlanId, routeId],
      );

      console.table(timelineRows.map((row) => ({
        itinerary_route_ID: row.itinerary_route_ID,
        hotspot_order: row.hotspot_order,
        item_type: row.item_type,
        hotspot_ID: row.hotspot_ID,
        hotspot_name: row.hotspot_name,
        hotspot_location: row.hotspot_location,
        hotspot_to_location: row.hotspot_to_location,
        hotspot_priority: row.hotspot_priority,
        hotspot_start_time: row.hotspot_start_time,
        hotspot_end_time: row.hotspot_end_time,
        allow_via_route: row.allow_via_route,
        via_location_name: row.via_location_name,
        hotspot_plan_own_way: row.hotspot_plan_own_way,
      })));
    }

    printSection('C. Manual Hotspot Evidence');
    const [manualHotspots] = await connection.query(
      `
        SELECT
          r.itinerary_route_ID,
          r.itinerary_route_date,
          r.no_of_days,
          r.location_name,
          r.next_visiting_location,
          r.direct_to_next_visiting_place,
          h.route_hotspot_ID,
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
        JOIN dvi_itinerary_route_hotspot_details h
          ON h.itinerary_route_ID = r.itinerary_route_ID
          AND h.deleted = 0
          AND h.status = 1
        LEFT JOIN dvi_hotspot_place hp
          ON hp.hotspot_ID = h.hotspot_ID
        WHERE r.itinerary_plan_ID = ?
          AND r.deleted = 0
          AND r.status = 1
          AND h.hotspot_plan_own_way = 1
        ORDER BY r.itinerary_route_date, r.itinerary_route_ID, h.hotspot_order, h.route_hotspot_ID;
      `,
      [resolvedPlanId],
    );
    console.table(manualHotspots);

    printSection('D. Route-wise Item Type Counts');
    const [itemTypeCounts] = await connection.query(
      `
        SELECT
          r.itinerary_route_ID,
          r.itinerary_route_date,
          h.item_type,
          COUNT(*) AS row_count
        FROM dvi_itinerary_route_details r
        JOIN dvi_itinerary_route_hotspot_details h
          ON h.itinerary_route_ID = r.itinerary_route_ID
          AND h.deleted = 0
          AND h.status = 1
        WHERE r.itinerary_plan_ID = ?
          AND r.deleted = 0
          AND r.status = 1
        GROUP BY r.itinerary_route_ID, r.itinerary_route_date, h.item_type
        ORDER BY r.itinerary_route_date, r.itinerary_route_ID, h.item_type;
      `,
      [resolvedPlanId],
    );
    console.table(itemTypeCounts);

    printSection('E. Timeline Row Summary');
    const [summaryRows] = await connection.query(
      `
        SELECT
          r.itinerary_route_ID,
          r.itinerary_route_date,
          COUNT(h.route_hotspot_ID) AS total_rows,
          SUM(CASE WHEN h.item_type = 4 THEN 1 ELSE 0 END) AS attraction_row_count,
          SUM(CASE WHEN h.item_type = 1 THEN 1 ELSE 0 END) AS travel_or_start_row_count,
          SUM(CASE WHEN h.item_type = 3 THEN 1 ELSE 0 END) AS travel_row_count,
          SUM(CASE WHEN h.item_type = 5 THEN 1 ELSE 0 END) AS hotel_row_count,
          SUM(CASE WHEN h.item_type = 6 THEN 1 ELSE 0 END) AS checkin_row_count,
          MAX(CASE WHEN h.hotspot_plan_own_way = 1 THEN 1 ELSE 0 END) AS has_manual_row,
          MAX(CASE WHEN COALESCE(vr.via_route, '') <> '' THEN 1 ELSE 0 END) AS has_via_row
        FROM dvi_itinerary_route_details r
        LEFT JOIN dvi_itinerary_route_hotspot_details h
          ON h.itinerary_route_ID = r.itinerary_route_ID
          AND h.deleted = 0
          AND h.status = 1
        LEFT JOIN (
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
        ) vr
          ON vr.itinerary_route_ID = r.itinerary_route_ID
        WHERE r.itinerary_plan_ID = ?
          AND r.deleted = 0
          AND r.status = 1
        GROUP BY r.itinerary_route_ID, r.itinerary_route_date
        ORDER BY r.itinerary_route_date, r.itinerary_route_ID;
      `,
      [resolvedPlanId],
    );
    console.table(summaryRows.map((row) => ({
      itinerary_route_ID: row.itinerary_route_ID,
      itinerary_route_date: row.itinerary_route_date,
      total_rows: row.total_rows,
      attraction_row_count: row.attraction_row_count,
      travel_row_count: row.travel_row_count,
      checkin_row_count: row.checkin_row_count,
      hotel_row_count: row.hotel_row_count,
      has_manual_row: Number(row.has_manual_row || 0) === 1 ? 'yes' : 'no',
      has_via_row: Number(row.has_via_row || 0) === 1 ? 'yes' : 'no',
    })));

    printSection('F. Details API Reminder');
    console.log(`node scripts/trigger_itin_details.js ${quoteInput || 'DVI2026042'}`);

    console.log('');
    console.log('Resolved identifiers:');
    console.log(`QUOTE_ID=${quoteInput || 'DVI2026042'}`);
    console.log(`PLAN_ID=${resolvedPlanId}`);

    if (planRows.length) {
      console.log('');
      console.log('Plan header snapshot:');
      console.table(planRows);
    }
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
