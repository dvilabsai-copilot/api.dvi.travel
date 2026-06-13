import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import {
  buildCityLookupCandidates,
  normalizeCityName,
} from '../src/modules/itineraries/utils/city-normalization.util';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const TRUSTED_CITY_ID_MAP_PATH = path.join(
  __dirname,
  'data',
  'stored-location-city-id-map.json',
);

type GroupedCityRow = {
  city_name: string | null;
  row_count: bigint | number;
};

type CityMasterRow = {
  id: number;
  name: string;
};

type TrustedCityMappingValue =
  | number
  | {
      cityId?: number;
      cityName?: string;
    };
type TrustedCityMappingFile = Record<string, TrustedCityMappingValue>;
type TrustedCityIdMap = Record<
  string,
  {
    cityId: number | null;
    cityName: string | null;
  }
>;
type GroupedCityPairRow = {
  source_city_name: string | null;
  destination_city_name: string | null;
  row_count: bigint | number;
};

function toCount(value: bigint | number | null | undefined): number {
  if (typeof value === 'bigint') return Number(value);
  return Number(value || 0);
}

function buildCityIndex(rows: CityMasterRow[]): Map<string, CityMasterRow> {
  const index = new Map<string, CityMasterRow>();

  for (const row of rows) {
    const normalized = normalizeCityName(row.name);
    if (!normalized) continue;

    if (!index.has(normalized)) {
      index.set(normalized, row);
    }
  }

  return index;
}

function loadTrustedCityIdMap(): TrustedCityIdMap {
  const raw = fs.readFileSync(TRUSTED_CITY_ID_MAP_PATH, 'utf8');
  const parsed = JSON.parse(raw) as TrustedCityMappingFile;

  const normalizedEntries = Object.entries(parsed)
    .map(([key, value]) => {
      const normalizedKey = normalizeCityName(key);
      if (!normalizedKey || normalizedKey.startsWith('_')) return null;

      if (typeof value === 'number') {
        return [
          normalizedKey,
          {
            cityId: value > 0 ? Number(value) : null,
            cityName: null,
          },
        ] as const;
      }

      return [
        normalizedKey,
        {
          cityId:
            typeof value?.cityId === 'number' && value.cityId > 0
              ? Number(value.cityId)
              : null,
          cityName: value?.cityName ? String(value.cityName).trim() : null,
        },
      ] as const;
    })
    .filter(Boolean) as Array<
    readonly [string, { cityId: number | null; cityName: string | null }]
  >;

  return Object.fromEntries(normalizedEntries);
}

function resolveCityIdFromIndex(
  cityIndex: Map<string, CityMasterRow>,
  trustedCityIdMap: TrustedCityIdMap,
  rawValue: string | null | undefined,
): number | null {
  for (const candidate of buildCityLookupCandidates(rawValue)) {
    const normalized = normalizeCityName(candidate);
    if (!normalized) continue;

    const trustedEntry = trustedCityIdMap[normalized];
    if (trustedEntry?.cityId && trustedEntry.cityId > 0) {
      return trustedEntry.cityId;
    }
    if (trustedEntry?.cityName) {
      const trustedNameMatch = cityIndex.get(normalizeCityName(trustedEntry.cityName));
      if (trustedNameMatch) {
        return Number(trustedNameMatch.id);
      }
    }

    const matched = cityIndex.get(normalized);
    if (matched) {
      return Number(matched.id);
    }
  }

  return null;
}

async function getGroupedSourceCities(): Promise<GroupedCityRow[]> {
  return prisma.$queryRaw<GroupedCityRow[]>`
    SELECT source_location_city AS city_name, COUNT(*) AS row_count
    FROM dvi_stored_locations
    WHERE deleted = 0
      AND source_location_city IS NOT NULL
      AND TRIM(source_location_city) <> ''
    GROUP BY source_location_city
    ORDER BY row_count DESC
  `;
}

async function getGroupedDestinationCities(): Promise<GroupedCityRow[]> {
  return prisma.$queryRaw<GroupedCityRow[]>`
    SELECT destination_location_city AS city_name, COUNT(*) AS row_count
    FROM dvi_stored_locations
    WHERE deleted = 0
      AND destination_location_city IS NOT NULL
      AND TRIM(destination_location_city) <> ''
    GROUP BY destination_location_city
    ORDER BY row_count DESC
  `;
}

