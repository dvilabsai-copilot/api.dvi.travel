import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { ItineraryHotelDetailsTboService } from '../itinerary-hotel-details-tbo.service';
import {
  calculateStaahOccupancyAmount,
  type StaahPricingPaxInput,
} from '../helpers/staah-occupancy-pricing';

export type ProviderCode = 'staah' | 'axisrooms' | 'tbo' | 'offline';

export interface StayBlockCandidate {
  planId: number;
  provider: ProviderCode;
  hotelCode: string;
  hotelName?: string;
  roomId?: string;
  rateId?: string;
  roomType?: string;
  mealPlan?: string;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  routeIds: number[];
  stayDates: string[];
  stayKey: string;
  anchorRouteId?: number;
  allowRoomTypeChanges?: boolean;
}

export interface RestrictionConflict {
  date?: string;
  type:
    | 'STOPSELL'
    | 'STATUS_CLOSED'
    | 'CTA'
    | 'CTD'
    | 'MIN_STAY'
    | 'MAX_STAY'
    | 'NO_INVENTORY'
    | 'NO_RATE'
    | 'UNKNOWN';
  message: string;
}

export interface NightlyRate {
  date: string;
  routeId?: number;
  roomId?: string;
  rateId?: string;
  roomType?: string;
  mealPlan?: string;
  rateOptionId?: string;
  bookingCode?: string;
  searchReference?: string;
  amountAfterTax: number;
  baseAmount?: number;
  extraAdultCount?: number;
  extraChildCount?: number;
  extraAdultRate?: number;
  extraChildRate?: number;
}

export interface StayBlockValidationResult {
  continuityStatus?: 'EXACT' | 'MIXED_ROOM_MEAL' | 'BLOCKED';
  continuityWarning?: {
    type: 'ROOM_MEAL_MISMATCH';
    message: string;
    existing?: string;
    selected?: string;
  };
  canBookSingleNight: boolean;
  canBookMultiNight: boolean;
  blocked: boolean;
  provider: ProviderCode;
  hotelName?: string;
  roomType?: string;
  mealPlan?: string;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  routeIds: number[];
  stayKey: string;
  restrictionConflicts: RestrictionConflict[];
  warnings: Array<{ type: string; message: string }>;
  nightlyRates: NightlyRate[];
  totalAmountAfterTax: number;
}

