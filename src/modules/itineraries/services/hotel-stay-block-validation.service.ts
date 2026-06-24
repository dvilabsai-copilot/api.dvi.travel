import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import {
  calculateStaahOccupancyAmount,
  type StaahPricingPaxInput,
} from '../helpers/staah-occupancy-pricing';

export type ProviderCode = 'staah' | 'axisrooms';

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
  amountAfterTax: number;
  baseAmount?: number;
  extraAdultCount?: number;
  extraChildCount?: number;
  extraAdultRate?: number;
  extraChildRate?: number;
}

export interface StayBlockValidationResult {
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
  constructor(private readonly prisma: PrismaService) {}

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
  }): Promise<StayBlockValidationResult> {
    const candidate = await this.buildContinuousStayCandidate(params);
    const fullStayValidation = await this.validateCandidate(candidate);

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
    const checkInDate = this.toDateOnly(params.checkInDate) || this.toDateOnly(currentRoute.itinerary_route_date);
    if (!checkInDate) {
      throw new BadRequestException('checkInDate is required');
    }

    const stayCity = this.normalizeLocation(currentRoute.next_visiting_location || currentRoute.location_name || '');
    const routeIds = [Number(currentRoute.itinerary_route_ID)];
    const stayDates = [checkInDate];

    for (let nextIndex = index + 1; nextIndex < routes.length; nextIndex += 1) {
      const nextRoute: any = routes[nextIndex];
      const expectedDate = this.addDays(checkInDate, routeIds.length);
      const nextRouteDate = this.toDateOnly(nextRoute.itinerary_route_date);
      if (!nextRouteDate || nextRouteDate !== expectedDate) {
        break;
      }

      const nextLocation = this.normalizeLocation(nextRoute.location_name || '');
      const nextDestination = this.normalizeLocation(nextRoute.next_visiting_location || '');
      if (!stayCity || nextLocation !== stayCity || nextDestination !== stayCity) {
        break;
      }

      routeIds.push(Number(nextRoute.itinerary_route_ID));
      stayDates.push(nextRouteDate);
    }

    const checkOutDate = this.addDays(checkInDate, stayDates.length);
    const stayKey = [
      params.provider,
      params.hotelCode,
      String(params.roomId || ''),
      String(params.rateId || params.mealPlan || ''),
      `${checkInDate}_to_${checkOutDate}`,
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
      checkInDate,
      checkOutDate,
      nights: stayDates.length,
      routeIds,
      stayDates,
      stayKey,
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

      nightlyRates.push(this.buildNightlyRate(date, calculateStaahOccupancyAmount(rateRow.occupancy_rates, paxProfile)));
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

      nightlyRates.push(this.buildNightlyRate(date, calculateStaahOccupancyAmount(rateRow.occupancy_rates, paxProfile)));
    }

    return this.buildValidationResult(candidate, conflicts, nightlyRates);
  }

  private async validateCandidate(candidate: StayBlockCandidate): Promise<StayBlockValidationResult> {
    if (candidate.provider === 'staah') {
      return this.validateStaahStayBlock(candidate);
    }
    return this.validateAxisRoomsStayBlock(candidate);
  }

  private toSingleNightCandidate(candidate: StayBlockCandidate): StayBlockCandidate {
    const singleNightCheckOutDate = this.addDays(candidate.checkInDate, 1);
    const firstRouteId = Number(candidate.routeIds[0] || 0);
    return {
      ...candidate,
      checkOutDate: singleNightCheckOutDate,
      nights: 1,
      routeIds: firstRouteId > 0 ? [firstRouteId] : [],
      stayDates: [candidate.checkInDate],
      stayKey: [
        candidate.provider,
        candidate.hotelCode,
        String(candidate.roomId || ''),
        String(candidate.rateId || candidate.mealPlan || ''),
        `${candidate.checkInDate}_to_${singleNightCheckOutDate}`,
      ].join(':'),
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

  private buildNightlyRate(date: string, breakdown: ReturnType<typeof calculateStaahOccupancyAmount>): NightlyRate {
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

    return {
      date,
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