async function getGroupedUnresolvedCityPairs(): Promise<GroupedCityPairRow[]> {
  return prisma.$queryRaw<GroupedCityPairRow[]>`
    SELECT
      source_location_city AS source_city_name,
      destination_location_city AS destination_city_name,
      COUNT(*) AS row_count
    FROM dvi_stored_locations
    WHERE deleted = 0
      AND source_location_city IS NOT NULL
      AND TRIM(source_location_city) <> ''
      AND destination_location_city IS NOT NULL
      AND TRIM(destination_location_city) <> ''
      AND (source_city_id IS NULL OR destination_city_id IS NULL)
    GROUP BY source_location_city, destination_location_city
    ORDER BY row_count DESC
  `;
}

async function processGroupedColumn(args: {
  groups: GroupedCityRow[];
  targetColumn: 'source_city_id' | 'destination_city_id';
  matchColumn: 'source_location_city' | 'destination_location_city';
  cityIndex: Map<string, CityMasterRow>;
  trustedCityIdMap: TrustedCityIdMap;
}) {
  let groupedValues = 0;
  let matchedGroups = 0;
  let matchedRows = 0;
  let updatedGroups = 0;
  const unmatchedGroups: Array<{
    cityName: string;
    normalizedCandidates: string[];
    rowCount: number;
    trustedCityId: number | null;
  }> = [];

  for (const group of args.groups) {
    groupedValues += 1;
    const cityName = String(group.city_name ?? '').trim();
    if (!cityName) continue;

    const resolvedCityId = resolveCityIdFromIndex(
      args.cityIndex,
      args.trustedCityIdMap,
      cityName,
    );
    if (resolvedCityId) {
      matchedGroups += 1;
      matchedRows += toCount(group.row_count);
    } else {
      unmatchedGroups.push({
        cityName,
        normalizedCandidates: buildCityLookupCandidates(cityName).map((candidate) =>
          normalizeCityName(candidate),
        ),
        rowCount: toCount(group.row_count),
        trustedCityId:
          args.trustedCityIdMap[normalizeCityName(cityName)]?.cityId ?? null,
      });
    }

    if (!resolvedCityId) continue;

    if (APPLY) {
      await prisma.dvi_stored_locations.updateMany({
        where: {
          deleted: 0,
          [args.matchColumn]: cityName,
        } as any,
        data: {
          [args.targetColumn]: resolvedCityId,
        } as any,
      });
    }

    updatedGroups += 1;
  }

  return {
    groupedValues,
    matchedGroups,
    matchedRows,
    updatedGroups,
    unmatchedGroups: unmatchedGroups
      .sort((a, b) => b.rowCount - a.rowCount || a.cityName.localeCompare(b.cityName))
      .slice(0, 100),
  };
}

async function main() {
  const trustedCityIdMap = loadTrustedCityIdMap();
  const [cities, sourceGroups, destinationGroups, unresolvedPairs] = await Promise.all([
    prisma.dvi_cities.findMany({
      where: {
        status: 1,
        deleted: { in: [0, 1] },
      },
      select: {
        id: true,
        name: true,
      },
      orderBy: { name: 'asc' },
    }),
    getGroupedSourceCities(),
    getGroupedDestinationCities(),
    getGroupedUnresolvedCityPairs(),
  ]);

  const cityIndex = buildCityIndex(cities as CityMasterRow[]);

  const sourceResult = await processGroupedColumn({
    groups: sourceGroups,
    targetColumn: 'source_city_id',
    matchColumn: 'source_location_city',
    cityIndex,
    trustedCityIdMap,
  });

  const destinationResult = await processGroupedColumn({
    groups: destinationGroups,
    targetColumn: 'destination_city_id',
    matchColumn: 'destination_location_city',
    cityIndex,
    trustedCityIdMap,
  });

  const topUnresolvedPairs = unresolvedPairs
    .map((pair) => ({
      sourceCityName: String(pair.source_city_name ?? '').trim(),
      destinationCityName: String(pair.destination_city_name ?? '').trim(),
      sourceTrustedCityId:
        trustedCityIdMap[
          normalizeCityName(String(pair.source_city_name ?? '').trim())
        ]?.cityId ?? null,
      destinationTrustedCityId:
        trustedCityIdMap[
          normalizeCityName(String(pair.destination_city_name ?? '').trim())
        ]?.cityId ?? null,
      rowCount: toCount(pair.row_count),
    }))
    .sort((a, b) => b.rowCount - a.rowCount)
    .slice(0, 100);

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? 'apply' : 'dry-run',
        source: sourceResult,
        destination: destinationResult,
        cityMasterRows: cities.length,
        trustedCityIdMapSize: Object.keys(trustedCityIdMap).length,
        trustedCityIdMapPath: TRUSTED_CITY_ID_MAP_PATH,
        topUnresolvedPairs,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error('[backfill-stored-location-city-ids] Failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
