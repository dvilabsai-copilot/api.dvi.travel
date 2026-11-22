import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import {
  calculateRouteVehicleDetails,
  getStoredLocationCity,
  getVehicleLocationDetails,
  type RouteData,
  type RouteCalculationResult,
  type VehicleCalculationContext,
  type VehicleCalcRunCache,
} from '../itineraries/engines/vehicle-calculation.helpers';
import { resolveVehicleOriginCoordinates } from '../itineraries/utils/vehicle-origin-coordinates.util';
import { buildPermitLocationChain } from '../itineraries/engines/route-engine.service';

const money = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const numberOf = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const normalize = (value: unknown): string => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const timeValue = (value: Date | null): string | undefined =>
  value ? `${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')}:${String(value.getUTCSeconds()).padStart(2, '0')}` : undefined;

export interface UpgradePriceRow {
  vehicleTypeId: number;
  vehicleName: string;
  capacity: number;
  unitPrice: number | null;
  price: number | null;
  extraPayment: number | null;
  quantity: number;
  source: 'saved_quote' | 'calculated_preview' | 'unavailable';

  candidateIdentity?: {
    vendorId: number;
    branchId: number;
    vendorVehicleTypeId: number;
    vehicleId: number;
  };

  breakdown?: {
    rental: number;
    toll: number;
    parking: number;
    driver: number;
    permit: number;
    extraKm: number;
    earlyLateCharges: number;
    gst: number;
    vendorMargin: number;
    vendorMarginGst: number;
  };
}

type PermitPreviewContext = {
  viaByRoute: Map<number, string[]>;
  stateCache: Map<string, number | null>;
};

/** Read-only vehicle upgrade quote preview: never changes plan, vendor assignments, or prices. */
@Injectable()
export class VehicleUpgradePricingService {
  constructor(private readonly prisma: PrismaService) {}

  private async locationState(name: string, cache: Map<string, number | null>): Promise<number | null> {
    const key = normalize(name);
    if (!key) return null;
    if (cache.has(key)) return cache.get(key) ?? null;

    const stored = await this.prisma.dvi_stored_locations.findFirst({
      where: {
        OR: [{ source_location: name }, { destination_location: name }],
        status: 1,
        deleted: 0,
      },
      orderBy: { location_ID: 'desc' },
      select: { source_location: true, source_location_state: true, destination_location_state: true },
    });
    const stateName =
      normalize(stored?.source_location) === key
        ? stored?.source_location_state
        : stored?.destination_location_state;
    const via = !stateName ? await this.prisma.dvi_stored_location_via_routes.findFirst({
      where: { via_route_location: name, status: 1, deleted: 0 },
      orderBy: { via_route_location_ID: 'desc' },
      select: { via_route_location_state: true },
    }) : null;
    const state = String(stateName || via?.via_route_location_state || '').trim();
    let resolved = state ? await this.prisma.dvi_permit_state.findFirst({
      where: { status: 1, deleted: 0, state_name: state },
      select: { permit_state_id: true },
    }) : null;
    if (!resolved && ['pondicherry', 'puducherry'].includes(normalize(state))) {
      resolved = await this.prisma.dvi_permit_state.findFirst({
        where: { status: 1, deleted: 0, state_name: normalize(state) === 'pondicherry' ? 'Puducherry' : 'Pondicherry' },
        select: { permit_state_id: true },
      });
    }
    const id = resolved ? numberOf(resolved.permit_state_id) : null;
    cache.set(key, id);
    return id;
  }

