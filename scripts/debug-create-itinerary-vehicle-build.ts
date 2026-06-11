import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

type PlanRow = {
  itinerary_plan_ID: number;
  arrival_location: string | null;
  departure_location: string | null;
  pick_up_date_and_time: Date | null;
  trip_start_date_and_time: Date | null;
  trip_end_date_and_time: Date | null;
  no_of_days: number | null;
};

type RouteRow = {
  itinerary_route_ID: number;
  location_name: string | null;
  next_visiting_location: string | null;
  itinerary_route_date: Date | null;
  no_of_km: string | null;
};

type RequestedVehicleRow = {
  vehicle_type_id: number;
  vehicle_count: number;
  vehicle_type_title: string | null;
};

type VendorBranchCandidateRow = {
  vendor_id: number;
  vendor_name: string | null;
  vendor_branch_id: number;
  vendor_branch_name: string | null;
  vendor_branch_location: string | null;
  vendor_branch_city: number | null;
  branch_city_name: string | null;
  matched_route_city: string | null;
  matched_by_name_or_location_token: number;
  matched_by_city_id: number;
};

type VehicleCandidateRow = {
  vehicle_id: number;
  vendor_id: number;
  vendor_name: string | null;
  vendor_branch_id: number;
  vendor_branch_name: string | null;
  vendor_branch_city: number | null;
  vehicle_type_id: number | null;
  owner_city: string | null;
  owner_city_name: string | null;
  status: number;
  deleted: number;
};

type VendorRateCheckRow = {
  vendor_id: number;
  vendor_name: string | null;
  selected_vehicle_type_id: number;
  modern_rate_exists: number;
  legacy_rate_exists: number;
};

const prisma = new PrismaClient();

