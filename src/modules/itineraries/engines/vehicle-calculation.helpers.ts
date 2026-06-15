// vehicle-calculation.helpers.ts
// Helper functions to match PHP vehicle calculation logic

import { PrismaClient } from '@prisma/client';
import {
  buildCityLookupCandidates,
  normalizeCityName,
  resolveCityNameById as resolveCityNameByIdCached,
  resolveCityRecordByName,
} from '../utils/city-normalization.util';
import { getCachedStoredLocationPair } from '../../locations/stored-location-cache.helper';

function toNum(v: any): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
}

function normalizeCityToken(value: string): string {
  const base = String(value || '').trim();
  if (!base) return '';
  const firstPart = base.split(',')[0] || base;
  return normalizeCityName(firstPart);
}

export interface VehicleCalculationContext {
  prisma: PrismaClient | any;
  itinerary_plan_ID: number;
  vehicle_type_id: number;
  vendor_id: number;
  vendor_vehicle_type_ID: number;
  vendor_branch_id: number;
  vehicle_location_id: number;
  vehicle_origin: string;
  vehicle_origin_city: string;
  vehicle_origin_latitude: number;
  vehicle_origin_longitude: number;
  extra_km_charge: number;
  extra_hour_charge: number;
  selected_time_limit_id?: number;
  get_kms_limit: number; // outstation_allowed_km_per_day
  driver_batta: number;
  food_cost: number;
  accomodation_cost: number;
  extra_cost: number;
  driver_early_morning_charges: number;
  driver_evening_charges: number;
  early_morning_charges: number;
  evening_charges: number;
  force_local_trip?: boolean;
  buildCache?: VehicleCalcRunCache;
}

export type VehicleCalcRunCache = {
  storedLocationCity: Map<string, string>;
  locationCoordinates: Map<string, { latitude: number; longitude: number } | null>;
  vehicleLocationDetails: Map<number, {
    origin: string;
    city: string;
    latitude: number;
    longitude: number;
  }>;
  viaRouteNames: Map<number, string[]>;
  routeHotspotMetrics: Map<number, {
    runningKm: number;
    runningSeconds: number;
    sightseeingKm: number;
    sightseeingSeconds: number;
  }>;
  routeLocationId: Map<string, number>;
  localPoint: Map<number, { name: string; lat: number | null; lng: number | null; source: string }>;
  permitCharges: Map<string, number>;
  globalSettings?: {
    localSpeed: number;
    outstationSpeed: number;
  };
};