  /** Same route/vehicle-origin state transition rules as the existing permit rebuild. */
  private async previewPermits(
    planId: number,
    vendorId: number,
    branchId: number,
    vendorTypeId: number,
    registration: string | null,
    origin: string,
    routes: Array<{ itinerary_route_ID: number; itinerary_route_date: Date | null; location_name: string | null; next_visiting_location: string | null }>,
    previewContext?: PermitPreviewContext,
  ): Promise<number> {
    const code = String(registration || '').slice(0, 2).toUpperCase();
    if (!code) return 0;
    const vehicleState = await this.prisma.dvi_permit_state.findFirst({
      where: { state_code: code, status: 1, deleted: 0 },
      select: { permit_state_id: true },
    });
    const vehicleStateId = numberOf(vehicleState?.permit_state_id);
    if (!vehicleStateId) return 0;

    const viaByRoute = previewContext?.viaByRoute ?? new Map<number, string[]>();
    if (!previewContext) {
      const viaRows = await this.prisma.dvi_itinerary_via_route_details.findMany({
        where: { itinerary_plan_ID: planId, status: 1, deleted: 0 },
        orderBy: [{ itinerary_route_date: 'asc' }, { itinerary_via_route_ID: 'asc' }],
        select: { itinerary_route_ID: true, itinerary_via_location_name: true },
      });
      for (const item of viaRows) {
        const id = numberOf(item.itinerary_route_ID);
        const value = String(item.itinerary_via_location_name || '').trim();
        if (id && value) viaByRoute.set(id, [...(viaByRoute.get(id) ?? []), value]);
      }
    }
    const stateCache = previewContext?.stateCache ?? new Map<string, number | null>();
    const alreadyCharged = new Map<string, Date>();
    let total = 0;
    for (const [index, route] of routes.entries()) {
      const date = route.itinerary_route_date;
      if (!date) continue;
      const chain = buildPermitLocationChain({
        routeCount: index + 1,
        totalRoutes: routes.length,
        vehicleOrigin: origin,
        sourceLocation: route.location_name,
        viaLocations: viaByRoute.get(route.itinerary_route_ID) || [],
        destinationLocation: route.next_visiting_location,
      });
      const states = await Promise.all(chain.map((name) => this.locationState(name, stateCache)));
      for (let i = 1; i < states.length; i++) {
        const from = states[i - 1];
        const to = states[i];
        if (!from || !to || from === to || to === vehicleStateId) continue;
        const key = `${vehicleStateId}:${to}`;
        const previousDate = alreadyCharged.get(key);
        if (previousDate && date.getTime() - previousDate.getTime() <= 6 * 24 * 60 * 60 * 1000) continue;
        const permit = await this.prisma.dvi_permit_cost.findFirst({
          where: {
            vendor_id: vendorId,
            vehicle_type_id: vendorTypeId,
            source_state_id: vehicleStateId,
            destination_state_id: to,
            status: 1,
            deleted: 0,
          },
          orderBy: { permit_cost_id: 'asc' },
          select: { permit_cost: true },
        });
        const amount = numberOf(permit?.permit_cost);
        if (amount > 0) {
          total += amount;
          alreadyCharged.set(key, date);
        }
      }
    }
    void branchId;
    return money(total);
  }

