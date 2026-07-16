// FILE: src/modules/itineraries/itinerary-details.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import {
  canViewItineraryCostBreakdown,
  isAgentRole,
  redactItineraryCostBreakdown,
  redactVehicleForAgent,
  redactVehicleCostBreakdowns,
} from './utils/itinerary-cost-visibility.util';
import { Request } from 'express';
import { PrismaService } from '../../prisma.service';
import { LatestItineraryQueryDto } from './dto/latest-itinerary-query.dto';
import { calculateRouteTollCharges, getEffectiveTimeLimitKm } from './engines/vehicle-calculation.helpers';
import { filterActiveVendorCandidateRows } from './utils/active-vendor-candidate.util';
import {
  buildVehicleRateAvailabilityMessage,
  getVehicleRateAvailability,
} from './utils/vehicle-rate-availability.util';
import { haversineKm } from './utils/distance-utils';
import {
  buildEntryTicketBreakdown,
  type EntryTicketBreakdownDto,
} from './utils/entry-ticket-breakdown.util';
import { ItineraryDetailsTimelinePresentationService } from './services/itinerary-details-timeline-presentation.service';
import { ItineraryDetailsTimeRangePolicyService } from './services/itinerary-details-time-range-policy.service';
import { ItineraryDetailsDisplayFormattingService } from './services/itinerary-details-display-formatting.service';
import { ItineraryDetailsRouteHotelMapService } from './services/itinerary-details-route-hotel-map.service';
import { ItineraryDetailsTravelSemanticsService } from './services/itinerary-details-travel-semantics.service';
import { ItineraryDetailsRouteHotspotDataService } from './services/itinerary-details-route-hotspot-data.service';
import { ItineraryDetailsEntryTicketCostService } from './services/itinerary-details-entry-ticket-cost.service';
import { ItineraryLatestDataTableService } from './services/itinerary-latest-data-table.service';
import { ItineraryDetailsSegmentSanitizerService } from './services/itinerary-details-segment-sanitizer.service';
import { ItineraryDetailsDestinationResolutionService } from './services/itinerary-details-destination-resolution.service';
import { ItineraryDetailsSegmentOrderingService } from './services/itinerary-details-segment-ordering.service';
import { ItineraryDetailsHotelFirstPolicyService } from './services/itinerary-details-hotel-first-policy.service';

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