@Injectable()
export class HotelStayBlockValidationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hotelDetails: ItineraryHotelDetailsTboService,
  ) {}

  async previewStayExtension(params: {
    planId: number;
    routeId: number;
    provider: ProviderCode;
    hotelCode: string;
    hotelName?: string;
    roomId?: string;
    rateId?: string;
    roomType?: string;
    mealPlan?: string;
    checkInDate: string;
    groupType?: number;
    allowRoomTypeChanges?: boolean;
  }): Promise<StayBlockValidationResult> {
    const candidate = await this.buildContinuousStayCandidate(params);
    let fullStayValidation = await this.validateCandidate(candidate);
    if (
      candidate.provider === 'staah'
      && candidate.nights > 1
      && fullStayValidation.blocked
      && fullStayValidation.restrictionConflicts.length > 0
      && fullStayValidation.restrictionConflicts.every((conflict) =>
        conflict.type === 'NO_RATE' || conflict.type === 'NO_INVENTORY',
      )
    ) {
      const mixedStayValidation = await this.tryBuildStaahMixedStay(candidate);
      if (mixedStayValidation) {
        fullStayValidation = mixedStayValidation;
      }
    }
    const continuityWarning = candidate.nights > 1 && params.groupType
      ? await this.findExistingRoomMealMismatch(candidate, params.groupType)
      : undefined;

    if (continuityWarning && !fullStayValidation.blocked) {
      fullStayValidation.continuityStatus = 'MIXED_ROOM_MEAL';
      fullStayValidation.continuityWarning = continuityWarning;
      fullStayValidation.warnings = [
        ...fullStayValidation.warnings,
        { type: continuityWarning.type, message: continuityWarning.message },
      ];
    }

    if (candidate.nights <= 1) {
      return {
        ...fullStayValidation,
        canBookSingleNight: !fullStayValidation.blocked,
        warnings: [
          ...fullStayValidation.warnings,
          {
            type: 'INFO',
            message: 'No continuous same-destination hotel night found after this date.',
          },
        ],
      };
    }

    const singleNightValidation = await this.validateCandidate(this.toSingleNightCandidate(candidate));
    return {
      ...fullStayValidation,
      canBookSingleNight: !singleNightValidation.blocked,
    };
  }

  private async findExistingRoomMealMismatch(
    candidate: StayBlockCandidate,
    groupType: number,
  ): Promise<StayBlockValidationResult['continuityWarning'] | undefined> {
    const rows = await (this.prisma as any).dvi_itinerary_plan_hotel_details.findMany({
      where: {
        itinerary_plan_id: candidate.planId,
        group_type: Number(groupType),
        itinerary_route_id: { in: candidate.routeIds },
        hotel_required: 1,
        status: 1,
        deleted: 0,
      },
      select: {
        itinerary_route_id: true,
        hotel_provider: true,
        hotel_code: true,
        hotel_id: true,
        selected_price_snapshot: true,
      },
    });
    const targetProvider = String(candidate.provider || '').trim().toLowerCase();
    const targetHotelCode = this.normalizeText(candidate.hotelCode || '');
    const targetRoom = this.normalizeText(candidate.roomType || '');
    const targetMeal = this.normalizeText(candidate.mealPlan || '');
    const mismatch = rows.find((row: any) => {
      const routeId = Number(row.itinerary_route_id || 0);
      if (!routeId || routeId === Number(candidate.anchorRouteId)) return false;
      if (String(row.hotel_provider || '').trim().toLowerCase() !== targetProvider) return false;
      const rowCode = this.normalizeText(row.hotel_code || row.hotel_id || '');
      if (targetHotelCode && rowCode && rowCode !== targetHotelCode) return false;
      let snapshot: any = {};
      try {
        snapshot = typeof row.selected_price_snapshot === 'string'
          ? JSON.parse(row.selected_price_snapshot)
          : (row.selected_price_snapshot || {});
      } catch {
        snapshot = {};
      }
      const existingRoom = String(snapshot.roomType || snapshot.roomTypeName || '').trim();
      const existingMeal = String(snapshot.mealPlan || snapshot.mealPlanCode || '').trim();
      return this.normalizeText(existingRoom) !== targetRoom || this.normalizeText(existingMeal) !== targetMeal;
    });
    if (!mismatch) return undefined;

    let snapshot: any = {};
    try {
      snapshot = typeof mismatch.selected_price_snapshot === 'string'
        ? JSON.parse(mismatch.selected_price_snapshot)
        : (mismatch.selected_price_snapshot || {});
    } catch {
      snapshot = {};
    }
    const existing = `${String(snapshot.roomType || snapshot.roomTypeName || '-').trim()} / ${String(snapshot.mealPlan || snapshot.mealPlanCode || '-').trim()}`;
    const selected = `${String(candidate.roomType || '-').trim()} / ${String(candidate.mealPlan || '-').trim()}`;
    return {
      type: 'ROOM_MEAL_MISMATCH',
      existing,
      selected,
      message: `This manual selection creates a different room type or meal plan for the same hotel across the itinerary. Existing: ${existing}. Selected: ${selected}. This may be unfair or confusing for families travelling together. Continue only if you want.`,
    };
  }

  async buildContinuousStayCandidate(params: {
    planId: number;
    routeId: number;
    provider: ProviderCode;
    hotelCode: string;
    hotelName?: string;
    roomId?: string;
    rateId?: string;
    roomType?: string;
    mealPlan?: string;
    checkInDate: string;
    allowRoomTypeChanges?: boolean;
  }): Promise<StayBlockCandidate> {
    const routes = await this.prisma.dvi_itinerary_route_details.findMany({
      where: {
        itinerary_plan_ID: params.planId,
        deleted: 0,
        status: 1,
      } as any,
      orderBy: [{ itinerary_route_date: 'asc' }, { itinerary_route_ID: 'asc' }],
      select: {
        itinerary_route_ID: true,
        itinerary_route_date: true,
        location_name: true,
        next_visiting_location: true,
      },
    });

    const index = routes.findIndex((route: any) => Number(route.itinerary_route_ID) === Number(params.routeId));
    if (index < 0) {
      throw new BadRequestException(`Route ${params.routeId} not found for plan ${params.planId}`);
    }

    const currentRoute: any = routes[index];
    // The route table is authoritative for the selected night. Callers may
    // carry the logical stay start date (for example 2026-08-22) while the
    // selected route is a later night (for example route 10702 on
    // 2026-08-23). Using the caller date here collapses the candidate onto
    // the wrong day and produces a false one-night result.
    const routeDate = this.toDateOnly(currentRoute.itinerary_route_date);
    const checkInDate = routeDate || this.toDateOnly(params.checkInDate);
    if (!checkInDate) {
      throw new BadRequestException('checkInDate is required');
    }

    const stayCity = this.normalizeLocation(currentRoute.next_visiting_location || currentRoute.location_name || '');
    const routeIds = [Number(currentRoute.itinerary_route_ID)];
    const stayDates = [checkInDate];

    // Continuity is anchored to the selected route, but a stay can extend in
    // either direction. This is important when the user edits Day 2: Day 1
    // must be checked as well as any following night.
    for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
      const previousRoute: any = routes[previousIndex];
      const expectedDate = this.addDays(checkInDate, -((index - previousIndex)));
      const previousRouteDate = this.toDateOnly(previousRoute.itinerary_route_date);
      if (!previousRouteDate || previousRouteDate !== expectedDate) break;

      const previousDestination = this.normalizeLocation(
        previousRoute.next_visiting_location || previousRoute.location_name || '',
      );
      if (!stayCity || previousDestination !== stayCity) break;

      routeIds.unshift(Number(previousRoute.itinerary_route_ID));
      stayDates.unshift(previousRouteDate);
    }

    for (let nextIndex = index + 1; nextIndex < routes.length; nextIndex += 1) {
      const nextRoute: any = routes[nextIndex];
      const expectedDate = this.addDays(checkInDate, nextIndex - index);
      const nextRouteDate = this.toDateOnly(nextRoute.itinerary_route_date);
      if (!nextRouteDate || nextRouteDate !== expectedDate) break;

      // The overnight destination is the authoritative continuity key. The
      // route's `location_name` can describe the place the vehicle departed
      // from (for example, an airport/previous city) while
      // `next_visiting_location` is the hotel destination. Requiring both
      // fields to equal the anchor made a middle/last-night edit look like a
      // single-night stay even though the itinerary had consecutive nights
      // in the same destination.
      const nextDestination = this.normalizeLocation(
        nextRoute.next_visiting_location || nextRoute.location_name || '',
      );
      if (!stayCity || nextDestination !== stayCity) break;

      routeIds.push(Number(nextRoute.itinerary_route_ID));
      stayDates.push(nextRouteDate);
    }

    const stayStartDate = stayDates[0] || checkInDate;
    const checkOutDate = this.addDays(stayStartDate, stayDates.length);
    const stayKey = [
      params.provider,
      params.hotelCode,
      String(params.roomId || ''),
      String(params.rateId || params.mealPlan || ''),
      `${stayStartDate}_to_${checkOutDate}`,
    ].join(':');

    return {
      planId: params.planId,
      provider: params.provider,
      hotelCode: params.hotelCode,
      hotelName: params.hotelName,
      roomId: params.roomId,
      rateId: params.rateId,
      roomType: params.roomType,
      mealPlan: params.mealPlan,
      checkInDate: stayStartDate,
      checkOutDate,
      nights: stayDates.length,
      routeIds,
      stayDates,
      stayKey,
      anchorRouteId: Number(params.routeId),
      allowRoomTypeChanges: params.allowRoomTypeChanges,
    };
  }

  async validateStaahStayBlock(candidate: StayBlockCandidate): Promise<StayBlockValidationResult> {
    const hotelMaster = await this.resolveHotel(candidate.provider, candidate.hotelCode);
    const propertyId = String(hotelMaster?.staah_property_id || '').trim();
    if (!propertyId) {
      throw new BadRequestException(`STAAH property mapping not found for hotel ${candidate.hotelCode}`);
    }

    const plan = await this.getPlan(candidate.planId);
    const resolvedRoomId = await this.resolveStaahRoomId(
      hotelMaster?.hotel_id,
      propertyId,
      candidate.roomId,
      candidate.roomType,
    );
    const resolvedRate = await this.resolveStaahRatePlan(propertyId, resolvedRoomId, candidate.rateId, candidate.mealPlan);

    const restrictionRows = await this.findStaahRestrictionRows(
      propertyId,
      resolvedRoomId,
      resolvedRate.rateId,
      candidate.checkInDate,
      candidate.checkOutDate,
    );

    const conflicts = this.collectRestrictionConflicts(
      restrictionRows,
      candidate,
      (row: any) => String(row.type || ''),
      (row: any) => String(row.value || ''),
    );

    const paxProfile = this.buildPaxProfile(plan);
    const nightlyRates: NightlyRate[] = [];

    for (const date of candidate.stayDates) {
      const inventory = await this.findStaahInventoryRow(propertyId, resolvedRoomId, date);

      if (!inventory || Number(inventory.free || 0) <= 0) {
        conflicts.push({
          date,
          type: 'NO_INVENTORY',
          message: `No inventory available on ${date}`,
        });
        continue;
      }

      const rateRow = await this.findStaahRateRow(propertyId, resolvedRoomId, resolvedRate.rateId, date);

      if (!rateRow) {
        conflicts.push({
          date,
          type: 'NO_RATE',
          message: `No rate found on ${date}`,
        });
        continue;
      }

      nightlyRates.push(this.buildNightlyRate(
        date,
        calculateStaahOccupancyAmount(rateRow.occupancy_rates, paxProfile),
        Number(candidate.routeIds[candidate.stayDates.indexOf(date)] || 0),
        resolvedRoomId,
        resolvedRate.rateId,
        candidate.roomType,
        resolvedRate.rateName,
        this.buildStaahRateOptionId(candidate.hotelName, resolvedRoomId, resolvedRate.rateId, date),
      ));
    }

    return this.buildValidationResult(candidate, conflicts, nightlyRates);
  }

  async validateAxisRoomsStayBlock(candidate: StayBlockCandidate): Promise<StayBlockValidationResult> {
    const hotelMaster = await this.resolveHotel(candidate.provider, candidate.hotelCode);
    const hotelId = Number(hotelMaster?.hotel_id || 0);
    const propertyId = String(hotelMaster?.axisrooms_property_id || '').trim();
    if (!hotelId || !propertyId) {
      throw new BadRequestException(`AxisRooms property mapping not found for hotel ${candidate.hotelCode}`);
    }

    const plan = await this.getPlan(candidate.planId);
    if (candidate.allowRoomTypeChanges && !candidate.roomId && !candidate.roomType && !candidate.rateId) {
      return this.validateAxisRoomsHotelStay(candidate, hotelId, plan);
    }
    const roomRow = await this.resolveAxisRoom(hotelId, candidate.roomId, candidate.roomType);
    const ratePlan = await this.resolveAxisRatePlan(hotelId, Number(roomRow.room_ID), candidate.rateId, candidate.mealPlan);

    const restrictionRows = await this.prisma.axisrooms_restriction.findMany({
      where: {
        axisrooms_property_id: propertyId,
        room_id: String(roomRow.room_ref_code || ''),
        rateplan_id: ratePlan.ratePlanId,
        start_date: { lte: new Date(candidate.checkOutDate) } as any,
        end_date: { gte: new Date(candidate.checkInDate) } as any,
      },
      orderBy: [{ received_at: 'desc' }, { start_date: 'asc' }] as any,
    });

    const conflicts = this.collectRestrictionConflicts(
      restrictionRows,
      candidate,
      (row: any) => String(row.type || ''),
      (row: any) => String(row.value || ''),
    );

    const paxProfile = this.buildPaxProfile(plan);
    const nightlyRates: NightlyRate[] = [];

    for (const date of candidate.stayDates) {
      const inventory = await (this.prisma as any).dvi_hotel_room_availability.findFirst({
        where: {
          hotel_id: hotelId,
          room_id: Number(roomRow.room_ID),
          start_date: { lte: new Date(date) },
          end_date: { gte: new Date(date) },
        },
        orderBy: { received_at: 'desc' },
      });

      if (!inventory || Number(inventory.free || 0) <= 0) {
        conflicts.push({
          date,
          type: 'NO_INVENTORY',
          message: `No inventory available on ${date}`,
        });
        continue;
      }

      const rateRow = await (this.prisma as any).dvi_hotel_occupancy_rate.findFirst({
        where: {
          hotel_id: hotelId,
          room_id: Number(roomRow.room_ID),
          rateplan_id: ratePlan.ratePlanId,
          start_date: { lte: new Date(date) },
          end_date: { gte: new Date(date) },
        },
        orderBy: { received_at: 'desc' },
      });

      if (!rateRow) {
        conflicts.push({
          date,
          type: 'NO_RATE',
          message: `No rate found on ${date}`,
        });
        continue;
      }

      nightlyRates.push(this.buildNightlyRate(
        date,
        calculateStaahOccupancyAmount(rateRow.occupancy_rates, paxProfile),
        Number(candidate.routeIds[candidate.stayDates.indexOf(date)] || 0),
        String(roomRow.room_ref_code || roomRow.room_ID || ''),
        ratePlan.ratePlanId,
        candidate.roomType || String(roomRow.room_title || ''),
        candidate.mealPlan,
        `axisrooms:${hotelId}:${Number(roomRow.room_ID)}:${ratePlan.ratePlanId}:${date}`,
      ));
    }

    return this.buildValidationResult(candidate, conflicts, nightlyRates);
  }

  /** Validate a HOTEL intent against the cheapest available room per night. */
  private async validateAxisRoomsHotelStay(
    candidate: StayBlockCandidate,
    hotelId: number,
    plan: any,
  ): Promise<StayBlockValidationResult> {
    const rooms = await this.prisma.dvi_hotel_rooms.findMany({
      where: { hotel_id: hotelId, deleted: 0 } as any,
      select: { room_ID: true, room_ref_code: true, room_title: true },
    });
    const paxProfile = this.buildPaxProfile(plan);
    const nightlyRates: NightlyRate[] = [];
    const conflicts: RestrictionConflict[] = [];

    for (const date of candidate.stayDates) {
      const options: Array<{ room: any; ratePlanId: string; amount: number; breakdown: any }> = [];
      let hasInventory = false;

      for (const room of rooms as any[]) {
        const inventory = await (this.prisma as any).dvi_hotel_room_availability.findFirst({
          where: {
            hotel_id: hotelId,
            room_id: Number(room.room_ID),
            start_date: { lte: new Date(date) },
            end_date: { gte: new Date(date) },
          },
          orderBy: { received_at: 'desc' },
        });
        if (!inventory || Number(inventory.free || 0) <= 0) continue;
        hasInventory = true;

        const ratePlan = await this.resolveAxisRatePlan(
          hotelId,
          Number(room.room_ID),
          undefined,
          candidate.mealPlan,
        );
        const rateRow = await (this.prisma as any).dvi_hotel_occupancy_rate.findFirst({
          where: {
            hotel_id: hotelId,
            room_id: Number(room.room_ID),
            rateplan_id: ratePlan.ratePlanId,
            start_date: { lte: new Date(date) },
            end_date: { gte: new Date(date) },
          },
          orderBy: { received_at: 'desc' },
        });
        if (!rateRow) continue;

        const breakdown = calculateStaahOccupancyAmount(rateRow.occupancy_rates, paxProfile);
        options.push({
          room,
          ratePlanId: ratePlan.ratePlanId,
          amount: Number(breakdown.finalCalculatedAmount || 0),
          breakdown,
        });
      }

      const selected = options.sort((left, right) => left.amount - right.amount)[0];
      if (!selected) {
        conflicts.push({
          date,
          type: hasInventory ? 'NO_RATE' : 'NO_INVENTORY',
          message: hasInventory ? `No rate found on ${date}` : `No inventory available on ${date}`,
        });
        continue;
      }

      nightlyRates.push(this.buildNightlyRate(
        date,
        selected.breakdown,
        Number(candidate.routeIds[candidate.stayDates.indexOf(date)] || 0),
        String(selected.room.room_ref_code || selected.room.room_ID || ''),
        selected.ratePlanId,
        String(selected.room.room_title || ''),
        candidate.mealPlan,
        `axisrooms:${hotelId}:${Number(selected.room.room_ID)}:${selected.ratePlanId}:${date}`,
      ));
    }

    return this.buildValidationResult(candidate, conflicts, nightlyRates);
  }

  private async validateCandidate(candidate: StayBlockCandidate): Promise<StayBlockValidationResult> {
    if (candidate.provider === 'staah') {
      return this.validateStaahStayBlock(candidate);
    }
    if (candidate.provider === 'axisrooms') {
      return this.validateAxisRoomsStayBlock(candidate);
    }
    // TBO/offline continuity is validated from a fresh property-scoped lookup.
    return this.validateSnapshotStayBlock(candidate);
  }

  private async validateSnapshotStayBlock(candidate: StayBlockCandidate): Promise<StayBlockValidationResult> {
    const plan = await this.getPlan(candidate.planId);
    const conflicts: RestrictionConflict[] = [];
    const nightlyRates: NightlyRate[] = [];
    let freshRows: Array<{ route_id: number; full_payload: any }> = [];
    try {
      const fresh = await this.hotelDetails.getSelectedHotelRates(
        String((plan as any)?.itinerary_quote_ID || ''),
        Number(candidate.anchorRouteId || candidate.routeIds[0] || 0),
        candidate.provider,
        candidate.hotelCode,
        0,
      );
      freshRows = (Array.isArray((fresh as any)?.hotels) ? (fresh as any).hotels : [])
        .map((full_payload: any) => ({
          route_id: Number(full_payload?.itineraryRouteId || full_payload?.routeId || 0),
          full_payload,
        }));
    } catch (error) {
      return this.buildValidationResult(candidate, [{
        type: 'UNKNOWN',
        message: `The provider could not verify ${candidate.hotelName || candidate.hotelCode}. Please retry.`,
      }], []);
    }
    const parse = (value: any) => {
      try { return typeof value === 'string' ? JSON.parse(value) : (value || {}); } catch { return {}; }
    };
    const normalize = (value: any) => String(value || '').trim().toLowerCase();
    const positiveAmount = (value: unknown): number | null => {
      const amount = Number(value);
      return Number.isFinite(amount) && amount > 0 ? amount : null;
    };
    const snapshotAmount = (option: any): number => {
      // TBO recommendation rows use price/netAmount/totalFare while
      // normalized refresh rows use pricePerNight/totalPrice. Prefer the
      // first positive value so a legacy zero field cannot hide a valid rate.
      const directAmount = [
        option.amountAfterTax,
        option.totalAmountAfterTax,
        option.pricePerNight,
        option.totalPrice,
        option.totalStayPrice,
        option.totalAmount,
        option.totalFare,
        option.netAmount,
        option.price,
      ].map(positiveAmount).find((amount): amount is number => amount !== null);
      if (directAmount !== undefined) return directAmount;
      const roomAmount = Array.isArray(option.roomTypes)
        ? option.roomTypes.map((room: any) => positiveAmount(room?.price)).find((amount): amount is number => amount !== null)
        : undefined;
      return roomAmount ?? 0;
    };
    const property = normalize(candidate.hotelCode);
    const room = normalize(candidate.roomType);
    const meal = normalize(candidate.mealPlan);
    const optionRows = (freshRows || []).flatMap((row: any) => {
      const payload = parse(row.full_payload);
      const options = Array.isArray(payload.rateOptions) ? payload.rateOptions : [payload];
      return options.map((option: any) => ({
        ...payload,
        ...option,
        routeId: Number(row.route_id || payload.routeId || payload.itineraryRouteId || 0),
        provider: String(option.provider || payload.provider || '').trim().toLowerCase(),
        hotelCode: String(option.hotelCode || payload.hotelCode || option.providerHotelCode || payload.providerHotelCode || '').trim(),
        roomType: option.roomType || option.roomTypeName || payload.roomType || payload.roomTypeName,
        mealPlan: option.mealPlan || option.mealPlanCode || payload.mealPlan || payload.mealPlanCode,
      }));
    });

    for (let index = 0; index < candidate.routeIds.length; index += 1) {
      const routeId = Number(candidate.routeIds[index]);
      const date = candidate.stayDates[index];
      const matchingOptions = optionRows.filter((option: any) => {
        if (Number(option.routeId) !== routeId) return false;
        if (normalize(option.provider) !== normalize(candidate.provider)) return false;
        const optionProperty = normalize(option.hotelCode || option.canonicalHotelId || option.hotelId);
        if (property && optionProperty && optionProperty !== property) return false;
        if (room && normalize(option.roomType) && normalize(option.roomType) !== room) return false;
        if (meal && normalize(option.mealPlan) && normalize(option.mealPlan) !== meal) return false;
        return true;
      });
      const matches = matchingOptions
        .map((option: any) => ({ option, amount: snapshotAmount(option) }))
        .filter((entry: any) => entry.amount > 0)
        .sort((left: any, right: any) => left.amount - right.amount);
      const selected = matches[0];
      if (!selected) {
        conflicts.push({
          date,
          type: 'NO_RATE',
          message: matchingOptions.length > 0
            ? `The current rate for ${candidate.hotelName || candidate.hotelCode} has no positive price on ${date}.`
            : `No current rate for ${candidate.hotelName || candidate.hotelCode} on ${date}.`,
        });
        continue;
      }
      const option = selected.option;
      const amount = selected.amount;
      nightlyRates.push({
        date,
        routeId,
        roomId: String(option.roomId || option.room_id || candidate.roomId || '').trim() || undefined,
        rateId: String(option.rateId || option.rate_id || candidate.rateId || '').trim() || undefined,
        roomType: option.roomType || candidate.roomType,
        mealPlan: option.mealPlan || candidate.mealPlan,
        rateOptionId: option.rateOptionId || option.rate_option_id || option.optionKey || option.bookingCode,
        bookingCode: option.bookingCode,
        searchReference: option.searchReference,
        amountAfterTax: Number(amount.toFixed(2)),
        baseAmount: Number((option.baseAmount ?? option.pricePerNight ?? amount).toFixed(2)),
      });
    }
    return this.buildValidationResult(candidate, conflicts, nightlyRates);
  }

  private async tryBuildStaahMixedStay(
    candidate: StayBlockCandidate,
  ): Promise<StayBlockValidationResult | null> {
    const hotelMaster = await this.resolveHotel(candidate.provider, candidate.hotelCode);
    const propertyId = String(hotelMaster?.staah_property_id || '').trim();
    if (!propertyId) return null;
    const plan = await this.getPlan(candidate.planId);
    const roomId = await this.resolveStaahRoomId(
      hotelMaster?.hotel_id,
      propertyId,
      candidate.roomId,
      candidate.roomType,
    );
    const ratePlans = await this.prisma.staah_rateplan.findMany({
      where: { staah_property_id: propertyId, room_id: roomId },
      select: { room_id: true, rateplan_id: true, rateplan_name: true },
    });
    if (!ratePlans.length) return null;

    const requestedRate = this.normalizeText(candidate.rateId || candidate.mealPlan || '');
    const requestedMeal = this.normalizeText(candidate.mealPlan || '');
    const orderedRatePlans = [...ratePlans].sort((left: any, right: any) => {
      const score = (row: any) => {
        const id = this.normalizeText(row.rateplan_id);
        const name = this.normalizeText(row.rateplan_name);
        return (id === requestedRate ? 4 : 0)
          + (name === requestedMeal ? 2 : 0)
          + (id.includes(requestedRate) && requestedRate ? 1 : 0);
      };
      return score(right) - score(left);
    });
    const paxProfile = this.buildPaxProfile(plan);
    const nightlyRates: NightlyRate[] = [];
    const conflicts: RestrictionConflict[] = [];

    for (const date of candidate.stayDates) {
      const inventory = await this.findStaahInventoryRow(propertyId, roomId, date);
      if (!inventory || Number(inventory.free || 0) <= 0) return null;
      let selected: { plan: any; rate: any; amount: ReturnType<typeof calculateStaahOccupancyAmount> } | null = null;
      for (const ratePlan of orderedRatePlans) {
        const rate = await this.findStaahRateRow(
          propertyId,
          roomId,
          String(ratePlan.rateplan_id || ''),
          date,
        );
        if (!rate) continue;
        const restrictions = await this.findStaahRestrictionRows(
          propertyId,
          roomId,
          String(ratePlan.rateplan_id || ''),
          date,
          this.addDays(date, 1),
        );
        const oneNightCandidate = {
          ...candidate,
          checkInDate: date,
          checkOutDate: this.addDays(date, 1),
          nights: 1,
          stayDates: [date],
          routeIds: [candidate.routeIds[candidate.stayDates.indexOf(date)]],
        };
        const rateConflicts = this.collectRestrictionConflicts(
          restrictions,
          oneNightCandidate,
          (row: any) => String(row.type || ''),
          (row: any) => String(row.value || ''),
        );
        if (rateConflicts.length > 0) continue;
        selected = {
          plan: ratePlan,
          rate,
          amount: calculateStaahOccupancyAmount(rate.occupancy_rates, paxProfile),
        };
        break;
      }
      if (!selected) return null;
      nightlyRates.push(this.buildNightlyRate(
        date,
        selected.amount,
        Number(candidate.routeIds[candidate.stayDates.indexOf(date)] || 0),
        roomId,
        String(selected.plan.rateplan_id || ''),
        candidate.roomType,
        String(selected.plan.rateplan_name || candidate.mealPlan || ''),
        this.buildStaahRateOptionId(
          candidate.hotelName,
          roomId,
          String(selected.plan.rateplan_id || ''),
          date,
        ),
      ));
    }

    const result = this.buildValidationResult(candidate, conflicts, nightlyRates);
    result.continuityStatus = 'MIXED_ROOM_MEAL';
    result.warnings = [{
      type: 'ROOM_MEAL_MISMATCH',
      message: 'The selected room/meal rate is not available for every night. Available complete supplier rates were selected per night; confirm to continue.',
    }];
    return result;
  }

  private toSingleNightCandidate(candidate: StayBlockCandidate): StayBlockCandidate {
    const firstRouteId = Number(candidate.anchorRouteId || candidate.routeIds[0] || 0);
    const anchorIndex = candidate.routeIds.findIndex((routeId) => Number(routeId) === firstRouteId);
    const anchorDate = candidate.stayDates[anchorIndex >= 0 ? anchorIndex : 0] || candidate.checkInDate;
    const singleNightCheckOutDate = this.addDays(anchorDate, 1);
    return {
      ...candidate,
      checkInDate: anchorDate,
      checkOutDate: singleNightCheckOutDate,
      nights: 1,
      routeIds: firstRouteId > 0 ? [firstRouteId] : [],
      stayDates: [anchorDate],
      stayKey: [
        candidate.provider,
        candidate.hotelCode,
        String(candidate.roomId || ''),
        String(candidate.rateId || candidate.mealPlan || ''),
        `${anchorDate}_to_${singleNightCheckOutDate}`,
      ].join(':'),
      anchorRouteId: firstRouteId,
    };
  }

  private async getPlan(planId: number) {
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: planId },
    });
    if (!plan) {
      throw new BadRequestException(`Plan ${planId} not found`);
    }
    return plan;
  }

  private buildPaxProfile(plan: any): StaahPricingPaxInput {
    return {
      roomCount: Math.max(Number(plan?.preferred_room_count || 0), 1),
      adults: Math.max(Number(plan?.total_adult || 0), 1),
      children: Math.max(Number(plan?.total_children || 0), 0),
      extraBedCount: Math.max(Number(plan?.total_extra_bed || 0), 0),
      childWithBedCount: Math.max(Number(plan?.total_child_with_bed || 0), 0),
      childWithoutBedCount: Math.max(Number(plan?.total_child_without_bed || 0), 0),
    };
  }

  private async resolveHotel(provider: ProviderCode, hotelCode: string) {
    const raw = String(hotelCode || '').trim();
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
      const byId = await this.prisma.dvi_hotel.findFirst({ where: { hotel_id: numeric } });
      if (byId) return byId;
    }

    return this.prisma.dvi_hotel.findFirst({
      where:
        provider === 'staah'
          ? {
              OR: [{ hotel_code: raw }, { staah_property_id: raw }],
              deleted: { not: true },
            }
          : {
              OR: [{ hotel_code: raw }, { axisrooms_property_id: raw }],
              deleted: { not: true },
            },
    });
  }

  private async resolveStaahRoomId(
    hotelId: number | undefined,
    propertyId: string,
    directRoomId?: string,
    roomType?: string,
  ): Promise<string> {
    const direct = String(directRoomId || '').trim();
    const rows = await this.prisma.staah_rateplan.findMany({
      where: { staah_property_id: propertyId },
      select: { room_id: true },
    });
    const propertyRoomIds = Array.from(
      new Set(rows.map((row) => String(row.room_id || '').trim()).filter(Boolean)),
    );

    const directMatch = propertyRoomIds.find(
      (roomId) => this.sameStaahId(roomId, direct) || this.normalizeText(roomId) === this.normalizeText(direct),
    );
    if (directMatch) {
      return directMatch;
    }
    if (direct) {
      return this.toStaahOutboundId(direct);
    }
    if (!hotelId) {
      throw new BadRequestException('STAAH room mapping not found');
    }

    const rooms = await this.prisma.dvi_hotel_rooms.findMany({
      where: { hotel_id: Number(hotelId), deleted: 0 } as any,
      select: { room_ref_code: true, room_title: true },
    });
    const target = this.normalizeText(roomType || '');
    const matched = rooms.find((row: any) => {
      const ref = this.normalizeText(row.room_ref_code || '');
      const title = this.normalizeText(row.room_title || '');
      return !!target && (target === ref || target === title || target.includes(title) || title.includes(target));
    });

    const mappedRoomId = String(matched?.room_ref_code || '').trim();
    const propertyMatch = propertyRoomIds.find(
      (roomId) => this.sameStaahId(roomId, mappedRoomId) || this.normalizeText(roomId) === this.normalizeText(mappedRoomId),
    );
    const roomId = propertyMatch || mappedRoomId;
    if (!roomId) {
      console.error('[STAAH_ROOM_MAPPING_FAILED]', {
        hotelId,
        propertyId,
        directRoomId: direct,
        roomType,
        propertyRoomIds,
        masterRoomRefs: rooms.map((room: any) => ({ ref: room.room_ref_code, title: room.room_title })),
      });
      throw new BadRequestException('STAAH room mapping not found');
    }
    return roomId;
  }

  private async resolveStaahRatePlan(propertyId: string, roomId: string, directRateId?: string, mealPlan?: string) {
    const rows = await this.prisma.staah_rateplan.findMany({
      where: {
        staah_property_id: propertyId,
      },
      select: {
        room_id: true,
        rateplan_id: true,
        rateplan_name: true,
      },
    });

    const roomScopedRows = rows.filter(
      (row) => this.sameStaahId(row.room_id, roomId) || this.normalizeText(row.room_id) === this.normalizeText(roomId),
    );
    const candidateRows = roomScopedRows.length ? roomScopedRows : rows;
    const direct = this.normalizeText(directRateId || '');
    const meal = this.normalizeText(mealPlan || '');
    const matched = candidateRows.find(
      (row) => this.sameStaahId(row.rateplan_id, directRateId) || this.normalizeText(row.rateplan_id) === direct,
    )
      || candidateRows.find(
        (row) => this.normalizeText(row.rateplan_name) === meal || this.normalizeText(row.rateplan_id) === meal,
      )
      || candidateRows[0];

    if (!matched) {
      throw new BadRequestException('STAAH rate plan mapping not found');
    }

    return {
      rateId: String(matched.rateplan_id || '').trim(),
      rateName: String(matched.rateplan_name || mealPlan || '').trim(),
    };
  }

  private async findStaahRestrictionRows(
    propertyId: string,
    roomId: string,
    ratePlanId: string,
    checkInDate: string,
    checkOutDate: string,
  ) {
    const whereBase = {
      staah_property_id: propertyId,
      start_date: { lte: new Date(checkOutDate) } as any,
      end_date: { gte: new Date(checkInDate) } as any,
    };

    const exactRows = await this.prisma.staah_restriction.findMany({
      where: {
        ...whereBase,
        room_id: roomId,
        rateplan_id: ratePlanId,
      },
      orderBy: [
        { received_at: 'desc' },
        { start_date: 'asc' },
        { id: 'desc' },
      ] as any,
    });
    if (exactRows.length) {
      return exactRows;
    }

    const rows = await this.prisma.staah_restriction.findMany({
      where: whereBase,
      orderBy: [
        { received_at: 'desc' },
        { start_date: 'asc' },
        { id: 'desc' },
      ] as any,
    });
    return rows.filter((row: any) => {
      const sameRoom =
        this.sameStaahId(row.room_id, roomId)
        || this.normalizeText(row.room_id) === this.normalizeText(roomId);

      const sameRate =
        this.sameStaahId(row.rateplan_id, ratePlanId)
        || this.normalizeText(row.rateplan_id) === this.normalizeText(ratePlanId);

      return sameRoom && sameRate;
    });
  }

  private async findStaahInventoryRow(propertyId: string, roomId: string, date: string) {
    const exact = await this.prisma.staah_inventory.findFirst({
      where: {
        staah_property_id: propertyId,
        room_id: roomId,
        start_date: { lte: new Date(date) } as any,
        end_date: { gte: new Date(date) } as any,
      },
      orderBy: { received_at: 'desc' },
    });
    if (exact) {
      return exact;
    }

    const rows = await this.prisma.staah_inventory.findMany({
      where: {
        staah_property_id: propertyId,
        start_date: { lte: new Date(date) } as any,
        end_date: { gte: new Date(date) } as any,
      },
      orderBy: { received_at: 'desc' },
    });
    return rows.find(
      (row) => this.sameStaahId((row as any).room_id, roomId) || this.normalizeText((row as any).room_id) === this.normalizeText(roomId),
    ) || null;
  }

  private async findStaahRateRow(propertyId: string, roomId: string, rateId: string, date: string) {
    const exact = await this.prisma.staah_rate.findFirst({
      where: {
        staah_property_id: propertyId,
        room_id: roomId,
        rateplan_id: rateId,
        start_date: { lte: new Date(date) } as any,
        end_date: { gte: new Date(date) } as any,
      },
      orderBy: { received_at: 'desc' },
    });
    if (exact) {
      return exact;
    }

    const rows = await this.prisma.staah_rate.findMany({
      where: {
        staah_property_id: propertyId,
        start_date: { lte: new Date(date) } as any,
        end_date: { gte: new Date(date) } as any,
      },
      orderBy: { received_at: 'desc' },
    });
    return rows.find(
      (row) =>
        (this.sameStaahId((row as any).room_id, roomId) || this.normalizeText((row as any).room_id) === this.normalizeText(roomId))
        && (this.sameStaahId((row as any).rateplan_id, rateId)
          || this.normalizeText((row as any).rateplan_id) === this.normalizeText(rateId)),
    ) || null;
  }

  private async resolveAxisRoom(hotelId: number, directRoomId?: string, roomType?: string) {
    const direct = String(directRoomId || '').trim();
    const rooms = await this.prisma.dvi_hotel_rooms.findMany({
      where: { hotel_id: hotelId, deleted: 0 } as any,
      select: { room_ID: true, room_ref_code: true, room_title: true },
    });

    const directMatch = rooms.find((row: any) => String(row.room_ref_code || '').trim() === direct);
    if (directMatch) {
      return directMatch;
    }

    const target = this.normalizeText(roomType || '');
    const matched = rooms.find((row: any) => {
      const ref = this.normalizeText(row.room_ref_code || '');
      const title = this.normalizeText(row.room_title || '');
      return !!target && (target === ref || target === title || target.includes(title) || title.includes(target));
    }) || rooms[0];

    if (!matched) {
      throw new BadRequestException('AxisRooms room mapping not found');
    }
    return matched;
  }

  private async resolveAxisRatePlan(hotelId: number, roomId: number, directRateId?: string, mealPlan?: string) {
    const rows = await this.prisma.dvi_hotel_room_rate_plan.findMany({
      where: {
        hotel_id: hotelId,
        room_id: roomId,
        deleted: 0,
        status: 1,
      } as any,
      select: {
        rateplan_id: true,
        rateplan_name: true,
        rate_plan_code: true,
      },
    });

    const direct = this.normalizeText(directRateId || '');
    const meal = this.normalizeText(mealPlan || '');
    const matched = rows.find((row: any) => this.normalizeText(row.rateplan_id) === direct)
      || rows.find((row: any) => this.normalizeText(row.rate_plan_code) === direct)
      || rows.find((row: any) => this.normalizeText(row.rateplan_name) === meal || this.normalizeText(row.rate_plan_code) === meal)
      || rows[0];

    if (!matched) {
      throw new BadRequestException('AxisRooms rate plan mapping not found');
    }

    return {
      ratePlanId: String(matched.rateplan_id || '').trim(),
    };
  }

  private buildNightlyRate(
    date: string,
    breakdown: ReturnType<typeof calculateStaahOccupancyAmount>,
    routeId?: number,
    roomId?: string,
    rateId?: string,
    roomType?: string,
    mealPlan?: string,
    rateOptionId?: string,
  ): NightlyRate {
    const extraAdultAmount = Number(
      (
        breakdown.finalCalculatedAmount
        - breakdown.baseOccupancyAmount
        - breakdown.extraBedAmount
        - breakdown.childWithBedAmount
        - breakdown.childWithoutBedAmount
        - breakdown.extraChildAmount
      ).toFixed(2),
    );
    const extraAdultCount = breakdown.baseOccupancyKey.includes('EXTRAADULT') ? 1 : 0;
    const extraAdultRate = extraAdultCount > 0 ? extraAdultAmount : 0;
    const authoritativeRateOptionId = rateOptionId || [roomId, rateId, date].filter(Boolean).join(':');

    return {
      date,
      routeId,
      roomId,
      rateId,
      roomType,
      mealPlan,
      rateOptionId: authoritativeRateOptionId,
      bookingCode: authoritativeRateOptionId,
      searchReference: authoritativeRateOptionId,
      amountAfterTax: Number(breakdown.finalCalculatedAmount.toFixed(2)),
      baseAmount: Number(breakdown.baseOccupancyAmount.toFixed(2)),
      extraAdultCount,
      extraChildCount: breakdown.extraChildCount,
      extraAdultRate,
      extraChildRate: Number(
        (breakdown.extraChildCount > 0
          ? breakdown.extraChildAmount / breakdown.extraChildCount
          : breakdown.extraChildRate || 0).toFixed(2),
      ),
    };
  }

  /**
   * STAAH snapshot rows use this stable, date-scoped identity. Continuity
   * validation must return the same identity so /hotels/select can validate
   * the exact supplier option instead of treating a correct recalculation as
   * a stale selection.
   */
  private buildStaahRateOptionId(
    hotelName: string | undefined,
    roomId: string | undefined,
    rateId: string | undefined,
    date: string,
  ): string {
    const normalize = (value: unknown) => String(value || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '');
    const room = String(roomId || '').trim().toUpperCase();
    const rate = String(rateId || '').trim().toUpperCase();
    const day = String(date || '').replace(/-/g, '');
    const property = normalize(hotelName);
    return ['STAAH', property, room, rate, day].filter(Boolean).join('-');
  }

  private buildValidationResult(
    candidate: StayBlockCandidate,
    conflicts: RestrictionConflict[],
    nightlyRates: NightlyRate[],
  ): StayBlockValidationResult {
    const uniqueConflicts = this.dedupeConflicts(conflicts);
    const blocked = uniqueConflicts.length > 0;
    const totalAmountAfterTax = blocked
      ? 0
      : Number(nightlyRates.reduce((sum, night) => sum + Number(night.amountAfterTax || 0), 0).toFixed(2));

    return {
      continuityStatus: blocked ? 'BLOCKED' : (candidate.nights > 1 ? 'EXACT' : 'EXACT'),
      canBookSingleNight: !blocked && candidate.nights === 1,
      canBookMultiNight: !blocked && candidate.nights > 1,
      blocked,
      provider: candidate.provider,
      hotelName: candidate.hotelName,
      roomType: candidate.roomType,
      mealPlan: candidate.mealPlan,
      checkInDate: candidate.checkInDate,
      checkOutDate: candidate.checkOutDate,
      nights: candidate.nights,
      routeIds: candidate.routeIds,
      stayKey: candidate.stayKey,
      restrictionConflicts: blocked ? uniqueConflicts : [],
      warnings: [],
      nightlyRates: blocked ? [] : nightlyRates,
      totalAmountAfterTax,
    };
  }

  private normalizeRestrictionType(value: unknown): string {
    return String(value || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  private isRestrictionActive(value: unknown): boolean {
    const normalized = String(value ?? '')
      .trim()
      .toUpperCase();

    return [
      '1',
      'Y',
      'YES',
      'TRUE',
      'ON',
      'CLOSE',
      'CLOSED',
      'STOP',
      'STOPSELL',
      'STOP SELL',
    ].includes(normalized);
  }

  private isStopSellType(type: string): boolean {
    return (
      type.includes('STOPSELL')
      || type.includes('STOPSOLD')
      || type.includes('STOPSALE')
      || type === 'STATUS'
    );
  }

  private isCtaType(type: string): boolean {
    return type.includes('CTA') || type.includes('COA') || type.includes('CLOSEONARRIVAL');
  }

  private isCtdType(type: string): boolean {
    return type.includes('CTD') || type.includes('COD') || type.includes('CLOSEONDEPARTURE');
  }

  private collectRestrictionConflicts(
    rows: any[],
    candidate: StayBlockCandidate,
    typeGetter: (row: any) => string,
    valueGetter: (row: any) => string,
  ): RestrictionConflict[] {
    const conflicts: RestrictionConflict[] = [];

    for (const row of rows || []) {
      const rawType = this.normalizeRestrictionType(typeGetter(row));
      const start = this.toDateOnly(row.start_date);
      const end = this.toDateOnly(row.end_date);

      if (!start || !end) {
        continue;
      }

      const active = this.isRestrictionActive(valueGetter(row));
      if (!active) {
        continue;
      }

      if (this.isStopSellType(rawType)) {
        for (const date of candidate.stayDates) {
          if (this.isDateBetween(date, start, end)) {
            conflicts.push({
              date,
              type: rawType === 'STATUS' ? 'STATUS_CLOSED' : 'STOPSELL',
              message: `${rawType === 'STATUS' ? 'Status closed' : 'StopSell'} active on ${date}`,
            });
          }
        }
      }

      if (this.isCtaType(rawType) && this.isDateBetween(candidate.checkInDate, start, end)) {
        conflicts.push({
          date: candidate.checkInDate,
          type: 'CTA',
          message: `CTA active on check-in date ${candidate.checkInDate}`,
        });
      }

      if (this.isCtdType(rawType) && this.isDateBetween(candidate.checkOutDate, start, end)) {
        conflicts.push({
          date: candidate.checkOutDate,
          type: 'CTD',
          message: `CTD active on checkout date ${candidate.checkOutDate}`,
        });
      }

      const numericValue = Number(valueGetter(row));
      if (
        (rawType.includes('MINSTAY') || rawType.includes('MINLOS'))
        && Number.isFinite(numericValue)
        && candidate.nights < numericValue
      ) {
        conflicts.push({
          type: 'MIN_STAY',
          message: `Minimum stay is ${numericValue} night(s)`,
        });
      }

      if (
        (rawType.includes('MAXSTAY') || rawType.includes('MAXLOS'))
        && Number.isFinite(numericValue)
        && candidate.nights > numericValue
      ) {
        conflicts.push({
          type: 'MAX_STAY',
          message: `Maximum stay is ${numericValue} night(s)`,
        });
      }
    }

    return conflicts;
  }

  private dedupeConflicts(conflicts: RestrictionConflict[]): RestrictionConflict[] {
    const seen = new Set<string>();
    const unique: RestrictionConflict[] = [];

    for (const conflict of conflicts) {
      const key = `${conflict.type}::${conflict.date || ''}::${conflict.message}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      unique.push(conflict);
    }

    return unique;
  }

  private normalizeLocation(value: unknown): string {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  private normalizeStaahExternalId(value: unknown): string {
    return String(value ?? '')
      .trim()
      .toUpperCase()
      .replace(/_/g, '');
  }

  private toStaahOutboundId(value: unknown): string {
    return String(value ?? '')
      .trim()
      .toUpperCase()
      .replace(/_/g, '');
  }

  private sameStaahId(left: unknown, right: unknown): boolean {
    const normalizedLeft = this.normalizeStaahExternalId(left);
    const normalizedRight = this.normalizeStaahExternalId(right);
    return !!normalizedLeft && !!normalizedRight && normalizedLeft === normalizedRight;
  }

  private normalizeText(value: unknown): string {
    return String(value || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  private toDateOnly(value: unknown): string | null {
    if (!value) {
      return null;
    }
    if (value instanceof Date) {
      return value.toISOString().slice(0, 10);
    }
    const raw = String(value).trim();
    if (!raw) {
      return null;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return raw;
    }
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }

  private addDays(date: string, days: number): string {
    const base = new Date(`${date}T00:00:00.000Z`);
    base.setUTCDate(base.getUTCDate() + days);
    return base.toISOString().slice(0, 10);
  }

  private isDateBetween(target: string, start: string, end: string): boolean {
    return target >= start && target <= end;
  }
}