  private async quoteVehicle(
    planId: number,
    typeId: number,
    quantity: number,
    mapping: { vendor_vehicle_type_ID: number; vendor_id: number; driver_batta: number; food_cost: number; accomodation_cost: number; extra_cost: number; driver_early_morning_charges: number; driver_evening_charges: number },
    vehicle: {
      vehicle_id: number; vendor_branch_id: number; vehicle_location_id: number;
      vehicle_origin: string | null; vehicle_origin_latitude: number | null; vehicle_origin_longitude: number | null;
      owner_city: string | null; registration_number: string | null;
      extra_km_charge: number; extra_hour_charge: number; early_morning_charges: number; evening_charges: number;
    },
    vendor: { vendor_origin_latitude: number | null; vendor_origin_longitude: number | null; vendor_margin: number; vendor_margin_gst_type: number; vendor_margin_gst_percentage: number },
    branch: { vendor_branch_gst_type: number; vendor_branch_gst: number; vendor_branch_location: string | null; vendor_branch_city: number },
    routes: Array<{ itinerary_route_ID: number; itinerary_route_date: Date | null; location_name: string | null; next_visiting_location: string | null; no_of_km: string | null; route_start_time: Date | null; route_end_time: Date | null }>,
    sharedCache?: VehicleCalcRunCache,
    previewContext?: PermitPreviewContext,
  ): Promise<Pick<UpgradePriceRow, 'unitPrice' | 'price' | 'breakdown'> | null> {
    // Keep branch-specific vehicle origin data isolated between candidates.
    const cache = sharedCache
      ? { ...sharedCache, vehicleLocationDetails: new Map() }
      : undefined;
    const branchCity = await this.prisma.dvi_cities.findFirst({
      where: { id: branch.vendor_branch_city, deleted: 0 },
      select: { name: true },
    });
    const fallbackOrigin = String(branchCity?.name || branch.vendor_branch_location || '').trim();
    const originData = await getVehicleLocationDetails(
      this.prisma, vehicle.vehicle_location_id,
      fallbackOrigin, fallbackOrigin, cache,
    );
    const originCoords = resolveVehicleOriginCoordinates(vehicle, vendor, originData);
    const activeKmLimit = await this.prisma.dvi_kms_limit.findFirst({
      where: { vendor_id: mapping.vendor_id, vendor_vehicle_type_id: mapping.vendor_vehicle_type_ID,
        status: 1, deleted: 0 },
      orderBy: { kms_limit_id: 'desc' },
      select: { kms_limit: true },
    });
    const ctx: VehicleCalculationContext = {
      prisma: this.prisma,
      itinerary_plan_ID: planId,
      vehicle_type_id: typeId,
      vendor_id: mapping.vendor_id,
      vendor_vehicle_type_ID: mapping.vendor_vehicle_type_ID,
      vendor_branch_id: vehicle.vendor_branch_id,
      vehicle_location_id: vehicle.vehicle_location_id,
      vehicle_origin: originData.origin,
      vehicle_origin_city: originData.city,
      vehicle_origin_latitude: originCoords.latitude,
      vehicle_origin_longitude: originCoords.longitude,
      vehicle_origin_has_custom_coordinates: originCoords !== originData,
      extra_km_charge: numberOf(vehicle.extra_km_charge),
      extra_hour_charge: numberOf(vehicle.extra_hour_charge),
      get_kms_limit: 250,
      driver_batta: numberOf(mapping.driver_batta),
      food_cost: numberOf(mapping.food_cost),
      accomodation_cost: numberOf(mapping.accomodation_cost),
      extra_cost: numberOf(mapping.extra_cost),
      driver_early_morning_charges: numberOf(mapping.driver_early_morning_charges),
      driver_evening_charges: numberOf(mapping.driver_evening_charges),
      early_morning_charges: numberOf(vehicle.early_morning_charges),
      evening_charges: numberOf(vehicle.evening_charges),
      buildCache: cache,
    };
    const starts = await getStoredLocationCity(this.prisma, String(routes[0]?.location_name || ''), cache);
    const ends = await getStoredLocationCity(this.prisma, String(routes[routes.length - 1]?.next_visiting_location || ''), cache);
    ctx.force_local_trip = Boolean(starts && ends && normalize(starts) === normalize(ends));

    const days: RouteCalculationResult[] = [];
    let previousCity = '';
    for (let i = 0; i < routes.length; i++) {
      const row = routes[i];
      if (!row.itinerary_route_date) return null;
      const from = String(row.location_name || '').trim();
      const to = String(row.next_visiting_location || '').trim();
      if (!from || !to) return null;
      const data: RouteData = {
        itinerary_route_ID: row.itinerary_route_ID,
        itinerary_route_date: row.itinerary_route_date,
        location_name: from,
        next_visiting_location: to,
        no_of_km: row.no_of_km || '0',
        route_start_time: timeValue(row.route_start_time),
        route_end_time: timeValue(row.route_end_time),
      };
      const prevDate = routes[i - 1]?.itinerary_route_date?.toISOString().slice(0, 10);
      const date = row.itinerary_route_date.toISOString().slice(0, 10);
      const nextDate = routes[i + 1]?.itinerary_route_date?.toISOString().slice(0, 10);
      const result = await calculateRouteVehicleDetails(
        ctx, data, i + 1, routes.length, previousCity,
        !nextDate || nextDate !== date,
        !prevDate || prevDate !== date,
      );
    if (ctx.vendor_id === 60 && ctx.vehicle_type_id === 37) {
  console.log('[UPGRADE_PREVIEW_TIME_PROOF]', JSON.stringify({
    routeId: data.itinerary_route_ID,
    start: data.route_start_time,
    end: data.route_end_time,
    origin: ctx.vehicle_origin,
    pickup: result.TOTAL_PICKUP_DURATION,
    drop: result.TOTAL_DROP_DURATION,
    morningHours: result.morning_extra_time,
    eveningHours: result.evening_extra_time,
    rates: {
      morningDriver: ctx.driver_early_morning_charges,
      morningVehicle: ctx.early_morning_charges,
      eveningDriver: ctx.driver_evening_charges,
      eveningVehicle: ctx.evening_charges
    },
    charges: {
      morningDriver: result.DRIVER_MORINING_CHARGES,
      morningVehicle: result.VENDOR_VEHICLE_MORNING_CHARGES,
      eveningDriver: result.DRIVER_EVEINING_CHARGES,
      eveningVehicle: result.VENDOR_VEHICLE_EVENING_CHARGES
    }
  }));
}
// A route with travelled kilometres needs a valid rental rate,
// including local sightseeing routes with the same start and end.
const travelledKm =
  numberOf(result.TOTAL_PICKUP_KM) +
  numberOf(result.TOTAL_RUNNING_KM) +
  numberOf(result.SIGHT_SEEING_TRAVELLING_KM) +
  numberOf(result.TOTAL_DROP_KM);

if (
  result.vehicle_cost_for_the_day <= 0 &&
  (from !== to || travelledKm > 0)
) {
  if (process.env.DEBUG_VEHICLE_UPGRADE_PRICES === '1') {
    console.warn('[UPGRADE_MISSING_RENTAL_RATE]', {
      vehicleTypeId: typeId,
      vendorId: mapping.vendor_id,
      vendorVehicleTypeId: mapping.vendor_vehicle_type_ID,
      vendorBranchId: vehicle.vendor_branch_id,
      routeId: row.itinerary_route_ID,
      from,
      to,
    });
  }

  return null;
}
      days.push(result);
      previousCity = await getStoredLocationCity(this.prisma, to, cache);
    }
    if (!days.length) return null;

    const rental = days.reduce((sum, item) => sum + item.vehicle_cost_for_the_day, 0);
    const toll = days.reduce((sum, item) => sum + item.VEHICLE_TOLL_CHARGE, 0);
    const parking = days.reduce((sum, item) => sum + item.VEHICLE_PARKING_CHARGE, 0);
    const driver = days.reduce((sum, item) => sum + item.TOTAL_DRIVER_CHARGES, 0);
    const earlyLateCharges = days.reduce((sum, item) => sum +
      item.DRIVER_MORINING_CHARGES + item.VENDOR_VEHICLE_MORNING_CHARGES +
      item.DRIVER_EVEINING_CHARGES + item.VENDOR_VEHICLE_EVENING_CHARGES, 0);
    const localExtra = days.reduce((sum, item) => sum + item.TOTAL_LOCAL_EXTRA_KM_CHARGES, 0);
    const outstation = days.filter((item) => item.travel_type === 2);
    const outstationKm = outstation.reduce((sum, item) => sum +
      numberOf(item.TOTAL_PICKUP_KM) + numberOf(item.TOTAL_RUNNING_KM) +
      numberOf(item.SIGHT_SEEING_TRAVELLING_KM) + numberOf(item.TOTAL_DROP_KM), 0);
    const kmsLimitId = outstation.find((item) => item.kms_limit_id > 0)?.kms_limit_id || 0;
    const limit = kmsLimitId ? await this.prisma.dvi_kms_limit.findUnique({
      where: { kms_limit_id: kmsLimitId }, select: { kms_limit: true },
    }) : null;
    if (outstation.length && (!limit || limit.kms_limit <= 0)) return null;
    const outstationExtraKm = outstation.length ? Math.max(0, Math.ceil(outstationKm - numberOf(limit?.kms_limit) * outstation.length)) : 0;
    const extraKm = localExtra + money(outstationExtraKm * numberOf(vehicle.extra_km_charge));
    const permit = await this.previewPermits(
      planId, mapping.vendor_id, vehicle.vendor_branch_id, mapping.vendor_vehicle_type_ID,
      vehicle.registration_number, originData.origin, routes, previewContext,
    );

    const base = rental + toll + parking + driver + permit + extraKm + earlyLateCharges;
    const gst = branch.vendor_branch_gst_type === 2 ? money(base * branch.vendor_branch_gst / 100) : 0;
    const vendorMargin = money((base + gst) * vendor.vendor_margin / 100);
    const vendorMarginGst = vendor.vendor_margin_gst_type === 2
      ? money(vendorMargin * vendor.vendor_margin_gst_percentage / 100) : 0;
    const unitPrice = money(base + gst + vendorMargin + vendorMarginGst);
    if (!(unitPrice > 0) || !Number.isFinite(unitPrice)) return null;

    return {
      unitPrice,
      price: money(unitPrice * quantity),
      breakdown: {
        rental: money(rental), toll: money(toll), parking: money(parking),
        driver: money(driver), permit, extraKm: money(extraKm),
        earlyLateCharges: money(earlyLateCharges), gst, vendorMargin, vendorMarginGst,
      },
    };
  }