function normalizeVehicleOfferText(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeVehicleOfferAmount(value: unknown): string {
  const amount = Number.parseFloat(String(value ?? 0));
  return Number.isFinite(amount) ? amount.toFixed(2) : '0.00';
}

function roundCurrency(value: number): number {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function buildVehicleOfferKey(row: any): string {
  return [
    Number(row?.vendor_id || 0),
    Number(row?.vendor_branch_id || 0),
    Number(row?.vehicle_type_id || 0),
    normalizeVehicleOfferText(row?.vehicle_orign),
    normalizeVehicleOfferAmount(row?.vehicle_grand_total),
  ].join('|');
}

function buildVehicleDetailKey(row: any): string {
  const routeDateRaw = row?.itinerary_route_date;
  const routeDate =
    routeDateRaw instanceof Date
      ? routeDateRaw.toISOString().slice(0, 10)
      : String(routeDateRaw ?? '').slice(0, 10);
  return [
    Number(row?.itinerary_plan_vendor_eligible_ID || 0),
    Number(row?.itinerary_route_id || 0),
    Number(row?.vehicle_id || 0),
    routeDate,
  ].join('|');
}

function toSortableDateTime(value: unknown): number {
  if (!value) return 0;

  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : 0;
  }

  const parsed = new Date(value as string | number);
  const time = parsed.getTime();
  return Number.isFinite(time) ? time : 0;
}

export interface VehicleDayWisePricingDto {
  date: string; // "2025-12-26"
  dayLabel: string; // "Day 1 | 26 Dec 2025"
  route: string; // "Chennai → Mahabalipuram"
  travelType?: 'Local' | 'Outstation' | 'Mixed';
  timeLimitId?: number;
  chargeableTimeLimitId?: number;
  kmsLimitId?: number;
  slabTitle?: string;
  chargeableSlabTitle?: string;
  originalSlabTitle?: string;
  slabUpgraded?: boolean;
  packageTitle?: string;
  slabHoursLimit?: number;
  slabKmLimit?: number;
  packageKmLimit?: number;
  pickupKms: number;
  pickupDurationMinutes?: number;
  travelKms: number; // Running KM per day
  travelDurationMinutes?: number;
  sightseeingKms: number; // Sightseeing KM per day
  sightseeingDurationMinutes?: number;
  dropDurationMinutes?: number;
  totalDurationMinutes?: number;
  totalKms: number; // Total KMS per day (pickup + travel + sightseeing + drop)
  rentalCharges: number;
  tollCharges: number;
  tollBreakupText?: string[];
  parkingCharges: number;
  parkingBreakupText?: string[];
  driverCharges: number;
  permitCharges: number;
  extraHourCount: number;
  extraHourRate: number;
  extraHourCharges: number;
  extraKms: number;
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
 *   - totalKms: pickup + travel + sightseeing + drop for that specific day
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
  vehicleId?: number | null;
  vehicleIds?: number[];
  vehicleNumber?: string | null;
  vehicleNumbers?: string[];
  availableVehicleCount?: number;
  vehicleRegistrationNumber?: string | null;
  vehicleRegistrationStateCode?: string | null;
  vehicleRegistrationStateName?: string | null;
  vendorEligibleId?: number;
  vehicleTypeId?: number;
  vehicleTypeName?: string;
  isAssigned?: boolean;
  rateAvailable?: boolean;
  missingRateTypes?: Array<'Local' | 'Outstation'>;
  rateAvailabilityMessage?: string | null;
  selectedTimeLimitId?: number;
  availableSlabs?: Array<{
    timeLimitId: number;
    title: string;
    hoursLimit: number;
    kmLimit: number;
  }>;
  localTrip?: boolean;

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
  localUsedKm?: number;
  outstationUsedKm?: number;
  totalAllowedLocalKm?: number;
  totalAllowedOutstationKm?: number;
  totalAllowedKm?: number;
  localDaysCount?: number;
  outstationDaysCount?: number;
  outstationAllowedKmPerDay?: number;
  localAllowedKmBreakdown?: Array<{
    timeLimitId?: number;
    allowedKm: number;
    days: number;
    label?: string;
  }>;
  extraKms?: number;
  localExtraKms?: number;
  localExtraKmCharge?: number;
  outstationExtraKms?: number;
  outstationExtraKmCharge?: number;
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
  entryTicketBreakdown?: EntryTicketBreakdownDto[];
  totalActivityCost?: number;
  kmLimitWarning?: string;
  totalAllowedKm?: number;
  totalTravelledKm?: number;
  totalExtraKm?: number;
  totalAllowedLocalKm?: number;
  totalAllowedOutstationKm?: number;
  localUsedKm?: number;
  outstationUsedKm?: number;
  localExtraKms?: number;
  localExtraKmCharge?: number;
  outstationExtraKms?: number;
  outstationExtraKmCharge?: number;
  
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
  routeFamilyBaseQuoteId?: string | null;
  routeVariantIndex?: number | null;
  routeOptions?: Array<{
    quoteId: string;
    label: string;
    planId: number;
    routeIndex: number;
  }>;
  siblingRoutes?: Array<{
    quoteId: string;
    label: string;
    planId: number;
    routeIndex: number;
  }>;
  suggestedRoutes?: Array<{
    quoteId: string;
    label: string;
    planId: number;
    routeIndex: number;
  }>;
  itineraryPreference?: number;
  itineraryType?: number;
  guideForItinerary?: number;
  preferred_hotel_category?: string | number[] | null;
  preferredHotelCategory?: string | number[] | null;
  hotel_facilities?: string[] | string | null;
  hotelFacilities?: string[] | string | null;
  isConfirmed?: boolean;
  confirmed_itinerary_plan_ID?: number; // ID needed for /confirmed/:id endpoint
  special_instructions?: string | null;
  specialInstructions?: string | null;
  special_instruction?: string | null;
  specialInstruction?: string | null;
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
meal_plan_code?: string | null;

// Guest food preference for frontend day-wise header
food_type?: string | null;
foodType?: string | null;
food_type_name?: string | null;
foodTypeName?: string | null;
guest_food_preference?: string | null;
guestFoodPreference?: string | null;
guest_food_preference_name?: string | null;
guestFoodPreferenceName?: string | null;

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
  vehicleRateAvailability?: Array<{
    vehicleTypeId: number;
    vehicleTypeName: string;
    message: string;
  }>;

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
  private readonly timelinePresentationService = new ItineraryDetailsTimelinePresentationService();
  private readonly timeRangePolicyService = new ItineraryDetailsTimeRangePolicyService();
  private readonly displayFormattingService = new ItineraryDetailsDisplayFormattingService();
  private readonly routeHotelMapService = new ItineraryDetailsRouteHotelMapService();
  private readonly travelSemanticsService = new ItineraryDetailsTravelSemanticsService();
  private readonly routeHotspotDataService = new ItineraryDetailsRouteHotspotDataService();
  private readonly entryTicketCostService = new ItineraryDetailsEntryTicketCostService();
  private readonly latestDataTableService: ItineraryLatestDataTableService;
  private readonly segmentSanitizerService = new ItineraryDetailsSegmentSanitizerService();
  private readonly destinationResolutionService = new ItineraryDetailsDestinationResolutionService();
  private readonly segmentOrderingService = new ItineraryDetailsSegmentOrderingService();
  private readonly hotelFirstPolicyService = new ItineraryDetailsHotelFirstPolicyService();

  constructor(
    private readonly prisma: PrismaService,
  ) {
    this.latestDataTableService = new ItineraryLatestDataTableService(
      this.prisma,
      (value) => this.parseDate(value),
      (date) => this.startOfDay(date),
      (date) => this.endOfDay(date),
      (value) => this.formatTripDateTime(value),
      (value) => this.formatCreatedOn(value),
    );
  }

  private parseRouteFamilyQuote(quoteId: string | undefined | null): {
    baseQuoteId: string;
    routeVariantIndex: number | null;
  } | null {
    const raw = String(quoteId || '').trim();
    if (!raw) return null;

    const match = raw.match(/^(.*)-R(\d+)$/i);
    if (!match) {
      return {
        baseQuoteId: raw,
        routeVariantIndex: null,
      };
    }

    const baseQuoteId = String(match[1] || '').trim();
    const routeVariantIndex = Number.parseInt(String(match[2] || ''), 10);

    if (!baseQuoteId || !Number.isFinite(routeVariantIndex) || routeVariantIndex <= 0) {
      return {
        baseQuoteId: raw,
        routeVariantIndex: null,
      };
    }

    return {
      baseQuoteId,
      routeVariantIndex,
    };
  }

  private async buildSiblingRouteOptions(quoteId: string): Promise<Array<{
    quoteId: string;
    label: string;
    planId: number;
    routeIndex: number;
  }>> {
    const parsed = this.parseRouteFamilyQuote(quoteId);
    const baseQuoteId = String(parsed?.baseQuoteId || '').trim();
    const currentRouteVariantIndex = Number(parsed?.routeVariantIndex || 0);
    if (!baseQuoteId || currentRouteVariantIndex <= 0) return [];

    const familyRows = await this.prisma.dvi_itinerary_plan_details.findMany({
      where: {
        deleted: 0,
        itinerary_quote_ID: { startsWith: `${baseQuoteId}-R` },
      },
      select: {
        itinerary_plan_ID: true,
        itinerary_quote_ID: true,
        createdon: true,
      },
      orderBy: [
        { createdon: 'asc' },
        { itinerary_plan_ID: 'asc' },
      ],
    });

    if (familyRows.length <= 1) {
      return [];
    }

    const rowsWithIndex = familyRows
      .map((row) => {
        const rowQuoteId = String(row.itinerary_quote_ID || '').trim();
        if (!rowQuoteId) return null;

        const rowParsed = this.parseRouteFamilyQuote(rowQuoteId);
        return {
          planId: Number(row.itinerary_plan_ID || 0),
          quoteId: rowQuoteId,
          routeIndex: rowParsed?.routeVariantIndex ?? 0,
          createdon: row.createdon ?? null,
        };
      })
      .filter((row): row is {
        planId: number;
        quoteId: string;
        routeIndex: number;
        createdon: Date | null;
      } => Boolean(row?.planId && row?.quoteId));

    const hasExplicitVariantIndexes = rowsWithIndex.some((row) => row.routeIndex > 0);
    const sortedRows = rowsWithIndex.sort((a, b) => {
      const aSortIndex = a.routeIndex > 0 ? a.routeIndex : Number.MAX_SAFE_INTEGER;
      const bSortIndex = b.routeIndex > 0 ? b.routeIndex : Number.MAX_SAFE_INTEGER;
      if (aSortIndex !== bSortIndex) return aSortIndex - bSortIndex;

      const aCreated = a.createdon ? new Date(a.createdon).getTime() : 0;
      const bCreated = b.createdon ? new Date(b.createdon).getTime() : 0;
      if (aCreated !== bCreated) return aCreated - bCreated;

      return a.planId - b.planId;
    });

    return sortedRows.map((row, index) => {
      const routeIndex = hasExplicitVariantIndexes
        ? (row.routeIndex > 0 ? row.routeIndex : index + 1)
        : index + 1;

      return {
        quoteId: row.quoteId,
        label: `Route ${routeIndex}`,
        planId: row.planId,
        routeIndex,
      };
    });
  }

  private logItineraryApiTiming(params: {
    api: 'itinerary_details' | 'itinerary_details_by_id';
    step: string;
    startedAt: number;
    stepStartedAt: number;
    planId?: number | null;
    quoteId?: string | null;
  }): number {
    const now = Date.now();
    console.log('[ITINERARY_API_TIMING]', {
      api: params.api,
      planId: params.planId ?? null,
      quoteId: params.quoteId ?? null,
      step: params.step,
      durationMs: now - params.stepStartedAt,
      totalElapsedMs: now - params.startedAt,
    });
    return now;
  }

  // TODO: remove after validation
  private logBookingRule(payload: Record<string, unknown>): void {
    console.log('[BOOKING_RULE]', payload);
  }

  private normalizePlaceLabel(value: any): string {
    return String(value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private isGenericHotelLabel(value: any): boolean {
    const normalized = this.normalizePlaceLabel(value);
    return normalized === 'hotel' || normalized === 'check in hotel' || normalized === 'checkin hotel';
  }

  private isSamePlaceLike(a: any, b: any): boolean {
    const na = this.normalizePlaceLabel(a);
    const nb = this.normalizePlaceLabel(b);
    return !!na && !!nb && na === nb;
  }

  // ---------------------------------------------------------------------------
  // Low-level helpers
  // ---------------------------------------------------------------------------

private formatKm(value: number): string {
return `${value.toFixed(2)} KM`;
}

private parseFiniteNumber(value: unknown): number | null {
  const num = Number.parseFloat(String(value ?? '').trim());
  return Number.isFinite(num) ? num : null;
}

private parseStoredDistanceKm(value: unknown): number | null {
  const num = this.parseFiniteNumber(value);
  return num !== null && num >= 0 ? num : null;
}

private formatTravelDistance(distanceKm: number | null): string {
  return distanceKm !== null && Number.isFinite(distanceKm)
    ? `${distanceKm.toFixed(2)} KM`
    : '--';
}

private async getOsrmRouteDistanceKm(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): Promise<number | null> {
  if (
    !Number.isFinite(fromLat)
    || !Number.isFinite(fromLng)
    || !Number.isFinite(toLat)
    || !Number.isFinite(toLng)
  ) {
    return null;
  }

  try {
    const osrmBaseUrl = String(process.env.OSRM_BASE_URL || 'https://router.project-osrm.org/route/v1/driving').trim();
    const url = `${osrmBaseUrl}/${fromLng},${fromLat};${toLng},${toLat}?overview=false&alternatives=false&steps=false`;
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) return null;

    const body = await response.json();
    const route = Array.isArray(body?.routes) ? body.routes[0] : null;
    const meters = Number(route?.distance);
    if (!Number.isFinite(meters) || meters <= 0) return null;

    const km = meters / 1000;
    return Number.isFinite(km) && km > 0 ? km : null;
  } catch {
    return null;
  }
}

private isSuspiciousTravelDistance(params: {
  distanceKm: number | null;
  durationRaw?: Date | string | null;
  fromName?: string | null;
  toName?: string | null;
}): boolean {
  const { distanceKm, durationRaw, fromName, toName } = params;
  const samePlace = this.isSamePlaceLike(fromName, toName);
  if (samePlace) return false;
  if (distanceKm === null || !Number.isFinite(distanceKm) || distanceKm <= 0) return true;
  if (distanceKm <= 0.15) return true;

  const durationMin = this.durationToMinutes(durationRaw ?? null);
  if (durationMin !== null && durationMin >= 15 && distanceKm <= 0.5) {
    return true;
  }

  return false;
}

private async resolveTravelDistanceKm(params: {
  row: any;
  itemType: number;
  location: any;
  route: any;
  semanticFromHotspotId?: number | null;
  semanticToHotspotId?: number | null;
  fromName?: string | null;
  toName?: string | null;
  hotspotMap: Map<number, any>;
}): Promise<number | null> {
  const baseDistanceKm = this.parseStoredDistanceKm(params.row?.hotspot_travelling_distance);
  if (!this.isSuspiciousTravelDistance({
    distanceKm: baseDistanceKm,
    durationRaw: params.row?.hotspot_traveling_time ?? null,
    fromName: params.fromName,
    toName: params.toName,
  })) {
    return baseDistanceKm;
  }

  const toHotspotId = Number(params.semanticToHotspotId || 0);
  const fromHotspotId = Number(params.semanticFromHotspotId || 0);

    if (fromHotspotId > 0 && toHotspotId > 0 && fromHotspotId !== toHotspotId) {
      const fromMaster = params.hotspotMap.get(fromHotspotId);
      const toMaster = params.hotspotMap.get(toHotspotId);
      const fromLat = this.parseFiniteNumber(fromMaster?.hotspot_latitude);
      const fromLng = this.parseFiniteNumber(fromMaster?.hotspot_longitude);
      const toLat = this.parseFiniteNumber(toMaster?.hotspot_latitude);
      const toLng = this.parseFiniteNumber(toMaster?.hotspot_longitude);

      if (fromLat !== null && fromLng !== null && toLat !== null && toLng !== null) {
        const osrmKm = await this.getOsrmRouteDistanceKm(fromLat, fromLng, toLat, toLng);
        if (osrmKm !== null) return osrmKm;
        return haversineKm(Number(fromLat), Number(fromLng), Number(toLat), Number(toLng));
      }
    }

    if (toHotspotId > 0) {
    const toMaster = params.hotspotMap.get(toHotspotId);
      const toLat = this.parseFiniteNumber(toMaster?.hotspot_latitude);
      const toLng = this.parseFiniteNumber(toMaster?.hotspot_longitude);
      const sourceLat = this.parseFiniteNumber(params.location?.source_location_lattitude);
      const sourceLng = this.parseFiniteNumber(params.location?.source_location_longitude);

      if (sourceLat !== null && sourceLng !== null && toLat !== null && toLng !== null) {
        const osrmKm = await this.getOsrmRouteDistanceKm(sourceLat, sourceLng, toLat, toLng);
        if (osrmKm !== null) return osrmKm;
        return haversineKm(Number(sourceLat), Number(sourceLng), Number(toLat), Number(toLng));
      }
    }

  if (params.itemType === 2) {
    const storedRouteKm = this.parseStoredDistanceKm(params.location?.distance ?? params.route?.no_of_km);
    if (storedRouteKm !== null && storedRouteKm > 0) {
      return storedRouteKm;
    }
  }

  return baseDistanceKm;
}

private getFoodPreferenceLabel(value: unknown): string | null {
  const raw = String(value ?? '').trim();

  if (!raw || raw === '0' || raw.toLowerCase() === 'null') {
    return null;
  }

const foodTypeMap: Record<string, string> = {
  "1": "Vegetarian",
  "2": "Non Vegetarian",
  "3": "Jain",
  "4": "Vegan",
  "5": "Eggetarian",
};

  return foodTypeMap[raw] || raw;
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

  private formatDbDateOnly(...args: any[]): any {
    return (this.displayFormattingService as any).formatDbDateOnly(...args);
  }

  private pad2(...args: any[]): any {
    return (this.displayFormattingService as any).pad2(...args);
  }

  private formatCreatedOn(...args: any[]): any {
    return (this.displayFormattingService as any).formatCreatedOn(...args);
  }

  private formatTripDateTime(...args: any[]): any {
    return (this.displayFormattingService as any).formatTripDateTime(...args);
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
  public formatTime(...args: any[]): any {
    return (this.displayFormattingService as any).formatTime(...args);
  }

  private formatDuration(...args: any[]): any {
    return (this.displayFormattingService as any).formatDuration(...args);
  }

  /** Convert time string "HH:MM AM/PM" to minutes since midnight */
  private timeToMinutes(...args: any[]): any {
    return (this.timeRangePolicyService as any).timeToMinutes(...args);
  }

  private parseDisplayTimeMinutesStrict(...args: any[]): any {
    return (this.timeRangePolicyService as any).parseDisplayTimeMinutesStrict(...args);
  }

  private minutesToDisplayTime(...args: any[]): any {
    return (this.timeRangePolicyService as any).minutesToDisplayTime(...args);
  }

  private orderedTimeRange(...args: any[]): any {
    return (this.timeRangePolicyService as any).orderedTimeRange(...args);
  }

  private getTravelTimeRangeWithDuration(...args: any[]): any {
    return (this.timeRangePolicyService as any).getTravelTimeRangeWithDuration(...args);
  }

  private durationToMinutes(...args: any[]): any {
    return (this.timeRangePolicyService as any).durationToMinutes(...args);
  }

  private formatDurationFromDisplayRange(...args: any[]): any {
    return (this.timeRangePolicyService as any).formatDurationFromDisplayRange(...args);
  }

  private normalizeSegmentChronology(segments: any[]): void {
    this.timelinePresentationService.normalizeSegmentChronology(segments);
  }

  private normalizeConfirmedTravelLabelsFromSequence(
    segments: any[],
    fallbackHotelName?: string | null,
  ): any[] {
    return this.timelinePresentationService.normalizeConfirmedTravelLabelsFromSequence(segments, fallbackHotelName);
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
      orderBy: { itinerary_plan_ID: 'desc' },
      select: { itinerary_plan_ID: true },
    });
    return plan ? plan.itinerary_plan_ID : null;
  }

  async getItineraryDetails(
    quoteId: string,
    groupType?: number,
    viewerRole?: unknown,
  ): Promise<ItineraryDetailsResponseDto> {
    const apiStartedAt = Date.now();
    let stepStartedAt = apiStartedAt;

    // ------------------------------ PLAN ------------------------------
    const plan = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_quote_ID: quoteId, deleted: 0 },
      orderBy: { itinerary_plan_ID: 'desc' },
    });

    if (!plan) {
      throw new NotFoundException('Itinerary not found');
    }
    const planId = plan.itinerary_plan_ID;
    const parsedRouteFamilyQuote = this.parseRouteFamilyQuote(plan.itinerary_quote_ID);
    const siblingRouteOptions = await this.buildSiblingRouteOptions(
      String(plan.itinerary_quote_ID || ''),
    );
    const itineraryPreference = Number((plan as any).itinerary_preference || 0);
    const isVehicleOnly = itineraryPreference === 2;
    const proofQuoteEnabled = false;

    const confirmedPlan = await this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
      where: { itinerary_plan_ID: planId, deleted: 0, status: 1 },
    });
    stepStartedAt = this.logItineraryApiTiming({
      api: 'itinerary_details',
      planId,
      quoteId,
      step: 'plan_lookup',
      startedAt: apiStartedAt,
      stepStartedAt,
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
    stepStartedAt = this.logItineraryApiTiming({
      api: 'itinerary_details',
      planId,
      quoteId,
      step: 'routes_lookup',
      startedAt: apiStartedAt,
      stepStartedAt,
    });

    const entryTicketRowsByRouteHotspotId = await this.entryTicketCostService.load(this.prisma, planId);

    const routeHotelMap = await this.routeHotelMapService.build({
      prisma: this.prisma,
      planId,
      confirmedPlan,
      groupType,
      routes,
      isVehicleOnly,
    });
    stepStartedAt = this.logItineraryApiTiming({
      api: 'itinerary_details',
      planId,
      quoteId,
      step: 'hotel_details_lookup',
      startedAt: apiStartedAt,
      stepStartedAt,
    });

    const days: any[] = [];
    const entryTicketBreakdown: EntryTicketBreakdownDto[] = [];

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

      const routeHotspotData = await this.routeHotspotDataService.load({
        prisma: this.prisma,
        planId,
        routeId: Number(route.itinerary_route_ID),
        formatTime: (value) => this.formatTime(value),
        timeToMinutes: (value) => this.timeToMinutes(value),
      });
      const {
        routeHotspots,
        hotspotIds,
        hotspotMap,
        normalizeLookupName,
        hotspotNameToIdMap,
        hotspotTimingMap,
        hotspotGalleryMap,
      } = routeHotspotData;

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
      let seenAttraction = false;
      let emittedTravelBeforeFirstAttraction = false;
      
      // FIX #3: Track hotel arrival time for checkin anchoring
      let hotelArrivalTime: string | null = null;
      let emittedTerminalSegment = false;
      const suppressedLastRouteOrders = new Set<number>();
      const routeEndMins = this.timeToMinutes(this.formatTime(route.route_end_time as any) ?? '00:00 AM');

      const normalizeName = (value?: string | null) =>
        (value ?? '').trim().toLowerCase();

      const isForcedManualConflictAttractionRow = (row: any): boolean => {
        if (Number((row as any)?.item_type ?? 0) !== 4) return false;
        const isConflict = Number((row as any)?.is_conflict ?? (row as any)?.isConflict ?? 0) === 1;
        if (!isConflict) return false;
        const reason = String((row as any)?.conflict_reason ?? (row as any)?.conflictReason ?? '');
        return /forced manual insertion after user confirmation/i.test(reason);
      };

      const pendingForcedManualConflictRows = (routeHotspots || [])
        .filter((row: any) => isForcedManualConflictAttractionRow(row))
        .filter((row: any) => Number((row as any)?.hotspot_ID ?? 0) > 0);
      const insertedForcedManualConflictHotspotIds = new Set<number>();

      const getRouteHotelName = () => {
        const hotelInfo = routeHotelMap.get(route.itinerary_route_ID);
        return hotelInfo?.hotel_name ?? 'Hotel';
      };

      const destinationResolutionContext = {
        hotspotMap,
        hotspotNameToIdMap,
        route,
        location,
        plan,
        normalizeLookupName,
        isForcedManualConflictAttractionRow,
        getRouteHotelName,
      };
      const findNextSemanticDestinationName = (rows: any[], currentIndex: number): string | null =>
        this.destinationResolutionService.findNextSemanticDestinationName(
          rows,
          currentIndex,
          destinationResolutionContext,
        );
      const inferHotspotIdFromLabel = (label?: string | null): number | null =>
        this.destinationResolutionService.inferHotspotIdFromLabel(label, destinationResolutionContext);

      // Find item_type 1 (START/BREAK) to get actual start time
      const startHotspot = routeHotspots.find(
        (rh) => Number((rh as any).item_type ?? 0) === 1,
      );

      const travelSegmentSemantics = this.travelSemanticsService.build({
        routeHotspots,
        hotspotMap,
        location,
        route,
        plan,
        index,
        routes,
        routeHotelMap,
        formatTime: (value) => this.formatTime(value),
        timeToMinutes: (value) => this.timeToMinutes(value),
        isForcedManualConflictAttractionRow,
        getRouteHotelName,
      });

      // Only add START segment if item_type 1 exists (match PHP behavior)
      // Exception: suppress START on late-arrival Day 1 that has no attractions
      const hasAttractions = routeHotspots.some(
        (rh) => Number((rh as any).item_type ?? 0) === 4,
      );
      const destinationLocationName = String(
        location?.destination_location ??
        route.next_visiting_location ??
        plan.departure_location ??
        '',
      ).trim();
      const isTerminalDepartureDay =
        /(airport|air\s*port|railway|rail\s*way|station|bus\s*stand|bus\s*station|terminal|terminus|junction|stn)\b/i
          .test(destinationLocationName);
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

      if (!(isLateArrivalDay1 && !hasAttractions)) {
        let startTimeRange: string | null = null;

        if (startHotspot) {
          startTimeRange = `${this.formatTime((startHotspot as any).hotspot_start_time ?? null)} - ${this.formatTime((startHotspot as any).hotspot_end_time ?? null)}`;
        } else {
          const routeStartText = this.formatTime(route.route_start_time as any);
          const firstTimelineStartText = this.formatTime((routeHotspots[0] as any)?.hotspot_start_time ?? null);

          if (routeStartText && isTerminalDepartureDay && !hasAttractions) {
            // Transfer-only departure days should show the exact transfer start,
            // not a borrowed start from stale or unrelated timeline rows.
            startTimeRange = routeStartText;
          } else if (routeStartText && firstTimelineStartText) {
            const orderedStartRange = this.orderedTimeRange(routeStartText, firstTimelineStartText);
            startTimeRange = orderedStartRange ?? `${routeStartText} - ${firstTimelineStartText}`;
          } else if (routeStartText) {
            const routeStartMins = this.timeToMinutes(routeStartText);
            const fallbackEndText = this.minutesToDisplayTime(routeStartMins + 60);
            startTimeRange = `${routeStartText} - ${fallbackEndText}`;
          }
        }

        if (startTimeRange) {
          segments.push({
            type: 'start' as const,
            title: index === 0 ? 'Start your Journey' : 'Start Your Day',
            timeRange: startTimeRange,
          });
        }
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

        let distanceNum = this.parseStoredDistanceKm((rh as any).hotspot_travelling_distance) ?? 0;
        let travelDistance = this.formatTravelDistance(distanceNum);

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

          const resolvedDistanceKm = await this.resolveTravelDistanceKm({
            row: rh,
            itemType,
            location,
            route,
            fromName: previousStopName,
            toName,
            hotspotMap,
          });
          distanceNum = resolvedDistanceKm ?? 0;
          travelDistance = this.formatTravelDistance(resolvedDistanceKm);

          if (Number.isFinite(distanceNum) && distanceNum > 0) {
            totalDistanceKm += distanceNum;
          }

          const travelRange = this.getTravelTimeRangeWithDuration(startTimeText, endTimeText, travelDuration);

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

          if (!seenAttraction) {
            emittedTravelBeforeFirstAttraction = true;
          }

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
            const resolvedDistanceKm = await this.resolveTravelDistanceKm({
              row: rh,
              itemType,
              location,
              route,
              fromName: previousStopName,
              toName,
              hotspotMap,
            });
            distanceNum = resolvedDistanceKm ?? 0;
            travelDistance = this.formatTravelDistance(resolvedDistanceKm);
            const travelRange = this.getTravelTimeRangeWithDuration(startTimeText, endTimeText, travelDuration);

            if (Number.isFinite(distanceNum) && distanceNum > 0) {
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

            if (!seenAttraction) {
              emittedTravelBeforeFirstAttraction = true;
            }

            previousStopName = toName;
          } else {
            if (suppressedLastRouteOrders.has(Number((rh as any).hotspot_order || 0))) {
              continue;
            }

            // Regular travel to hotspot - use precomputed semantic mapping
            const semanticMapping = travelSegmentSemantics.get(rh.route_hotspot_ID);
            let fromName = semanticMapping?.from ?? previousStopName;  // Fallback only if not in map
            let toName = semanticMapping?.to ?? 
              master?.hotspot_name ??
              viaLocationName ??
              (rh.hotspot_ID === 0 ? route.next_visiting_location : null) ??
              previousStopName;

            // In force-conflict mode, keep the manually inserted conflict hotspot in sequence:
            // Hotel -> [manual conflict hotspot] -> next scheduled attraction.
            if (pendingForcedManualConflictRows.length > 0) {
              for (const forcedRow of pendingForcedManualConflictRows) {
                const forcedHotspotId = Number((forcedRow as any)?.hotspot_ID ?? 0);
                if (!forcedHotspotId || insertedForcedManualConflictHotspotIds.has(forcedHotspotId)) {
                  continue;
                }

                const forcedMaster = hotspotMap.get(forcedHotspotId);
                const forcedName = String(forcedMaster?.hotspot_name ?? '').trim();
                if (!forcedName) {
                  insertedForcedManualConflictHotspotIds.add(forcedHotspotId);
                  continue;
                }

                const preManualStart =
                  this.formatTime((startHotspot as any)?.hotspot_start_time ?? null) ||
                  this.formatTime(route.route_start_time as any) ||
                  startTimeText;
                const preManualEnd = startTimeText || preManualStart;
                const preManualRange = this.orderedTimeRange(preManualStart, preManualEnd);
                const forcedDurationMinutes = this.durationToMinutes((forcedMaster as any)?.hotspot_duration ?? null);
                const conflictVisitStart = preManualEnd || preManualStart;
                const conflictVisitStartMinutes = this.parseDisplayTimeMinutesStrict(conflictVisitStart);
                const conflictVisitEnd =
                  conflictVisitStartMinutes !== null && forcedDurationMinutes !== null
                    ? this.minutesToDisplayTime(conflictVisitStartMinutes + forcedDurationMinutes)
                    : conflictVisitStart;
                const conflictVisitRange = this.orderedTimeRange(conflictVisitStart, conflictVisitEnd);
                const conflictVisitTime = conflictVisitRange
                  ? `${conflictVisitRange} (Manual override)`
                  : 'Manual override';

                const previousDayHotelName =
                  index > 0
                    ? routeHotelMap.get(routes[index - 1].itinerary_route_ID)?.hotel_name ?? null
                    : null;
                const travelFrom = previousDayHotelName || previousStopName?.trim() || fromName;
                if (travelFrom && normalizeName(travelFrom) !== normalizeName(forcedName)) {
                  pushHotspotAnchorPlaceholder({
                    from: travelFrom,
                    to: forcedName,
                    timeRange: preManualRange,
                  });

                  segments.push({
                    type: 'travel' as const,
                    from: travelFrom,
                    to: forcedName,
                    timeRange: preManualRange,
                    distance: '--',
                    duration:
                      this.formatDurationFromDisplayRange(preManualStart, preManualEnd) ||
                      this.formatDuration('00:00:00'),
                    note: 'This may vary due to traffic conditions',
                    isConflict: true,
                    conflictReason: 'Forced manual insertion after user confirmation.',
                  });
                }

                segments.push({
                  type: 'attraction' as const,
                  name: forcedName,
                  description: forcedMaster?.hotspot_description ?? '',
                  visitTime: conflictVisitTime,
                  duration: this.formatDuration((forcedMaster as any)?.hotspot_duration ?? null),
                  amount: null,
                  timings: '',
                  image: (hotspotGalleryMap.get(forcedHotspotId) ?? [])[0] ?? null,
                  galleryImages: hotspotGalleryMap.get(forcedHotspotId) ?? [],
                  videoUrl: forcedMaster?.hotspot_video_url ?? null,
                  planOwnWay: true,
                  activities: [],
                  hasAvailableActivities: false,
                  hotspotId: forcedHotspotId,
                  routeHotspotId: (forcedRow as any)?.route_hotspot_ID,
                  locationId: route.location_id ? Number(route.location_id) : null,
                  priority: Number((forcedMaster as any)?.hotspot_priority || 9999),
                  isConflict: true,
                  conflictReason: 'Forced manual insertion after user confirmation.',
                  isManual: true,
                  isDeleted: false,
                });

                insertedForcedManualConflictHotspotIds.add(forcedHotspotId);
                previousStopName = forcedName;
                fromName = forcedName;
                seenAttraction = true;
                emittedTravelBeforeFirstAttraction = true;
              }
            }

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

            const currentRowIndex = routeHotspots.indexOf(rh);
            const hasUpcomingHotelSegment =
              currentRowIndex >= 0 &&
              routeHotspots
                .slice(currentRowIndex + 1)
                .some((nextRow) => {
                  const nextType = Number((nextRow as any).item_type ?? 0);
                  return nextType === 5 || nextType === 6;
                });

            const routeHotelName = getRouteHotelName();
            const destinationCityLabel =
              route.next_visiting_location ??
              location?.destination_location ??
              null;

            // When this is the terminal city-level travel right before hotel rows,
            // prefer the resolved hotel name so travel + checkin are consistent.
            if (
              hasUpcomingHotelSegment &&
              Number(rh.hotspot_ID ?? 0) === 0 &&
              destinationCityLabel &&
              normalizeName(toName) === normalizeName(destinationCityLabel) &&
              normalizeName(routeHotelName) !== '' &&
              normalizeName(routeHotelName) !== 'hotel' &&
              normalizeName(routeHotelName) !== normalizeName(destinationCityLabel)
            ) {
              toName = routeHotelName;
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

            const resolvedDistanceKm = await this.resolveTravelDistanceKm({
              row: rh,
              itemType,
              location,
              route,
              semanticFromHotspotId:
                semanticMapping?.fromHotspotId
                ?? inferHotspotIdFromLabel(fromName)
                ?? null,
              semanticToHotspotId:
                semanticMapping?.toHotspotId
                ?? inferHotspotIdFromLabel(toName)
                ?? (Number(rh.hotspot_ID ?? 0) || null),
              fromName,
              toName,
              hotspotMap,
            });
            distanceNum = resolvedDistanceKm ?? 0;
            travelDistance = this.formatTravelDistance(resolvedDistanceKm);

            if (Number.isFinite(distanceNum) && distanceNum > 0) {
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

            if (!seenAttraction) {
              emittedTravelBeforeFirstAttraction = true;
            }

            previousStopName = toName;
          }
          continue;
        }

        if (itemType === 4) {
          // ATTRACTION / HOTSPOT visit
          if (!master || !master.hotspot_name?.trim()) {
            continue;
          }

          const isForcedManualConflictAttraction = isForcedManualConflictAttractionRow(rh);

          if (!isForcedManualConflictAttraction && !seenAttraction && !emittedTravelBeforeFirstAttraction) {
            const syntheticFrom = previousStopName?.trim() ||
              location?.source_location ||
              route.location_name ||
              plan.arrival_location ||
              '';
            const syntheticTo = master.hotspot_name?.trim() || '';

            const syntheticStart = this.formatTime((startHotspot as any)?.hotspot_start_time ?? null)
              || this.formatTime(route.route_start_time as any)
              || startTimeText;
            const syntheticEnd = startTimeText || syntheticStart;
            const syntheticRange = this.orderedTimeRange(syntheticStart, syntheticEnd);

            const startMins = syntheticStart ? this.timeToMinutes(syntheticStart) : 0;
            const endMins = syntheticEnd ? this.timeToMinutes(syntheticEnd) : startMins;
            const durationMins = Math.max(0, endMins - startMins);
            const durationH = Math.floor(durationMins / 60);
            const durationM = durationMins % 60;
            const durationHms = `${this.pad2(durationH)}:${this.pad2(durationM)}:00`;

            if (
              syntheticFrom &&
              syntheticTo &&
              normalizeName(syntheticFrom) !== normalizeName(syntheticTo)
            ) {
              pushHotspotAnchorPlaceholder({
                from: syntheticFrom,
                to: syntheticTo,
                timeRange: syntheticRange,
              });

              segments.push({
                type: 'travel' as const,
                from: syntheticFrom,
                to: syntheticTo,
                timeRange: syntheticRange,
                distance: '0.00 KM',
                duration: this.formatDuration(durationHms),
                note: 'This may vary due to traffic conditions',
                isConflict: false,
                conflictReason: null,
              });
            }

            emittedTravelBeforeFirstAttraction = true;
          }

          if (index === routes.length - 1) {
            const attractionEndMins = endTimeText ? this.timeToMinutes(endTimeText) : 0;
            const overrunDropOffRow = routeHotspots.find((candidate: any) => {
              const candidateType = Number((candidate as any).item_type ?? 0);
              if (candidateType !== 7) return false;

              const candidateStartText = this.formatTime((candidate as any).hotspot_start_time ?? null);
              const candidateEndText = this.formatTime((candidate as any).hotspot_end_time ?? null);
              const candidateStartMins = candidateStartText ? this.timeToMinutes(candidateStartText) : 0;
              const candidateEndMins = candidateEndText ? this.timeToMinutes(candidateEndText) : 0;

              return candidateStartMins === attractionEndMins && candidateEndMins > routeEndMins;
            });

            if (overrunDropOffRow) {
              suppressedLastRouteOrders.add(Number((rh as any).hotspot_order || 0));
              continue;
            }
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

          if (isForcedManualConflictAttraction) {
            // These rows are rendered via the synthetic sequence injected before regular travel.
            // Skipping raw rows here prevents duplicate conflict attractions in timeline output.
            continue;
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

          const entryTicket = buildEntryTicketBreakdown({
            dayNumber: index + 1,
            date: route.itinerary_route_date,
            locationId: Number(route.location_id || 0),
            locationName: master.hotspot_name,
            routeHotspot: { ...rh, ...master },
            persistedRows: entryTicketRowsByRouteHotspotId.get(Number(rh.route_hotspot_ID || 0)),
            adults: Number(plan.total_adult || 0),
            children: Number(plan.total_children || 0),
            infants: Number(plan.total_infants || 0),
            nationality: Number(plan.nationality || 0),
            entryTicketRequired: Number(plan.entry_ticket_required || 0) === 1,
          });
          if (entryTicket) entryTicketBreakdown.push(entryTicket);

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

          if (!isForcedManualConflictAttraction) {
            previousStopName = master.hotspot_name;
            seenAttraction = true;
          }

          continue;
        }

        if (itemType === 5) {
          // TRAVEL TO HOTEL segment
          // Derive origin by chronology (latest attraction that ended at/before this travel start).
          // Do NOT rely on row order; route rows are grouped by hotspot_order/item_type and can
          // place future attractions before this travel-to-hotel row in the array.
          
          const hotelInfo = routeHotelMap.get(route.itinerary_route_ID);
          const toName =
            isVehicleOnly
              ? 'Hotel'
              : (
                hotelInfo?.hotel_name ??
                hotelInfo?.hotel_city ??
                location?.destination_location ??
                route.next_visiting_location ??
                'Hotel'
              );

          const normalizeLabel = (value?: string | null) =>
            String(value ?? '').trim().toLowerCase();
          const sourceCityName = location?.source_location ?? route.location_name ?? '';
          const destinationCityName = location?.destination_location ?? route.next_visiting_location ?? '';
          const isSameCityRoute =
            normalizeLabel(sourceCityName) !== '' &&
            normalizeLabel(sourceCityName) === normalizeLabel(destinationCityName);
          const isCityFallbackDestination =
            !hotelInfo?.hotel_name &&
            normalizeLabel(toName) !== '' &&
            normalizeLabel(toName) === normalizeLabel(destinationCityName);

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

          // Only suppress same-city hotel travel when the segment collapses into a redundant
          // city-to-same-city label because the hotel could not be resolved beyond the city name.
          if (
            isSameCityRoute &&
            isCityFallbackDestination &&
            normalizeLabel(fromName) !== '' &&
            normalizeLabel(fromName) === normalizeLabel(toName)
          ) {
            continue;
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

            const sameTimeRange = startMins === endMins;
            if (sameTimeRange) {
              const derivedRange = this.getTravelTimeRangeWithDuration(startTimeText, endTimeText, travelDuration);
              if (derivedRange) {
                travelToHotelTimeRange = derivedRange;
                const parts = derivedRange.split(' - ');
                if (parts.length === 2) {
                  hotelArrivalTime = parts[1].trim();
                }
              }
            }
          }

          segments.push({
            type: "travel" as const,
            from: fromName,
            to: toName,
            timeRange: travelToHotelTimeRange,
            distance: travelDistance,
            duration:
              this.formatDurationFromDisplayRange(startTimeText, endTimeText) ??
              this.formatDuration(travelDuration),
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
            isVehicleOnly
              ? 'Hotel'
              : (
                hotelInfo?.hotel_name ??
                hotelInfo?.hotel_city ??
                location?.destination_location ??
                route.next_visiting_location ??
                'Hotel'
              );
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
          emittedTerminalSegment = true;

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
            timeRange: this.getTravelTimeRangeWithDuration(startTimeText, endTimeText, travelDuration),
            distance: travelDistance,
            duration: this.formatDuration(travelDuration),
            note: 'This may vary due to traffic conditions',
            isConflict: (rh as any).isConflict === true,
            conflictReason: (rh as any).conflictReason ?? null,
          });
          emittedTerminalSegment = true;

          previousStopName = toName;
          continue;
        }
      }

      // RETURN block at the end of the day (only if no item_type 6 or 7 exists)
      const hasReturnOrDropOff = emittedTerminalSegment;
      const dayStartTimeText = this.formatTime(route.route_start_time as any);
      const dayEndTimeText = this.formatTime(route.route_end_time as any);
      const terminalDestinationName = String(
        route.next_visiting_location ??
        plan.departure_location ??
        'Departure Point',
      ).trim();
      const isTerminalDeparture =
        /(airport|air\s*port|railway|rail\s*way|station|bus\s*stand|bus\s*station|terminal|terminus|junction|stn)\b/i
          .test(terminalDestinationName);

      if (!hasReturnOrDropOff) {
        if (isTerminalDeparture) {
          segments.push({
            type: 'travel' as const,
            from: previousStopName,
            to: terminalDestinationName,
            timeRange:
              dayStartTimeText && dayEndTimeText
                ? `${dayStartTimeText} -> ${dayEndTimeText}`
                : dayEndTimeText || dayStartTimeText || '',
            distance: this.formatTravelDistance(Number(route.no_of_km ?? 0) || null),
            duration:
              dayStartTimeText && dayEndTimeText
                ? this.formatDurationFromDisplayRange(dayStartTimeText, dayEndTimeText) ??
                  this.formatDuration('00:00:00')
                : this.formatDuration('00:00:00'),
            note: 'Airport transfer',
            isConflict: false,
            conflictReason: null,
          });
        } else {
          segments.push({
            type: 'return' as const,
            time: dayEndTimeText,
            note: null,
          });
        }
      }




// ================= FIXED DISTANCE CALCULATION =================

// Fetch via routes FIRST
const viaRoutes = await this.prisma.dvi_itinerary_via_route_details.findMany({
  where: {
    itinerary_plan_ID: planId,
    itinerary_route_ID: route.itinerary_route_ID,
    deleted: 0,
  },
  orderBy: { itinerary_via_route_ID: 'asc' },
});

const viaRoutesList = viaRoutes.map((vr) => ({
  id: Number(vr.itinerary_via_location_ID),
  name: String(vr.itinerary_via_location_name || '').trim(),
}));

const storedIntercityDistanceNum =
  parseFloat(String((route as any).no_of_km ?? 0)) || 0;

const sourceName =
  location?.source_location ??
  route.location_name ??
  plan.arrival_location ??
  '';

const destinationName =
  location?.destination_location ??
  route.next_visiting_location ??
  plan.departure_location ??
  '';

// Build FULL route chain
const routeChain = [
  sourceName,
  ...viaRoutesList.map((v) => v.name),
  destinationName,
]
  .map((v) => String(v || '').trim())
  .filter(Boolean);

// Remove duplicates (VERY IMPORTANT FIX)
const cleanedRouteChain = routeChain.filter(
  (value, index, self) =>
    index === 0 || value.toLowerCase() !== self[index - 1].toLowerCase()
);

let viaRouteDistanceNum = 0;

for (let i = 0; i < cleanedRouteChain.length - 1; i++) {
  const from = cleanedRouteChain[i];
  const to = cleanedRouteChain[i + 1];

  // Try exact match first
  let storedRoute = await this.prisma.dvi_stored_locations.findFirst({
    where: {
      deleted: 0,
      source_location: from,
      destination_location: to,
    } as any,
  });

  // Try reverse match
  if (!storedRoute) {
    storedRoute = await this.prisma.dvi_stored_locations.findFirst({
      where: {
        deleted: 0,
        source_location: to,
        destination_location: from,
      } as any,
    });
  }

  const segmentKm =
    parseFloat(
      String(
        (storedRoute as any)?.distance ??
          (storedRoute as any)?.no_of_km ??
          (storedRoute as any)?.location_distance ??
          0
      )
    ) || 0;

  viaRouteDistanceNum += segmentKm;
}



// Sightseeing distance
// Sightseeing distance
const vehicleKmForRoute = vehicleKmByRouteId.get(
  Number(route.itinerary_route_ID || 0)
);

const sightseeingDistanceNum = Number(vehicleKmForRoute?.sightseeingKm || 0);

// Fallback travel segment distance
const travelSegmentDistanceNum = segments.reduce((sum, segment: any) => {
  if (segment?.type !== 'travel') return sum;

  const distanceNum =
    parseFloat(String(segment?.distance ?? '').replace(/[^0-9.]/g, '')) || 0;

  return sum + distanceNum;
}, 0);

// FINAL intercity distance priority:
// 1. VIA-chain distance
// 2. stored route.no_of_km
// 3. visible travel segment total
const intercityDistanceNum =
  viaRouteDistanceNum > 0
    ? viaRouteDistanceNum
    : storedIntercityDistanceNum > 0
      ? storedIntercityDistanceNum
      : travelSegmentDistanceNum;

// Total day distance = intercity + sightseeing
const totalDistanceNum = intercityDistanceNum + sightseeingDistanceNum;

const intercityDistance = this.formatKm(intercityDistanceNum);
const sightseeingDistance = this.formatKm(sightseeingDistanceNum);
const dayDistance = this.formatKm(totalDistanceNum);


// DEBUG (keep this for testing)
console.log('[FINAL_DISTANCE_DEBUG]', {
  routeChain: cleanedRouteChain,
  viaRouteDistanceNum,
  storedIntercityDistanceNum,
  finalUsed: intercityDistanceNum,
});

// ================= END FIX =================



      // FIX #1: Sort segments chronologically.
      // Strategy:
      //   1. Lift out all anchor CTAs (type=hotspot) along with the index of the segment they
      //      were inserted after (their preceding non-CTA neighbour index in the unsorted list).
      //   2. Sort only the non-CTA segments by time.
      //   3. Re-insert each CTA immediately after the sorted position of its preceding neighbour.
      // This guarantees: Travel → Attraction → CTA → Travel → Attraction → CTA → …

      // Step 1: extract CTAs and remember which non-CTA segment each followed.
      const orderedSegments = this.segmentOrderingService.order(segments, {
        parseDisplayTimeMinutesStrict: (value) => this.parseDisplayTimeMinutesStrict(value),
        normalizeName,
      });
      segments.length = 0;
      segments.push(...orderedSegments);

      // In hotel-first flows, place start before check-in
      // so the sequence reads: travel to hotel -> Start your Journey -> checkin.
      const routeHotelNameForDay = getRouteHotelName();
      this.hotelFirstPolicyService.apply({
        segments,
        routeHotelName: routeHotelNameForDay,
        normalizeName,
        timeToMinutes: (value) => this.timeToMinutes(value),
      });

      // Final response-level sanitizer: prevent excluded hotspots and no-op travels from leaking.
      const excludedIds = new Set<number>(
        Array.isArray((route as any)?.excluded_hotspot_ids)
          ? (route as any).excluded_hotspot_ids
              .map((id: any) => Number(id))
              .filter((id: number) => Number.isFinite(id) && id > 0)
          : [],
      );
      const sanitizeSegments = (rows: any[]): any[] =>
        this.segmentSanitizerService.sanitize({
          segments: rows,
          excludedIds,
          hotspotMap,
          normalizePlaceLabel: (value) => this.normalizePlaceLabel(value),
          isGenericHotelLabel: (value) => this.isGenericHotelLabel(value),
          isSamePlaceLike: (a, b) => this.isSamePlaceLike(a, b),
        });
      segments.splice(0, segments.length, ...sanitizeSegments(segments));

      this.normalizeConfirmedTravelLabelsFromSequence(
        segments,
        routeHotelNameForDay,
      );
      segments.splice(0, segments.length, ...sanitizeSegments(segments));

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
  distance: dayDistance,
intercityDistance,
sightseeingDistance,       // local sightseeing separately
  startTime: dayStartTimeText,
  endTime: dayEndTimeText,
  viaRoutes: viaRoutesList,
  needsRebuild: excludedIds.size > 0,
  excludedHotspotIds: Array.from(excludedIds.values()),
  segments,
});
    }
    stepStartedAt = this.logItineraryApiTiming({
      api: 'itinerary_details',
      planId,
      quoteId,
      step: 'hotspot_details_lookup_and_timeline_build',
      startedAt: apiStartedAt,
      stepStartedAt,
    });

    const shouldIncludeVehicles = itineraryPreference === 2 || itineraryPreference === 3;

    // ------------------------------ VEHICLES ------------------------------
    // PHP displays vehicles directly from dvi_itinerary_plan_vendor_eligible_list
    // Each row in eligible list is already aggregated per vendor/branch/type/origin
    const rawEligibleRows = shouldIncludeVehicles
      ? await this.prisma.dvi_itinerary_plan_vendor_eligible_list.findMany({
          where: { itinerary_plan_id: planId, status: 1, deleted: 0 },
          orderBy: { itinerary_plan_vendor_eligible_ID: 'asc' },
        })
      : [];

    const eligibleGroups = new Map<string, any[]>();
    for (const eligibleRow of rawEligibleRows) {
      const offerKey = buildVehicleOfferKey(eligibleRow);
      const existingRows = eligibleGroups.get(offerKey) || [];
      existingRows.push(eligibleRow);
      eligibleGroups.set(offerKey, existingRows);
    }

    const eligibleGroupMetaByRepresentativeId = new Map<
      number,
      {
        eligibleIds: number[];
        vehicleIds: number[];
        rawRowCount: number;
      }
    >();
    let eligibleRows = Array.from(eligibleGroups.values()).map((groupRows) => {
      const representative = [...groupRows].sort(
        (a, b) =>
          Number((b as any).itineary_plan_assigned_status || 0) -
            Number((a as any).itineary_plan_assigned_status || 0) ||
          Number((a as any).itinerary_plan_vendor_eligible_ID || 0) -
            Number((b as any).itinerary_plan_vendor_eligible_ID || 0),
      )[0];
      const representativeId = Number(
        (representative as any).itinerary_plan_vendor_eligible_ID || 0,
      );
      if (representativeId > 0) {
        eligibleGroupMetaByRepresentativeId.set(representativeId, {
          eligibleIds: groupRows
            .map((row: any) => Number(row?.itinerary_plan_vendor_eligible_ID || 0))
            .filter((id: number) => id > 0),
          vehicleIds: Array.from(
            new Set(
              groupRows
                .map((row: any) => Number(row?.vehicle_id || 0))
                .filter((id: number) => id > 0),
            ),
          ),
          rawRowCount: groupRows.length,
        });
      }
      return representative;
    });

    const dedupedEligibleCount = eligibleRows.length;
    const {
      rows: activeEligibleRows,
    } = shouldIncludeVehicles
      ? await filterActiveVendorCandidateRows<any>(this.prisma, eligibleRows as any[])
      : { rows: [] as any[] };
    eligibleRows = activeEligibleRows;

    const assignedEligibleRows = activeEligibleRows.filter(
      (e) => (e as any).itineary_plan_assigned_status === 1,
    );
    const debugVehicleTrace =
      process.env.DEBUG_DVI20260594_INSERT === 'true' ||
      process.env.DEBUG_VEHICLE_DUPLICATE_TRACE === 'true';
    if (debugVehicleTrace) {
      console.log('[DETAILS_VEHICLE_ELIGIBLE_ROWS]', {
        planId,
        rawCount: rawEligibleRows.length,
        dedupedCount: dedupedEligibleCount,
        activeCount: activeEligibleRows.length,
        rows: activeEligibleRows.map((x: any) => ({
          eligibleId: Number(x.itinerary_plan_vendor_eligible_ID || 0),
          vehicleTypeId: Number(x.vehicle_type_id || 0),
          vendorVehicleTypeId: Number(x.vendor_vehicle_type_id || 0),
          vehicleId: Number(x.vehicle_id || 0),
          assignedStatus: Number(x.itineary_plan_assigned_status || 0),
          deleted: Number(x.deleted || 0),
          status: Number(x.status || 0),
        })),
      });
    }
    let kmLimitWarning: string | undefined;

    // Fetch all vehicle type names to map vehicleTypeId -> vehicleTypeName
    const vehicleTypeIds = Array.from(
      new Set(activeEligibleRows.map(r => (r as any).vehicle_type_id).filter(Boolean))
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

    const rawVehicleDetailsRows = allEligibleIds.length
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

    const vehicleDetailRowsByKey = new Map<string, any>();
    for (const vehicleDetailRow of rawVehicleDetailsRows) {
      const detailKey = buildVehicleDetailKey(vehicleDetailRow);
      const existingRow = vehicleDetailRowsByKey.get(detailKey);
      if (
        !existingRow ||
        Number((vehicleDetailRow as any).itinerary_plan_vendor_vehicle_details_ID || 0) <
          Number((existingRow as any).itinerary_plan_vendor_vehicle_details_ID || 0)
      ) {
        vehicleDetailRowsByKey.set(detailKey, vehicleDetailRow);
      }
    }
    const vehicleDetailsRows = Array.from(vehicleDetailRowsByKey.values()).sort((a, b) => {
      const dateA = toSortableDateTime((a as any).itinerary_route_date);
      const dateB = toSortableDateTime((b as any).itinerary_route_date);
      if (dateA !== dateB) return dateA - dateB;
      return (
        Number((a as any).itinerary_route_id || 0) -
        Number((b as any).itinerary_route_id || 0)
      );
    });

    // Group vehicle details by eligible ID to sum KMs
    const vehicleDetailsByEligible = new Map<number, any[]>();
    for (const vd of vehicleDetailsRows) {
      const eligibleId = (vd as any).itinerary_plan_vendor_eligible_ID;
      if (!vehicleDetailsByEligible.has(eligibleId)) {
        vehicleDetailsByEligible.set(eligibleId, []);
      }
      vehicleDetailsByEligible.get(eligibleId)!.push(vd);
    }
    if (debugVehicleTrace) {
      for (const [eligibleId, rows] of vehicleDetailsByEligible.entries()) {
        const dupMap = new Map<string, number>();
        for (const row of rows) {
          const key = `${Number((row as any).itinerary_plan_vendor_eligible_ID || 0)}_${Number((row as any).itinerary_route_id || 0)}`;
          dupMap.set(key, (dupMap.get(key) || 0) + 1);
        }
        const duplicateKeys = Array.from(dupMap.entries())
          .filter(([, c]) => c > 1)
          .map(([k, c]) => ({ key: k, rowCount: c }));
        console.log('[DETAILS_VEHICLE_DETAIL_ROWS]', {
          planId,
          eligibleId,
          rawRowCount: rawVehicleDetailsRows.filter(
            (row: any) =>
              Number((row as any).itinerary_plan_vendor_eligible_ID || 0) === Number(eligibleId || 0),
          ).length,
          dedupedRowCount: rows.length,
          duplicateKeys,
        });
      }
    }
    stepStartedAt = this.logItineraryApiTiming({
      api: 'itinerary_details',
      planId,
      quoteId,
      step: 'vehicle_details_lookup',
      startedAt: apiStartedAt,
      stepStartedAt,
    });

    const calculateVehicleKmTotals = (rows: any[]) => {
      let totalPickupKm = 0;
      let totalTravelKm = 0;
      let totalSightseeingKm = 0;
      let totalDropKm = 0;
      let routeBadgeKmTotal = 0;
      let vehicleComponentKmTotal = 0;

      for (const vd of rows) {
        const travelKm = parseFloat(String((vd as any).total_running_km || 0)) || 0;
        const sightseeingKm = parseFloat(String((vd as any).total_siteseeing_km || 0)) || 0;
        const dbTotalKm = parseFloat(String((vd as any).total_travelled_km || 0)) || 0;
        const pickupKm = parseFloat(String((vd as any).total_pickup_km || 0)) || 0;
        const dropKm = parseFloat(String((vd as any).total_drop_km || 0)) || 0;

        const expectedTotalKm = Number((pickupKm + travelKm + sightseeingKm + dropKm).toFixed(2));

        totalPickupKm += pickupKm;
        totalTravelKm += travelKm;
        totalSightseeingKm += sightseeingKm;
        totalDropKm += dropKm;
        routeBadgeKmTotal += dbTotalKm > 0 ? dbTotalKm : Number((travelKm + sightseeingKm).toFixed(2));
        vehicleComponentKmTotal += expectedTotalKm;
      }

      return {
        totalPickupKm,
        totalTravelKm,
        totalSightseeingKm,
        totalDropKm,
        routeBadgeKmTotal,
        vehicleComponentKmTotal,
      };
    };

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

    const viaRouteRows = routeIds.length
      ? await this.prisma.dvi_itinerary_via_route_details.findMany({
          where: {
            itinerary_plan_ID: Number(planId || 0),
            itinerary_route_ID: { in: routeIds },
            status: 1,
            deleted: 0,
          },
          orderBy: { itinerary_via_route_ID: 'asc' },
          select: {
            itinerary_route_ID: true,
            itinerary_via_location_name: true,
          },
        })
      : [];
    const viaNamesByRouteId = new Map<number, string[]>();
    for (const viaRow of viaRouteRows) {
      const routeId = Number((viaRow as any).itinerary_route_ID || 0);
      if (!routeId) continue;
      const viaName = String((viaRow as any).itinerary_via_location_name || '').trim();
      if (!viaName) continue;
      if (!viaNamesByRouteId.has(routeId)) {
        viaNamesByRouteId.set(routeId, []);
      }
      viaNamesByRouteId.get(routeId)!.push(viaName);
    }

    const vehicleIds = Array.from(
      new Set(
        [
          ...eligibleRows.map((eligible: any) => Number(eligible.vehicle_id || 0)),
          ...vehicleDetailsRows.map((vd: any) => Number(vd.vehicle_id || 0)),
        ]
          .filter((id: number) => id > 0)
      ),
    );

    const vehicleMasterRows = vehicleIds.length
      ? await this.prisma.dvi_vehicle.findMany({
          where: { vehicle_id: { in: vehicleIds }, deleted: 0, status: 1 },
          select: { vehicle_id: true, registration_number: true, extra_hour_charge: true },
        })
      : [];
    const vehicleInfoMap = new Map<number, { vehicleId: number; registrationNumber: string | null; extraHourCharge: number }>(
      vehicleMasterRows.map((v: any) => [
        Number(v.vehicle_id || 0),
        {
          vehicleId: Number(v.vehicle_id || 0),
          registrationNumber: String(v.registration_number || '').trim() || null,
          extraHourCharge: Number(v.extra_hour_charge || 0),
        },
      ]),
    );
    const vehicleExtraHourRateMap = new Map<number, number>(
      vehicleMasterRows.map((v: any) => [Number(v.vehicle_id || 0), Number(v.extra_hour_charge || 0)]),
    );

    const vehicleRegistrationStateCodes = Array.from(
      new Set(
        vehicleMasterRows
          .map((vehicle: any) => String(vehicle.registration_number || '').trim())
          .filter(Boolean)
          .map((registrationNumber: string) => registrationNumber.substring(0, 2).toUpperCase())
          .filter((code: string) => code.length > 0),
      ),
    );
    const permitStates = vehicleRegistrationStateCodes.length
      ? await (this.prisma as any).dvi_permit_state.findMany({
          where: {
            state_code: { in: vehicleRegistrationStateCodes },
            deleted: 0,
            status: 1,
          },
          select: {
            state_code: true,
            state_name: true,
          },
        })
      : [];
    const permitStateByCode = new Map<string, { state_name: string | null }>(
      permitStates.map((state: any) => [
        String(state.state_code || '').trim().toUpperCase(),
        { state_name: String(state.state_name || '').trim() || null },
      ]),
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
    const branchCityIds = Array.from(
      new Set(
        branches
          .map((branch: any) => Number(branch.vendor_branch_city || 0))
          .filter((id: number) => id > 0),
      ),
    );
    const branchCityNameMap = new Map<number, string>(
      (
        branchCityIds.length
          ? await this.prisma.dvi_cities.findMany({
              where: {
                id: { in: branchCityIds },
                deleted: 0,
              } as any,
              select: {
                id: true,
                name: true,
              },
            } as any)
          : []
      ).map((row: any) => [Number(row.id || 0), String(row.name || '').trim()]),
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
    const slabInfoByTimeLimit = new Map<number, { title: string; hoursLimit: number; kmLimit: number }>();
    const maxSlabByKey = new Map<string, { timeLimitId: number; hoursLimit: number; kmLimit: number }>();
    const slabHoursById = new Map<number, number>();
    for (const slab of slabRows) {
      const slabIdNum = Number(slab.time_limit_id || 0);
      const hoursLimitNum = Number(slab.hours_limit || 0);
      if (slabIdNum > 0 && !slabHoursById.has(slabIdNum)) {
        slabHoursById.set(slabIdNum, hoursLimitNum);
      }
      const key = `${Number(slab.vendor_id || 0)}_${Number(slab.vendor_vehicle_type_id || 0)}`;
      const effectiveKmLimit = getEffectiveTimeLimitKm(slab);
      if (!slabMap.has(key)) slabMap.set(key, []);
      slabMap.get(key)!.push({
        timeLimitId: slabIdNum,
        title: String(slab.time_limit_title || '').trim() || `${Number(slab.hours_limit || 0)} HRS ${Number(slab.km_limit || 0)} KMS`,
        hoursLimit: hoursLimitNum,
        kmLimit: effectiveKmLimit,
      });
      slabInfoByTimeLimit.set(slabIdNum, {
        title: String(slab.time_limit_title || '').trim() || `${Number(slab.hours_limit || 0)} HRS ${Number(slab.km_limit || 0)} KMS`,
        hoursLimit: hoursLimitNum,
        kmLimit: effectiveKmLimit,
      });

      const existingMax = maxSlabByKey.get(key);
      const kmLimitNum = effectiveKmLimit;
      if (
        !existingMax ||
        hoursLimitNum > existingMax.hoursLimit ||
        (hoursLimitNum === existingMax.hoursLimit && kmLimitNum > existingMax.kmLimit) ||
        (hoursLimitNum === existingMax.hoursLimit && kmLimitNum === existingMax.kmLimit && slabIdNum > existingMax.timeLimitId)
      ) {
        maxSlabByKey.set(key, {
          timeLimitId: slabIdNum,
          hoursLimit: hoursLimitNum,
          kmLimit: kmLimitNum,
        });
      }
    }

    const kmsLimitIds = Array.from(
      new Set(
        vehicleDetailsRows
          .map((vd: any) => Number(vd.kms_limit_id || 0))
          .filter((id: number) => id > 0),
      ),
    );
    const kmsLimitRows = kmsLimitIds.length
      ? await this.prisma.dvi_kms_limit.findMany({
          where: {
            kms_limit_id: { in: kmsLimitIds },
            status: 1,
            deleted: 0,
          },
          select: {
            kms_limit_id: true,
            kms_limit_title: true,
            kms_limit: true,
          },
        })
      : [];
    const kmsLimitInfoById = new Map<number, { title: string; kmLimit: number }>(
      kmsLimitRows.map((row: any) => [
        Number(row.kms_limit_id || 0),
        {
          title: String(row.kms_limit_title || '').trim() || `${Number(row.kms_limit || 0)} KMS`,
          kmLimit: Number(row.kms_limit || 0),
        },
      ]),
    );

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
      const totalTimeSecondsDirect = parseTimeToSeconds(vd.total_travelled_time);
      const totalTimeSecondsFromParts =
        (parseTimeToSeconds(vd.total_pickup_duration) || 0) +
        (parseTimeToSeconds(vd.total_running_time) || 0) +
        (parseTimeToSeconds(vd.total_siteseeing_time) || 0) +
        (parseTimeToSeconds(vd.total_drop_duration) || 0);
      const totalTimeSeconds =
        totalTimeSecondsDirect !== null
          ? totalTimeSecondsDirect
          : (totalTimeSecondsFromParts > 0 ? totalTimeSecondsFromParts : null);
      if (totalTimeSeconds === null) return { count: 0, rate: 0, charge: 0 };
      const serviceHours = totalTimeSeconds / 3600;

      const slabHours = Number(slabHoursById.get(Number(vd.time_limit_id || 0)) || 0);
      const rate = Number(vehicleExtraHourRateMap.get(Number(vd.vehicle_id || 0)) || 0);
      if (slabHours <= 0 || rate <= 0 || serviceHours <= slabHours) return { count: 0, rate, charge: 0 };
      const count = Math.max(0, Math.ceil((serviceHours - slabHours) * 2) / 2);
      return { count, rate, charge: count * rate };
    };

    const tollBreakupCache = new Map<string, string[]>();
    const getTollBreakupForRow = async (eligible: any, vd: any): Promise<string[]> => {
      const routeId = Number((vd as any).itinerary_route_id || 0);
      const vehicleTypeId = Number((vd as any).vehicle_type_id || 0);
      const cacheKey = `${routeId}_${vehicleTypeId}`;
      if (!routeId || !vehicleTypeId) return [];
      if (tollBreakupCache.has(cacheKey)) return tollBreakupCache.get(cacheKey) || [];

      const viaRows = await (this.prisma as any).dvi_itinerary_via_route_details.findMany({
        where: {
          itinerary_plan_ID: Number(planId || 0),
          itinerary_route_ID: routeId,
          status: 1,
          deleted: 0,
        },
        orderBy: { itinerary_via_route_ID: 'asc' },
        select: { itinerary_via_location_name: true },
      });

      const viaRouteNames = viaRows
        .map((r: any) => String(r?.itinerary_via_location_name || '').trim())
        .filter(Boolean);

      const routeToll = await calculateRouteTollCharges(
        this.prisma,
        vehicleTypeId,
        String((vd as any).itinerary_route_location_from || ''),
        String((vd as any).itinerary_route_location_to || ''),
        viaRouteNames,
      );

      const routeFrom = String((vd as any).itinerary_route_location_from || '').trim();
      const routeTo = String((vd as any).itinerary_route_location_to || '').trim();
      const routePairLabel = `${routeFrom} → ${routeTo}`;
      const storedToll = Number((vd as any).vehicle_toll_charges || 0);
      const computedBreakupTotal = Number((routeToll.breakup || []).reduce((sum: number, item: any) => {
        return sum + Number(item?.charge || 0);
      }, 0));

      let breakupForDisplay = (routeToll.breakup || []).map((item: any) => ({
        label: String(item?.label || '').includes('→') ? String(item?.label || '').trim() : routePairLabel,
        charge: Number(item?.charge || 0),
      }));
      if (
        storedToll > 0 &&
        (breakupForDisplay.length === 0 || Math.abs(computedBreakupTotal - storedToll) > 0.01)
      ) {
        breakupForDisplay = [{ label: routePairLabel, charge: storedToll }];
      }

      const uniqueFormatted = breakupForDisplay
        .map((item) => `${item.label} - ₹ ${Number(item.charge || 0).toFixed(2)}`)
        .filter(Boolean);

      tollBreakupCache.set(cacheKey, uniqueFormatted);
      return uniqueFormatted;
    };

    const tollBreakupByRouteId = new Map<string, string[]>();
    const tollBreakupTasks: Promise<void>[] = [];
    for (const eligible of eligibleRows) {
      const eligibleId = Number((eligible as any).itinerary_plan_vendor_eligible_ID || 0);
      const dayWiseDetailsForEligible = vehicleDetailsByEligible.get(eligibleId) || [];
      const uniqueDayRows = dayWiseDetailsForEligible.filter((vd: any, index: number, all: any[]) => {
        const routeId = Number((vd as any).itinerary_route_id || 0);
        return routeId > 0 && index === all.findIndex((item: any) => Number(item?.itinerary_route_id || 0) === routeId);
      });

      for (const vd of uniqueDayRows) {
        tollBreakupTasks.push((async () => {
          const routeId = Number((vd as any).itinerary_route_id || 0);
          const cacheKey = `${routeId}_${Number((vd as any).vehicle_type_id || 0)}`;
          if (!routeId || tollBreakupByRouteId.has(cacheKey)) return;
          tollBreakupByRouteId.set(cacheKey, await getTollBreakupForRow(eligible, vd));
        })());
      }
    }
    if (tollBreakupTasks.length > 0) {
      await Promise.all(tollBreakupTasks);
    }

    const parkingBreakupRows = routeIds.length
      ? await this.prisma.$queryRawUnsafe(`
          SELECT
            pc.itinerary_route_ID AS itinerary_route_id,
            pc.vehicle_type AS vehicle_type_id,
            pc.hotspot_ID AS hotspot_id,
            COALESCE(hp.hotspot_name, '') AS hotspot_name,
            pc.parking_charges_amt AS parking_charge
          FROM dvi_itinerary_route_hotspot_parking_charge pc
          LEFT JOIN dvi_hotspot_place hp
            ON hp.hotspot_ID = pc.hotspot_ID
          WHERE pc.itinerary_plan_ID = ${planId}
            AND pc.deleted = 0
            AND pc.status = 1
            AND pc.itinerary_route_ID IN (${routeIds.join(",")})
          ORDER BY pc.itinerary_route_ID ASC, pc.vehicle_type ASC, pc.hotspot_ID ASC
        `) as any[]
      : [];

    const parkingBreakupByRouteId = new Map<string, string[]>();
    for (const row of parkingBreakupRows) {
      const routeId = Number((row as any).itinerary_route_id || 0);
      const vehicleTypeId = Number((row as any).vehicle_type_id || 0);
      if (!routeId || !vehicleTypeId) continue;

      const hotspotId = Number((row as any).hotspot_id || 0);
      const hotspotName = String((row as any).hotspot_name || '').trim();
      const charge = Number((row as any).parking_charge || 0);
      if (charge <= 0) continue;

      const key = `${routeId}_${vehicleTypeId}`;
      const formatted = `${hotspotName || `Hotspot #${hotspotId}`} - ₹ ${charge.toFixed(2)}`;
      const existing = parkingBreakupByRouteId.get(key) || [];
      if (!existing.includes(formatted)) {
        parkingBreakupByRouteId.set(key, [...existing, formatted]);
      }
    }

    // Build vehicles array directly from eligible list (like PHP does)
    const allVehicles: ItineraryVehicleRowDto[] = activeEligibleRows.map((eligible) => {
      const branchId = (eligible as any).vendor_branch_id ?? 0;
      const branch = branchMap.get(branchId) || null;
      const branchCityName = branch
        ? branchCityNameMap.get(Number((branch as any).vendor_branch_city || 0)) || ''
        : '';
      const vehicleTypeId = (eligible as any).vehicle_type_id ?? 0;
      const eligibleVehicleId = Number((eligible as any).vehicle_id || 0) || null;
      const vehicleInfo = eligibleVehicleId ? vehicleInfoMap.get(eligibleVehicleId) : undefined;
      const registrationNumber = String(vehicleInfo?.registrationNumber || '').trim();
      const vehicleRegistrationStateCode = registrationNumber
        ? registrationNumber.substring(0, 2).toUpperCase()
        : null;
      const origin = ((eligible as any).vehicle_orign ?? '').toString().trim();
      
      const qty = (eligible as any).total_vehicle_qty ?? 0;
      const totalAmount = (eligible as any).vehicle_grand_total ?? 0;

      // Get all charge breakdowns
      let rentalCharges = Number((eligible as any).total_rental_charges ?? 0);
      let tollCharges = Number((eligible as any).total_toll_charges ?? 0);
      let parkingCharges = Number((eligible as any).total_parking_charges ?? 0);
      let driverCharges = Number((eligible as any).total_driver_charges ?? 0);
      let permitCharges = Number((eligible as any).total_permit_charges ?? 0);
      const before6amDriver = (eligible as any).total_before_6_am_charges_for_driver ?? 0;
      const before6amVendor = (eligible as any).total_before_6_am_charges_for_vehicle ?? 0;
      const after8pmDriver = (eligible as any).total_after_8_pm_charges_for_driver ?? 0;
      const after8pmVendor = (eligible as any).total_after_8_pm_charges_for_vehicle ?? 0;
      let extraHourCharge = 0;

      // Calculate aggregated KMs from day-wise vehicle details
      const eligibleId = eligible.itinerary_plan_vendor_eligible_ID;
      const groupedVehicleMeta = eligibleGroupMetaByRepresentativeId.get(
        Number(eligibleId || 0),
      );
      const groupedVehicleIds = groupedVehicleMeta?.vehicleIds || [];
      const groupedVehicleNumbers = Array.from(
        new Set(
          groupedVehicleIds
            .map((vehicleId) => String(vehicleInfoMap.get(vehicleId)?.registrationNumber || '').trim())
            .filter(Boolean),
        ),
      );
      const dayWiseDetails = vehicleDetailsByEligible.get(eligibleId) || [];
      const hasLocalDays = dayWiseDetails.some((vd: any) => Number((vd as any).travel_type || 0) === 1);
      const hasOutstationDays = dayWiseDetails.some((vd: any) => Number((vd as any).travel_type || 0) === 2);
      const localTrip = hasLocalDays && !hasOutstationDays;
      const mixedTrip = hasLocalDays && hasOutstationDays;
      const selectedTimeLimitId = dayWiseDetails.length
        ? Number((dayWiseDetails[0] as any).time_limit_id || 0)
        : 0;
      const slabKey = `${Number((eligible as any).vendor_id || 0)}_${Number((eligible as any).vendor_vehicle_type_id || 0)}`;
      const availableSlabs = slabMap.get(slabKey) || [];

      const vehicleKmTotals = calculateVehicleKmTotals(dayWiseDetails);
      const totalPickupKm = vehicleKmTotals.totalPickupKm;
      const totalTravelKm = vehicleKmTotals.totalTravelKm;
      const totalSightseeingKm = vehicleKmTotals.totalSightseeingKm;
      const totalDropKm = vehicleKmTotals.totalDropKm;
      const routeBadgeKmTotal = vehicleKmTotals.routeBadgeKmTotal;
      const vehicleComponentKmTotal = vehicleKmTotals.vehicleComponentKmTotal;
      const totalTravelledKm = vehicleComponentKmTotal;

      let breakdown: VehicleCostBreakdownItemDto[] | undefined;

      const outstationPackageKm =
        parseFloat(String((eligible as any).total_allowed_kms || 0)) || 0;

      const outstationDayDates = new Set(
        dayWiseDetails
          .filter((vd: any) => Number((vd as any).travel_type || 0) === 2)
          .map((vd: any) => vd.itinerary_route_date?.toISOString?.()?.split('T')[0] || '')
          .filter(Boolean),
      );

      const outstationDayCount = outstationDayDates.size;

      const configuredOutstationKmPerDay =
        parseFloat(String((eligible as any).outstation_allowed_km_per_day || 0)) || 0;

      const outstationKmPerDay =
        configuredOutstationKmPerDay > 0
          ? configuredOutstationKmPerDay
          : outstationPackageKm > 0 && outstationDayCount > 0
            ? outstationPackageKm / outstationDayCount
            : 250;

      const packageLabel = mixedTrip
        ? 'Mixed'
        : localTrip
          ? 'Local'
          : (outstationPackageKm > 0 ? `Outstation - ${outstationPackageKm} KM Package` : 'Outstation');
      // Build day-wise pricing breakdown from vehicle details
      // Build day-wise pricing breakdown from vehicle details
      // KMS per day: pickup, running, siteseeing, drop, and computed total.
      const dayWisePricing: VehicleDayWisePricingDto[] = [];
      const dayWiseMap = new Map<string, any>();

      const parseDurationToMinutes = (value: any): number => {
        const seconds = parseTimeToSeconds(value);
        if (seconds === null) return 0;
        return Math.max(0, Math.round(seconds / 60));
      };

      for (const vd of dayWiseDetails) {
        const dateStr = (vd as any).itinerary_route_date?.toISOString?.()?.split('T')[0] || '';
        if (!dateStr) continue;
        
        if (!dayWiseMap.has(dateStr)) {
          dayWiseMap.set(dateStr, {
            date: dateStr,
            locations: [],
            routeSequence: [],
            rental: 0,
            toll: 0,
            parking: 0,
            driver: 0,
            permit: 0,
            extraHourCount: 0,
            extraHourRate: 0,
            extraHour: 0,
            extraKms: 0,
            extraKm: 0,
            travelType: '',
            timeLimitId: 0,
            chargeableTimeLimitId: 0,
            kmsLimitId: 0,
            slabTitle: '',
            chargeableSlabTitle: '',
            originalSlabTitle: '',
            slabUpgraded: false,
            packageTitle: '',
            slabHoursLimit: 0,
            slabKmLimit: 0,
            packageKmLimit: 0,
            pickupKms: 0,
            pickupDurationMinutes: 0,
            dropKms: 0,
            dropDurationMinutes: 0,
            travelKms: 0, // running_km per day
            travelDurationMinutes: 0,
            sightseeingKms: 0, // siteseeing_km per day
            sightseeingDurationMinutes: 0,
            totalDurationMinutes: 0,
            tollBreakupText: [],
            parkingBreakupText: [],
            totalKms: 0 // pickup + running + sightseeing + drop per day
          });
        }
        
        const dayData = dayWiseMap.get(dateStr);
        const rowRouteId = Number((vd as any).itinerary_route_id || 0);
        const fromLocation = String((vd as any).itinerary_route_location_from || '').trim();
        const toLocation = String((vd as any).itinerary_route_location_to || '').trim();
        const viaNames = viaNamesByRouteId.get(rowRouteId) || [];
        const rowRouteSequence = [fromLocation, ...viaNames, toLocation].filter(Boolean);

        if (rowRouteSequence.length) {
          if (!Array.isArray(dayData.routeSequence)) {
            dayData.routeSequence = [];
          }
          if (!dayData.routeSequence.length) {
            dayData.routeSequence.push(...rowRouteSequence);
          } else {
            const prev = String(dayData.routeSequence[dayData.routeSequence.length - 1] || '').trim();
            const next = String(rowRouteSequence[0] || '').trim();
            if (prev && next && prev.toLowerCase() === next.toLowerCase()) {
              dayData.routeSequence.push(...rowRouteSequence.slice(1));
            } else {
              dayData.routeSequence.push(...rowRouteSequence);
            }
          }
        }

        dayData.locations.push({
          from: fromLocation,
          to: toLocation
        });
        const rawRental = parseFloat(String((vd as any).vehicle_rental_charges || 0)) || 0;
        const extraHourBreakup = getExtraHourBreakupForRow(vd);
        const dayExtraHourCharge = extraHourBreakup.charge;
        const baseRental = Math.max(0, rawRental - dayExtraHourCharge);
        const rowTravelTypeId = Number((vd as any).travel_type || 0);
        const isOutstationRow = rowTravelTypeId === 2;
        dayData.rental += baseRental;
        dayData.extraHourCount += extraHourBreakup.count;
        dayData.extraHourRate = extraHourBreakup.rate || dayData.extraHourRate;
        dayData.extraHour += dayExtraHourCharge;
        const rowExtraKms = isOutstationRow ? 0 : (parseFloat(String((vd as any).total_extra_km || 0)) || 0);
        const rowExtraKmCharges = isOutstationRow ? 0 : (parseFloat(String((vd as any).total_extra_km_charges || 0)) || 0);
        dayData.extraKms += rowExtraKms;
        dayData.extraKm += rowExtraKmCharges;
        const dayBefore6Driver = parseFloat(String((vd as any).before_6_am_charges_for_driver || 0)) || 0;
        const dayBefore6Vehicle = parseFloat(String((vd as any).before_6_am_charges_for_vehicle || 0)) || 0;
        const dayAfter8Driver = parseFloat(String((vd as any).after_8_pm_charges_for_driver || 0)) || 0;
        const dayAfter8Vehicle = parseFloat(String((vd as any).after_8_pm_charges_for_vehicle || 0)) || 0;
        // Keep day-wise totals in sync with persisted route-level billing components.
        dayData.driver += dayBefore6Driver + dayBefore6Vehicle + dayAfter8Driver + dayAfter8Vehicle;
        dayData.toll += parseFloat((vd as any).vehicle_toll_charges || 0);
        const tollBreakupText = tollBreakupByRouteId.get(`${Number((vd as any).itinerary_route_id || 0)}_${Number((vd as any).vehicle_type_id || 0)}`) || [];
        if (tollBreakupText.length > 0) {
          dayData.tollBreakupText = Array.from(new Set([...(dayData.tollBreakupText || []), ...tollBreakupText]));
        }
        const parkingBreakupText = parkingBreakupByRouteId.get(`${Number((vd as any).itinerary_route_id || 0)}_${Number((vd as any).vehicle_type_id || 0)}`) || [];
        if (parkingBreakupText.length > 0) {
          dayData.parkingBreakupText = Array.from(new Set([...(dayData.parkingBreakupText || []), ...parkingBreakupText]));
        }
        dayData.parking += parseFloat((vd as any).vehicle_parking_charges || 0);
        dayData.driver += parseFloat((vd as any).vehicle_driver_charges || 0);
        dayData.permit += parseFloat((vd as any).vehicle_permit_charges || 0);
        dayData.pickupKms += parseFloat(String((vd as any).total_pickup_km || 0)) || 0;
        const pickupDurationMinutes = parseDurationToMinutes((vd as any).total_pickup_duration);
        dayData.pickupDurationMinutes += pickupDurationMinutes;
        dayData.dropKms += parseFloat(String((vd as any).total_drop_km || 0)) || 0;
        const dropDurationMinutes = parseDurationToMinutes((vd as any).total_drop_duration);
        dayData.dropDurationMinutes += dropDurationMinutes;
        const rowTravelType = rowTravelTypeId === 2 ? 'Outstation' : 'Local';
        const rowChargeableTimeLimitId =
          Number((vd as any).chargeable_time_limit_id || (vd as any).time_limit_id || 0);
        const rowChargeableSlabTitle =
          String((vd as any).chargeable_slab_title || '').trim();
        const rowChargeableHoursLimit =
          Number((vd as any).chargeable_slab_hours_limit || 0);
        const rowChargeableKmLimit =
          Number((vd as any).chargeable_slab_km_limit || 0);
        const rowOriginalSlabTitle =
          String((vd as any).original_slab_title || '').trim();
        const rowSlabUpgraded =
          Number((vd as any).slab_upgraded || 0) === 1 ||
          (vd as any).slab_upgraded === true;

        if (!dayData.travelType) {
          dayData.travelType = rowTravelType;
        } else if (dayData.travelType !== rowTravelType) {
          dayData.travelType = 'Mixed';
        }

        const rowTimeLimitId = Number((vd as any).time_limit_id || 0);
        const rowKmsLimitId = Number((vd as any).kms_limit_id || 0);

        /**
         * Backend display rule:
         * Outstation day should show outstation KM package/limit in SLAB column,
         * not local hour-based slab.
         *
         * Example:
         * SLAB: 250 KM (Outstation)
         */
        if (rowTravelType === 'Outstation') {
          const outstationKmLimit = outstationKmPerDay;

          const outstationSlabTitle = `${Number(outstationKmLimit.toFixed(2)).toString()} KM (Outstation)`;

          dayData.slabTitle = outstationSlabTitle;
          dayData.slabKmLimit = outstationKmLimit;

          dayData.packageTitle = outstationSlabTitle;
          dayData.packageKmLimit = outstationKmLimit;

          if (!dayData.kmsLimitId && rowKmsLimitId > 0) {
            dayData.kmsLimitId = rowKmsLimitId;
          }
        } else {
          const slabInfo = slabInfoByTimeLimit.get(rowChargeableTimeLimitId || rowTimeLimitId);

          if (!dayData.timeLimitId && rowTimeLimitId > 0) {
            dayData.timeLimitId = rowTimeLimitId;
          }

          if (!dayData.chargeableTimeLimitId && rowChargeableTimeLimitId > 0) {
            dayData.chargeableTimeLimitId = rowChargeableTimeLimitId;
          }

          if (!dayData.slabTitle) {
            dayData.slabTitle = rowChargeableSlabTitle || slabInfo?.title || '';
          }
          if (!dayData.chargeableSlabTitle) {
            dayData.chargeableSlabTitle = rowChargeableSlabTitle || slabInfo?.title || '';
          }
          if (!dayData.originalSlabTitle && rowOriginalSlabTitle) {
            dayData.originalSlabTitle = rowOriginalSlabTitle;
          }
          if (rowSlabUpgraded) {
            dayData.slabUpgraded = true;
          }
          if (!dayData.slabHoursLimit) {
            dayData.slabHoursLimit = rowChargeableHoursLimit || Number(slabInfo?.hoursLimit || 0);
          }
          if (!dayData.slabKmLimit) {
            dayData.slabKmLimit = rowChargeableKmLimit || Number(slabInfo?.kmLimit || 0);
          }
          if (
            dayData.chargeableTimeLimitId > 0 &&
            rowChargeableTimeLimitId > 0 &&
            dayData.chargeableTimeLimitId !== rowChargeableTimeLimitId
          ) {
            dayData.slabTitle = 'Mixed Slabs';
            dayData.chargeableSlabTitle = 'Mixed Slabs';
          }

          const kmsLimitInfo = kmsLimitInfoById.get(rowKmsLimitId);

          if (!dayData.kmsLimitId && rowKmsLimitId > 0) {
            dayData.kmsLimitId = rowKmsLimitId;
            dayData.packageTitle = kmsLimitInfo?.title || '';
            dayData.packageKmLimit = Number(kmsLimitInfo?.kmLimit || 0);

            if (!dayData.slabTitle) {
              dayData.slabTitle = kmsLimitInfo?.title || '';
              dayData.slabKmLimit = Number(kmsLimitInfo?.kmLimit || 0);
            }
          }
        }
        // Total KM in UI is defined as pickup + travel + sightseeing + drop.
        const runningKm = parseFloat(String((vd as any).total_running_km || 0)) || 0;
        const runningDurationMinutes = parseDurationToMinutes((vd as any).total_running_time);
        const sightseeingKm = parseFloat(String((vd as any).total_siteseeing_km || 0)) || 0;
        const sightseeingDurationMinutes = parseDurationToMinutes((vd as any).total_siteseeing_time);
        const pickupKm = parseFloat(String((vd as any).total_pickup_km || 0)) || 0;
        const dropKm = parseFloat(String((vd as any).total_drop_km || 0)) || 0;
        const directTotalDurationMinutes = parseDurationToMinutes((vd as any).total_travelled_time);
        const computedTotalDurationMinutes =
          pickupDurationMinutes +
          runningDurationMinutes +
          sightseeingDurationMinutes +
          dropDurationMinutes;
        const expectedTotalKm = Number((pickupKm + runningKm + sightseeingKm + dropKm).toFixed(2));

        dayData.travelKms += runningKm;
        dayData.travelDurationMinutes += runningDurationMinutes;
        dayData.sightseeingKms += sightseeingKm;
        dayData.sightseeingDurationMinutes += sightseeingDurationMinutes;
        dayData.totalDurationMinutes +=
          directTotalDurationMinutes > 0
            ? directTotalDurationMinutes
            : computedTotalDurationMinutes;
        dayData.totalKms += expectedTotalKm;
      }

      // Convert map to array and format with day labels
      const sortedDayWiseEntries = Array.from(dayWiseMap.entries()).sort(([dateA], [dateB]) => {
        return toSortableDateTime(dateA) - toSortableDateTime(dateB);
      });
      let dayCounter = 1;
      for (const [dateStr, dayData] of sortedDayWiseEntries) {
        const date = new Date(dateStr);
        const dayName = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
        const locations: string[] = dayData.locations.map((l: any) => l.from || '').concat(dayData.locations.map((l: any) => l.to || '')).filter((l: string) => l);
        const uniqueLocations: string[] = Array.from(new Set(locations));
        const routeSequence: string[] = Array.isArray(dayData.routeSequence) ? dayData.routeSequence.filter(Boolean) : [];
        const route: string = routeSequence.length > 0
          ? routeSequence.join(' → ')
          : (uniqueLocations.length > 1 ? `${uniqueLocations[0]} → ${uniqueLocations[uniqueLocations.length - 1]}` : (uniqueLocations[0] || ''));
        
        dayWisePricing.push({
          date: dateStr,
          dayLabel: `Day ${dayCounter} | ${dayName}`,
          route,
          travelType: dayData.travelType || undefined,
          timeLimitId: dayData.timeLimitId || undefined,
          chargeableTimeLimitId: dayData.chargeableTimeLimitId || dayData.timeLimitId || undefined,
          kmsLimitId: dayData.kmsLimitId || undefined,
          slabTitle: dayData.slabTitle || undefined,
          chargeableSlabTitle: dayData.chargeableSlabTitle || dayData.slabTitle || undefined,
          originalSlabTitle: dayData.originalSlabTitle || undefined,
          slabUpgraded: dayData.slabUpgraded || undefined,
          packageTitle: dayData.packageTitle || undefined,
          slabHoursLimit: dayData.slabHoursLimit || undefined,
          slabKmLimit: dayData.slabKmLimit || undefined,
          packageKmLimit: dayData.packageKmLimit || undefined,
          pickupKms: dayData.pickupKms,
          pickupDurationMinutes: dayData.pickupDurationMinutes || undefined,
          travelKms: dayData.travelKms,
          travelDurationMinutes: dayData.travelDurationMinutes || undefined,
          sightseeingKms: dayData.sightseeingKms,
          sightseeingDurationMinutes: dayData.sightseeingDurationMinutes || undefined,
          dropDurationMinutes: dayData.dropDurationMinutes || undefined,
          totalDurationMinutes: dayData.totalDurationMinutes || undefined,
          totalKms: dayData.totalKms,
          rentalCharges: dayData.rental,
          tollCharges: dayData.toll,
          tollBreakupText: dayData.tollBreakupText?.length ? dayData.tollBreakupText : undefined,
          parkingCharges: dayData.parking,
          parkingBreakupText: dayData.parkingBreakupText?.length ? dayData.parkingBreakupText : undefined,
          driverCharges: dayData.driver,
          permitCharges: dayData.permit,
          extraHourCount: dayData.extraHourCount,
          extraHourRate: dayData.extraHourRate,
          extraHourCharges: dayData.extraHour,
          extraKms: dayData.extraKms,
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
      const dayWiseTollTotal = dayWisePricing.reduce((s, d) => s + Number(d.tollCharges || 0), 0);
      const dayWiseParkingTotal = dayWisePricing.reduce((s, d) => s + Number(d.parkingCharges || 0), 0);
      const dayWisePermitTotal = dayWisePricing.reduce((s, d) => s + Number(d.permitCharges || 0), 0);
      const dayWiseExtraHourCountTotal = dayWisePricing.reduce((s, d) => s + Number(d.extraHourCount || 0), 0);
      const dayWiseExtraHourRate = Number(dayWisePricing.find((d) => Number(d.extraHourRate || 0) > 0)?.extraHourRate || 0);
      const dayWiseExtraHourTotal = dayWisePricing.reduce((s, d) => s + Number(d.extraHourCharges || 0), 0);
      const dayWiseExtraKmChargeTotal = dayWisePricing.reduce((s, d) => s + Number(d.extraKmCharges || 0), 0);
      extraHourCharge = dayWiseExtraHourTotal;
      if (dayWiseRentalTotal > 0) {
        rentalCharges = dayWiseRentalTotal;
      }
      if (dayWiseTollTotal > 0) {
        tollCharges = dayWiseTollTotal;
      }
      if (dayWiseParkingTotal > 0) {
        parkingCharges = dayWiseParkingTotal;
      }
      // day-wise driverCharges includes the before-6AM/after-8PM driver and
      // vehicle surcharges for display. The vehicle-level driver component
      // must contain only the base vehicle_driver_charges value; the timing
      // surcharge fields are added separately below, matching PHP.
      if (dayWiseDetails.length > 0) {
        driverCharges = dayWiseDetails.reduce(
          (sum: number, vd: any) => sum + Number(vd.vehicle_driver_charges || 0),
          0,
        );
      }
      if (dayWisePermitTotal > 0) {
        permitCharges = dayWisePermitTotal;
      }
      const eligAny = eligible as any;

      // Build a breakdown list only for >0 amounts (for UI card)
      const tmp: VehicleCostBreakdownItemDto[] = [];
      const pushItem = (label: string, amount: number) => {
        if (amount > 0) {
          tmp.push({ label, amount });
        }
      };

      pushItem('Rental Charges', rentalCharges);
      pushItem('Extra Hour Charges', extraHourCharge);
      pushItem('Toll Charges', tollCharges);
      pushItem('Parking Charges', parkingCharges);
      pushItem('Driver Charges', driverCharges);
      pushItem('Permit Charges', permitCharges);
      pushItem('Before 6 AM (Driver)', before6amDriver);
      pushItem('Before 6 AM (Vehicle)', before6amVendor);
      pushItem('After 8 PM (Driver)', after8pmDriver);
      pushItem('After 8 PM (Vehicle)', after8pmVendor);

      const firstDayVd = dayWiseDetails[0];
      const lastDayVd = dayWiseDetails[dayWiseDetails.length - 1];
      const totalPickupDuration = (firstDayVd as any)?.total_pickup_duration
        ? formatHmsDuration(String((firstDayVd as any).total_pickup_duration))
        : '0 Hours 0 Min';
      const totalDropDuration = (lastDayVd as any)?.total_drop_duration
        ? formatHmsDuration(String((lastDayVd as any).total_drop_duration))
        : '0 Hours 0 Min';

      const localDayWiseDetails = dayWiseDetails.filter(
        (vd: any) => Number((vd as any).travel_type || 0) === 1,
      );
      const outstationDayWiseDetails = dayWiseDetails.filter(
        (vd: any) => Number((vd as any).travel_type || 0) === 2,
      );
      const getRouteDateKey = (vd: any): string => {
        const raw = vd?.itinerary_route_date;
        if (!raw) return '';

        if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
          return raw.toISOString().split('T')[0];
        }

        return String(raw).slice(0, 10);
      };
      const localDaysCount = new Set(
        localDayWiseDetails.map(getRouteDateKey).filter(Boolean),
      ).size;
      const outstationDaysCount = new Set(
        outstationDayWiseDetails.map(getRouteDateKey).filter(Boolean),
      ).size;
      const localAllowedKmBreakdown = Array.from(
        localDayWiseDetails.reduce((map, vd: any) => {
          const timeLimitId = Number((vd as any).time_limit_id || 0);
          const slabInfo = slabInfoByTimeLimit.get(timeLimitId);
          const key = String(timeLimitId || 'unknown');
          const allowedKm = Number(slabInfo?.kmLimit || 0);
          const existing = map.get(key) || {
            timeLimitId: timeLimitId || undefined,
            allowedKm: 0,
            days: 0,
            label: slabInfo?.title || undefined,
          };

          existing.allowedKm += allowedKm;
          existing.days += 1;
          if (!existing.label && slabInfo?.title) {
            existing.label = slabInfo.title;
          }

          map.set(key, existing);
          return map;
        }, new Map<string, { timeLimitId?: number; allowedKm: number; days: number; label?: string }>()),
      )
        .map(([, item]) => item)
        .filter((item) => item.allowedKm > 0 || item.days > 0);

      // Summary fields from eligible_list
      const noOfDays = dayWiseDetails.length || 1;
      const persistedTotalUsedKm =
        parseFloat(String((eligAny as any).total_kms || 0)) || 0;
      const computedLocalUsedKm = localDayWiseDetails.reduce((sum: number, vd: any) => {
        const pickupKm = parseFloat(String((vd as any).total_pickup_km || 0)) || 0;
        const runningKm = parseFloat(String((vd as any).total_running_km || 0)) || 0;
        const sightseeingKm = parseFloat(String((vd as any).total_siteseeing_km || 0)) || 0;
        const dropKm = parseFloat(String((vd as any).total_drop_km || 0)) || 0;
        return sum + pickupKm + runningKm + sightseeingKm + dropKm;
      }, 0);
      const computedOutstationUsedKm = outstationDayWiseDetails.reduce((sum: number, vd: any) => {
        const pickupKm = parseFloat(String((vd as any).total_pickup_km || 0)) || 0;
        const runningKm = parseFloat(String((vd as any).total_running_km || 0)) || 0;
        const sightseeingKm = parseFloat(String((vd as any).total_siteseeing_km || 0)) || 0;
        const dropKm = parseFloat(String((vd as any).total_drop_km || 0)) || 0;
        return sum + pickupKm + runningKm + sightseeingKm + dropKm;
      }, 0);
      const persistedLocalUsedKm =
        parseFloat(String((eligAny as any).total_local_km || 0)) || 0;
      const persistedOutstationUsedKm =
        parseFloat(String((eligAny as any).total_outstation_km || 0)) || 0;
      const localUsedKm = roundCurrency(
        persistedLocalUsedKm > 0 ? persistedLocalUsedKm : computedLocalUsedKm,
      );
      const outstationUsedKm = roundCurrency(
        persistedOutstationUsedKm > 0 ? persistedOutstationUsedKm : computedOutstationUsedKm,
      );
      const totalUsedKm = roundCurrency(
        persistedTotalUsedKm > 0 ? persistedTotalUsedKm : localUsedKm + outstationUsedKm,
      );
      const totalAllowedLocalKm = parseFloat(String(eligAny.total_allowed_local_kms || 0)) || 0;
      const totalAllowedOutstationKm = parseFloat(String(eligAny.total_allowed_kms || 0)) || 0;
      const totalAllowedKm = roundCurrency(totalAllowedLocalKm + totalAllowedOutstationKm);
      const outstationAllowedKmPerDay =
        parseFloat(String((eligAny as any).outstation_allowed_km_per_day || 0)) || 0;
      const extraKmRate = parseFloat(String(eligAny.extra_km_rate || 0)) || 0;
      const localExtraKms = parseFloat(String((eligAny as any).total_extra_local_kms || 0)) || 0;
      const localExtraKmCharge =
        parseFloat(String((eligAny as any).total_extra_local_kms_charge || 0)) || 0;
      const outstationExtraKms = parseFloat(String((eligAny as any).total_extra_kms || 0)) || 0;
      const outstationExtraKmCharge =
        parseFloat(String((eligAny as any).total_extra_kms_charge || 0)) || 0;
      const extraKms = roundCurrency(localExtraKms + outstationExtraKms);
      const extraKmCharge = roundCurrency(localExtraKmCharge + outstationExtraKmCharge);
      pushItem('Local Extra KM Charges', localExtraKmCharge);
      pushItem('Outstation Extra KM Charges', outstationExtraKmCharge);
      breakdown = tmp.length ? tmp : undefined;
      const totalCostOfVehicle = rentalCharges + tollCharges + parkingCharges + driverCharges + permitCharges
        + Number(eligAny.total_before_6_am_charges_for_driver ?? 0)
        + Number(eligAny.total_before_6_am_charges_for_vehicle ?? 0)
        + Number(eligAny.total_after_8_pm_charges_for_driver ?? 0)
        + Number(eligAny.total_after_8_pm_charges_for_vehicle ?? 0)
        + extraHourCharge;
      const subtotal = roundCurrency(totalCostOfVehicle + localExtraKmCharge + outstationExtraKmCharge);
      const vehicleGstPercentage = parseFloat(String(eligAny.vehicle_gst_percentage || 0)) || 0;
      const vehicleGstAmount = parseFloat(String(eligAny.vehicle_gst_amount || 0)) || 0;
      const vendorMarginPercentage = parseFloat(String(eligAny.vendor_margin_percentage || 0)) || 0;
      const vendorMarginAmount = roundCurrency(
        ((subtotal + vehicleGstAmount) * vendorMarginPercentage) / 100,
      );
      const configuredVendorMarginGstPercentage =
        parseFloat(String(eligAny.vendor_margin_gst_percentage || 0)) || 0;
      // PHP uses the vendor-branch GST percentage when the vendor-specific
      // margin GST percentage is missing/zero.
      const vendorBranchGstPercentage =
        parseFloat(String((branch as any)?.vendor_branch_gst || 0)) || 0;
      const vendorMarginGstPercentage =
        configuredVendorMarginGstPercentage >= 1
          ? configuredVendorMarginGstPercentage
          : vendorBranchGstPercentage;
      const vendorMarginGstType = parseFloat(String(eligAny.vendor_margin_gst_type || 0)) || 0;
      const vendorMarginGstAmount =
        vendorMarginGstType === 2
          ? roundCurrency((vendorMarginAmount * vendorMarginGstPercentage) / 100)
          : 0;
      const grandTotal = roundCurrency(
        subtotal + vehicleGstAmount + vendorMarginAmount + vendorMarginGstAmount,
      );

      if (process.env.DEBUG_VEHICLE_KM_SUMMARY === 'true') {
        console.log('[VEHICLE_DISTANCE_SUMMARY_SOURCE]', {
          quoteId,
          planId,
          vendorEligibleId: eligible.itinerary_plan_vendor_eligible_ID,
          totalUsedKm,
          persistedTotalUsedKm,
          computedLocalUsedKm,
          computedOutstationUsedKm,
          localUsedKm,
          outstationUsedKm,
          totalAllowedLocalKm,
          totalAllowedOutstationKm,
          totalAllowedKm,
          outstationAllowedKmPerDay,
          localDaysCount,
          outstationDaysCount,
          localExtraKms,
          localExtraKmCharge,
          outstationExtraKms,
          outstationExtraKmCharge,
          extraKms,
          extraKmCharge,
        });
      }

      const rateAvailability = getVehicleRateAvailability(dayWiseDetails);
      const rateAvailabilityMessage = rateAvailability.available
        ? null
        : buildVehicleRateAvailabilityMessage(
            [String(branch?.vendor_branch_name || branchCityName || origin || '').trim()],
            vehicleTypeNameMap.get(vehicleTypeId) || 'this vehicle type',
            rateAvailability.missingRateTypes,
          );

      const vehicleResponseRow = {
        vendorName: branch?.vendor_branch_name ?? null,
        branchName: branch?.vendor_branch_name ?? null,
        vehicleOrigin:
          origin ||
          branchCityName ||
          branch?.vendor_branch_location ||
          branch?.vendor_branch_name ||
          null,
        totalQty: String(qty),
        totalAmount: totalAmount.toFixed(2),

        // IDs needed for vendor selection
        vehicleId: eligibleVehicleId,
        vehicleIds: groupedVehicleIds,
        vehicleNumber: registrationNumber || null,
        vehicleNumbers: groupedVehicleNumbers,
        availableVehicleCount:
          groupedVehicleIds.length > 0
            ? groupedVehicleIds.length
            : Math.max(1, Number(groupedVehicleMeta?.rawRowCount || 1)),
        vehicleRegistrationNumber: registrationNumber || null,
        vehicleRegistrationStateCode,
        vehicleRegistrationStateName:
          vehicleRegistrationStateCode
            ? permitStateByCode.get(vehicleRegistrationStateCode)?.state_name || null
            : null,
        vendorEligibleId: eligible.itinerary_plan_vendor_eligible_ID,
        vehicleTypeId: vehicleTypeId,
        vehicleTypeName: vehicleTypeNameMap.get(vehicleTypeId) || 'Unknown Vehicle Type',
        isAssigned: (eligible as any).itineary_plan_assigned_status === 1,
        rateAvailable: rateAvailability.available,
        missingRateTypes: rateAvailability.missingRateTypes,
        rateAvailabilityMessage,
        selectedTimeLimitId,
        availableSlabs,
        localTrip,

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
        totalTravelKm,
        totalSightseeingKm,
        totalPickupDuration,
        totalDropKm,
        totalDropDuration,
        totalUsedKm,
        localUsedKm,
        outstationUsedKm,
        totalAllowedLocalKm,
        totalAllowedOutstationKm,
        totalAllowedKm,
        localDaysCount,
        outstationDaysCount,
        outstationAllowedKmPerDay,
        localAllowedKmBreakdown: localAllowedKmBreakdown.length ? localAllowedKmBreakdown : undefined,
        extraKms,
        localExtraKms,
        localExtraKmCharge,
        outstationExtraKms,
        outstationExtraKmCharge,
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
        col1Distance: totalTravelKm > 0 ? `${totalTravelKm.toFixed(2)} KM` : '0.00 KM',
        col2Distance: totalSightseeingKm > 0 ? `${totalSightseeingKm.toFixed(2)} KM` : '0.00 KM',
        col3Distance: totalTravelledKm > 0 ? `${totalTravelledKm.toFixed(2)} KM` : '0.00 KM',
        col1Duration: '0 Min',
        col2Duration: '0 Min',
        col3Duration: '0 Min',
      };
      if (debugVehicleTrace) {
        console.log('[DETAILS_VEHICLE_RESPONSE_ROW]', {
          vehicleId: Number((vehicleResponseRow as any).vehicleId || 0) || null,
          vehicleNumber: String((vehicleResponseRow as any).vehicleNumber || ''),
          vehicleRegistrationStateCode: String((vehicleResponseRow as any).vehicleRegistrationStateCode || ''),
          vehicleRegistrationStateName: String((vehicleResponseRow as any).vehicleRegistrationStateName || ''),
          vehicleTypeId: Number((vehicleResponseRow as any).vehicleTypeId || 0),
          vehicleTypeName: String((vehicleResponseRow as any).vehicleTypeName || ''),
          eligibleId: Number((vehicleResponseRow as any).vendorEligibleId || 0),
          isAssigned: Boolean((vehicleResponseRow as any).isAssigned),
          dayWisePricingCount: Array.isArray((vehicleResponseRow as any).dayWisePricing)
            ? (vehicleResponseRow as any).dayWisePricing.length
            : 0,
          totalAmount: Number((vehicleResponseRow as any).totalAmount || 0),
        });
      }
      return vehicleResponseRow;
    });

    const vehicleRateAvailability: ItineraryDetailsResponseDto['vehicleRateAvailability'] = [];
    const vehiclesByTypeForRateAvailability = new Map<number, ItineraryVehicleRowDto[]>();
    for (const vehicle of allVehicles) {
      const vehicleTypeId = Number(vehicle?.vehicleTypeId || 0);
      if (!vehicleTypeId) continue;
      const rows = vehiclesByTypeForRateAvailability.get(vehicleTypeId) || [];
      rows.push(vehicle);
      vehiclesByTypeForRateAvailability.set(vehicleTypeId, rows);
    }

    for (const [vehicleTypeId, rows] of vehiclesByTypeForRateAvailability.entries()) {
      const validRows = rows.filter((row) => row.rateAvailable !== false);
      if (validRows.length > 0) continue;

      const vehicleTypeName = String(rows[0]?.vehicleTypeName || `Vehicle Type ${vehicleTypeId}`);
      const vendorNames = rows.map((row) => String(row.vendorName || '').trim()).filter(Boolean);
      const missingRateTypes = Array.from(
        new Set(rows.flatMap((row) => row.missingRateTypes || [])),
      ) as Array<'Local' | 'Outstation'>;
      vehicleRateAvailability.push({
        vehicleTypeId,
        vehicleTypeName,
        message: buildVehicleRateAvailabilityMessage(vendorNames, vehicleTypeName, missingRateTypes),
      });
    }

    // Only rate-valid vendors are eligible for display and selection. Keep the
    // no-rate information above so the UI can show a useful empty-state message.
    const vehicles: ItineraryVehicleRowDto[] = allVehicles.filter(
      (vehicle) => vehicle.rateAvailable !== false,
    );

    console.log('[DETAILS_VEHICLE_ROWS]', {
      quoteId,
      planId,
      rawEligibleCount: rawEligibleRows.length,
      activeEligibleCount: activeEligibleRows.length,
      dedupedEligibleCount,
      rawVehicleDetailCount: rawVehicleDetailsRows.length,
      dedupedVehicleDetailCount: vehicleDetailsRows.length,
      returnedVehicleCount: vehicles.length,
      filteredRateUnavailableCount: allVehicles.length - vehicles.length,
      vehicleRateAvailability,
      vehicles: allVehicles.map((responseRow: any) => {
        return {
          vehicleId: Number(responseRow?.vehicleId || 0) || null,
          vehicleNumber: String(responseRow?.vehicleNumber || ''),
          vehicleRegistrationStateCode: String(responseRow?.vehicleRegistrationStateCode || ''),
          vehicleRegistrationStateName: String(responseRow?.vehicleRegistrationStateName || ''),
          vendorEligibleId: Number(responseRow?.vendorEligibleId || 0),
          vehicleTypeId: Number(responseRow?.vehicleTypeId || 0),
          rateAvailable: responseRow?.rateAvailable !== false,
          totalAmount: Number(responseRow?.totalAmount || 0),
        };
      }),
    });
    stepStartedAt = this.logItineraryApiTiming({
      api: 'itinerary_details',
      planId,
      quoteId,
      step: 'vehicle_mapping_and_pricing',
      startedAt: apiStartedAt,
      stepStartedAt,
    });

    // Normalize assignment in the API response so each vehicle type marks the
    // lowest displayed amount as selected, even if the DB carries an older choice.
    const vehiclesByTypeForSelection = new Map<number, any[]>();
    for (const vehicle of vehicles as any[]) {
      const vehicleTypeId = Number(vehicle?.vehicleTypeId || 0);
      if (!vehicleTypeId) continue;

      if (!vehiclesByTypeForSelection.has(vehicleTypeId)) {
        vehiclesByTypeForSelection.set(vehicleTypeId, []);
      }

      vehiclesByTypeForSelection.get(vehicleTypeId)!.push(vehicle);
    }

    for (const rows of vehiclesByTypeForSelection.values()) {
      const cheapest = rows.reduce((prev, curr) => {
        const prevAmount = Number(prev?.grandTotal ?? prev?.totalAmount ?? 0);
        const currAmount = Number(curr?.grandTotal ?? curr?.totalAmount ?? 0);

        if (currAmount < prevAmount) return curr;

        if (currAmount === prevAmount) {
          return Number(curr?.vendorEligibleId || 0) < Number(prev?.vendorEligibleId || 0)
            ? curr
            : prev;
        }

        return prev;
      }, rows[0]);

      for (const row of rows) {
        row.isAssigned =
          Number(row?.vendorEligibleId || 0) === Number(cheapest?.vendorEligibleId || 0);
      }
    }

    // 5) Total vehicle amount for footer: sum only ASSIGNED vehicles (itineary_plan_assigned_status = 1)
    // This matches PHP behavior which filters by assigned status
    const totalVehicleAmountFromEligible = vehicles.reduce(
      (sum: number, vehicle: any) =>
        sum + (vehicle?.isAssigned ? Number(vehicle?.grandTotal || vehicle?.totalAmount || 0) : 0),
      0,
    );

    const totalVehicleAmount =
      totalVehicleAmountFromEligible > 0
        ? totalVehicleAmountFromEligible
        : vehicles.reduce(
            (sum: number, v: any) => sum + (Number(v.grandTotal || v.totalAmount || 0) || 0),
            0,
          );

    const selectedVehicleRows = (vehicles as any[]).filter(
      (vehicle: any) => vehicle?.isAssigned === true,
    );
    const hasRequiredVehicleSelection = !shouldIncludeVehicles || (
      vehiclesByTypeForSelection.size > 0 &&
      vehicleRateAvailability.length === 0 &&
      selectedVehicleRows.length === vehiclesByTypeForSelection.size
    );

    /**
     * KM warning should not sum every eligible vendor row.
     * It should use only the selected/assigned rows that are used for final pricing.
     *
     * If multiple selected vehicle types exist, do not multiply the same itinerary KM
     * into a fake large warning number. Use the worst selected row for warning display.
     */
    const kmWarningRowsSource = selectedVehicleRows.length > 0 ? selectedVehicleRows : (vehicles as any[]);
    const kmWarningRows = Array.from(
      kmWarningRowsSource.reduce((map, vehicle: any) => {
        const key = `${Number(vehicle?.vehicleTypeId || 0)}:${Number(vehicle?.vendorEligibleId || 0)}`;
        if (!map.has(key)) {
          map.set(key, vehicle);
        }
        return map;
      }, new Map<string, any>()),
    ).map(([, vehicle]) => vehicle);

    const selectedKmRows = kmWarningRows
      .map((vehicle: any) => {
        const localExtraKms = Number(vehicle?.localExtraKms || 0);
        const outstationExtraKms = Number(vehicle?.outstationExtraKms || 0);

        return {
          vendorEligibleId: Number(vehicle?.vendorEligibleId || 0),
          vehicleTypeId: Number(vehicle?.vehicleTypeId || 0),
          vendorName: String(vehicle?.vendorName || ''),
          totalAllowedKm: Number(vehicle?.totalAllowedKm || 0),
          totalAllowedLocalKm: Number(vehicle?.totalAllowedLocalKm || 0),
          totalAllowedOutstationKm: Number(vehicle?.totalAllowedOutstationKm || 0),
          totalUsedKm: Number(vehicle?.totalUsedKm || 0),
          localUsedKm: Number(vehicle?.localUsedKm || 0),
          outstationUsedKm: Number(vehicle?.outstationUsedKm || 0),
          localExtraKms,
          localExtraKmCharge: Number(vehicle?.localExtraKmCharge || 0),
          outstationExtraKms,
          outstationExtraKmCharge: Number(vehicle?.outstationExtraKmCharge || 0),
          extraKms: Math.max(0, localExtraKms + outstationExtraKms),
          extraKmCharge:
            Number(vehicle?.localExtraKmCharge || 0) +
            Number(vehicle?.outstationExtraKmCharge || 0),
          outstationAllowedKmPerDay: Number(vehicle?.outstationAllowedKmPerDay || 0),
          outstationDaysCount: Number(vehicle?.outstationDaysCount || 0),
          localDaysCount: Number(vehicle?.localDaysCount || 0),
          isAssigned: vehicle?.isAssigned === true,
        };
      })
      .filter(
        (row) =>
          row.totalAllowedKm > 0 ||
          row.totalUsedKm > 0 ||
          row.extraKms > 0,
      );

    const kmWarningBaseRow =
      selectedKmRows.reduce((worst, current) => {
        if (!worst) return current;

        if (current.extraKms > worst.extraKms) return current;

        const currentOverflow = Math.max(0, current.totalUsedKm - current.totalAllowedKm);
        const worstOverflow = Math.max(0, worst.totalUsedKm - worst.totalAllowedKm);

        if (currentOverflow > worstOverflow) return current;

        return worst;
      }, null as null | {
        vendorEligibleId: number;
        vehicleTypeId: number;
        vendorName: string;
        totalAllowedKm: number;
        totalAllowedLocalKm: number;
        totalAllowedOutstationKm: number;
        totalUsedKm: number;
        extraKms: number;
        extraKmCharge: number;
        localUsedKm: number;
        outstationUsedKm: number;
        localExtraKms: number;
        localExtraKmCharge: number;
        outstationExtraKms: number;
        outstationExtraKmCharge: number;
        outstationAllowedKmPerDay: number;
        outstationDaysCount: number;
        localDaysCount: number;
        isAssigned: boolean;
      });

    const totalAllowedKmFromAssigned = Number((kmWarningBaseRow?.totalAllowedKm || 0).toFixed(2));
    const totalTravelledKmFromAssigned = Number((kmWarningBaseRow?.totalUsedKm || 0).toFixed(2));
    const totalExtraKmFromAssigned = Number((kmWarningBaseRow?.extraKms || 0).toFixed(2));

    if (totalExtraKmFromAssigned > 0) {
      kmLimitWarning = `Planner warning: assigned vehicles exceed allowed KM by ${totalExtraKmFromAssigned.toFixed(2)} km (extra KM charges may apply).`;
    } else {
      kmLimitWarning = undefined;
    }

    this.logBookingRule({
      rule: 'KM_LIMIT_WARNING',
      quoteId,
      planId,
      emitted: Boolean(kmLimitWarning),
      selectedVehicleRowsCount: selectedVehicleRows.length,
      kmWarningRowsCount: selectedKmRows.length,
      selectedKmRows,
      selectedKmWarningBaseRow: kmWarningBaseRow,
      totalAllowedKm: totalAllowedKmFromAssigned,
      totalTravelledKm: totalTravelledKmFromAssigned,
      totalExtraKm: totalExtraKmFromAssigned,
    });

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
    // Disabled for details API latency: this endpoint should read saved values only.
    const getLiveSelectedGroupRoomCost = async (): Promise<number> => {
      return 0;
    };

    const liveSelectedGroupRoomCost = await getLiveSelectedGroupRoomCost();
    const shouldUseLiveSelectedGroupCost =
      liveSelectedGroupRoomCost > 0 &&
      (totalRoomCost <= 0 || Math.abs(liveSelectedGroupRoomCost - totalRoomCost) > 0.01);
    stepStartedAt = this.logItineraryApiTiming({
      api: 'itinerary_details',
      planId,
      quoteId,
      step: 'hotel_cost_lookup',
      startedAt: apiStartedAt,
      stepStartedAt,
    });

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
    const totalVehicleQty = selectedVehicleRows.reduce(
      (sum: number, vehicle: any) => sum + Number(vehicle?.totalQty || 0),
      0,
    );

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
    const persistedHotspotCost = Number(hotspotAgg._sum.hotspot_amout || 0);
    const calculatedEntryTicketCost = entryTicketBreakdown.reduce(
      (sum, row) => sum + Number(row.total || 0),
      0,
    );
    const totalHotspotCost = Number(
      (Number(plan.entry_ticket_required || 0) === 1
        ? calculatedEntryTicketCost
        : persistedHotspotCost
      ).toFixed(2),
    );
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

    const subtotal =
      effectiveHotelAmount +
      totalVehicleCost +
      totalGuideCost +
      totalHotspotCost +
      totalActivityCost;
    const additionalMargin = itineraryNoDays <= additionalMarginDayLimit 
      ? (subtotal * additionalMarginPercentage) / 100
      : 0;

    // 4. Calculate total amount before discounts
    const totalAmount = subtotal + additionalMargin;

    // 5. Get coupon discount and agent margin from plan
    const couponDiscount = 0; // Not currently stored in plan table
    const agentMargin = hasRequiredVehicleSelection ? Number(plan.agent_margin || 0) : 0;

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
      entryTicketBreakdown: entryTicketBreakdown.length > 0 ? entryTicketBreakdown : undefined,
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
      totalAllowedLocalKm:
        kmWarningBaseRow?.totalAllowedLocalKm && kmWarningBaseRow.totalAllowedLocalKm > 0
          ? Number(kmWarningBaseRow.totalAllowedLocalKm.toFixed(2))
          : undefined,
      totalAllowedOutstationKm:
        kmWarningBaseRow?.totalAllowedOutstationKm && kmWarningBaseRow.totalAllowedOutstationKm > 0
          ? Number(kmWarningBaseRow.totalAllowedOutstationKm.toFixed(2))
          : undefined,
      localUsedKm:
        kmWarningBaseRow?.localUsedKm && kmWarningBaseRow.localUsedKm > 0
          ? Number(kmWarningBaseRow.localUsedKm.toFixed(2))
          : undefined,
      outstationUsedKm:
        kmWarningBaseRow?.outstationUsedKm && kmWarningBaseRow.outstationUsedKm > 0
          ? Number(kmWarningBaseRow.outstationUsedKm.toFixed(2))
          : undefined,
      localExtraKms:
        kmWarningBaseRow?.localExtraKms && kmWarningBaseRow.localExtraKms > 0
          ? Number(kmWarningBaseRow.localExtraKms.toFixed(2))
          : undefined,
      localExtraKmCharge:
        kmWarningBaseRow?.localExtraKmCharge && kmWarningBaseRow.localExtraKmCharge > 0
          ? Number(kmWarningBaseRow.localExtraKmCharge.toFixed(2))
          : undefined,
      outstationExtraKms:
        kmWarningBaseRow?.outstationExtraKms && kmWarningBaseRow.outstationExtraKms > 0
          ? Number(kmWarningBaseRow.outstationExtraKms.toFixed(2))
          : undefined,
      outstationExtraKmCharge:
        kmWarningBaseRow?.outstationExtraKmCharge && kmWarningBaseRow.outstationExtraKmCharge > 0
          ? Number(kmWarningBaseRow.outstationExtraKmCharge.toFixed(2))
          : undefined,
      
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
    const tripStartDate = this.formatDbDateOnly(plan.trip_start_date_and_time);
    const tripEndDate = this.formatDbDateOnly(plan.trip_end_date_and_time);

    const dateRange =
      tripStartDate && tripEndDate ? `${tripStartDate} to ${tripEndDate}` : '';
   
    
 // Room count belongs to the plan header and should remain available even for vehicle-only itineraries.
const roomCount = Number(plan.preferred_room_count ?? 0);

const guestFoodPreference = this.getFoodPreferenceLabel(
  (plan as any).food_type ?? (confirmedPlan as any)?.food_type,
);

const specialInstructions = String(
  (plan as any).special_instructions ??
    (confirmedPlan as any)?.special_instructions ??
    ""
).trim();

const rawItineraryPreference = Number((plan as any).itinerary_preference || 0);
const hasHotelRows = Array.isArray(hotelRows) && hotelRows.some((row: any) => Number(row?.deleted || 0) === 0);
const hasVehicleRows = Array.isArray(vehicles) && vehicles.length > 0;
const normalizedItineraryPreference =
  parsedRouteFamilyQuote?.baseQuoteId && hasHotelRows && hasVehicleRows
    ? 3
    : rawItineraryPreference;

// Calls made internally by clipboard/document builders do not carry an HTTP
// user. Preserve their existing full-detail behavior; authenticated controller
// calls always pass req.user.role and are filtered by the role policy.
const canViewCostBreakdown =
  viewerRole === undefined ? true : canViewItineraryCostBreakdown(viewerRole);
const vehiclesForAgent = isAgentRole(viewerRole)
  ? vehicles.filter((vehicle: any) => vehicle?.isAssigned === true)
  : vehicles;
const visibleVehicles = canViewCostBreakdown
  ? vehicles
  : isAgentRole(viewerRole)
    ? vehiclesForAgent.map(redactVehicleForAgent)
    : redactVehicleCostBreakdowns(vehicles);
const visibleCostBreakdown = canViewCostBreakdown
  ? costBreakdown
  : redactItineraryCostBreakdown(costBreakdown);

const response: ItineraryDetailsResponseDto = {
  quoteId: plan.itinerary_quote_ID ?? '',
      planId: plan.itinerary_plan_ID,
      routeFamilyBaseQuoteId: parsedRouteFamilyQuote?.baseQuoteId ?? null,
      routeVariantIndex: parsedRouteFamilyQuote?.routeVariantIndex ?? null,
      routeOptions: siblingRouteOptions,
      siblingRoutes: siblingRouteOptions,
      suggestedRoutes: siblingRouteOptions,
      itineraryPreference: normalizedItineraryPreference,
      itineraryType: Number((plan as any).itinerary_type || 0),
      guideForItinerary: Number((plan as any).guide_for_itinerary || 0),
      preferred_hotel_category: (plan as any).preferred_hotel_category ?? null,
      preferredHotelCategory: (plan as any).preferred_hotel_category ?? null,
      hotel_facilities: (plan as any).hotel_facilities ?? null,
      hotelFacilities: (plan as any).hotel_facilities ?? null,
      isConfirmed: !!confirmedPlan,
      confirmed_itinerary_plan_ID: confirmedPlan?.confirmed_itinerary_plan_ID,
      special_instructions: specialInstructions,
      specialInstructions,
      special_instruction: specialInstructions,
      specialInstruction: specialInstructions,
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
meal_plan_code: (plan as any).meal_plan_code ?? null,

// Guest food preference for frontend day-wise header
food_type: guestFoodPreference,
foodType: guestFoodPreference,
food_type_name: guestFoodPreference,
foodTypeName: guestFoodPreference,
guest_food_preference: guestFoodPreference,
guestFoodPreference: guestFoodPreference,
guest_food_preference_name: guestFoodPreference,
guestFoodPreferenceName: guestFoodPreference,

      days,

      vehicles: visibleVehicles,
      vehicleRateAvailability,
      packageIncludes: {
        description: '',
        houseBoatNote: '',
        rateNote: '',
      },
      costBreakdown: visibleCostBreakdown,
    };
    stepStartedAt = this.logItineraryApiTiming({
      api: 'itinerary_details',
      planId,
      quoteId,
      step: 'final_response_mapping',
      startedAt: apiStartedAt,
      stepStartedAt,
    });

    return response;
  }

  
    // ---------------------------------------------------------------------------
  // Latest Itineraries DataTable (unchanged logic, just using helpers)
  // ---------------------------------------------------------------------------
  async getLatestItinerariesDataTable(q: LatestItineraryQueryDto, req: any) {
    return this.latestDataTableService.get(q, req);
  }


  async findOne(id: number, groupType?: number, viewerRole?: unknown) {
    const apiStartedAt = Date.now();
    let stepStartedAt = apiStartedAt;
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: id },
    });
    if (!plan) throw new NotFoundException('Itinerary not found');
    stepStartedAt = this.logItineraryApiTiming({
      api: 'itinerary_details_by_id',
      planId: id,
      quoteId: String(plan?.itinerary_quote_ID || ''),
      step: 'plan_lookup_by_id',
      startedAt: apiStartedAt,
      stepStartedAt,
    });
    
    const quoteId = plan.itinerary_quote_ID;
    if (!quoteId) throw new NotFoundException('Quote ID not found for this plan');
    return this.getItineraryDetails(quoteId, groupType, viewerRole);
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
