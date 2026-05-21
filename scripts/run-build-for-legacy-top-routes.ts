import { PrismaClient } from '@prisma/client';
import { spawn } from 'node:child_process';

const prisma = new PrismaClient();

type LegacySegment = {
  fromName: string;
  toName: string;
  segmentCount: number;
};

type HotspotRow = {
  hotspot_ID: number;
  hotspot_name: string | null;
  hotspot_latitude: string | null;
  hotspot_longitude: string | null;
};

type ResolvedHotspot = {
  inputName: string;
  hotspot_ID: number;
  hotspot_name: string;
};

type ResolvedPair = {
  from: ResolvedHotspot;
  to: ResolvedHotspot;
  segmentCount: number;
};

const CITY_ALIAS_HOTSPOT_ID: Record<string, number> = {
  'munnar': 220,
  'thekkady': 670,
  'cochin': 740,
  'kochi': 740,
  'cochin airport': 740,
  'cochin international airport': 740,
  'alleppey': 254,
  'kovalam': 263,
  'trivandrum': 210,
  'trivandrum domestic airport': 210,
  'trivandrum international airport': 210,
  'trivandrum kerala india': 210,
  'thiruvananthapuram': 210,
  'coorg': 135,
  'ooty': 93,
  'pondicherry': 24,
  'bangalore': 108,
  'mysore': 120,
  'chennai': 7,
  'tirupati': 201,
  'wayanad': 239,
  'varkala': 215,
  'kodaikanal': 68,
  'coimbatore': 78,
  'kanyakumari': 505,
};

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(command: string, args: string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"');
}