  async preview(planId: number, currentVehicleTypeId: number, selectedVendorEligibleId?: number) {
    if (!Number.isSafeInteger(planId) || planId <= 0 ||
        !Number.isSafeInteger(currentVehicleTypeId) || currentVehicleTypeId <= 0) {
      throw new BadRequestException('Valid itineraryPlanId and currentVehicleTypeId are required');
    }
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: planId }, select: { itinerary_plan_ID: true },
    });
    if (!plan) throw new NotFoundException('Itinerary not found');

const currentWhere = {
  itinerary_plan_id: planId,
  vehicle_type_id: currentVehicleTypeId,
  itineary_plan_assigned_status: 1,
  status: 1,
  deleted: 0,
  vehicle_grand_total: { gt: 0 },
};

let current = selectedVendorEligibleId
  ? await this.prisma.dvi_itinerary_plan_vendor_eligible_list.findFirst({
      where: {
        ...currentWhere,
        itinerary_plan_vendor_eligible_ID: selectedVendorEligibleId,
      },
    })
  : null;

// The rebuild recreates quotation IDs. If the supplied ID is
// outdated, look up the newly assigned quotation for this type.
if (!current) {
  current = await this.prisma.dvi_itinerary_plan_vendor_eligible_list.findFirst({
    where: currentWhere,
    orderBy: { itinerary_plan_vendor_eligible_ID: 'asc' },
  });
}

