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

type VehicleSampleRow = {
  vehicle_id: number;
  vendor_id: number;
  vendor_branch_id: number;
  vehicle_type_id: number | null;
  owner_city: string | null;
  status: number;
  deleted: number;
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
      // Fall through to plain-string parsing.
    }
  }

  const separator = raw.includes('||') ? '||' : raw.includes('\n') ? '\n' : null;
  if (!separator) {
    return [raw];
  }

  return raw
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeKey(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function firstToken(value: string): string {
  return String(value ?? '').split(',')[0]?.trim() ?? '';
}

function candidateValues(value: string): string[] {
  const trimmed = String(value ?? '').trim();
  const token = firstToken(trimmed);
  return Array.from(
    new Set([trimmed, token].filter((item) => Boolean(item))),
  );
}

function printSection(title: string, payload: unknown) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(payload, null, 2));
}

async function buildStoredLocationMaps() {
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
      normalized.set(normalizeKey(sourceLocation), sourceCity);
    }

    if (destinationLocation && destinationCity) {
      exact.set(destinationLocation, destinationCity);
      normalized.set(normalizeKey(destinationLocation), destinationCity);
    }
  }

  return { exact, normalized };
}

async function getMappingCheck(location: string) {
  const token = firstToken(location);

  const [
    exactSource,
    exactDestination,
    normalizedSource,
    normalizedDestination,
    likeMatches,
  ] = await Promise.all([
    prisma.$queryRawUnsafe(
      `
      SELECT source_location, source_location_city, destination_location, destination_location_city, status, deleted
      FROM dvi_stored_locations
      WHERE deleted = 0 AND status = 1 AND source_location = ?
      LIMIT 10
      `,
      location,
    ),
    prisma.$queryRawUnsafe(
      `
      SELECT source_location, source_location_city, destination_location, destination_location_city, status, deleted
      FROM dvi_stored_locations
      WHERE deleted = 0 AND status = 1 AND destination_location = ?
      LIMIT 10
      `,
      location,
    ),
    prisma.$queryRawUnsafe(
      `
      SELECT source_location, source_location_city, destination_location, destination_location_city, status, deleted
      FROM dvi_stored_locations
      WHERE deleted = 0 AND status = 1 AND LOWER(TRIM(source_location)) = LOWER(TRIM(?))
      LIMIT 10
      `,
      location,
    ),
    prisma.$queryRawUnsafe(
      `
      SELECT source_location, source_location_city, destination_location, destination_location_city, status, deleted
      FROM dvi_stored_locations
      WHERE deleted = 0 AND status = 1 AND LOWER(TRIM(destination_location)) = LOWER(TRIM(?))
      LIMIT 10
      `,
      location,
    ),
    prisma.$queryRawUnsafe(
      `
      SELECT source_location, source_location_city, destination_location, destination_location_city, status, deleted
      FROM dvi_stored_locations
      WHERE deleted = 0
        AND status = 1
        AND (
          source_location LIKE ?
          OR destination_location LIKE ?
          OR source_location_city LIKE ?
          OR destination_location_city LIKE ?
        )
      LIMIT 10
      `,
      `%${token}%`,
      `%${token}%`,
      `%${token}%`,
      `%${token}%`,
    ),
  ]);

  return {
    location,
    token,
    exactSource,
    exactDestination,
    normalizedSource,
    normalizedDestination,
    likeMatches,
  };
}

function deriveCurrentEligibleCities(
  uniqueLocations: string[],
  exactMap: Map<string, string>,
) {
  return Array.from(
    new Set(
      uniqueLocations.map((location) => exactMap.get(location.trim()) || location.trim()),
    ),
  );
}

function deriveImprovedEligibleCities(
  uniqueLocations: string[],
  exactMap: Map<string, string>,
  normalizedMap: Map<string, string>,
) {
  const cities: string[] = [];
  const diagnostics = uniqueLocations.map((location) => {
    const candidates = candidateValues(location);
    let matchedCity = '';
    let matchedCandidate = '';

    for (const candidate of candidates) {
      const exact = exactMap.get(candidate);
      if (exact) {
        matchedCity = exact;
        matchedCandidate = candidate;
        break;
      }

      const normalized = normalizedMap.get(normalizeKey(candidate));
      if (normalized) {
        matchedCity = normalized;
        matchedCandidate = candidate;
        break;
      }
    }

    const fallbackCity = firstToken(location) || location.trim();
    const derivedCity = matchedCity || fallbackCity || location.trim();
    cities.push(derivedCity);

    return {
      originalLocation: location,
      matchedCandidate: matchedCandidate || null,
      mappedCity: matchedCity || null,
      firstCommaSeparatedPart: firstToken(location) || null,
      normalizedOriginal: normalizeKey(location),
      normalizedFirstPart: normalizeKey(firstToken(location)),
      derivedCity,
    };
  });

  return {
    eligibleCities: Array.from(new Set(cities.filter(Boolean))),
    diagnostics,
  };
}

