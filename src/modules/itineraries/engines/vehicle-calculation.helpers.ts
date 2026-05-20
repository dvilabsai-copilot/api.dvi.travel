// vehicle-calculation.helpers.ts
// Helper functions to match PHP vehicle calculation logic

import { PrismaClient } from '@prisma/client';

function toNum(v: any): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
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
  TOTAL_LOCAL_EXTRA_HOURS: number;
  TOTAL_LOCAL_EXTRA_HOUR_CHARGES: number;
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

function getTravelLocationType(
  startLocation: string,
  endLocation: string,
): 1 | 2 {
  const starts = String(startLocation || '').split('|').map((s) => s.trim()).filter(Boolean);
  const ends = String(endLocation || '').split('|').map((s) => s.trim()).filter(Boolean);
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
  itinerary_route_ID: number
): Promise<{
  runningKm: number;
  runningSeconds: number;
  sightseeingKm: number;
  sightseeingSeconds: number;
}> {
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
    return {
      runningKm: Number(row.running_km ?? 0),
      runningSeconds: Number(row.running_seconds ?? 0),
      sightseeingKm: Number(row.sightseeing_km ?? 0),
      sightseeingSeconds: Number(row.sightseeing_seconds ?? 0),
    };
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
  destination_location: string
): Promise<number> {
  try {
    const result = await prisma.dvi_stored_locations.findFirst({
      where: {
        source_location: source_location,
        destination_location: destination_location,
        deleted: 0,
        status: 1
      },
      orderBy: { location_ID: "desc" },
      select: { location_ID: true }
    });
    return result?.location_ID ?? 0;
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
    const result = await prisma.$queryRaw<any[]>`
      SELECT COALESCE(SUM(toll_charge), 0) as total_toll
      FROM dvi_vehicle_toll_charges
      WHERE vehicle_type_id = ${vehicle_type_id}
      AND location_id = ${location_id}
      AND status = 1
      AND deleted = 0
    `;
    return Number(result[0]?.total_toll ?? 0);
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
): Promise<number> {
  let totalToll = 0;

  try {
    if (via_route_names && via_route_names.length > 0) {
      // With via routes: source -> via1, via1 -> via2, ..., lastVia -> dest
      const allSegments: [string, string][] = [[source_location, via_route_names[0]]];
      
      for (let i = 0; i < via_route_names.length - 1; i++) {
        allSegments.push([via_route_names[i], via_route_names[i + 1]]);
      }
      
      allSegments.push([via_route_names[via_route_names.length - 1], destination_location]);
      
      for (const [from, to] of allSegments) {
        const locationId = await getLocationIdFromSourceDest(prisma, from, to);
        const tollCharge = await calculateVehicleTollCharges(prisma, vehicle_type_id, BigInt(locationId));
        totalToll += tollCharge;
      }
    } else {
      // Direct route: source -> destination
      const locationId = await getLocationIdFromSourceDest(prisma, source_location, destination_location);
      totalToll = await calculateVehicleTollCharges(prisma, vehicle_type_id, BigInt(locationId));
    }
  } catch (error) {
    console.error('[calculateRouteTollCharges] Error:', error);
  }

  return totalToll;
}

async function getViaRouteNames(
  prisma: any,
  itinerary_plan_ID: number,
  itinerary_route_ID: number,
): Promise<string[]> {
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

    return rows
      .map((r: any) => String(r?.itinerary_via_location_name || '').trim())
      .filter((v: string) => Boolean(v));
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
  location_name: string
): Promise<string> {
  try {
    const result = await prisma.dvi_stored_locations.findFirst({
      where: { 
        source_location: location_name,
        deleted: 0,
        status: 1
      },
      select: { source_location_city: true }
    });
    return result?.source_location_city ?? '';
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
  location_name: string
): Promise<{ latitude: number; longitude: number } | null> {
  try {
    const result = await prisma.dvi_stored_locations.findFirst({
      where: { 
        source_location: location_name,
        deleted: 0,
        status: 1
      },
      select: { 
        source_location_lattitude: true,
        source_location_longitude: true
      }
    });
    
    if (result) {
      return {
        latitude: parseFloat(result.source_location_lattitude || '0'),
        longitude: parseFloat(result.source_location_longitude || '0')
      };
    }
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
  vehicle_location_id: number
): Promise<{
  origin: string;
  city: string;
  latitude: number;
  longitude: number;
}> {
  if (!vehicle_location_id || vehicle_location_id === 0) {
    return { origin: '', city: '', latitude: 0, longitude: 0 };
  }

  try {
    const result = await prisma.dvi_stored_locations.findUnique({
      where: { location_ID: BigInt(vehicle_location_id) },
      select: {
        source_location: true,
        source_location_city: true,
        source_location_lattitude: true,
        source_location_longitude: true
      }
    });

    return {
      origin: result?.source_location ?? '',
      city: result?.source_location_city ?? '',
      latitude: parseFloat(result?.source_location_lattitude || '0'),
      longitude: parseFloat(result?.source_location_longitude || '0')
    };
  } catch (error) {
    console.error('[getVehicleLocationDetails] Error:', error);
    return { origin: '', city: '', latitude: 0, longitude: 0 };
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
  vendor_vehicle_type_ID: number
): Promise<number> {
  try {
    const result = await prisma.$queryRaw<any[]>`
      SELECT COALESCE(SUM(permit_cost), 0) as total_permit
      FROM dvi_itinerary_plan_route_permit_charge
      WHERE itinerary_plan_ID = ${itinerary_plan_ID}
      AND itinerary_route_ID = ${itinerary_route_ID}
      AND vendor_id = ${vendor_id}
      AND vendor_vehicle_type_id = ${vendor_vehicle_type_ID}
      AND status = 1
      AND deleted = 0
    `;
    return Number(result[0]?.total_permit ?? 0);
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
  check_local_via_route_city: boolean
): number {
  // PHP logic from line ~460:
  // if ($source_location_city == $destination_location_city && 
  //     $source_location_city == $vehicle_origin_city && 
  //     ($route_count == 1 || $route_count == $total_no_of_itineary_plan_route_details || 
  //      ($previous_destination_location_city == $source_location_city)) && 
  //     $check_local_via_route_city == true)
  
    // NestJS note: The PHP vehicle_origin_city check is relaxed for middle-route same-city
    // continuation days.  When the vehicle has already arrived in the current city on the
    // previous day (previous_destination_city === source_city), the origin-city requirement
    // is waived so that local sightseeing days within outstation trips are correctly priced
    // using a LOCAL slab (e.g. BLR vehicle doing COORG→COORG on day 2 of a BLR→COORG trip).
    if (source_city === destination_city && check_local_via_route_city) {
      const isOriginCityFirstOrLast =
        source_city === vehicle_origin_city &&
        (route_count === 1 || route_count === total_routes);
      const isContinuationDay = previous_destination_city === source_city;
      if (isOriginCityFirstOrLast || isContinuationDay) {
        return 1; // LOCAL
      }
    }
    return 2; // OUTSTATION
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
        return selected.time_limit_id;
      }
    }

    // Auto mode: default to the smallest available slab for this vendor/vehicle type.
    const firstSlab = await prisma.dvi_time_limit.findFirst({
      where: {
        vendor_id,
        vendor_vehicle_type_id: vendor_vehicle_type_ID,
        deleted: 0,
        status: 1,
      },
      select: {
        time_limit_id: true,
      },
      orderBy: {
        time_limit_id: 'asc',
      },
    });

    if (firstSlab?.time_limit_id) {
      return firstSlab.time_limit_id;
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
  time_limit_id: number
): Promise<number> {
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
      console.log(`[getLocalVehiclePricingByDate] No pricing found for vendor=${vendor_id}, branch=${vendor_branch_id}, vehicle_type=${vendor_vehicle_type_ID}, time_limit=${time_limit_id}, ${month} ${year}`);
      return 0;
    }

    // Get price from day column (day_1 through day_31)
    const dayColumn = `day_${day}`;
    const price = pricing[dayColumn as keyof typeof pricing];
    
    return toNum(price);
  } catch (error) {
    console.error('[getLocalVehiclePricingByDate] Error:', error);
    return 0;
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
  previous_destination_city: string
): Promise<RouteCalculationResult> {
  const { prisma, itinerary_plan_ID, vehicle_type_id, vendor_id, vendor_vehicle_type_ID, vendor_branch_id } = ctx;

  // Get route location details
  const sourceLocationId = await getLocationIdFromSourceDest(
    prisma,
    route.location_name,
    route.next_visiting_location
  );
  
  // Get city names for travel type determination
  const sourceCity = await getStoredLocationCity(prisma, route.location_name);
  const destCity = await getStoredLocationCity(prisma, route.next_visiting_location);

  // Get coordinates for distance calculations
  const sourceCoords = await getLocationCoordinates(prisma, route.location_name);
  const destCoords = await getLocationCoordinates(prisma, route.next_visiting_location);
  const viaRouteNames = await getViaRouteNames(prisma, itinerary_plan_ID, route.itinerary_route_ID);

  // Check if all via routes are within same city (for LOCAL determination)
  let check_local_via_route_city = true;
  // TODO: Implement via route city checking logic
  // For now, assume true if source and dest are same city

  if (sourceCity !== destCity) {
    check_local_via_route_city = false;
  }

  // Determine travel type (LOCAL=1 or OUTSTATION=2)
  const travel_type = determineTravelType(
    route_count,
    total_routes,
    sourceCity,
    destCity,
    ctx.vehicle_origin_city,
    previous_destination_city,
    check_local_via_route_city
  );

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
  let TOTAL_LOCAL_EXTRA_KM = 0;
  let TOTAL_LOCAL_EXTRA_KM_CHARGES = 0;
  let TOTAL_LOCAL_EXTRA_HOURS = 0;
  let TOTAL_LOCAL_EXTRA_HOUR_CHARGES = 0;
  let TOTAL_ALLOWED_LOCAL_KM = 0;

  const hotspotMetrics = await getRouteHotspotMetrics(
    prisma,
    itinerary_plan_ID,
    route.itinerary_route_ID
  );

  const baseRunningKm = Number(hotspotMetrics.runningKm || 0);
  const baseRunningTimeSeconds = Number(hotspotMetrics.runningSeconds || 0);
  const sightseeingTimeSeconds = Number(hotspotMetrics.sightseeingSeconds || 0);

  const globalSettings = await prisma.dvi_global_settings.findFirst({
    where: { deleted: 0 },
    orderBy: { global_settings_ID: 'asc' },
    select: {
      itinerary_local_speed_limit: true,
      itinerary_outstation_speed_limit: true,
    },
  });
  const localSpeed = Number(globalSettings?.itinerary_local_speed_limit ?? 40) || 40;
  const outstationSpeed = Number(globalSettings?.itinerary_outstation_speed_limit ?? 60) || 60;

  TOTAL_RUNNING_KM = String(baseRunningKm.toFixed(2));

  const isBaseCityLocalRoute =
    travel_type === 1 &&
    sourceCity === ctx.vehicle_origin_city &&
    destCity === ctx.vehicle_origin_city;

  const applyPickupForThisRoute =
    !!sourceCoords && (isBaseCityLocalRoute || route_count === 1);
  const applyDropForThisRoute =
    !!destCoords && (isBaseCityLocalRoute || route_count === total_routes);

  // LOCAL routes in the vehicle's base city: pickup/drop are applied daily.
  // LOCAL continuation days away from the base city: vehicle stays with the passengers.
  // OUTSTATION routes: pickup on Day 1 and drop on last day.
  if (applyPickupForThisRoute && sourceCoords) {
    const pickupDistance = calculateDistanceAndDuration(
      ctx.vehicle_origin_latitude,
      ctx.vehicle_origin_longitude,
      sourceCoords.latitude,
      sourceCoords.longitude,
      getTravelLocationType(ctx.vehicle_origin_city, sourceCity) === 1 ? localSpeed : outstationSpeed,
      1.5,
    );
    TOTAL_PICKUP_KM = String(toNum(pickupDistance.distance).toFixed(2));
    TOTAL_PICKUP_DURATION = parsePhpDurationToHms(pickupDistance.duration);
  }

  if (applyDropForThisRoute && destCoords) {
    const dropDistance = calculateDistanceAndDuration(
      destCoords.latitude,
      destCoords.longitude,
      ctx.vehicle_origin_latitude,
      ctx.vehicle_origin_longitude,
      getTravelLocationType(destCity, ctx.vehicle_origin_city) === 1 ? localSpeed : outstationSpeed,
      1.5,
    );
    TOTAL_DROP_KM = String(toNum(dropDistance.distance).toFixed(2));
    TOTAL_DROP_DURATION = parsePhpDurationToHms(dropDistance.duration);
  }

  // Keep running KM limited to route/hotspot travel only.
  // Pickup/drop are tracked separately in dedicated fields.
  TOTAL_RUNNING_KM = String(baseRunningKm.toFixed(2));

  // Calculate sightseeing KM
  SIGHT_SEEING_TRAVELLING_KM = String(Number(hotspotMetrics.sightseeingKm || 0).toFixed(2));
  SIGHT_SEEING_TRAVELLING_TIME = secondsToHms(sightseeingTimeSeconds);

  // Total KM includes pickup + running + sightseeing + drop.
  const totalKmNum =
    toNum(TOTAL_PICKUP_KM) +
    toNum(TOTAL_RUNNING_KM) +
    toNum(SIGHT_SEEING_TRAVELLING_KM) +
    toNum(TOTAL_DROP_KM);
  const TOTAL_KM = totalKmNum.toFixed(2);

  const totalTravellingSeconds =
    baseRunningTimeSeconds +
    parseHmsToSeconds(TOTAL_PICKUP_DURATION) +
    parseHmsToSeconds(TOTAL_DROP_DURATION);
  TOTAL_TRAVELLING_TIME = secondsToHms(totalTravellingSeconds);

  const totalRouteSeconds = totalTravellingSeconds + sightseeingTimeSeconds;
  const TOTAL_TIME = secondsToHms(totalRouteSeconds);

  // Route service duration is used for slab extra-hour logic.
  let routeServiceHours = 0;
  if (route.route_start_time && route.route_end_time) {
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
      routeServiceHours = diff / 3600;
    }
  }

  // Calculate toll charges
  let tollCharges = await calculateRouteTollCharges(
    prisma,
    vehicle_type_id,
    route.location_name,
    route.next_visiting_location,
    viaRouteNames,
  );

  // Add tolls for origin legs that are applied for this route.
  if (applyPickupForThisRoute) {
    const originToSourceToll = await calculateRouteTollCharges(
      prisma,
      vehicle_type_id,
      ctx.vehicle_origin,
      route.location_name
    );
    tollCharges += originToSourceToll;
  }

  if (applyDropForThisRoute) {
    const destToOriginToll = await calculateRouteTollCharges(
      prisma,
      vehicle_type_id,
      route.next_visiting_location,
      ctx.vehicle_origin
    );
    tollCharges += destToOriginToll;
  }
  
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
    vendor_vehicle_type_ID
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
  const kms_limit_id = await getKmsLimitId(prisma, vendor_id, vendor_vehicle_type_ID);

  // Calculate vehicle rental based on travel type
  if (travel_type === 1) {
    // LOCAL - get time limit ID
    time_limit_id = await getTimeLimitId(
      prisma,
      vendor_id,
      vendor_vehicle_type_ID,
      routeServiceHours,
      totalKmNum,
      ctx.selected_time_limit_id,
    );
    
    // Get LOCAL pricing from day-based pricebook
    vehicle_cost_for_the_day = await getLocalVehiclePricingByDate(
      prisma,
      day,
      year,
      month,
      vendor_id,
      vendor_branch_id,
      vendor_vehicle_type_ID,
      time_limit_id
    );
    
    // If no pricing found, fall back to 2400
    if (vehicle_cost_for_the_day === 0) {
      console.log(`[calculateRouteVehicleDetails] Using fallback LOCAL pricing 2400 for route ${route.itinerary_route_ID}`);
      vehicle_cost_for_the_day = 2400;
    }
    
    if (time_limit_id > 0) {
      const timeLimit = await prisma.dvi_time_limit.findUnique({
        where: { time_limit_id },
        select: { km_limit: true, hours_limit: true },
      });
      TOTAL_ALLOWED_LOCAL_KM = Number(timeLimit?.km_limit ?? 0);

      const allowedHours = Number(timeLimit?.hours_limit ?? 0);
      if (allowedHours > 0 && routeServiceHours > allowedHours) {
        TOTAL_LOCAL_EXTRA_HOURS = Math.ceil(routeServiceHours - allowedHours);
        TOTAL_LOCAL_EXTRA_HOUR_CHARGES = TOTAL_LOCAL_EXTRA_HOURS * Number(ctx.extra_hour_charge || 0);
      }
    }

    // Calculate extra KM charges for LOCAL
    if (totalKmNum > TOTAL_ALLOWED_LOCAL_KM) {
      TOTAL_LOCAL_EXTRA_KM = totalKmNum - TOTAL_ALLOWED_LOCAL_KM;
      TOTAL_LOCAL_EXTRA_KM_CHARGES = TOTAL_LOCAL_EXTRA_KM * ctx.extra_km_charge;
    }

    vehicle_cost_for_the_day += TOTAL_LOCAL_EXTRA_HOUR_CHARGES;
  } else {
    // OUTSTATION - use day-based pricebook
    time_limit_id = 0;
    TOTAL_LOCAL_EXTRA_HOURS = 0;
    TOTAL_LOCAL_EXTRA_HOUR_CHARGES = 0;
    TOTAL_ALLOWED_LOCAL_KM = ctx.get_kms_limit; // per-day allowed KM for outstation

    // Per-day extra KM (for display on day row; aggregate is also computed in engine)
    if (totalKmNum > TOTAL_ALLOWED_LOCAL_KM) {
      TOTAL_LOCAL_EXTRA_KM = totalKmNum - TOTAL_ALLOWED_LOCAL_KM;
      TOTAL_LOCAL_EXTRA_KM_CHARGES = TOTAL_LOCAL_EXTRA_KM * ctx.extra_km_charge;
    } else {
      TOTAL_LOCAL_EXTRA_KM = 0;
      TOTAL_LOCAL_EXTRA_KM_CHARGES = 0;
    }

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
    const SIX_AM_SEC = 6 * 3600;
    const EIGHT_PM_SEC = 20 * 3600;
    const startTimeStr = ensureTimeString(route.route_start_time);
    const endTimeStr = ensureTimeString(route.route_end_time);
    const startSec = startTimeStr ? parseTimeToSeconds(startTimeStr) : SIX_AM_SEC;
    const endSec = endTimeStr ? parseTimeToSeconds(endTimeStr) : EIGHT_PM_SEC;

    if (startSec < SIX_AM_SEC) {
      morning_extra_time_hours = (SIX_AM_SEC - startSec) / 3600;
    }
    if (endSec > EIGHT_PM_SEC) {
      evening_extra_time_hours = (endSec - EIGHT_PM_SEC) / 3600;
    }
  }
  const morning_extra_time = morning_extra_time_hours;
  const evening_extra_time = evening_extra_time_hours;
  const DRIVER_MORINING_CHARGES = ctx.driver_early_morning_charges * morning_extra_time_hours;
  const VENDOR_VEHICLE_MORNING_CHARGES = ctx.early_morning_charges * morning_extra_time_hours;
  const DRIVER_EVEINING_CHARGES = ctx.driver_evening_charges * evening_extra_time_hours;
  const VENDOR_VEHICLE_EVENING_CHARGES = ctx.evening_charges * evening_extra_time_hours;

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

  return {
    travel_type,
    time_limit_id,
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
    TOTAL_LOCAL_EXTRA_HOURS,
    TOTAL_LOCAL_EXTRA_HOUR_CHARGES,
  };
}