if (!current) {
  throw new NotFoundException(
    'No active assigned quotation exists for this vehicle type. ' +
    'Verify the itinerary vehicle selections before continuing.',
  );
}
    const vehicleCount = numberOf(current.total_vehicle_qty) || numberOf(current.vehicle_count);
    if (!vehicleCount) throw new BadRequestException('Current vehicle quantity is missing');
    const currentTotal = money(current.vehicle_grand_total * vehicleCount);
    const types = await this.prisma.dvi_vehicle_type.findMany({
      where: { status: 1, deleted: 0 },
      select: { vehicle_type_id: true, vehicle_type_title: true, occupancy: true },
      orderBy: { occupancy: 'asc' },
    });
    const existing = await this.prisma.dvi_itinerary_plan_vendor_eligible_list.findMany({
      where: { itinerary_plan_id: planId, status: 1, deleted: 0, vehicle_grand_total: { gt: 0 } },
      select: { vehicle_type_id: true, vehicle_grand_total: true, itineary_plan_assigned_status: true },
      orderBy: { itinerary_plan_vendor_eligible_ID: 'asc' },
    });
    const routes = await this.prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: planId, status: 1, deleted: 0 },
      select: {
        itinerary_route_ID: true, itinerary_route_date: true, location_name: true,
        next_visiting_location: true, no_of_km: true,
        route_start_time: true, route_end_time: true,
      },
      orderBy: [{ itinerary_route_date: 'asc' }, { itinerary_route_ID: 'asc' }],
    });
    if (!routes.length) throw new NotFoundException('Itinerary routes not found');

    // Request-scoped caches: never persist route data between itineraries.
    const sharedCache: VehicleCalcRunCache = {
      storedLocationCity: new Map(),
      locationCoordinates: new Map(),
      vehicleLocationDetails: new Map(),
      viaRouteNames: new Map(),
      routeHotspotMetrics: new Map(),
      routeLocationId: new Map(),
      localPoint: new Map(),
      permitCharges: new Map(),
    };
    const viaRows = await this.prisma.dvi_itinerary_via_route_details.findMany({
      where: { itinerary_plan_ID: planId, status: 1, deleted: 0 },
      orderBy: [{ itinerary_route_date: 'asc' }, { itinerary_via_route_ID: 'asc' }],
      select: { itinerary_route_ID: true, itinerary_via_location_name: true },
    });
    const viaByRoute = new Map<number, string[]>();
    for (const item of viaRows) {
      const id = numberOf(item.itinerary_route_ID);
      const value = String(item.itinerary_via_location_name || '').trim();
      if (id && value) viaByRoute.set(id, [...(viaByRoute.get(id) ?? []), value]);
    }
    const permitContext: PermitPreviewContext = {
      viaByRoute,
      stateCache: new Map(),
    };
    for (const [routeId, names] of viaByRoute) {
      sharedCache.viaRouteNames.set(routeId, names);
    }

    const currentType = types.find((item) => item.vehicle_type_id === currentVehicleTypeId);
    const minimumSeats = numberOf(currentType?.occupancy);
    // Confirm this read-only calculation reproduces the existing selected quotation.
    // If it does not, suppress unconfirmed upgrade numbers instead of underquoting.
    const selectedMapping = await this.prisma.dvi_vendor_vehicle_types.findFirst({
      where: { vendor_vehicle_type_ID: current.vendor_vehicle_type_id,
        vendor_id: current.vendor_id, status: 1, deleted: 0 },
    });
    const selectedVehicle = await this.prisma.dvi_vehicle.findFirst({
      where: { vehicle_id: current.vehicle_id, vendor_id: current.vendor_id,
        vendor_branch_id: current.vendor_branch_id, status: 1, deleted: 0 },
      select: {
        vehicle_id: true, vendor_branch_id: true, vehicle_location_id: true,
        vehicle_origin: true, vehicle_origin_latitude: true, vehicle_origin_longitude: true,
        owner_city: true, registration_number: true,
        extra_km_charge: true, extra_hour_charge: true,
        early_morning_charges: true, evening_charges: true,
      },
    });
    const selectedVendor = await this.prisma.dvi_vendor_details.findFirst({
      where: { vendor_id: current.vendor_id, status: 1, deleted: 0 },
      select: {
        vendor_origin_latitude: true, vendor_origin_longitude: true,
        vendor_margin: true, vendor_margin_gst_type: true,
        vendor_margin_gst_percentage: true,
      },
    });
    const selectedBranch = await this.prisma.dvi_vendor_branches.findFirst({
      where: { vendor_branch_id: current.vendor_branch_id, status: 1, deleted: 0 },
      select: {
        vendor_branch_id: true, vendor_branch_city: true,
        vendor_branch_gst_type: true, vendor_branch_gst: true,
        vendor_branch_location: true,
      },
    });
let parityValidated = false;
let recalculatedPrice: number | null = null;
let parityError: string | null = null;

if (selectedMapping && selectedVehicle && selectedVendor && selectedBranch) {
  try {
    const check = await this.quoteVehicle(
      planId, currentVehicleTypeId, vehicleCount,
      selectedMapping, selectedVehicle, selectedVendor, selectedBranch, routes,
      sharedCache, permitContext,
    );

    recalculatedPrice = check?.price ?? null;

    parityValidated = Boolean(
      recalculatedPrice !== null &&
      Math.abs(recalculatedPrice - currentTotal) <= 0.01
    );
  } catch (error) {
    parityError =
      error instanceof Error ? error.message : "Calculation failed";
  }
} else {
  parityError = "Current vehicle vendor, mapping, or branch details missing";
}

