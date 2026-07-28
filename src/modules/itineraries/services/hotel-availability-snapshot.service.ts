import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { createConnection } from 'mysql2/promise';
import { PrismaService } from '../../../prisma.service';
import {
  ItineraryHotelDetailsResponseDto,
  ItineraryHotelRowDto,
} from '../itinerary-hotel-details.service';
import { ItineraryHotelDetailsTboService } from '../itinerary-hotel-details-tbo.service';
import {
  hotelDisplaySnapshot,
  hotelOptionKey,
  hotelSelectionKeyFromRow,
  isProtectedHotelSelection,
  isSpecialHotelPlanRow,
  optionMatchesSelection,
  parseHotelSelectionSnapshot,
  selectionOriginFromRow,
  selectedOptionKeyFromRow,
} from '../utils/hotel-selection-identity.util';

type PersistedReadFallback = () => Promise<ItineraryHotelDetailsResponseDto>;

type SnapshotReadOptions = {
  page?: number;
  pageSize?: number;
  groupType?: number;
  itineraryRouteId?: number;
};

export type HotelAvailabilityChangeType =
  | 'AUTO_SELECTION_CHANGED'
  | 'PRICE_CHANGED'
  | 'ROOM_TYPE_CHANGED'
  | 'MEAL_PLAN_CHANGED'
  | 'RATE_CHANGED'
  | 'SELECTION_UNAVAILABLE'
  | 'BECAME_AVAILABLE'
  | 'OFFLINE_APPROVAL_CHANGED'
  | 'SELECTION_DEDUPED';

export type HotelAvailabilityChange = {
  changeType: HotelAvailabilityChangeType;
  routeId: number;
  day?: number | string | null;
  date?: string | null;
  destination?: string | null;
  groupType: number;
  previous?: Record<string, unknown> | null;
  current?: Record<string, unknown> | null;
  previousPrice?: number | null;
  currentPrice?: number | null;
  priceDelta?: number | null;
  selectionOrigin?: string;
};

export type HotelAvailabilityChangeSummary = {
  hasChanges: boolean;
  totalChanges: number;
  changes: HotelAvailabilityChange[];
};

/**
 * Owns the durable boundary between live supplier searches and hotel reads.
 * The existing search-cache table is intentionally used as-is: one row stores
 * the complete normalized option in full_payload, so room/rate fields survive
 * without changing the legacy uniqueness key.
 */
@Injectable()
export class HotelAvailabilitySnapshotService {
  private readonly logger = new Logger(HotelAvailabilitySnapshotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tboHotelDetails: ItineraryHotelDetailsTboService,
  ) {}

  optionKey(row: any): string {
    return hotelOptionKey(row);
  }

  async readPersisted(
    quoteId: string,
    options: SnapshotReadOptions = {},
    fallback?: PersistedReadFallback,
  ): Promise<ItineraryHotelDetailsResponseDto> {
    const plan = await this.findPlan(quoteId);
    const cache = (this.prisma as any).dvi_itinerary_hotel_search_cache;
    const latest = await cache.findFirst({
      where: { quote_id: quoteId, plan_id: plan.itinerary_plan_ID, deleted: 0, status: 1 },
      orderBy: [{ synced_at: 'desc' }, { id: 'desc' }],
      select: { synced_at: true, full_payload: true },
    });

    if (!latest?.synced_at) {
      if (fallback) return fallback();
      throw new BadRequestException('Hotel availability has not been checked yet');
    }

    const rows = await cache.findMany({
      where: {
        quote_id: quoteId,
        plan_id: plan.itinerary_plan_ID,
        deleted: 0,
        status: 1,
        synced_at: latest.synced_at,
      },
      orderBy: [{ group_type: 'asc' }, { sort_rank: 'asc' }, { id: 'asc' }],
    });
    const planRows = await (this.prisma as any).dvi_itinerary_plan_hotel_details.findMany({
      where: { itinerary_plan_id: plan.itinerary_plan_ID, deleted: 0, status: 1 },
      orderBy: { itinerary_plan_hotel_details_ID: 'desc' },
    });

    const selectedByRouteGroup = new Map<string, any>();
    for (const row of planRows) {
      const key = hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row);
      if (!selectedByRouteGroup.has(key) && !isSpecialHotelPlanRow(row)) {
        selectedByRouteGroup.set(key, row);
      }
    }