async function getVehicleDiagnostics(city: string) {
  const [exactRows, normalizedRows, likeRows, activeRows, samples] = await Promise.all([
    prisma.$queryRawUnsafe(
      'SELECT COUNT(*) AS total FROM dvi_vehicle WHERE owner_city = ?',
      city,
    ),
    prisma.$queryRawUnsafe(
      'SELECT COUNT(*) AS total FROM dvi_vehicle WHERE LOWER(TRIM(owner_city)) = LOWER(TRIM(?))',
      city,
    ),
    prisma.$queryRawUnsafe(
      'SELECT COUNT(*) AS total FROM dvi_vehicle WHERE owner_city LIKE ?',
      `%${city}%`,
    ),
    prisma.$queryRawUnsafe(
      'SELECT COUNT(*) AS total FROM dvi_vehicle WHERE owner_city = ? AND status = 1 AND deleted = 0',
      city,
    ),
    prisma.$queryRawUnsafe(
      `
      SELECT vehicle_id, vendor_id, vendor_branch_id, vehicle_type_id, owner_city, status, deleted
      FROM dvi_vehicle
      WHERE owner_city = ?
         OR LOWER(TRIM(owner_city)) = LOWER(TRIM(?))
         OR owner_city LIKE ?
      ORDER BY vehicle_id DESC
      LIMIT 10
      `,
      city,
      city,
      `%${city}%`,
    ),
  ]);

  const readTotal = (rows: any[]) => Number(rows?.[0]?.total ?? 0);

  return {
    city,
    exactOwnerCityCount: readTotal(exactRows),
    normalizedOwnerCityCount: readTotal(normalizedRows),
    likeOwnerCityCount: readTotal(likeRows),
    activeExactOwnerCityCount: readTotal(activeRows),
    sampleRows: samples as VehicleSampleRow[],
  };
}

