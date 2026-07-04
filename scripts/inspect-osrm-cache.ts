import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type Args = {
  fromHotspotId?: number;
  toHotspotId?: number;
  fromKey?: string;
  toKey?: string;
  limit: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { limit: 10 };

  for (let i = 0; i < argv.length; i += 1) {
    const key = String(argv[i] || '').trim();
    const value = String(argv[i + 1] || '').trim();

    if (key === '--fromHotspotId') {
      args.fromHotspotId = Number(value || 0) || undefined;
      i += 1;
    } else if (key === '--toHotspotId') {
      args.toHotspotId = Number(value || 0) || undefined;
      i += 1;
    } else if (key === '--fromKey') {
      args.fromKey = value || undefined;
      i += 1;
    } else if (key === '--toKey') {
      args.toKey = value || undefined;
      i += 1;
    } else if (key === '--limit') {
      args.limit = Math.max(1, Number(value || 10) || 10);
      i += 1;
    }
  }

  return args;
}

function normalize(value: any): any {
  return JSON.parse(
    JSON.stringify(value, (_key, innerValue) =>
      typeof innerValue === 'bigint' ? innerValue.toString() : innerValue,
    ),
  );
}

async function inspectHotspotRouteMatrix(args: Args) {
  const filters: string[] = [];
  const params: any[] = [];

  if (args.fromHotspotId && args.toHotspotId) {
    filters.push('((from_hotspot_id = ? AND to_hotspot_id = ?) OR (from_hotspot_id = ? AND to_hotspot_id = ?))');
    params.push(args.fromHotspotId, args.toHotspotId, args.toHotspotId, args.fromHotspotId);
  } else if (args.fromHotspotId) {
    filters.push('(from_hotspot_id = ? OR to_hotspot_id = ?)');
    params.push(args.fromHotspotId, args.fromHotspotId);
  } else if (args.toHotspotId) {
    filters.push('(from_hotspot_id = ? OR to_hotspot_id = ?)');
    params.push(args.toHotspotId, args.toHotspotId);
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = await prisma.$queryRawUnsafe(
    `
    SELECT
      from_hotspot_id,
      to_hotspot_id,
      osrm_distance_km,
      osrm_duration_min,
      LENGTH(route_coordinates) AS route_coordinates_length,
      process_status,
      error_message,
      updated_at
    FROM hotspot_route_matrix
    ${whereClause}
    ORDER BY updated_at DESC
    LIMIT ${Math.max(1, Number(args.limit || 10))}
    `,
    ...params,
  );

  const summary = await prisma.$queryRawUnsafe(
    `
    SELECT
      COUNT(*) AS total_rows,
      SUM(CASE WHEN process_status = 'DONE' THEN 1 ELSE 0 END) AS done_rows,
      SUM(CASE WHEN process_status = 'FAILED' THEN 1 ELSE 0 END) AS failed_rows
    FROM hotspot_route_matrix
    `,
  );

  return {
    summary: normalize(summary),
    rows: normalize(rows),
  };
}

async function inspectEndpointRouteMatrix(args: Args) {
  let tableExists = false;
  try {
    const tableCheck = await prisma.$queryRawUnsafe(
      `
      SELECT COUNT(*) AS count_rows
      FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name = 'endpoint_route_matrix'
      `,
    );
    const countRows = Number((tableCheck as any)?.[0]?.count_rows || 0);
    tableExists = countRows > 0;
  } catch {
    tableExists = false;
  }

  if (!tableExists) {
    return {
      summary: [{ total_rows: 0, done_rows: 0, failed_rows: 0 }],
      rows: [],
    };
  }

  const filters: string[] = [];
  const params: any[] = [];

  if (args.fromKey && args.toKey) {
    filters.push('((from_cache_key = ? AND to_cache_key = ?) OR (from_cache_key = ? AND to_cache_key = ?))');
    params.push(args.fromKey, args.toKey, args.toKey, args.fromKey);
  } else if (args.fromKey) {
    filters.push('(from_cache_key = ? OR to_cache_key = ?)');
    params.push(args.fromKey, args.fromKey);
  } else if (args.toKey) {
    filters.push('(from_cache_key = ? OR to_cache_key = ?)');
    params.push(args.toKey, args.toKey);
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = await prisma.$queryRawUnsafe(
    `
    SELECT
      from_cache_key,
      to_cache_key,
      osrm_distance_km,
      osrm_duration_min,
      LENGTH(route_coordinates) AS route_coordinates_length,
      process_status,
      error_message,
      updated_at
    FROM endpoint_route_matrix
    ${whereClause}
    ORDER BY updated_at DESC
    LIMIT ${Math.max(1, Number(args.limit || 10))}
    `,
    ...params,
  );

  const summary = await prisma.$queryRawUnsafe(
    `
    SELECT
      COUNT(*) AS total_rows,
      SUM(CASE WHEN process_status = 'DONE' THEN 1 ELSE 0 END) AS done_rows,
      SUM(CASE WHEN process_status = 'FAILED' THEN 1 ELSE 0 END) AS failed_rows
    FROM endpoint_route_matrix
    `,
  );

  return {
    summary: normalize(summary),
    rows: normalize(rows),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [hotspotRouteMatrix, endpointRouteMatrix] = await Promise.all([
    inspectHotspotRouteMatrix(args),
    inspectEndpointRouteMatrix(args),
  ]);

  console.log(JSON.stringify({
    args,
    hotspotRouteMatrix,
    endpointRouteMatrix,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