function normalizeForCompare(input: string): string {
  return decodeHtmlEntities(input)
    .toLowerCase()
    .replace(/[^a-z0-9&]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(input: string): string[] {
  return normalizeForCompare(input)
    .split(' ')
    .filter((item) => item.length >= 3);
}

function safeMatches(inputName: string, rows: HotspotRow[]): HotspotRow[] {
  const inputNorm = normalizeForCompare(inputName);
  const inputTokens = tokenize(inputName);

  const exact = rows.filter((row) => normalizeForCompare(String(row.hotspot_name ?? '')) === inputNorm);
  if (exact.length > 0) {
    return exact;
  }

  const contains = rows.filter((row) => {
    const rowNorm = normalizeForCompare(String(row.hotspot_name ?? ''));
    return rowNorm.includes(inputNorm) || inputNorm.includes(rowNorm);
  });

  if (contains.length > 0) {
    return contains;
  }

  return rows.filter((row) => {
    const rowTokens = new Set(tokenize(String(row.hotspot_name ?? '')));
    if (!inputTokens.length) return false;
    const matched = inputTokens.filter((token) => rowTokens.has(token)).length;
    return matched >= Math.max(2, Math.floor(inputTokens.length * 0.6));
  });
}

function toResolved(inputName: string, row: HotspotRow): ResolvedHotspot {
  return {
    inputName,
    hotspot_ID: row.hotspot_ID,
    hotspot_name: row.hotspot_name ?? `Hotspot-${row.hotspot_ID}`,
  };
}

async function getTopLegacySegments(limit: number): Promise<LegacySegment[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ from_location: string; to_location: string; segment_count: bigint | number }>>(`
    SELECT
      TRIM(location_name) AS from_location,
      TRIM(next_visiting_location) AS to_location,
      COUNT(*) AS segment_count
    FROM dvi_travels.dvi_itinerary_route_details
    WHERE deleted = 0
      AND location_name IS NOT NULL
      AND next_visiting_location IS NOT NULL
      AND TRIM(location_name) <> ''
      AND TRIM(next_visiting_location) <> ''
    GROUP BY TRIM(location_name), TRIM(next_visiting_location)
    ORDER BY COUNT(*) DESC
    LIMIT ${limit}
  `);

  return rows.map((row) => ({
    fromName: row.from_location,
    toName: row.to_location,
    segmentCount: Number(row.segment_count),
  }));
}

async function main() {
  const topLimit = Number(process.env.LEGACY_TOP_ROUTE_LIMIT || '20');
  const osrmBaseUrl = (process.env.OSRM_BASE_URL || 'http://localhost:5000/route/v1/driving').toLowerCase();
  const isPublicOsrm = osrmBaseUrl.includes('router.project-osrm.org');
  const delayMs = isPublicOsrm ? 1200 : 200;

  if (!Number.isInteger(topLimit) || topLimit <= 0) {
    throw new Error('LEGACY_TOP_ROUTE_LIMIT must be a positive integer.');
  }

  const segments = await getTopLegacySegments(topLimit);
  const nonStaySegments = segments.filter((item) => normalizeForCompare(item.fromName) !== normalizeForCompare(item.toName));

  const hotspotRows = await prisma.dvi_hotspot_place.findMany({
    where: { deleted: 0 },
    select: {
      hotspot_ID: true,
      hotspot_name: true,
      hotspot_latitude: true,
      hotspot_longitude: true,
    },
    orderBy: { hotspot_ID: 'asc' },
  });

  const resolveCache = new Map<string, ResolvedHotspot>();
  const unresolvedNames = new Set<string>();
  const ambiguousNames: Array<{ inputName: string; matches: HotspotRow[] }> = [];

  const hotspotById = new Map<number, HotspotRow>();
  for (const row of hotspotRows) {
    hotspotById.set(row.hotspot_ID, row);
  }

  const tryAliasResolve = (inputName: string): ResolvedHotspot | null => {
    const norm = normalizeForCompare(inputName);
    for (const [alias, hotspotId] of Object.entries(CITY_ALIAS_HOTSPOT_ID)) {
      if (!norm.includes(alias)) continue;
      const row = hotspotById.get(hotspotId);
      if (!row) continue;
      return toResolved(inputName, row);
    }
    return null;
  };

  const resolveOne = (inputName: string): ResolvedHotspot | null => {
    const cache = resolveCache.get(inputName);
    if (cache) return cache;

    const aliasResolved = tryAliasResolve(inputName);
    if (aliasResolved) {
      resolveCache.set(inputName, aliasResolved);
      return aliasResolved;
    }

    const matches = safeMatches(inputName, hotspotRows);
    if (!matches.length) {
      unresolvedNames.add(inputName);
      return null;
    }

    if (matches.length > 1) {
      const preferred = matches.find((item) => {
        const name = normalizeForCompare(String(item.hotspot_name ?? ''));
        const input = normalizeForCompare(inputName);
        return name.includes(input) || input.includes(name);
      });

      if (preferred) {
        const resolved = toResolved(inputName, preferred);
        resolveCache.set(inputName, resolved);
        return resolved;
      }

      ambiguousNames.push({ inputName, matches });
      return null;
    }

    const resolved = toResolved(inputName, matches[0]);
    resolveCache.set(inputName, resolved);
    return resolved;
  };

  const resolvedPairs: ResolvedPair[] = [];
  for (const item of nonStaySegments) {
    const from = resolveOne(item.fromName);
    const to = resolveOne(item.toName);
    if (from && to && from.hotspot_ID !== to.hotspot_ID) {
      resolvedPairs.push({ from, to, segmentCount: item.segmentCount });
    }
  }

  const candidates = Array.from(
    new Map(
      resolvedPairs
        .flatMap((pair) => [pair.from, pair.to])
        .map((spot) => [spot.hotspot_ID, spot]),
    ).values(),
  );

  let totalAttempted = 0;
  let totalSuccessful = 0;
  let totalFailed = 0;

  for (let pairIndex = 0; pairIndex < resolvedPairs.length; pairIndex += 1) {
    const pair = resolvedPairs[pairIndex];

    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidate = candidates[candidateIndex];

      if (candidate.hotspot_ID === pair.from.hotspot_ID || candidate.hotspot_ID === pair.to.hotspot_ID) {
        continue;
      }

      totalAttempted += 1;

      console.log(
        `[pair ${pairIndex + 1}/${resolvedPairs.length} candidate ${candidateIndex + 1}/${candidates.length}] ${pair.from.hotspot_name} -> ${pair.to.hotspot_name} via ${candidate.hotspot_name}`,
      );

      const exitCode = await runCommand(
        'npx',
        ['tsx', '--no-cache', 'scripts/build-hotspot-route-matrix.ts', '--apply', '--limit=1', '--rebuild-done'],
        {
          FROM_HOTSPOT_ID: String(pair.from.hotspot_ID),
          TO_HOTSPOT_ID: String(pair.to.hotspot_ID),
          BETWEEN_HOTSPOT_ID: String(candidate.hotspot_ID),
          MAX_PAIR_HAVERSINE_KM: '350',
        },
      );

      if (exitCode === 0) {
        totalSuccessful += 1;
      } else {
        totalFailed += 1;
      }

      await sleep(delayMs);
    }
  }

  const pairConditions = resolvedPairs
    .map((pair) => `(bm.from_hotspot_id = ${pair.from.hotspot_ID} AND bm.to_hotspot_id = ${pair.to.hotspot_ID})`)
    .join(' OR ');

  const summaryRows = pairConditions
    ? await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
        SELECT
          f.hotspot_name AS from_name,
          t.hotspot_name AS to_name,
          c.hotspot_name AS candidate_name,
          bm.route_fit_type,
          bm.road_detour_km,
          bm.road_detour_ratio,
          bm.route_decision_reason
        FROM hotspot_route_between_map bm
        JOIN dvi_hotspot_place f ON f.hotspot_ID = bm.from_hotspot_id
        JOIN dvi_hotspot_place t ON t.hotspot_ID = bm.to_hotspot_id
        JOIN dvi_hotspot_place c ON c.hotspot_ID = bm.between_hotspot_id
        WHERE ${pairConditions}
        ORDER BY
          f.hotspot_name,
          t.hotspot_name,
          FIELD(bm.route_fit_type, 'ON_ROUTE', 'MINOR_DETOUR', 'BACKTRACK', 'OFF_ROUTE'),
          bm.road_detour_km ASC
      `)
    : [];

  const routeFitCounts = summaryRows.reduce<Record<string, number>>((acc, row) => {
    const key = String(row.route_fit_type ?? 'UNKNOWN');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  console.log('\nLegacy Top Segments (non-stay):');
  for (const pair of resolvedPairs) {
    console.log(`- ${pair.from.hotspot_name} (${pair.from.hotspot_ID}) -> ${pair.to.hotspot_name} (${pair.to.hotspot_ID}) legacy_count=${pair.segmentCount}`);
  }

  console.log('\nResolved Candidate Hotspots (from route set):');
  for (const candidate of candidates) {
    console.log(`- ${candidate.hotspot_name} (${candidate.hotspot_ID})`);
  }

  if (unresolvedNames.size) {
    console.log('\nUnresolved legacy names:');
    for (const name of unresolvedNames) {
      console.log(`- ${name}`);
    }
  }

  if (ambiguousNames.length) {
    console.log('\nAmbiguous legacy names:');
    for (const item of ambiguousNames) {
      console.log(`- ${item.inputName}`);
      for (const row of item.matches) {
        console.log(`  hotspot_ID=${row.hotspot_ID} hotspot_name="${row.hotspot_name ?? ''}"`);
      }
    }
  }

  console.log('\nExecution Counters:');
  console.log(
    JSON.stringify(
      {
        topLimit,
        routePairsResolved: resolvedPairs.length,
        candidateHotspotsResolved: candidates.length,
        totalAttempted,
        totalSuccessful,
        totalFailed,
        routeFitCounts,
      },
      null,
      2,
    ),
  );

  console.log('\nSummary Rows:');
  console.log(JSON.stringify(summaryRows, null, 2));
}

main()
  .catch((error) => {
    console.error('Failed running legacy top route hotspot build:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