function parseArg(flag: string): string | undefined {
  const prefix = `${flag}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function toNum(value: unknown): number {
  const num =
    typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isFinite(num) ? num : 0;
}

function normalizeCityToken(value: string): string {
  const base = String(value || '').toLowerCase().trim();
  if (!base) return '';
  const firstPart = base.split(',')[0] || base;
  const normalized = firstPart
    .replace(
      /\b(international|domestic|airport|railway|station|bus|stand|hotel|lodge|temple|mall|palace|park|garden|museum|planetarium|aquarium)\b/g,
      ' ',
    )
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const cityAliases: Record<string, string> = {
    bengaluru: 'bangalore',
    bangaluru: 'bangalore',
    bengalore: 'bangalore',
  };

  return cityAliases[normalized] || normalized;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

function firstToken(value: string): string {
  return String(value ?? '').split(',')[0]?.trim() ?? '';
}

function logSection(title: string, payload: unknown) {
  console.log(`\n=== ${title} ===`);
  console.log(
    JSON.stringify(
      payload,
      (_key, value) => (typeof value === 'bigint' ? Number(value) : value),
      2,
    ),
  );
}

async function deriveEligibleCitiesExactlyAsEngine(
  routes: RouteRow[],
): Promise<{
  locationTokens: string[];
  eligibleCities: string[];
  firstTokenFallbacks: string[];
  resolvedCityRows: Array<{ id: number; name: string }>;
  eligibleOwnerCityValues: string[];
}> {
  const locationTokens = uniqueStrings(
    routes.flatMap((route) => [
      String(route.location_name ?? '').trim(),
      String(route.next_visiting_location ?? '').trim(),
    ]),
  );

  let eligibleCities: string[] = [];

  if (locationTokens.length > 0) {
    const [storedSrcRows, storedDestRows] = await Promise.all([
      prisma.dvi_stored_locations.findMany({
        where: {
          deleted: 0,
          status: 1,
          source_location: { in: locationTokens },
        } as any,
        select: {
          source_location_city: true,
        },
      } as any),
      prisma.dvi_stored_locations.findMany({
        where: {
          deleted: 0,
          status: 1,
          destination_location: { in: locationTokens },
        } as any,
        select: {
          destination_location_city: true,
        },
      } as any),
    ]);

    const citySet = new Set<string>();

    for (const row of storedSrcRows) {
      const city = String(row.source_location_city ?? '').trim();
      if (city) citySet.add(city);
    }

    for (const row of storedDestRows) {
      const city = String(row.destination_location_city ?? '').trim();
      if (city) citySet.add(city);
    }

    eligibleCities = Array.from(citySet);
  }

  const firstTokenFallbacks = uniqueStrings(
    locationTokens.map((location) => firstToken(location)).filter(Boolean),
  );

  const candidateNames = uniqueStrings([
    ...eligibleCities,
    ...locationTokens,
    ...firstTokenFallbacks,
  ]);

  const candidateLower = new Set(candidateNames.map((value) => value.toLowerCase()));
  const candidateNormalized = new Set(
    candidateNames.map((value) => normalizeCityToken(value)).filter(Boolean),
  );

  const cityRows = await prisma.dvi_cities.findMany({
    where: {
      deleted: 0,
    },
    select: {
      id: true,
      name: true,
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });

  const resolvedCityRows = cityRows
    .map((row) => ({
      id: Number(row.id),
      name: String(row.name ?? '').trim(),
    }))
    .filter(
      (row) =>
        row.id > 0 &&
        row.name &&
        (candidateLower.has(row.name.toLowerCase()) ||
          candidateNormalized.has(normalizeCityToken(row.name))),
    );

  const eligibleOwnerCityValues = uniqueStrings([
    ...eligibleCities,
    ...resolvedCityRows.map((row) => String(row.id)),
  ]);

  return {
    locationTokens,
    eligibleCities,
    firstTokenFallbacks,
    resolvedCityRows,
    eligibleOwnerCityValues,
  };
}

function buildVehicleTypeOr(planVehicleTypeId: number) {
  return [
    { vehicle_type_id: planVehicleTypeId },
    { vendor_vehicle_type_ID: planVehicleTypeId },
  ];
}

async function main() {
  const planId = Number(parseArg('--plan') ?? 0);
  if (!Number.isFinite(planId) || planId <= 0) {
    throw new Error('Usage: npx tsx scripts/debug-create-itinerary-vehicle-build.ts --plan=9565');
  }

  const plan = (await prisma.dvi_itinerary_plan_details.findUnique({
    where: { itinerary_plan_ID: planId },
    select: {
      itinerary_plan_ID: true,
      arrival_location: true,
      departure_location: true,
      pick_up_date_and_time: true,
      trip_start_date_and_time: true,
      trip_end_date_and_time: true,
      no_of_days: true,
    },
  })) as PlanRow | null;

  if (!plan) {
    throw new Error(`Plan ${planId} not found`);
  }

  const routes = (await prisma.dvi_itinerary_route_details.findMany({
    where: {
      itinerary_plan_ID: planId,
      status: 1,
      deleted: 0,
    } as any,
    select: {
      itinerary_route_ID: true,
      location_name: true,
      next_visiting_location: true,
      itinerary_route_date: true,
      no_of_km: true,
    },
    orderBy: { itinerary_route_ID: 'asc' },
  } as any)) as RouteRow[];

  const derived = await deriveEligibleCitiesExactlyAsEngine(routes);
  const resolvedCityIds = derived.resolvedCityRows.map((row) => row.id);
  const resolvedCityNameById = new Map(
    derived.resolvedCityRows.map((row) => [row.id, row.name]),
  );

  logSection('A. Plan and routes', {
    plan: {
      itinerary_plan_ID: plan.itinerary_plan_ID,
      arrival_point: plan.arrival_location,
      departure_point: plan.departure_location,
      pick_up_date_and_time: plan.pick_up_date_and_time,
      trip_start_date_and_time: plan.trip_start_date_and_time,
      trip_end_date_and_time: plan.trip_end_date_and_time,
      no_of_days: plan.no_of_days,
    },
    routes: routes.map((route) => ({
      itinerary_route_ID: route.itinerary_route_ID,
      location_name: route.location_name,
      next_visiting_location: route.next_visiting_location,
      itinerary_route_date: route.itinerary_route_date,
      no_of_km: route.no_of_km,
    })),
    derived_eligible_city_names_exactly_as_engine: derived.eligibleCities,
    resolved_dvi_cities: derived.resolvedCityRows,
    first_token_fallback_city_names: derived.firstTokenFallbacks,
    eligible_owner_city_values: derived.eligibleOwnerCityValues,
  });

  const selectedVehicleRows = (await prisma.$queryRawUnsafe(
    `
    SELECT
      REQUEST.vehicle_type_id,
      REQUEST.vehicle_count,
      VEHICLE_TYPE.vehicle_type_title
    FROM dvi_itinerary_plan_vehicle_details REQUEST
    LEFT JOIN dvi_vehicle_type VEHICLE_TYPE
      ON VEHICLE_TYPE.vehicle_type_id = REQUEST.vehicle_type_id
    WHERE REQUEST.itinerary_plan_id = ?
      AND REQUEST.status = 1
      AND REQUEST.deleted = 0
    ORDER BY REQUEST.vehicle_type_id ASC
    `,
    planId,
  )) as RequestedVehicleRow[];

  logSection('B. Selected vehicle types', selectedVehicleRows);

  const vendorBranchCandidates = (await prisma.$queryRawUnsafe(
    `
    SELECT
      VENDOR.vendor_id,
      VENDOR.vendor_name,
      BRANCH.vendor_branch_id,
      BRANCH.vendor_branch_name,
      BRANCH.vendor_branch_location,
      BRANCH.vendor_branch_city,
      CITY.name AS branch_city_name
    FROM dvi_vendor_details VENDOR
    INNER JOIN dvi_vendor_branches BRANCH
      ON BRANCH.vendor_id = VENDOR.vendor_id
    LEFT JOIN dvi_cities CITY
      ON CITY.id = BRANCH.vendor_branch_city
      AND CITY.deleted = 0
    WHERE VENDOR.status = 1
      AND VENDOR.deleted = 0
      AND BRANCH.status = 1
      AND BRANCH.deleted = 0
    ORDER BY VENDOR.vendor_id ASC, BRANCH.vendor_branch_id ASC
    `,
  )) as Array<{
    vendor_id: number;
    vendor_name: string | null;
    vendor_branch_id: number;
    vendor_branch_name: string | null;
    vendor_branch_location: string | null;
    vendor_branch_city: number | null;
    branch_city_name: string | null;
  }>;

  const branchDiagnostics: VendorBranchCandidateRow[] = [];
  for (const branch of vendorBranchCandidates) {
    const nameToken = normalizeCityToken(String(branch.vendor_branch_name ?? ''));
    const locationToken = normalizeCityToken(
      String(branch.vendor_branch_location ?? ''),
    );
    const matchedRouteCity =
      derived.eligibleCities.find((city) => {
        const cityToken = normalizeCityToken(city);
        return cityToken && (cityToken === nameToken || cityToken === locationToken);
      }) ?? null;

    const matchedByToken = matchedRouteCity ? 1 : 0;
    const matchedByCityId =
      resolvedCityIds.includes(Number(branch.vendor_branch_city ?? 0)) ? 1 : 0;

    if (matchedByToken || matchedByCityId) {
      branchDiagnostics.push({
        vendor_id: branch.vendor_id,
        vendor_name: branch.vendor_name,
        vendor_branch_id: branch.vendor_branch_id,
        vendor_branch_name: branch.vendor_branch_name,
        vendor_branch_location: branch.vendor_branch_location,
        vendor_branch_city: branch.vendor_branch_city,
        branch_city_name: branch.branch_city_name,
        matched_route_city: matchedRouteCity,
        matched_by_name_or_location_token: matchedByToken,
        matched_by_city_id: matchedByCityId,
      });
    }
  }

  logSection('C. Vendor/branch candidates', branchDiagnostics);

  const selectedVehicleTypeIds = uniqueStrings(
    selectedVehicleRows.map((row) => String(row.vehicle_type_id)),
  ).map(Number);
  const targetVehicleTypeIds = uniqueStrings(
    [...selectedVehicleTypeIds, 1, 23, 25, 21].map(String),
  ).map(Number);

  const oldVehicleMatches = (await prisma.$queryRawUnsafe(
    `
    SELECT
      VEHICLE.vehicle_id,
      VEHICLE.vendor_id,
      VENDOR.vendor_name,
      VEHICLE.vendor_branch_id,
      BRANCH.vendor_branch_name,
      BRANCH.vendor_branch_city,
      VEHICLE.vehicle_type_id,
      VEHICLE.owner_city,
      CITY.name AS owner_city_name,
      VEHICLE.status,
      VEHICLE.deleted
    FROM dvi_vehicle VEHICLE
    LEFT JOIN dvi_vendor_details VENDOR
      ON VENDOR.vendor_id = VEHICLE.vendor_id
    LEFT JOIN dvi_vendor_branches BRANCH
      ON BRANCH.vendor_branch_id = VEHICLE.vendor_branch_id
    LEFT JOIN dvi_cities CITY
      ON CITY.id = CAST(VEHICLE.owner_city AS UNSIGNED)
      AND CITY.deleted = 0
    WHERE VEHICLE.status = 1
      AND VEHICLE.deleted = 0
      AND VEHICLE.owner_city IN (${derived.eligibleCities.map(() => '?').join(', ') || "''"})
      AND VEHICLE.vehicle_type_id IN (${targetVehicleTypeIds.map(() => '?').join(', ')})
    ORDER BY VEHICLE.vendor_id ASC, VEHICLE.vendor_branch_id ASC, VEHICLE.vehicle_id ASC
    `,
    ...derived.eligibleCities,
    ...targetVehicleTypeIds,
  )) as VehicleCandidateRow[];

  const modernVehicleMatches = (await prisma.$queryRawUnsafe(
    `
    SELECT
      VEHICLE.vehicle_id,
      VEHICLE.vendor_id,
      VENDOR.vendor_name,
      VEHICLE.vendor_branch_id,
      BRANCH.vendor_branch_name,
      BRANCH.vendor_branch_city,
      VEHICLE.vehicle_type_id,
      VEHICLE.owner_city,
      CITY.name AS owner_city_name,
      VEHICLE.status,
      VEHICLE.deleted
    FROM dvi_vehicle VEHICLE
    LEFT JOIN dvi_vendor_details VENDOR
      ON VENDOR.vendor_id = VEHICLE.vendor_id
    LEFT JOIN dvi_vendor_branches BRANCH
      ON BRANCH.vendor_branch_id = VEHICLE.vendor_branch_id
    LEFT JOIN dvi_cities CITY
      ON CITY.id = CAST(VEHICLE.owner_city AS UNSIGNED)
      AND CITY.deleted = 0
    WHERE VEHICLE.status = 1
      AND VEHICLE.deleted = 0
      AND (
        VEHICLE.owner_city IN (${derived.eligibleOwnerCityValues.map(() => '?').join(', ') || "''"})
        OR BRANCH.vendor_branch_city IN (${resolvedCityIds.map(() => '?').join(', ') || '0'})
      )
      AND VEHICLE.vehicle_type_id IN (${targetVehicleTypeIds.map(() => '?').join(', ')})
    ORDER BY VEHICLE.vendor_id ASC, VEHICLE.vendor_branch_id ASC, VEHICLE.vehicle_id ASC
    `,
    ...derived.eligibleOwnerCityValues,
    ...resolvedCityIds,
    ...targetVehicleTypeIds,
  )) as VehicleCandidateRow[];

  logSection('D. Vehicle matching', {
    selected_vehicle_type_ids: targetVehicleTypeIds,
    old_logic_owner_city_in_city_names: oldVehicleMatches,
    modern_logic_owner_city_or_branch_city: modernVehicleMatches,
  });

  const vehicleTypePlaceholders = targetVehicleTypeIds.map(() => '?').join(', ');
  const vendorRateMatches = (await prisma.$queryRawUnsafe(
    `
    SELECT
      VENDOR.vendor_id,
      VENDOR.vendor_name,
      PLAN_TYPES.selected_vehicle_type_id,
      CASE WHEN EXISTS (
        SELECT 1
        FROM dvi_vendor_vehicle_types MODERN
        WHERE MODERN.vendor_id = VENDOR.vendor_id
          AND MODERN.vehicle_type_id = PLAN_TYPES.selected_vehicle_type_id
          AND MODERN.status = 1
          AND MODERN.deleted = 0
      ) THEN 1 ELSE 0 END AS modern_rate_exists,
      CASE WHEN EXISTS (
        SELECT 1
        FROM dvi_vendor_vehicle_types LEGACY
        WHERE LEGACY.vendor_id = VENDOR.vendor_id
          AND LEGACY.vendor_vehicle_type_ID = PLAN_TYPES.selected_vehicle_type_id
          AND LEGACY.status = 1
          AND LEGACY.deleted = 0
      ) THEN 1 ELSE 0 END AS legacy_rate_exists
    FROM (
      SELECT DISTINCT vendor_id, vendor_name
      FROM dvi_vendor_details
      WHERE status = 1
        AND deleted = 0
    ) VENDOR
    CROSS JOIN (
      SELECT ? AS selected_vehicle_type_id
      ${targetVehicleTypeIds.slice(1).map(() => 'UNION ALL SELECT ?').join(' ')}
    ) PLAN_TYPES
    WHERE EXISTS (
      SELECT 1
      FROM dvi_vendor_branches BRANCH
      WHERE BRANCH.vendor_id = VENDOR.vendor_id
        AND BRANCH.status = 1
        AND BRANCH.deleted = 0
        AND BRANCH.vendor_branch_city IN (${resolvedCityIds.map(() => '?').join(', ') || '0'})
    )
    ORDER BY VENDOR.vendor_id ASC, PLAN_TYPES.selected_vehicle_type_id ASC
    `,
    ...targetVehicleTypeIds,
    ...resolvedCityIds,
  )) as VendorRateCheckRow[];

  logSection('E. Vendor rate matching', vendorRateMatches);

  const vendorBranchesByVendor = new Map<number, VendorBranchCandidateRow[]>();
  for (const branch of branchDiagnostics) {
    const rows = vendorBranchesByVendor.get(branch.vendor_id) ?? [];
    rows.push(branch);
    vendorBranchesByVendor.set(branch.vendor_id, rows);
  }

  const modernVehicleByVendorAndType = new Map<string, VehicleCandidateRow[]>();
  for (const row of modernVehicleMatches) {
    const key = `${row.vendor_id}|${row.vehicle_type_id ?? 0}`;
    const rows = modernVehicleByVendorAndType.get(key) ?? [];
    rows.push(row);
    modernVehicleByVendorAndType.set(key, rows);
  }

  const vendorRateByVendorAndType = new Map<string, VendorRateCheckRow>();
  for (const row of vendorRateMatches) {
    vendorRateByVendorAndType.set(
      `${row.vendor_id}|${row.selected_vehicle_type_id}`,
      row,
    );
  }

  const insertionDiagnosis = targetVehicleTypeIds.map((planVehicleTypeId) => {
    const matchingBranches = branchDiagnostics.filter(
      (branch) =>
        branch.matched_by_name_or_location_token === 1 ||
        branch.matched_by_city_id === 1,
    );
    if (!matchingBranches.length) {
      return {
        vehicle_type_id: planVehicleTypeId,
        status: 'SKIPPED',
        reason: 'no branch matched',
      };
    }

    const vendorReasons = matchingBranches.map((branch) => {
      const modernRows =
        modernVehicleByVendorAndType.get(`${branch.vendor_id}|${planVehicleTypeId}`) ?? [];
      const rateRow =
        vendorRateByVendorAndType.get(`${branch.vendor_id}|${planVehicleTypeId}`) ?? null;

      let reason = 'would insert';
      if (!modernRows.length) {
        reason = branch.matched_by_city_id || branch.matched_by_name_or_location_token
          ? 'no active vehicle'
          : 'city mismatch';
      } else if (!rateRow || !rateRow.modern_rate_exists) {
        reason = 'no active vendor rate row';
      }

      return {
        vendor_id: branch.vendor_id,
        vendor_name: branch.vendor_name,
        vendor_branch_id: branch.vendor_branch_id,
        branch_city_name: branch.branch_city_name,
        branch_match_by_token: branch.matched_by_name_or_location_token,
        branch_match_by_city_id: branch.matched_by_city_id,
        modern_vehicle_rows: modernRows.map((row) => ({
          vehicle_id: row.vehicle_id,
          vehicle_type_id: row.vehicle_type_id,
          owner_city: row.owner_city,
        })),
        rate_check: rateRow,
        reason,
      };
    });

    return {
      vehicle_type_id: planVehicleTypeId,
      status: vendorReasons.some((row) => row.reason === 'would insert')
        ? 'INSERTABLE'
        : 'SKIPPED',
      vendor_diagnosis: vendorReasons,
    };
  });

  logSection('F. Insert diagnosis', insertionDiagnosis);

  const [eligibleCounts, vehicleDetailCounts] = await Promise.all([
    prisma.dvi_itinerary_plan_vendor_eligible_list.count({
      where: {
        itinerary_plan_id: planId,
        status: 1,
        deleted: 0,
      },
    }),
    prisma.dvi_itinerary_plan_vendor_vehicle_details.count({
      where: {
        itinerary_plan_id: planId,
        status: 1,
        deleted: 0,
      },
    }),
  ]);

  logSection('G. Current DB result', {
    itinerary_plan_id: planId,
    eligible_count: eligibleCounts,
    vehicle_details_count: vehicleDetailCounts,
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