    let normalizedRows = rows
      .map((row: any) => this.parsePayload(row.full_payload))
      .filter(Boolean)
      .map((row: any) => this.decorateSelection(row, selectedByRouteGroup, plan.itinerary_plan_ID)) as any[];

    // A missing selected option is selection metadata on the existing
    // route/day/group row, never a synthetic option row. This keeps row/day
    // cardinality equal to the availability snapshot and prevents fabricated
    // names such as "Previously selected hotel".
    const markedUnavailable = new Set<string>();
    normalizedRows = normalizedRows.map((row: any) => {
      const selection = selectedByRouteGroup.get(hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row));
      if (!selection || optionMatchesSelection(selection, row)) return row;
      const key = hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row);
      if (markedUnavailable.has(key)) return row;
      markedUnavailable.add(key);
      return this.decorateUnavailableSelection(row, selection);
    });

    if (options.groupType && options.groupType > 0) {
      normalizedRows = normalizedRows.filter((row) => Number(row.groupType || 0) === Number(options.groupType));
    }
    if (options.itineraryRouteId && options.itineraryRouteId > 0) {
      normalizedRows = normalizedRows.filter((row) => Number(row.itineraryRouteId || 0) === Number(options.itineraryRouteId));
    }

    const tabs = this.buildTabs(normalizedRows);
    const page = Math.max(1, Number(options.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(options.pageSize || 20)));
    const total = normalizedRows.length;
    const start = (page - 1) * pageSize;
    const paged = normalizedRows.slice(start, start + pageSize);
    const checkedAt = new Date(latest.synced_at);
    const latestPayload = this.parsePayload(latest.full_payload);
    const searchRunId = String(latestPayload?.searchRunId || `legacy-hotel-${plan.itinerary_plan_ID}-${checkedAt.toISOString()}`);
    const hasUnavailableSelection = normalizedRows.some((row: any) => row.selectionStatus === 'UNAVAILABLE');
    const placeholderRows = normalizedRows.filter((row: any) => (
      row.isPlaceholder === true
      || row.synthetic === true
      || !Number(row.itineraryRouteId || 0)
      || !String(row.day || '').trim()
      || !String(row.date || row.checkInDate || '').trim()
    ));
    const availabilityState = this.getAvailabilityState(checkedAt, hasUnavailableSelection);
    const routePagination = options.itineraryRouteId && options.itineraryRouteId > 0
      ? {
          [`${Number(options.groupType || 0)}-${Number(options.itineraryRouteId)}`]: {
            page,
            pageSize,
            total,
            hasMore: start + pageSize < total,
            groupType: Number(options.groupType || 0),
          },
        }
      : undefined;

    return {
      quoteId,
      planId: plan.itinerary_plan_ID,
      hotelRatesVisible: Boolean((plan as any).hotel_rates_visibility),
      showHotelMargins: String(process.env.SHOW_HOTEL_MARGINS || '').toLowerCase() === 'true',
      hotelTabs: tabs,
      hotels: paged,
      totalRoomCount: normalizedRows.length,
      pagination: {
        [Number(options.groupType || 0) || 0]: {
          page,
          pageSize,
          total,
          hasMore: start + pageSize < total,
        },
      },
      routePagination,
      hotelAvailability: {
        hasSupplierHotels: normalizedRows.some((row: any) => row.isBookable !== false && row.provider !== 'offline'),
        supplierHotelCount: normalizedRows.filter((row: any) => row.isBookable !== false && row.provider !== 'offline').length,
        placeholderRowCount: placeholderRows.length,
        totalSearchRoutes: new Set(normalizedRows.map((row: any) => Number(row.itineraryRouteId || 0)).filter(Boolean)).size,
        emptySearchRoutes: 0,
        isPlaceholderOnly: normalizedRows.length > 0 && placeholderRows.length === normalizedRows.length,
        message: hasUnavailableSelection
          ? 'A previously selected hotel is unavailable in the current snapshot. Review the selection or check availability again.'
          : 'Showing persisted hotel availability. Live suppliers are called only by Check Availability.',
        availabilityState,
        searchRunId,
        checkedAt: checkedAt.toISOString(),
        providerErrors: [],
        unavailableSelectionCount: planRows.filter((row: any) => !isSpecialHotelPlanRow(row))
          .filter((row: any) => !normalizedRows.some((hotel: any) =>
            hotel.isSelected && Number(hotel.selectionId || 0) === Number(row.itinerary_plan_hotel_details_ID),
          )).length,
      } as any,
    };
  }

  async searchAndPersist(
    quoteId: string,
    requestType: 'CREATE' | 'CHECK_AVAILABILITY',
    createdBy = 0,
  ): Promise<{
    searchRunId: string;
    response: ItineraryHotelDetailsResponseDto;
    changeSummary: HotelAvailabilityChangeSummary;
  }> {
    const plan = await this.findPlan(quoteId);
    const lockName = `itinerary_hotel_availability:${plan.itinerary_plan_ID}`;
    const databaseUrl = String(process.env.DATABASE_URL || '').trim();
    if (!databaseUrl) throw new Error('DATABASE_URL is required for hotel availability coordination');

    const connection = await createConnection(databaseUrl);
    let acquired = false;
    const startedAt = Date.now();
    const checkedAt = new Date();
    const searchRunId = `hotel-${plan.itinerary_plan_ID}-${randomUUID()}`;

    try {
      const [lockRows] = await connection.query<any[]>('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
      acquired = Number(lockRows?.[0]?.acquired || 0) === 1;
      if (!acquired) {
        throw new ConflictException({
          message: 'Hotel availability is already running for this itinerary.',
          code: 'HOTEL_AVAILABILITY_IN_PROGRESS',
          planId: plan.itinerary_plan_ID,
          searchRunId,
        });
      }

      this.logger.log('[HOTEL_AVAILABILITY_START]', {
        quoteId,
        planId: plan.itinerary_plan_ID,
        searchRunId,
        requestType,
      });
      const liveResponse = await this.tboHotelDetails.getHotelDetailsByQuoteIdFromTbo(quoteId);
      const sourceRows = Array.isArray(liveResponse.hotels) ? liveResponse.hotels : [];
      if (sourceRows.length === 0) {
        throw new ServiceUnavailableException({
          message: 'Hotel availability returned no options; the previous snapshot was retained.',
          code: 'HOTEL_AVAILABILITY_EMPTY',
          planId: plan.itinerary_plan_ID,
          quoteId,
          searchRunId,
          previousSnapshotRetained: true,
        });
      }

      const rows = this.dedupeRows(sourceRows);
      const changeSummary = await this.prisma.$transaction(async (tx) => {
        const txCache = (tx as any).dvi_itinerary_hotel_search_cache;
        await txCache.deleteMany({
          where: { quote_id: quoteId, plan_id: plan.itinerary_plan_ID },
        });
        await txCache.createMany({
          data: rows.map((row: any, index: number) => ({
            quote_id: quoteId,
            plan_id: plan.itinerary_plan_ID,
            route_id: Number(row.itineraryRouteId || 0),
            group_type: Number(row.groupType || 0),
            hotel_code: String(row.hotelCode || row.hotelId || '0'),
            provider: String(row.provider || 'external').toLowerCase(),
            hotel_name: String(row.hotelName || 'Hotel'),
            rating: Number(row.category || 0),
            price: Number(row.totalHotelCost || row.pricePerNight || 0),
            room_type: String(row.roomType || '').slice(0, 255) || null,
            meal_plan: String(row.mealPlan || '').slice(0, 100) || null,
            search_reference: row.searchReference ? String(row.searchReference) : null,
            full_payload: JSON.stringify({ ...row, optionKey: this.optionKey(row), searchRunId }),
            check_in_date: this.toDate(row.date || row.checkInDate),
            check_out_date: row.checkOutDate
              ? this.toDate(row.checkOutDate)
              : this.addDays(this.toDate(row.date || row.checkInDate), Number(row.numberOfNights || 1)),
            sort_rank: index,
            synced_at: checkedAt,
            status: 1,
            deleted: 0,
          })),
        });

        return this.reconcileSelections(tx, plan.itinerary_plan_ID, rows, searchRunId, createdBy);
      });

      const response = await this.readPersisted(quoteId, { page: 1, pageSize: 100 });
      (response as any).hotelAvailability = {
        ...(response as any).hotelAvailability,
        availabilityState: liveResponse.hotelAvailability?.isPlaceholderOnly ? 'PARTIAL' : 'FRESH',
        searchRunId,
        checkedAt: checkedAt.toISOString(),
        providerErrors: [],
      };
      this.logger.log('[HOTEL_AVAILABILITY_COMPLETE]', {
        quoteId,
        planId: plan.itinerary_plan_ID,
        searchRunId,
        optionCount: rows.length,
        durationMs: Date.now() - startedAt,
      });
      return { searchRunId, response, changeSummary };
    } catch (error) {
      this.logger.warn('[HOTEL_AVAILABILITY_FAILED]', {
        quoteId,
        planId: plan.itinerary_plan_ID,
        searchRunId,
        durationMs: Date.now() - startedAt,
        message: String((error as any)?.message || error || 'Hotel availability failed'),
      });
      throw error;
    } finally {
      if (acquired) {
        try { await connection.query('SELECT RELEASE_LOCK(?) AS released', [lockName]); } catch (error) {
          this.logger.error('[HOTEL_AVAILABILITY_LOCK_RELEASE_FAILED]', String((error as any)?.message || error));
        }
      }
      await connection.end();
    }
  }

  async getActiveRows(quoteId: string): Promise<any[] | null> {
    const plan = await this.findPlan(quoteId);
    const cache = (this.prisma as any).dvi_itinerary_hotel_search_cache;
    const latest = await cache.findFirst({
      where: { quote_id: quoteId, plan_id: plan.itinerary_plan_ID, deleted: 0, status: 1 },
      orderBy: [{ synced_at: 'desc' }, { id: 'desc' }],
      select: { synced_at: true },
    });
    if (!latest?.synced_at) return null;
    const rows = await cache.findMany({
      where: { quote_id: quoteId, plan_id: plan.itinerary_plan_ID, deleted: 0, status: 1, synced_at: latest.synced_at },
      orderBy: [{ sort_rank: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row: any) => this.parsePayload(row.full_payload)).filter(Boolean);
  }

  private async findPlan(quoteId: string): Promise<any> {
    const plan = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_quote_ID: String(quoteId).trim(), deleted: 0 },
    });
    if (!plan) throw new BadRequestException('Itinerary not found');
    return plan;
  }

  private parsePayload(payload: unknown): any | null {
    if (payload && typeof payload === 'object') return payload;
    try { return JSON.parse(String(payload || '')); } catch { return null; }
  }

  private dedupeRows(rows: any[]): any[] {
    const seen = new Set<string>();
    return rows.filter((row) => {
      const key = this.optionKey(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private decorateSelection(row: any, selectedByRouteGroup: Map<string, any>, planId: number): any {
    const selection = selectedByRouteGroup.get(hotelSelectionKeyFromRow(planId, row));
    const normalized = { ...row, optionKey: row.optionKey || this.optionKey(row) };
    if (!selection) return normalized;
    const matched = optionMatchesSelection(selection, normalized);
    if (!matched) return normalized;
    const selectionOrigin = selectionOriginFromRow(selection);
    return {
      ...normalized,
      isSelected: true,
      selectionOrigin,
      selectionId: Number(selection.itinerary_plan_hotel_details_ID || 0),
      itineraryPlanHotelDetailsId: Number(selection.itinerary_plan_hotel_details_ID || 0),
      selectedRateOptionId: selection.selected_rate_option_id || row.rateOptionId || row.searchReference,
      selectedPricePerNight: selection.selected_price_per_night,
      selectedTotalPrice: selection.selected_total_price,
      selectedCurrency: selection.selected_currency,
      requiresPriceReacceptance: Boolean(selection.requires_price_reacceptance),
      selectedPriceSnapshot: selection.selected_price_snapshot || null,
      selectionStatus: 'AVAILABLE',
      selection: {
        ...hotelDisplaySnapshot({ ...selection, ...parseHotelSelectionSnapshot(selection) }),
        status: 'AVAILABLE',
        selectionOrigin,
        selectionId: Number(selection.itinerary_plan_hotel_details_ID || 0),
      },
    };
  }

  private decorateUnavailableSelection(row: any, selection: any): any {
    const snapshot = parseHotelSelectionSnapshot(selection);
    const selectionOrigin = selectionOriginFromRow(selection);
    return {
      ...row,
      selectionStatus: 'UNAVAILABLE',
      selectionOrigin,
      selectionId: Number(selection.itinerary_plan_hotel_details_ID || 0),
      selection: {
        ...hotelDisplaySnapshot({ ...selection, ...snapshot }),
        status: 'UNAVAILABLE',
        selectionOrigin,
        selectionId: Number(selection.itinerary_plan_hotel_details_ID || 0),
      },
      availabilityStatus: row.availabilityStatus || 'REVIEW_REQUIRED',
      availabilityMessage: 'The persisted selection is not present in the latest availability snapshot. Review the selection.',
    };
  }

  private getAvailabilityState(checkedAt: Date, hasUnavailableSelection: boolean): 'FRESH' | 'STALE' | 'PARTIAL' {
    const ttlMinutes = Math.max(Number(process.env.HOTEL_AVAILABILITY_TTL_MINUTES || 60), 1);
    const isFresh = Date.now() - checkedAt.getTime() < ttlMinutes * 60 * 1000;
    if (hasUnavailableSelection) return 'PARTIAL';
    return isFresh ? 'FRESH' : 'STALE';
  }

  private buildTabs(rows: any[]): Array<{ groupType: number; label: string; totalAmount: number }> {
    const totals = new Map<number, number>();
    for (const row of rows) {
      const groupType = Number(row.groupType || 0);
      totals.set(groupType, (totals.get(groupType) || 0) + Number(row.totalHotelCost || 0) + Number(row.totalHotelTaxAmount || 0));
    }
    return Array.from(totals.entries()).sort(([a], [b]) => a - b).map(([groupType, totalAmount]) => ({
      groupType,
      label: `Recommended #${groupType}`,
      totalAmount,
    }));
  }

  private async reconcileSelections(
    tx: any,
    planId: number,
    rows: any[],
    searchRunId: string,
    createdBy: number,
  ): Promise<HotelAvailabilityChangeSummary> {
    const changes: HotelAvailabilityChange[] = [];
    const selections = await tx.dvi_itinerary_plan_hotel_details.findMany({
      where: { itinerary_plan_id: planId, deleted: 0, status: 1, hotel_required: 1 },
      orderBy: [{ itinerary_plan_hotel_details_ID: 'desc' }],
    });
    const grouped = new Map<string, any[]>();
    for (const row of selections) {
      const key = hotelSelectionKeyFromRow(planId, row);
      const bucket = grouped.get(key) || [];
      bucket.push(row);
      grouped.set(key, bucket);
    }

    for (const [selectionKey, bucket] of grouped.entries()) {
      const selection = bucket[0];
      const duplicateRows = bucket.slice(1);
      for (const duplicate of duplicateRows) {
        await tx.dvi_itinerary_plan_hotel_details.update({
          where: { itinerary_plan_hotel_details_ID: duplicate.itinerary_plan_hotel_details_ID },
          data: { status: 0, deleted: 1, updatedon: new Date() },
        });
        await tx.dvi_itinerary_plan_hotel_room_details.updateMany({
          where: { itinerary_plan_hotel_details_id: duplicate.itinerary_plan_hotel_details_ID, deleted: 0 },
          data: { status: 0, deleted: 1, updatedon: new Date() },
        });
        changes.push(this.buildChange('SELECTION_DEDUPED', selection, null, {
          selectionOrigin: selectionOriginFromRow(selection),
        }));
      }

      if (isProtectedHotelSelection(selection)) continue;

      const options = rows.filter((row: any) => hotelSelectionKeyFromRow(planId, row) === selectionKey);
      const origin = selectionOriginFromRow(selection);
      const matched = options.find((row: any) => optionMatchesSelection(selection, row));
      const replacement = matched || (origin === 'AUTO_SELECTED'
        ? options.find((row: any) => row.isBookable !== false && row.isSelectable !== false && row.provider !== 'offline')
        : undefined);
      const previousSnapshot = { ...selection, ...parseHotelSelectionSnapshot(selection) };
      const previous = hotelDisplaySnapshot(previousSnapshot);

      if (!replacement) {
        if (origin === 'USER_SELECTED') {
          const snapshot = {
            ...parseHotelSelectionSnapshot(selection),
            selectionOrigin: origin,
            availabilityStatus: 'UNAVAILABLE',
            searchRunId,
          };
          await tx.dvi_itinerary_plan_hotel_details.update({
            where: { itinerary_plan_hotel_details_ID: selection.itinerary_plan_hotel_details_ID },
            data: { selected_price_snapshot: JSON.stringify(snapshot), updatedon: new Date() },
          });
          changes.push(this.buildChange('SELECTION_UNAVAILABLE', selection, null, {
            previous,
            selectionOrigin: origin,
          }));
        }
        continue;
      }

      const next = hotelDisplaySnapshot(replacement);
      const oldPrice = Number(selection.selected_total_price || selection.total_hotel_cost || 0);
      const newPrice = Number(replacement.totalStayPrice || replacement.totalHotelCost || replacement.totalPrice || 0);
      const oldRoom = String(previousSnapshot.roomType || selection.room_type || '').trim().toLowerCase();
      const newRoom = String(replacement.roomType || '').trim().toLowerCase();
      const oldMeal = String(previousSnapshot.mealPlan || selection.meal_plan || '').trim().toLowerCase();
      const newMeal = String(replacement.mealPlan || '').trim().toLowerCase();
      const oldOption = selectedOptionKeyFromRow(selection);
      const newOption = String(replacement.optionKey || hotelOptionKey(replacement)).trim().toLowerCase();

      await tx.dvi_itinerary_plan_hotel_details.update({
        where: { itinerary_plan_hotel_details_ID: selection.itinerary_plan_hotel_details_ID },
        data: this.buildSelectionUpdate(selection, replacement, origin, searchRunId),
      });
      await this.syncSelectedRoom(tx, selection, replacement, createdBy);

      if (origin === 'AUTO_SELECTED' && (!matched || oldOption !== newOption)) {
        changes.push(this.buildChange('AUTO_SELECTION_CHANGED', selection, replacement, {
          previous,
          current: next,
          priceDelta: newPrice - oldPrice,
          selectionOrigin: origin,
        }));
      } else if (!matched && origin === 'USER_SELECTED') {
        changes.push(this.buildChange('BECAME_AVAILABLE', selection, replacement, {
          previous,
          current: next,
          priceDelta: newPrice - oldPrice,
          selectionOrigin: origin,
        }));
      }
      if (oldPrice > 0 && newPrice > 0 && Math.abs(oldPrice - newPrice) > 0.009) {
        changes.push(this.buildChange('PRICE_CHANGED', selection, replacement, {
          previousPrice: oldPrice,
          currentPrice: newPrice,
          priceDelta: newPrice - oldPrice,
          previous,
          current: next,
          selectionOrigin: origin,
        }));
      }
      if (oldRoom && newRoom && oldRoom !== newRoom) {
        changes.push(this.buildChange('ROOM_TYPE_CHANGED', selection, replacement, {
          previous,
          current: next,
          selectionOrigin: origin,
        }));
      }
      if (oldMeal && newMeal && oldMeal !== newMeal) {
        changes.push(this.buildChange('MEAL_PLAN_CHANGED', selection, replacement, {
          previous,
          current: next,
          selectionOrigin: origin,
        }));
      }
      if (oldOption && newOption && oldOption !== newOption && !changes.some((change) =>
        change.changeType === 'AUTO_SELECTION_CHANGED' && change.routeId === Number(selection.itinerary_route_id),
      )) {
        changes.push(this.buildChange('RATE_CHANGED', selection, replacement, {
          previous,
          current: next,
          selectionOrigin: origin,
        }));
      }
    }

    return { hasChanges: changes.length > 0, totalChanges: changes.length, changes };
  }

  private buildSelectionUpdate(selection: any, option: any, origin: string, searchRunId: string): Record<string, unknown> {
    const priorSnapshot = parseHotelSelectionSnapshot(selection);
    const optionKey = String(option.optionKey || hotelOptionKey(option));
    const pricePerNight = Number(option.pricePerNight || option.totalHotelCost || option.totalStayPrice || 0);
    const totalPrice = Number(option.totalStayPrice || option.totalHotelCost || option.totalPrice || 0);
    return {
      hotel_id: Number(option.hotelId || option.hotelCode || selection.hotel_id || 0),
      hotel_code: String(option.hotelCode || option.hotelId || selection.hotel_code || selection.hotel_id || ''),
      hotel_category_id: Number(option.category || selection.hotel_category_id || 0),
      hotel_provider: option.provider || selection.hotel_provider || null,
      hotel_booking_mode: option.bookingMode || selection.hotel_booking_mode || 'LIVE_API',
      price_source: option.priceSource || selection.price_source || 'LIVE_API',
      is_live_rate: option.provider === 'offline' ? false : true,
      selected_rate_option_id: option.rateOptionId || option.optionKey || option.searchReference || option.bookingCode || null,
      selected_price_per_night: pricePerNight,
      selected_total_price: totalPrice,
      selected_currency: option.currency || selection.selected_currency || null,
      total_hotel_cost: totalPrice,
      total_hotel_tax_amount: Number(option.totalHotelTaxAmount || selection.total_hotel_tax_amount || 0),
      selected_price_snapshot: JSON.stringify({
        ...priorSnapshot,
        ...hotelDisplaySnapshot(option),
        optionKey,
        rateOptionId: option.rateOptionId || option.optionKey || option.searchReference || option.bookingCode || null,
        selectionOrigin: origin,
        availabilityStatus: 'AVAILABLE',
        searchRunId,
      }),
      requires_price_reacceptance: origin === 'USER_SELECTED' &&
        Number(selection.selected_total_price || selection.total_hotel_cost || 0) > 0 &&
        Math.abs(Number(selection.selected_total_price || selection.total_hotel_cost || 0) - totalPrice) > 0.009,
      updatedon: new Date(),
    };
  }

  private async syncSelectedRoom(tx: any, selection: any, option: any, createdBy: number): Promise<void> {
    const activeRooms = await tx.dvi_itinerary_plan_hotel_room_details.findMany({
      where: { itinerary_plan_hotel_details_id: selection.itinerary_plan_hotel_details_ID, deleted: 0, status: 1 },
      orderBy: { itinerary_plan_hotel_room_details_ID: 'desc' },
    });
    const room = activeRooms[0];
    for (const duplicate of activeRooms.slice(1)) {
      await tx.dvi_itinerary_plan_hotel_room_details.update({
        where: { itinerary_plan_hotel_room_details_ID: duplicate.itinerary_plan_hotel_room_details_ID },
        data: { status: 0, deleted: 1, updatedon: new Date() },
      });
    }
    const meal = String(option.mealPlan || '').toUpperCase();
    const roomData = {
      group_type: Number(selection.group_type || option.groupType || 0),
      itinerary_plan_id: Number(selection.itinerary_plan_id),
      itinerary_route_id: Number(selection.itinerary_route_id),
      itinerary_route_date: selection.itinerary_route_date || this.toDate(option.date || option.checkInDate),
      hotel_id: Number(option.hotelId || option.hotelCode || selection.hotel_id || 0),
      room_type_id: Number(option.roomTypeId || selection.room_type_id || 0),
      room_id: Number(option.roomId || selection.room_id || 0),
      room_qty: Math.max(Number(selection.total_no_of_rooms || 1), 1),
      room_rate: Number(option.pricePerNight || option.totalStayPrice || option.totalHotelCost || 0),
      total_room_cost: Number(option.totalStayPrice || option.totalHotelCost || option.totalPrice || 0),
      breakfast_required: /CP|MAP|AP|BREAKFAST|ALL/.test(meal) ? 1 : 0,
      lunch_required: /MAP|AP|LUNCH|ALL/.test(meal) ? 1 : 0,
      dinner_required: /MAP|AP|DINNER|ALL/.test(meal) ? 1 : 0,
      status: 1,
      deleted: 0,
      updatedon: new Date(),
    };
    if (room) {
      await tx.dvi_itinerary_plan_hotel_room_details.update({
        where: { itinerary_plan_hotel_room_details_ID: room.itinerary_plan_hotel_room_details_ID },
        data: roomData,
      });
    } else {
      await tx.dvi_itinerary_plan_hotel_room_details.create({
        data: {
          itinerary_plan_hotel_details_id: selection.itinerary_plan_hotel_details_ID,
          createdby: createdBy || selection.createdby || 0,
          createdon: new Date(),
          ...roomData,
        },
      });
    }
  }

  private buildChange(
    changeType: HotelAvailabilityChangeType,
    selection: any,
    option: any,
    extra: Partial<HotelAvailabilityChange> = {},
  ): HotelAvailabilityChange {
    const routeId = Number(selection?.itinerary_route_id || option?.itineraryRouteId || 0);
    const groupType = Number(selection?.group_type || option?.groupType || 0);
    const date = option?.date || option?.checkInDate || selection?.itinerary_route_date || null;
    return {
      changeType,
      routeId,
      day: option?.day ?? null,
      date: date ? new Date(String(date)).toISOString().slice(0, 10) : null,
      destination: option?.destination || selection?.itinerary_route_location || null,
      groupType,
      selectionOrigin: selection ? selectionOriginFromRow(selection) : undefined,
      ...extra,
    };
  }

  private toDate(value: unknown): Date {
    const parsed = value ? new Date(String(value)) : new Date();
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  private addDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setUTCDate(result.getUTCDate() + Math.max(1, days || 1));
    return result;
  }
}
