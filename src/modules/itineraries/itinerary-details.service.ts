// FILE: src/modules/itineraries/itinerary-details.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../../prisma.service';
import { LatestItineraryQueryDto } from './dto/latest-itinerary-query.dto';
import { ItineraryHotelDetailsTboService } from './itinerary-hotel-details-tbo.service';

// ---------------------------------------------------------------------------
// DTOs for Itinerary Details response (shared shape with frontend)
// ---------------------------------------------------------------------------

export interface VehicleCostBreakdownItemDto {
  label: string;
  amount: number;
}

/** Convert "HH:MM:SS" or Prisma TIME buffer → "X Hours Y Min" label */
function formatHmsDuration(raw: string | null | undefined): string {
  if (!raw) return '0 Hours 0 Min';
  // Prisma TIME fields come back as Buffer bytes or as e.g. "02:49:00"
  const str = String(raw).trim();
  const match = str.match(/^(\d{1,3}):(\d{2})(?::\d{2})?$/);
  if (match) {
    const h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    return `${h} Hours ${m} Min`;
  }
  return '0 Hours 0 Min';
}

export interface VehicleDayWisePricingDto {
  date: string; // "2025-12-26"
  dayLabel: string; // "Day 1 | 26 Dec 2025"
  route: string; // "Chennai → Mahabalipuram"
  pickupKms: number;
  travelKms: number; // Running KM per day
  sightseeingKms: number; // Sightseeing KM per day
  totalKms: number; // Total KMS per day (travel + sightseeing)
  rentalCharges: number;
  tollCharges: number;
  parkingCharges: number;
  driverCharges: number;
  permitCharges: number;
  extraHourCount: number;
  extraHourRate: number;
  extraHourCharges: number;
  extraKmCharges: number;
  dropKms: number;
  totalCharges: number;
}

/**
 * THREE KMS COLUMNS EXPLANATION:
 * 
 * col1Distance (Travel KM / Running KM):
 *   - Distance between city-to-city travel
 *   - Example: Chennai to Mahabalipuram = 55.60 KM
 *   - Source: total_running_km
 * 
 * col2Distance (Sightseeing KM):
 *   - Local distance within a city for attractions/hotspots
 *   - Example: Local sightseeing in Mahabalipuram = 24.03 KM
 *   - Source: total_siteseeing_km
 * 
 * col3Distance (Total KM):
 *   - Sum of Travel KM + Sightseeing KM
 *   - Example: 55.60 + 24.03 = 79.63 KM
 *   - Source: total_travelled_km
 *   - Used for: Extra KM charges, pricing calculations
 * 
 * DAY-WISE KMS BREAKDOWN (in expanded row):
 *   - travelKms: total_running_km for that specific day
 *   - sightseeingKms: total_siteseeing_km for that specific day  
 *   - totalKms: total_travelled_km for that specific day (travel + sightseeing)
 *   - Shows per-day breakdown, matching legacy PHP structure
 * 
 * Example:
 *   Day 1: Travel 55.60 KM + Sightseeing 24.03 KM = Total 79.63 KM per day
 */
export interface ItineraryVehicleRowDto {
  vendorName: string | null;
  branchName: string | null;
  vehicleOrigin: string | null;
  totalQty: string;
  totalAmount: string;

  // IDs needed for vendor selection
  vendorEligibleId?: number;
  vehicleTypeId?: number;
  vehicleTypeName?: string;
  isAssigned?: boolean;
  selectedTimeLimitId?: number;
  availableSlabs?: Array<{
    timeLimitId: number;
    title: string;
    hoursLimit: number;
    kmLimit: number;
  }>;

  // Optional detailed charges – can be filled from vendor-eligible table later
  rentalCharges?: number;
  tollCharges?: number;
  parkingCharges?: number;
  driverCharges?: number;
  permitCharges?: number;
  before6amDriver?: number;
  before6amVendor?: number;
  after8pmDriver?: number;
  after8pmVendor?: number;
  breakdown?: VehicleCostBreakdownItemDto[];
  
  // Day-wise pricing breakdown for expandable row
  dayWisePricing?: VehicleDayWisePricingDto[];

  // Summary totals for the PHP-style expanded panel
  totalDays?: number;
  totalCostOfVehicle?: number;
  totalPickupKm?: number;
  totalPickupDuration?: string;
  totalDropKm?: number;
  totalDropDuration?: string;
  totalUsedKm?: number;
  totalAllowedKm?: number;
  extraKms?: number;
  extraKmRate?: number;
  extraKmCharge?: number;
  extraHourCount?: number;
  extraHourRate?: number;
  extraHourCharge?: number;
  subtotal?: number;
  vehicleGstPercentage?: number;
  vehicleGstAmount?: number;
  vendorMarginPercentage?: number;
  vendorMarginAmount?: number;
  vendorMarginGstPercentage?: number;
  vendorMarginGstAmount?: number;
  grandTotal?: number;

  // Optional UI helper fields for the vehicle card
  dayLabel?: string;
  fromLabel?: string;
  toLabel?: string;
  packageLabel?: string;
  col1Distance?: string;
  col1Duration?: string;
  col2Distance?: string;
  col2Duration?: string;
  col3Distance?: string;
  col3Duration?: string;
  imageUrl?: string | null;
}

export interface CostBreakdownDto {
  // Hotel costs
  totalRoomCost?: number;
  roomCostPerPerson?: number;
  hotelPaxCount?: number;
  totalAmenitiesCost?: number;
  extraBedCost?: number;
  childWithBedCost?: number;
  childWithoutBedCost?: number;
  totalHotelAmount?: number;
  
  // Vehicle costs
  totalVehicleCost: number;
  totalVehicleAmount: number;
  totalVehicleQty?: number;
  
  // Activity/Guide costs
  totalGuideCost?: number;
  totalHotspotCost?: number;
  totalActivityCost?: number;
  kmLimitWarning?: string;
  totalAllowedKm?: number;
  totalTravelledKm?: number;
  totalExtraKm?: number;
  
  // Final calculations
  additionalMargin: number;
  totalAmount: number;
  couponDiscount: number;
  agentMargin: number;
  totalRoundOff: number;
  netPayable: number;
  companyName: string;
}

// NOTE: Hotel fields removed – hotels come from a separate endpoint now.
export interface ItineraryDetailsResponseDto {
  quoteId: string;
  planId: number;
  itineraryPreference?: number;
  isConfirmed?: boolean;
  confirmed_itinerary_plan_ID?: number; // ID needed for /confirmed/:id endpoint
  dateRange: string;
  dayCount: number;
  nightCount: number;
  roomCount: number;
  extraBed: number;
  childWithBed: number;
  childWithoutBed: number;
  adults: number;
  children: number;
  infants: number;
  overallCost: string;

  // DAY / ROUTE TIMELINE
  days: {
  id: number;
  dayNumber: number;
  date: Date | string;
  locationId: number;
  departure: string;
  arrival: string;
  distance: string;
  intercityDistance: string;
  sightseeingDistance: string;
  startTime: string;
  endTime: string;
  viaRoutes: { id: number; name: string }[];
  segments: any[];
}[]; // already shaped for FE (Start/Travel/Attraction/Return)

  // VEHICLES
  vehicles: ItineraryVehicleRowDto[];

  // PACKAGE NOTES + COSTING
  packageIncludes: {
    description: string;
    houseBoatNote: string;
    rateNote: string;
  };
  costBreakdown: CostBreakdownDto;
}

@Injectable()
export class ItineraryDetailsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hotelDetailsTboService: ItineraryHotelDetailsTboService,
  ) {}

  // TODO: remove after validation
  private logBookingRule(payload: Record<string, unknown>): void {
    console.log('[BOOKING_RULE]', payload);
  }

  // ---------------------------------------------------------------------------
  // Low-level helpers
  // ---------------------------------------------------------------------------

  private formatKm(value: number): string {
  return `${value.toFixed(2)} KM`;
}

  private toBigIntOrZero(value?: number | string | bigint | null): bigint {
    if (typeof value === 'bigint') return value;
    if (value === null || value === undefined) return 0n;
    const n = Number(value);
    if (Number.isNaN(n)) return 0n;
    return BigInt(Math.trunc(n));
  }

  private parseDate(value?: string | Date | null): Date | null {
    if (!value) return null;
    if (value instanceof Date) return value;

    const str = String(value).trim();
    if (!str) return null;

    // "DD/MM/YYYY"
    if (str.includes('/') && !str.includes('T')) {
      const [dStr, mStr, yStr] = str.split('/');
      const d = parseInt(dStr ?? '0', 10);
      const m = parseInt(mStr ?? '0', 10);
      const y = parseInt(yStr ?? '0', 10);
      if (!d || !m || !y) return null;
      return new Date(y, m - 1, d, 0, 0, 0, 0);
    }

    const dt = new Date(str);
    return isNaN(dt.getTime()) ? null : dt;
  }

  private startOfDay(d: Date) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  private endOfDay(d: Date) {
    const x = new Date(d);
    x.setHours(23, 59, 59, 999);
    return x;
  }

  private toCsv(value: any): string {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) {
      return value
        .map((v) => String(v).trim())
        .filter(Boolean)
        .join(',');
    }

    const str = String(value).trim();
    if (!str) return '';

    if (str.startsWith('[') && str.endsWith(']')) {
      try {
        const parsed = JSON.parse(str);
        if (Array.isArray(parsed)) {
          return parsed
            .map((v) => String(v).trim())
            .filter(Boolean)
            .join(',');
        }
      } catch {
        // ignore
      }
    }

    return str;
  }

  private pad2(n: number) {
    return String(n).padStart(2, '0');
  }

  /** YYYY-MM-DD using server local timezone (DB stores IST wall-clock). */
  private formatISODateLocal(d: Date): string {
    return `${d.getFullYear()}-${this.pad2(d.getMonth() + 1)}-${this.pad2(d.getDate())}`;
  }

  private formatCreatedOn(d?: Date | string | null) {
    const dt = d instanceof Date ? d : d ? new Date(d) : null;
    if (!dt || isNaN(dt.getTime())) return '';
    const weekday = dt.toLocaleString('en-US', { weekday: 'short' });
    const month = dt.toLocaleString('en-US', { month: 'short' });
    return `${weekday}, ${month} ${this.pad2(dt.getDate())}, ${dt.getFullYear()}`;
  }

  /**
   * Extract TIME from DATETIME field and format as "hh:mm AM/PM".
   * 
   * IMPORTANT:
   * - MySQL DATETIME stores wall-clock time without timezone (e.g., "2025-12-24 12:00:00").
   * - Prisma reads this as UTC, so "2025-12-24 12:00:00" becomes a JS Date with UTC time.
   * - We extract the time portion using UTC getters to get the original wall-clock time.
   * - This prevents timezone conversion (12:00 stays 12:00, not shifted to 17:30 IST).
   */
  private formatTripDateTime(d?: Date | string | null) {
    if (!d) return null;
    const dt = d instanceof Date ? d : new Date(d);
    if (isNaN(dt.getTime())) return null;

    let hh = dt.getUTCHours();
    const mm = this.pad2(dt.getUTCMinutes());

    const ampm = hh >= 12 ? 'PM' : 'AM';
    hh = hh % 12;
    if (hh === 0) hh = 12;

    return `${this.pad2(hh)}:${mm} ${ampm}`;
  }


  /**
   * FORMAT MySQL TIME (stored as IST wall-clock in DB) → "hh:mm AM/PM".
   *
   * IMPORTANT:
   * - MySQL TIME has no timezone.
   * - Prisma maps TIME to a JS Date (1970-01-01T12:00:00.000Z) in UTC.
   * - We must use UTC getters to read the time value without timezone conversion.
   * - Using local getters on an IST server would add +5:30 (12:00 → 17:30).
   */
  public formatTime(d?: Date | string | null): string | null {
    if (!d) return null;
    const dt = d instanceof Date ? d : new Date(d);
    if (isNaN(dt.getTime())) return null;

    let hh = dt.getUTCHours();           // ✅ Read UTC time value
    const mm = this.pad2(dt.getUTCMinutes());

    const ampm = hh >= 12 ? 'PM' : 'AM';
    hh = hh % 12;
    if (hh === 0) hh = 12;

    return `${this.pad2(hh)}:${mm} ${ampm}`;
  }

  /** Convert a TIME duration (stored as Date) to "X Hours" / "Y Min" */
  private formatDuration(d?: Date | string | null): string | null {
    if (!d) return null;
    let totalMinutes: number | null = null;

    if (d instanceof Date) {
      if (isNaN(d.getTime())) return null;
      totalMinutes = d.getUTCHours() * 60 + d.getUTCMinutes();
    } else if (typeof d === 'string') {
      const raw = d.trim();
      const hhmmss = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);

      if (hhmmss) {
        totalMinutes = Number(hhmmss[1]) * 60 + Number(hhmmss[2]);
      } else {
        const dt = new Date(raw);
        if (!isNaN(dt.getTime())) {
          totalMinutes = dt.getUTCHours() * 60 + dt.getUTCMinutes();
        }
      }
    }

    if (totalMinutes === null) return null;
    if (totalMinutes <= 0) return null;

    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;

    if (h > 0 && m > 0) return `${h} Hours ${m} Min`;
    if (h > 0) return `${h} Hours`;
    return `${m} Min`;
  }

  /** Convert time string "HH:MM AM/PM" to minutes since midnight */
  private timeToMinutes(timeStr: string | null): number {
    if (!timeStr) return 0;
    
    const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!match) return 0;
    
    let hours = parseInt(match[1]);
    const minutes = parseInt(match[2]);
    const ampm = match[3].toUpperCase();
    
    if (ampm === 'PM' && hours !== 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;
    
    return hours * 60 + minutes;
  }

  private parseDisplayTimeMinutesStrict(timeStr: string | null): number | null {
    if (!timeStr) return null;
    const match = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) return null;

    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const ampm = match[3].toUpperCase();

    if (ampm === 'PM' && hours !== 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;

    return hours * 60 + minutes;
  }

  private minutesToDisplayTime(minutes: number): string {
    const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440;
    let hh = Math.floor(normalized / 60);
    const mm = normalized % 60;
    const ampm = hh >= 12 ? 'PM' : 'AM';
    hh = hh % 12;
    if (hh === 0) hh = 12;
    return `${this.pad2(hh)}:${this.pad2(mm)} ${ampm}`;
  }

  private orderedTimeRange(startTimeText: string | null, endTimeText: string | null): string | null {
    if (!startTimeText || !endTimeText) return null;

    const startMins = this.parseDisplayTimeMinutesStrict(startTimeText);
    const endMins = this.parseDisplayTimeMinutesStrict(endTimeText);

    if (startMins === null || endMins === null) {
      return `${startTimeText} - ${endTimeText}`;
    }

    if (startMins <= endMins) {
      return `${startTimeText} - ${endTimeText}`;
    }

    return `${endTimeText} - ${startTimeText}`;
  }

  private extractRangeFromSegment(seg: any): {
    field: 'timeRange' | 'visitTime';
    suffix: string;
    start: number;
    end: number;
  } | null {
    if (!seg) return null;

    const field: 'timeRange' | 'visitTime' | null =
      seg.type === 'attraction' ? 'visitTime' :
      (seg.type === 'start' || seg.type === 'travel' || seg.type === 'return' || seg.type === 'break') ? 'timeRange' :
      null;

    if (!field || typeof seg[field] !== 'string') return null;

    const raw = String(seg[field]);
    const suffixStart = raw.indexOf(' (');
    const core = (suffixStart >= 0 ? raw.slice(0, suffixStart) : raw).trim();
    const suffix = suffixStart >= 0 ? raw.slice(suffixStart) : '';
    const parts = core.split(' - ').map((p) => p.trim());
    if (parts.length !== 2) return null;

    const start = this.parseDisplayTimeMinutesStrict(parts[0]);
    const end = this.parseDisplayTimeMinutesStrict(parts[1]);
    if (start === null || end === null) return null;

    return { field, suffix, start, end };
  }

  private normalizeSegmentChronology(segments: any[]): void {
    let previousEnd: number | null = null;

    for (const seg of segments) {
      const parsed = this.extractRangeFromSegment(seg);
      if (!parsed) continue;

      let start = parsed.start;
      let end = parsed.end;
      if (end < start) {
        const temp = start;
        start = end;
        end = temp;
      }

      if (previousEnd !== null && start < previousEnd) {
        const duration = Math.max(0, end - start);
        start = previousEnd;
        end = start + duration;
      }

      seg[parsed.field] = `${this.minutesToDisplayTime(start)} - ${this.minutesToDisplayTime(end)}${parsed.suffix}`;
      previousEnd = end;
    }
  }

  // ---------------------------------------------------------------------------
  // Itinerary DETAILS (parity-ish with PHP, WITHOUT hotels)
  // ---------------------------------------------------------------------------
  
  /**
   * Helper method to get planId from quoteId
   */
  async getPlanIdFromQuoteId(quoteId: string): Promise<number | null> {
    const plan = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_quote_ID: quoteId, deleted: 0 },
      select: { itinerary_plan_ID: true },
    });
    return plan ? plan.itinerary_plan_ID : null;
  }

  async getItineraryDetails(
    quoteId: string,
    groupType?: number,
  ): Promise<ItineraryDetailsResponseDto> {
    // ------------------------------ PLAN ------------------------------
    const plan = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_quote_ID: quoteId, deleted: 0 },
    });

    if (!plan) {
      throw new NotFoundException('Itinerary not found');
    }
    const planId = plan.itinerary_plan_ID;
    const proofQuoteEnabled = quoteId === 'DVI202604230';
    const proofHotspotId = 13;
    const proofRouteHotspotId = 40060;

    const confirmedPlan = await this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
      where: { itinerary_plan_ID: planId, deleted: 0 },
    });

    // ------------------------- ROUTES + HOTSPOTS ----------------------
   const routes = await this.prisma.dvi_itinerary_route_details.findMany({
  where: { itinerary_plan_ID: planId, deleted: 0, status: 1 },
  orderBy: { itinerary_route_ID: 'asc' },
});