if (process.env.NODE_ENV !== "production") {
  console.log("[UPGRADE_PRICE_CHECK]", {
    planId,
    currentVehicleTypeId,
    savedPrice: currentTotal,
    recalculatedPrice,
    difference:
      recalculatedPrice === null
        ? null
        : money(recalculatedPrice - currentTotal),
    parityValidated,
    parityError,
  });
}

    // Resolve itinerary city names once, in parallel, instead of once per type.
    const cities = new Set<string>();
    const routeLocations = [...new Set(routes.flatMap((route) =>
      [route.location_name, route.next_visiting_location]
        .map((name) => String(name || '').trim())
        .filter(Boolean),
    ))];
    await Promise.all(routeLocations.map(async (location) => {
      cities.add(normalize(location));
      const city = await getStoredLocationCity(this.prisma, location, sharedCache);
      if (city) cities.add(normalize(city));
    }));

    const prices: UpgradePriceRow[] = [];
    const pricingStart = Date.now();
    const eligibleTypes = types.filter((type) =>
      type.vehicle_type_id !== currentVehicleTypeId &&
      !(minimumSeats > 0 && type.occupancy < minimumSeats) &&
      Boolean(String(type.vehicle_type_title || '').trim()),
    );

    // Saved quotations keep exactly the original priority: assigned first.
    const savedByType = new Map<number, (typeof existing)[number]>();
    for (const row of existing) {
      const previous = savedByType.get(row.vehicle_type_id);
      if (!previous || (previous.itineary_plan_assigned_status !== 1 && row.itineary_plan_assigned_status === 1)) {
        savedByType.set(row.vehicle_type_id, row);
      }
    }

    const unquotedTypes = parityValidated
      ? eligibleTypes.filter((type) => !savedByType.has(type.vehicle_type_id))
      : [];
    const unquotedTypeIds = unquotedTypes.map((type) => type.vehicle_type_id);

    // Bulk-load mapping, vendor, branch, city, and vehicle records once.
    // These are the same active/deleted filters as the original nested loops.
    const allMappings = unquotedTypeIds.length
      ? await this.prisma.dvi_vendor_vehicle_types.findMany({
          where: {
            status: 1,
            deleted: 0,
            OR: [
              { vehicle_type_id: { in: unquotedTypeIds } },
              { vendor_vehicle_type_ID: { in: unquotedTypeIds } },
            ],
          },
        })
      : [];
    const vendorIds = [...new Set(allMappings.map((row) => row.vendor_id).filter((id) => id > 0))];
    const allVendors = vendorIds.length
      ? await this.prisma.dvi_vendor_details.findMany({
          where: { vendor_id: { in: vendorIds }, status: 1, deleted: 0 },
          select: {
            vendor_id: true,
            vendor_origin_latitude: true,
            vendor_origin_longitude: true,
            vendor_margin: true,
            vendor_margin_gst_type: true,
            vendor_margin_gst_percentage: true,
          },
        })
      : [];
    const vendorById = new Map(allVendors.map((vendor) => [vendor.vendor_id, vendor]));
    const activeVendorIds = allVendors.map((vendor) => vendor.vendor_id);
    const allBranches = activeVendorIds.length
      ? await this.prisma.dvi_vendor_branches.findMany({
          where: { vendor_id: { in: activeVendorIds }, status: 1, deleted: 0 },
          select: {
            vendor_id: true,
            vendor_branch_id: true,
            vendor_branch_gst_type: true,
            vendor_branch_gst: true,
            vendor_branch_location: true,
            vendor_branch_city: true,
          },
        })
      : [];
    const branchesByVendor = new Map<number, typeof allBranches>();
    for (const branch of allBranches) {
      const list = branchesByVendor.get(branch.vendor_id) ?? [];
      list.push(branch);
      branchesByVendor.set(branch.vendor_id, list);
    }
    const branchCityIds = [...new Set(allBranches.map((branch) => branch.vendor_branch_city).filter((id) => id > 0))];
    const branchCities = branchCityIds.length
      ? await this.prisma.dvi_cities.findMany({
          where: { id: { in: branchCityIds }, deleted: 0 },
          select: { id: true, name: true },
        })
      : [];
    const cityNameById = new Map(branchCities.map((city) => [city.id, normalize(city.name)]));
    const branchMatches = (branch: (typeof allBranches)[number]): boolean =>
      cities.has(normalize(branch.vendor_branch_location)) ||
      cities.has(cityNameById.get(branch.vendor_branch_city) || '');

    const branchIds = allBranches.map((branch) => branch.vendor_branch_id);
    const vehicleTypeIds = [...new Set([
      ...unquotedTypeIds,
     ...allMappings.map((map) => map.vendor_vehicle_type_ID),
...allMappings.map((map) => map.vehicle_type_id),
    ])];
    const allVehicles = branchIds.length && vehicleTypeIds.length
      ? await this.prisma.dvi_vehicle.findMany({
          where: {
            vendor_id: { in: activeVendorIds },
            vendor_branch_id: { in: branchIds },
            vehicle_type_id: { in: vehicleTypeIds },
            status: 1,
            deleted: 0,
          },
          select: {
            vehicle_id: true,
            vendor_id: true,
            vehicle_type_id: true,
            vendor_branch_id: true,
            vehicle_location_id: true,
            vehicle_origin: true,
            vehicle_origin_latitude: true,
            vehicle_origin_longitude: true,
            owner_city: true,
            registration_number: true,
            extra_km_charge: true,
            extra_hour_charge: true,
            early_morning_charges: true,
            evening_charges: true,
          },
        })
      : [];
    const vehiclesByBranch = new Map<string, typeof allVehicles>();
    for (const vehicle of allVehicles) {
      const key = `${vehicle.vendor_id}:${vehicle.vendor_branch_id}`;
      const list = vehiclesByBranch.get(key) ?? [];
      list.push(vehicle);
      vehiclesByBranch.set(key, list);
    }

    type QuoteCandidate = {
      typeId: number;
      mapping: (typeof allMappings)[number];
      vehicle: (typeof allVehicles)[number];
      vendor: (typeof allVendors)[number];
      branch: (typeof allBranches)[number];
    };
    const candidates: QuoteCandidate[] = [];
    const diagnostics = new Map<number, {
      mappings: number;
      activeVendors: number;
      eligibleBranches: number;
      matchingVehicles: number;
      successfulQuotes: number;
      rejectedQuotes: number;
      calculationErrors: number;
      firstError: string | null;
    }>();

    for (const type of unquotedTypes) {
      const exactMappings = allMappings.filter((map) => map.vehicle_type_id === type.vehicle_type_id);
      const mappings = exactMappings.length
        ? exactMappings
        : allMappings.filter((map) => map.vendor_vehicle_type_ID === type.vehicle_type_id);
      const activeTypeBranches = [...new Set(mappings.map((map) => map.vendor_id))]
        .flatMap((vendorId) => branchesByVendor.get(vendorId) ?? []);
      const hasStrictBranch = activeTypeBranches.some(branchMatches);
      const diagnostic = {
        mappings: mappings.length,
        activeVendors: 0,
        eligibleBranches: 0,
        matchingVehicles: 0,
        successfulQuotes: 0,
        rejectedQuotes: 0,
        calculationErrors: 0,
        firstError: null as string | null,
      };
      diagnostics.set(type.vehicle_type_id, diagnostic);

      for (const mapping of mappings) {
        const vendor = vendorById.get(mapping.vendor_id);
        if (!vendor) continue;
        diagnostic.activeVendors++;
        const vendorBranches = branchesByVendor.get(mapping.vendor_id) ?? [];
        const eligibleBranches = hasStrictBranch
          ? vendorBranches.filter(branchMatches)
          : vendorBranches;
        diagnostic.eligibleBranches += eligibleBranches.length;

  // Match the actual rebuild engine's candidate limit and vehicle order.
const eligibleBranchIds = new Set(
  eligibleBranches.map((branch) => branch.vendor_branch_id),
);

const engineVehicleCandidates = allVehicles
  .filter((vehicle) =>
    vehicle.vendor_id === mapping.vendor_id &&
    eligibleBranchIds.has(vehicle.vendor_branch_id) &&
    (
      vehicle.vehicle_type_id === type.vehicle_type_id ||
      vehicle.vehicle_type_id === mapping.vendor_vehicle_type_ID ||
      vehicle.vehicle_type_id === mapping.vehicle_type_id
    ),
  )
  .sort((a, b) => a.vehicle_id - b.vehicle_id)
  .slice(0, Math.max(vehicleCount, 10));

diagnostic.matchingVehicles += engineVehicleCandidates.length;

for (const vehicle of engineVehicleCandidates) {
  const branch = eligibleBranches.find(
    (item) => item.vendor_branch_id === vehicle.vendor_branch_id,
  );

  if (branch) {
    candidates.push({
      typeId: type.vehicle_type_id,
      mapping,
      vehicle,
      vendor,
      branch,
    });
  }
}
      }
    }

    // Bound database-intensive quote calculations across ALL vehicle types.
    // No nested Promise.all over vendors or vehicles: it could exhaust the pool.
    const bestByType = new Map<number, {
      quote: Pick<UpgradePriceRow, 'unitPrice' | 'price' | 'breakdown'>;
      candidateIndex: number;
    }>();
    let nextCandidate = 0;
    const calculateCandidate = async (): Promise<void> => {
      while (nextCandidate < candidates.length) {
        const index = nextCandidate++;
        const candidate = candidates[index];
        const diagnostic = diagnostics.get(candidate.typeId)!;
        try {
          const quote = await this.quoteVehicle(
            planId, candidate.typeId, vehicleCount,
            candidate.mapping, candidate.vehicle, candidate.vendor,
            candidate.branch, routes, sharedCache, permitContext,
          );
          if (!quote || quote.price === null || !Number.isFinite(quote.price)) {
            diagnostic.rejectedQuotes++;
            continue;
          }
          diagnostic.successfulQuotes++;
          const previous = bestByType.get(candidate.typeId);
          if (
            !previous ||
            quote.price < (previous.quote.price ?? Infinity) ||
            (quote.price === previous.quote.price && index < previous.candidateIndex)
          ) {
            bestByType.set(candidate.typeId, { quote, candidateIndex: index });
          }
        } catch (error) {
          diagnostic.calculationErrors++;
          if (!diagnostic.firstError) {
            diagnostic.firstError = error instanceof Error ? error.message : String(error);
          }
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, candidates.length) }, () => calculateCandidate()),
    );

    if (process.env.DEBUG_VEHICLE_UPGRADE_PRICES === "1") {
  for (const [vehicleTypeId, chosen] of bestByType.entries()) {
    const candidate = candidates[chosen.candidateIndex];
    if (!candidate) continue;

    console.log(
      "[UPGRADE_PREVIEW_WINNER]",
      JSON.stringify({
        planId,
        vehicleTypeId,
        vendorId: candidate.mapping.vendor_id,
        branchId: candidate.vehicle.vendor_branch_id,
        vehicleId: candidate.vehicle.vehicle_id,
        vendorVehicleTypeId:
          candidate.mapping.vendor_vehicle_type_ID,
        quotedPrice: chosen.quote.price,
        breakdown: chosen.quote.breakdown,
      }),
    );
  }
}
    // Return rows in the original vehicle-type order, not worker finish order.
    for (const type of eligibleTypes) {
      const name = String(type.vehicle_type_title || '').trim();
      const saved = savedByType.get(type.vehicle_type_id);
      if (saved) {
        const total = money(saved.vehicle_grand_total * vehicleCount);
        if (total > currentTotal) {
          prices.push({
            vehicleTypeId: type.vehicle_type_id,
            vehicleName: name,
            capacity: type.occupancy,
            unitPrice: saved.vehicle_grand_total,
            price: total,
            extraPayment: money(total - currentTotal),
            quantity: vehicleCount,
            source: 'saved_quote',
          });
        }
        continue;
      }
      if (!parityValidated) continue;
      const bestSelection = bestByType.get(type.vehicle_type_id);
const best = bestSelection?.quote ?? null;
const selectedCandidate = bestSelection
  ? candidates[bestSelection.candidateIndex]
  : undefined;
      if (process.env.DEBUG_VEHICLE_UPGRADE_PRICES === '1') {
        console.log('[UPGRADE_VEHICLE_DIAGNOSTIC]', {
          planId,
          vehicleTypeId: type.vehicle_type_id,
          vehicleName: name,
          ...diagnostics.get(type.vehicle_type_id),
          currentPrice: currentTotal,
          bestCalculatedPrice: best?.price ?? null,
        });
      }
      if (best && best.price !== null && best.price > currentTotal) {
        prices.push({
          vehicleTypeId: type.vehicle_type_id,
          vehicleName: name,
          capacity: type.occupancy,
          unitPrice: best.unitPrice,
          price: best.price,
          extraPayment: money(best.price - currentTotal),
          quantity: vehicleCount,
         source: 'calculated_preview',
breakdown: best.breakdown,
candidateIdentity: selectedCandidate
  ? {
      vendorId: selectedCandidate.mapping.vendor_id,
      branchId: selectedCandidate.vehicle.vendor_branch_id,
      vendorVehicleTypeId:
        selectedCandidate.mapping.vendor_vehicle_type_ID,
      vehicleId: selectedCandidate.vehicle.vehicle_id,
    }
  : undefined,
        });
      }
    }
    if (process.env.DEBUG_VEHICLE_UPGRADE_PRICES === '1') {
      console.log('[UPGRADE_PRICING_PERFORMANCE]', {
        planId,
        vehicleTypesChecked: eligibleTypes.length,
        candidateVehiclesChecked: candidates.length,
        pricingDurationMs: Date.now() - pricingStart,
        returnedPrices: prices.length,
      });
    }
    return {
      itineraryPlanId: planId, currentVehicleTypeId,
      currentVehiclePrice: currentTotal, quantity: vehicleCount,
      prices,
      parityValidated,
    };
  }
}
