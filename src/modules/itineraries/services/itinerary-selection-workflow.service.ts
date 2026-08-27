// FILE: src/modules/itineraries/services/itinerary-selection-workflow.service.ts

import { Injectable, BadRequestException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { createConnection } from 'mysql2/promise';
import { PrismaService } from '../../../prisma.service';
import { RouteEngineService } from '../engines/route-engine.service';
import { ItineraryVehiclesEngine } from '../engines/itinerary-vehicles.engine';
import { ItineraryHotelDetailsTboService } from '../itinerary-hotel-details-tbo.service';
import { OfflineHotelCatalogService } from './offline-hotel-catalog.service';
import { filterActiveVendorCandidateRows } from '../utils/active-vendor-candidate.util';
import { getVehicleRateAvailability } from '../utils/vehicle-rate-availability.util';
import {
  hotelSelectionKey,
  hotelSelectionKeyFromRow,
  normalizeSupplierRateIdentity,
  supplierRateIdentityMatches,
} from '../utils/hotel-selection-identity.util';
import {
  getCanonicalMealPlanFlags,
  inferCanonicalHotelRatePlanCode,
  inferCanonicalHotelRatePlanCodeFromMealText,
  inferCanonicalHotelRatePlanCodeFromMealFlags,
} from '../../hotels/hotel-rate-plans';
import { resolveHotelSelectionPricing } from '../utils/hotel-selection-pricing.util';
import { HotelAvailabilitySnapshotService } from './hotel-availability-snapshot.service';
import { toDatabaseBusinessDate } from '../utils/itinerary.utils';

@Injectable()
export class ItinerarySelectionWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly routeEngine: RouteEngineService,
    private readonly itineraryVehiclesEngine: ItineraryVehiclesEngine,
    private readonly hotelDetailsTboService: ItineraryHotelDetailsTboService,
    private readonly offlineHotelCatalogService?: OfflineHotelCatalogService,
    private readonly hotelAvailabilitySnapshotService?: HotelAvailabilitySnapshotService,
  ) {}

  private requireTargetGroupType(groupType: unknown): number {
    const targetGroupType = Number(groupType);
    if (!Number.isInteger(targetGroupType) || targetGroupType < 1 || targetGroupType > 4) {
      throw new BadRequestException('Hotel selection requires a valid target groupType between 1 and 4');
    }
    return targetGroupType;
  }

  /**
   * Own the plan/group advisory lock for the complete authoritative operation.
   * Supplier calls intentionally run outside the Prisma transaction, but no
   * competing intent may resolve against the snapshot while this callback is
   * in progress.
   */
  async withHotelSelectionLock<T>(planId: number, groupType: number, work: () => Promise<T>): Promise<T> {
    const targetGroupType = this.requireTargetGroupType(groupType);
    const lockName = `itinerary-hotel-selection:${Number(planId)}:${targetGroupType}`;
    const databaseUrl = String(process.env.DATABASE_URL || '').trim();
    if (!databaseUrl) {
      throw new InternalServerErrorException({
        code: 'HOTEL_SELECTION_LOCK_UNAVAILABLE',
        message: 'The hotel selection lock could not be established.',
      });
    }
    const connection = await createConnection(databaseUrl);
    let acquired = false;
    try {
      const result: any = await connection.query('SELECT GET_LOCK(?, 10) AS acquired', [lockName]);
      acquired = Number(result?.[0]?.[0]?.acquired || 0) === 1;
      if (!acquired) throw new BadRequestException('Another hotel selection is being applied. Please retry.');
      return await work();
    } finally {
      if (acquired) {
        try { await connection.query('SELECT RELEASE_LOCK(?)', [lockName]); } catch { /* close releases it */ }
      }
      await connection.end();
    }
  }

  async getAvailableHotels(routeId: number) {
 // Get route details
    const route = await (this.prisma as any).dvi_itinerary_route_details.findFirst({
      where: { itinerary_route_ID: routeId },
    });

    if (!route || !route.location_id) {
      return [];
    }

 // Get location coordinates separately
    const location = await (this.prisma as any).dvi_stored_locations.findFirst({
      where: { location_ID: Number(route.location_id) },
      select: {
        destination_location_lattitude: true,
        destination_location_longitude: true,
      },
    });

    if (!location || !location.destination_location_lattitude || !location.destination_location_longitude) {
      return [];
    }

    const destLat = Number(location.destination_location_lattitude);
    const destLng = Number(location.destination_location_longitude);

 // Fetch hotels with Haversine distance calculation
    const hotels = await this.prisma.$queryRaw`
      SELECT
        h.hotel_id,
        h.hotel_name,
        h.hotel_address,
        h.hotel_latitude,
        h.hotel_longitude,
        h.hotel_category,
        (6371 * acos(
          cos(radians(${destLat})) *
          cos(radians(h.hotel_latitude)) *
          cos(radians(h.hotel_longitude) - radians(${destLng})) +
          sin(radians(${destLat})) *
          sin(radians(h.hotel_latitude))
        )) AS distance_in_km
      FROM dvi_hotel h
      WHERE h.status = 1
        AND h.deleted = 0
        AND h.hotel_latitude IS NOT NULL
        AND h.hotel_longitude IS NOT NULL
      HAVING distance_in_km <= 20
      ORDER BY distance_in_km ASC
      LIMIT 20
    `;

    return (hotels as any[]).map(h => ({
      id: h.hotel_id,
      name: h.hotel_name,
      address: h.hotel_address,
      category: h.hotel_category,
      distance: Number(h.distance_in_km).toFixed(2),
    }));
  }

 /**
   * Select/update hotel for a route
 */
  async selectHotel(data: {
    planId: number;
    routeId: number;
    hotelId: number | null;
    roomTypeId: number;
    selectionIntent?: 'HOTEL' | 'ROOM_TYPE' | 'MEAL_PLAN' | 'RATE_OPTION';
 groupType?: number; // ADD groupType parameter
    mealPlan?: { all?: boolean; breakfast?: boolean; lunch?: boolean; dinner?: boolean; };
    canonicalHotelId?: number | null;
    hotelCode?: string;
    providerHotelCode?: string;
    selectionKey?: string;
    rateOptionId?: string;
    provider?: string;
    optionKey?: string;
    pricePerNight?: number;
    totalPrice?: number;
    currency?: string;
    hotelName?: string;
    category?: number;
    roomType?: string;
    mealPlanCode?: string;
    bookingCode?: string;
    searchReference?: string;
    roomId?: string | number;
    rateId?: string | number;
    roomCount?: number;
    extraBedCount?: number;
    extraBedRate?: number;
    extraBedAmount?: number;
    extraBedGstAmount?: number;
    hotelMarginPercentage?: number;
    basePricePerNight?: number;
    baseTotalPrice?: number;
    hotelMarginAmount?: number;
    hotelMarginStayAmount?: number;
    hotelMarginTotalAmount?: number;
    hotelMarginGstAmount?: number;
    amountIncludesHotelMargin?: boolean;
    pricingIncludesHotelMargin?: boolean;
    numberOfNights?: number;
    nightlyRates?: Array<Record<string, unknown>>;
    routeDate?: string;
     requestedBy?: number;
    /** Internal transaction client used by atomic multi-route saves. */
    transactionClient?: any;
  }) {
    // groupType is the target recommendation package being edited. It must be
    // explicit; never infer it from the selected inventory row or default it
    // to Group 1 because that can overwrite a different package's row.
    data = { ...data, groupType: this.requireTargetGroupType(data.groupType) };
    if (String(data.provider || '').trim().toLowerCase() === 'offline' || String(data.rateOptionId || '').startsWith('offline:')) {
      return this.selectOfflineHotel(data);
    }
    const db = data.transactionClient || this.prisma;
    const userId = 1;
    const liveRateMetadata = this.getLiveRateMetadata(data.provider);

 // Get the quote ID and Day 1 early-check-in metadata.
    const [plan, route, previousDayMarker] = await Promise.all([
      db.dvi_itinerary_plan_details.findUnique({
        where: { itinerary_plan_ID: data.planId },
      }),
      (db as any).dvi_itinerary_route_details.findFirst({
        where: {
          itinerary_plan_ID: data.planId,
          itinerary_route_ID: data.routeId,
          deleted: 0,
        },
      }),
      (db as any).dvi_itinerary_plan_hotel_details.findFirst({
        where: {
          itinerary_plan_id: data.planId,
          itinerary_route_id: data.routeId,
          group_type: data.groupType || 1,
          hotel_required: 2,
          hotel_id: 0,
          deleted: 0,
          status: 1,
        },
      }),
    ]);
    const quoteId = (plan as any)?.itinerary_quote_ID || '';
    // The itinerary occupancy is the minimum authoritative room count. Older
    // frontend payloads can still send roomCount=1 from a supplier row even
    // when the plan requests multiple rooms.
    const itineraryRoomCount = Math.max(Number((plan as any)?.preferred_room_count || 1), 1);
    data = {
      ...data,
      roomCount: Math.max(Number(data.roomCount || 1), itineraryRoomCount),
    };
    const normalizedProvider = String(data.provider || '').trim().toLowerCase();
    const hasLiveSupplierRateIdentity =
      ['tbo', 'axisrooms', 'staah', 'resavenue', 'hobse'].includes(normalizedProvider) &&
      Boolean(
        String(data.hotelCode || '').trim() ||
        String(data.rateOptionId || '').trim() ||
        String(data.optionKey || '').trim() ||
        String(data.searchReference || '').trim() ||
        String(data.bookingCode || '').trim(),
      );
    if (
      (!Number.isInteger(Number(data.hotelId)) || Number(data.hotelId) <= 0) &&
      !hasLiveSupplierRateIdentity
    ) {
      throw new BadRequestException('Hotel selection requires a canonical dvi_hotel.hotel_id');
    }
    await this.validateLiveSelectionAgainstSnapshot(data, plan, quoteId, route);

    const actualGuestArrivalAt = (plan as any)?.trip_start_date_and_time
      ? new Date((plan as any).trip_start_date_and_time)
      : null;
    const routeDate = route?.itinerary_route_date
      ? new Date(route.itinerary_route_date)
      : null;
    const hotelCheckOutDate = routeDate && !Number.isNaN(routeDate.getTime())
      ? new Date(Date.UTC(
          routeDate.getUTCFullYear(),
          routeDate.getUTCMonth(),
          routeDate.getUTCDate() + 1,
          0,
          0,
          0,
        ))
      : null;
    const shouldApplyEarlyCheckIn =
      Boolean(previousDayMarker?.itinerary_route_date) &&
      Boolean(actualGuestArrivalAt && !Number.isNaN(actualGuestArrivalAt.getTime())) &&
      (Number((plan as any)?.itinerary_preference || 0) === 1 ||
        Number((plan as any)?.itinerary_preference || 0) === 3);
    const earlyCheckInNote = shouldApplyEarlyCheckIn
      ? `Guest has opted for early morning check-in with extra payment. ` +
        `Room to be blocked from ${new Date(previousDayMarker.itinerary_route_date).toISOString().slice(0, 10)}, ` +
        `with actual guest arrival/check-in on ${actualGuestArrivalAt!.toISOString().slice(0, 10)} ` +
        `at ${actualGuestArrivalAt!.toISOString().slice(11, 19)}.`
      : null;
    const earlyCheckInData = shouldApplyEarlyCheckIn
      ? {
          hotel_check_in_date: previousDayMarker.itinerary_route_date,
          actual_guest_arrival_at: actualGuestArrivalAt,
          hotel_check_out_date: hotelCheckOutDate,
          early_checkin: 1,
          early_checkin_extra_payment_applicable: 1,
          early_checkin_payment_status: 'EXTRA_PAYMENT_APPLICABLE',
          early_checkin_note: earlyCheckInNote,
        }
      : {
          hotel_check_in_date: null,
          actual_guest_arrival_at: null,
          hotel_check_out_date: null,
          early_checkin: 0,
          early_checkin_extra_payment_applicable: 0,
          early_checkin_payment_status: null,
          early_checkin_note: null,
        };

 // Check if hotel assignment already exists in hotel_details
    const existingHotelCandidates = await (db as any).dvi_itinerary_plan_hotel_details.findMany({
      where: {
        itinerary_plan_id: data.planId,
        itinerary_route_id: data.routeId,
        group_type: data.groupType || 1,
        hotel_required: 1,
        deleted: 0,
        status: 1,
      },
      orderBy: { itinerary_plan_hotel_details_ID: 'desc' },
    });
    const selectionKey = hotelSelectionKey(
      data.planId,
      data.routeId,
      data.groupType || 1,
      route?.itinerary_route_date,
    );
    const existingHotelDetails = existingHotelCandidates.find((row: any) =>
      hotelSelectionKeyFromRow(data.planId, row) === selectionKey,
    ) || existingHotelCandidates[0];
    const canonicalHotelId = Number(data.canonicalHotelId ?? data.hotelId ?? 0);
    const persistedHotelId = canonicalHotelId > 0 ? canonicalHotelId : null;
    const persistedHotelCode =
      String(data.providerHotelCode || data.hotelCode || existingHotelDetails?.hotel_code || '').trim() || null;
    let selectionPricing = resolveHotelSelectionPricing({
      totalPrice: data.totalPrice,
      pricePerNight: data.pricePerNight,
      roomCount: data.roomCount,
    });
    const providerForPricing = String(data.provider || '').trim().toLowerCase();
    let axisRoomsBasePrice = 0;
    let axisRoomsSupplementRates: { extraBedRate: number; childWithBedRate: number; childWithoutBedRate: number } | null = null;
    if (String(data.provider || '').trim().toLowerCase() === 'axisrooms') {
      axisRoomsBasePrice = await this.resolveAxisRoomsSelectionBasePrice(data, route);
      axisRoomsSupplementRates = await this.resolveAxisRoomsSelectionSupplementRates(data, route);
    }
    // Selection requests intentionally contain identity, not occupancy
    // quantities. When a client omits them, use the itinerary plan as the
    // authoritative source instead of persisting zero supplements.
    const extraBedCount = Math.max(Math.trunc(Number(
      data.extraBedCount ?? (plan as any)?.total_extra_bed ?? 0,
    )), 0);
    const extraBedRate = Math.max(Number(
      providerForPricing === 'axisrooms'
        ? axisRoomsSupplementRates?.extraBedRate ?? data.extraBedRate ?? 0
        : data.extraBedRate || 0,
    ), 0);
    const extraBedAmount = Math.max(
      Number(data.extraBedAmount ?? (extraBedCount * extraBedRate)),
      0,
    );
    const extraBedGstAmount = Math.max(Number(data.extraBedGstAmount || 0), 0);
    const childWithBedCount = Math.max(Math.trunc(Number(
      (data as any).childWithBedCount ?? (plan as any)?.total_child_with_bed ?? 0,
    )), 0);
    const childWithBedRate = Math.max(Number(
      providerForPricing === 'axisrooms'
        ? axisRoomsSupplementRates?.childWithBedRate ?? (data as any).childWithBedRate ?? 0
        : (data as any).childWithBedRate || 0,
    ), 0);
    const childWithBedAmount = Math.max(
      Number((data as any).childWithBedAmount ?? (childWithBedCount * childWithBedRate)),
      0,
    );
    const childWithoutBedCount = Math.max(Math.trunc(Number(
      (data as any).childWithoutBedCount ?? (plan as any)?.total_child_without_bed ?? 0,
    )), 0);
    const childWithoutBedRate = Math.max(Number(
      providerForPricing === 'axisrooms'
        ? axisRoomsSupplementRates?.childWithoutBedRate ?? (data as any).childWithoutBedRate ?? 0
        : (data as any).childWithoutBedRate || 0,
    ), 0);
    const childWithoutBedAmount = Math.max(
      Number((data as any).childWithoutBedAmount ?? (childWithoutBedCount * childWithoutBedRate)),
      0,
    );
    const globalSettingsModel = (db as any).dvi_global_settings;
    const globalSettings = globalSettingsModel
      ? await globalSettingsModel.findFirst({
          where: { deleted: 0, status: 1 },
          orderBy: { global_settings_ID: 'asc' },
          select: { hotel_margin: true },
        })
      : null;
    const configuredMargin = globalSettings?.hotel_margin ?? process.env.HOTEL_MARGIN ?? 0;
    const requestedHotelMargin = Number(data.hotelMarginPercentage);
    const hotelMaster = providerForPricing === 'axisrooms' && persistedHotelId
      ? await (db as any).dvi_hotel?.findUnique?.({
          where: { hotel_id: persistedHotelId },
          select: { hotel_margin: true },
        })
      : null;
    const hotelMasterMargin = Number(hotelMaster?.hotel_margin || 0);
    const suppliedHotelMargin = Number(data.hotelMarginPercentage || 0);
    const hotelMarginPercentage = Math.max(
      providerForPricing === 'axisrooms'
        ? hotelMasterMargin > 0
          ? hotelMasterMargin
          : Number(configuredMargin || requestedHotelMargin || 0)
        : suppliedHotelMargin > 0
          ? suppliedHotelMargin
          : Number(configuredMargin || 0),
      0,
    );
    // STAAH's nightly occupancy amount is the supplier room cost before our
    // margin.  Older clients sent the previous row's margin amount, which
    // caused a fresh ₹1,630 rate to be reconciled as ₹1,666 (using the stale
    // ₹290 margin from a ₹1,450 rate).  Derive the payable amount and margin
    // from this option's own base amount instead.
    const pricingAlreadyIncludesMargin = data.amountIncludesHotelMargin === true ||
      data.pricingIncludesHotelMargin === true;
    const staahBasePricePerNight = providerForPricing === 'staah'
      ? Math.max(Number(
          pricingAlreadyIncludesMargin
            ? data.basePricePerNight || data.pricePerNight
            : data.pricePerNight,
        ), 0)
      : 0;
    const staahBaseTotal = staahBasePricePerNight > 0
      ? Number((staahBasePricePerNight * Math.max(Number(data.roomCount || 1), 1)).toFixed(2))
      : 0;
    const staahMarginRate = staahBaseTotal > 0
      ? Number((staahBaseTotal * hotelMarginPercentage / 100).toFixed(2))
      : 0;
    if (providerForPricing === 'staah' && staahBaseTotal > 0) {
      data.pricePerNight = Number((staahBasePricePerNight * (1 + hotelMarginPercentage / 100)).toFixed(2));
      data.totalPrice = Number((staahBaseTotal + staahMarginRate).toFixed(2));
      selectionPricing = resolveHotelSelectionPricing({
        totalPrice: data.totalPrice,
        pricePerNight: data.pricePerNight,
        roomCount: data.roomCount,
      });
    }
    if (axisRoomsBasePrice > 0) {
      const axisRoomsMarginBase = Number((
        axisRoomsBasePrice + extraBedAmount + childWithBedAmount + childWithoutBedAmount
      ).toFixed(2));
      const axisRoomsMargin = Number((axisRoomsMarginBase * hotelMarginPercentage / 100).toFixed(2));
      const authoritativePayable = Number((axisRoomsMarginBase + axisRoomsMargin).toFixed(2));
      // AxisRooms selections must be priced from the matching ARI row, never
      // from a stale client payload that can combine another option's total.
      data.pricePerNight = Number((authoritativePayable / Math.max(Number(data.roomCount || 1), 1)).toFixed(2));
      data.totalPrice = authoritativePayable;
      data.basePricePerNight = Number((axisRoomsBasePrice / Math.max(Number(data.roomCount || 1), 1)).toFixed(2));
      data.baseTotalPrice = axisRoomsBasePrice;
      (data as any).hotelMarginBaseAmount = axisRoomsMarginBase;
      data.hotelMarginAmount = axisRoomsMargin;
      data.hotelMarginTotalAmount = axisRoomsMargin;
      selectionPricing = resolveHotelSelectionPricing({
        totalPrice: authoritativePayable,
        pricePerNight: authoritativePayable,
        roomCount: data.roomCount,
      });
    }
    const suppliedBasePricePerNight = Math.max(Number(data.basePricePerNight || 0), 0);
    const suppliedBaseTotal = Math.max(
      Number(data.baseTotalPrice || 0) ||
        suppliedBasePricePerNight * Math.max(Number(data.roomCount || 1), 1),
      0,
    );
    const effectiveRoomCount = Math.max(Number(data.roomCount || 1), 1);
    const authoritativeBasePricePerNight = axisRoomsBasePrice > 0
      ? Number((axisRoomsBasePrice / effectiveRoomCount).toFixed(2))
      : staahBasePricePerNight > 0
        ? staahBasePricePerNight
        : suppliedBasePricePerNight;
    const authoritativeBaseTotal = axisRoomsBasePrice > 0
      ? axisRoomsBasePrice
      : staahBaseTotal > 0
        ? staahBaseTotal
        : suppliedBaseTotal;
    const suppliedMarginAmount = Math.max(Number(
      data.hotelMarginStayAmount ?? data.hotelMarginTotalAmount ?? data.hotelMarginAmount ?? 0,
    ), 0);
    const hotelMarginBaseAmount = providerForPricing === 'axisrooms' && axisRoomsBasePrice > 0
      ? Number((axisRoomsBasePrice + extraBedAmount + childWithBedAmount + childWithoutBedAmount).toFixed(2))
      : authoritativeBaseTotal;
    const hotelMarginRate = providerForPricing === 'axisrooms'
      ? hotelMarginBaseAmount > 0
         ? Number((hotelMarginBaseAmount * hotelMarginPercentage / 100).toFixed(2))
        : 0
      : providerForPricing === 'staah' && staahMarginRate > 0
      ? staahMarginRate
      : suppliedMarginAmount > 0
        ? suppliedMarginAmount
        : authoritativeBaseTotal > 0 && hotelMarginPercentage > 0
          ? Number((authoritativeBaseTotal * hotelMarginPercentage / 100).toFixed(2))
          // Preserve legacy live-provider behavior in this surgical fix. An
          // Offline rate is never allowed to derive markup from payable; its
          // catalog path supplies authoritative base and margin explicitly.
          : providerForPricing !== 'offline'
            ? Math.max((selectionPricing.totalPrice * hotelMarginPercentage) / 100, 0)
            : 0;
    const hotelMarginRateTaxAmount = Math.max(Number(data.hotelMarginGstAmount || 0), 0);
    const persistedRoomCost = providerForPricing === 'axisrooms' && axisRoomsBasePrice > 0
      ? axisRoomsBasePrice
      : selectionPricing.totalPrice;
    const authoritativePricingSnapshot = {
      ...(authoritativeBasePricePerNight > 0 ? { basePricePerNight: authoritativeBasePricePerNight } : {}),
      ...(authoritativeBaseTotal > 0 ? { baseTotalPrice: authoritativeBaseTotal } : {}),
      ...(hotelMarginBaseAmount > 0 ? { hotelMarginBaseAmount } : {}),
      ...(hotelMarginPercentage > 0 ? { hotelMarginPercentage } : {}),
      ...(hotelMarginRate > 0 ? {
        hotelMarginAmount: hotelMarginRate,
        hotelMarginTotalAmount: hotelMarginRate,
      } : {}),
      ...(Number(data.numberOfNights || 0) > 0 ? { numberOfNights: Number(data.numberOfNights) } : {}),
      ...(Array.isArray(data.nightlyRates) ? { nightlyRates: data.nightlyRates } : {}),
    };

    const rawMealBreakfast = data.mealPlan?.breakfast || data.mealPlan?.all ? 1 : 0;
    const rawMealLunch = data.mealPlan?.lunch || data.mealPlan?.all ? 1 : 0;
    const rawMealDinner = data.mealPlan?.dinner || data.mealPlan?.all ? 1 : 0;
    const canonicalMealPlanCode =
      inferCanonicalHotelRatePlanCode(data.mealPlanCode) ||
      inferCanonicalHotelRatePlanCodeFromMealText(data.mealPlanCode) ||
      (rawMealBreakfast || rawMealLunch || rawMealDinner
        ? inferCanonicalHotelRatePlanCodeFromMealFlags(rawMealBreakfast, rawMealLunch, rawMealDinner)
        : null);
    const canonicalMealFlags = canonicalMealPlanCode
      ? getCanonicalMealPlanFlags(canonicalMealPlanCode)
      : {
          all: false,
          breakfast: Boolean(rawMealBreakfast),
          lunch: Boolean(rawMealLunch),
          dinner: Boolean(rawMealDinner),
        };
    const mealBreakfast = canonicalMealFlags.breakfast ? 1 : 0;
    const mealLunch = canonicalMealFlags.lunch ? 1 : 0;
    const mealDinner = canonicalMealFlags.dinner ? 1 : 0;

    let hotelDetailsId: number;

    if (existingHotelDetails) {
 // Update existing hotel assignment
 console.log(` Updating existing hotel - Old ID: ${existingHotelDetails.hotel_id}, New ID: ${persistedHotelId ?? 'NULL'}, GroupType: ${data.groupType}`);
      await (db as any).dvi_itinerary_plan_hotel_details.update({
        where: { itinerary_plan_hotel_details_ID: existingHotelDetails.itinerary_plan_hotel_details_ID },
        data: {
          hotel_id: persistedHotelId,
          hotel_code: persistedHotelCode,
          hotel_required: 1,
          ...earlyCheckInData,
 group_type: data.groupType || 1, // Save groupType
          updatedon: new Date(),
          ...liveRateMetadata,
          selected_rate_option_id: data.rateOptionId || data.optionKey || null,
          selected_price_per_night: data.pricePerNight ?? null,
          selected_total_price: selectionPricing.totalPrice,
          total_no_of_rooms: selectionPricing.roomCount,
            total_room_cost: persistedRoomCost,
          // This column is non-nullable; zero is a valid margin amount.
          hotel_margin_percentage: hotelMarginPercentage,
          hotel_margin_rate: hotelMarginRate,
          // This column is non-nullable; zero is a valid tax amount.
          hotel_margin_rate_tax_amt: hotelMarginRateTaxAmount,
          total_hotel_cost: selectionPricing.totalPrice,
           total_extra_bed_cost: extraBedAmount,
           total_childwith_bed_cost: childWithBedAmount,
           total_childwithout_bed_cost: childWithoutBedAmount,
          total_extra_bed_cost_gst_amount: extraBedGstAmount,
          selected_currency: data.currency || null,
          selection_origin: 'USER_SELECTED',
            selected_price_snapshot: JSON.stringify({
              optionKey: data.optionKey || null,
              rateOptionId: data.rateOptionId || null,
              hotelCode: data.hotelCode || null,
              canonicalHotelId: data.canonicalHotelId ?? data.hotelId ?? null,
              providerHotelCode: data.providerHotelCode || null,
              selectionKey: data.selectionKey || null,
              provider: data.provider || null,
              selectionOrigin: 'USER_SELECTED',
            hotelName: data.hotelName || null,
            category: data.category || null,
            roomTypeId: data.roomTypeId || null,
            roomType: data.roomType || null,
            mealPlan: canonicalMealPlanCode || null,
            bookingCode: data.bookingCode || null,
            searchReference: data.searchReference || null,
            roomId: data.roomId || null,
            rateId: data.rateId || null,
            extraBedCount,
            extraBedRate,
             extraBedAmount,
             extraBedGstAmount,
             childWithBedCount,
             childWithBedRate,
             childWithBedAmount,
             childWithoutBedCount,
             childWithoutBedRate,
             childWithoutBedAmount,
            ...authoritativePricingSnapshot,
            hotelMarginGstAmount: hotelMarginRateTaxAmount,
            pricePerNight: data.pricePerNight ?? null,
            totalPrice: selectionPricing.totalPrice || null,
            ...(providerForPricing === 'staah' && staahBasePricePerNight > 0 ? {
              basePricePerNight: staahBasePricePerNight,
              baseTotalPrice: staahBaseTotal,
              roomCostTaxAmount: 0,
            } : {}),
          }),
        },
      });
      await (db as any).dvi_itinerary_plan_hotel_details.updateMany({
        where: {
          itinerary_plan_id: data.planId,
          itinerary_route_id: data.routeId,
          group_type: data.groupType || 1,
          hotel_required: 1,
          deleted: 0,
          status: 1,
          itinerary_plan_hotel_details_ID: { not: existingHotelDetails.itinerary_plan_hotel_details_ID },
        },
        data: { status: 0, deleted: 1, updatedon: new Date() },
      });
      const updated = await (db as any).dvi_itinerary_plan_hotel_details.findUnique({
        where: { itinerary_plan_hotel_details_ID: existingHotelDetails.itinerary_plan_hotel_details_ID },
      });
 console.log(` Updated. New values - hotel_id: ${(updated as any).hotel_id}, group_type: ${(updated as any).group_type}`);
      hotelDetailsId = existingHotelDetails.itinerary_plan_hotel_details_ID;
    } else {
 // Create new hotel assignment
 console.log(` Creating new hotel - ID: ${persistedHotelId ?? 'NULL'}, GroupType: ${data.groupType}`);
      const created = await (db as any).dvi_itinerary_plan_hotel_details.create({
        data: {
          itinerary_plan_id: data.planId,
          itinerary_route_id: data.routeId,
          itinerary_route_date: route?.itinerary_route_date || null,
          itinerary_route_location:
            route?.next_visiting_location || route?.location_name || null,
          hotel_id: persistedHotelId,
          hotel_code: persistedHotelCode,
          hotel_required: 1,
          ...earlyCheckInData,
 group_type: data.groupType || 1, // Save groupType
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
          ...liveRateMetadata,
          selected_rate_option_id: data.rateOptionId || data.optionKey || null,
          selected_price_per_night: data.pricePerNight ?? null,
          selected_total_price: selectionPricing.totalPrice,
          total_no_of_rooms: selectionPricing.roomCount,
           total_room_cost: persistedRoomCost,
          // This column is non-nullable; zero is a valid margin amount.
          hotel_margin_percentage: hotelMarginPercentage,
          hotel_margin_rate: hotelMarginRate,
          // This column is non-nullable; zero is a valid tax amount.
          hotel_margin_rate_tax_amt: hotelMarginRateTaxAmount,
          total_hotel_cost: selectionPricing.totalPrice,
           total_extra_bed_cost: extraBedAmount,
           total_childwith_bed_cost: childWithBedAmount,
           total_childwithout_bed_cost: childWithoutBedAmount,
          total_extra_bed_cost_gst_amount: extraBedGstAmount,
          selected_currency: data.currency || null,
          selection_origin: 'USER_SELECTED',
          selected_price_snapshot: JSON.stringify({
            optionKey: data.optionKey || null,
            rateOptionId: data.rateOptionId || null,
            hotelCode: data.hotelCode || null,
            canonicalHotelId: data.canonicalHotelId ?? data.hotelId ?? null,
            providerHotelCode: data.providerHotelCode || null,
            selectionKey: data.selectionKey || null,
            provider: data.provider || null,
            selectionOrigin: 'USER_SELECTED',
            hotelName: data.hotelName || null,
            category: data.category || null,
            roomTypeId: data.roomTypeId || null,
            roomType: data.roomType || null,
            mealPlan: canonicalMealPlanCode || null,
            bookingCode: data.bookingCode || null,
            searchReference: data.searchReference || null,
            roomId: data.roomId || null,
            rateId: data.rateId || null,
            extraBedCount,
            extraBedRate,
             extraBedAmount,
             extraBedGstAmount,
             childWithBedCount,
             childWithBedRate,
             childWithBedAmount,
             childWithoutBedCount,
             childWithoutBedRate,
             childWithoutBedAmount,
            ...authoritativePricingSnapshot,
            hotelMarginGstAmount: hotelMarginRateTaxAmount,
            pricePerNight: data.pricePerNight ?? null,
            totalPrice: selectionPricing.totalPrice || null,
            ...(providerForPricing === 'staah' && staahBasePricePerNight > 0 ? {
              basePricePerNight: staahBasePricePerNight,
              baseTotalPrice: staahBaseTotal,
              roomCostTaxAmount: 0,
            } : {}),
          }),
        },
      });
 console.log(` Created. Values - hotel_id: ${(created as any).hotel_id}, group_type: ${(created as any).group_type}`);
      hotelDetailsId = created.itinerary_plan_hotel_details_ID;
    }

 // Check if room details already exist
    const existingRoomDetails = await (db as any).dvi_itinerary_plan_hotel_room_details.findFirst({
      where: {
        itinerary_plan_hotel_details_id: hotelDetailsId,
        deleted: 0,
        status: 1,
      },
      orderBy: { itinerary_plan_hotel_room_details_ID: 'desc' },
    });

    if (existingRoomDetails) {
 // Update existing room details
      await (db as any).dvi_itinerary_plan_hotel_room_details.update({
        where: { itinerary_plan_hotel_room_details_ID: existingRoomDetails.itinerary_plan_hotel_room_details_ID },
        data: {
          hotel_id: persistedHotelId,
          room_type_id: data.roomTypeId,
          room_qty: selectionPricing.roomCount,
          room_rate: selectionPricing.roomRate,
          total_room_cost: selectionPricing.totalPrice,
          extra_bed_count: extraBedCount,
          extra_bed_rate: extraBedRate,
          breakfast_required: mealBreakfast,
          lunch_required: mealLunch,
          dinner_required: mealDinner,
          updatedon: new Date(),
        },
      });
      await (db as any).dvi_itinerary_plan_hotel_room_details.updateMany({
        where: {
          itinerary_plan_hotel_details_id: hotelDetailsId,
          deleted: 0,
          status: 1,
          itinerary_plan_hotel_room_details_ID: { not: existingRoomDetails.itinerary_plan_hotel_room_details_ID },
        },
        data: { status: 0, deleted: 1, updatedon: new Date() },
      });
    } else {
 // Create new room details
      await (db as any).dvi_itinerary_plan_hotel_room_details.create({
        data: {
          itinerary_plan_hotel_details_id: hotelDetailsId,
          itinerary_plan_id: data.planId,
          itinerary_route_id: data.routeId,
          hotel_id: persistedHotelId,
          room_type_id: data.roomTypeId,
          room_qty: selectionPricing.roomCount,
          room_rate: selectionPricing.roomRate,
          total_room_cost: selectionPricing.totalPrice,
          extra_bed_count: extraBedCount,
          extra_bed_rate: extraBedRate,
          breakfast_required: mealBreakfast,
          lunch_required: mealLunch,
          dinner_required: mealDinner,
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });
    }

    // A live selection changes the durable assignment. Invalidate the
    // per-quote hotel-details cache so a subsequent itinerary reload reads
    // this USER_SELECTED rate instead of reconstructing the previous
    // auto-selected row from the stale snapshot.
    if (plan?.itinerary_quote_ID && !data.transactionClient) {
      this.hotelDetailsTboService.clearCacheForQuote(String(plan.itinerary_quote_ID));
    }

    return {
      success: true,
      message: 'Hotel selected successfully',
    };
  }

  private getLiveRateMetadata(provider?: string) {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    if (!['tbo', 'axisrooms', 'staah', 'resavenue', 'hobse'].includes(normalizedProvider)) return {};
    if (normalizedProvider === 'axisrooms') {
      // AxisRooms availability and price are read from our ARI-synchronised
      // tables. Booking is still supplier-bookable, but this is not a live
      // search price and must not be labelled as one in the persisted row.
      return {
        hotel_provider: normalizedProvider,
        hotel_booking_mode: 'LIVE_API',
        price_source: 'DATABASE',
        is_live_rate: false,
        hotel_approval_status: 'NOT_REQUIRED',
        manual_confirmation_status: 'NOT_STARTED',
        requires_price_reacceptance: false,
      };
    }
    return {
      hotel_provider: normalizedProvider,
      hotel_booking_mode: 'LIVE_API',
      price_source: 'LIVE_API',
      is_live_rate: true,
      hotel_approval_status: 'NOT_REQUIRED',
      manual_confirmation_status: 'NOT_STARTED',
      requires_price_reacceptance: false,
    };
  }

  private async selectOfflineHotel(data: {
    planId: number;
    routeId: number;
    hotelId: number;
    roomTypeId: number;
    canonicalHotelId?: number;
    rateOptionId?: string;
    roomCount?: number;
    routeDate?: string;
    groupType?: number;
    mealPlan?: { all?: boolean; breakfast?: boolean; lunch?: boolean; dinner?: boolean };
    requestedBy?: number;
    transactionClient?: any;
  }) {
    data = { ...data, groupType: this.requireTargetGroupType(data.groupType) };
    const canonicalHotelId = Number(data.canonicalHotelId ?? data.hotelId ?? 0);
    const rateOptionId = String(data.rateOptionId || '').trim();
    if (!canonicalHotelId || !rateOptionId) {
      throw new BadRequestException('Offline hotel selection requires canonicalHotelId and rateOptionId');
    }

    let resolvedRate;
    try {
      if (!this.offlineHotelCatalogService) throw new Error('Offline hotel catalog service is not configured');
      resolvedRate = await this.offlineHotelCatalogService.resolveOfflineRateOption({
        planId: Number(data.planId),
        routeId: Number(data.routeId),
        routeDate: data.routeDate,
        canonicalHotelId,
        rateOptionId,
        roomCount: Number(data.roomCount || 0) > 0
          ? Number(data.roomCount)
          : undefined,
      });
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Offline hotel rate is stale or invalid');
    }

    const requestedBy = Number(data.requestedBy || 1);
    const effectiveRoomCount = Math.max(
      Number(resolvedRate.roomCount || data.roomCount || 1),
      1,
    );
    const now = new Date();
    const resolvedRouteId = Number(resolvedRate.routeId || data.routeId);
    const routeNight = resolvedRate.nightlyRates.find((night: any) => night.date === resolvedRate.routeDate);
    if (!routeNight) {
      throw new BadRequestException('Offline hotel pricing does not contain the selected route night');
    }
    const routeBaseAmount = Number(routeNight.baseAmount || 0);
    const routeMarginAmount = Number(routeNight.marginAmount || 0);
    const routePayableAmount = Number(routeNight.sellAmount || 0);
    if (Math.abs(routeBaseAmount + routeMarginAmount - routePayableAmount) > 0.01) {
      throw new BadRequestException({
        code: 'HOTEL_PRICING_INTEGRITY_ERROR',
        message: 'Offline hotel base, margin, and payable amounts do not reconcile.',
      });
    }
    // One DB row represents one itinerary route/night. Keep the complete stay
    // totals under explicit stay-prefixed fields so downstream row sums cannot
    // accidentally charge the full continuous stay once per route.
    const routeSnapshot = {
      ...resolvedRate,
      pricingScope: 'ROUTE_NIGHT',
      stayBaseTotalPrice: resolvedRate.baseTotalPrice,
      stayHotelMarginTotalAmount: resolvedRate.hotelMarginTotalAmount,
      stayTotalPrice: resolvedRate.totalStayPrice,
      basePricePerNight: routeBaseAmount,
      baseTotalPrice: routeBaseAmount,
      hotelMarginAmount: routeMarginAmount,
      hotelMarginTotalAmount: routeMarginAmount,
      pricePerNight: routePayableAmount,
      totalPrice: routePayableAmount,
      totalStayPrice: routePayableAmount,
      numberOfNights: 1,
      nightlyRates: [routeNight],
    };
    const snapshot = JSON.stringify(routeSnapshot);
    const checkInDate = resolvedRate.routeDate || routeNight.date || null;
    const checkOutDate = checkInDate
      ? toDatabaseBusinessDate(checkInDate)
      : null;
    if (checkOutDate) checkOutDate.setUTCDate(checkOutDate.getUTCDate() + 1);

    // Load the plan before the transaction callback. The callback needs the
    // itinerary occupancy counts when creating room details.
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: Number(data.planId) },
      select: { total_extra_bed: true, total_child_with_bed: true, itinerary_quote_ID: true },
    });

    const persist = async (tx: any) => {
      const existingHotelCandidates = await (tx as any).dvi_itinerary_plan_hotel_details.findMany({
        where: {
          itinerary_plan_id: Number(data.planId),
          itinerary_route_id: resolvedRouteId,
          group_type: Number(data.groupType || 1),
          hotel_required: 1,
          deleted: 0,
          status: 1,
        },
        orderBy: { itinerary_plan_hotel_details_ID: 'desc' },
      });
      const offlineSelectionKey = hotelSelectionKey(
        Number(data.planId),
        resolvedRouteId,
        Number(data.groupType || 1),
        checkInDate,
      );
      const existingHotel = existingHotelCandidates.find((row: any) =>
        hotelSelectionKeyFromRow(Number(data.planId), row) === offlineSelectionKey,
      ) || existingHotelCandidates[0];
      const hotelData = {
        hotel_id: resolvedRate.canonicalHotelId,
        hotel_code: String(resolvedRate.canonicalHotelId),
        hotel_required: 1,
        hotel_provider: 'offline',
        hotel_booking_mode: 'MANUAL_APPROVAL',
        price_source: 'DATABASE',
        is_live_rate: false,
        selected_rate_option_id: rateOptionId,
        selected_price_per_night: routePayableAmount,
        selected_total_price: routePayableAmount,
        selected_currency: resolvedRate.currency,
        selection_origin: 'USER_SELECTED',
        selected_price_snapshot: snapshot,
        total_no_of_rooms: effectiveRoomCount,
        total_room_cost: routeBaseAmount,
        total_extra_bed_cost: Number(resolvedRate.extraBedAmount || 0),
        total_childwith_bed_cost: Number(resolvedRate.childWithBedAmount || 0),
        hotel_margin_percentage: resolvedRate.hotelMarginPercentage,
        hotel_margin_rate: routeMarginAmount,
        hotel_margin_rate_tax_amt: 0,
        total_hotel_cost: routePayableAmount,
        hotel_approval_status: 'PENDING_APPROVAL',
        hotel_approval_requested_at: now,
        hotel_approval_requested_by: requestedBy,
        hotel_approved_at: null,
        hotel_approved_by: null,
        hotel_rejected_at: null,
        hotel_rejected_by: null,
        hotel_approval_notes: null,
        manual_confirmation_status: 'NOT_STARTED',
        manual_confirmation_requested_at: null,
        manually_confirmed_at: null,
        manually_confirmed_by: null,
        manual_confirmation_notes: null,
        requires_price_reacceptance: false,
        updatedon: now,
        status: 1,
        deleted: 0,
        ...(checkInDate ? { hotel_check_in_date: toDatabaseBusinessDate(checkInDate) } : {}),
        ...(checkOutDate ? { hotel_check_out_date: checkOutDate } : {}),
      };
      const selection = existingHotel
        ? await (tx as any).dvi_itinerary_plan_hotel_details.update({
            where: { itinerary_plan_hotel_details_ID: existingHotel.itinerary_plan_hotel_details_ID },
            data: hotelData,
          })
        : await (tx as any).dvi_itinerary_plan_hotel_details.create({
            data: {
              itinerary_plan_id: Number(data.planId),
              itinerary_route_id: resolvedRouteId,
              group_type: Number(data.groupType || 1),
              createdby: requestedBy,
              createdon: now,
              itinerary_route_date: checkInDate ? toDatabaseBusinessDate(checkInDate) : null,
              ...hotelData,
            },
          });

      const existingRoom = await (tx as any).dvi_itinerary_plan_hotel_room_details.findFirst({
        where: { itinerary_plan_hotel_details_id: selection.itinerary_plan_hotel_details_ID, deleted: 0 },
      });
      const roomData = {
        hotel_id: resolvedRate.canonicalHotelId,
        room_id: resolvedRate.roomId,
        room_type_id: resolvedRate.roomTypeId,
        room_qty: effectiveRoomCount,
        room_rate: routePayableAmount,
        total_room_cost: routePayableAmount,
        extra_bed_count: Math.max(Number(plan.total_extra_bed || 0), 0),
        extra_bed_rate: Number(resolvedRate.extraBedRate || 0),
        child_with_bed_count: Math.max(Number(plan.total_child_with_bed || 0), 0),
        child_with_bed_charges: Number(resolvedRate.childWithBedAmount || 0),
        breakfast_required: data.mealPlan?.breakfast || data.mealPlan?.all ? 1 : 0,
        lunch_required: data.mealPlan?.lunch || data.mealPlan?.all ? 1 : 0,
        dinner_required: data.mealPlan?.dinner || data.mealPlan?.all ? 1 : 0,
        status: 1,
        deleted: 0,
        updatedon: now,
      };
      if (existingRoom) {
        await (tx as any).dvi_itinerary_plan_hotel_room_details.update({
          where: { itinerary_plan_hotel_room_details_ID: existingRoom.itinerary_plan_hotel_room_details_ID },
          data: roomData,
        });
      } else {
        await (tx as any).dvi_itinerary_plan_hotel_room_details.create({
          data: {
            itinerary_plan_hotel_details_id: selection.itinerary_plan_hotel_details_ID,
            itinerary_plan_id: Number(data.planId),
            itinerary_route_id: resolvedRouteId,
            group_type: Number(data.groupType || 1),
            createdby: requestedBy,
            createdon: now,
            ...roomData,
          },
        });
      }

      await (tx as any).dvi_itinerary_plan_hotel_approval_history.create({
        data: {
          itinerary_plan_hotel_details_id: selection.itinerary_plan_hotel_details_ID,
          previous_approval_status: existingHotel?.hotel_approval_status || 'NOT_REQUESTED',
          new_approval_status: 'PENDING_APPROVAL',
          previous_confirmation_status: existingHotel?.manual_confirmation_status || 'NOT_STARTED',
          new_confirmation_status: 'NOT_STARTED',
          price: routePayableAmount,
          currency: resolvedRate.currency,
          notes: 'Offline hotel selection requested',
          acted_by: requestedBy,
          acted_at: now,
          metadata: snapshot,
        },
      });
    };
    if (data.transactionClient) await persist(data.transactionClient);
    else await this.prisma.$transaction(persist);

    if (plan?.itinerary_quote_ID && !data.transactionClient) this.hotelDetailsTboService.clearCacheForQuote(String(plan.itinerary_quote_ID));
    return {
      success: true,
      message: 'Hotel selected successfully and is pending hotel approval',
      approvalStatus: 'PENDING_APPROVAL',
      manualConfirmationStatus: 'NOT_STARTED',
      canonicalHotelId: resolvedRate.canonicalHotelId,
      rateOptionId,
    };
  }

 /**
   * Bulk save hotel selections - used before confirming itinerary
 */
  async bulkSaveHotels(
    planId: number,
    hotels: any[],
    requestedBy = 1,
    skipSupplierRefresh = false,
    lockAlreadyHeld = false,
  ) {

    if (!Array.isArray(hotels) || hotels.length === 0) {
      throw new BadRequestException('At least one hotel selection is required');
    }
    const groups = new Set(hotels.map((hotel) => this.requireTargetGroupType(hotel.groupType)));
    if (groups.size !== 1) {
      throw new BadRequestException('Atomic hotel persistence requires one recommendation group per operation');
    }

 // Get the quote ID to clear the cache
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: planId },
    });
    const quoteId = (plan as any)?.itinerary_quote_ID || '';

 console.log(` Bulk saving ${hotels.length} hotel(s) for plan ${planId}`);

    const lockName = `itinerary-hotel-selection:${planId}:${String(hotels[0]?.groupType || 1)}`;
    const databaseUrl = String(process.env.DATABASE_URL || '').trim();
    if (!lockAlreadyHeld && !databaseUrl) {
      throw new InternalServerErrorException({
        code: 'HOTEL_SELECTION_LOCK_UNAVAILABLE',
        message: 'The hotel selection lock could not be established.',
      });
    }
    const lockConnection = lockAlreadyHeld ? null : await createConnection(databaseUrl);
    let lockAcquired = false;
    try {
      if (lockConnection) {
        const lockResult: any = await lockConnection.query('SELECT GET_LOCK(?, 10) AS acquired', [lockName]);
        lockAcquired = Number((lockResult as any)?.[0]?.[0]?.acquired || 0) === 1;
        if (!lockAcquired) throw new BadRequestException('Another hotel selection is being applied. Please retry.');
      }

      // Supplier refresh is deliberately outside the Prisma transaction, but
      // inside the plan/group lock. A late refresh from request A therefore
      // cannot overwrite a newer request B after B has committed.
      for (const hotel of skipSupplierRefresh ? [] : hotels) {
        const provider = String(hotel.provider || '').trim().toLowerCase();
        const hotelCode = String(hotel.providerHotelCode || hotel.hotelCode || hotel.hotelId || '').trim();
        if (!provider || provider === 'offline' || !hotelCode || !plan?.itinerary_quote_ID) continue;
        const refreshed = await this.hotelDetailsTboService.getSelectedHotelRates(
          String(plan.itinerary_quote_ID), Number(hotel.routeId), provider, hotelCode, Number(hotel.groupType),
        );
        if (!Array.isArray(refreshed?.hotels) || refreshed.hotels.length === 0) {
          throw new BadRequestException(`No current rates are available for ${hotelCode}`);
        }
        if (this.hotelAvailabilitySnapshotService) {
          await this.hotelAvailabilitySnapshotService.mergeSelectedHotelRates(
            String(plan.itinerary_quote_ID), Number(hotel.routeId), provider, hotelCode, refreshed.hotels,
          );
        }
      }

      await this.prisma.$transaction(async (tx: any) => {
        for (const hotel of hotels) {
          await this.selectHotel({
            planId,
          routeId: hotel.routeId,
            selectionIntent: hotel.selectionIntent,
            hotelId: hotel.hotelId,
            roomTypeId: hotel.roomTypeId || 1,
            groupType: hotel.groupType,
            mealPlan: hotel.mealPlan,
            canonicalHotelId: hotel.canonicalHotelId ?? hotel.hotelId,
            providerHotelCode: hotel.providerHotelCode,
            selectionKey: hotel.selectionKey,
            rateOptionId: hotel.rateOptionId,
            provider: hotel.provider,
            hotelCode: hotel.hotelCode,
            optionKey: hotel.optionKey,
            pricePerNight: hotel.selectionPricingSource === 'SERVER_RESOLVED' || hotel.selectionIntent === 'RATE_OPTION'
              ? hotel.pricePerNight
              : undefined,
            totalPrice: hotel.selectionPricingSource === 'SERVER_RESOLVED' || hotel.selectionIntent === 'RATE_OPTION'
              ? hotel.totalPrice
              : undefined,
            currency: hotel.currency,
            hotelName: hotel.hotelName,
            category: hotel.category,
            roomType: hotel.roomType,
            mealPlanCode: hotel.mealPlanCode,
            bookingCode: hotel.bookingCode,
            searchReference: hotel.searchReference,
            roomId: hotel.roomId,
            rateId: hotel.rateId,
            roomCount: hotel.roomCount,
            extraBedCount: hotel.extraBedCount,
            extraBedRate: hotel.extraBedRate,
            extraBedAmount: hotel.extraBedAmount,
            extraBedGstAmount: hotel.extraBedGstAmount,
            requestedBy,
            transactionClient: tx,
          });
        }
      });
    } finally {
      if (lockConnection) {
        if (lockAcquired) {
          try { await lockConnection.query('SELECT RELEASE_LOCK(?)', [lockName]); } catch { /* connection close releases it */ }
        }
        await lockConnection.end();
      }
    }

 // Clear cache once at the end
    if (quoteId) {
      this.hotelDetailsTboService.clearCacheForQuote(quoteId);
    }

    return {
      success: true,
      message: `Successfully saved ${hotels.length} hotel selections`,
    };
  }

  /**
   * A selection must come from the latest persisted availability snapshot.
   * The fallback for test doubles/legacy installations is intentionally only
   for databases where the snapshot model is unavailable; production has this
   table because automatic availability validation owns the durable search boundary.
   */
  private async validateLiveSelectionAgainstSnapshot(
    data: any,
    plan: any,
    quoteId: string,
    route?: any,
  ): Promise<void> {
    const provider = String(data.provider || '').trim().toLowerCase();
    if (!provider || provider === 'offline') return;

    // A property/room/meal selection is intentionally not a concrete rate
    // selection. It must be resolved by the current availability source
    // (AxisRooms occupancy data for AX) rather than compared with a stale
    // client/container price from the search cache. Exact RATE_OPTION
    // selections continue through the strict snapshot identity/price check.
    const selectionIntent = String(data.selectionIntent || '').trim().toUpperCase();
    // selectHotelIntentUnlocked resolves a property-level intent into a
    // concrete route option before persistence. Therefore checking for rate
    // identity here is incorrect: those generated identities belong to the
    // server's current selection, not to a client-supplied RATE_OPTION.
    // Property/room/meal intents have already been resolved against current
    // candidates and continuous-stay availability by the caller.
    if (['HOTEL', 'ROOM_TYPE', 'MEAL_PLAN'].includes(selectionIntent)) {
      return;
    }

    if (provider === 'axisrooms' || provider === 'ax') {
      this.assertAxisRoomsReferenceMatchesRoute(data, route);

      // AxisRooms is not a live-search snapshot provider in this flow. Its
      // availability and price are read from the ARI tables populated by the
      // daily inventory feed. Validate that source directly and do not require
      // a prior search-result row, which may be absent or belong to another
      // request lifecycle.
      if (await this.isCurrentAxisRoomsDatabaseRate(data, route)) return;

    }

    // A selection is validated against a fresh provider/local-source lookup
    // for that property. Full inventory is never recovered from a database or
    // process cache between the search response and this selection request.
    const freshResult = await this.hotelDetailsTboService.getSelectedHotelRates(
      quoteId,
      Number(data.routeId),
      provider,
      String(data.hotelCode || data.providerHotelCode || data.hotelId || ''),
      Number(data.groupType || 0),
    );
    const rows = (Array.isArray((freshResult as any)?.hotels) ? (freshResult as any).hotels : [])
      .map((full_payload: any) => ({ full_payload }));
    const requestedRateIds = [data.selectionKey, data.rateOptionId, data.optionKey, data.searchReference, data.bookingCode]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    const requestedCanonicalId = Number((data.canonicalHotelId ?? data.hotelId) || 0);
    const requestedHotelCode = String(
      data.hotelCode || data.providerHotelCode || data.provider_hotel_code || '',
    ).trim().toLowerCase();
    const requestedRoomType = String(data.roomType || '').trim().toLowerCase();
    const requestedHotelName = String(data.hotelName || '').trim().toLowerCase();
    const requestedMealPlan =
      inferCanonicalHotelRatePlanCode(data.mealPlanCode) ||
      inferCanonicalHotelRatePlanCodeFromMealText(data.mealPlanCode) ||
      '';
    const parsedRows = rows
      .map((row: any) => {
        try { return typeof row.full_payload === 'string' ? JSON.parse(row.full_payload) : row.full_payload; } catch { return null; }
      })
      .filter(Boolean);
    const targetGroupType = Number(data.groupType || 0);
    const groupScopedRows = parsedRows.filter((row: any) => {
      const candidateGroupType = Number(row?.groupType ?? row?.group_type ?? 0);
      return !targetGroupType || candidateGroupType === 0 || candidateGroupType === targetGroupType;
    });
    const candidateRows = groupScopedRows.flatMap((row: any) => {
      const rateOptions = Array.isArray(row?.rateOptions) ? row.rateOptions : [];
      if (rateOptions.length === 0) return [row];
      // A hotel row is a container for its room/rate options. Prefer the
      // concrete option when validating a selection so a parent row cannot
      // hide the selected option's price and room identity.
      return [...rateOptions.map((option: any) => normalizeSupplierRateIdentity({
        ...row,
        ...option,
        provider: option.provider || row.provider,
        canonicalHotelId: row.canonicalHotelId ?? option.canonicalHotelId,
        hotelId: row.hotelId ?? option.hotelId,
        hotelCode: row.hotelCode || row.providerHotelCode || option.hotelCode,
        hotelName: row.hotelName || option.hotelName,
        roomType: option.roomType || option.roomTypeName || row.roomType,
        mealPlan: option.mealPlan || option.mealPlanCode || option.ratePlanName || row.mealPlan,
        bookingCode: option.bookingCode || row.bookingCode,
        searchReference: option.searchReference || row.searchReference,
        rateOptionId: option.rateOptionId || option.rate_option_id || row.rateOptionId,
        optionKey: option.optionKey || option.option_key || row.optionKey,
        roomId: option.roomId || option.room_id || row.roomId,
        rateId: option.rateId || option.rate_id || option.rateOptionId || row.rateId,
      })), normalizeSupplierRateIdentity(row)];
    });
    const propertyMatches = (candidate: any): boolean => {
        if (String(candidate.provider || '').trim().toLowerCase() !== provider) return false;
        const candidateCanonicalId = Number(candidate.canonicalHotelId ?? candidate.hotelId ?? candidate.hotel_id ?? 0);
        const candidateHotelCode = String(
          candidate.providerHotelCode || candidate.provider_hotel_code || candidate.hotelCode || candidate.hotel_code || '',
        ).trim().toLowerCase();
        const canonicalMatch = requestedCanonicalId > 0 && candidateCanonicalId > 0 && candidateCanonicalId === requestedCanonicalId;
        const codeMatch = Boolean(requestedHotelCode && candidateHotelCode && requestedHotelCode === candidateHotelCode);
        if (!canonicalMatch && !codeMatch) return false;
        return true;
    };
    const candidateMealPlan = (candidate: any): string =>
      inferCanonicalHotelRatePlanCode(candidate?.mealPlanCode) ||
      inferCanonicalHotelRatePlanCodeFromMealText(
        candidate?.mealPlan || candidate?.meal_plan || candidate?.ratePlanName,
      ) ||
      '';
    const rateMatches = (candidate: any): boolean => {
      // A card-level HOTEL selection can intentionally omit a concrete rate
      // identity. In that case select the current lowest rate for the
      // requested property/meal plan; do not reject it as stale merely because
      // the UI did not send a nested bookingCode.
      if (requestedRateIds.length === 0) {
        if (!requestedMealPlan) return true;
        return candidateMealPlan(candidate) === requestedMealPlan;
      }
      return supplierRateIdentityMatches(data, candidate);
    };
    const matchingCandidates = candidateRows.filter((candidate: any) => {
      if (!propertyMatches(candidate) || !rateMatches(candidate)) return false;
      const candidateRoomType = String(candidate.roomType || candidate.room_type || '').trim().toLowerCase();
      const candidateHotelName = String(candidate.hotelName || candidate.hotel_name || '').trim().toLowerCase();
      if (requestedRoomType && candidateRoomType && requestedRoomType !== candidateRoomType) return false;
      if (requestedHotelName && candidateHotelName && requestedHotelName !== candidateHotelName) return false;
      return true;
    });
    const matched = matchingCandidates
      .sort((left: any, right: any) => Number(left.totalPrice ?? left.totalStayPrice ?? left.price ?? Infinity) - Number(right.totalPrice ?? right.totalStayPrice ?? right.price ?? Infinity))[0];

    if (!matched) {
      throw new BadRequestException('The selected hotel rate is stale or unavailable. Refresh hotel availability and select again.');
    }

    const requestedTotal = Number(data.totalPrice ?? 0);
    const explicitSnapshotTotals = [
      matched.totalStayPrice,
      matched.totalPrice,
      matched.totalAmount,
      matched.totalAmountAfterTax,
      matched.totalHotelCost,
      matched.totalCost,
      matched.totalRoomCost,
      matched.total_hotel_cost,
    ].map(Number).filter((amount) => Number.isFinite(amount) && amount > 0);
    // Only use a nightly price as a fallback when the snapshot does not
    // expose any stay-level amount. Comparing a multi-night selection with a
    // per-night value can incorrectly accept or reject a stale selection.
    const snapshotTotals = explicitSnapshotTotals.length > 0
      ? explicitSnapshotTotals
      : [matched.price, matched.pricePerNight, matched.price_per_night]
        .map(Number)
        .filter((amount) => Number.isFinite(amount) && amount > 0);
    if (requestedTotal > 0 && snapshotTotals.length > 0 && !snapshotTotals.some((snapshotTotal) => Math.abs(requestedTotal - snapshotTotal) <= 0.01)) {
      console.error('[HOTEL_SELECTION_PRICE_MISMATCH]', JSON.stringify({
        planId: data.planId,
        routeId: data.routeId,
        groupType: data.groupType,
        provider,
        hotelCode: requestedHotelCode,
        requestedTotal,
        snapshotTotals,
        matched: {
          rateOptionId: matched.rateOptionId,
          bookingCode: matched.bookingCode,
          selectionKey: matched.selectionKey,
          totalPrice: matched.totalPrice,
          totalStayPrice: matched.totalStayPrice,
          pricePerNight: matched.pricePerNight,
          groupType: matched.groupType ?? matched.group_type,
        },
      }));
      throw new BadRequestException('The selected hotel price changed. Refresh hotel availability and review the updated rate.');
    }
  }

  private toDateOnly(value: unknown): string {
    const parsed = value ? new Date(String(value)) : new Date('invalid');
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
  }

  private axisRoomsReferenceDate(value: unknown): string {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const isoDate = raw.match(/(20\d{2})[-](\d{2})[-](\d{2})/);
    if (isoDate) return `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}`;
    const compactDate = raw.match(/(?:^|[-|:])((20\d{2})(\d{2})(\d{2}))(?:$|[-|:])/i);
    return compactDate ? `${compactDate[2]}-${compactDate[3]}-${compactDate[4]}` : '';
  }

  private parseAxisRoomsRateReference(data: any): {
    hotelId: number;
    roomId: number;
    rateplanId: string;
    date: string;
  } {
    const references = [data?.rateOptionId, data?.optionKey, data?.searchReference, data?.bookingCode]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    let hotelId = Number(data?.canonicalHotelId ?? data?.hotelId ?? 0) || 0;
    let roomId = Number(data?.roomId || 0) || 0;
    let rateplanId = String(data?.rateId || '').trim();
    let date = '';

    for (const reference of references) {
      const rateOption = reference.match(/^axisrooms:(\d+):(\d+):([^:|]+):(\d{4}-\d{2}-\d{2})$/i);
      if (rateOption) {
        hotelId = Number(rateOption[1]) || hotelId;
        roomId = Number(rateOption[2]) || roomId;
        rateplanId = rateOption[3] || rateplanId;
        date = rateOption[4];
        break;
      }
      const optionRate = reference.match(/axisrooms[:|](\d+)[:|](\d+)[:|]([^:|]+)[:|](\d{4}-\d{2}-\d{2})/i);
      if (optionRate) {
        hotelId = Number(optionRate[1]) || hotelId;
        roomId = Number(optionRate[2]) || roomId;
        rateplanId = optionRate[3] || rateplanId;
        date = optionRate[4];
      }
      const booking = reference.match(/^AX[-:](\d+)[-:](\d{8})$/i);
      if (booking) {
        hotelId = Number(booking[1]) || hotelId;
        date = `${booking[2].slice(0, 4)}-${booking[2].slice(4, 6)}-${booking[2].slice(6, 8)}`;
      }
      date = date || this.axisRoomsReferenceDate(reference);
    }

    return { hotelId, roomId, rateplanId, date };
  }

  private assertAxisRoomsReferenceMatchesRoute(data: any, route?: any): void {
    const routeDate = this.toDateOnly(route?.itinerary_route_date);
    if (!routeDate) return;
    const references = [data?.rateOptionId, data?.optionKey, data?.searchReference, data?.bookingCode]
      .map((value) => this.axisRoomsReferenceDate(value))
      .filter(Boolean);
    const uniqueReferenceDates = Array.from(new Set(references));
    if (uniqueReferenceDates.length > 1 || (uniqueReferenceDates.length === 1 && uniqueReferenceDates[0] !== routeDate)) {
      throw new BadRequestException({
        message: `The selected AxisRooms rate belongs to ${uniqueReferenceDates[0] || 'another date'}, but this itinerary route is ${routeDate}.`,
        code: 'HOTEL_RATE_ROUTE_DATE_MISMATCH',
        provider: 'axisrooms',
        routeId: Number(data?.routeId || 0),
        routeDate,
        rateDate: uniqueReferenceDates[0] || null,
      });
    }
  }

  private async isCurrentAxisRoomsDatabaseRate(data: any, route?: any): Promise<boolean> {
    const identity = this.parseAxisRoomsRateReference(data);
    const routeDate = this.toDateOnly(route?.itinerary_route_date);
    if (!identity.hotelId || !identity.roomId || !identity.rateplanId || !routeDate || identity.date !== routeDate) return false;

    const availabilityModel = (this.prisma as any).dvi_hotel_room_availability;
    const ratePlanModel = (this.prisma as any).dvi_hotel_room_rate_plan;
    const occupancyModel = (this.prisma as any).dvi_hotel_occupancy_rate;
    if (!availabilityModel?.findFirst || !ratePlanModel?.findFirst || !occupancyModel?.findMany) return false;

    const date = toDatabaseBusinessDate(routeDate);
    const requiredRooms = Math.max(Number(data?.roomCount || 1), 1);
    const [availability, ratePlan, occupancyRows] = await Promise.all([
      availabilityModel.findFirst({
        where: { hotel_id: identity.hotelId, room_id: identity.roomId, start_date: { lte: date }, end_date: { gte: date } },
        orderBy: [{ start_date: 'desc' }, { received_at: 'desc' }],
        select: { free: true },
      }),
      ratePlanModel.findFirst({
        where: { hotel_id: identity.hotelId, room_id: identity.roomId, rateplan_id: identity.rateplanId, axisrooms_room_id: { not: null }, deleted: 0, status: 1 },
        select: { rateplan_id: true },
      }),
      occupancyModel.findMany({
        where: { hotel_id: identity.hotelId, room_id: identity.roomId, rateplan_id: identity.rateplanId, start_date: { lte: date }, end_date: { gte: date } },
        select: { occupancy_rates: true },
      }),
    ]);
    if (!availability || Number(availability.free || 0) < requiredRooms || !ratePlan) return false;
    return occupancyRows.some((row: any) => {
      const values = row?.occupancy_rates && typeof row.occupancy_rates === 'object' ? Object.values(row.occupancy_rates) : [];
      return values.some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
    });
  }

  private async resolveAxisRoomsSelectionBasePrice(data: any, route?: any): Promise<number> {
    const identity = this.parseAxisRoomsRateReference(data);
    const routeDate = this.toDateOnly(route?.itinerary_route_date);
    const occupancyModel = (this.prisma as any).dvi_hotel_occupancy_rate;
    if (!identity.hotelId || !identity.roomId || !identity.rateplanId || !routeDate || !occupancyModel?.findMany) {
      return 0;
    }
    const rows = await occupancyModel.findMany({
      where: {
        hotel_id: identity.hotelId,
        room_id: identity.roomId,
        rateplan_id: identity.rateplanId,
        start_date: { lte: toDatabaseBusinessDate(routeDate) },
        end_date: { gte: toDatabaseBusinessDate(routeDate) },
      },
      select: { occupancy_rates: true, start_date: true, end_date: true, received_at: true },
      orderBy: [{ start_date: 'desc' }, { received_at: 'desc' }],
    });
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: Number(data.planId) },
      select: {
        total_adult: true,
        total_child_with_bed: true,
        total_extra_bed: true,
      } as any,
    });
    const roomCount = Math.max(Math.trunc(Number(data.roomCount || 1)), 1);
    const rateContext = {
      roomCount,
      adults: Number((plan as any)?.total_adult || 0),
      childWithBedCount: Number((plan as any)?.total_child_with_bed || 0),
      extraBedCount: Number((plan as any)?.total_extra_bed || 0),
    };
    // A later-starting legacy row may contain only EXTRABED/child
    // supplements. Do not let that row become the room price. Select the
    // most recent matching row that actually contains SINGLE/DOUBLE.
    const rateRow = rows.find((row: any) =>
      this.extractAxisroomsRate(row.occupancy_rates, rateContext) > 0,
    );
    const amount = rateRow
      ? this.extractAxisroomsRate(rateRow.occupancy_rates, rateContext)
      : 0;
    return Number.isFinite(amount) && amount > 0 ? Number(amount.toFixed(2)) : 0;
  }

  private async resolveAxisRoomsSelectionSupplementRates(
    data: any,
    route?: any,
  ): Promise<{ extraBedRate: number; childWithBedRate: number; childWithoutBedRate: number }> {
    const identity = this.parseAxisRoomsRateReference(data);
    const routeDate = this.toDateOnly(route?.itinerary_route_date);
    const occupancyModel = (this.prisma as any).dvi_hotel_occupancy_rate;
    if (!identity.hotelId || !identity.roomId || !identity.rateplanId || !routeDate || !occupancyModel?.findMany) {
      return { extraBedRate: 0, childWithBedRate: 0, childWithoutBedRate: 0 };
    }
    const rows = await occupancyModel.findMany({
      where: {
        hotel_id: identity.hotelId,
        room_id: identity.roomId,
        rateplan_id: identity.rateplanId,
        start_date: { lte: toDatabaseBusinessDate(routeDate) },
        end_date: { gte: toDatabaseBusinessDate(routeDate) },
      },
      select: { occupancy_rates: true, start_date: true, received_at: true },
      orderBy: [{ start_date: 'desc' }, { received_at: 'desc' }],
    });
    const matchingRow = (rows || []).find((row: any) => {
      const values = row?.occupancy_rates && typeof row.occupancy_rates === 'object'
        ? row.occupancy_rates as Record<string, unknown>
        : {};
      return ['SINGLE', 'DOUBLE'].some((key) => Number(values[key]) > 0);
    });
    const values = matchingRow?.occupancy_rates && typeof matchingRow.occupancy_rates === 'object'
      ? matchingRow.occupancy_rates as Record<string, unknown>
      : {};
    return {
      extraBedRate: Math.max(Number(values.EXTRABED ?? values.EXTRAADULT ?? values.EXTRACHILD ?? 0), 0),
      childWithBedRate: Math.max(Number(values.CHILD_WITH_BED ?? 0), 0),
      childWithoutBedRate: Math.max(Number(values.CHILD_WITHOUT_BED ?? 0), 0),
    };
  }

  private extractAxisroomsRate(
    occupancyRates: unknown,
    pax?: { roomCount?: number; adults?: number; childWithBedCount?: number; extraBedCount?: number },
  ): number {
    const values = occupancyRates && typeof occupancyRates === 'object'
      ? occupancyRates as Record<string, unknown>
      : {};
    const roomCount = Math.max(Math.trunc(Number(pax?.roomCount || 1)), 1);
    const adults = Math.max(Math.trunc(Number(pax?.adults || 0)), 0);
    if (adults > 0) {
      const adultsPerRoom = Math.max(Math.ceil(adults / roomCount), 1);
      const occupancyKey = adultsPerRoom <= 1 ? 'SINGLE' : 'DOUBLE';
      const roomRate = Number(values[occupancyKey]);
      if (Number.isFinite(roomRate) && roomRate > 0) {
        const extraBeds = Math.max(
          Math.trunc(Number(pax?.extraBedCount || 0)),
          0,
        );
        const extraBedRate = Number(values.EXTRABED ?? values.EXTRAADULT ?? values.EXTRACHILD ?? 0);
        // Return only the room occupancy amount. Supplements are persisted
        // separately and must not be folded into the room base.
        return roomRate * roomCount;
      }
    }
    // Supplements are not room rates. In particular, never use EXTRABED as
    // the room price when a legacy occupancy row has no SINGLE/DOUBLE value.
    for (const key of ['SINGLE', 'DOUBLE']) {
      const value = Number(values[key]);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return 0;
  }

  private async getVehicleRateAvailabilityForEligible(
    planId: number,
    vendorEligibleId: number,
  ) {
    const detailRows = await this.prisma.$queryRawUnsafe(`
      SELECT
        travel_type,
        total_pickup_km,
        total_running_km,
        total_siteseeing_km,
        total_drop_km,
        vehicle_rental_charges
      FROM dvi_itinerary_plan_vendor_vehicle_details
      WHERE itinerary_plan_id = ${Number(planId)}
        AND itinerary_plan_vendor_eligible_ID = ${Number(vendorEligibleId)}
        AND deleted = 0
    `) as any[];

    return getVehicleRateAvailability(detailRows);
  }

 async selectVehicleVendor(data: {
  planId: number;
  vehicleTypeId: number;
  vendorEligibleId: number;
}) {
  const planId = Number(data.planId || 0);
  const vehicleTypeId = Number(data.vehicleTypeId || 0);
  const vendorEligibleId = Number(data.vendorEligibleId || 0);

  const selectedEligible = await (
    this.prisma as any
  ).dvi_itinerary_plan_vendor_eligible_list.findFirst({
    where: {
      itinerary_plan_vendor_eligible_ID: vendorEligibleId,
      itinerary_plan_id: planId,
      vehicle_type_id: vehicleTypeId,
      status: 1,
      deleted: 0,
    },
  });

  if (!selectedEligible) {
    throw new NotFoundException(
      'Selected vendor eligible row not found for plan/vehicle type',
    );
  }

  const { rows: activeSelectedRows } =
    await filterActiveVendorCandidateRows<any>(
      this.prisma,
      [selectedEligible],
    );

  if (!activeSelectedRows.length) {
    throw new BadRequestException(
      'Selected vendor is no longer active and cannot be assigned',
    );
  }

  const selectedRateAvailability =
    await this.getVehicleRateAvailabilityForEligible(
      planId,
      vendorEligibleId,
    );

  if (!selectedRateAvailability.available) {
    throw new BadRequestException(
      'Selected vendor does not have applicable local or outstation rates for this vehicle type',
    );
  }

  const requiredVehicleRows =
    await this.prisma.dvi_itinerary_plan_vehicle_details.findMany({
      where: {
        itinerary_plan_id: planId,
        vehicle_type_id: vehicleTypeId,
        status: 1,
        deleted: 0,
      },
      select: {
        vehicle_count: true,
      },
    });

  const requiredVehicleCount = Math.max(
    1,
    requiredVehicleRows.reduce(
      (sum, row) => sum + Number(row.vehicle_count || 0),
      0,
    ),
  );

  const candidateRows = await (
    this.prisma as any
  ).dvi_itinerary_plan_vendor_eligible_list.findMany({
    where: {
      itinerary_plan_id: planId,
      vehicle_type_id: vehicleTypeId,
      vehicle_grand_total: { gt: 0 },
      status: 1,
      deleted: 0,
    },
    orderBy: [
      { vehicle_grand_total: 'asc' },
      { itinerary_plan_vendor_eligible_ID: 'asc' },
    ],
  });

  const { rows: activeCandidateRows } =
    await filterActiveVendorCandidateRows<any>(
      this.prisma,
      candidateRows,
    );

  const rateValidCandidates: any[] = [];

  for (const candidate of activeCandidateRows) {
    const candidateEligibleId = Number(
      candidate.itinerary_plan_vendor_eligible_ID || 0,
    );

    const availability =
      candidateEligibleId === vendorEligibleId
        ? selectedRateAvailability
        : await this.getVehicleRateAvailabilityForEligible(
            planId,
            candidateEligibleId,
          );

    if (availability.available) {
      rateValidCandidates.push(candidate);
    }
  }

  const isSameSelectedVendor = (candidate: any) =>
    Number(candidate.vendor_id || 0) ===
      Number(selectedEligible.vendor_id || 0) &&
    Number(candidate.vendor_branch_id || 0) ===
      Number(selectedEligible.vendor_branch_id || 0) &&
    Number(candidate.vendor_vehicle_type_id || 0) ===
      Number(selectedEligible.vendor_vehicle_type_id || 0);

  const selectedCandidate = rateValidCandidates.find(
    (candidate) =>
      Number(candidate.itinerary_plan_vendor_eligible_ID || 0) ===
      vendorEligibleId,
  );

  if (!selectedCandidate) {
    throw new BadRequestException(
      'Selected vehicle vendor is no longer available',
    );
  }

  const remainingCandidates = rateValidCandidates
    .filter(
      (candidate) =>
        Number(candidate.itinerary_plan_vendor_eligible_ID || 0) !==
        vendorEligibleId,
    )
    .sort((a, b) => {
      const sameVendorDifference =
        Number(!isSameSelectedVendor(a)) -
        Number(!isSameSelectedVendor(b));

      if (sameVendorDifference !== 0) {
        return sameVendorDifference;
      }

      const amountDifference =
        Number(a.vehicle_grand_total || 0) -
        Number(b.vehicle_grand_total || 0);

      if (amountDifference !== 0) {
        return amountDifference;
      }

      return (
        Number(a.itinerary_plan_vendor_eligible_ID || 0) -
        Number(b.itinerary_plan_vendor_eligible_ID || 0)
      );
    });

  const assignedRows = [
    selectedCandidate,
    ...remainingCandidates,
  ].slice(0, requiredVehicleCount);

  const assignedVendorEligibleIds = assignedRows
    .map((row) =>
      Number(row.itinerary_plan_vendor_eligible_ID || 0),
    )
    .filter((id) => id > 0);

  await this.prisma.$transaction(async (tx) => {
    await (
      tx as any
    ).dvi_itinerary_plan_vendor_eligible_list.updateMany({
      where: {
        itinerary_plan_id: planId,
        vehicle_type_id: vehicleTypeId,
        status: 1,
        deleted: 0,
      },
      data: {
        itineary_plan_assigned_status: 0,
      },
    });

    await (
      tx as any
    ).dvi_itinerary_plan_vendor_eligible_list.updateMany({
      where: {
        itinerary_plan_vendor_eligible_ID: {
          in: assignedVendorEligibleIds,
        },
      },
      data: {
        itineary_plan_assigned_status: 1,
      },
    });

    await (
      tx as any
    ).dvi_itinerary_plan_vehicle_vendor_selection.upsert({
      where: {
        itinerary_plan_id_vehicle_type_id: {
          itinerary_plan_id: planId,
          vehicle_type_id: vehicleTypeId,
        },
      },
      create: {
        itinerary_plan_id: planId,
        vehicle_type_id: vehicleTypeId,
        selected_vendor_eligible_id: vendorEligibleId,
        vendor_id: Number(selectedEligible.vendor_id || 0),
        vendor_branch_id: Number(
          selectedEligible.vendor_branch_id || 0,
        ),
        vendor_vehicle_type_id: Number(
          selectedEligible.vendor_vehicle_type_id || 0,
        ),
        vehicle_id: Number(selectedEligible.vehicle_id || 0),
        selection_source: 'manual',
        createdby: 1,
        createdon: new Date(),
        updatedon: new Date(),
        status: 1,
        deleted: 0,
      },
      update: {
        selected_vendor_eligible_id: vendorEligibleId,
        vendor_id: Number(selectedEligible.vendor_id || 0),
        vendor_branch_id: Number(
          selectedEligible.vendor_branch_id || 0,
        ),
        vendor_vehicle_type_id: Number(
          selectedEligible.vendor_vehicle_type_id || 0,
        ),
        vehicle_id: Number(selectedEligible.vehicle_id || 0),
        selection_source: 'manual',
        updatedon: new Date(),
        status: 1,
        deleted: 0,
      },
    });
  });

  return {
    success: true,
    message: 'Vehicle vendor selected successfully',
    vehicleTypeId,
    selectedVendorEligibleId: vendorEligibleId,
    assignedVendorEligibleIds,
    selectionSource: 'manual' as const,
  };
}

  private async rebuildVehiclePricingWithSlabOverrides(data: {
  planId: number;
  selectedTimeLimitByEligible?: Record<string, number>;
}) {
  const userId = 1;

  await this.itineraryVehiclesEngine.rebuildEligibleVendorList({
    planId: Number(data.planId),
    createdBy: userId,
    selectedTimeLimitByEligible:
      data.selectedTimeLimitByEligible || {},
    beforeVehicleDetailsBuild: async ({
      tx,
      planId,
    }) => {
      await this.routeEngine.rebuildPermitCharges(
        tx,
        Number(planId),
        userId,
      );
    },
  });
}

  // Backward-compatible wrapper for legacy select-slab endpoint.
  async selectVehicleSlab(data: {
    planId: number;
    vehicleTypeId: number;
    vendorEligibleId?: number;
    timeLimitId?: number;
  }) {
    const planId = Number(data?.planId || 0);
    const vehicleTypeId = Number(
      data?.vehicleTypeId || 0,
    );
    const vendorEligibleId = Number(
      data?.vendorEligibleId || 0,
    );
    const timeLimitId = Number(
      data?.timeLimitId || 0,
    );

    if (
      !planId ||
      !vehicleTypeId ||
      !vendorEligibleId ||
      !timeLimitId
    ) {
      throw new BadRequestException(
        'planId, vehicleTypeId, vendorEligibleId and timeLimitId are required',
      );
    }

    const selectedEligible = await (
      this.prisma as any
    ).dvi_itinerary_plan_vendor_eligible_list.findFirst({
      where: {
        itinerary_plan_vendor_eligible_ID:
          vendorEligibleId,
        itinerary_plan_id: planId,
        vehicle_type_id: vehicleTypeId,
        status: 1,
        deleted: 0,
      },
      select: {
        itinerary_plan_vendor_eligible_ID: true,
        vendor_id: true,
        vendor_branch_id: true,
        vendor_vehicle_type_id: true,
        vehicle_id: true,
        vehicle_type_id: true,
      },
    });

    if (!selectedEligible) {
      throw new NotFoundException(
        'Selected vendor eligible row not found for plan/vehicle type',
      );
    }

    const selectedMap: Record<string, number> = {};

    selectedMap[String(vendorEligibleId)] =
      timeLimitId;

    const compositeKey = [
      Number(selectedEligible.vendor_id || 0),
      Number(
        selectedEligible.vendor_branch_id || 0,
      ),
      Number(
        selectedEligible.vendor_vehicle_type_id || 0,
      ),
      Number(selectedEligible.vehicle_id || 0),
    ].join(':');

    selectedMap[compositeKey] = timeLimitId;

   await this.rebuildVehiclePricingWithSlabOverrides({
  planId,
  selectedTimeLimitByEligible: selectedMap,
});
    return {
      success: true,
      message:
        'Vehicle slab selected and pricing recalculated successfully',
      planId,
      vehicleTypeId,
      vendorEligibleId,
      timeLimitId,
    };
  }

// Backward-compatible wrapper for legacy auto-select endpoint.
async autoSelectVehicleSlabs(data: {
  planId: number;
  vehicleTypeId?: number;
}) {
  const planId = Number(data?.planId || 0);
  const vehicleTypeId =
    Number(data?.vehicleTypeId || 0) || 0;

  if (!planId) {
    throw new BadRequestException(
      'planId is required',
    );
  }

  await this.rebuildVehiclePricingWithSlabOverrides({
    planId,
    selectedTimeLimitByEligible: {},
  });

  return {
    success: true,
    message:
      'Vehicle slabs auto-selected and pricing recalculated successfully',
    planId,
    vehicleTypeId: vehicleTypeId || undefined,
  };
}
  async forceRebuildVehiclePricingAfterHotspotChange(
    planId: number,
    routeId?: number,
  ) {
    const normalizedPlanId = Number(planId || 0);

    if (!normalizedPlanId) {
      return;
    }

    const vehicleRowsBefore = await (
      this.prisma as any
    ).dvi_itinerary_plan_vendor_vehicle_details.findMany({
      where: {
        itinerary_plan_id: normalizedPlanId,
        deleted: 0,
        ...(routeId
          ? {
              itinerary_route_id: Number(routeId),
            }
          : {}),
      },
      select: {
        itinerary_route_id: true,
        total_travelled_km: true,
        total_vehicle_amount: true,
      },
    });

    const beforeKm = vehicleRowsBefore.reduce(
      (sum: number, row: any) =>
        sum + Number(row?.total_travelled_km || 0),
      0,
    );

    const beforeAmount = vehicleRowsBefore.reduce(
      (sum: number, row: any) =>
        sum + Number(row?.total_vehicle_amount || 0),
      0,
    );

    console.log(
      '[HOTSPOT_CHANGE_VEHICLE_REBUILD_BEFORE]',
      {
        planId: normalizedPlanId,
        routeId: routeId || null,
        totalKms: Number(beforeKm.toFixed(2)),
        totalAmount: Number(beforeAmount.toFixed(2)),
      },
    );

    await this.itineraryVehiclesEngine.rebuildEligibleVendorList({
      planId: normalizedPlanId,
      createdBy: 1,
      beforeVehicleDetailsBuild: async ({
        tx,
        planId,
      }) => {
        await this.routeEngine.rebuildPermitCharges(
          tx,
          Number(planId),
          1,
        );
      },
    });
  }
}