const vehicleKmRows =
  await this.prisma.$queryRawUnsafe(`
    SELECT
      itinerary_route_id,
      total_running_km,
      total_siteseeing_km,
      total_travelled_km
    FROM dvi_itinerary_plan_vendor_vehicle_details
    WHERE itinerary_plan_id = ${planId}
      AND deleted = 0
  `) as any[];

const vehicleKmByRouteId = new Map<
  number,
  { runningKm: number; sightseeingKm: number; totalKm: number }
>();

for (const row of vehicleKmRows) {
  const routeId = Number((row as any).itinerary_route_id || 0);
  if (!routeId) continue;

  const runningKm =
    parseFloat(String((row as any).total_running_km || 0)) || 0;
  const sightseeingKm =
    parseFloat(String((row as any).total_siteseeing_km || 0)) || 0;
  const totalKm =
    parseFloat(String((row as any).total_travelled_km || 0)) || 0;

  const existing = vehicleKmByRouteId.get(routeId);

  if (!existing) {
    vehicleKmByRouteId.set(routeId, {
      runningKm,
      sightseeingKm,
      totalKm,
    });
    continue;
  }

  vehicleKmByRouteId.set(routeId, {
    runningKm: Math.max(existing.runningKm, runningKm),
    sightseeingKm: Math.max(existing.sightseeingKm, sightseeingKm),
    totalKm: Math.max(existing.totalKm, totalKm),
  });
}

    // ------------------------- HOTELS FOR TIMELINE ----------------------
    let timelineHotelRows: any[] = [];
    
    if (confirmedPlan) {
      // If confirmed, fetch from confirmed hotels table
      const confirmedHotelWhere: any = { itinerary_plan_id: planId, deleted: 0 };
      
      timelineHotelRows = await this.prisma.dvi_confirmed_itinerary_plan_hotel_details.findMany({
        where: confirmedHotelWhere,
        select: {
          hotel_id: true,
          hotel_code: true,
          itinerary_route_id: true,
          group_type: true,
        }
      });
      
      console.log(`[Timeline Hotels] Fetched ${timelineHotelRows.length} hotels from CONFIRMED table`);
    } else {
      // If draft, fetch from draft hotels table
      const timelineHotelWhere: any = { itinerary_plan_id: planId, deleted: 0 };
      if (groupType !== undefined) {
        timelineHotelWhere.group_type = groupType;
      } else {
        timelineHotelWhere.group_type = 1; // Default to first recommendation
      }

      timelineHotelRows = await this.prisma.dvi_itinerary_plan_hotel_details.findMany({
        where: timelineHotelWhere,
        select: {
          hotel_id: true,
          hotel_code: true,
          itinerary_route_id: true,
          group_type: true,
        }
      });
      
      console.log(`[Timeline Hotels] Fetched ${timelineHotelRows.length} hotels from DRAFT table with group_type=${timelineHotelWhere.group_type}`);
    }

    // Build route -> hotel map
    // For TBO/ResAvenue hotels, we'll get names from the live search API later
    const routeHotelRowMap = new Map(
      timelineHotelRows.map((h) => [h.itinerary_route_id, h]),
    );
    
    // Try to get hotel names from dvi_hotel master (for local hotels)
    const hotelIds = Array.from(
      new Set(
        timelineHotelRows
          .map((h) => Number(h.hotel_id ?? 0))
          .filter((id) => id > 0),
      ),
    );
    const hotelMasters = hotelIds.length > 0
      ? await this.prisma.dvi_hotel.findMany({
          where: { hotel_id: { in: hotelIds } },
          select: { hotel_id: true, hotel_name: true, hotel_address: true },
        })
      : [];
    
    const hotelMasterMap = new Map(hotelMasters.map(h => [h.hotel_id, h]));

    const tboHotelCodes = Array.from(
      new Set(
        timelineHotelRows
          .map((h: any) => String(h?.hotel_code ?? '').trim())
          .filter((code) => code.length > 0),
      ),
    );

    const tboHotelMasters = tboHotelCodes.length
      ? await this.prisma.tbo_hotel_master.findMany({
          where: { tbo_hotel_code: { in: tboHotelCodes } },
          select: {
            tbo_hotel_code: true,
            hotel_name: true,
            hotel_address: true,
          },
        })
      : [];

    const tboHotelMasterMap = new Map(
      tboHotelMasters.map((h) => [h.tbo_hotel_code, h]),
    );

    // For TBO hotels, also try to look up from tbo_hotel_booking_confirmation
    const tboConfirmationRows = await this.prisma.tbo_hotel_booking_confirmation.findMany({
      where: {
        itinerary_plan_ID: planId,
        deleted: 0,
      },
      select: {
        itinerary_route_ID: true,
        tbo_hotel_code: true,
      },
      distinct: ['itinerary_route_ID'],
    });

    const tboConfirmationMap = new Map(
      tboConfirmationRows.map((r: any) => [Number(r.itinerary_route_ID), r.tbo_hotel_code]),
    );
    
    // Build final map with hotel info
    // If hotel not in master, we'll fetch from TBO/ResAvenue search results
    const routeHotelMap = new Map();
    for (const [routeId, hotelRow] of routeHotelRowMap.entries()) {
      const hotelIdNum = Number((hotelRow as any)?.hotel_id ?? 0);
      const masterInfo = hotelMasterMap.get(hotelIdNum);
      
      let hotelCode = String((hotelRow as any)?.hotel_code ?? '').trim();
      // Fallback: check if there's a TBO confirmation for this route
      if (!hotelCode && tboConfirmationMap.has(routeId)) {
        hotelCode = String(tboConfirmationMap.get(routeId) ?? '').trim();
      }
      
      const tboInfo = hotelCode.length ? tboHotelMasterMap.get(hotelCode) : null;

      routeHotelMap.set(routeId, {
        hotel_id: hotelIdNum,
        hotel_name: masterInfo?.hotel_name ?? tboInfo?.hotel_name ?? null,
        hotel_address: masterInfo?.hotel_address ?? tboInfo?.hotel_address ?? null,
        hotel_code: hotelCode,
      });
    }

    const days: any[] = [];

    for (let index = 0; index < routes.length; index++) {
      const route = routes[index];

      // from/to locations (dvi_stored_locations)
      const location =
        route.location_id && route.location_id !== BigInt(0)
          ? await this.prisma.dvi_stored_locations.findFirst({
              where: {
                location_ID: route.location_id,
                deleted: 0,
              },
            })
          : null;

      // route-hotspot rows
      const routeHotspots =
        await this.prisma.$queryRawUnsafe(`
          SELECT 
            route_hotspot_ID,
            itinerary_plan_ID,
            itinerary_route_ID,
            item_type,
            hotspot_order,
            hotspot_ID,
            hotspot_adult_entry_cost,
            hotspot_child_entry_cost,
            hotspot_infant_entry_cost,
            hotspot_foreign_adult_entry_cost,
            hotspot_foreign_child_entry_cost,
            hotspot_foreign_infant_entry_cost,
            hotspot_amout,
            CAST(hotspot_traveling_time AS CHAR) as hotspot_traveling_time,
            CAST(itinerary_travel_type_buffer_time AS CHAR) as itinerary_travel_type_buffer_time,
            hotspot_travelling_distance,
            hotspot_start_time,
            hotspot_end_time,
            allow_break_hours,
            allow_via_route,
            via_location_name,
            hotspot_plan_own_way,
            is_conflict,
            conflict_reason,
            createdby,
            createdon,
            updatedon,
            status,
            deleted
          FROM dvi_itinerary_route_hotspot_details
          WHERE itinerary_plan_ID = ${planId}
            AND itinerary_route_ID = ${route.itinerary_route_ID}
            AND deleted = 0
            AND status = 1
          ORDER BY hotspot_order ASC
        `) as any[];

      // Bug 3 fix: stable tiebreaker so TRAVEL_TO_HOTEL (item_type=5) always
      // precedes CHECKIN (item_type=6) when both share the same hotspot_order.
      // Array.sort is in-place; the SQL primary sort by hotspot_order is preserved
      // for all rows whose hotspot_order values differ.
      routeHotspots.sort((a: any, b: any) => {
        const orderDiff = Number(a.hotspot_order ?? 0) - Number(b.hotspot_order ?? 0);
        if (orderDiff !== 0) return orderDiff;
        return Number(a.item_type ?? 0) - Number(b.item_type ?? 0);
      });

      if (proofQuoteEnabled) {
        const proofRawRow = routeHotspots.find(
          (rh) => Number((rh as any).route_hotspot_ID) === proofRouteHotspotId,
        );
        if (proofRawRow) {
          console.log('[ItineraryDetails][PROOF] Raw route hotspot row from details query', {
            quoteId,
            planId,
            itineraryRouteId: route.itinerary_route_ID,
            routeHotspotId: (proofRawRow as any).route_hotspot_ID,
            hotspotId: (proofRawRow as any).hotspot_ID,
            itemType: (proofRawRow as any).item_type,
            hotspotStartTime: (proofRawRow as any).hotspot_start_time,
            hotspotEndTime: (proofRawRow as any).hotspot_end_time,
            hotspotOrder: (proofRawRow as any).hotspot_order,
            isConflict: (proofRawRow as any).is_conflict,
            conflictReason: (proofRawRow as any).conflict_reason,
            deleted: (proofRawRow as any).deleted,
            status: (proofRawRow as any).status,
          });
          console.log('[VisitTime][PROOF] Route day boundaries from route row', {
            itineraryRouteId: route.itinerary_route_ID,
            routeStartTimeRaw: route.route_start_time,
            routeEndTimeRaw: route.route_end_time,
            routeStartTimeDisplay: this.formatTime(route.route_start_time as any),
            routeEndTimeDisplay: this.formatTime(route.route_end_time as any),
          });
        }
      }

      const hotspotIds = Array.from(
        new Set(
          routeHotspots
            .map((h) => h.hotspot_ID)
            .filter((id) => typeof id === 'number' && id > 0),
        ),
      );

      const hotspotMasters = hotspotIds.length
        ? await this.prisma.dvi_hotspot_place.findMany({
            where: {
              hotspot_ID: { in: hotspotIds },
              deleted: 0,
            },
          })
        : [];

      const hotspotMap = new Map(hotspotMasters.map((h) => [h.hotspot_ID, h]));

      // Fetch hotspot timing data for opening hours
      const hotspotTimings = hotspotIds.length
        ? await this.prisma.dvi_hotspot_timing.findMany({
            where: {
              hotspot_ID: { in: hotspotIds },
              deleted: 0,
              status: 1,
            },
          })
        : [];

      const hotspotTimingMap = new Map<number, any[]>();
      for (const t of hotspotTimings) {
        if (!hotspotTimingMap.has(t.hotspot_ID)) {
          hotspotTimingMap.set(t.hotspot_ID, []);
        }
        hotspotTimingMap.get(t.hotspot_ID)!.push(t);
      }

      // Bulk fetch hotspot gallery images
      const hotspotGalleryRows = hotspotIds.length
        ? await this.prisma.dvi_hotspot_gallery_details.findMany({
            where: { hotspot_ID: { in: hotspotIds }, deleted: 0 },
            orderBy: { hotspot_gallery_details_id: 'asc' },
            select: { hotspot_ID: true, hotspot_gallery_name: true },
          })
        : [];
      const hotspotGalleryMap = new Map<number, string[]>();
      for (const g of hotspotGalleryRows) {
        const name = (g.hotspot_gallery_name ?? '').toString().trim();
        if (!name) continue;
        const urls = hotspotGalleryMap.get(g.hotspot_ID) ?? [];
        urls.push(`/uploads/hotspot_gallery/${name}`);
        hotspotGalleryMap.set(g.hotspot_ID, urls);
      }

      const segments: any[] = [];
      let travelAnchorIndex = 0;

      // Push CTA immediately before the upcoming travel segment so it renders:
      //   Attraction → CTA → Travel → Attraction → CTA → Travel …
      const pushHotspotAnchorPlaceholder = (payload: {
        from: string;
        to: string;
        timeRange: string | null;
      }) => {
        segments.push({
          type: 'hotspot' as const,
          text: 'Click to Add Hotspot',
          locationId: route.location_id ? Number(route.location_id) : null,
          anchorType: 'after_travel' as const,
          anchorIndex: travelAnchorIndex,
          anchorFrom: payload.from,
          anchorTo: payload.to,
          anchorTimeRange: payload.timeRange,
        });
        travelAnchorIndex += 1;
      };

      let previousStopName =
        location?.source_location ??
        route.location_name ??
        plan.arrival_location ??
        "";

      // If starting from "Hotel", use the hotel name from the previous day's stay
      if (previousStopName === "Hotel" && index > 0) {
        const prevHotelInfo = routeHotelMap.get(
          routes[index - 1].itinerary_route_ID,
        );
        if (prevHotelInfo?.hotel_name) {
          previousStopName = prevHotelInfo.hotel_name;
        }
      }

      let totalDistanceKm = 0;
      
      // FIX #3: Track hotel arrival time for checkin anchoring
      let hotelArrivalTime: string | null = null;
      const routeEndMins = this.timeToMinutes(this.formatTime(route.route_end_time as any) ?? '00:00 AM');

      const normalizeName = (value?: string | null) =>
        (value ?? '').trim().toLowerCase();

      const getRouteHotelName = () => {
        const hotelInfo = routeHotelMap.get(route.itinerary_route_ID);
        return hotelInfo?.hotel_name ?? 'Hotel';
      };

      const findNextSemanticDestinationName = (
        rows: any[],
        currentIndex: number,
      ): string | null => {
        for (let nextIndex = currentIndex + 1; nextIndex < rows.length; nextIndex++) {
          const nextRow = rows[nextIndex];
          const nextItemType = Number((nextRow as any).item_type ?? 0);

          if (nextItemType === 4) {
            const nextMaster = nextRow.hotspot_ID
              ? hotspotMap.get(nextRow.hotspot_ID as number) || null
              : null;
            const nextHotspotName = nextMaster?.hotspot_name?.trim();
            if (nextHotspotName) {
              return nextHotspotName;
            }
            continue;
          }

          if (nextItemType === 5 || nextItemType === 6) {
            // Skip hotel-related rows; continue looking for next activity destination
            continue;
          }

          if (nextItemType === 2 || nextItemType === 7) {
            const nextLocationName =
              route.next_visiting_location ??
              location?.destination_location ??
              plan.departure_location ??
              null;
            if (!nextLocationName) {
              continue;
            }
            return nextLocationName === 'Hotel'
              ? getRouteHotelName()
              : nextLocationName;
          }

          if (nextItemType === 3) {
            if (Number((nextRow as any).allow_break_hours ?? 0) === 1) {
              continue;
            }

            const nextViaLocationName = (nextRow as any).via_location_name?.trim();
            if (
              Number((nextRow as any).allow_via_route ?? 0) === 1 &&
              nextViaLocationName
            ) {
              return nextViaLocationName;
            }

            if (Number((nextRow as any).hotspot_ID ?? 0) === 0) {
              const nextLocationName =
                route.next_visiting_location ??
                location?.destination_location ??
                plan.departure_location ??
                null;
              if (!nextLocationName) {
                continue;
              }
              return nextLocationName === 'Hotel'
                ? getRouteHotelName()
                : nextLocationName;
            }
          }
        }

        return null;
      };

      // Find item_type 1 (START/BREAK) to get actual start time
      const startHotspot = routeHotspots.find(
        (rh) => Number((rh as any).item_type ?? 0) === 1,
      );

      // ====== SEMANTIC RECONSTRUCTION ALGORITHM ======
      // Reconstruct true origin/destination for each travel row by analyzing:
      // 1. The hotspot_ID in the travel row (destination)
      // 2. The sequence of visits and their times
      // 3. Looking back for the actual "from" location
      //
      // Key insight: item_type=3 rows appear in DB after their corresponding  
      // item_type=4 attractions (due to hotspot_order sorting), but chronologically
      // they represent TRAVEL TO those attractions. The "from" is the previous
      // different location we visited.
      
      const buildTravelSegmentSemantics = (): Map<number, {from: string; to: string}> => {
        const travelSemantics = new Map<number, {from: string; to: string}>();
        
        // First pass: collect all attractions and their visit order
        const visitSequence: Array<{hotspotId: number; hotspotName: string}> = [];
        let routeStartLoc =
          location?.source_location ??
          route.location_name ??
          plan.arrival_location ??
          '';

        // If this day starts from "Hotel" (previous-night stay), resolve the
        // actual hotel name so the first travel segment reads
        // "From PLA Residency, Thanjavur" instead of the bare city name.
        if (index > 0) {
          const prevRouteHotelInfo = routeHotelMap.get(
            routes[index - 1].itinerary_route_ID,
          );
          if (prevRouteHotelInfo?.hotel_name) {
            routeStartLoc = prevRouteHotelInfo.hotel_name;
          }
        }
        
        // Track the last unique location we're at
        let lastUniqueLocation = routeStartLoc;

        const getHotelCheckinTimeMinutes = (row: any): number | null => {
          const start = this.formatTime((row as any)?.hotspot_start_time ?? null);
          const end = this.formatTime((row as any)?.hotspot_end_time ?? null);
          const checkInTime = end || start;
          return checkInTime ? this.timeToMinutes(checkInTime) : null;
        };

        const hasPriorHotelCheckinBeforeTravel = (travelRow: any): boolean => {
          const travelStart = this.formatTime((travelRow as any)?.hotspot_start_time ?? null);
          if (!travelStart) return false;
          const travelStartMins = this.timeToMinutes(travelStart);

          return routeHotspots.some((candidate) => {
            const candidateType = Number((candidate as any).item_type ?? 0);
            if (candidateType !== 6) return false;
            const checkInMins = getHotelCheckinTimeMinutes(candidate);
            return checkInMins !== null && checkInMins <= travelStartMins;
          });
        };
        
        // Build visit sequence by collecting all attractions
        for (const row of routeHotspots) {
          const itemType = Number((row as any).item_type ?? 0);
          const hotspotId = Number(row.hotspot_ID ?? 0);
          
          if (itemType === 4 && hotspotId > 0) {
            const master = hotspotMap.get(hotspotId);
            if (master?.hotspot_name?.trim()) {
              visitSequence.push({hotspotId, hotspotName: master.hotspot_name});
              lastUniqueLocation = master.hotspot_name;
            }
          }
        }
        
        // Second pass: determine origin for each travel row
        for (const row of routeHotspots) {
          const itemType = Number((row as any).item_type ?? 0);
          const hotspotId = Number(row.hotspot_ID ?? 0);
          
          if (itemType === 3 && hotspotId > 0) {
            // This is a travel row - determine its origin and destination
            const destMaster = hotspotMap.get(hotspotId);
            const destination = destMaster?.hotspot_name ?? lastUniqueLocation;
            
            // Find the origin by looking at what comes before this destination in visit sequence
            let origin = routeStartLoc;  // Safe fallback
            
            // Find this hotspotId in the visit sequence
            const destIndex = visitSequence.findIndex(v => v.hotspotId === hotspotId);
            
            if (destIndex > 0) {
              // There's a previous visit - that's where we came from
              origin = visitSequence[destIndex - 1].hotspotName;
            } else if (destIndex === 0 && visitSequence.length > 0) {
              // First destination: in hotel-first flows, first sightseeing starts from hotel.
              origin = hasPriorHotelCheckinBeforeTravel(row)
                ? getRouteHotelName()
                : routeStartLoc;
            } else {
              // Destination not found in visits (shouldn't happen, but safe)
              origin = routeStartLoc;
            }
            
            travelSemantics.set(row.route_hotspot_ID, {
              from: origin,
              to: destination,
            });
          }
        }
        
        return travelSemantics;
      };
      
      // Build the semantic map once, before main loop
      const travelSegmentSemantics = buildTravelSegmentSemantics();

      // Only add START segment if item_type 1 exists (match PHP behavior)
      // Exception: suppress START on late-arrival Day 1 that has no attractions
      const hasAttractions = routeHotspots.some(
        (rh) => Number((rh as any).item_type ?? 0) === 4,
      );
      const isLateArrivalDay1 = index === 0 && (() => {
        const planStartTime = (plan as any).trip_start_date_and_time;
        if (planStartTime instanceof Date) {
          const h = planStartTime.getUTCHours();
          return h >= 17 || h === 0;
        }
        // Fallback to route start time for this route
        const routeStart = typeof route.route_start_time === 'string'
          ? route.route_start_time
          : route.route_start_time && typeof route.route_start_time === 'object'
          ? `${String((route.route_start_time as any).getUTCHours()).padStart(2, '0')}:00`
          : null;
        if (routeStart) {
          const h = parseInt(routeStart.split(':')[0], 10);
          return h >= 17 || h === 0;
        }
        return false;
      })();

      if (startHotspot && !(isLateArrivalDay1 && !hasAttractions)) {
        const startTimeRange = `${this.formatTime((startHotspot as any).hotspot_start_time ?? null)} - ${this.formatTime((startHotspot as any).hotspot_end_time ?? null)}`;

        segments.push({
          type: 'start' as const,
          title: index === 0 ? 'Start your Journey' : 'Start Your Day',
          timeRange: startTimeRange,
        });
      }

      for (const rh of routeHotspots) {
        // ✅ NEW FILTER: Skip hotel rows marked as appearing before route start
        // These are previous-day checkout rows incorrectly attached to current day
        const isConflictMarked = (rh as any).is_conflict === 1 || (rh as any).isConflict === true;
        const conflictReason = String((rh as any).conflict_reason || (rh as any).conflictReason || '');
        
        if (isConflictMarked && conflictReason.includes('HOTEL_ROW_BEFORE_ROUTE_START')) {
          // Log the suppression for proof
          if (proofQuoteEnabled) {
            console.log('[HotelDayBoundaryAPI][PROOF] Suppressing hotel row before route start', {
              quoteId,
              routeId: route.itinerary_route_ID,
              routeHotspotId: rh.route_hotspot_ID,
              itemType: (rh as any).item_type,
              itemTypeName: (rh as any).item_type === 5 ? 'TRAVEL_TO_HOTEL' : ((rh as any).item_type === 6 ? 'CHECKIN' : 'OTHER'),
              startTime: this.formatTime((rh as any).hotspot_start_time ?? null),
              endTime: this.formatTime((rh as any).hotspot_end_time ?? null),
              conflictReason,
              action: 'SKIPPED_FROM_RESPONSE',
            });
          }
          continue;  // Skip this row, don't add segment to response
        }

        const master = rh.hotspot_ID
          ? hotspotMap.get(rh.hotspot_ID as number) || null
          : null;

        const itemType = Number((rh as any).item_type ?? 0);

        const distanceStr = (rh as any)
          .hotspot_travelling_distance as string | null | undefined;
        const distanceNum =
          distanceStr && distanceStr.trim().length
            ? parseFloat(distanceStr)
            : 0;
        const travelDistance = `${(distanceNum || 0).toFixed(2)} KM`;

        const travelDuration = (rh as any).hotspot_traveling_time ?? null;
        const startTimeText = this.formatTime(
          (rh as any).hotspot_start_time ?? null,
        );
        const endTimeText = this.formatTime(
          (rh as any).hotspot_end_time ?? null,
        );

        // ---------------- ITEM TYPE HANDLING (match PHP) ----------------
        if (itemType === 1) {
          // PHP doesn't actually show a separate row here; we already pushed
          // the generic "Start your Journey" above, so just update previousStop.
          const newPreviousStopName = 
            location?.source_location ??
            route.location_name ??
            plan.arrival_location ??
            '';
          
          // [PROOF] Log START processing
          if (proofQuoteEnabled) {
            console.log('[ItemType1Start][PROOF]', {
              quoteId,
              routeId: route.itinerary_route_ID,
              routeHotspotId: rh.route_hotspot_ID,
              hotspotOrder: (rh as any).hotspot_order,
              sourceLocation: location?.source_location ?? 'N/A',
              routeLocationName: route.location_name ?? 'N/A',
              planArrivalLocation: plan.arrival_location ?? 'N/A',
              derivedStartLocation: newPreviousStopName,
              timeRange: `${startTimeText} - ${endTimeText}`,
              previousStopNameBefore: previousStopName,
            });
          }
          
          previousStopName = newPreviousStopName;
          continue;
        }

        if (itemType === 2) {
          // TRAVEL row (from source to next location)
          let toName =
            route.next_visiting_location ??
            location?.destination_location ??
            plan.departure_location ??
            "";

          if (toName === "Hotel") {
            const hotelInfo = routeHotelMap.get(route.itinerary_route_ID);
            if (hotelInfo?.hotel_name) {
              toName = hotelInfo.hotel_name;
            }
          }

          // Skip travel segment if from and to locations are the same
          if (previousStopName.trim() === toName.trim()) {
            // Still update previousStopName to maintain consistency
            previousStopName = toName;
            continue;
          }

          if (!Number.isNaN(distanceNum)) {
            totalDistanceKm += distanceNum;
          }

          const travelRange = this.orderedTimeRange(startTimeText, endTimeText);

          pushHotspotAnchorPlaceholder({
            from: previousStopName,
            to: toName,
            timeRange: travelRange,
          });
          segments.push({
            type: "travel" as const,
            from: previousStopName,
            to: toName,
            timeRange: travelRange,
            distance: travelDistance,
            duration: this.formatDuration(travelDuration),
            note: "This may vary due to traffic conditions",
          });

          previousStopName = toName;
          continue;
        }

        if (itemType === 3) {
          // Item type 3 can be: break hours, via route, or lunch break
          const allowBreakHours = (rh as any).allow_break_hours ?? 0;
          const allowViaRoute = (rh as any).allow_via_route ?? 0;
          const viaLocationName = (rh as any).via_location_name?.trim();

          // [PROOF] Log item_type=3 entry state
          if (proofQuoteEnabled) {
            console.log('[ItemType3Entry][PROOF]', {
              quoteId,
              routeId: route.itinerary_route_ID,
              routeHotspotId: rh.route_hotspot_ID,
              hotspotOrder: (rh as any).hotspot_order,
              hotspotId: rh.hotspot_ID,
              hotspotName: master?.hotspot_name ?? 'N/A',
              allowBreakHours,
              allowViaRoute,
              viaLocationName,
              previousStopNameBeforeProcessing: previousStopName,
              rowTimeStart: startTimeText,
              rowTimeEnd: endTimeText,
              rowDistance: travelDistance,
              rowDuration: (rh as any).hotspot_traveling_time,
            });
          }

          if (allowBreakHours === 1) {
            // BREAK HOURS (Lunch break, waiting time, etc.)
            const toName = master?.hotspot_name ?? viaLocationName ?? previousStopName;
            const breakRange = this.orderedTimeRange(startTimeText, endTimeText);
            
            segments.push({
              type: 'break' as const,
              location: toName,
              duration: this.formatDuration(travelDuration),
              timeRange: breakRange,
            });
          } else if (allowViaRoute === 1 && viaLocationName) {
            // VIA ROUTE (Travel via a location)
            const toName = viaLocationName;
            const travelRange = this.orderedTimeRange(startTimeText, endTimeText);

            if (!Number.isNaN(distanceNum)) {
              totalDistanceKm += distanceNum;
            }

            pushHotspotAnchorPlaceholder({
              from: previousStopName,
              to: toName,
              timeRange: travelRange,
            });
            segments.push({
              type: 'travel' as const,
              from: previousStopName,
              to: toName,
              timeRange: travelRange,
              distance: travelDistance,
              duration: this.formatDuration(travelDuration),
              note: 'This may vary due to traffic conditions',
            });

            previousStopName = toName;
          } else {
            // Regular travel to hotspot - use precomputed semantic mapping
            const semanticMapping = travelSegmentSemantics.get(rh.route_hotspot_ID);
            const fromName = semanticMapping?.from ?? previousStopName;  // Fallback only if not in map
            let toName = semanticMapping?.to ?? 
              master?.hotspot_name ??
              viaLocationName ??
              (rh.hotspot_ID === 0 ? route.next_visiting_location : null) ??
              previousStopName;

            if (toName === "Hotel") {
              const hotelInfo = routeHotelMap.get(route.itinerary_route_ID);
              if (hotelInfo?.hotel_name) {
                toName = hotelInfo.hotel_name;
              }
            }

            const initiallyDerivedToName = toName;
            let nextSemanticDestinationChosen: string | null = null;
            let usedNextSemanticDestination = false;

            if (proofQuoteEnabled) {
              console.log('[Item3RegularTravelBeforeLookahead][PROOF]', {
                quoteId,
                routeId: route.itinerary_route_ID,
                routeHotspotId: rh.route_hotspot_ID,
                hotspotOrder: (rh as any).hotspot_order,
                hotspotId: Number(rh.hotspot_ID ?? 0),
                semanticMappingFound: !!semanticMapping,
                derivedFromName: fromName,
                derivedToNameInitial: initiallyDerivedToName,
                rowTimes: `${startTimeText} - ${endTimeText}`,
                rowDistance: travelDistance,
              });
            }

            if (
              normalizeName(fromName) === normalizeName(toName) &&
              Number(rh.hotspot_ID ?? 0) > 0
            ) {
              const currentIndex = routeHotspots.indexOf(rh);
              nextSemanticDestinationChosen =
                currentIndex >= 0
                  ? findNextSemanticDestinationName(routeHotspots, currentIndex)
                  : null;

              if (nextSemanticDestinationChosen) {
                toName = nextSemanticDestinationChosen;
                usedNextSemanticDestination = true;
              }
            }

            if (proofQuoteEnabled) {
              console.log('[Item3LookaheadResult][PROOF]', {
                quoteId,
                routeId: route.itinerary_route_ID,
                routeHotspotId: rh.route_hotspot_ID,
                fromEqualToCondition: normalizeName(fromName) === normalizeName(initiallyDerivedToName),
                nextSemanticDestinationChosen,
                usedNextSemanticDestination,
                finalToName: toName,
              });
            }

            if (proofQuoteEnabled) {
              console.log('[TravelSegment][PROOF]', {
                quoteId,
                routeId: route.itinerary_route_ID,
                routeHotspotId: rh.route_hotspot_ID,
                hotspotOrder: (rh as any).hotspot_order,
                itemType: 3,
                hotspotId: rh.hotspot_ID,
                semanticFrom: fromName,
                initiallyDerivedToName,
                nextSemanticDestinationChosen,
                finalFrom: fromName,
                finalTo: toName,
                fallbackUsed: !usedNextSemanticDestination,
              });
            }

            if (!Number.isNaN(distanceNum)) {
              totalDistanceKm += distanceNum;
            }

            if (proofQuoteEnabled) {
              console.log('[Item3SegmentEmitted][PROOF]', {
                quoteId,
                routeId: route.itinerary_route_ID,
                routeHotspotId: rh.route_hotspot_ID,
                type: 'travel',
                from: fromName,
                to: toName,
                timeRange: this.orderedTimeRange(startTimeText, endTimeText),
                distance: travelDistance,
                duration: this.formatDuration(travelDuration),
              });
            }

            const travelRange = this.orderedTimeRange(startTimeText, endTimeText);

            pushHotspotAnchorPlaceholder({
              from: fromName,
              to: toName,
              timeRange: travelRange,
            });
            segments.push({
              type: "travel" as const,
              from: fromName,
              to: toName,
              timeRange: travelRange,
              distance: travelDistance,
              duration: this.formatDuration(travelDuration),
              note: "This may vary due to traffic conditions",
              isConflict: (rh as any).is_conflict === 1,
              conflictReason: (rh as any).conflict_reason ?? null,
            });

            previousStopName = toName;
          }
          continue;
        }

        if (itemType === 4) {
          // ATTRACTION / HOTSPOT visit
          if (!master || !master.hotspot_name?.trim()) {
            continue;
          }

          const stayDuration = (master as any).hotspot_duration ?? null;
          const hotspotAmount = (rh as any).hotspot_amout ?? 0;
          const hotspotPlanOwnWay = (rh as any).hotspot_plan_own_way ?? 0;
          const hotspotVideoUrl = master.hotspot_video_url ?? null;
          
          const rawP = (master as any).hotspot_priority ?? (master as any).priority ?? 0;
          const priority = Number(rawP) === 0 ? 9999 : Number(rawP);

          // Check if master catalog has activities for this hotspot
          const catalogActivityCount = rh.hotspot_ID
            ? await this.prisma.dvi_activity.count({
                where: { hotspot_id: rh.hotspot_ID as number, deleted: 0, status: 1 },
              })
            : 0;
          const hasAvailableActivities = catalogActivityCount > 0;

          // Fetch activities for this hotspot
          const activities = await this.prisma.dvi_itinerary_route_activity_details.findMany({
            where: {
              itinerary_plan_ID: planId,
              itinerary_route_ID: route.itinerary_route_ID,
              route_hotspot_ID: rh.route_hotspot_ID,
              hotspot_ID: rh.hotspot_ID as number,
              deleted: 0,
              status: 1,
            },
            orderBy: { activity_order: 'asc' },
          });

          // Fetch activity masters for details
          const activityIds = activities.map(a => a.activity_ID).filter(id => id > 0);
          const activityMasters = activityIds.length
            ? await this.prisma.dvi_activity.findMany({
                where: {
                  activity_id: { in: activityIds },
                  deleted: 0,
                },
              })
            : [];

          const activityMap = new Map(activityMasters.map(a => [a.activity_id, a]));

          // Bulk fetch activity gallery images for this hotspot's activities
          const activityGalleryRows = activityIds.length
            ? await this.prisma.dvi_activity_image_gallery_details.findMany({
                where: { activity_id: { in: activityIds }, deleted: 0 },
                orderBy: { activity_image_gallery_details_id: 'asc' },
                select: { activity_id: true, activity_image_gallery_name: true },
              })
            : [];
          const activityGalleryMap = new Map<number, string[]>();
          for (const g of activityGalleryRows) {
            const id = g.activity_id ?? 0;
            const name = (g.activity_image_gallery_name ?? '').toString().trim();
            if (!name || !id) continue;
            const urls = activityGalleryMap.get(id) ?? [];
            urls.push(`/uploads/activity_gallery/${name}`);
            activityGalleryMap.set(id, urls);
          }

          const activityList = activities.map(actDetail => {
            const actMaster = activityMap.get(actDetail.activity_ID);
            const actGallery = activityGalleryMap.get(actDetail.activity_ID) ?? [];
            return {
              id: actDetail.route_activity_ID,
              activityId: actDetail.activity_ID,
              title: actMaster?.activity_title ?? '',
              description: actMaster?.activity_description ?? '',
              amount: Number(actDetail.activity_amout || 0),
              startTime: this.formatTime(actDetail.activity_start_time as any),
              endTime: this.formatTime(actDetail.activity_end_time as any),
              duration: this.formatDuration(actDetail.activity_traveling_time as any),
              image: actGallery[0] ?? null,
              galleryImages: actGallery,
            };
          });

          // Check if there's wait time due to opening hours
          const orderedVisitRange = this.orderedTimeRange(startTimeText, endTimeText);
          let visitTimeDisplay = orderedVisitRange;

          let timingValidationExecuted = false;
          let timingValidationPassed = false;
          let timingValidationSkippedReason: string | null = null;

          if (visitTimeDisplay && rh.hotspot_ID && route.itinerary_route_date) {
            timingValidationExecuted = true;
            const timings = hotspotTimingMap.get(rh.hotspot_ID as number) || [];
            const dayOfWeek = (route.itinerary_route_date.getDay() + 6) % 7; // Mon=0 style

            const dayTimings = timings.filter(t => Number(t.hotspot_timing_day) === dayOfWeek);
            const todayTimings = dayTimings.filter(t => t.hotspot_closed !== 1);

            if (dayTimings.length > 0 && todayTimings.length === 0) {
              visitTimeDisplay = orderedVisitRange
                ? `${orderedVisitRange} (closed on this day)`
                : null;
            }

            if (todayTimings.length > 0) {
              const isOpenAllTime = todayTimings.some(t => t.hotspot_open_all_time === 1);
              
              if (!isOpenAllTime) {
                const visitStartText = orderedVisitRange
                  ? String(orderedVisitRange).split(' - ')[0]?.trim()
                  : startTimeText;
                const visitEndText = orderedVisitRange
                  ? String(orderedVisitRange).split(' - ')[1]?.trim()
                  : endTimeText;

                const arrivalMins = this.timeToMinutes(visitStartText);
                const departureMins = this.timeToMinutes(visitEndText);
                
                // Check if visit fits in ANY window
                const fitsInAnyWindow = todayTimings.some(t => {
                  const opStart = this.timeToMinutes(this.formatTime(t.hotspot_start_time as any));
                  const opEnd = this.timeToMinutes(this.formatTime(t.hotspot_end_time as any));
                  return arrivalMins >= opStart && departureMins <= opEnd;
                });

                if (!fitsInAnyWindow) {
                  // Find the next opening time after arrival
                  const nextOpening = todayTimings
                    .map(t => this.formatTime(t.hotspot_start_time as any))
                    .filter(ot => this.timeToMinutes(ot) > arrivalMins)
                    .sort((a, b) => this.timeToMinutes(a) - this.timeToMinutes(b))[0];

                  if (nextOpening) {
                    visitTimeDisplay = orderedVisitRange
                      ? `${orderedVisitRange} (opens at ${nextOpening})`
                      : null;
                  } else {
                    visitTimeDisplay = orderedVisitRange
                      ? `${orderedVisitRange} (outside operating hours)`
                      : null;
                  }
                }
                timingValidationPassed = fitsInAnyWindow;
              } else {
                timingValidationPassed = true;
              }
            } else {
              timingValidationSkippedReason = 'No open timings configured for the route day';
            }
          } else {
            timingValidationSkippedReason = 'Missing visit range, hotspot id, or route date';
          }

          // Format operating hours (timings)
          let operatingHours = '';
          const timings = rh.hotspot_ID ? hotspotTimingMap.get(rh.hotspot_ID as number) || [] : [];
          const dayOfWeek = route.itinerary_route_date ? (route.itinerary_route_date.getDay() + 6) % 7 : 0;
          const dayTimings = timings.filter(t => Number(t.hotspot_timing_day) === dayOfWeek);
          const todayTimings = dayTimings.filter(t => t.hotspot_closed !== 1);

          if (dayTimings.length > 0 && todayTimings.length === 0) {
            operatingHours = 'Closed';
          } else if (todayTimings.length > 0) {
            if (todayTimings.some(t => t.hotspot_open_all_time === 1)) {
              operatingHours = 'Open 24 Hours';
            } else {
              operatingHours = todayTimings
                .map(t => `${this.formatTime(t.hotspot_start_time as any)} - ${this.formatTime(t.hotspot_end_time as any)}`)
                .join(', ');
            }
          }

          segments.push({
            type: 'attraction' as const,
            name: master.hotspot_name,
            description: master.hotspot_description ?? '',
            visitTime: visitTimeDisplay,
            duration: this.formatDuration(stayDuration),
            amount: hotspotAmount > 0 ? Number(hotspotAmount) : null,
            timings: operatingHours,
            image: (hotspotGalleryMap.get(rh.hotspot_ID as number) ?? [])[0] ?? null,
            galleryImages: hotspotGalleryMap.get(rh.hotspot_ID as number) ?? [],
            videoUrl: hotspotVideoUrl,
            planOwnWay: hotspotPlanOwnWay === 1,
            activities: activityList,
            hasAvailableActivities,
            hotspotId: rh.hotspot_ID as number,
            routeHotspotId: rh.route_hotspot_ID,
            locationId: route.location_id ? Number(route.location_id) : null,
            priority,

            isConflict: (rh as any).is_conflict === 1,
            conflictReason: (rh as any).conflict_reason ?? null,
            isManual: hotspotPlanOwnWay === 1,
            isDeleted: (rh as any).deleted === 1,
          });

          // [PROOF] Log attraction processing
          if (proofQuoteEnabled) {
            console.log('[AttractionProcessing][PROOF]', {
              quoteId,
              routeId: route.itinerary_route_ID,
              routeHotspotId: rh.route_hotspot_ID,
              hotspotOrder: (rh as any).hotspot_order,
              hotspotId: rh.hotspot_ID,
              hotspotName: master.hotspot_name,
              visitTime: visitTimeDisplay,
              previousStopNameBefore: previousStopName,
            });
          }

          previousStopName = master.hotspot_name;

          continue;
        }

        if (itemType === 5) {
          // TRAVEL TO HOTEL segment
          // Derive origin by chronology (latest attraction that ended at/before this travel start).
          // Do NOT rely on row order; route rows are grouped by hotspot_order/item_type and can
          // place future attractions before this travel-to-hotel row in the array.
          
          const hotelInfo = routeHotelMap.get(route.itinerary_route_ID);
          const toName =
            hotelInfo?.hotel_name ??
            hotelInfo?.hotel_city ??
            location?.destination_location ??
            route.next_visiting_location ??
            "Hotel";

          const travelStartMins = startTimeText ? this.timeToMinutes(startTimeText) : null;

          // Find the chronologically last attraction that actually happened before this row.
          // Fallback: use previous day's hotel name (if any), otherwise city name.
          const prevDayHotelForItem5 = index > 0
            ? routeHotelMap.get(routes[index - 1].itinerary_route_ID)?.hotel_name ?? null
            : null;

          let fromName =
            prevDayHotelForItem5 ??
            location?.source_location ??
            route.location_name ??
            plan.arrival_location ??
            ""; // Safe fallback

          if (travelStartMins !== null) {
            let bestAttractionName: string | null = null;
            let bestAttractionEnd = -1;

            for (const candidate of routeHotspots) {
              const candidateType = Number((candidate as any).item_type ?? 0);
              if (candidateType !== 4 || Number(candidate.hotspot_ID ?? 0) <= 0) continue;

              const candidateEndText = this.formatTime((candidate as any).hotspot_end_time ?? null);
              if (!candidateEndText) continue;
              const candidateEndMins = this.timeToMinutes(candidateEndText);

              if (candidateEndMins <= travelStartMins && candidateEndMins >= bestAttractionEnd) {
                const candidateMaster = hotspotMap.get(candidate.hotspot_ID as number);
                if (candidateMaster?.hotspot_name?.trim()) {
                  bestAttractionName = candidateMaster.hotspot_name;
                  bestAttractionEnd = candidateEndMins;
                }
              }
            }

            if (bestAttractionName) {
              fromName = bestAttractionName;
            }
          }

          if (proofQuoteEnabled) {
            console.log('[ItemType5TravelToHotel][PROOF]', {
              quoteId,
              routeId: route.itinerary_route_ID,
              routeHotspotId: rh.route_hotspot_ID,
              hotspotOrder: (rh as any).hotspot_order,
              derivedFromName: fromName,
              derivedToName: toName,
              rowTimeStart: startTimeText,
              rowTimeEnd: endTimeText,
              rowDistance: travelDistance,
            });
          }

          if (!Number.isNaN(distanceNum)) {
            totalDistanceKm += distanceNum;
          }

          // Handle reversed times in DB  for item_type=5
          let travelToHotelTimeRange: string | null = null;
          if (startTimeText && endTimeText) {
            const startMins = this.timeToMinutes(startTimeText);
            const endMins = this.timeToMinutes(endTimeText);
            if (startMins > endMins) {
              travelToHotelTimeRange = `${endTimeText} - ${startTimeText}`;
              
              // FIX #3: Store the actual ARRIVAL time (which is after reversal)
              hotelArrivalTime = startTimeText;
              
              if (proofQuoteEnabled) {
                console.log('[Item5TimeReversal][PROOF]', {
                  quoteId,
                  routeId: route.itinerary_route_ID,
                  routeHotspotId: rh.route_hotspot_ID,
                  storageOrder: `${startTimeText} - ${endTimeText}`,
                  emitOrder: travelToHotelTimeRange,
                  fromLocation: fromName,
                  toLocation: toName,
                  storedHotelArrivalTime: hotelArrivalTime,
                });
              }
              
              console.log('[TravelMapping][PROOF] item_type=5 reversed time range normalised', {
                quoteId,
                routeHotspotId: rh.route_hotspot_ID,
                from: fromName,
                to: toName,
                storedRange: `${startTimeText} - ${endTimeText}`,
                emittedRange: travelToHotelTimeRange,
              });
            } else {
              travelToHotelTimeRange = `${startTimeText} - ${endTimeText}`;
              
              // FIX #3: Store the actual ARRIVAL time
              hotelArrivalTime = endTimeText;
            }
          }

          segments.push({
            type: "travel" as const,
            from: fromName,
            to: toName,
            timeRange: travelToHotelTimeRange,
            distance: travelDistance,
            duration: this.formatDuration(travelDuration),
            note: "This may vary due to traffic conditions",
            isConflict: (rh as any).is_conflict === 1,
            conflictReason: (rh as any).conflict_reason ?? null,
          });

          previousStopName = toName;
          continue;
        }

        if (itemType === 6) {
          // HOTEL CHECK-IN / RETURN segment
          const hotelInfo = routeHotelMap.get(route.itinerary_route_ID);
          const hotelName =
            hotelInfo?.hotel_name ??
            hotelInfo?.hotel_city ??
            location?.destination_location ??
            route.next_visiting_location ??
            "Hotel";
          const hotelAddress = hotelInfo?.hotel_address ?? "";

          // FIX #3: Use hotel arrival time (from travel-to-hotel) if available
          // Otherwise fallback to endTimeText from this checkin row, then startTimeText, then route end time
          const checkInTime =
            hotelArrivalTime ??
            endTimeText ??
            startTimeText ??
            this.formatTime(route.route_end_time as any) ??
            null;

          // [PROOF] Log checkin derivation
          if (proofQuoteEnabled) {
            console.log('[ItemType6CheckinEntry][PROOF]', {
              quoteId,
              routeId: route.itinerary_route_ID,
              routeHotspotId: rh.route_hotspot_ID,
              hotspotOrder: (rh as any).hotspot_order,
              hotspotId: rh.hotspot_ID,
              hotspotEndTimeRaw: (rh as any).hotspot_end_time,
              hotspotStartTimeRaw: (rh as any).hotspot_start_time,
              routeEndTime: route.route_end_time,
              formattedEndTime: endTimeText,
              formattedStartTime: startTimeText,
              formattedRouteEndTime: this.formatTime(route.route_end_time as any),
              usedHotelArrivalTime: !!hotelArrivalTime,
              hotelArrivalTime,
              selectedCheckInTime: checkInTime,
              segmentIndexBeforeCheckin: segments.length,
              previousStopNameAtThisPoint: previousStopName,
              hotelNameResolved: hotelName,
            });
          }

          segments.push({
            type: "checkin" as const,
            hotelName: hotelName,
            hotelAddress: hotelAddress,
            time: checkInTime,
          });

          previousStopName = hotelName;
          continue;
        }

        if (itemType === 7) {
          // DROP OFF - final travel to airport/departure point
          const toName = route.next_visiting_location ?? plan.departure_location ?? 'Departure Point';

          if (!Number.isNaN(distanceNum)) {
            totalDistanceKm += distanceNum;
          }

          // FIX #2: Validate that DROP_OFF doesn't exceed route end time
          const dropOffEndMins = endTimeText ? this.timeToMinutes(endTimeText) : 0;
          
          if (dropOffEndMins > routeEndMins) {
            // DROP_OFF row exceeds route end time - suppress it from normal segments
            if (proofQuoteEnabled) {
              console.log('[RouteEndValidation][DROPOFF_SUPPRESSED][PROOF]', {
                quoteId,
                routeId: route.itinerary_route_ID,
                routeHotspotId: rh.route_hotspot_ID,
                dropOffEndTime: endTimeText,
                dropOffEndMins,
                routeEndMins,
                exceedsByMins: dropOffEndMins - routeEndMins,
                reason: 'DROP_OFF exceeds route end time - segment suppressed',
              });
            }
            // Skip this segment - do not emit
            continue;
          }

          segments.push({
            type: 'travel' as const,
            from: previousStopName,
            to: toName,
            timeRange: this.orderedTimeRange(startTimeText, endTimeText),
            distance: travelDistance,
            duration: this.formatDuration(travelDuration),
            note: 'This may vary due to traffic conditions',
            isConflict: (rh as any).isConflict === true,
            conflictReason: (rh as any).conflictReason ?? null,
          });

          previousStopName = toName;
          continue;
        }
      }

      // RETURN block at the end of the day (only if no item_type 6 or 7 exists)
      const hasReturnOrDropOff = routeHotspots.some((rh) => {
        const itemType = Number((rh as any).item_type ?? 0);
        return itemType === 6 || itemType === 7;
      });

      const dayEndTimeText = this.formatTime(route.route_end_time as any);

      if (!hasReturnOrDropOff) {
        segments.push({
          type: 'return' as const,
          time: dayEndTimeText,
          note: null,
        });
      }

const storedIntercityDistanceNum =
  parseFloat(String((route as any).no_of_km ?? 0)) || 0;

const travelSegmentDistanceNum = segments.reduce((sum, segment: any) => {
  if (segment?.type !== 'travel') return sum;

  const distanceNum =
    parseFloat(String(segment?.distance ?? '').replace(/[^0-9.]/g, '')) || 0;

  return sum + distanceNum;
}, 0);

// Never show Inter-City as 0 when visible travel already exists
const intercityDistanceNum =
  storedIntercityDistanceNum > 0
    ? storedIntercityDistanceNum
    : travelSegmentDistanceNum;

const sightseeingDistanceNum = routeHotspots.reduce((sum, rh) => {
  const itemType = Number((rh as any).item_type ?? 0);

  // Ignore pure START row
  if (itemType === 1) return sum;

  const distanceStr = String((rh as any).hotspot_travelling_distance ?? '').trim();
  const distanceNum = distanceStr ? parseFloat(distanceStr) : 0;

  return sum + (Number.isNaN(distanceNum) ? 0 : distanceNum);
}, 0);

// Keep total realistic even when old DB has missing no_of_km
const totalDistanceNum = Math.max(
  intercityDistanceNum + sightseeingDistanceNum,
  travelSegmentDistanceNum,
);

const intercityDistance = this.formatKm(intercityDistanceNum);
const sightseeingDistance = this.formatKm(sightseeingDistanceNum);
const dayDistance = this.formatKm(totalDistanceNum);
//const dayDistance = this.formatKm(totalDistanceNum);

  console.log('[DISTANCE_DEBUG_DAY]', {
    planId,
    routeId: route.itinerary_route_ID,
    dayNumber: index + 1,
    dayDistance,
    intercityDistance,
    sightseeingDistance,
    // UI currently renders Travel badge from day.intercityDistance (fallback day.distance).
    uiDisplayedValue: intercityDistance,
  });

      const dayStartTimeText = this.formatTime(route.route_start_time as any);

      // Fetch via routes for this route
      const viaRoutes = await this.prisma.dvi_itinerary_via_route_details.findMany({
        where: {
          itinerary_plan_ID: planId,
          itinerary_route_ID: route.itinerary_route_ID,
          deleted: 0,
        },
        orderBy: { itinerary_via_route_ID: 'asc' },
      });

      const viaRoutesList = viaRoutes.map(vr => ({
        id: Number(vr.itinerary_via_location_ID),
        name: vr.itinerary_via_location_name,
      }));

      // FIX #1: Sort segments chronologically.
      // Strategy:
      //   1. Lift out all anchor CTAs (type=hotspot) along with the index of the segment they
      //      were inserted after (their preceding non-CTA neighbour index in the unsorted list).
      //   2. Sort only the non-CTA segments by time.
      //   3. Re-insert each CTA immediately after the sorted position of its preceding neighbour.
      // This guarantees: Travel → Attraction → CTA → Travel → Attraction → CTA → …

      // Step 1: extract CTAs and remember which non-CTA segment each followed.
      type CtaEntry = { cta: any; afterSegmentRef: any | null };
      const ctaEntries: CtaEntry[] = [];
      const nonCtaSegments: any[] = [];

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (seg?.type === 'hotspot' && seg?.anchorType === 'after_travel') {
          // Find the most recent non-CTA segment before this one.
          let afterRef: any | null = null;
          for (let j = i - 1; j >= 0; j--) {
            if (!(segments[j]?.type === 'hotspot' && segments[j]?.anchorType === 'after_travel')) {
              afterRef = segments[j];
              break;
            }
          }
          ctaEntries.push({ cta: seg, afterSegmentRef: afterRef });
        } else {
          nonCtaSegments.push(seg);
        }
      }

      // Step 2: sort the non-CTA segments by time.
      const typeOrder: Record<string, number> = {
        'start': 0,
        'travel': 1,
        'attraction': 2,
        'break': 3,
        'checkin': 4,
        'return': 5,
      };

      const getSegMinutes = (seg: any): number => {
        let timeStr: string | null = null;
        if (seg.type === 'start' || seg.type === 'travel' || seg.type === 'return' || seg.type === 'break') {
          timeStr = seg.timeRange ? String(seg.timeRange).split(' - ')[0] : null;
        } else if (seg.type === 'attraction') {
          timeStr = seg.visitTime ? String(seg.visitTime).split(' - ')[0] : null;
        } else if (seg.type === 'checkin') {
          timeStr = seg.time ? String(seg.time).split(' - ')[0] : null;
        }
        if (timeStr?.trim()) return this.timeToMinutes(timeStr.trim());
        return 1440;
      };

      nonCtaSegments.sort((a: any, b: any) => {
        const aStart = getSegMinutes(a);
        const bStart = getSegMinutes(b);
        const diff = aStart - bStart;
        if (diff !== 0) return diff;

        // Same-minute tie-break for dirty overlap data:
        // if travel starts from an attraction location at the exact same minute,
        // show the attraction first, then departure travel.
        if (a?.type === 'travel' && b?.type === 'attraction') {
          const aFrom = normalizeName(a?.from);
          const aTo = normalizeName(a?.to);
          const bName = normalizeName(b?.name);

          if (aFrom.length > 0 && bName.length > 0 && aFrom === bName) {
            return 1;
          }
          if (aTo.length > 0 && bName.length > 0 && aTo === bName) {
            return -1;
          }
        }

        if (a?.type === 'attraction' && b?.type === 'travel') {
          const bFrom = normalizeName(b?.from);
          const bTo = normalizeName(b?.to);
          const aName = normalizeName(a?.name);

          if (bFrom.length > 0 && aName.length > 0 && bFrom === aName) {
            return -1;
          }
          if (bTo.length > 0 && aName.length > 0 && bTo === aName) {
            return 1;
          }
        }

        return (typeOrder[a.type] ?? 99) - (typeOrder[b.type] ?? 99);
      });

      // Step 3: splice each CTA back in right after its reference segment.
      // Process in reverse anchorIndex order so earlier insertions don't shift later positions.
      const sortedCtaEntries = [...ctaEntries].reverse();
      for (const { cta, afterSegmentRef } of sortedCtaEntries) {
        let insertAt = nonCtaSegments.length; // default: append
        if (afterSegmentRef !== null) {
          const refIdx = nonCtaSegments.indexOf(afterSegmentRef);
          if (refIdx !== -1) {
            insertAt = refIdx + 1;
          }
        }
        nonCtaSegments.splice(insertAt, 0, cta);
      }

      // Replace segments in-place with the correctly ordered result.
      segments.length = 0;
      segments.push(...nonCtaSegments);

      // In hotel-first flows, place start before check-in
      // so the sequence reads: travel to hotel -> Start your Journey -> checkin.
      const getSegmentStartMinutes = (seg: any): number | null => {
        if (!seg) return null;

        if (seg.type === 'start' || seg.type === 'travel' || seg.type === 'return' || seg.type === 'break') {
          if (seg.timeRange) {
            const start = String(seg.timeRange).split(' - ')[0]?.trim();
            return start ? this.timeToMinutes(start) : null;
          }
          return null;
        }

        if (seg.type === 'attraction') {
          if (seg.visitTime) {
            const start = String(seg.visitTime).split(' - ')[0]?.trim();
            return start ? this.timeToMinutes(start) : null;
          }
          return null;
        }

        if (seg.type === 'checkin') {
          if (seg.time) {
            const start = String(seg.time).split(' - ')[0]?.trim();
            return start ? this.timeToMinutes(start) : null;
          }
          return null;
        }

        return null;
      };

      const startIndex = segments.findIndex((seg: any) => seg?.type === 'start');
      const checkinIndex = segments.findIndex((seg: any) => seg?.type === 'checkin');
      const routeHotelNameForDay = getRouteHotelName();
      const routeHotelNameNormalized = normalizeName(routeHotelNameForDay);

      const firstHotelDepartureTravel = segments.find((seg: any) => {
        if (seg?.type !== 'travel') return false;
        const fromNormalized = normalizeName(seg?.from);
        const toNormalized = normalizeName(seg?.to);

        return (
          routeHotelNameNormalized.length > 0 &&
          fromNormalized === routeHotelNameNormalized &&
          toNormalized !== routeHotelNameNormalized
        );
      });

      const checkinStartMins =
        checkinIndex >= 0 ? getSegmentStartMinutes(segments[checkinIndex]) : null;
      const firstHotelDepartureStartMins = getSegmentStartMinutes(firstHotelDepartureTravel);

      const isHotelFirstFlow =
        checkinIndex >= 0 &&
        !!firstHotelDepartureTravel &&
        checkinStartMins !== null &&
        firstHotelDepartureStartMins !== null &&
        checkinStartMins <= firstHotelDepartureStartMins;

      if (isHotelFirstFlow && startIndex >= 0 && startIndex < checkinIndex) {
        const [startSegment] = segments.splice(startIndex, 1);
        const refreshedCheckinIndex = segments.findIndex((seg: any) => seg?.type === 'checkin');

        if (refreshedCheckinIndex >= 0) {
          // Insert START before CHECKIN
          segments.splice(refreshedCheckinIndex, 0, startSegment);
        } else {
          segments.unshift(startSegment);
        }
      }

      // Ensure timeline never moves backward when source rows contain overlaps/reversed ranges.
      this.normalizeSegmentChronology(segments);

      if (proofQuoteEnabled) {
        console.log('[SegmentChronology][SORT_APPLIED][PROOF]', {
          quoteId,
          routeId: route.itinerary_route_ID,
          dayNumber: index + 1,
          totalSegments: segments.length,
          segmentOrder: segments.map((s: any) => {
            const timeStr = s.timeRange ? s.timeRange.split(' - ')[0] : 'NO-TIME';
            const label = s.type === 'travel' ? `${s.from}→${s.to}` : (s.name || s.hotelName || s.text || '');
            return `${s.type}(${timeStr})[${label}]`;
          }),
        });
      }

     days.push({
  id: route.itinerary_route_ID,
  dayNumber: index + 1,
  date: route.itinerary_route_date,
  locationId: Number(route.location_id || 0),
  departure:
    location?.source_location ??
    route.location_name ??
    plan.arrival_location ??
    '',
  arrival:
    location?.destination_location ??
    route.next_visiting_location ??
    plan.departure_location ??
    '',
  distance: dayDistance, // total distance
  intercityDistance,     // city-to-city only
  sightseeingDistance,   // local sightseeing only
  startTime: dayStartTimeText,
  endTime: dayEndTimeText,
  viaRoutes: viaRoutesList,
  segments,
});
    }

    const itineraryPreference = Number((plan as any).itinerary_preference || 0);
    const shouldIncludeVehicles = itineraryPreference === 2 || itineraryPreference === 3;

    // ------------------------------ VEHICLES ------------------------------
    // PHP displays vehicles directly from dvi_itinerary_plan_vendor_eligible_list
    // Each row in eligible list is already aggregated per vendor/branch/type/origin
    const eligibleRows = shouldIncludeVehicles
      ? await this.prisma.dvi_itinerary_plan_vendor_eligible_list.findMany({
          where: { itinerary_plan_id: planId, deleted: 0 },
          orderBy: { itinerary_plan_vendor_eligible_ID: 'asc' },
        })
      : [];

    const assignedEligibleRows = eligibleRows.filter(
      (e) => (e as any).itineary_plan_assigned_status === 1,
    );

    const totalAllowedKmFromAssigned = assignedEligibleRows.reduce(
      (sum, e) => sum + (parseFloat(String((e as any).total_allowed_kms || 0)) || 0),
      0,
    );
    const totalTravelledKmFromAssigned = assignedEligibleRows.reduce(
      (sum, e) => sum + (parseFloat(String((e as any).total_kms || 0)) || 0),
      0,
    );
    const totalExtraKmFromAssigned = assignedEligibleRows.reduce(
      (sum, e) => sum + (parseFloat(String((e as any).total_extra_kms || 0)) || 0),
      0,
    );

    let kmLimitWarning: string | undefined;
    if (totalExtraKmFromAssigned > 0) {
      kmLimitWarning = `Planner warning: assigned vehicles exceed allowed KM by ${totalExtraKmFromAssigned.toFixed(2)} km (extra KM charges may apply).`;
    } else if (
      totalAllowedKmFromAssigned > 0 &&
      totalTravelledKmFromAssigned > totalAllowedKmFromAssigned
    ) {
      const overflow = totalTravelledKmFromAssigned - totalAllowedKmFromAssigned;
      kmLimitWarning = `Planner warning: travelled KM exceed allowed KM by ${overflow.toFixed(2)} km.`;
    }

    this.logBookingRule({
      rule: 'KM_LIMIT_WARNING',
      quoteId,
      planId,
      emitted: Boolean(kmLimitWarning),
      totalAllowedKm: Number(totalAllowedKmFromAssigned.toFixed(2)),
      totalTravelledKm: Number(totalTravelledKmFromAssigned.toFixed(2)),
      totalExtraKm: Number(totalExtraKmFromAssigned.toFixed(2)),
    });

    // Fetch all vehicle type names to map vehicleTypeId -> vehicleTypeName
    const vehicleTypeIds = Array.from(
      new Set(eligibleRows.map(r => (r as any).vehicle_type_id).filter(Boolean))
    );
    const vehicleTypes = vehicleTypeIds.length > 0
      ? await (this.prisma as any).dvi_vehicle_type.findMany({
          where: { 
            vehicle_type_id: { in: vehicleTypeIds },
            deleted: 0 
          },
          select: { vehicle_type_id: true, vehicle_type_title: true }
        })
      : [];
    
    const vehicleTypeNameMap = new Map<number, string>(
      vehicleTypes.map((vt: any) => [vt.vehicle_type_id, vt.vehicle_type_title || 'Unknown Vehicle Type'])
    );

    // Fetch vehicle details for ALL eligibles so every vendor shows day-wise breakdown on expand
    const allEligibleIds = eligibleRows
  .map((e) => Number((e as any).itinerary_plan_vendor_eligible_ID))
  .filter((id) => id > 0);

   const vehicleDetailsRows = allEligibleIds.length
  ? await this.prisma.$queryRawUnsafe(`
      SELECT 
        itinerary_plan_vendor_vehicle_details_ID,
        itinerary_plan_vendor_eligible_ID,
        itinerary_plan_id,
        itinerary_route_id,
        itinerary_route_date,
        vehicle_type_id,
        vehicle_qty,
        vendor_id,
        vendor_vehicle_type_id,
        vehicle_id,
        vendor_branch_id,
        time_limit_id,
        kms_limit_id,
        travel_type,
        itinerary_route_location_from,
        itinerary_route_location_to,
        total_running_km,
        CAST(total_running_time AS CHAR) as total_running_time,
        total_siteseeing_km,
        CAST(total_siteseeing_time AS CHAR) as total_siteseeing_time,
        total_pickup_km,
        CAST(total_pickup_duration AS CHAR) as total_pickup_duration,
        total_drop_km,
        CAST(total_drop_duration AS CHAR) as total_drop_duration,
        total_extra_km,
        extra_km_rate,
        total_extra_km_charges,
        total_travelled_km,
        total_travelled_time,
        vehicle_rental_charges,
        vehicle_toll_charges,
        vehicle_parking_charges,
        vehicle_driver_charges,
        vehicle_permit_charges,
        before_6_am_extra_time,
        after_8_pm_extra_time,
        before_6_am_charges_for_driver,
        before_6_am_charges_for_vehicle,
        after_8_pm_charges_for_driver,
        after_8_pm_charges_for_vehicle,
        total_vehicle_amount,
        createdby,
        createdon,
        updatedon,
        status,
        deleted
      FROM dvi_itinerary_plan_vendor_vehicle_details
      WHERE itinerary_plan_id = ${planId}
        AND deleted = 0
        AND itinerary_plan_vendor_eligible_ID IN (${allEligibleIds.join(",")})
      ORDER BY itinerary_route_date ASC
    `) as any[]
  : [];

    // Group vehicle details by eligible ID to sum KMs
    const vehicleDetailsByEligible = new Map<number, any[]>();
    for (const vd of vehicleDetailsRows) {
      const eligibleId = (vd as any).itinerary_plan_vendor_eligible_ID;
      if (!vehicleDetailsByEligible.has(eligibleId)) {
        vehicleDetailsByEligible.set(eligibleId, []);
      }
      vehicleDetailsByEligible.get(eligibleId)!.push(vd);
    }

    const routeIds = Array.from(
      new Set(
        vehicleDetailsRows
          .map((vd: any) => Number(vd.itinerary_route_id || 0))
          .filter((id: number) => id > 0),
      ),
    );

    const routeTimeRows = routeIds.length
      ? await this.prisma.dvi_itinerary_route_details.findMany({
          where: { itinerary_route_ID: { in: routeIds } },
          select: {
            itinerary_route_ID: true,
            route_start_time: true,
            route_end_time: true,
          },
        })
      : [];
    const routeTimeMap = new Map<number, { start: any; end: any }>(
      routeTimeRows.map((r: any) => [
        Number(r.itinerary_route_ID || 0),
        { start: r.route_start_time, end: r.route_end_time },
      ]),
    );

    const vehicleIds = Array.from(
      new Set(
        vehicleDetailsRows
          .map((vd: any) => Number(vd.vehicle_id || 0))
          .filter((id: number) => id > 0),
      ),
    );

    const vehicleExtraRows = vehicleIds.length
      ? await this.prisma.dvi_vehicle.findMany({
          where: { vehicle_id: { in: vehicleIds }, deleted: 0, status: 1 },
          select: { vehicle_id: true, extra_hour_charge: true },
        })
      : [];
    const vehicleExtraHourRateMap = new Map<number, number>(
      vehicleExtraRows.map((v: any) => [Number(v.vehicle_id || 0), Number(v.extra_hour_charge || 0)]),
    );

    // 3) Load vendor branches (for names & origin location)
    const branchIds = Array.from(
      new Set(
        eligibleRows
          .map((e) => (e as any).vendor_branch_id)
          .filter((id: number) => typeof id === 'number' && id > 0),
      ),
    );

    const branches = branchIds.length
      ? await this.prisma.dvi_vendor_branches.findMany({
          where: { vendor_branch_id: { in: branchIds }, deleted: 0 },
        })
      : [];

    const branchMap = new Map(
      branches.map((b) => [b.vendor_branch_id, b]),
    );

    const slabKeySet = new Set(
      eligibleRows
        .map((e) => `${Number((e as any).vendor_id || 0)}_${Number((e as any).vendor_vehicle_type_id || 0)}`)
        .filter((k) => !k.startsWith('0_0')),
    );
    const slabWhereClauses = Array.from(slabKeySet)
      .map((k) => {
        const [vendorIdStr, vvtStr] = k.split('_');
        return `(vendor_id = ${Number(vendorIdStr)} AND vendor_vehicle_type_id = ${Number(vvtStr)})`;
      })
      .join(' OR ');

    const slabRows: Array<{
      vendor_id: number;
      vendor_vehicle_type_id: number;
      time_limit_id: number;
      time_limit_title: string | null;
      hours_limit: number;
      km_limit: number;
    }> = slabWhereClauses
      ? await this.prisma.$queryRawUnsafe(`
          SELECT vendor_id, vendor_vehicle_type_id, time_limit_id, time_limit_title, hours_limit, km_limit
          FROM dvi_time_limit
          WHERE status = 1
            AND deleted = 0
            AND (${slabWhereClauses})
          ORDER BY time_limit_id ASC
        `)
      : [];

    const slabMap = new Map<string, Array<{
      timeLimitId: number;
      title: string;
      hoursLimit: number;
      kmLimit: number;
    }>>();
    const slabHoursById = new Map<number, number>();
    for (const slab of slabRows) {
      const slabIdNum = Number(slab.time_limit_id || 0);
      const hoursLimitNum = Number(slab.hours_limit || 0);
      if (slabIdNum > 0 && !slabHoursById.has(slabIdNum)) {
        slabHoursById.set(slabIdNum, hoursLimitNum);
      }
      const key = `${Number(slab.vendor_id || 0)}_${Number(slab.vendor_vehicle_type_id || 0)}`;
      if (!slabMap.has(key)) slabMap.set(key, []);
      slabMap.get(key)!.push({
        timeLimitId: slabIdNum,
        title: String(slab.time_limit_title || '').trim() || `${Number(slab.hours_limit || 0)} HRS ${Number(slab.km_limit || 0)} KMS`,
        hoursLimit: hoursLimitNum,
        kmLimit: Number(slab.km_limit || 0),
      });
    }

    const parseTimeToSeconds = (value: any): number | null => {
      if (!value) return null;
      if (value instanceof Date) {
        return value.getUTCHours() * 3600 + value.getUTCMinutes() * 60 + value.getUTCSeconds();
      }
      const text = String(value).trim();
      if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(text)) return null;
      const parts = text.split(':').map((x) => Number(x || 0));
      return (Number(parts[0] || 0) * 3600) + (Number(parts[1] || 0) * 60) + Number(parts[2] || 0);
    };

    const getExtraHourBreakupForRow = (vd: any): { count: number; rate: number; charge: number } => {
      const routeInfo = routeTimeMap.get(Number(vd.itinerary_route_id || 0));
      if (!routeInfo) return { count: 0, rate: 0, charge: 0 };

      const startSec = parseTimeToSeconds(routeInfo.start);
      const endSec = parseTimeToSeconds(routeInfo.end);
      if (startSec === null || endSec === null) return { count: 0, rate: 0, charge: 0 };

      let durationSec = endSec - startSec;
      if (durationSec < 0) durationSec += 24 * 3600;
      const serviceHours = durationSec / 3600;

      const slabHours = Number(slabHoursById.get(Number(vd.time_limit_id || 0)) || 0);
      const rate = Number(vehicleExtraHourRateMap.get(Number(vd.vehicle_id || 0)) || 0);

      if (slabHours <= 0 || rate <= 0 || serviceHours <= slabHours) return { count: 0, rate, charge: 0 };
      const count = Math.ceil(serviceHours - slabHours);
      return { count, rate, charge: count * rate };
    };

    // Build vehicles array directly from eligible list (like PHP does)
    const vehicles: ItineraryVehicleRowDto[] = eligibleRows.map((eligible) => {
      const branchId = (eligible as any).vendor_branch_id ?? 0;
      const branch = branchMap.get(branchId) || null;
      const vehicleTypeId = (eligible as any).vehicle_type_id ?? 0;
      const origin = ((eligible as any).vehicle_orign ?? '').toString().trim();
      
      const qty = (eligible as any).total_vehicle_qty ?? 0;
      const totalAmount = (eligible as any).vehicle_grand_total ?? 0;

      // Get all charge breakdowns
      let rentalCharges = Number((eligible as any).total_rental_charges ?? 0);
      const tollCharges = (eligible as any).total_toll_charges ?? 0;
      const parkingCharges = (eligible as any).total_parking_charges ?? 0;
      const driverCharges = (eligible as any).total_driver_charges ?? 0;
      const permitCharges = (eligible as any).total_permit_charges ?? 0;
      const before6amDriver = (eligible as any).total_before_6_am_charges_for_driver ?? 0;
      const before6amVendor = (eligible as any).total_before_6_am_charges_for_vehicle ?? 0;
      const after8pmDriver = (eligible as any).total_after_8_pm_charges_for_driver ?? 0;
      const after8pmVendor = (eligible as any).total_after_8_pm_charges_for_vehicle ?? 0;
      let extraHourCharge = 0;

      // Calculate aggregated KMs from day-wise vehicle details
      const eligibleId = eligible.itinerary_plan_vendor_eligible_ID;
      const dayWiseDetails = vehicleDetailsByEligible.get(eligibleId) || [];
      const selectedTimeLimitId = dayWiseDetails.length
        ? Number((dayWiseDetails[0] as any).time_limit_id || 0)
        : 0;
      const slabKey = `${Number((eligible as any).vendor_id || 0)}_${Number((eligible as any).vendor_vehicle_type_id || 0)}`;
      const availableSlabs = slabMap.get(slabKey) || [];
      
     let totalRunningKm = 0;
let totalSiteseeingKm = 0;
let totalTravelledKm = 0;

for (const vd of dayWiseDetails) {
  const runningKm = parseFloat(String((vd as any).total_running_km || 0)) || 0;
  const sightseeingKm = parseFloat(String((vd as any).total_siteseeing_km || 0)) || 0;
  const dbTotalKm = parseFloat(String((vd as any).total_travelled_km || 0)) || 0;

  const expectedTotalKm = Number((runningKm + sightseeingKm).toFixed(2));
  const safeTotalKm =
    Math.abs(dbTotalKm - expectedTotalKm) <= 0.01
      ? dbTotalKm
      : expectedTotalKm;

  totalRunningKm += runningKm;
  totalSiteseeingKm += sightseeingKm;
  totalTravelledKm += safeTotalKm;
}

      let breakdown: VehicleCostBreakdownItemDto[] | undefined;

      // Simple PHP-like package label: "Outstation - 250 KM"
      const totalKms = (eligible as any).total_kms ?? '';
      const packageLabel = totalKms ? `Outstation - ${totalKms}KM` : undefined;

      // Build day-wise pricing breakdown from vehicle details
      // Build day-wise pricing breakdown from vehicle details
      // KMS per day: running_km, siteseeing_km, and total_travelled_km (running + siteseeing)
      const dayWisePricing: VehicleDayWisePricingDto[] = [];
      const dayWiseMap = new Map<string, any>();
      
      for (const vd of dayWiseDetails) {
        const dateStr = (vd as any).itinerary_route_date?.toISOString?.()?.split('T')[0] || '';
        if (!dateStr) continue;
        
        if (!dayWiseMap.has(dateStr)) {
          dayWiseMap.set(dateStr, {
            date: dateStr,
            locations: [],
            rental: 0,
            toll: 0,
            parking: 0,
            driver: 0,
            permit: 0,
            extraHourCount: 0,
            extraHourRate: 0,
            extraHour: 0,
            extraKm: 0,
            pickupKms: 0,
            dropKms: 0,
            travelKms: 0, // running_km per day
            sightseeingKms: 0, // siteseeing_km per day
            totalKms: 0 // total_travelled_km per day
          });
        }
        
        const dayData = dayWiseMap.get(dateStr);
        dayData.locations.push({
          from: (vd as any).itinerary_route_location_from || '',
          to: (vd as any).itinerary_route_location_to || ''
        });
        const rawRental = parseFloat(String((vd as any).vehicle_rental_charges || 0)) || 0;
        const extraHourBreakup = getExtraHourBreakupForRow(vd);
        const dayExtraHourCharge = extraHourBreakup.charge;
        const baseRental = Math.max(0, rawRental - dayExtraHourCharge);
        dayData.rental += baseRental;
        dayData.extraHourCount += extraHourBreakup.count;
        dayData.extraHourRate = extraHourBreakup.rate || dayData.extraHourRate;
        dayData.extraHour += dayExtraHourCharge;
        dayData.extraKm += parseFloat(String((vd as any).total_extra_km_charges || 0)) || 0;
        dayData.toll += parseFloat((vd as any).vehicle_toll_charges || 0);
        dayData.parking += parseFloat((vd as any).vehicle_parking_charges || 0);
        dayData.driver += parseFloat((vd as any).vehicle_driver_charges || 0);
        dayData.permit += parseFloat((vd as any).vehicle_permit_charges || 0);
        dayData.pickupKms += parseFloat(String((vd as any).total_pickup_km || 0)) || 0;
        dayData.dropKms += parseFloat(String((vd as any).total_drop_km || 0)) || 0;
        // Track all three KMS values per day
       const runningKm = parseFloat(String((vd as any).total_running_km || 0)) || 0;
const sightseeingKm = parseFloat(String((vd as any).total_siteseeing_km || 0)) || 0;
const dbTotalKm = parseFloat(String((vd as any).total_travelled_km || 0)) || 0;

const expectedTotalKm = Number((runningKm + sightseeingKm).toFixed(2));
const safeTotalKm =
  Math.abs(dbTotalKm - expectedTotalKm) <= 0.01
    ? dbTotalKm
    : expectedTotalKm;

dayData.travelKms += runningKm;
dayData.sightseeingKms += sightseeingKm;
dayData.totalKms += safeTotalKm;
      }

      // Convert map to array and format with day labels
      let dayCounter = 1;
      for (const [dateStr, dayData] of dayWiseMap.entries()) {
        const date = new Date(dateStr);
        const dayName = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
        const locations: string[] = dayData.locations.map((l: any) => l.from || '').concat(dayData.locations.map((l: any) => l.to || '')).filter((l: string) => l);
        const uniqueLocations: string[] = Array.from(new Set(locations));
        const route: string = uniqueLocations.length > 1 ? `${uniqueLocations[0]} → ${uniqueLocations[uniqueLocations.length - 1]}` : (uniqueLocations[0] || '');
        
        dayWisePricing.push({
          date: dateStr,
          dayLabel: `Day ${dayCounter} | ${dayName}`,
          route,
          pickupKms: dayData.pickupKms,
          travelKms: dayData.travelKms,
          sightseeingKms: dayData.sightseeingKms,
          totalKms: dayData.totalKms,
          rentalCharges: dayData.rental,
          tollCharges: dayData.toll,
          parkingCharges: dayData.parking,
          driverCharges: dayData.driver,
          permitCharges: dayData.permit,
          extraHourCount: dayData.extraHourCount,
          extraHourRate: dayData.extraHourRate,
          extraHourCharges: dayData.extraHour,
          extraKmCharges: dayData.extraKm,
          dropKms: dayData.dropKms,
          totalCharges:
            dayData.rental +
            dayData.extraHour +
            dayData.extraKm +
            dayData.toll +
            dayData.parking +
            dayData.driver +
            dayData.permit
        });
        dayCounter++;
      }

      const dayWiseRentalTotal = dayWisePricing.reduce((s, d) => s + Number(d.rentalCharges || 0), 0);
      const dayWiseExtraHourCountTotal = dayWisePricing.reduce((s, d) => s + Number(d.extraHourCount || 0), 0);
      const dayWiseExtraHourRate = Number(dayWisePricing.find((d) => Number(d.extraHourRate || 0) > 0)?.extraHourRate || 0);
      const dayWiseExtraHourTotal = dayWisePricing.reduce((s, d) => s + Number(d.extraHourCharges || 0), 0);
      const dayWiseExtraKmChargeTotal = dayWisePricing.reduce((s, d) => s + Number(d.extraKmCharges || 0), 0);
      extraHourCharge = dayWiseExtraHourTotal;
      if (dayWiseRentalTotal > 0) {
        rentalCharges = dayWiseRentalTotal;
      }

      // Build a breakdown list only for >0 amounts (for UI card)
      const tmp: VehicleCostBreakdownItemDto[] = [];
      const pushItem = (label: string, amount: number) => {
        if (amount > 0) {
          tmp.push({ label, amount });
        }
      };

      pushItem('Rental Charges', rentalCharges);
      pushItem('Extra Hour Charges', extraHourCharge);
      pushItem('Extra KM Charges', dayWiseExtraKmChargeTotal);
      pushItem('Toll Charges', tollCharges);
      pushItem('Parking Charges', parkingCharges);
      pushItem('Driver Charges', driverCharges);
      pushItem('Permit Charges', permitCharges);
      pushItem('Before 6 AM (Driver)', before6amDriver);
      pushItem('Before 6 AM (Vehicle)', before6amVendor);
      pushItem('After 8 PM (Driver)', after8pmDriver);
      pushItem('After 8 PM (Vehicle)', after8pmVendor);

      breakdown = tmp.length ? tmp : undefined;

      // Aggregate pickup/drop KMs from day-wise vehicle details
      const totalPickupKm = dayWiseDetails.reduce((s: number, vd: any) => s + (parseFloat(String(vd.total_pickup_km || 0)) || 0), 0);
      const totalDropKm = dayWiseDetails.reduce((s: number, vd: any) => s + (parseFloat(String(vd.total_drop_km || 0)) || 0), 0);
      const firstDayVd = dayWiseDetails[0];
      const lastDayVd = dayWiseDetails[dayWiseDetails.length - 1];
      const totalPickupDuration = (firstDayVd as any)?.total_pickup_duration
        ? formatHmsDuration(String((firstDayVd as any).total_pickup_duration))
        : '0 Hours 0 Min';
      const totalDropDuration = (lastDayVd as any)?.total_drop_duration
        ? formatHmsDuration(String((lastDayVd as any).total_drop_duration))
        : '0 Hours 0 Min';

      // Summary fields from eligible_list
      const noOfDays = dayWiseDetails.length || 1;
      const eligAny = eligible as any;
      const totalUsedKm = parseFloat(String(eligAny.total_kms || 0)) || 0;
      const totalAllowedKm = parseFloat(String(eligAny.total_allowed_kms || 0)) || 0;
      const extraKms =
        parseFloat(String(eligAny.total_extra_kms || 0)) ||
        parseFloat(String(eligAny.total_extra_local_kms || 0)) ||
        0;
      const extraKmRate = parseFloat(String(eligAny.extra_km_rate || 0)) || 0;
      const extraKmCharge =
        dayWiseExtraKmChargeTotal ||
        parseFloat(String(eligAny.total_extra_kms_charge || 0)) ||
        parseFloat(String(eligAny.total_extra_local_kms_charge || 0)) ||
        0;
      const totalCostOfVehicle = rentalCharges + tollCharges + parkingCharges + driverCharges + permitCharges
        + Number(eligAny.total_before_6_am_charges_for_driver ?? 0)
        + Number(eligAny.total_before_6_am_charges_for_vehicle ?? 0)
        + Number(eligAny.total_after_8_pm_charges_for_driver ?? 0)
        + Number(eligAny.total_after_8_pm_charges_for_vehicle ?? 0)
        + extraHourCharge;
      const subtotal = totalCostOfVehicle + extraKmCharge;
      const vehicleGstPercentage = parseFloat(String(eligAny.vehicle_gst_percentage || 0)) || 0;
      const vehicleGstAmount = parseFloat(String(eligAny.vehicle_gst_amount || 0)) || 0;
      const vendorMarginPercentage = parseFloat(String(eligAny.vendor_margin_percentage || 0)) || 0;
      const vendorMarginAmount = parseFloat(String(eligAny.vendor_margin_amount || 0)) || 0;
      const vendorMarginGstPercentage = parseFloat(String(eligAny.vendor_margin_gst_percentage || 0)) || 0;
      const vendorMarginGstAmount = parseFloat(String(eligAny.vendor_margin_gst_amount || 0)) || 0;
      const grandTotal = parseFloat(String(eligAny.vehicle_grand_total || 0)) || 0;

      return {
        vendorName: branch?.vendor_branch_name ?? null,
        branchName: branch?.vendor_branch_name ?? null,
        vehicleOrigin: origin || branch?.vendor_branch_location || null,
        totalQty: String(qty),
        totalAmount: totalAmount.toFixed(2),

        // IDs needed for vendor selection
        vendorEligibleId: eligible.itinerary_plan_vendor_eligible_ID,
        vehicleTypeId: vehicleTypeId,
        vehicleTypeName: vehicleTypeNameMap.get(vehicleTypeId) || 'Unknown Vehicle Type',
        isAssigned: (eligible as any).itineary_plan_assigned_status === 1,
        selectedTimeLimitId,
        availableSlabs,

        rentalCharges,
        tollCharges,
        parkingCharges,
        driverCharges,
        permitCharges,
        dayWisePricing,
        before6amDriver,
        before6amVendor,
        after8pmDriver,
        after8pmVendor,
        breakdown,
        packageLabel,

        // PHP summary panel fields
        totalDays: noOfDays,
        totalCostOfVehicle,
        totalPickupKm,
        totalPickupDuration,
        totalDropKm,
        totalDropDuration,
        totalUsedKm,
        totalAllowedKm,
        extraKms,
        extraKmRate,
        extraKmCharge,
        extraHourCount: dayWiseExtraHourCountTotal,
        extraHourRate: dayWiseExtraHourRate,
        extraHourCharge,
        subtotal,
        vehicleGstPercentage,
        vehicleGstAmount,
        vendorMarginPercentage,
        vendorMarginAmount,
        vendorMarginGstPercentage,
        vendorMarginGstAmount,
        grandTotal,

        // KM columns for the UI card
        col1Distance: totalRunningKm > 0 ? `${totalRunningKm.toFixed(2)} KM` : '0.00 KM',
        col2Distance: totalSiteseeingKm > 0 ? `${totalSiteseeingKm.toFixed(2)} KM` : '0.00 KM',
        col3Distance: totalTravelledKm > 0 ? `${totalTravelledKm.toFixed(2)} KM` : '0.00 KM',
        col1Duration: '0 Min',
        col2Duration: '0 Min',
        col3Duration: '0 Min',
      };
    });

    // 5) Total vehicle amount for footer: sum only ASSIGNED vehicles (itineary_plan_assigned_status = 1)
    // This matches PHP behavior which filters by assigned status
    const totalVehicleAmountFromEligible = eligibleRows.reduce(
      (sum, e) => {
        const isAssigned = (e as any).itineary_plan_assigned_status === 1;
        return sum + (isAssigned ? ((e as any).vehicle_grand_total ?? 0) : 0);
      },
      0,
    );

    const totalVehicleAmount =
      totalVehicleAmountFromEligible > 0
        ? totalVehicleAmountFromEligible
        : vehicles.reduce(
            (sum: number, v: any) => sum + (v.total_vehicle_amount ?? 0),
            0,
          );

    // ------------------------------ COST BREAKDOWN (calculate from database) ------------------------------
    
    // 1. Calculate Hotel Costs with detailed breakdown
    // Filter by group_type if provided (for hotel recommendation tabs)
    const hotelWhere: any = { itinerary_plan_id: planId, deleted: 0 };
    if (groupType !== undefined) {
      hotelWhere.group_type = groupType;
    }
    const hotelRows = await this.prisma.dvi_itinerary_plan_hotel_details.findMany({
      where: hotelWhere,
    });

    // Exclude marker/placeholder rows from cost math.
    let costHotelRows = hotelRows.filter(
      (h) => Number((h as any).hotel_required || 0) !== 2,
    );

    // Total room cost (excluding meals initially)
    let totalRoomCost = 0;
    let totalAmenitiesCost = 0;
    let extraBedCost = 0;
    let childWithBedCost = 0;
    let childWithoutBedCost = 0;
    let totalMealCost = 0;

    costHotelRows.forEach(h => {
      const detailedRoomCost =
        Number(h.total_room_cost || 0) +
        Number(h.hotel_margin_rate || 0) +
        Number(h.total_room_gst_amount || 0);
      const fallbackRoomCost = Number(h.total_hotel_cost || 0);

      // TBO/cache rows often populate only total_hotel_cost; fallback keeps room totals non-zero.
      totalRoomCost += detailedRoomCost > 0 ? detailedRoomCost : fallbackRoomCost;
      totalAmenitiesCost += Number(h.total_amenities_cost || 0);
      extraBedCost += Number(h.total_extra_bed_cost || 0);
      childWithBedCost += Number(h.total_childwith_bed_cost || 0);
      childWithoutBedCost += Number(h.total_childwithout_bed_cost || 0);
      totalMealCost += Number(h.total_hotel_meal_plan_cost || 0);
    });

    // For selected recommendation tabs, derive room total from live group-specific hotel details
    // and override stale duplicated DB costs when they differ.
    const getLiveSelectedGroupRoomCost = async (): Promise<number> => {
      if (groupType === undefined) return 0;

      try {
        // Use the same default hotel_details dataset as frontend tabs
        // (page=1, pageSize=20, all groups), then filter by selected group.
        const hotelDetailsFallback = await this.hotelDetailsTboService.getHotelDetailsByQuoteIdFromTbo(
          quoteId,
          1,
          20,
        );

        const fallbackRows = (hotelDetailsFallback.hotels || []).filter((h: any) => {
          const rowGroupType = Number(h.groupType ?? 0);
          return (
            rowGroupType === Number(groupType) &&
            String(h.hotelName || '') !== 'No Hotels Available'
          );
        });

        const cheapestByStay = new Map<string, number>();
        fallbackRows.forEach((h: any) => {
          const routeId = Number(h.itineraryRouteId || 0);
          const stayDate = String(h.date || '').trim();
          if (!routeId || !stayDate) return;

          const key = `${routeId}::${stayDate}`;
          const amount = Number(h.totalHotelCost || 0) + Number(h.totalHotelTaxAmount || 0);
          if (!Number.isFinite(amount) || amount <= 0) return;

          const existing = cheapestByStay.get(key);
          if (existing === undefined || amount < existing) {
            cheapestByStay.set(key, amount);
          }
        });

        const baseFallbackRoomCost = Array.from(cheapestByStay.values()).reduce(
          (sum, v) => sum + Number(v || 0),
          0,
        );
        const roomCountMultiplier = Math.max(Number(plan.preferred_room_count ?? 1), 1);
        return baseFallbackRoomCost * roomCountMultiplier;
      } catch {
        return 0;
      }
    };

    const liveSelectedGroupRoomCost = await getLiveSelectedGroupRoomCost();
    const shouldUseLiveSelectedGroupCost =
      liveSelectedGroupRoomCost > 0 &&
      (totalRoomCost <= 0 || Math.abs(liveSelectedGroupRoomCost - totalRoomCost) > 0.01);

    if (shouldUseLiveSelectedGroupCost) {
      totalRoomCost = liveSelectedGroupRoomCost;
      totalAmenitiesCost = 0;
      extraBedCost = 0;
      childWithBedCost = 0;
      childWithoutBedCost = 0;
      totalMealCost = 0;
    }

    // Calculate per-person room cost (PHP logic)
    const totalAdults = plan.total_adult || 0;
    const totalChildren = plan.total_children || 0;
    const totalExtraBed = plan.total_extra_bed || 0;
    const hotelPaxCount = totalAdults - totalExtraBed;
    
    const paxMealCost = (totalAdults + totalChildren) > 0 
      ? totalMealCost / (totalAdults + totalChildren)
      : 0;
    
    const totalRoomCostUpdated = totalRoomCost + (hotelPaxCount * paxMealCost);
    const roomCostPerPerson = hotelPaxCount > 0 
      ? totalRoomCostUpdated / hotelPaxCount
      : 0;

    // Update costs with meal portions
    const updatedExtraBedCost = extraBedCost + (paxMealCost * totalExtraBed);
    const updatedChildWithBedCost = childWithBedCost + (paxMealCost * (plan.total_child_with_bed || 0));
    const updatedChildWithoutBedCost = childWithoutBedCost + (paxMealCost * (plan.total_child_without_bed || 0));

    const totalHotelAmount = totalRoomCostUpdated + totalAmenitiesCost + updatedExtraBedCost + updatedChildWithBedCost + updatedChildWithoutBedCost;

    // 2. Vehicle costs already calculated
    const totalVehicleCost = totalVehicleAmount;
    const totalVehicleQty = eligibleRows.reduce((sum, e) => {
      const isAssigned = (e as any).itineary_plan_assigned_status === 1;
      return sum + (isAssigned ? Number((e as any).total_vehicle_qty || 0) : 0);
    }, 0);

    // 3. Calculate Guide, Hotspot, and Activity costs
    // For now set to 0, can be calculated from route activities/guides if needed
    const [guideAgg, hotspotAgg, activityAgg] = await Promise.all([
      this.prisma.dvi_itinerary_route_guide_details.aggregate({
        where: { itinerary_plan_ID: planId, deleted: 0, status: 1 },
        _sum: { guide_cost: true },
      }),
      this.prisma.dvi_itinerary_route_hotspot_details.aggregate({
        where: {
          itinerary_plan_ID: planId,
          item_type: 4,
          deleted: 0,
          status: 1,
        },
        _sum: { hotspot_amout: true },
      }),
      this.prisma.dvi_itinerary_route_activity_details.aggregate({
        where: { itinerary_plan_ID: planId, deleted: 0, status: 1 },
        _sum: { activity_amout: true },
      }),
    ]);

    const totalGuideCost = Number(guideAgg._sum.guide_cost || 0);
    const totalHotspotCost = Number(hotspotAgg._sum.hotspot_amout || 0);
    const totalActivityCost = Number(activityAgg._sum.activity_amout || 0);

    this.logBookingRule({
      rule: 'GUIDE_AGGREGATION',
      quoteId,
      planId,
      totalGuideCost,
      totalHotspotCost,
      totalActivityCost,
    });

    // 4. Calculate additional margin (10% for trips <= configured day limit)
    const itineraryNoDays = plan.no_of_days || 0;
    const additionalMarginPercentage = 10; // Could come from global settings
    const additionalMarginDayLimit = 3; // Could come from global settings
    
    const shouldIncludeHotels = itineraryPreference === 1 || itineraryPreference === 3;
    const effectiveHotelAmount = shouldIncludeHotels ? totalHotelAmount : 0;

    const subtotal = effectiveHotelAmount + totalVehicleCost;
    const additionalMargin = itineraryNoDays <= additionalMarginDayLimit 
      ? (subtotal * additionalMarginPercentage) / 100
      : 0;

    // 4. Calculate total amount before discounts
    const totalAmount = subtotal + additionalMargin;

    // 5. Get coupon discount and agent margin from plan
    const couponDiscount = 0; // Not currently stored in plan table
    const agentMargin = Number(plan.agent_margin || 0);

    // 6. Calculate round off
    const netBeforeRoundOff = totalAmount - couponDiscount + agentMargin;
    const roundedNet = Math.round(netBeforeRoundOff);
    const totalRoundOff = roundedNet - netBeforeRoundOff;

    // 7. Final net payable
    const netPayable = roundedNet;

    const costBreakdown: CostBreakdownDto = {
      // Hotel costs
      totalRoomCost: shouldIncludeHotels && totalRoomCostUpdated > 0 ? totalRoomCostUpdated : undefined,
      roomCostPerPerson: shouldIncludeHotels && roomCostPerPerson > 0 ? roomCostPerPerson : undefined,
      hotelPaxCount: shouldIncludeHotels && hotelPaxCount > 0 ? hotelPaxCount : undefined,
      totalAmenitiesCost: shouldIncludeHotels && totalAmenitiesCost > 0 ? totalAmenitiesCost : undefined,
      extraBedCost: shouldIncludeHotels && updatedExtraBedCost > 0 ? updatedExtraBedCost : undefined,
      childWithBedCost: shouldIncludeHotels && updatedChildWithBedCost > 0 ? updatedChildWithBedCost : undefined,
      childWithoutBedCost: shouldIncludeHotels && updatedChildWithoutBedCost > 0 ? updatedChildWithoutBedCost : undefined,
      totalHotelAmount: shouldIncludeHotels && effectiveHotelAmount > 0 ? effectiveHotelAmount : undefined,
      
      // Vehicle costs
      totalVehicleCost: shouldIncludeVehicles ? totalVehicleCost : 0,
      totalVehicleAmount: shouldIncludeVehicles ? totalVehicleCost : 0,
      totalVehicleQty:
        shouldIncludeVehicles && totalVehicleQty > 0 ? totalVehicleQty : undefined,
      
      // Activity/Guide costs
      totalGuideCost: totalGuideCost > 0 ? totalGuideCost : undefined,
      totalHotspotCost: totalHotspotCost > 0 ? totalHotspotCost : undefined,
      totalActivityCost: totalActivityCost > 0 ? totalActivityCost : undefined,
      kmLimitWarning,
      totalAllowedKm:
        totalAllowedKmFromAssigned > 0 ? Number(totalAllowedKmFromAssigned.toFixed(2)) : undefined,
      totalTravelledKm:
        totalTravelledKmFromAssigned > 0
          ? Number(totalTravelledKmFromAssigned.toFixed(2))
          : undefined,
      totalExtraKm:
        totalExtraKmFromAssigned > 0 ? Number(totalExtraKmFromAssigned.toFixed(2)) : undefined,
      
      // Final calculations
      additionalMargin: additionalMargin,
      totalAmount: totalAmount,
      couponDiscount: couponDiscount,
      agentMargin: agentMargin,
      totalRoundOff: totalRoundOff,
      netPayable: netPayable,
      companyName: 'Doview Holidays India Pvt ltd',
    };

    // ------------------------------ TOP SUMMARY ------------------------------
    const dateRange =
      plan.trip_start_date_and_time && plan.trip_end_date_and_time
        ? `${this.formatISODateLocal(plan.trip_start_date_and_time)} to ${this.formatISODateLocal(
            plan.trip_end_date_and_time,
          )}`
        : '';

    // Room count should be hidden for vehicle-only itineraries.
    const roomCount = shouldIncludeHotels ? Number(plan.preferred_room_count ?? 0) : 0;

    const response: ItineraryDetailsResponseDto = {
      quoteId: plan.itinerary_quote_ID ?? '',
      planId: plan.itinerary_plan_ID,
      itineraryPreference: Number((plan as any).itinerary_preference || 0),
      isConfirmed: !!confirmedPlan,
      confirmed_itinerary_plan_ID: confirmedPlan?.confirmed_itinerary_plan_ID,
      dateRange,
      dayCount: Number((plan as any).no_of_days || days.length || 0),
      nightCount: Number((plan as any).no_of_nights || 0),
      roomCount,
      extraBed: plan.total_extra_bed ?? 0,
      childWithBed: plan.total_child_with_bed ?? 0,
      childWithoutBed: plan.total_child_without_bed ?? 0,
      adults: plan.total_adult ?? 0,
      children: plan.total_children ?? 0,
      infants: plan.total_infants ?? 0,
      overallCost: netPayable.toFixed(2), // Use calculated net payable

      days,

      vehicles,
      packageIncludes: {
        description: '',
        houseBoatNote: '',
        rateNote: '',
      },
      costBreakdown,
    };

    return response;
  }

  
    // ---------------------------------------------------------------------------
  // Latest Itineraries DataTable (unchanged logic, just using helpers)
  // ---------------------------------------------------------------------------
  async getLatestItinerariesDataTable(
    q: LatestItineraryQueryDto,
    req: any,
  ) {
    const rawQuery: any = (req as any)?.query ?? {};

    const searchValue =
      (rawQuery.search &&
        (rawQuery.search.value ?? rawQuery.search['value'])) ||
      rawQuery['search[value]'] ||
      '';

    const draw = Number(q.draw ?? rawQuery.draw ?? 0) || 0;
    const start = Number(q.start ?? rawQuery.start ?? 0) || 0;
    const limit = Number(q.length ?? rawQuery.length ?? 10) || 10;

    const startDateRaw = this.parseDate(
      q.start_date ?? rawQuery.start_date ?? null,
    );
    const endDateRaw = this.parseDate(
      q.end_date ?? rawQuery.end_date ?? null,
    );

    const startDate = startDateRaw ? this.startOfDay(startDateRaw) : null;
    const endDate = endDateRaw ? this.endOfDay(endDateRaw) : null;

    const source_location = String(
      q.source_location ?? rawQuery.source_location ?? '',
    ).trim();
    const destination_location = String(
      q.destination_location ?? rawQuery.destination_location ?? '',
    ).trim();

    const filter_agent_id =
      Number(q.agent_id ?? rawQuery.agent_id ?? 0) || 0;
    const filter_staff_id =
      Number(q.staff_id ?? rawQuery.staff_id ?? 0) || 0;

    const u: any = (req as any).user ?? {};
    const logged_user_level =
      Number(u.roleID ?? u.roleId ?? u.role ?? 0) || 0;
    const input_staff_id = Number(u.staff_id ?? u.staffId ?? 0) || 0;
    const input_agent_id = Number(u.agent_id ?? u.agentId ?? 0) || 0;

    const s = String(searchValue ?? '').trim();

    let roleOr: any | null = null;

    if (input_staff_id > 0 && logged_user_level !== 6) {
      const teAgents = await this.prisma.dvi_agent.findMany({
        where: {
          travel_expert_id: input_staff_id,
        } as any,
        select: { agent_ID: true },
      });
      const teAgentIds = teAgents
        .map((a) => Number(a.agent_ID))
        .filter((n) => n > 0);

      roleOr = {
        OR: [
          { staff_id: input_staff_id },
          ...(teAgentIds.length ? [{ agent_id: { in: teAgentIds } }] : []),
        ],
      };
    } else if (input_agent_id > 0) {
      const agentStaff = await this.prisma.dvi_staff_details.findMany({
        where: {
          agent_id: input_agent_id,
        } as any,
        select: { staff_id: true },
      });
      const agentStaffIds = agentStaff
        .map((x) => Number(x.staff_id))
        .filter((n) => n > 0);

      roleOr = {
        OR: [
          { agent_id: input_agent_id },
          ...(agentStaffIds.length ? [{ staff_id: { in: agentStaffIds } }] : []),
        ],
      };
    }

    let searchOr: any[] = [];
    if (s) {
      const staffMatches = await this.prisma.dvi_staff_details.findMany({
        where: {
          staff_name: { contains: s },
        } as any,
        select: { staff_id: true },
        take: 500,
      });
      const staffIdsByName = staffMatches
        .map((x) => Number(x.staff_id))
        .filter((n) => n > 0);

      const agentMatches = await this.prisma.dvi_agent.findMany({
        where: {
          agent_name: { contains: s },
        } as any,
        select: { agent_ID: true },
        take: 500,
      });
      const agentIdsByName = agentMatches
        .map((x) => Number(x.agent_ID))
        .filter((n) => n > 0);

      const userMatches = await this.prisma.dvi_users.findMany({
        where: {
          OR: [
            { username: { contains: s } },
            ...(staffIdsByName.length
              ? [{ staff_id: { in: staffIdsByName } }]
              : []),
            ...(agentIdsByName.length
              ? [{ agent_id: { in: agentIdsByName } }]
              : []),
          ],
        } as any,
        select: { userID: true },
        take: 1000,
      });
      const userIdsBySearch = userMatches
        .map((x) => Number(x.userID))
        .filter((n) => n > 0);

      const confirmedMatches =
        await this.prisma.dvi_confirmed_itinerary_plan_details.findMany(
          {
            where: {
              deleted: 0,
              itinerary_quote_ID: { contains: s },
            } as any,
            select: { itinerary_plan_ID: true },
            take: 1000,
          },
        );
      const planIdsByConfirmed = confirmedMatches
        .map((x) => Number(x.itinerary_plan_ID))
        .filter((n) => n > 0);

      searchOr = [
        { arrival_location: { contains: s } },
        { departure_location: { contains: s } },
        { itinerary_quote_ID: { contains: s } },
        ...(userIdsBySearch.length
          ? [{ createdby: { in: userIdsBySearch } }]
          : []),
        ...(planIdsByConfirmed.length
          ? [{ itinerary_plan_ID: { in: planIdsByConfirmed } }]
          : []),
      ];
    }

    const where: any = {
      deleted: 0,
      ...(roleOr ? roleOr : {}),
      ...(s ? { OR: searchOr } : {}),
    };

    if (startDate) {
      where.trip_start_date_and_time = {
        ...(where.trip_start_date_and_time ?? {}),
        gte: startDate,
      };
    }
    if (endDate) {
      where.trip_end_date_and_time = {
        ...(where.trip_end_date_and_time ?? {}),
        lte: endDate,
      };
    }

    if (source_location) where.arrival_location = source_location;
    if (destination_location) where.departure_location = destination_location;

    if (filter_agent_id > 0) where.agent_id = filter_agent_id;
    if (filter_staff_id > 0) where.staff_id = filter_staff_id;

    const totalRecords =
      await this.prisma.dvi_itinerary_plan_details.count({ where });

    const plans = await this.prisma.dvi_itinerary_plan_details.findMany({
      where,
      orderBy: { itinerary_plan_ID: 'desc' },
      skip: start,
      take: limit,
      select: {
        itinerary_plan_ID: true,
        arrival_location: true,
        departure_location: true,
        trip_start_date_and_time: true,
        trip_end_date_and_time: true,
        expecting_budget: true,
        itinerary_quote_ID: true,
        no_of_routes: true,
        no_of_days: true,
        no_of_nights: true,
        total_adult: true,
        total_children: true,
        total_infants: true,
        itinerary_preference: true,
        preferred_room_count: true,
        total_extra_bed: true,
        status: true,
        deleted: true,
        createdon: true,
        createdby: true,
        staff_id: true,
        agent_id: true,
      } as any,
    });

    const planIds = plans
      .map((p: any) => Number(p.itinerary_plan_ID))
      .filter((n) => n > 0);
    const createdByUserIds = plans
      .map((p: any) => Number(p.createdby))
      .filter((n) => n > 0);

    const confirmed = planIds.length
      ? await this.prisma.dvi_confirmed_itinerary_plan_details.findMany({
          where: { itinerary_plan_ID: { in: planIds }, deleted: 0 } as any,
          select: { itinerary_plan_ID: true, itinerary_quote_ID: true },
        })
      : [];
    const confirmedMap = new Map<number, string>();
    for (const c of confirmed as any[]) {
      const pid = Number(c.itinerary_plan_ID);
      if (pid) confirmedMap.set(pid, String(c.itinerary_quote_ID ?? ''));
    }

    const users = createdByUserIds.length
      ? await this.prisma.dvi_users.findMany({
          where: { userID: { in: createdByUserIds } } as any,
          select: {
            userID: true,
            roleID: true,
            staff_id: true,
            agent_id: true,
            username: true,
          },
        })
      : [];
    const userMap = new Map<number, any>();
    for (const uu of users as any[]) userMap.set(Number(uu.userID), uu);

    const staffIds = Array.from(
      new Set(
        (users as any[])
          .map((x) => Number(x.staff_id))
          .filter((n) => n > 0),
      ),
    );
    const agentIds = Array.from(
      new Set(
        (users as any[])
          .map((x) => Number(x.agent_id))
          .filter((n) => n > 0),
      ),
    );

    const staffRows = staffIds.length
      ? await this.prisma.dvi_staff_details.findMany({
          where: { staff_id: { in: staffIds } } as any,
          select: { staff_id: true, staff_name: true },
        })
      : [];
    const staffMap = new Map<number, string>();
    for (const st of staffRows as any[])
      staffMap.set(Number(st.staff_id), String(st.staff_name ?? ''));

    const agentRows = agentIds.length
      ? await this.prisma.dvi_agent.findMany({
          where: { agent_ID: { in: agentIds } } as any,
          select: { agent_ID: true, agent_name: true },
        })
      : [];
    const agentMap = new Map<number, string>();
    for (const ag of agentRows as any[])
      agentMap.set(Number(ag.agent_ID), String(ag.agent_name ?? ''));

    let counter = start;

    const data = (plans ?? []).map((p: any) => {
      counter++;

      const pid = Number(p.itinerary_plan_ID ?? 0) || 0;
      const uRec = userMap.get(Number(p.createdby ?? 0)) ?? null;

      const roleID = Number(uRec?.roleID ?? 0) || 0;
      const staff_id = Number(uRec?.staff_id ?? 0) || 0;
      const agent_id = Number(uRec?.agent_id ?? 0) || 0;

      const staff_name = staff_id ? staffMap.get(staff_id) ?? '' : '';
      const agent_name = agent_id ? agentMap.get(agent_id) ?? '' : '';

      let username = '';
      if (roleID === 1) {
        username = String(uRec?.username ?? '');
      } else if (roleID === 3 && staff_id !== 0 && agent_id === 0) {
        username = `Travel Expert - <br>${staff_name}`;
      } else if (roleID === 4 && staff_id === 0 && agent_id !== 0) {
        username = `Agent - <br>${agent_name}`;
      } else if (roleID === 4 && staff_id !== 0 && agent_id !== 0) {
        username = `Agent - <br>${staff_name}`;
      } else if (roleID === 5 && staff_id !== 0 && agent_id === 0) {
        username = `Guide - <br>${staff_name}`;
      }

      const total_adult = Number(p.total_adult ?? 0) || 0;
      const total_children = Number(p.total_children ?? 0) || 0;
      const total_infants = Number(p.total_infants ?? 0) || 0;

      const total_members = `<span>Adult - ${total_adult}</br>Children - ${total_children}</br>Infants - ${total_infants}</span>`;

      return {
        counter,
        modify: pid,
        itinerary_quote_ID: String(p.itinerary_quote_ID ?? '') || null,
        itinerary_booking_ID: confirmedMap.get(pid) ?? null,
        arrival_location: p.arrival_location ?? '',
        departure_location: p.departure_location ?? '',
        itinerary_preference:
          Number(p.itinerary_preference ?? 0) || 0,
        no_of_days_and_nights: `${
          Number(p.no_of_nights ?? 0) || 0
        }&${Number(p.no_of_days ?? 0) || 0}`,
        no_of_person: total_members,
        trip_start_date_and_time: this.formatTripDateTime(
          p.trip_start_date_and_time,
        ),
        trip_end_date_and_time: this.formatTripDateTime(
          p.trip_end_date_and_time,
        ),
        total_adult,
        total_children,
        total_infants,
        username,
        createdon: this.formatCreatedOn(p.createdon),
      };
    });

    return {
      draw,
      recordsTotal: totalRecords,
      recordsFiltered: totalRecords,
      data,
    };
  }


  async findOne(id: number, groupType?: number) {
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: id },
    });
    if (!plan) throw new NotFoundException('Itinerary not found');
    
    const quoteId = plan.itinerary_quote_ID;
    if (!quoteId) throw new NotFoundException('Quote ID not found for this plan');
    return this.getItineraryDetails(quoteId, groupType);
  }

  async findOneOld(id: number, groupType?: number) {
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: id },
    });
    if (!plan) throw new NotFoundException('Itinerary not found');

    const routes = await this.prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: id, deleted: 0 },
    });

    // Fetch via routes for all routes in this plan
    const viaRoutesRaw = await this.prisma.dvi_itinerary_via_route_details.findMany({
      where: { itinerary_plan_ID: id, deleted: 0 },
    });

    // Group via routes by route ID
    const viaRoutesByRouteId = new Map<number, any[]>();
    for (const vr of viaRoutesRaw) {
      const routeId = Number(vr.itinerary_route_ID);
      if (!viaRoutesByRouteId.has(routeId)) {
        viaRoutesByRouteId.set(routeId, []);
      }
      viaRoutesByRouteId.get(routeId)!.push({
        itinerary_via_location_ID: Number(vr.itinerary_via_location_ID),
        itinerary_via_location_name: vr.itinerary_via_location_name,
      });
    }

    // Add via_routes array to each route
    const routesWithVia = routes.map(r => ({
      ...r,
      via_routes: viaRoutesByRouteId.get(Number(r.itinerary_route_ID)) || [],
    }));

    const hotspots =
      await this.prisma.dvi_itinerary_route_hotspot_details.findMany({
        where: { itinerary_plan_ID: id, deleted: 0 },
      });

    const vehicles =
      await this.prisma.dvi_itinerary_plan_vehicle_details.findMany({
        where: { itinerary_plan_id: id, deleted: 0 },
      });

    const travellers =
      await this.prisma.dvi_itinerary_traveller_details.findMany({
        where: { itinerary_plan_ID: id, deleted: 0 },
      });

    return { plan, routes: routesWithVia, hotspots, vehicles, travellers };
  }
}