async function getJoinDiagnostics(cities: string[]) {
  const uniqueCities = Array.from(new Set(cities.filter(Boolean)));
  if (uniqueCities.length === 0) {
    return {
      counts: {},
      finalDistinctVehicleTypes: [],
      droppedReasons: {},
    };
  }

  const placeholders = uniqueCities.map(() => '?').join(', ');
  const countFor = async (extraJoinSql = '', extraWhereSql = '') => {
    const rows = (await prisma.$queryRawUnsafe(
      `
      SELECT COUNT(DISTINCT VEHICLE.vehicle_id) AS total
      FROM dvi_vehicle VEHICLE
      ${extraJoinSql}
      WHERE VEHICLE.status = 1
        AND VEHICLE.deleted = 0
        AND VEHICLE.owner_city IN (${placeholders})
        ${extraWhereSql}
      `,
      ...uniqueCities,
    )) as Array<{ total: bigint | number }>;

    return Number(rows?.[0]?.total ?? 0);
  };

  const counts = {
    activeVehiclesInMatchingCity: await countFor(),
    withVendorVehicleTypes: await countFor(
      `
      LEFT JOIN dvi_vendor_vehicle_types VENDOR_VEHICLE_TYPES
        ON VEHICLE.vehicle_type_id = VENDOR_VEHICLE_TYPES.vendor_vehicle_type_ID
        AND VEHICLE.vendor_id = VENDOR_VEHICLE_TYPES.vendor_id
      `,
      'AND VENDOR_VEHICLE_TYPES.vendor_vehicle_type_ID IS NOT NULL',
    ),
    withActiveVendorDetails: await countFor(
      `
      LEFT JOIN dvi_vendor_vehicle_types VENDOR_VEHICLE_TYPES
        ON VEHICLE.vehicle_type_id = VENDOR_VEHICLE_TYPES.vendor_vehicle_type_ID
        AND VEHICLE.vendor_id = VENDOR_VEHICLE_TYPES.vendor_id
      LEFT JOIN dvi_vendor_details VENDOR_DETAILS
        ON VENDOR_DETAILS.vendor_id = VEHICLE.vendor_id
      `,
      `
      AND VENDOR_VEHICLE_TYPES.vendor_vehicle_type_ID IS NOT NULL
      AND VENDOR_DETAILS.status = 1
      AND VENDOR_DETAILS.deleted = 0
      `,
    ),
    withActiveVendorBranches: await countFor(
      `
      LEFT JOIN dvi_vendor_vehicle_types VENDOR_VEHICLE_TYPES
        ON VEHICLE.vehicle_type_id = VENDOR_VEHICLE_TYPES.vendor_vehicle_type_ID
        AND VEHICLE.vendor_id = VENDOR_VEHICLE_TYPES.vendor_id
      LEFT JOIN dvi_vendor_details VENDOR_DETAILS
        ON VENDOR_DETAILS.vendor_id = VEHICLE.vendor_id
      LEFT JOIN dvi_vendor_branches VENDOR_BRANCH_DETAILS
        ON VENDOR_BRANCH_DETAILS.vendor_branch_id = VEHICLE.vendor_branch_id
      `,
      `
      AND VENDOR_VEHICLE_TYPES.vendor_vehicle_type_ID IS NOT NULL
      AND VENDOR_DETAILS.status = 1
      AND VENDOR_DETAILS.deleted = 0
      AND VENDOR_BRANCH_DETAILS.status = 1
      AND VENDOR_BRANCH_DETAILS.deleted = 0
      `,
    ),
    withVehicleTypes: await countFor(
      `
      LEFT JOIN dvi_vendor_vehicle_types VENDOR_VEHICLE_TYPES
        ON VEHICLE.vehicle_type_id = VENDOR_VEHICLE_TYPES.vendor_vehicle_type_ID
        AND VEHICLE.vendor_id = VENDOR_VEHICLE_TYPES.vendor_id
      LEFT JOIN dvi_vendor_details VENDOR_DETAILS
        ON VENDOR_DETAILS.vendor_id = VEHICLE.vendor_id
      LEFT JOIN dvi_vendor_branches VENDOR_BRANCH_DETAILS
        ON VENDOR_BRANCH_DETAILS.vendor_branch_id = VEHICLE.vendor_branch_id
      LEFT JOIN dvi_vehicle_type VEHICLE_TYPES
        ON VEHICLE_TYPES.vehicle_type_id = VENDOR_VEHICLE_TYPES.vehicle_type_id
      `,
      `
      AND VENDOR_VEHICLE_TYPES.vendor_vehicle_type_ID IS NOT NULL
      AND VENDOR_DETAILS.status = 1
      AND VENDOR_DETAILS.deleted = 0
      AND VENDOR_BRANCH_DETAILS.status = 1
      AND VENDOR_BRANCH_DETAILS.deleted = 0
      AND VEHICLE_TYPES.vehicle_type_id IS NOT NULL
      `,
    ),
  };

  const finalDistinctVehicleTypes = await prisma.$queryRawUnsafe(
    `
    SELECT DISTINCT
      VENDOR_VEHICLE_TYPES.vehicle_type_id,
      VEHICLE_TYPES.vehicle_type_title,
      VEHICLE_TYPES.occupancy
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
    ...uniqueCities,
  );

  const [ownerCityMismatch, vendorInactive, branchInactive, vendorVehicleTypeMissing, vehicleTypeMissing] =
    await Promise.all([
      prisma.$queryRawUnsafe(
        `
        SELECT COUNT(DISTINCT vehicle_id) AS total
        FROM dvi_vehicle
        WHERE status = 1
          AND deleted = 0
          AND owner_city NOT IN (${placeholders})
        `,
        ...uniqueCities,
      ),
      prisma.$queryRawUnsafe(
        `
        SELECT COUNT(DISTINCT VEHICLE.vehicle_id) AS total
        FROM dvi_vehicle VEHICLE
        LEFT JOIN dvi_vendor_details VENDOR_DETAILS
          ON VENDOR_DETAILS.vendor_id = VEHICLE.vendor_id
        WHERE VEHICLE.status = 1
          AND VEHICLE.deleted = 0
          AND VEHICLE.owner_city IN (${placeholders})
          AND (
            VENDOR_DETAILS.vendor_id IS NULL
            OR VENDOR_DETAILS.status <> 1
            OR VENDOR_DETAILS.deleted <> 0
          )
        `,
        ...uniqueCities,
      ),
      prisma.$queryRawUnsafe(
        `
        SELECT COUNT(DISTINCT VEHICLE.vehicle_id) AS total
        FROM dvi_vehicle VEHICLE
        LEFT JOIN dvi_vendor_branches VENDOR_BRANCH_DETAILS
          ON VENDOR_BRANCH_DETAILS.vendor_branch_id = VEHICLE.vendor_branch_id
        WHERE VEHICLE.status = 1
          AND VEHICLE.deleted = 0
          AND VEHICLE.owner_city IN (${placeholders})
          AND (
            VENDOR_BRANCH_DETAILS.vendor_branch_id IS NULL
            OR VENDOR_BRANCH_DETAILS.status <> 1
            OR VENDOR_BRANCH_DETAILS.deleted <> 0
          )
        `,
        ...uniqueCities,
      ),
      prisma.$queryRawUnsafe(
        `
        SELECT COUNT(DISTINCT VEHICLE.vehicle_id) AS total
        FROM dvi_vehicle VEHICLE
        LEFT JOIN dvi_vendor_vehicle_types VENDOR_VEHICLE_TYPES
          ON VEHICLE.vehicle_type_id = VENDOR_VEHICLE_TYPES.vendor_vehicle_type_ID
          AND VEHICLE.vendor_id = VENDOR_VEHICLE_TYPES.vendor_id
        WHERE VEHICLE.status = 1
          AND VEHICLE.deleted = 0
          AND VEHICLE.owner_city IN (${placeholders})
          AND VENDOR_VEHICLE_TYPES.vendor_vehicle_type_ID IS NULL
        `,
        ...uniqueCities,
      ),
      prisma.$queryRawUnsafe(
        `
        SELECT COUNT(DISTINCT VEHICLE.vehicle_id) AS total
        FROM dvi_vehicle VEHICLE
        LEFT JOIN dvi_vendor_vehicle_types VENDOR_VEHICLE_TYPES
          ON VEHICLE.vehicle_type_id = VENDOR_VEHICLE_TYPES.vendor_vehicle_type_ID
          AND VEHICLE.vendor_id = VENDOR_VEHICLE_TYPES.vendor_id
        LEFT JOIN dvi_vehicle_type VEHICLE_TYPES
          ON VEHICLE_TYPES.vehicle_type_id = VENDOR_VEHICLE_TYPES.vehicle_type_id
        WHERE VEHICLE.status = 1
          AND VEHICLE.deleted = 0
          AND VEHICLE.owner_city IN (${placeholders})
          AND (
            VEHICLE_TYPES.vehicle_type_id IS NULL
            OR VEHICLE_TYPES.status <> 1
            OR VEHICLE_TYPES.deleted <> 0
          )
        `,
        ...uniqueCities,
      ),
    ]);

  const readTotal = (rows: any[]) => Number(rows?.[0]?.total ?? 0);

  return {
    counts,
    finalDistinctVehicleTypes,
    droppedReasons: {
      ownerCityMismatch: readTotal(ownerCityMismatch),
      vendorInactiveOrDeleted: readTotal(vendorInactive),
      branchInactiveOrDeleted: readTotal(branchInactive),
      vendorVehicleTypeMissing: readTotal(vendorVehicleTypeMissing),
      vehicleTypeMissingOrInactive: readTotal(vehicleTypeMissing),
    },
  };
}

async function main() {
  const sourceArg = parseArgValue('--source') ?? process.env.SOURCE_LOCATIONS ?? '';
  const nextArg = parseArgValue('--next') ?? process.env.NEXT_LOCATIONS ?? '';

  const sourceLocation = splitLocations(sourceArg);
  const nextVisitingLocation = splitLocations(nextArg);
  const uniqueLocations = Array.from(
    new Set([...sourceLocation, ...nextVisitingLocation].map((item) => item.trim()).filter(Boolean)),
  );

  printSection('1. Input payload', {
    sourceLocation,
    nextVisitingLocation,
    uniqueLocations,
  });

  const { exact, normalized } = await buildStoredLocationMaps();

  const mappingChecks = [];
  for (const location of uniqueLocations) {
    mappingChecks.push(await getMappingCheck(location));
  }
  printSection('2. dvi_stored_locations mapping check', mappingChecks);

  const currentEligibleCities = deriveCurrentEligibleCities(uniqueLocations, exact);
  const improved = deriveImprovedEligibleCities(uniqueLocations, exact, normalized);
  printSection('3. Derived eligibleCities', {
    currentBackendExactOnly: currentEligibleCities,
    improvedBackendCandidateCities: improved.eligibleCities,
    normalizedCandidateCities: improved.diagnostics,
  });

  const allCandidateCities = Array.from(
    new Set([
      ...currentEligibleCities,
      ...improved.eligibleCities,
      ...uniqueLocations.map((location) => firstToken(location)).filter(Boolean),
    ]),
  );

  const vehicleDiagnostics = [];
  for (const city of allCandidateCities) {
    vehicleDiagnostics.push(await getVehicleDiagnostics(city));
  }
  printSection('4. Vehicle data check', vehicleDiagnostics);

  const joinDiagnostics = await getJoinDiagnostics(improved.eligibleCities);
  printSection('5. Step-by-step join diagnosis', joinDiagnostics);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
