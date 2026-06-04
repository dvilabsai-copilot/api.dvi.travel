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

function formatValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function formatRouteLine(route, index) {
  return `Day ${index + 1}: ${formatValue(route.location_name)} -> ${formatValue(route.next_visiting_location)} direct=${formatValue(route.direct_to_next_visiting_place ?? 0)} via=${formatValue(route.via_route)}`;
}

async function main() {
  const connection = await mysql.createConnection(resolveDbConfig());

  try {
    const candidateSql = `
      SELECT
        p.itinerary_plan_ID,
        p.itinerary_quote_ID AS quote_id,
        COUNT(r.itinerary_route_ID) AS route_count,
        COUNT(DISTINCT DATE(r.itinerary_route_date)) AS route_day_count,
        COUNT(DISTINCT TRIM(r.location_name)) AS distinct_source_city_count,
        COUNT(DISTINCT TRIM(r.next_visiting_location)) AS distinct_destination_city_count,
        GROUP_CONCAT(
          CONCAT(
            'Day ', COALESCE(r.no_of_days, ''),
            ': ',
            COALESCE(r.location_name, ''),
            ' -> ',
            COALESCE(r.next_visiting_location, ''),
            ' direct=',
            COALESCE(r.direct_to_next_visiting_place, 0)
          )
          ORDER BY r.itinerary_route_date, r.itinerary_route_ID
          SEPARATOR ' | '
        ) AS route_summary
      FROM dvi_itinerary_plan_details p
      JOIN dvi_itinerary_route_details r
        ON r.itinerary_plan_ID = p.itinerary_plan_ID
        AND r.deleted = 0
        AND r.status = 1
      WHERE p.deleted = 0
        AND p.status = 1
      GROUP BY
        p.itinerary_plan_ID,
        p.itinerary_quote_ID
      HAVING route_count >= 10
         AND route_day_count >= 10
         AND (
           distinct_source_city_count >= 5
           OR distinct_destination_city_count >= 5
         )
      ORDER BY
        route_day_count DESC,
        distinct_destination_city_count DESC,
        p.itinerary_plan_ID DESC
      LIMIT 10;
    `;

    const [candidates] = await connection.query(candidateSql);

    console.log('Top 10 candidates:');
    if (candidates.length) {
      console.table(candidates.map((candidate, index) => ({
        rank: index + 1,
        itinerary_plan_ID: candidate.itinerary_plan_ID,
        quote_id: candidate.quote_id,
        route_count: candidate.route_count,
        route_day_count: candidate.route_day_count,
        distinct_source_city_count: candidate.distinct_source_city_count,
        distinct_destination_city_count: candidate.distinct_destination_city_count,
      })));
    } else {
      console.log('(no candidates found)');
    }

    if (!candidates.length) {
      console.log('\nNo matching itinerary found.');
      return;
    }

    const best = candidates[0];
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
          GROUP_CONCAT(itinerary_via_location_name ORDER BY itinerary_via_route_ID SEPARATOR ' -> ') AS via_route
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
      [best.itinerary_plan_ID],
    );

    console.log('\nBest matching itinerary:');
    console.log(`Plan ID: ${best.itinerary_plan_ID}`);
    console.log(`Quote ID: ${best.quote_id}`);
    console.log(`Route count: ${best.route_count}`);
    console.log(`Route day count: ${best.route_day_count}`);
    console.log(`Distinct source cities: ${best.distinct_source_city_count}`);
    console.log(`Distinct destination cities: ${best.distinct_destination_city_count}`);

    console.log('\nRoute rows:');
    console.table(routeRows);

    console.log('\nRoutes:');
    routeRows.forEach((route, index) => {
      console.log(formatRouteLine(route, index));
    });

    console.log('\nUse this quote for docs/testing:');
    console.log(`QUOTE_ID=${best.quote_id}`);
    console.log(`PLAN_ID=${best.itinerary_plan_ID}`);
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