function normalizeCacheKey(value: string | number | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

function buildCacheKey(...parts: Array<string | number | null | undefined>): string {
  return parts.map((part) => normalizeCacheKey(part)).join('::');
}

export interface RouteData {
  itinerary_route_ID: number;
  itinerary_route_date: Date;
  location_name: string;
  next_visiting_location: string;
  no_of_km: string | number;
  route_start_time?: string;
  route_end_time?: string;
  location_latitude?: number;
  location_longitude?: number;
  next_location_latitude?: number;
  next_location_longitude?: number;
}

export interface RouteCalculationResult {
  travel_type: number; // 1=LOCAL, 2=OUTSTATION
  time_limit_id: number;
  kms_limit_id: number;
  TOTAL_RUNNING_KM: string;
  TOTAL_TRAVELLING_TIME: string | null;
  SIGHT_SEEING_TRAVELLING_KM: string;
  SIGHT_SEEING_TRAVELLING_TIME: string | null;
  TOTAL_PICKUP_KM: string;
  TOTAL_PICKUP_DURATION: string | null;
  TOTAL_DROP_KM: string;
  TOTAL_DROP_DURATION: string | null;
  TOTAL_KM: string;
  TOTAL_TIME: string;
  vehicle_cost_for_the_day: number;
  VEHICLE_TOLL_CHARGE: number;
  VEHICLE_PARKING_CHARGE: number;
  TOTAL_DRIVER_CHARGES: number;
  permit_charges: number;
  morning_extra_time: number;
  evening_extra_time: number;
  DRIVER_MORINING_CHARGES: number;
  VENDOR_VEHICLE_MORNING_CHARGES: number;
  DRIVER_EVEINING_CHARGES: number;
  VENDOR_VEHICLE_EVENING_CHARGES: number;
  TOTAL_VEHICLE_AMOUNT: number;
  TOTAL_LOCAL_EXTRA_KM: number;
  TOTAL_LOCAL_EXTRA_KM_CHARGES: number;
  TOTAL_ALLOWED_LOCAL_KM: number;
  TOTAL_ALLOWED_OUTSTATION_KM: number;
  TOTAL_LOCAL_EXTRA_HOURS: number;
  TOTAL_LOCAL_EXTRA_HOUR_CHARGES: number;
  TOLL_BREAKUP?: Array<{ label: string; charge: number }>;
  PICKUP_DEBUG?: {
    vehicleOrigin: string;
    pickupFrom: string;
    pickupTo: string;
    matchedStoredLocationId: number | null;
    matchedStoredLocationSource: string | null;
    matchedStoredLocationDestination: string | null;
    matchedStoredLocationDistance: number | null;
    calculationSource: 'stored_location' | 'haversine' | 'fallback' | 'existing_db' | 'unknown';
  };
}

export interface VendorEligibleTotals {
  OVERALL_TOTAL_KM: string;
  OVERALL_OUTSTATION_KM: string;
  OVERALL_TOTAL_TIME: string;
  OVERALL_RENDAL_CHARGES: number;
  OVERALL_VEHICLE_TOLL_CHARGE: number;
  OVERALL_VEHICLE_PARKING_CHARGE: number;
  OVERALL_TOTAL_DRIVER_CHARGES: number;
  OVERALL_PERMIT_CHARGES: number;
  OVERALL_BEFORE_6AM_EXTRA_TIME: number;
  OVERALL_AFTER_8PM_EXTRA_TIME: number;
  OVERALL_DRIVER_MORINING_CHARGES: number;
  OVERALL_VENDOR_VEHICLE_MORNING_CHARGES: number;
  OVERALL_DRIVER_EVEINING_CHARGES: number;
  OVERALL_VENDOR_VEHICLE_EVENING_CHARGES: number;
  OVERALL_LOCAL_KM: string;
  OVERALL_LOCAL_EXTRA_KM: string;
  OVERALL_LOCAL_EXTRA_KM_CHARGES: number;
  TOTAL_ITINEARY_ALLOWED_KM: string;
  TOTAL_EXTRA_KM: string;
  TOTAL_EXTRA_KM_CHARGE: number;
}

/**
 * Calculate distance between two coordinates using Haversine formula
 * Returns distance in kilometers
 */
export function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calculate distance and duration between two points
 * PHP: calculateDistanceAndDuration($lat1, $lon1, $lat2, $lon2, $travel_type)
 */
export function calculateDistanceAndDuration(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  avgSpeedKmPerHr = 50,
  correctionFactor = 1
): { distance: string; duration: string } {
  const distanceKm = calculateDistance(lat1, lon1, lat2, lon2) * correctionFactor;
  const speed = Number.isFinite(avgSpeedKmPerHr) && avgSpeedKmPerHr > 0 ? avgSpeedKmPerHr : 50;
  const durationHours = distanceKm / speed;
  const hours = Math.floor(durationHours);
  const minutes = Math.floor((durationHours - hours) * 60);
  
  return {
    distance: distanceKm.toFixed(2),
    duration: `${hours} hour ${minutes} mins`
  };
}

function parseStoredDurationToHms(durationValue: any): string {
  if (!durationValue) return '00:00:00';
  if (durationValue instanceof Date) {
    return `${String(durationValue.getUTCHours()).padStart(2, '0')}:${String(durationValue.getUTCMinutes()).padStart(2, '0')}:${String(durationValue.getUTCSeconds()).padStart(2, '0')}`;
  }

  const text = String(durationValue).trim();
  if (!text) return '00:00:00';
  if (/^\d{1,3}:\d{2}(:\d{2})?$/.test(text)) {
    const parts = text.split(':');
    return `${String(Number(parts[0] || 0)).padStart(2, '0')}:${String(Number(parts[1] || 0)).padStart(2, '0')}:${String(Number(parts[2] || 0)).padStart(2, '0')}`;
  }

  const lower = text.toLowerCase();
  const days = Number(lower.match(/(\d+)\s*day/)?.[1] || 0);
  const hours = Number(lower.match(/(\d+)\s*hour/)?.[1] || 0);
  const mins = Number(lower.match(/(\d+)\s*min/)?.[1] || 0);
  return secondsToHms((((days * 24) + hours) * 60 + mins) * 60);
}

function parseKmLimitFromTitle(titleValue: any): number {
  const text = String(titleValue || '').trim();
  if (!text) return 0;
  const match = text.match(/(\d+(?:\.\d+)?)\s*KMS?/i);
  return match ? Number(match[1] || 0) : 0;
}

export function getEffectiveTimeLimitKm(timeLimit: { km_limit?: any; time_limit_title?: any } | null | undefined): number {
  if (!timeLimit) return 0;
  const rawKmLimit = Number(timeLimit.km_limit || 0);
  if (rawKmLimit > 1) {
    return rawKmLimit;
  }

  const parsedKmLimit = parseKmLimitFromTitle(timeLimit.time_limit_title);
  if (parsedKmLimit > 0) {
    return parsedKmLimit;
  }

  return rawKmLimit;
}

function locationCandidates(value: string): string[] {
  const raw = String(value || '').trim();
  if (!raw) return [];
  return Array.from(new Set([
    raw,
    raw.split('|')[0]?.trim() || '',
    raw.split(',')[0]?.trim() || '',
    raw.split('-')[0]?.trim() || '',
  ].filter(Boolean)));
}

async function resolveCityIdByLabel(prisma: any, value: string): Promise<number> {
  try {
    const city = await resolveCityRecordByName(prisma, value);
    return Number(city?.id || 0);
  } catch (error) {
    console.error('[resolveCityIdByLabel] Error:', error);
    return 0;
  }
}

async function resolveCityNameById(prisma: any, cityId: number): Promise<string> {
  try {
    return await resolveCityNameByIdCached(prisma, cityId);
  } catch (error) {
    console.error('[resolveCityNameById] Error:', error);
    return '';
  }
}

function buildLocationMatchConditions(sourceLocation: string, destinationLocation: string) {
  const sourceCandidates = locationCandidates(sourceLocation);
  const destinationCandidates = locationCandidates(destinationLocation);
  const sourceCityToken = normalizeCityToken(sourceLocation);
  const destinationCityToken = normalizeCityToken(destinationLocation);

  const conditions: Array<Record<string, any>> = [];

  for (const sourceCandidate of sourceCandidates) {
    for (const destinationCandidate of destinationCandidates) {
      conditions.push({
        source_location: sourceCandidate,
        destination_location: destinationCandidate,
      });
    }
  }

  if (sourceCityToken && destinationCityToken) {
    conditions.push({
      source_location_city: { contains: sourceCityToken },
      destination_location_city: { contains: destinationCityToken },
    });
  }

  return conditions;
}

async function getExactStoredLocationId(
  prisma: any,
  source_location: string,
  destination_location: string,
  debugContext?: { planId?: number; routeId?: number },
): Promise<number> {
  try {
    const row = await getCachedStoredLocationPair<{
      location_ID: number | bigint;
    }>({
      planId: debugContext?.planId,
      routeId: debugContext?.routeId,
      source: source_location,
      destination: destination_location,
      lookup: () =>
        prisma.dvi_stored_locations.findFirst({
          where: {
            source_location,
            destination_location,
            deleted: 0,
            status: 1,
          },
          orderBy: { location_ID: 'desc' },
          select: { location_ID: true },
        }),
      serialize: (value) => ({
        locationId: Number(value?.location_ID || 0) || null,
      }),
    });

    return Number(row?.location_ID || 0);
  } catch (error) {
    console.error('[getExactStoredLocationId] Error:', error);
    return 0;
  }
}

export async function getLegDistanceAndDuration(
  prisma: any,
  fromName: string,
  toName: string,
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  travelLocationType: 1 | 2,
  localSpeed = 40,
  outstationSpeed = 60,
  debugContext?: { planId?: number; routeId?: number },
): Promise<{ distance: string; duration: string }> {
  try {
    const fromCandidates = locationCandidates(fromName);
    const toCandidates = locationCandidates(toName);

    for (const source_location of fromCandidates) {
      for (const destination_location of toCandidates) {
        const stored = await getCachedStoredLocationPair<{
          distance: number | string | null;
          duration: string | null;
        }>({
          planId: debugContext?.planId,
          routeId: debugContext?.routeId,
          source: source_location,
          destination: destination_location,
          lookup: () =>
            prisma.dvi_stored_locations.findFirst({
              where: {
                source_location,
                destination_location,
                deleted: 0,
                status: 1,
              },
              orderBy: { location_ID: 'desc' },
              select: {
                distance: true,
                duration: true,
              },
            }),
          serialize: (value) => ({
            distance: Number(value?.distance || 0) || null,
            duration: String(value?.duration || ''),
          }),
        });

        if (stored && (Number(stored.distance || 0) > 0 || String(stored.duration || '').trim())) {
          return {
            distance: Number(stored.distance || 0).toFixed(2),
            duration: parseStoredDurationToHms(stored.duration),
          };
        }
      }
    }
  } catch (error) {
    console.error('[getLegDistanceAndDuration] Stored lookup error:', error);
  }

  const fallback = calculateDistanceAndDuration(
    fromLat,
    fromLng,
    toLat,
    toLng,
    travelLocationType === 1 ? localSpeed : outstationSpeed,
    1.5,
  );
  return {
    distance: String((Number(fallback.distance) || 0).toFixed(2)),
    duration: parsePhpDurationToHms(fallback.duration),
  };
}

function getTravelLocationType(
  startLocation: string,
  endLocation: string,
): 1 | 2 {
  const starts = String(startLocation || '').split('|').map((s) => normalizeCityToken(s)).filter(Boolean);
  const ends = String(endLocation || '').split('|').map((s) => normalizeCityToken(s)).filter(Boolean);
  for (const s of starts) {
    for (const e of ends) {
      if (s === e) return 1;
    }
  }
  return 2;
}

function parsePhpDurationToHms(durationText: string | null | undefined): string {
  const text = String(durationText || '').trim();
  if (!text) return '00:00:00';

  const hoursMatch = text.match(/(\d+)\s*hour/i);
  const minsMatch = text.match(/(\d+)\s*mins?/i);

  let hours = hoursMatch ? Number(hoursMatch[1]) : 0;
  let mins = minsMatch ? Number(minsMatch[1]) : 0;

  if (!Number.isFinite(hours)) hours = 0;
  if (!Number.isFinite(mins)) mins = 0;

  hours += Math.floor(mins / 60);
  mins = mins % 60;

  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:00`;
}

function parseHmsToSeconds(hms: string | null | undefined): number {
  const t = String(hms || '').trim();
  if (!/^\d{2}:\d{2}:\d{2}$/.test(t)) return 0;
  const [h, m, s] = t.split(':').map((v) => Number(v || 0));
  return h * 3600 + m * 60 + s;
}

function secondsToHms(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function getRouteHotspotMetrics(
  prisma: any,
  itinerary_plan_ID: number,
  itinerary_route_ID: number,
  cache?: VehicleCalcRunCache
): Promise<{
  runningKm: number;
  runningSeconds: number;
  sightseeingKm: number;
  sightseeingSeconds: number;
}> {
  const cached = cache?.routeHotspotMetrics.get(Number(itinerary_route_ID || 0));
  if (cached) {
    return cached;
  }
  try {
    const rows = await prisma.$queryRaw<any[]>`
      SELECT
        COALESCE(SUM(CASE WHEN item_type IN (2,6,7,5)
          THEN CAST(hotspot_travelling_distance AS DECIMAL(10,2)) ELSE 0 END), 0) AS running_km,
        COALESCE(SUM(CASE WHEN item_type IN (2,6,7,5)
          THEN TIME_TO_SEC(hotspot_traveling_time) ELSE 0 END), 0) AS running_seconds,
        COALESCE(SUM(CASE WHEN item_type IN (1,3,4)
          THEN CAST(hotspot_travelling_distance AS DECIMAL(10,2)) ELSE 0 END), 0) AS sightseeing_km,
        COALESCE(SUM(CASE WHEN item_type IN (1,3,4)
          THEN TIME_TO_SEC(hotspot_traveling_time) ELSE 0 END), 0) AS sightseeing_seconds
      FROM dvi_itinerary_route_hotspot_details
      WHERE itinerary_plan_ID = ${itinerary_plan_ID}
        AND itinerary_route_ID = ${itinerary_route_ID}
        AND status = 1
        AND deleted = 0
    `;

    const row = rows?.[0] ?? {};
    const result = {
      runningKm: Number(row.running_km ?? 0),
      runningSeconds: Number(row.running_seconds ?? 0),
      sightseeingKm: Number(row.sightseeing_km ?? 0),
      sightseeingSeconds: Number(row.sightseeing_seconds ?? 0),
    };
    cache?.routeHotspotMetrics.set(Number(itinerary_route_ID || 0), result);
    return result;
  } catch (error) {
    console.error('[getRouteHotspotMetrics] Error:', error);
    return {
      runningKm: 0,
      runningSeconds: 0,
      sightseeingKm: 0,
      sightseeingSeconds: 0,
    };
  }
}

/**
 * Get location ID from source and destination pair
 * PHP: getSTOREDLOCATION_SOURCE_AND_DESTINATION_DETAILS($source, $dest, 'get_location_id')
 */
export async function getLocationIdFromSourceDest(
  prisma: any,
  source_location: string,
  destination_location: string,
  debugContext?: { planId?: number; routeId?: number },
  cache?: VehicleCalcRunCache,
): Promise<number> {
  try {
    const cacheKey = buildCacheKey(source_location, destination_location);
    const cached = cache?.routeLocationId.get(cacheKey);
    if (typeof cached === 'number') {
      return cached;
    }

    const sourceCityId = await resolveCityIdByLabel(prisma, source_location);
    const destinationCityId = await resolveCityIdByLabel(prisma, destination_location);

    const exact = await getCachedStoredLocationPair<{
      location_ID: number | bigint;
    }>({
      planId: debugContext?.planId,
      routeId: debugContext?.routeId,
      source: source_location,
      destination: destination_location,
      lookup: () =>
        prisma.dvi_stored_locations.findFirst({
          where: {
            source_location,
            destination_location,
            deleted: 0,
            status: 1
          },
          orderBy: { location_ID: "desc" },
          select: { location_ID: true }
        }),
      serialize: (value) => ({
        locationId: Number(value?.location_ID || 0) || null,
      }),
    });

    if (exact?.location_ID) {
      const locationId = Number(exact.location_ID || 0);
      cache?.routeLocationId.set(cacheKey, locationId);
      return locationId;
    }

    if (sourceCityId > 0 && destinationCityId > 0) {
      const cityPairRow = await prisma.dvi_stored_locations.findFirst({
        where: {
          deleted: 0,
          status: 1,
          source_city_id: sourceCityId,
          destination_city_id: destinationCityId,
        },
        orderBy: { location_ID: 'desc' },
        select: { location_ID: true },
      });

      if (cityPairRow?.location_ID) {
        const locationId = Number(cityPairRow.location_ID || 0);
        cache?.routeLocationId.set(cacheKey, locationId);
        return locationId;
      }
    }

    const sourceCityToken = normalizeCityToken(source_location);
    const destinationCityToken = normalizeCityToken(destination_location);

    if (sourceCityToken && destinationCityToken && sourceCityToken === destinationCityToken) {
      const sameCityRows = await prisma.dvi_stored_locations.findMany({
        where: {
          deleted: 0,
          status: 1,
          source_location: { contains: source_location },
          destination_location: { contains: destination_location },
        },
        select: { location_ID: true },
        orderBy: { location_ID: 'desc' },
      });

      if (sameCityRows.length) {
        const locationId = Number(sameCityRows[0].location_ID ?? 0);
        cache?.routeLocationId.set(cacheKey, locationId);
        return locationId;
      }
    }

    const fuzzyConditions = buildLocationMatchConditions(source_location, destination_location);
    if (!fuzzyConditions.length) {
      return 0;
    }

    const fuzzy = await prisma.dvi_stored_locations.findFirst({
      where: {
        deleted: 0,
        status: 1,
        OR: fuzzyConditions,
      },
      orderBy: { location_ID: "desc" },
      select: { location_ID: true },
    });

    const locationId = Number(fuzzy?.location_ID ?? 0);
    cache?.routeLocationId.set(cacheKey, locationId);
    return locationId;
  } catch (error) {
    console.error('[getLocationIdFromSourceDest] Error:', error);
    return 0;
  }
}

/**
 * Calculate vehicle toll charges for a route
 * PHP: getVEHICLE_TOLL_CHARGES($vehicle_type_id, $location_id)
 */
export async function calculateVehicleTollCharges(
  prisma: any,
  vehicle_type_id: number,
  location_id: bigint
): Promise<number> {
  if (!location_id) return 0;
  
  try {
    const row = await prisma.dvi_vehicle_toll_charges.findFirst({
      where: {
        vehicle_type_id,
        location_id,
        status: 1,
        deleted: 0,
      },
      orderBy: { vehicle_toll_charge_ID: 'desc' },
      select: { toll_charge: true },
    });

    return Number(row?.toll_charge ?? 0);
  } catch (error) {
    console.error('[calculateVehicleTollCharges] Error:', error);
    return 0;
  }
}

/**
 * Calculate toll charges for route including via routes
 * PHP: Complex logic from lines 1550-1650
 */
export async function calculateRouteTollCharges(
  prisma: any,
  vehicle_type_id: number,
  source_location: string,
  destination_location: string,
  via_route_names: string[] = []
): Promise<{ total: number; breakup: Array<{ label: string; charge: number }> }> {
  let totalToll = 0;
  const breakup: Array<{ label: string; charge: number }> = [];

  const getTollForLocationPair = async (from: string, to: string): Promise<{ locationId: number; toll: number; label: string }> => {
    const locationId = await getExactStoredLocationId(prisma, from, to);
    if (!locationId) {
      return { locationId: 0, toll: 0, label: `${from} → ${to}` };
    }

    const toll = await calculateVehicleTollCharges(prisma, vehicle_type_id, BigInt(locationId));
    let label = `${from} → ${to}`;
    if (toll > 0) {
      try {
        const labelRows = await prisma.$queryRaw<any[]>`
          SELECT source_location, destination_location
          FROM dvi_stored_locations
          WHERE location_ID = ${BigInt(locationId)}
          LIMIT 1
        `;
        const sourceLabel = String(labelRows?.[0]?.source_location || '').trim();
        const destinationLabel = String(labelRows?.[0]?.destination_location || '').trim();
        if (sourceLabel && destinationLabel) {
          label = `${sourceLabel} → ${destinationLabel}`;
        }
      } catch (error) {
        console.error('[calculateRouteTollCharges] Label lookup error:', error);
      }
    }

    return { locationId, toll, label };
  };

  try {
    const routeLegs = via_route_names.length
      ? [source_location, ...via_route_names, destination_location]
      : [source_location, destination_location];

    for (let index = 0; index < routeLegs.length - 1; index++) {
      const legFrom = routeLegs[index];
      const legTo = routeLegs[index + 1];
      const legToll = await getTollForLocationPair(legFrom, legTo);
      if (legToll.toll > 0) {
        totalToll += legToll.toll;
        breakup.push({ label: legToll.label, charge: legToll.toll });
      }
    }
  } catch (error) {
    console.error('[calculateRouteTollCharges] Error:', error);
  }

  return { total: totalToll, breakup };
}

async function getViaRouteNames(
  prisma: any,
  itinerary_plan_ID: number,
  itinerary_route_ID: number,
  cache?: VehicleCalcRunCache,
): Promise<string[]> {
  const cached = cache?.viaRouteNames.get(Number(itinerary_route_ID || 0));
  if (cached) return cached;
  try {
    const rows = await prisma.dvi_itinerary_via_route_details.findMany({
      where: {
        itinerary_plan_ID,
        itinerary_route_ID,
        status: 1,
        deleted: 0,
      },
      orderBy: { itinerary_via_route_ID: 'asc' },
      select: { itinerary_via_location_name: true },
    });

    const values = rows
      .map((r: any) => String(r?.itinerary_via_location_name || '').trim())
      .filter((v: string) => Boolean(v));
    cache?.viaRouteNames.set(Number(itinerary_route_ID || 0), values);
    return values;
  } catch (error) {
    console.error('[getViaRouteNames] Error:', error);
    return [];
  }
}

/**
 * Calculate parking charges for hotspots in a route
 * PHP: getITINERARY_HOTSPOT_VEHICLE_PARKING_CHARGES_DETAILS
 * Uses the parking charge timeline table populated by hotspot-engine
 */
export async function calculateHotspotParkingCharges(
  prisma: any,
  vehicle_type_id: number,
  itinerary_plan_ID: number,
  itinerary_route_ID: number
): Promise<number> {
  try {
    const result = await prisma.$queryRaw<any[]>`
      SELECT COALESCE(SUM(parking_charges_amt), 0) as total_parking
      FROM dvi_itinerary_route_hotspot_parking_charge
      WHERE itinerary_plan_ID = ${itinerary_plan_ID}
      AND itinerary_route_ID = ${itinerary_route_ID}
      AND vehicle_type = ${vehicle_type_id}
      AND status = 1
      AND deleted = 0
    `;

    const derived = Number(result[0]?.total_parking ?? 0);
    if (derived > 0) return derived;

    // Fallback parity path: compute from route hotspot IDs + master parking table.
    const fallback = await prisma.$queryRaw<any[]>`
      SELECT COALESCE(SUM(hvpc.parking_charge), 0) AS total_parking
      FROM dvi_itinerary_route_hotspot_details rh
      JOIN dvi_hotspot_vehicle_parking_charges hvpc
        ON hvpc.hotspot_id = rh.hotspot_ID
       AND hvpc.vehicle_type_id = ${vehicle_type_id}
       AND hvpc.status = 1
       AND hvpc.deleted = 0
      WHERE rh.itinerary_plan_ID = ${itinerary_plan_ID}
        AND rh.itinerary_route_ID = ${itinerary_route_ID}
        AND rh.item_type = 4
        AND rh.status = 1
        AND rh.deleted = 0
    `;

    return Number(fallback[0]?.total_parking ?? 0);
  } catch (error) {
    console.error('[calculateHotspotParkingCharges] Error:', error);
    return 0;
  }
}

/**
 * Get stored location name from location_id
 * PHP: getSTOREDLOCATIONDETAILS($location_id, 'SOURCE_LOCATION')
 */
export async function getStoredLocationName(
  prisma: any,
  location_id: number
): Promise<string> {
  try {
    const result = await prisma.dvi_stored_locations.findUnique({
      where: { location_ID: location_id },
      select: { source_location: true }
    });
    return result?.source_location ?? '';
  } catch (error) {
    console.error('[getStoredLocationName] Error:', error);
    return '';
  }
}

/**
 * Get stored location city from location name
 * PHP: getSTOREDLOCATIONDETAILS($location_name, 'SOURCE_CITY')
 */
export async function getStoredLocationCity(
  prisma: any,
  location_name: string,
  cache?: VehicleCalcRunCache,
): Promise<string> {
  const cacheKey = normalizeCacheKey(location_name);
  const cached = cache?.storedLocationCity.get(cacheKey);
  if (typeof cached === 'string') {
    return cached;
  }
  try {
    const resolvedCity = await resolveCityRecordByName(prisma, location_name);
    if (resolvedCity?.name) {
      cache?.storedLocationCity.set(cacheKey, resolvedCity.name);
      return resolvedCity.name;
    }

    const exactSource = await prisma.dvi_stored_locations.findFirst({
      where: { 
        source_location: location_name,
        deleted: 0,
        status: 1
      },
      select: { source_location_city: true, source_city_id: true }
    });
    if (Number(exactSource?.source_city_id || 0) > 0) {
      const sourceCityName = await resolveCityNameById(
        prisma,
        Number(exactSource?.source_city_id || 0),
      );
      if (sourceCityName) {
        cache?.storedLocationCity.set(cacheKey, sourceCityName);
        return sourceCityName;
      }
    }
    if (exactSource?.source_location_city) {
      const value = String(exactSource.source_location_city);
      cache?.storedLocationCity.set(cacheKey, value);
      return value;
    }

    const exactDestination = await prisma.dvi_stored_locations.findFirst({
      where: {
        destination_location: location_name,
        deleted: 0,
        status: 1,
      },
      select: { destination_location_city: true, destination_city_id: true },
    });
    if (Number(exactDestination?.destination_city_id || 0) > 0) {
      const destinationCityName = await resolveCityNameById(
        prisma,
        Number(exactDestination?.destination_city_id || 0),
      );
      if (destinationCityName) {
        cache?.storedLocationCity.set(cacheKey, destinationCityName);
        return destinationCityName;
      }
    }
    if (exactDestination?.destination_location_city) {
      const value = String(exactDestination.destination_location_city);
      cache?.storedLocationCity.set(cacheKey, value);
      return value;
    }

    const normalizedNeedle = normalizeCityToken(location_name);
    if (!normalizedNeedle) return '';

    const fuzzy = await prisma.dvi_stored_locations.findFirst({
      where: {
        OR: [
          { source_location: { contains: location_name } },
          { destination_location: { contains: location_name } },
        ],
        deleted: 0,
        status: 1,
      },
      select: {
        source_location_city: true,
        destination_location_city: true,
        source_location: true,
        destination_location: true,
      },
      orderBy: { location_ID: 'desc' },
    });

    if (fuzzy) {
      const srcCity = String(fuzzy.source_location_city || '').trim();
      const dstCity = String(fuzzy.destination_location_city || '').trim();
      const srcLoc = String(fuzzy.source_location || '').trim();
      const dstLoc = String(fuzzy.destination_location || '').trim();

      if (normalizeCityToken(srcLoc).includes(normalizedNeedle) && srcCity) {
        cache?.storedLocationCity.set(cacheKey, srcCity);
        return srcCity;
      }
      if (normalizeCityToken(dstLoc).includes(normalizedNeedle) && dstCity) {
        cache?.storedLocationCity.set(cacheKey, dstCity);
        return dstCity;
      }
      const value = srcCity || dstCity || '';
      cache?.storedLocationCity.set(cacheKey, value);
      return value;
    }

    return '';
  } catch (error) {
    console.error('[getStoredLocationCity] Error:', error);
    return '';
  }
}

/**
 * Get location coordinates
 */
export async function getLocationCoordinates(
  prisma: any,
  location_name: string,
  cache?: VehicleCalcRunCache,
): Promise<{ latitude: number; longitude: number } | null> {
  const cacheKey = normalizeCacheKey(location_name);
  const cached = cache?.locationCoordinates.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const resolvedCity = await resolveCityRecordByName(prisma, location_name);

    const exactSource = await prisma.dvi_stored_locations.findFirst({
      where: {
        source_location: location_name,
        deleted: 0,
        status: 1,
      },
      orderBy: { location_ID: 'desc' },
      select: {
        source_location_lattitude: true,
        source_location_longitude: true,
      },
    });

    if (exactSource) {
      const value = {
        latitude: parseFloat(exactSource.source_location_lattitude || '0'),
        longitude: parseFloat(exactSource.source_location_longitude || '0')
      };
      cache?.locationCoordinates.set(cacheKey, value);
      return value;
    }

    const exactDestination = await prisma.dvi_stored_locations.findFirst({
      where: {
        destination_location: location_name,
        deleted: 0,
        status: 1,
      },
      orderBy: { location_ID: 'desc' },
      select: {
        destination_location_lattitude: true,
        destination_location_longitude: true,
      },
    });

    if (exactDestination) {
      const value = {
        latitude: parseFloat(exactDestination.destination_location_lattitude || '0'),
        longitude: parseFloat(exactDestination.destination_location_longitude || '0')
      };
      cache?.locationCoordinates.set(cacheKey, value);
      return value;
    }

    if (resolvedCity?.id) {
      const cityRoute = await prisma.dvi_stored_locations.findFirst({
        where: {
          deleted: 0,
          status: 1,
          OR: [
            {
              source_city_id: resolvedCity.id,
              destination_city_id: resolvedCity.id,
            },
            {
              source_location_city: resolvedCity.name,
              destination_location_city: resolvedCity.name,
            },
          ],
        } as any,
        orderBy: { location_ID: 'desc' },
        select: {
          source_location_lattitude: true,
          source_location_longitude: true,
        },
      });

      if (cityRoute) {
        const value = {
          latitude: parseFloat(cityRoute.source_location_lattitude || '0'),
          longitude: parseFloat(cityRoute.source_location_longitude || '0'),
        };
        cache?.locationCoordinates.set(cacheKey, value);
        return value;
      }
    }

    const locationToken = String(location_name || '').split(',')[0]?.trim() || String(location_name || '').trim();
    if (locationToken) {
      const fuzzySource = await prisma.dvi_stored_locations.findFirst({
        where: {
          source_location: { contains: locationToken },
          deleted: 0,
          status: 1,
        },
        orderBy: { location_ID: 'desc' },
        select: {
          source_location_lattitude: true,
          source_location_longitude: true,
        },
      });

      if (fuzzySource) {
        const value = {
          latitude: parseFloat(fuzzySource.source_location_lattitude || '0'),
          longitude: parseFloat(fuzzySource.source_location_longitude || '0')
        };
        cache?.locationCoordinates.set(cacheKey, value);
        return value;
      }
    }

    cache?.locationCoordinates.set(cacheKey, null);
    return null;
  } catch (error) {
    console.error('[getLocationCoordinates] Error:', error);
    return null;
  }
}

/**
 * Get vehicle location details (origin, city, coordinates)
 * PHP: Multiple calls to getSTOREDLOCATIONDETAILS
 */
export async function getVehicleLocationDetails(
  prisma: any,
  vehicle_location_id: number,
  fallbackOrigin?: string,
  fallbackCity?: string,
  cache?: VehicleCalcRunCache,
): Promise<{
  origin: string;
  city: string;
  latitude: number;
  longitude: number;
}> {
  const normalizedFallbackOrigin = String(fallbackOrigin || '').trim();
  const normalizedFallbackCity = String(fallbackCity || '').trim();
  const cacheKey = Number(vehicle_location_id || 0);
  const cached = cache?.vehicleLocationDetails.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const result =
      vehicle_location_id && vehicle_location_id !== 0
        ? await prisma.dvi_stored_locations.findUnique({
            where: { location_ID: BigInt(vehicle_location_id) },
            select: {
              source_location: true,
              source_location_city: true,
              source_city_id: true,
              source_location_lattitude: true,
              source_location_longitude: true
            }
          })
        : null;

    const canonicalCityName =
      Number(result?.source_city_id || 0) > 0
        ? await resolveCityNameById(prisma, Number(result?.source_city_id || 0))
        : '';

    const storedOrigin = String(result?.source_location || '').trim();
    const storedCity = canonicalCityName || String(result?.source_location_city || '').trim();
    const storedLatitude = parseFloat(result?.source_location_lattitude || '0');
    const storedLongitude = parseFloat(result?.source_location_longitude || '0');

    if (storedOrigin && hasUsableCoordinates(storedLatitude, storedLongitude)) {
      const value = {
        origin: storedOrigin,
        city: storedCity,
        latitude: storedLatitude,
        longitude: storedLongitude,
      };
      cache?.vehicleLocationDetails.set(cacheKey, value);
      return value;
    }

    const fallbackLookupName = normalizedFallbackOrigin || normalizedFallbackCity;
    const fallbackCoordinates = fallbackLookupName
      ? await getLocationCoordinates(prisma, fallbackLookupName, cache)
      : null;
    const fallbackLatitude = Number(fallbackCoordinates?.latitude || 0);
    const fallbackLongitude = Number(fallbackCoordinates?.longitude || 0);

    if (fallbackLookupName && hasUsableCoordinates(fallbackLatitude, fallbackLongitude)) {
      const value = {
        origin: normalizedFallbackOrigin || fallbackLookupName,
        city: normalizedFallbackCity || fallbackLookupName,
        latitude: fallbackLatitude,
        longitude: fallbackLongitude,
      };
      cache?.vehicleLocationDetails.set(cacheKey, value);
      return value;
    }

    const value = {
      origin: storedOrigin || normalizedFallbackOrigin,
      city: storedCity || normalizedFallbackCity,
      latitude: 0,
      longitude: 0,
    };
    cache?.vehicleLocationDetails.set(cacheKey, value);
    return value;
  } catch (error) {
    console.error('[getVehicleLocationDetails] Error:', error);
    return {
      origin: normalizedFallbackOrigin,
      city: normalizedFallbackCity,
      latitude: 0,
      longitude: 0,
    };
  }
}

/**
 * Calculate permit charges based on route state boundaries
 * Queries the permit charge table populated by route planning
 */
export async function calculatePermitCharges(
  prisma: any,
  itinerary_plan_ID: number,
  itinerary_route_ID: number,
  vendor_id: number,
  vendor_vehicle_type_ID: number,
  vendor_branch_id: number,
  cache?: VehicleCalcRunCache,
): Promise<number> {
  const cacheKey = buildCacheKey(
    itinerary_plan_ID,
    itinerary_route_ID,
    vendor_id,
    vendor_vehicle_type_ID,
    vendor_branch_id,
  );
  const cached = cache?.permitCharges.get(cacheKey);
  if (typeof cached === 'number') {
    return cached;
  }
  try {
    const result = await prisma.$queryRaw<any[]>`
      SELECT COALESCE(SUM(permit_cost), 0) as total_permit
      FROM dvi_itinerary_plan_route_permit_charge
      WHERE itinerary_plan_ID = ${itinerary_plan_ID}
      AND itinerary_route_ID = ${itinerary_route_ID}
      AND vendor_id = ${vendor_id}
      AND vendor_branch_id = ${vendor_branch_id}
      AND vendor_vehicle_type_id = ${vendor_vehicle_type_ID}
      AND status = 1
      AND deleted = 0
    `;
    const permitCharge = Number(result[0]?.total_permit ?? 0);
    console.log('[PERMIT_CHARGE_CALCULATED]', {
      planId: itinerary_plan_ID,
      routeId: itinerary_route_ID,
      vendorId: vendor_id,
      vendorBranchId: vendor_branch_id,
      vendorVehicleTypeId: vendor_vehicle_type_ID,
      vehicleId: null,
      permitCharge,
    });
    cache?.permitCharges.set(cacheKey, permitCharge);
    return permitCharge;
  } catch (error) {
    console.error('[calculatePermitCharges] Error:', error);
    return 0;
  }
}

/**
 * Determine travel type based on PHP logic
 * Returns 1 for LOCAL, 2 for OUTSTATION
 */
export function determineTravelType(
  route_count: number,
  total_routes: number,
  source_city: string,
  destination_city: string,
  vehicle_origin_city: string,
  previous_destination_city: string,
  check_local_via_route_city: boolean,
  force_local_trip: boolean = false,
): number {
    const sourceNorm = normalizeCityToken(source_city);
    const destNorm = normalizeCityToken(destination_city);
    const originNorm = normalizeCityToken(vehicle_origin_city);
    const prevNorm = normalizeCityToken(previous_destination_city);

    const isSameCityRoute =
      sourceNorm !== '' &&
      sourceNorm === destNorm &&
      check_local_via_route_city;

    const isVehicleOriginCityRoute =
      isSameCityRoute &&
      sourceNorm === originNorm;

    /**
     * Correct rule:
     * A same-city day is LOCAL only when that city is the vehicle origin city.
     *
     * Example:
     * Vehicle origin = Chennai
     * Mahabalipuram → Mahabalipuram = OUTSTATION
     *
     * Vehicle origin = Chennai
     * Chennai → Chennai = LOCAL
     */
    if (force_local_trip && isVehicleOriginCityRoute) {
      return 1; // LOCAL
    }

    if (isVehicleOriginCityRoute) {
      const isOriginCityFirstOrLast =
        route_count === 1 || route_count === total_routes;

      const isOriginCityContinuationDay =
        prevNorm !== '' && prevNorm === sourceNorm;

      if (isOriginCityFirstOrLast || isOriginCityContinuationDay) {
        return 1; // LOCAL
      }
    }

    return 2; // OUTSTATION
  }
  

  function sameCityViaRoutesRemainLocal(
    sourceCity: string,
    destinationCity: string,
    viaRouteNames: string[],
  ): boolean {
    const sourceNorm = normalizeCityToken(sourceCity);
    const destinationNorm = normalizeCityToken(destinationCity);

    if (!sourceNorm || sourceNorm !== destinationNorm) {
      return false;
    }

    const viaCityTokens = viaRouteNames
      .map((name) => normalizeCityToken(name))
      .filter(Boolean);

    if (!viaCityTokens.length) {
      return true;
    }

    return viaCityTokens.every((viaCity) => viaCity === sourceNorm);
  }

/**
 * Calculate time in HH.MM format from hours
 * PHP returns "25.1" meaning 25 hours and 1 minutes (actually 25 hours 6 minutes based on decimal .1 = 6 mins)
 */
export function calculateTotalHoursAndMinutes(times: string[]): string {
  let totalMinutes = 0;

  for (const time of times) {
    const parts = time.split(':');
    if (parts.length >= 2) {
      const hours = parseInt(parts[0] || '0', 10);
      const minutes = parseInt(parts[1] || '0', 10);
      totalMinutes += hours * 60 + minutes;
    }
  }

  const totalHours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;

  return `${totalHours}.${remainingMinutes}`;
}

/**
 * Sum string numbers (KMs are stored as strings in PHP)
 */
export function sumStringNumbers(numbers: string[]): string {
  const total = numbers.reduce((sum, num) => {
    const parsed = parseFloat(num || '0');
    return sum + (isNaN(parsed) ? 0 : parsed);
  }, 0);
  return total.toFixed(2);
}

/**
 * Get KM limit ID for a vendor's vehicle type
 * PHP: getKMLIMIT($vendor_vehicle_type_ID, 'get_kms_limit_id', $vendor_id)
 * This determines which outstation pricing row to use
 */
export async function getKmsLimitId(
  prisma: any,
  vendor_id: number,
  vendor_vehicle_type_ID: number
): Promise<number> {
  try {
    // Try to find existing vehicle details record for this vendor/vehicle type
    const existingVehicleDetails = await prisma.dvi_itinerary_plan_vendor_vehicle_details.findFirst({
      where: {
        vendor_id,
        vendor_vehicle_type_id: vendor_vehicle_type_ID,
        deleted: 0,
        status: 1,
      },
      select: {
        kms_limit_id: true,
      },
      orderBy: {
        createdby: 'desc', // Get most recent
      },
    });

    if (existingVehicleDetails && existingVehicleDetails.kms_limit_id) {
      return existingVehicleDetails.kms_limit_id;
    }

    // If no existing record, try to find from outstation pricebook
    const pricebook = await prisma.dvi_vehicle_outstation_price_book.findFirst({
      where: {
        vendor_id,
        vehicle_type_id: vendor_vehicle_type_ID,
        status: 1,
        deleted: 0,
      },
      select: {
        kms_limit_id: true,
      },
      orderBy: {
        kms_limit_id: 'asc', // Use lowest available
      },
    });

    if (pricebook) {
      return pricebook.kms_limit_id;
    }

    console.log(`[getKmsLimitId] No kms_limit_id found for vendor=${vendor_id}, vehicle_type=${vendor_vehicle_type_ID}, using default 1`);
    return 1; // Default fallback
  } catch (error) {
    console.error('[getKmsLimitId] Error:', error);
    return 1;
  }
}

/**
 * Get time limit ID for a vendor's vehicle type (for LOCAL trips)
 * PHP: getTIMELIMIT($vendor_vehicle_type_ID, 'get_time_limit_id_for_hours_and_km', $vendor_id, $TOTAL_HOURS, $TOTAL_KM)
 * Determines which local pricing row to use based on hours and KM
 */
export async function getTimeLimitId(
  prisma: any,
  vendor_id: number,
  vendor_vehicle_type_ID: number,
  total_hours?: number,
  total_km?: number,
  selected_time_limit_id?: number
): Promise<number> {
  try {
    const selectedTimeLimitId = Number(selected_time_limit_id || 0);
    if (selectedTimeLimitId > 0) {
      const selected = await prisma.dvi_time_limit.findFirst({
        where: {
          time_limit_id: selectedTimeLimitId,
          vendor_id,
          vendor_vehicle_type_id: vendor_vehicle_type_ID,
          status: 1,
          deleted: 0,
        },
        select: { time_limit_id: true },
      });

      if (selected?.time_limit_id) {
        return selectedTimeLimitId;
      }
    }

    // Auto mode: pick slab based on duty-hours first (client/local rule),
    // with KM as a tie-breaker inside same-hour slabs.
    const allSlabs = await prisma.dvi_time_limit.findMany({
      where: {
        vendor_id,
        vendor_vehicle_type_id: vendor_vehicle_type_ID,
        deleted: 0,
        status: 1,
      },
      select: {
        time_limit_id: true,
        hours_limit: true,
        km_limit: true,
        time_limit_title: true,
      },
      orderBy: {
        time_limit_id: 'asc',
      },
    });

    if (allSlabs.length) {
      const dutyHours = Number(total_hours || 0);
      const effectiveDutyHours = Math.max(0, dutyHours);
      const dutyKm = Number(total_km || 0);

      const normalized = allSlabs.map((s: any) => ({
        time_limit_id: Number(s.time_limit_id || 0),
        hours_limit: Number(s.hours_limit || 0),
        km_limit: getEffectiveTimeLimitKm(s),
      })).filter((s: any) => s.time_limit_id > 0);

      const byHoursAsc = [...normalized].sort((a, b) => {
        if (a.hours_limit !== b.hours_limit) return a.hours_limit - b.hours_limit;
        if (a.km_limit !== b.km_limit) return a.km_limit - b.km_limit;
        return a.time_limit_id - b.time_limit_id;
      });

      const pickByHours = (hours: number) => {
        if (hours <= 0) return byHoursAsc[0];
        const floorByHours = byHoursAsc.filter((s) => s.hours_limit <= hours);
        if (floorByHours.length) {
          return floorByHours[floorByHours.length - 1];
        }
        return byHoursAsc[0];
      };

      const byHours = pickByHours(effectiveDutyHours);
      return byHours.time_limit_id;
    }

    // Fallback: find from local pricebook when time_limit table rows are unavailable.
    const pricebook = await prisma.dvi_vehicle_local_pricebook.findFirst({
      where: {
        vendor_id,
        vehicle_type_id: vendor_vehicle_type_ID,
        status: 1,
        deleted: 0,
      },
      select: {
        time_limit_id: true,
      },
      orderBy: {
        time_limit_id: 'asc', // Use lowest available
      },
    });

    if (pricebook) {
      return pricebook.time_limit_id;
    }

    console.log(`[getTimeLimitId] No time_limit_id found for vendor=${vendor_id}, vehicle_type=${vendor_vehicle_type_ID}, using default 1`);
    return 1; // Default fallback
  } catch (error) {
    console.error('[getTimeLimitId] Error:', error);
    return 1;
  }
}

/**
 * Get LOCAL vehicle pricing from day-based pricebook
 * PHP: getVEHICLE_LOCAL_PRICEBOOK_COST($day, $year, $month, $vendor_id, $vendor_branch_id, $vendor_vehicle_type_ID, $time_limit_id)
 * Table: dvi_vehicle_local_pricebook with day_1...day_31 columns
 */
export async function getLocalVehiclePricingByDate(
  prisma: any,
  day: number,
  year: string,
  month: string,
  vendor_id: number,
  vendor_branch_id: number,
  vendor_vehicle_type_ID: number,
  time_limit_id: number,
  master_vehicle_type_id?: number
): Promise<number> {
  const debugVehicleTrace =
    process.env.DEBUG_DVI20260594_INSERT === 'true' ||
    process.env.DEBUG_VEHICLE_DUPLICATE_TRACE === 'true';
  try {
    const pricing = await prisma.dvi_vehicle_local_pricebook.findFirst({
      where: {
        vendor_id,
        vendor_branch_id,
        vehicle_type_id: vendor_vehicle_type_ID,
        time_limit_id,
        year,
        month,
        status: 1,
        deleted: 0
      }
    });

    if (!pricing) {
      const fallbackVehicleTypeId = Number(master_vehicle_type_id || 0);
      const fallbackPricing = fallbackVehicleTypeId > 0
        ? await prisma.dvi_vehicle_local_pricebook.findFirst({
            where: {
              vendor_id,
              vendor_branch_id,
              vehicle_type_id: fallbackVehicleTypeId,
              time_limit_id,
              year,
              month,
              status: 1,
              deleted: 0
            }
          })
        : null;
      if (debugVehicleTrace) {
        console.log('[MUV_PRICEBOOK_LOOKUP]', {
          vendor_id,
          vendor_branch_id,
          vehicle_type_id_used_in_query: vendor_vehicle_type_ID,
          vendor_vehicle_type_id: vendor_vehicle_type_ID,
          fallback_vehicle_type_id: fallbackVehicleTypeId || 0,
          time_limit_id,
          year,
          month,
          dayColumn: `day_${day}`,
          priceRowFound: Boolean(fallbackPricing),
          priceFound: Number(fallbackPricing?.[`day_${day}` as keyof typeof fallbackPricing] || 0) > 0,
        });
      }
      if (!fallbackPricing) {
        console.log(`[getLocalVehiclePricingByDate] No pricing found for vendor=${vendor_id}, branch=${vendor_branch_id}, vehicle_type=${vendor_vehicle_type_ID}, time_limit=${time_limit_id}, ${month} ${year}`);
        return 0;
      }
      const dayColumn = `day_${day}`;
      return toNum(fallbackPricing[dayColumn as keyof typeof fallbackPricing]);
    }

    // Get price from day column (day_1 through day_31)
    const dayColumn = `day_${day}`;
    const price = pricing[dayColumn as keyof typeof pricing];
    if (debugVehicleTrace && Number(master_vehicle_type_id || 0) === 23) {
      console.log('[MUV_PRICEBOOK_LOOKUP]', {
        vendor_id,
        vendor_branch_id,
        vehicle_type_id_used_in_query: vendor_vehicle_type_ID,
        vendor_vehicle_type_id: vendor_vehicle_type_ID,
        fallback_vehicle_type_id: Number(master_vehicle_type_id || 0),
        time_limit_id,
        year,
        month,
        dayColumn,
        priceRowFound: true,
        priceFound: toNum(price) > 0,
      });
    }
    
    return toNum(price);
  } catch (error) {
    console.error('[getLocalVehiclePricingByDate] Error:', error);
    return 0;
  }
}

function toFiniteCoord(v: any): number | null {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) && Math.abs(n) > 0 ? n : null;
}

function calculateHaversineKm(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
  const R = 6371;
  const dLat = ((toLat - fromLat) * Math.PI) / 180;
  const dLon = ((toLng - fromLng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((fromLat * Math.PI) / 180) *
      Math.cos((toLat * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function hasUsableCoordinates(lat: number | null | undefined, lng: number | null | undefined): boolean {
  const latNum = Number(lat ?? 0);
  const lngNum = Number(lng ?? 0);
  return Number.isFinite(latNum) && Number.isFinite(lngNum) && Math.abs(latNum) > 0.000001 && Math.abs(lngNum) > 0.000001;
}

function formatMinutesToDbDuration(minutes: number): string {
  const totalSeconds = Math.max(0, Math.ceil(minutes) * 60);
  return secondsToHms(totalSeconds);
}

async function resolveLocalHotelOrCityPoint(
  prisma: any,
  itinerary_plan_ID: number,
  route: RouteData,
  cache?: VehicleCalcRunCache,
): Promise<{ name: string; lat: number | null; lng: number | null; source: string }> {
  const cacheKey = Number(route.itinerary_route_ID || 0);
  const cached = cache?.localPoint.get(cacheKey);
  if (cached) {
    return cached;
  }
  const planHotel = await prisma.dvi_itinerary_plan_hotel_details.findFirst({
    where: {
      itinerary_plan_id: itinerary_plan_ID,
      itinerary_route_id: route.itinerary_route_ID,
      deleted: 0,
      status: 1,
    },
    orderBy: { itinerary_plan_hotel_details_ID: 'desc' },
    select: { hotel_id: true, hotel_code: true, itinerary_route_location: true },
  });

  if (planHotel?.hotel_id && Number(planHotel.hotel_id) > 0) {
    const dviHotel = await prisma.dvi_hotel.findFirst({
      where: { hotel_id: Number(planHotel.hotel_id), deleted: false as any },
      select: { hotel_name: true, hotel_latitude: true, hotel_longitude: true },
    });
    const lat = toFiniteCoord(dviHotel?.hotel_latitude);
    const lng = toFiniteCoord(dviHotel?.hotel_longitude);
    if (lat !== null && lng !== null) {
      const value = { name: String(dviHotel?.hotel_name || route.location_name), lat, lng, source: 'dvi_hotel' };
      cache?.localPoint.set(cacheKey, value);
      return value;
    }
  }

  const tboCode = String(planHotel?.hotel_code || '').trim();
  if (tboCode) {
    const tboHotel = await prisma.tbo_hotel_master.findFirst({
      where: { tbo_hotel_code: tboCode, status: 1 },
      select: { hotel_name: true, hotel_latitude: true, hotel_longitude: true },
    });
    const lat = toFiniteCoord(tboHotel?.hotel_latitude);
    const lng = toFiniteCoord(tboHotel?.hotel_longitude);
    if (lat !== null && lng !== null) {
      const value = { name: String(tboHotel?.hotel_name || route.location_name), lat, lng, source: 'tbo_hotel_master' };
      cache?.localPoint.set(cacheKey, value);
      return value;
    }
  }

  const cityFallback = await prisma.dvi_stored_locations.findFirst({
    where: {
      source_location: route.location_name,
      destination_location: route.location_name,
      deleted: 0,
      status: 1,
    },
    orderBy: { location_ID: 'desc' },
    select: {
      source_location: true,
      source_location_lattitude: true,
      source_location_longitude: true,
    },
  });
  const cityLat = toFiniteCoord(cityFallback?.source_location_lattitude);
  const cityLng = toFiniteCoord(cityFallback?.source_location_longitude);
  if (cityLat !== null && cityLng !== null) {
    const value = {
      name: String(cityFallback?.source_location || route.location_name),
      lat: cityLat,
      lng: cityLng,
      source: 'city_fallback',
    };
    cache?.localPoint.set(cacheKey, value);
    return value;
  }

  const value = { name: route.location_name, lat: null, lng: null, source: 'old_fallback' };
  cache?.localPoint.set(cacheKey, value);
  return value;
}

export async function getPricedLocalTimeLimitId(
  prisma: any,
  vendor_id: number,
  vendor_branch_id: number,
  vendor_vehicle_type_ID: number,
  day: number,
  year: string,
  month: string,
  total_hours?: number,
  total_km?: number,
  selected_time_limit_id?: number
): Promise<{ timeLimitId: number; price: number }> {
  try {
    const slabs = await prisma.dvi_time_limit.findMany({
      where: {
        vendor_id,
        vendor_vehicle_type_id: vendor_vehicle_type_ID,
        status: 1,
        deleted: 0,
      },
      select: {
        time_limit_id: true,
        hours_limit: true,
        km_limit: true,
        time_limit_title: true,
      },
      orderBy: [
        { hours_limit: 'asc' },
        { km_limit: 'asc' },
        { time_limit_id: 'asc' },
      ],
    });

    if (!slabs.length) return { timeLimitId: 0, price: 0 };

    const dayColumn = `day_${day}`;
    const priced: Array<{ time_limit_id: number; hours_limit: number; km_limit: number; price: number }> = [];

    for (const slab of slabs) {
      const priceRow = await prisma.dvi_vehicle_local_pricebook.findFirst({
        where: {
          vendor_id,
          vendor_branch_id,
          vehicle_type_id: vendor_vehicle_type_ID,
          time_limit_id: Number(slab.time_limit_id || 0),
          year,
          month,
          status: 1,
          deleted: 0,
        },
      });
      if (!priceRow) continue;
      const price = toNum((priceRow as any)[dayColumn]);
      if (price <= 0) continue;
      priced.push({
        time_limit_id: Number(slab.time_limit_id || 0),
        hours_limit: Number(slab.hours_limit || 0),
        km_limit: getEffectiveTimeLimitKm(slab),
        price,
      });
    }

    if (!priced.length) return { timeLimitId: 0, price: 0 };

    const selectedId = Number(selected_time_limit_id || 0);
    if (selectedId > 0) {
      const selectedPriced = priced.find((s) => s.time_limit_id === selectedId);
      if (selectedPriced) {
        return { timeLimitId: selectedPriced.time_limit_id, price: selectedPriced.price };
      }
    }

    const dutyHours = Math.max(0, Number(total_hours || 0));
    const byHoursAsc = [...priced].sort((a, b) => {
      if (a.hours_limit !== b.hours_limit) return a.hours_limit - b.hours_limit;
      if (a.km_limit !== b.km_limit) return a.km_limit - b.km_limit;
      return a.time_limit_id - b.time_limit_id;
    });
    const floorByHours = byHoursAsc.filter((s) => s.hours_limit <= dutyHours);
    const chosen = floorByHours.length ? floorByHours[floorByHours.length - 1] : byHoursAsc[0];
    return { timeLimitId: Number(chosen.time_limit_id || 0), price: Number(chosen.price || 0) };
  } catch (error) {
    console.error('[getPricedLocalTimeLimitId] Error:', error);
    return { timeLimitId: 0, price: 0 };
  }
}

/**
 * Get OUTSTATION vehicle pricing from day-based pricebook
 * PHP: getVEHICLE_OUTSTATION_PRICEBOOK_COST($day, $year, $month, $vendor_id, $vendor_branch_id, $vendor_vehicle_type_ID, $kms_limit_id)
 * Table: dvi_vehicle_outstation_price_book with day_1...day_31 columns
 */
export async function getOutstationVehiclePricingByDate(
  prisma: any,
  day: number,
  year: string,
  month: string,
  vendor_id: number,
  vendor_branch_id: number,
  vendor_vehicle_type_ID: number,
  kms_limit_id: number
): Promise<number> {
  try {
    const pricing = await prisma.dvi_vehicle_outstation_price_book.findFirst({
      where: {
        vendor_id,
        vendor_branch_id,
        vehicle_type_id: vendor_vehicle_type_ID,
        kms_limit_id,
        year,
        month,
        status: 1,
        deleted: 0
      }
    });

    if (!pricing) {
      console.log(`[getOutstationVehiclePricingByDate] No pricing found for vendor=${vendor_id}, branch=${vendor_branch_id}, vehicle_type=${vendor_vehicle_type_ID}, kms_limit=${kms_limit_id}, ${month} ${year}`);
      return 0;
    }

    // Get price from day column (day_1 through day_31)
    const dayColumn = `day_${day}`;
    const price = pricing[dayColumn as keyof typeof pricing];
    
    return toNum(price);
  } catch (error) {
    console.error('[getOutstationVehiclePricingByDate] Error:', error);
    return 0;
  }
}

/**
 * DEPRECATED - Old local pricing function (kept for reference)
 * Use getLocalVehiclePricingByDate instead
 */
export async function getLocalVehiclePricing(
  prisma: any,
  vehicle_type_id: number,
  time_limit_id: number
): Promise<{
  vehicle_cost: number;
  allowed_km: number;
  extra_km_charge: number;
}> {
  try {
    const pricing = await prisma.dvi_vehicle_local_pricebook.findFirst({
      where: {
        vehicle_type_id,
        time_limit_id,
        status: 1,
        deleted: 0
      },
      select: {
        local_vehicle_rate: true,
        allowed_kms: true,
        extra_km_charges: true
      }
    });

    return {
      vehicle_cost: toNum(pricing?.local_vehicle_rate),
      allowed_km: toNum(pricing?.allowed_kms),
      extra_km_charge: toNum(pricing?.extra_km_charges)
    };
  } catch (error) {
    console.error('[getLocalVehiclePricing] Error:', error);
    return { vehicle_cost: 0, allowed_km: 0, extra_km_charge: 0 };
  }
}

/**
 * DEPRECATED - Old outstation pricing function (kept for reference)
 * Use getOutstationVehiclePricingByDate instead
 */
export async function getOutstationVehiclePricing(
  prisma: any,
  vendor_vehicle_type_ID: number,
  total_kms: number
): Promise<number> {
  try {
    const vehicleType = await prisma.vendor_vehicle_type.findUnique({
      where: { vendor_vehicle_type_ID },
      select: {
        outstation_allowed_km_per_day: true,
        outstation_vehicle_rate_per_day: true
      }
    });

    if (!vehicleType) return 0;

    const allowedKm = toNum(vehicleType.outstation_allowed_km_per_day);
    const ratePerDay = toNum(vehicleType.outstation_vehicle_rate_per_day);

    // PHP logic: rental based on allowed KM per day
    // If total KM exceeds allowed, still charges base rate
    return ratePerDay;
  } catch (error) {
    console.error('[getOutstationVehiclePricing] Error:', error);
    return 0;
  }
}

/**
 * Calculate sightseeing KMs for hotspots in a route
 * PHP: getITINEARY_ROUTE_HOTSPOT_DETAILS('', $plan_id, $route_id, 'SIGHT_SEEING_TRAVELLING_DISTANCE')
 * Sums travel distances from hotspot timeline where item_type = 3 (SiteSeeingTravel)
 */
export async function calculateSightseeingKm(
  prisma: any,
  itinerary_plan_ID: number,
  itinerary_route_ID: number
): Promise<{ km: string; time: string | null }> {
  try {
    // PHP parity: sightseeing includes item_type 1,3,4
    const result = await prisma.$queryRaw<any[]>`
      SELECT 
        COALESCE(SUM(CAST(hotspot_travelling_distance AS DECIMAL(10,2))), 0) as total_sightseeing_km,
        SEC_TO_TIME(COALESCE(SUM(TIME_TO_SEC(hotspot_traveling_time)), 0)) as total_sightseeing_time
      FROM dvi_itinerary_route_hotspot_details
      WHERE itinerary_plan_ID = ${itinerary_plan_ID}
      AND itinerary_route_ID = ${itinerary_route_ID}
      AND item_type IN (1,3,4)
      AND status = 1
      AND deleted = 0
    `;

    const totalKm = Number(result[0]?.total_sightseeing_km ?? 0);
    const totalTime = result[0]?.total_sightseeing_time;

    return {
      km: totalKm.toFixed(2),
      time: totalTime || null
    };
  } catch (error) {
    console.error('[calculateSightseeingKm] Error:', error);
    return { km: '0', time: null };
  }
}

/**
 * Calculate pickup distance for Day 1
 * Distance from vehicle origin to route source
 */
export function calculatePickupDistance(
  vehicle_origin_latitude: number,
  vehicle_origin_longitude: number,
  route_source_latitude: number,
  route_source_longitude: number
): number {
  if (!vehicle_origin_latitude || !vehicle_origin_longitude || 
      !route_source_latitude || !route_source_longitude) {
    return 0;
  }

  return calculateDistance(
    vehicle_origin_latitude,
    vehicle_origin_longitude,
    route_source_latitude,
    route_source_longitude
  );
}

/**
 * Calculate drop distance for last day
 * Distance from route destination to vehicle origin
 */
export function calculateDropDistance(
  route_destination_latitude: number,
  route_destination_longitude: number,
  vehicle_origin_latitude: number,
  vehicle_origin_longitude: number
): number {
  if (!route_destination_latitude || !route_destination_longitude ||
      !vehicle_origin_latitude || !vehicle_origin_longitude) {
    return 0;
  }

  return calculateDistance(
    route_destination_latitude,
    route_destination_longitude,
    vehicle_origin_latitude,
    vehicle_origin_longitude
  );
}

/**
 * Main function to calculate complete route vehicle details
 * Mirrors PHP logic from ajax_latest_itineary_manage_vehicle_details.php lines 400-1700
 */
export async function calculateRouteVehicleDetails(
  ctx: VehicleCalculationContext,
  route: RouteData,
  route_count: number,
  total_routes: number,
  previous_destination_city: string,
  isLastRouteOfDay: boolean = false,
  isFirstRouteOfDay: boolean = false
): Promise<RouteCalculationResult> {
  const { prisma, itinerary_plan_ID, vehicle_type_id, vendor_id, vendor_vehicle_type_ID, vendor_branch_id } = ctx;
  const cache = ctx.buildCache;
  const debugVehicleTrace =
    process.env.DEBUG_DVI20260594_INSERT === 'true' ||
    process.env.DEBUG_VEHICLE_DUPLICATE_TRACE === 'true';
  const isMuvTrace = Number(ctx.vehicle_type_id || 0) === 23;
  const debugInsert = process.env.DEBUG_DVI20260594_INSERT === 'true';
  const debugLocalFix =
    process.env.DEBUG_LOCAL_PICKUP_DROP_FIX === 'true' ||
    process.env.DEBUG_LOCAL_KM_FIX === 'true';
  const LOCAL_TRAFFIC_DISTANCE_FACTOR = Number(process.env.LOCAL_TRAFFIC_DISTANCE_FACTOR || 1.25);
  const LOCAL_TRAFFIC_AVG_SPEED_KMPH = Number(process.env.LOCAL_TRAFFIC_AVG_SPEED_KMPH || 22);

  // Get route location details
  const sourceLocationId = await getLocationIdFromSourceDest(
    prisma,
    route.location_name,
    route.next_visiting_location,
    { planId: itinerary_plan_ID, routeId: route.itinerary_route_ID },
    cache,
  );
  
  // Get city names for travel type determination
  const sourceCity = await getStoredLocationCity(prisma, route.location_name, cache);
  const destCity = await getStoredLocationCity(prisma, route.next_visiting_location, cache);

  // Get coordinates for distance calculations
  const sourceCoords = await getLocationCoordinates(prisma, route.location_name, cache);
  const destCoords = await getLocationCoordinates(prisma, route.next_visiting_location, cache);
  const viaRouteNames = await getViaRouteNames(prisma, itinerary_plan_ID, route.itinerary_route_ID, cache);

  // Same-city routes remain LOCAL only when all via stops stay in the same city.
  // Example: Bangalore -> Mysore -> Bangalore must be OUTSTATION for that day.
  const check_local_via_route_city = sameCityViaRoutesRemainLocal(
    sourceCity,
    destCity,
    viaRouteNames,
  );

  // Determine travel type (LOCAL=1 or OUTSTATION=2)
  const travel_type = determineTravelType(
    route_count,
    total_routes,
    sourceCity,
    destCity,
    ctx.vehicle_origin_city,
    previous_destination_city,
    check_local_via_route_city,
    Boolean((ctx as any).force_local_trip)
  );
  if (debugVehicleTrace && isMuvTrace) {
    console.log('[MUV_TRAVEL_TYPE_DECISION]', {
      routeId: route.itinerary_route_ID,
      route_count,
      total_routes,
      sourceCity,
      destCity,
      vehicle_origin_city: ctx.vehicle_origin_city,
      previous_destination_city,
      check_local_via_route_city,
      force_local_trip: Boolean((ctx as any).force_local_trip),
      travel_type,
    });
  }

  // Initialize variables
  let TOTAL_RUNNING_KM = '0';
  let TOTAL_TRAVELLING_TIME: string | null = null;
  let SIGHT_SEEING_TRAVELLING_KM = '0';
  let SIGHT_SEEING_TRAVELLING_TIME: string | null = null;
  let TOTAL_PICKUP_KM = '0';
  let TOTAL_PICKUP_DURATION: string | null = null;
  let TOTAL_DROP_KM = '0';
  let TOTAL_DROP_DURATION: string | null = null;
  let vehicle_cost_for_the_day = 0;
  let time_limit_id = 0;
  let kms_limit_id = 0;
  let TOTAL_LOCAL_EXTRA_KM = 0;
  let TOTAL_LOCAL_EXTRA_KM_CHARGES = 0;
  let TOTAL_LOCAL_EXTRA_HOURS = 0;
  let TOTAL_LOCAL_EXTRA_HOUR_CHARGES = 0;
  let TOTAL_ALLOWED_LOCAL_KM = 0;
  let TOTAL_ALLOWED_OUTSTATION_KM = 0;

  const hotspotMetrics = await getRouteHotspotMetrics(
    prisma,
    itinerary_plan_ID,
    route.itinerary_route_ID,
    cache,
  );

  const baseRunningKm = Number(hotspotMetrics.runningKm || 0);
  const baseRunningTimeSeconds = Number(hotspotMetrics.runningSeconds || 0);
  const baseSightseeingKm = Number(hotspotMetrics.sightseeingKm || 0);
  const sightseeingTimeSeconds = Number(hotspotMetrics.sightseeingSeconds || 0);
  const plannedRouteKm = Number(route.no_of_km || 0);

  let localSpeed = Number(cache?.globalSettings?.localSpeed ?? 0) || 0;
  let outstationSpeed = Number(cache?.globalSettings?.outstationSpeed ?? 0) || 0;
  if (!localSpeed || !outstationSpeed) {
    const globalSettings = await prisma.dvi_global_settings.findFirst({
      where: { deleted: 0 },
      orderBy: { global_settings_ID: 'asc' },
      select: {
        itinerary_local_speed_limit: true,
        itinerary_outstation_speed_limit: true,
      },
    });
    localSpeed = Number(globalSettings?.itinerary_local_speed_limit ?? 40) || 40;
    outstationSpeed = Number(globalSettings?.itinerary_outstation_speed_limit ?? 60) || 60;
    if (cache) {
      cache.globalSettings = { localSpeed, outstationSpeed };
    }
  }

  const isItineraryEdgeTransferRoute =
    route_count === 1 || route_count === total_routes;

  let effectiveRunningKm = baseRunningKm;
  let effectiveRunningTimeSeconds = baseRunningTimeSeconds;
  let effectiveSightseeingKm = baseSightseeingKm;
  let effectiveSightseeingTimeSeconds = sightseeingTimeSeconds;
  let excludedArrivalTransferKm = 0;
  let excludedDepartureTransferKm = 0;

  if (travel_type === 1 && !isItineraryEdgeTransferRoute) {
    // For local mid-itinerary segments, treat hotspot movement as sightseeing/local usage.
    effectiveSightseeingKm += effectiveRunningKm;
    effectiveSightseeingTimeSeconds += effectiveRunningTimeSeconds;
    effectiveRunningKm = 0;
    effectiveRunningTimeSeconds = 0;
  }

  TOTAL_RUNNING_KM = String(effectiveRunningKm.toFixed(2));

  const isBaseCityLocalRoute =
    travel_type === 1 &&
    sourceCity === ctx.vehicle_origin_city &&
    destCity === ctx.vehicle_origin_city;

  const pickupTargetName =
    travel_type === 1 && route_count > 1
      ? (sourceCity || route.location_name)
      : route.location_name;
  const dropSourceName =
    travel_type === 1 && route_count < total_routes
      ? (destCity || route.next_visiting_location)
      : route.next_visiting_location;

  const pickupTargetCoords = pickupTargetName === route.location_name
    ? sourceCoords
    : await getLocationCoordinates(prisma, pickupTargetName, cache);
  const dropSourceCoords = dropSourceName === route.next_visiting_location
    ? destCoords
    : await getLocationCoordinates(prisma, dropSourceName, cache);

  const applyPickupForThisRoute =
    travel_type === 1
      ? isFirstRouteOfDay
      : !!sourceCoords && route_count === 1;
  const isFinalItineraryRoute = route_count === total_routes;
  const applyDropForThisRoute =
    travel_type === 1
      ? isFinalItineraryRoute
      : !!destCoords && isFinalItineraryRoute;

  if (travel_type === 1 && isLastRouteOfDay && !isFinalItineraryRoute) {
    console.warn('[VEHICLE_DROP_SUPPRESSED_NON_FINAL_LOCAL_ROUTE]', {
      planId: itinerary_plan_ID,
      routeId: route.itinerary_route_ID,
      routeCount: route_count,
      totalRoutes: total_routes,
      locationName: route.location_name,
      nextVisitingLocation: route.next_visiting_location,
    });
  }

  const pickupFromName =
    travel_type === 1 && route_count > 1
      ? route.location_name
      : ctx.vehicle_origin;
  const pickupToName = pickupTargetName;
  const pickupFromCoords =
    travel_type === 1 && route_count > 1
      ? (await getLocationCoordinates(prisma, pickupFromName, cache))
      : (
          hasUsableCoordinates(ctx.vehicle_origin_latitude, ctx.vehicle_origin_longitude)
            ? {
                latitude: Number(ctx.vehicle_origin_latitude || 0),
                longitude: Number(ctx.vehicle_origin_longitude || 0),
              }
            : (pickupFromName ? await getLocationCoordinates(prisma, pickupFromName, cache) : null)
        );

  const dropFromNameFinal = dropSourceName;
  const dropToNameFinal = ctx.vehicle_origin;
  const fallbackVehicleOriginCoords =
    hasUsableCoordinates(ctx.vehicle_origin_latitude, ctx.vehicle_origin_longitude)
      ? {
          latitude: Number(ctx.vehicle_origin_latitude || 0),
          longitude: Number(ctx.vehicle_origin_longitude || 0),
        }
      : (ctx.vehicle_origin ? await getLocationCoordinates(prisma, ctx.vehicle_origin, cache) : null);
  const dropToCoordsFinal = {
    latitude: Number(fallbackVehicleOriginCoords?.latitude || 0),
    longitude: Number(fallbackVehicleOriginCoords?.longitude || 0),
  };
  let pickupDebug: RouteCalculationResult['PICKUP_DEBUG'] = {
    vehicleOrigin: String(ctx.vehicle_origin || ''),
    pickupFrom: String(pickupFromName || ''),
    pickupTo: String(pickupToName || ''),
    matchedStoredLocationId: null,
    matchedStoredLocationSource: null,
    matchedStoredLocationDestination: null,
    matchedStoredLocationDistance: null,
    calculationSource: 'unknown',
  };

  // Operational rule: pickup applies per route rules; local routes can include a daily shed return drop.
  if (applyPickupForThisRoute) {
    if (travel_type === 1 && route_count > 1) {
      const localPoint = await resolveLocalHotelOrCityPoint(prisma, itinerary_plan_ID, route, cache);
      if (
        localPoint.lat !== null &&
        localPoint.lng !== null &&
        Number(ctx.vehicle_origin_latitude || 0) &&
        Number(ctx.vehicle_origin_longitude || 0)
      ) {
        const haversineKm = calculateHaversineKm(
          Number(ctx.vehicle_origin_latitude),
          Number(ctx.vehicle_origin_longitude),
          localPoint.lat,
          localPoint.lng,
        );
        const billableKm = haversineKm * LOCAL_TRAFFIC_DISTANCE_FACTOR;
        const durationMinutes = Math.ceil((billableKm / LOCAL_TRAFFIC_AVG_SPEED_KMPH) * 60);
        TOTAL_PICKUP_KM = String(billableKm.toFixed(2));
        TOTAL_PICKUP_DURATION = formatMinutesToDbDuration(durationMinutes);
        pickupDebug = {
          ...pickupDebug,
          calculationSource: 'haversine',
        };
        if (debugLocalFix) {
          console.log('[LOCAL_PICKUP_DROP_FIX_INPUT]', {
            planId: itinerary_plan_ID, routeId: route.itinerary_route_ID, route_count, total_routes, travel_type,
            routeLocation: route.location_name, nextVisiting: route.next_visiting_location,
            vehicleOriginName: ctx.vehicle_origin, vehicleOriginLatLng: [ctx.vehicle_origin_latitude, ctx.vehicle_origin_longitude],
            hotelPointName: localPoint.name, hotelPointLatLng: [localPoint.lat, localPoint.lng], hotelPointSource: localPoint.source,
          });
          console.log('[LOCAL_PICKUP_DROP_FIX_DISTANCE]', {
            legType: 'pickup',
            fromName: ctx.vehicle_origin, toName: localPoint.name,
            fromLatLng: [ctx.vehicle_origin_latitude, ctx.vehicle_origin_longitude], toLatLng: [localPoint.lat, localPoint.lng],
            haversineKm, trafficFactor: LOCAL_TRAFFIC_DISTANCE_FACTOR, billableKm, avgSpeed: LOCAL_TRAFFIC_AVG_SPEED_KMPH,
            durationMinutes, fallbackUsed: false,
          });
        }
      }
      const localSelfPickup = await getCachedStoredLocationPair<{
        distance: number | string | null;
        duration: string | null;
      }>({
        planId: itinerary_plan_ID,
        routeId: route.itinerary_route_ID,
        source: route.location_name,
        destination: route.location_name,
        lookup: () =>
          prisma.dvi_stored_locations.findFirst({
            where: {
              source_location: route.location_name,
              destination_location: route.location_name,
              deleted: 0,
              status: 1,
            },
            orderBy: { location_ID: 'desc' },
            select: { distance: true, duration: true },
          }),
        serialize: (value) => ({
          distance: Number(value?.distance || 0) || null,
          duration: String(value?.duration || ''),
        }),
      });

      if (toNum(TOTAL_PICKUP_KM) <= 0 && localSelfPickup && Number(localSelfPickup.distance || 0) > 0) {
        const pickupKm = Number(localSelfPickup.distance || 0);
        const storedHms = parseStoredDurationToHms(localSelfPickup.duration);
        const storedSeconds = parseHmsToSeconds(storedHms);
        const minSecondsBySpeed = localSpeed > 0
          ? Math.round((pickupKm / localSpeed) * 3600)
          : 0;

        TOTAL_PICKUP_KM = String(pickupKm.toFixed(2));
        TOTAL_PICKUP_DURATION = secondsToHms(Math.max(storedSeconds, minSecondsBySpeed));
        pickupDebug = {
          ...pickupDebug,
          matchedStoredLocationSource: route.location_name,
          matchedStoredLocationDestination: route.location_name,
          matchedStoredLocationDistance: pickupKm,
          calculationSource: 'stored_location',
        };
        if (debugInsert) {
          console.log('[PICKUP_DECISION]', {
            branch_name: 'local_self_pickup',
            source_query_used: 'dvi_stored_locations source=route.location_name destination=route.location_name',
            source_location: route.location_name,
            destination_location: route.location_name,
            distance: localSelfPickup.distance,
            duration: localSelfPickup.duration,
            TOTAL_PICKUP_KM,
          });
        }
      }
    }

    const isFirstLocalArrivalLeg =
      travel_type === 1 && route_count === 1;

    if (
      toNum(TOTAL_PICKUP_KM) <= 0 &&
      isFirstLocalArrivalLeg &&
      pickupTargetCoords &&
      pickupFromCoords &&
      hasUsableCoordinates(Number(pickupFromCoords.latitude || 0), Number(pickupFromCoords.longitude || 0)) &&
      hasUsableCoordinates(Number(pickupTargetCoords.latitude || 0), Number(pickupTargetCoords.longitude || 0))
    ) {
      const directLeg = calculateDistanceAndDuration(
        Number(pickupFromCoords.latitude || 0),
        Number(pickupFromCoords.longitude || 0),
        Number(pickupTargetCoords.latitude || 0),
        Number(pickupTargetCoords.longitude || 0),
        localSpeed,
        1.5,
      );
      TOTAL_PICKUP_KM = String(toNum(directLeg.distance).toFixed(2));
      TOTAL_PICKUP_DURATION = parsePhpDurationToHms(directLeg.duration);
      pickupDebug = {
        ...pickupDebug,
        calculationSource: 'haversine',
      };
    } else if (toNum(TOTAL_PICKUP_KM) <= 0) {
      if (
        pickupTargetCoords &&
        pickupFromCoords &&
        hasUsableCoordinates(Number(pickupFromCoords.latitude || 0), Number(pickupFromCoords.longitude || 0)) &&
        hasUsableCoordinates(Number(pickupTargetCoords.latitude || 0), Number(pickupTargetCoords.longitude || 0))
      ) {
        const pickupDistance = await getLegDistanceAndDuration(
          prisma,
          pickupFromName,
          pickupToName,
          Number(pickupFromCoords.latitude || 0),
          Number(pickupFromCoords.longitude || 0),
          pickupTargetCoords.latitude,
          pickupTargetCoords.longitude,
          getTravelLocationType(ctx.vehicle_origin_city, sourceCity),
          localSpeed,
          outstationSpeed,
          { planId: itinerary_plan_ID, routeId: route.itinerary_route_ID },
        );
        let pickupKm = toNum(pickupDistance.distance);
        if (travel_type === 1 && route_count > 1 && pickupKm <= 0) {
          pickupKm = toNum(route.no_of_km);
        }
        TOTAL_PICKUP_KM = String(pickupKm.toFixed(2));
        TOTAL_PICKUP_DURATION = pickupDistance.duration;
        pickupDebug = {
          ...pickupDebug,
          calculationSource: 'existing_db',
        };
      } else if (travel_type === 1 && route_count > 1) {
        TOTAL_PICKUP_KM = String(toNum(route.no_of_km).toFixed(2));
        pickupDebug = {
          ...pickupDebug,
          calculationSource: 'fallback',
        };
      }
    }
  }

  if (applyDropForThisRoute) {
    const isLastLocalDepartureLeg = travel_type === 1 && route_count === total_routes;

    if (isLastLocalDepartureLeg && dropSourceCoords && dropToCoordsFinal) {
      const directLeg = calculateDistanceAndDuration(
        Number(dropSourceCoords.latitude || 0),
        Number(dropSourceCoords.longitude || 0),
        Number(dropToCoordsFinal.latitude || 0),
        Number(dropToCoordsFinal.longitude || 0),
        localSpeed,
        1.5,
      );
      TOTAL_DROP_KM = String(toNum(directLeg.distance).toFixed(2));
      TOTAL_DROP_DURATION = parsePhpDurationToHms(directLeg.duration);
    }

    if (toNum(TOTAL_DROP_KM) <= 0 && travel_type === 1 && isFinalItineraryRoute) {
      const localPoint = await resolveLocalHotelOrCityPoint(prisma, itinerary_plan_ID, route, cache);
      if (
        localPoint.lat !== null &&
        localPoint.lng !== null &&
        Number(ctx.vehicle_origin_latitude || 0) &&
        Number(ctx.vehicle_origin_longitude || 0)
      ) {
        const haversineKm = calculateHaversineKm(
          localPoint.lat,
          localPoint.lng,
          Number(ctx.vehicle_origin_latitude),
          Number(ctx.vehicle_origin_longitude),
        );
        const billableKm = haversineKm * LOCAL_TRAFFIC_DISTANCE_FACTOR;
        const durationMinutes = Math.ceil((billableKm / LOCAL_TRAFFIC_AVG_SPEED_KMPH) * 60);
        TOTAL_DROP_KM = String(billableKm.toFixed(2));
        TOTAL_DROP_DURATION = formatMinutesToDbDuration(durationMinutes);
        if (debugLocalFix) {
          console.log('[LOCAL_PICKUP_DROP_FIX_DISTANCE]', {
            legType: 'drop',
            fromName: localPoint.name, toName: ctx.vehicle_origin,
            fromLatLng: [localPoint.lat, localPoint.lng], toLatLng: [ctx.vehicle_origin_latitude, ctx.vehicle_origin_longitude],
            haversineKm, trafficFactor: LOCAL_TRAFFIC_DISTANCE_FACTOR, billableKm, avgSpeed: LOCAL_TRAFFIC_AVG_SPEED_KMPH,
            durationMinutes, fallbackUsed: false,
          });
        }
      }
      const localSelfDrop = await getCachedStoredLocationPair<{
        distance: number | string | null;
        duration: string | null;
      }>({
        planId: itinerary_plan_ID,
        routeId: route.itinerary_route_ID,
        source: route.next_visiting_location,
        destination: route.next_visiting_location,
        lookup: () =>
          prisma.dvi_stored_locations.findFirst({
            where: {
              source_location: route.next_visiting_location,
              destination_location: route.next_visiting_location,
              deleted: 0,
              status: 1,
            },
            orderBy: { location_ID: 'desc' },
            select: { distance: true, duration: true },
          }),
        serialize: (value) => ({
          distance: Number(value?.distance || 0) || null,
          duration: String(value?.duration || ''),
        }),
      });

      if (toNum(TOTAL_DROP_KM) <= 0 && localSelfDrop && Number(localSelfDrop.distance || 0) > 0) {
        const dropKm = Number(localSelfDrop.distance || 0);
        const storedHms = parseStoredDurationToHms(localSelfDrop.duration);
        const storedSeconds = parseHmsToSeconds(storedHms);
        const minSecondsBySpeed = localSpeed > 0
          ? Math.round((dropKm / localSpeed) * 3600)
          : 0;

        TOTAL_DROP_KM = String(dropKm.toFixed(2));
        TOTAL_DROP_DURATION = secondsToHms(Math.max(storedSeconds, minSecondsBySpeed));
        if (debugInsert) {
          console.log('[DROP_DECISION]', {
            branch_name: 'local_self_drop',
            source_query_used: 'dvi_stored_locations source=route.next_visiting_location destination=route.next_visiting_location',
            source_location: route.next_visiting_location,
            destination_location: route.next_visiting_location,
            distance: localSelfDrop.distance,
            duration: localSelfDrop.duration,
            TOTAL_DROP_KM,
          });
        }
      }
    }

    if (toNum(TOTAL_DROP_KM) <= 0) {
      const dropDistance = await getLegDistanceAndDuration(
        prisma,
        dropFromNameFinal,
        dropToNameFinal,
        Number(dropSourceCoords?.latitude || 0),
        Number(dropSourceCoords?.longitude || 0),
        Number(dropToCoordsFinal.latitude || 0),
        Number(dropToCoordsFinal.longitude || 0),
        getTravelLocationType(destCity, ctx.vehicle_origin_city),
        localSpeed,
        outstationSpeed,
        { planId: itinerary_plan_ID, routeId: route.itinerary_route_ID },
      );
      let dropKm = toNum(dropDistance.distance);
      if (travel_type === 1 && isFinalItineraryRoute && dropKm <= 0) {
        dropKm = toNum(route.no_of_km);
      }
      TOTAL_DROP_KM = String(dropKm.toFixed(2));
      TOTAL_DROP_DURATION = dropDistance.duration;
    } else if (toNum(TOTAL_DROP_KM) <= 0 && travel_type === 1 && isFinalItineraryRoute) {
      const fallbackKm = toNum(route.no_of_km);
      TOTAL_DROP_KM = String(fallbackKm.toFixed(2));
      const speed = travel_type === 1 ? localSpeed : outstationSpeed;
      const fallbackSeconds = speed > 0 ? Math.round((fallbackKm / speed) * 3600) : 0;
      TOTAL_DROP_DURATION = secondsToHms(fallbackSeconds);
    }
  }

  const shouldUsePlannedKmForAirportLocalRoute =
    travel_type === 1 &&
    plannedRouteKm > 0 &&
    isItineraryEdgeTransferRoute &&
    effectiveRunningKm <= 0;

  // Arrival/departure transfer legs should bill against planned route KM, not stitched hotspot-tour distance.
  if (shouldUsePlannedKmForAirportLocalRoute) {
    const plannedSeconds = localSpeed > 0
      ? Math.round((plannedRouteKm / localSpeed) * 3600)
      : 0;

    effectiveRunningKm = plannedRouteKm;
    effectiveRunningTimeSeconds = plannedSeconds > 0 ? plannedSeconds : effectiveRunningTimeSeconds;
    // Only zero sightseeing when this is a pure transfer (no real hotspot sightseeing for the day).
    // Preserve sightseeing if there are actual hotspot movements on the route.
    const hasSightseeingHotspots = baseSightseeingKm > 0 || baseRunningKm > plannedRouteKm;
    if (!hasSightseeingHotspots) {
      effectiveSightseeingKm = 0;
      effectiveSightseeingTimeSeconds = 0;
    } else {
      const sightseeingFromRunningKm = Math.max(0, baseRunningKm - plannedRouteKm);
      effectiveSightseeingKm = baseSightseeingKm + sightseeingFromRunningKm;
      const runningRatio =
        baseRunningKm > 0 ? sightseeingFromRunningKm / baseRunningKm : 0;
      effectiveSightseeingTimeSeconds =
        sightseeingTimeSeconds + Math.round(baseRunningTimeSeconds * runningRatio);
    }

    // Debug logging (enable by setting DEBUG_VEHICLE_CALC=true)
    if ((process.env.DEBUG_VEHICLE_CALC || '').toLowerCase() === 'true') {
      console.log('[calculateRouteVehicleDetails][DEBUG]', {
        planId: itinerary_plan_ID,
        routeId: route.itinerary_route_ID,
        routeCount: route_count,
        plannedRouteKm,
        baseRunningKm,
        baseSightseeingKm,
        effectiveSightseeingKm,
        isItineraryEdgeTransferRoute,
        shouldUsePlannedKmForAirportLocalRoute,
        hasSightseeingHotspots,
      });
    }
  } else {
    TOTAL_RUNNING_KM = String(effectiveRunningKm.toFixed(2));
  }

  if (travel_type === 1 && !isItineraryEdgeTransferRoute) {
    effectiveRunningKm = 0;
    effectiveRunningTimeSeconds = 0;
  }

  if (travel_type === 1 && isItineraryEdgeTransferRoute) {
    if (route_count === 1 && excludedArrivalTransferKm > 0) {
      effectiveSightseeingKm = Math.max(0, effectiveSightseeingKm - excludedArrivalTransferKm);
    }
    if (route_count === total_routes && excludedDepartureTransferKm > 0) {
      effectiveSightseeingKm = Math.max(0, effectiveSightseeingKm - excludedDepartureTransferKm);
    }
  }

  TOTAL_RUNNING_KM = String(effectiveRunningKm.toFixed(2));
  SIGHT_SEEING_TRAVELLING_KM = String(effectiveSightseeingKm.toFixed(2));
  SIGHT_SEEING_TRAVELLING_TIME = secondsToHms(effectiveSightseeingTimeSeconds);
  const hasActualSightseeingOnEdgeRoute =
    travel_type === 1 &&
    isItineraryEdgeTransferRoute &&
    toNum(SIGHT_SEEING_TRAVELLING_KM) > 0;

  // Total KM includes pickup + running + sightseeing + drop.
  const totalKmNum =
    toNum(TOTAL_PICKUP_KM) +
    toNum(TOTAL_RUNNING_KM) +
    toNum(SIGHT_SEEING_TRAVELLING_KM) +
    toNum(TOTAL_DROP_KM);
  const TOTAL_KM = totalKmNum.toFixed(2);
  if (debugInsert) {
    console.log('[CALC_RESULT]', {
      TOTAL_PICKUP_KM,
      TOTAL_RUNNING_KM,
      SIGHT_SEEING_TRAVELLING_KM,
      TOTAL_DROP_KM,
      TOTAL_KM,
    });
  }

  if (travel_type === 1 && isItineraryEdgeTransferRoute) {
    const hotspotRows = await prisma.dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID,
        itinerary_route_ID: route.itinerary_route_ID,
        deleted: 0,
      },
      orderBy: { route_hotspot_ID: 'asc' },
      select: {
        hotspot_travelling_distance: true,
        hotspot_traveling_time: true,
      },
    });
    const segmentRows = hotspotRows.filter((r: any) => Number(r.hotspot_travelling_distance || 0) > 0);
    const firstSegment = segmentRows[0];
    const lastSegment = segmentRows[segmentRows.length - 1];

    if (route_count === 1) {
      const arrivalTransferKm = Number(firstSegment?.hotspot_travelling_distance || 0);
      if (arrivalTransferKm > 0) {
        effectiveRunningKm = arrivalTransferKm;
        excludedArrivalTransferKm = arrivalTransferKm;
      }
    }

    if (route_count === total_routes) {
      const departureTransferKm = Number(lastSegment?.hotspot_travelling_distance || 0);
      if (departureTransferKm > 0) {
        effectiveRunningKm = departureTransferKm;
        excludedDepartureTransferKm = departureTransferKm;
      }
    }
  }
  if (debugLocalFix) {
    console.log('[LOCAL_KM_FIX_INPUT]', {
      planId: itinerary_plan_ID,
      routeId: route.itinerary_route_ID,
      route_count,
      total_routes,
      travel_type,
      route_location_name: route.location_name,
      route_next_visiting_location: route.next_visiting_location,
      vehicleOrigin: ctx.vehicle_origin,
      baseRunningKm,
      baseSightseeingKm,
      plannedRouteKm,
    });
    console.log('[LOCAL_TRAVEL_RESULT]', {
      routeId: route.itinerary_route_ID,
      TOTAL_RUNNING_KM,
      excludedArrivalTransferKm,
      excludedDepartureTransferKm,
      reason:
        travel_type !== 1
          ? 'non_local'
          : route_count === 1
            ? 'arrival_day_transfer'
            : route_count === total_routes
              ? 'departure_day_transfer'
              : 'middle_day_zero',
    });
    console.log('[LOCAL_SIGHTSEEING_RESULT]', {
      routeId: route.itinerary_route_ID,
      baseSightseeingKm,
      excludedArrivalTransferKm,
      excludedDepartureTransferKm,
      finalSightseeingKm: SIGHT_SEEING_TRAVELLING_KM,
    });
    console.log('[LOCAL_PICKUP_DROP_FIX_RESULT]', {
      routeId: route.itinerary_route_ID,
      TOTAL_PICKUP_KM,
      TOTAL_PICKUP_DURATION,
      TOTAL_DROP_KM,
      TOTAL_DROP_DURATION,
    });
    console.log('[LOCAL_CALC_FINAL]', {
      routeId: route.itinerary_route_ID,
      TOTAL_PICKUP_KM,
      TOTAL_RUNNING_KM,
      SIGHT_SEEING_TRAVELLING_KM,
      TOTAL_DROP_KM,
      TOTAL_KM,
    });
  }

  const totalMovementSeconds =
    effectiveRunningTimeSeconds +
    parseHmsToSeconds(TOTAL_PICKUP_DURATION) +
    parseHmsToSeconds(TOTAL_DROP_DURATION);

  TOTAL_TRAVELLING_TIME = secondsToHms(effectiveRunningTimeSeconds + effectiveSightseeingTimeSeconds);

  const totalRouteSeconds = totalMovementSeconds + effectiveSightseeingTimeSeconds;
  const TOTAL_TIME = secondsToHms(totalRouteSeconds);

  // Duty time should use pickup + timed route/hotspot usage + drop.
  let routeServiceHours = totalRouteSeconds / 3600;
  if (travel_type !== 1 && route.route_start_time && route.route_end_time) {
    const parseTimeToSeconds = (value: any): number | null => {
      if (!value) return null;
      if (value instanceof Date) {
        return (
          (value.getUTCHours() * 3600) +
          (value.getUTCMinutes() * 60) +
          value.getUTCSeconds()
        );
      }
      const text = String(value).trim();
      if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(text)) return null;
      const parts = text.split(':').map((x) => Number(x || 0));
      const h = Number(parts[0] || 0);
      const m = Number(parts[1] || 0);
      const s = Number(parts[2] || 0);
      return h * 3600 + m * 60 + s;
    };

    const startSec = parseTimeToSeconds(route.route_start_time);
    const endSec = parseTimeToSeconds(route.route_end_time);
    if (startSec !== null && endSec !== null) {
      let diff = endSec - startSec;
      if (diff < 0) {
        diff += 24 * 3600;
      }
      routeServiceHours = Math.max(routeServiceHours, diff / 3600);
    }
  }

  // Calculate toll charges
  let tollChargesResult = await calculateRouteTollCharges(
    prisma,
    vehicle_type_id,
    route.location_name,
    route.next_visiting_location,
    viaRouteNames,
  );
  let tollCharges = tollChargesResult.total;
  const tollBreakup = [...tollChargesResult.breakup];

  const VEHICLE_TOLL_CHARGE = tollCharges;

  // Calculate parking charges
  const parkingCharges = await calculateHotspotParkingCharges(
    prisma,
    vehicle_type_id,
    itinerary_plan_ID,
    route.itinerary_route_ID
  );
  const VEHICLE_PARKING_CHARGE = parkingCharges;

  // Calculate permit charges
  const permitCharges = await calculatePermitCharges(
    prisma,
    itinerary_plan_ID,
    route.itinerary_route_ID,
    vendor_id,
    vendor_vehicle_type_ID,
    vendor_branch_id,
    cache,
  );
  const permit_charges = permitCharges;

  // Extract day, month, year from route date
  const routeDate = new Date(route.itinerary_route_date);
  const day = routeDate.getDate(); // 1-31
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                     'July', 'August', 'September', 'October', 'November', 'December'];
  const month = monthNames[routeDate.getMonth()];
  const year = routeDate.getFullYear().toString();

  // Get kms_limit_id for outstation pricing
  kms_limit_id = await getKmsLimitId(prisma, vendor_id, vendor_vehicle_type_ID);

  // Calculate vehicle rental based on travel type
  const isFirstLocalArrivalLeg =
    travel_type === 1 && route_count === 1;

  if (travel_type === 1) {
    kms_limit_id = 0;
    let slabSelectionHours = routeServiceHours;
    let slabSelectionKm = totalKmNum;
    const shouldUsePureArrivalTransferSlabShortcut =
      isFirstLocalArrivalLeg && !hasActualSightseeingOnEdgeRoute;
    let selectedLocalTimeLimitId = Number(ctx.selected_time_limit_id || 0);

    if (shouldUsePureArrivalTransferSlabShortcut) {
      slabSelectionHours = 0;
      slabSelectionKm = Math.max(plannedRouteKm, toNum(TOTAL_RUNNING_KM));
    }

    if (hasActualSightseeingOnEdgeRoute) {
      const selectedSlab = selectedLocalTimeLimitId > 0
        ? await prisma.dvi_time_limit.findFirst({
            where: {
              time_limit_id: selectedLocalTimeLimitId,
              vendor_id,
              vendor_vehicle_type_id: vendor_vehicle_type_ID,
              status: 1,
              deleted: 0,
            },
            select: {
              time_limit_id: true,
              hours_limit: true,
              km_limit: true,
              time_limit_title: true,
            },
          })
        : null;
      const selectedSlabHours = Number(selectedSlab?.hours_limit || 0);
      const selectedSlabKm = getEffectiveTimeLimitKm(selectedSlab || null);
      const looksLikeTransferSlab = selectedSlabHours > 0 && selectedSlabHours <= 4 && selectedSlabKm > 0 && selectedSlabKm <= 40;

      // For edge routes with real sightseeing, do hour-based slab auto-selection.
      // We still compute transfer-style detection for diagnostics, but we always clear
      // selectedLocalTimeLimitId here so getTimeLimitId can choose by routeServiceHours.
      selectedLocalTimeLimitId = 0;

      if ((process.env.DEBUG_VEHICLE_CALC || '').toLowerCase() === 'true') {
        console.log('[SLAB_DEBUG_PRE_GET_TIME_LIMIT]', {
          itinerary_plan_ID,
          itinerary_route_ID: route.itinerary_route_ID,
          route_count,
          travel_type,
          isItineraryEdgeTransferRoute,
          SIGHT_SEEING_TRAVELLING_KM,
          hasActualSightseeingOnEdgeRoute,
          ctx_selected_time_limit_id: ctx.selected_time_limit_id,
          selectedLocalTimeLimitId_before_guard: Number(ctx.selected_time_limit_id || 0),
          selectedSlabHours,
          selectedSlabKm,
          looksLikeTransferSlab,
          selectedLocalTimeLimitId_after_guard: selectedLocalTimeLimitId,
        });
      }
    }

    // LOCAL - get time limit ID
    time_limit_id = await getTimeLimitId(
      prisma,
      vendor_id,
      vendor_vehicle_type_ID,
      slabSelectionHours,
      slabSelectionKm,
      selectedLocalTimeLimitId || undefined,
    );
    if (debugVehicleTrace && isMuvTrace) {
      console.log('[MUV_TIME_LIMIT_SELECTION]', {
        vendor_id,
        vendor_branch_id,
        vehicle_type_id,
        vendor_vehicle_type_id: vendor_vehicle_type_ID,
        total_hours: slabSelectionHours,
        total_km: slabSelectionKm,
        selected_time_limit_id: Number(ctx.selected_time_limit_id || 0),
        resolved_time_limit_id: time_limit_id,
      });
    }

    const pricedLocalSlab = await getPricedLocalTimeLimitId(
      prisma,
      vendor_id,
      vendor_branch_id,
      vendor_vehicle_type_ID,
      day,
      year,
      month,
      slabSelectionHours,
      slabSelectionKm,
      selectedLocalTimeLimitId || undefined,
    );
    if (pricedLocalSlab.timeLimitId > 0) {
      time_limit_id = pricedLocalSlab.timeLimitId;
    }
    if ((process.env.DEBUG_VEHICLE_CALC || '').toLowerCase() === 'true') {
      console.log('[SLAB_DEBUG_POST_GET_TIME_LIMIT]', {
        itinerary_plan_ID,
        itinerary_route_ID: route.itinerary_route_ID,
        route_count,
        final_time_limit_id: time_limit_id,
      });
    }

    let hourBaselineLimit = 0;
    if (!shouldUsePureArrivalTransferSlabShortcut) {
      const hourBaselineTimeLimitId = await getTimeLimitId(
        prisma,
        vendor_id,
        vendor_vehicle_type_ID,
        slabSelectionHours,
        0,
        0,
      );

      if (hourBaselineTimeLimitId > 0) {
        const hourBaseline = await prisma.dvi_time_limit.findUnique({
          where: { time_limit_id: hourBaselineTimeLimitId },
          select: { hours_limit: true },
        });
        hourBaselineLimit = Number(hourBaseline?.hours_limit ?? 0);
      }
    }

    vehicle_cost_for_the_day = Number(pricedLocalSlab.price || 0);
    if (vehicle_cost_for_the_day <= 0 && time_limit_id > 0) {
      if (debugVehicleTrace && isMuvTrace) {
        const dayColumn = `day_${day}`;
        const pbRows: any[] = await prisma.$queryRawUnsafe(
          `SELECT ${dayColumn} AS day_price
           FROM dvi_vehicle_local_pricebook
           WHERE vendor_id = ?
             AND vendor_branch_id = ?
             AND vehicle_type_id = ?
             AND time_limit_id = ?
             AND year = ?
             AND month = ?
             AND status = 1
             AND deleted = 0
           LIMIT 1`,
          vendor_id,
          vendor_branch_id,
          vendor_vehicle_type_ID,
          time_limit_id,
          year,
          month,
        );
        const dayPrice = Number(pbRows?.[0]?.day_price ?? 0);
        console.log('[MUV_PRICEBOOK_LOOKUP]', {
          vendor_id,
          vendor_branch_id,
          vehicle_type_id_used_in_query: vendor_vehicle_type_ID,
          vendor_vehicle_type_id: vendor_vehicle_type_ID,
          time_limit_id,
          year,
          month,
          dayColumn,
          priceRowFound: pbRows.length > 0,
          priceFound: dayPrice > 0,
        });
      }
      vehicle_cost_for_the_day = await getLocalVehiclePricingByDate(
        prisma,
        day,
        year,
        month,
        vendor_id,
        vendor_branch_id,
        vendor_vehicle_type_ID,
        time_limit_id,
        vehicle_type_id
      );
    }
    if (vehicle_cost_for_the_day <= 0) {
      console.warn(
        `[calculateRouteVehicleDetails] No active local priced slab found for vendor=${vendor_id}, branch=${vendor_branch_id}, vehicle_type=${vendor_vehicle_type_ID}, date=${year}-${month}-${day}, route=${route.itinerary_route_ID}`
      );
    }
    
    if (time_limit_id > 0) {
      const timeLimit = await prisma.dvi_time_limit.findUnique({
        where: { time_limit_id },
        select: { km_limit: true, hours_limit: true, time_limit_title: true },
      });
      TOTAL_ALLOWED_LOCAL_KM = getEffectiveTimeLimitKm(timeLimit);
      if ((process.env.DEBUG_VEHICLE_CALC || '').toLowerCase() === 'true') {
        console.log('[SLAB_DEBUG_ALLOWANCE_COST]', {
          itinerary_plan_ID,
          itinerary_route_ID: route.itinerary_route_ID,
          route_count,
          TOTAL_ALLOWED_LOCAL_KM,
          vehicle_cost_for_the_day,
        });
      }

      const allowedHours = Number(timeLimit?.hours_limit ?? 0);
      const effectiveAllowedHours = !shouldUsePureArrivalTransferSlabShortcut && hourBaselineLimit > 0
        ? hourBaselineLimit
        : allowedHours;

      if (!shouldUsePureArrivalTransferSlabShortcut && effectiveAllowedHours > 0 && routeServiceHours > effectiveAllowedHours) {
        const rawExtraHours = routeServiceHours - effectiveAllowedHours;
        TOTAL_LOCAL_EXTRA_HOURS = Math.max(0, Math.ceil(rawExtraHours * 2) / 2);
        TOTAL_LOCAL_EXTRA_HOUR_CHARGES = TOTAL_LOCAL_EXTRA_HOURS * Number(ctx.extra_hour_charge || 0);
      }
    }

    // Calculate extra KM charges for LOCAL
    if (totalKmNum > TOTAL_ALLOWED_LOCAL_KM) {
      TOTAL_LOCAL_EXTRA_KM = Math.max(0, Math.ceil(totalKmNum - TOTAL_ALLOWED_LOCAL_KM));
      TOTAL_LOCAL_EXTRA_KM_CHARGES = TOTAL_LOCAL_EXTRA_KM * ctx.extra_km_charge;
    }

    vehicle_cost_for_the_day += TOTAL_LOCAL_EXTRA_HOUR_CHARGES;
  } else {
    // OUTSTATION - use day-based pricebook
    time_limit_id = 0;
    TOTAL_LOCAL_EXTRA_HOURS = 0;
    TOTAL_LOCAL_EXTRA_HOUR_CHARGES = 0;
    TOTAL_ALLOWED_LOCAL_KM = 0;

    const kmsLimitRow = kms_limit_id > 0
      ? await prisma.dvi_kms_limit.findFirst({
          where: {
            kms_limit_id,
            status: 1,
            deleted: 0,
          },
          select: {
            kms_limit: true,
          },
        })
      : null;
    TOTAL_ALLOWED_OUTSTATION_KM = Number(kmsLimitRow?.kms_limit ?? ctx.get_kms_limit ?? 0);

    // Get OUTSTATION pricing from day-based pricebook
    vehicle_cost_for_the_day = await getOutstationVehiclePricingByDate(
      prisma,
      day,
      year,
      month,
      vendor_id,
      vendor_branch_id,
      vendor_vehicle_type_ID,
      kms_limit_id
    );
    
    // If no pricing found, fall back to 3200
    if (vehicle_cost_for_the_day === 0) {
      console.log(`[calculateRouteVehicleDetails] Using fallback OUTSTATION pricing 3200 for route ${route.itinerary_route_ID}`);
      vehicle_cost_for_the_day = 3200;
    }

    // Outstation extra KM is charged once at the eligible/trip summary level.
    // Keep the per-route detail row at zero so it does not get summed day-wise.
    TOTAL_LOCAL_EXTRA_KM = 0;
    TOTAL_LOCAL_EXTRA_KM_CHARGES = 0;
  }

  // Calculate driver charges (simplified - PHP has complex batta logic)
  const TOTAL_DRIVER_CHARGES =
    ctx.driver_batta +
    ctx.food_cost +
    ctx.accomodation_cost +
    ctx.extra_cost;

  // Time-based extra charges (before 6am, after 8pm) — PHP parity
  let morning_extra_time_hours = 0;
  let evening_extra_time_hours = 0;
  if (route.route_start_time || route.route_end_time) {
    // Helper to ensure we have a valid time string (HH:MM:SS format)
    const ensureTimeString = (val: any): string | null => {
      if (!val) return null;
      if (val instanceof Date) {
        const hh = String(val.getUTCHours()).padStart(2, '0');
        const mm = String(val.getUTCMinutes()).padStart(2, '0');
        const ss = String(val.getUTCSeconds()).padStart(2, '0');
        return `${hh}:${mm}:${ss}`;
      }
      const str = String(val).trim();
      // Match HH:MM:SS or HH:MM pattern
      if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(str)) return str;
      return null;
    };
    const parseTimeToSeconds = (t: string | null): number => {
      if (!t) return 0;
      const parts = t.split(':').map(Number);
      return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
    };
    const parseDurationSeconds = (val: any): number => {
      if (!val) return 0;
      const hms = parseStoredDurationToHms(val);
      return parseTimeToSeconds(hms);
    };
    const normalizeSecondsOfDay = (sec: number): number => {
      const DAY_SEC = 24 * 3600;
      return ((sec % DAY_SEC) + DAY_SEC) % DAY_SEC;
    };
    const SIX_AM_SEC = 6 * 3600;
    const EIGHT_PM_SEC = 20 * 3600;
    const startTimeStr = ensureTimeString(route.route_start_time);
    const endTimeStr = ensureTimeString(route.route_end_time);
    const startSec = startTimeStr ? parseTimeToSeconds(startTimeStr) : SIX_AM_SEC;
    const endSec = endTimeStr ? parseTimeToSeconds(endTimeStr) : EIGHT_PM_SEC;

    // Use full service window: pickup can start the duty earlier and drop can extend it.
    const pickupDurationSec = parseDurationSeconds(TOTAL_PICKUP_DURATION);
    const dropDurationSec = parseDurationSeconds(TOTAL_DROP_DURATION);
    const effectiveStartSec = normalizeSecondsOfDay(startSec - pickupDurationSec);
    const effectiveEndSec = normalizeSecondsOfDay(endSec + dropDurationSec);

    if (effectiveStartSec < SIX_AM_SEC) {
      morning_extra_time_hours = (SIX_AM_SEC - effectiveStartSec) / 3600;
    }
    if (effectiveEndSec > EIGHT_PM_SEC) {
      evening_extra_time_hours = (effectiveEndSec - EIGHT_PM_SEC) / 3600;
    }
  }
  // Billing policy: round time-based extras to nearest 30 minutes.
  const roundToNearestHalfHour = (hours: number): number => {
    if (!Number.isFinite(hours) || hours <= 0) return 0;
    return Math.round(hours * 2) / 2;
  };

  const roundedMorningExtraTimeHours = roundToNearestHalfHour(morning_extra_time_hours);
  const roundedEveningExtraTimeHours = roundToNearestHalfHour(evening_extra_time_hours);

  const morning_extra_time = roundedMorningExtraTimeHours;
  const evening_extra_time = roundedEveningExtraTimeHours;
  const DRIVER_MORINING_CHARGES = ctx.driver_early_morning_charges * roundedMorningExtraTimeHours;
  const VENDOR_VEHICLE_MORNING_CHARGES = ctx.early_morning_charges * roundedMorningExtraTimeHours;
  const DRIVER_EVEINING_CHARGES = ctx.driver_evening_charges * roundedEveningExtraTimeHours;
  const VENDOR_VEHICLE_EVENING_CHARGES = ctx.evening_charges * roundedEveningExtraTimeHours;

  // Calculate total vehicle amount for the route
  const TOTAL_VEHICLE_AMOUNT =
    vehicle_cost_for_the_day +
    VEHICLE_TOLL_CHARGE +
    VEHICLE_PARKING_CHARGE +
    TOTAL_DRIVER_CHARGES +
    permit_charges +
    DRIVER_MORINING_CHARGES +
    VENDOR_VEHICLE_MORNING_CHARGES +
    DRIVER_EVEINING_CHARGES +
    VENDOR_VEHICLE_EVENING_CHARGES +
    TOTAL_LOCAL_EXTRA_KM_CHARGES;
  if (debugVehicleTrace && isMuvTrace) {
    console.log('[MUV_CALC_FINAL]', {
      routeId: route.itinerary_route_ID,
      travel_type,
      time_limit_id,
      TOTAL_KM,
      vehicle_cost_for_the_day,
      TOTAL_VEHICLE_AMOUNT,
    });
  }

  return {
    travel_type,
    time_limit_id,
    kms_limit_id,
    TOTAL_RUNNING_KM,
    TOTAL_TRAVELLING_TIME,
    SIGHT_SEEING_TRAVELLING_KM,
    SIGHT_SEEING_TRAVELLING_TIME,
    TOTAL_PICKUP_KM,
    TOTAL_PICKUP_DURATION,
    TOTAL_DROP_KM,
    TOTAL_DROP_DURATION,
    TOTAL_KM,
    TOTAL_TIME,
    vehicle_cost_for_the_day,
    VEHICLE_TOLL_CHARGE,
    VEHICLE_PARKING_CHARGE,
    TOTAL_DRIVER_CHARGES,
    permit_charges,
    morning_extra_time,
    evening_extra_time,
    DRIVER_MORINING_CHARGES,
    VENDOR_VEHICLE_MORNING_CHARGES,
    DRIVER_EVEINING_CHARGES,
    VENDOR_VEHICLE_EVENING_CHARGES,
    TOTAL_VEHICLE_AMOUNT,
    TOTAL_LOCAL_EXTRA_KM,
    TOTAL_LOCAL_EXTRA_KM_CHARGES,
    TOTAL_ALLOWED_LOCAL_KM,
    TOTAL_ALLOWED_OUTSTATION_KM,
    TOTAL_LOCAL_EXTRA_HOURS,
    TOTAL_LOCAL_EXTRA_HOUR_CHARGES,
    TOLL_BREAKUP: tollBreakup,
    PICKUP_DEBUG: pickupDebug,
  };
}
