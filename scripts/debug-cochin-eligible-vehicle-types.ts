import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

type StoredLocationRow = {
  source_location: string | null;
  source_location_city: string | null;
  destination_location: string | null;
  destination_location_city: string | null;
  status: number | null;
  deleted: number | null;
};

type QueryRow = {
  vehicle_type_id: number | null;
  vehicle_type_title: string | null;
  occupancy: number | null;
  vehicle_id: number | null;
  vendor_id: number | null;
  vendor_name: string | null;
  vendor_branch_id: number | null;
  vendor_branch_name: string | null;
  vehicle_saved_vehicle_type_id: number | null;
  vendor_vehicle_type_ID: number | null;
  returned_vendor_vehicle_type_id: number | null;
  owner_city: string | null;
  status: number | null;
  deleted: number | null;
  vendor_branch_city?: number | null;
};

const prisma = new PrismaClient();

function parseArgValue(flag: string): string | undefined {
  const prefix = `${flag}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function splitLocations(value?: string): string[] {
  const raw = String(value ?? '').trim();
  if (!raw) return [];

  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item ?? '').trim()).filter(Boolean);
      }
    } catch {
      // Fall through to plain split.
    }
  }

  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeLocationKey(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function extractFirstCityToken(value: string): string {
  return String(value ?? '')
    .split(',')[0]
    ?.trim() ?? '';
}

function buildLocationCandidateValues(value: string): string[] {
  const trimmed = String(value ?? '').trim();
  const firstToken = extractFirstCityToken(trimmed);
  const candidates = [trimmed];

  if (firstToken && firstToken.toLowerCase() !== trimmed.toLowerCase()) {
    candidates.push(firstToken);
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

function printSection(title: string, payload: unknown) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(payload, null, 2));
}

async function getLocationMaps() {
  const rows = (await prisma.dvi_stored_locations.findMany({
    where: {
      deleted: 0,
      status: 1,
    } as any,
    select: {
      source_location: true,
      source_location_city: true,
      destination_location: true,
      destination_location_city: true,
      status: true,
      deleted: true,
    },
  } as any)) as StoredLocationRow[];

  const exact = new Map<string, string>();
  const normalized = new Map<string, string>();

  for (const row of rows) {
    const sourceLocation = String(row.source_location ?? '').trim();
    const sourceCity = String(row.source_location_city ?? '').trim();
    const destinationLocation = String(row.destination_location ?? '').trim();
    const destinationCity = String(row.destination_location_city ?? '').trim();

    if (sourceLocation && sourceCity) {
      exact.set(sourceLocation, sourceCity);
      normalized.set(normalizeLocationKey(sourceLocation), sourceCity);
    }

    if (destinationLocation && destinationCity) {
      exact.set(destinationLocation, destinationCity);
      normalized.set(normalizeLocationKey(destinationLocation), destinationCity);
    }
  }

  return { exact, normalized };
}

async function getStoredLocationMatch(location: string) {
  const [sourceMatches, destinationMatches] = await Promise.all([
    prisma.$queryRawUnsafe(
      `
      SELECT source_location, source_location_city, status, deleted
      FROM dvi_stored_locations
      WHERE deleted = 0
        AND status = 1
        AND source_location = ?
      `,
      location,
    ),
    prisma.$queryRawUnsafe(
      `
      SELECT destination_location, destination_location_city, status, deleted
      FROM dvi_stored_locations
      WHERE deleted = 0
        AND status = 1
        AND destination_location = ?
      `,
      location,
    ),
  ]);

  return {
    inputLocation: location,
    exactSourceLocationMatch: sourceMatches,
    exactDestinationLocationMatch: destinationMatches,
  };
}

function deriveEligibleCitiesExactlyAsCurrentApi(
  uniqueLocations: string[],
  exactMap: Map<string, string>,
  normalizedMap: Map<string, string>,
) {
  const uniqueCities = new Set<string>();
  const mappingSteps = uniqueLocations.map((location) => {
    const candidates = buildLocationCandidateValues(location);
    let resolvedCity = '';
    let matchedCandidate = '';
    let matchedBy: 'exact' | 'normalized' | 'firstTokenFallback' | 'rawFallback' | null = null;

    for (const candidate of candidates) {
      const exactMatch = exactMap.get(candidate);
      if (exactMatch) {
        resolvedCity = exactMatch.trim();
        matchedCandidate = candidate;
        matchedBy = 'exact';
        break;
      }

      const normalizedMatch = normalizedMap.get(normalizeLocationKey(candidate));
      if (normalizedMatch) {
        resolvedCity = normalizedMatch.trim();
        matchedCandidate = candidate;
        matchedBy = 'normalized';
        break;
      }
    }

    if (!resolvedCity) {
      const firstToken = extractFirstCityToken(location);
      if (firstToken) {
        resolvedCity = firstToken;
        matchedCandidate = firstToken;
        matchedBy = 'firstTokenFallback';
      } else {
        resolvedCity = location.trim();
        matchedCandidate = location.trim();
        matchedBy = 'rawFallback';
      }
    }

    uniqueCities.add(resolvedCity);

    return {
      inputLocation: location,
      candidates,
      matchedCandidate,
      matchedBy,
      resolvedEligibleCity: resolvedCity,
    };
  });

  return {
    mappingSteps,
    eligibleCities: Array.from(uniqueCities),
  };
}

async function runCurrentApiMirrorQuery(eligibleCities: string[]) {
  const placeholders = eligibleCities.map(() => '?').join(', ');

  return (await prisma.$queryRawUnsafe(
    `
    SELECT DISTINCT
      VENDOR_VEHICLE_TYPES.vehicle_type_id,
      VEHICLE_TYPES.vehicle_type_title,
      VEHICLE_TYPES.occupancy,
      VEHICLE.vehicle_id,
      VEHICLE.vendor_id,
      VENDOR_DETAILS.vendor_name,
      VEHICLE.vendor_branch_id,
      VENDOR_BRANCH_DETAILS.vendor_branch_name,
      VEHICLE.vehicle_type_id AS vehicle_saved_vehicle_type_id,
      VENDOR_VEHICLE_TYPES.vendor_vehicle_type_ID,
      VENDOR_VEHICLE_TYPES.vehicle_type_id AS returned_vendor_vehicle_type_id,
      VEHICLE.owner_city,
      VEHICLE.status,
      VEHICLE.deleted
    FROM dvi_vehicle VEHICLE
    LEFT JOIN dvi_vendor_vehicle_types VENDOR_VEHICLE_TYPES
      ON VEHICLE.vehicle_type_id = VENDOR_VEHICLE_TYPES.vendor_vehicle_type_ID
      AND VEHICLE.vendor_id = VENDOR_VEHICLE_TYPES.vendor_id
    LEFT JOIN dvi_vendor_details VENDOR_DETAILS
      ON VENDOR_DETAILS.vendor_id = VEHICLE.vendor_id
    LEFT JOIN dvi_vendor_branches VENDOR_BRANCH_DETAILS
      ON VENDOR_BRANCH_DETAILS.vendor_branch_id = VEHICLE.vendor_branch_id
    LEFT JOIN dvi_vehicle_type VEHICLE_TYPES
      ON VEHICLE_TYPES.vehicle_type_id = VENDOR_VEHICLE_TYPES.vehicle_type_id
    WHERE VEHICLE.status = 1
      AND VEHICLE.deleted = 0
      AND VENDOR_DETAILS.status = 1
      AND VENDOR_DETAILS.deleted = 0
      AND VENDOR_BRANCH_DETAILS.status = 1
      AND VENDOR_BRANCH_DETAILS.deleted = 0
      AND VEHICLE.owner_city IN (${placeholders})
    ORDER BY VEHICLE_TYPES.occupancy ASC, VEHICLE_TYPES.vehicle_type_title ASC
    `,
    ...eligibleCities,
  )) as QueryRow[];
}

async function runCorrectedJoinQuery(eligibleCities: string[]) {
  const placeholders = eligibleCities.map(() => '?').join(', ');

  return (await prisma.$queryRawUnsafe(
    `
    SELECT DISTINCT
      VENDOR_VEHICLE_TYPES.vehicle_type_id,
      VEHICLE_TYPES.vehicle_type_title,
      VEHICLE_TYPES.occupancy,
      VEHICLE.vehicle_id,
      VEHICLE.vendor_id,
      VENDOR_DETAILS.vendor_name,
      VEHICLE.vendor_branch_id,
      VENDOR_BRANCH_DETAILS.vendor_branch_name,
      VENDOR_BRANCH_DETAILS.vendor_branch_city,
      VEHICLE.vehicle_type_id AS vehicle_saved_vehicle_type_id,
      VENDOR_VEHICLE_TYPES.vendor_vehicle_type_ID,
      VENDOR_VEHICLE_TYPES.vehicle_type_id AS returned_vendor_vehicle_type_id,
      VEHICLE.owner_city,
      VEHICLE.status,
      VEHICLE.deleted
    FROM dvi_vehicle VEHICLE
    LEFT JOIN dvi_vendor_vehicle_types VENDOR_VEHICLE_TYPES
      ON VENDOR_VEHICLE_TYPES.vendor_id = VEHICLE.vendor_id
      AND VENDOR_VEHICLE_TYPES.vehicle_type_id = VEHICLE.vehicle_type_id
    LEFT JOIN dvi_vendor_details VENDOR_DETAILS
      ON VENDOR_DETAILS.vendor_id = VEHICLE.vendor_id
    LEFT JOIN dvi_vendor_branches VENDOR_BRANCH_DETAILS
      ON VENDOR_BRANCH_DETAILS.vendor_branch_id = VEHICLE.vendor_branch_id
    LEFT JOIN dvi_vehicle_type VEHICLE_TYPES
      ON VEHICLE_TYPES.vehicle_type_id = VENDOR_VEHICLE_TYPES.vehicle_type_id
    WHERE VEHICLE.status = 1
      AND VEHICLE.deleted = 0
      AND VENDOR_DETAILS.status = 1
      AND VENDOR_DETAILS.deleted = 0
      AND VENDOR_BRANCH_DETAILS.status = 1
      AND VENDOR_BRANCH_DETAILS.deleted = 0
      AND VEHICLE.owner_city IN (${placeholders})
    ORDER BY VEHICLE_TYPES.occupancy ASC, VEHICLE_TYPES.vehicle_type_title ASC
    `,
    ...eligibleCities,
  )) as QueryRow[];
}

async function resolveCityIds(eligibleCities: string[]) {
  const rows = await prisma.$queryRawUnsafe(
    `
    SELECT id, name
    FROM dvi_cities
    WHERE deleted = 0
      AND status = 1
      AND LOWER(TRIM(name)) IN (${eligibleCities.map(() => 'LOWER(TRIM(?))').join(', ')})
    ORDER BY name ASC
    `,
    ...eligibleCities,
  ) as Array<{ id: number; name: string }>;

  return rows;
}

async function runCityIdComparisons(eligibleCities: string[], cityIds: number[]) {
  if (cityIds.length === 0) {
    return {
      resolvedCities: [],
      ownerCityAsUnsignedRows: [],
      branchCityRows: [],
    };
  }

  const cityPlaceholders = cityIds.map(() => '?').join(', ');
  const eligibleCityPlaceholders = eligibleCities.map(() => '?').join(', ');

  const [ownerCityAsUnsignedRows, branchCityRows] = await Promise.all([
    prisma.$queryRawUnsafe(
      `
      SELECT
        VEHICLE.vehicle_id,
        VEHICLE.vendor_id,
        VENDOR_DETAILS.vendor_name,
        VEHICLE.vendor_branch_id,
        VENDOR_BRANCH_DETAILS.vendor_branch_name,
        VEHICLE.owner_city,
        CAST(VEHICLE.owner_city AS UNSIGNED) AS owner_city_as_unsigned,
        VEHICLE.vehicle_type_id
      FROM dvi_vehicle VEHICLE
      LEFT JOIN dvi_vendor_details VENDOR_DETAILS
        ON VENDOR_DETAILS.vendor_id = VEHICLE.vendor_id
      LEFT JOIN dvi_vendor_branches VENDOR_BRANCH_DETAILS
        ON VENDOR_BRANCH_DETAILS.vendor_branch_id = VEHICLE.vendor_branch_id
      WHERE VEHICLE.status = 1
        AND VEHICLE.deleted = 0
        AND CAST(VEHICLE.owner_city AS UNSIGNED) IN (${cityPlaceholders})
      ORDER BY VEHICLE.vehicle_id ASC
      `,
      ...cityIds,
    ),
    prisma.$queryRawUnsafe(
      `
      SELECT
        VEHICLE.vehicle_id,
        VEHICLE.vendor_id,
        VENDOR_DETAILS.vendor_name,
        VEHICLE.vendor_branch_id,
        VENDOR_BRANCH_DETAILS.vendor_branch_name,
        VENDOR_BRANCH_DETAILS.vendor_branch_city,
        VEHICLE.owner_city,
        VEHICLE.vehicle_type_id
      FROM dvi_vehicle VEHICLE
      LEFT JOIN dvi_vendor_details VENDOR_DETAILS
        ON VENDOR_DETAILS.vendor_id = VEHICLE.vendor_id
      LEFT JOIN dvi_vendor_branches VENDOR_BRANCH_DETAILS
        ON VENDOR_BRANCH_DETAILS.vendor_branch_id = VEHICLE.vendor_branch_id
      WHERE VEHICLE.status = 1
        AND VEHICLE.deleted = 0
        AND VENDOR_BRANCH_DETAILS.vendor_branch_city IN (${cityPlaceholders})
        AND VEHICLE.owner_city IN (${eligibleCityPlaceholders})
      ORDER BY VEHICLE.vehicle_id ASC
      `,
      ...cityIds,
      ...eligibleCities,
    ),
  ]);

  return {
    ownerCityAsUnsignedRows,
    branchCityRows,
  };
}

function keyByVehicle(row: QueryRow) {
  return [
    row.vehicle_id ?? '',
    row.vendor_id ?? '',
    row.vendor_branch_id ?? '',
    row.vehicle_saved_vehicle_type_id ?? '',
    row.returned_vendor_vehicle_type_id ?? '',
  ].join('|');
}

function buildFinalDiagnosis(currentRows: QueryRow[], correctedRows: QueryRow[]) {
  const currentKeys = new Set(currentRows.map(keyByVehicle));
  const correctedKeys = new Set(correctedRows.map(keyByVehicle));
  const wantedTypes = new Set([1, 23, 20, 21]);

  const combined = [...currentRows, ...correctedRows].filter(
    (row) => row.returned_vendor_vehicle_type_id != null && wantedTypes.has(Number(row.returned_vendor_vehicle_type_id)),
  );

  const seen = new Set<string>();

  return combined
    .map((row) => {
      const key = keyByVehicle(row);
      if (seen.has(key)) return null;
      seen.add(key);

      return {
        vehicle_id: row.vehicle_id,
        vendor_id: row.vendor_id,
        vendor_name: row.vendor_name,
        vendor_branch_id: row.vendor_branch_id,
        branch_name: row.vendor_branch_name,
        VEHICLE_owner_city: row.owner_city,
        VEHICLE_vehicle_type_id: row.vehicle_saved_vehicle_type_id,
        VENDOR_VEHICLE_TYPES_vendor_vehicle_type_ID: row.vendor_vehicle_type_ID,
        VENDOR_VEHICLE_TYPES_vehicle_type_id: row.returned_vendor_vehicle_type_id,
        vehicle_type_title: row.vehicle_type_title,
        fromOldJoin: currentKeys.has(key),
        fromCorrectedJoin: correctedKeys.has(key),
      };
    })
    .filter(Boolean);
}

function summarizeVendors(rows: QueryRow[]) {
  const summary = new Map<string, { vendor_id: number | null; vendor_name: string | null; count: number }>();

  for (const row of rows) {
    const key = `${row.vendor_id ?? 'null'}|${row.vendor_name ?? ''}`;
    const existing = summary.get(key) ?? {
      vendor_id: row.vendor_id,
      vendor_name: row.vendor_name,
      count: 0,
    };
    existing.count += 1;
    summary.set(key, existing);
  }

  return Array.from(summary.values()).sort((a, b) => b.count - a.count);
}

async function main() {
  const sourceArg =
    parseArgValue('--source') ??
    process.env.SOURCE_LOCATIONS ??
    'Cochin International Airport,Munnar';
  const nextArg =
    parseArgValue('--next') ??
    process.env.NEXT_LOCATIONS ??
    'Munnar,Cochin International Airport';

  const sourceLocation = splitLocations(sourceArg);
  const nextVisitingLocation = splitLocations(nextArg);
  const uniqueLocations = Array.from(
    new Set([...sourceLocation, ...nextVisitingLocation].map((value) => value.trim()).filter(Boolean)),
  );

  printSection('A. Input locations', {
    sourceLocation,
    nextVisitingLocation,
    uniqueLocations,
  });

  const { exact, normalized } = await getLocationMaps();
  const mappingRows = [];
  for (const location of uniqueLocations) {
    mappingRows.push(await getStoredLocationMatch(location));
  }

  const derived = deriveEligibleCitiesExactlyAsCurrentApi(
    uniqueLocations,
    exact,
    normalized,
  );

  printSection('B. dvi_stored_locations mapping', {
    perInputMatches: mappingRows,
    currentApiMappingSteps: derived.mappingSteps,
    finalEligibleCitiesExactlyAsCurrentApiDerives: derived.eligibleCities,
  });

  const currentRows = await runCurrentApiMirrorQuery(derived.eligibleCities);
  printSection('C. Current API mirror query rows', {
    rowCount: currentRows.length,
    vendorSummary: summarizeVendors(currentRows),
    rows: currentRows,
  });

  const correctedRows = await runCorrectedJoinQuery(derived.eligibleCities);
  const currentKeys = new Set(currentRows.map(keyByVehicle));
  const correctedKeys = new Set(correctedRows.map(keyByVehicle));

  printSection('D. Corrected join comparison', {
    currentRowCount: currentRows.length,
    correctedRowCount: correctedRows.length,
    rowsOnlyInCurrentJoin: currentRows.filter((row) => !correctedKeys.has(keyByVehicle(row))),
    rowsOnlyInCorrectedJoin: correctedRows.filter((row) => !currentKeys.has(keyByVehicle(row))),
    correctedRows,
  });

  const resolvedCities = await resolveCityIds(derived.eligibleCities);
  const cityIds = resolvedCities.map((row) => row.id);
  const cityIdComparisons = await runCityIdComparisons(derived.eligibleCities, cityIds);

  printSection('E. City ID comparison', {
    eligibleCities: derived.eligibleCities,
    resolvedCities,
    cityIds,
    ownerCityAsUnsignedInCityIds: cityIdComparisons.ownerCityAsUnsignedRows,
    vendorBranchCityInCityIds: cityIdComparisons.branchCityRows,
  });

  const finalDiagnosis = buildFinalDiagnosis(currentRows, correctedRows);
  printSection('F. Final diagnosis for returned types 1, 23, 20, 21', finalDiagnosis);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
