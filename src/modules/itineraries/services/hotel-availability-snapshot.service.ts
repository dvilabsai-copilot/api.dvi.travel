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
  ItineraryHotelTabDto,
} from '../itinerary-hotel-details.service';
import { ItineraryHotelDetailsTboService } from '../itinerary-hotel-details-tbo.service';
import { OfflineHotelCatalogService, selectOfflineRouteNightlyRate } from './offline-hotel-catalog.service';
import { HotelAvailabilityTimingLogger } from './hotel-availability-timing.logger';
import {
  hotelDisplaySnapshot,
  hotelOptionKey,
  hotelSelectionKey,
  hotelSelectionKeyFromRow,
  isProtectedHotelSelection,
  isSpecialHotelPlanRow,
  hotelPropertyMatchesSelection,
  hotelRateMatchesSelection,
  optionMatchesSelection,
  normalizeSupplierRateIdentity,
  parseHotelSelectionSnapshot,
  selectionOriginFromRow,
  selectedOptionKeyFromRow,
  strictAutoSelectionIdentityMatches,
} from '../utils/hotel-selection-identity.util';
import {
  buildHotelSelectionState,
  resolveHotelRequiredRoutes,
  synchronizeHotelTabTotals,
} from '../utils/hotel-selection-view-state.util';
import {
  mapHotelCategoryLabelToStar,
  resolveHotelRecommendationAlgorithm,
} from './hotel-recommendation-package.service';
import {
  inferCanonicalHotelRatePlanCode,
  inferCanonicalHotelRatePlanCodeFromMealFlags,
  inferCanonicalHotelRatePlanCodeFromMealText,
} from '../../hotels/hotel-rate-plans';
import { hotelStayTotal } from '../utils/hotel-stay-pricing.util';
import { HotelPricingService } from '../hotels/hotel-pricing.service';
import { projectHotelPayablePricing } from '../utils/hotel-payable-pricing.util';
import {
  decorateHotelCardPricing,
  hotelCardPayableAmount,
} from '../utils/hotel-card-pricing.util';

type PersistedReadFallback = () => Promise<ItineraryHotelDetailsResponseDto>;

type SnapshotReadOptions = {
  page?: number;
  pageSize?: number;
  groupType?: number;
  itineraryRouteId?: number;
};

const EMPTY_AVAILABILITY_MARKER = '__EMPTY_HOTEL_AVAILABILITY__';

export type HotelAvailabilityChangeType =
  | 'AUTO_SELECTION_CHANGED'
  | 'PRICE_CHANGED'
  | 'ROOM_TYPE_CHANGED'
  | 'MEAL_PLAN_CHANGED'
  | 'RATE_CHANGED'
  | 'SELECTION_UNAVAILABLE'
  | 'BECAME_AVAILABLE'
  | 'OFFLINE_APPROVAL_CHANGED'
  | 'SELECTION_DEDUPED'
  | 'SELECTION_REPLACED';

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

export type EmptyHotelStayBlock = {
  routeIds: number[];
  dayNumbers: number[];
  dates: string[];
  destination: string;
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
    private readonly offlineHotelCatalog: OfflineHotelCatalogService,
    private readonly hotelPricingService: HotelPricingService = new HotelPricingService(prisma),
  ) {}

  optionKey(row: any): string {
    return hotelOptionKey(row);
  }

  /** Remove an identity-less display copy when real supplier rates exist. */
  private canonicalizeRateOptions(parent: any, options: any[]): any[] {
    const normalized = (options || []).filter((option: any) => option && typeof option === 'object');
    const normalizeSupplierRoomIdentity = (option: any): any => {
      const provider = text(option?.provider || parent?.provider);
      if (provider !== 'hobse') return option;
      try {
        const reference = option?.searchReference || option?.search_reference;
        const parsed = typeof reference === 'string' ? JSON.parse(reference) : reference;
        const roomCode = String(parsed?.roomCode || '').trim();
        return roomCode ? { ...option, roomTypeId: roomCode, roomCode } : option;
      } catch {
        return option;
      }
    };
    const hasExplicitRate = (option: any): boolean => [
      option.rateOptionId, option.rate_option_id, option.bookingCode,
      option.booking_code, option.searchReference, option.search_reference,
      option.rateId, option.rate_id, option.optionKey, option.option_key,
    ].some((value: any) => String(value ?? '').trim().length > 0);
    if (!normalized.some(hasExplicitRate)) return normalized;
    const text = (value: any) => String(value ?? '').trim().toLowerCase();
    const amount = (value: any) => Number(Number(value ?? 0).toFixed(2));
    const sameDisplayCopy = (option: any): boolean =>
      text(option.provider || option.hotel_provider) === text(parent.provider || parent.hotel_provider) &&
      text(option.providerHotelCode || option.provider_hotel_code || option.hotelCode || option.hotel_code) ===
        text(parent.providerHotelCode || parent.provider_hotel_code || parent.hotelCode || parent.hotel_code) &&
      text(option.roomTypeId || option.room_type_id || option.roomId || option.room_id || option.roomType) ===
        text(parent.roomTypeId || parent.room_type_id || parent.roomId || parent.room_id || parent.roomType) &&
      text(option.mealPlan || option.meal_plan || option.mealPlanCode) ===
        text(parent.mealPlan || parent.meal_plan || parent.mealPlanCode) &&
      amount(option.baseTotalPrice || option.baseStayPrice || option.baseHotelCost || option.basePricePerNight) ===
        amount(parent.baseTotalPrice || parent.baseStayPrice || parent.baseHotelCost || parent.basePricePerNight) &&
      amount(option.totalPrice || option.totalStayPrice || option.totalAmount || option.pricePerNight) ===
        amount(parent.totalPrice || parent.totalStayPrice || parent.totalAmount || parent.pricePerNight);
    const canonical = new Map<string, any>();
    for (const sourceOption of normalized) {
      const option = normalizeSupplierRoomIdentity(sourceOption);
      const supplierRate = text(
        option.rateOptionId || option.rate_option_id || option.bookingCode || option.booking_code ||
        option.searchReference || option.search_reference || option.rateId || option.rate_id ||
        option.optionKey || option.option_key,
      );
      if (!supplierRate && sameDisplayCopy(option)) continue;
      // A supplier rate identity is stronger than a later normalized room
      // identity. Raw supplier rows may omit roomTypeId while the normalized
      // copy fills it from searchReference; including both fields would keep
      // the same rate twice. Only use room identity as a fallback when the
      // supplier did not provide any rate identity.
      const room = text(option.roomTypeId || option.room_type_id || option.roomId || option.room_id || option.roomType);
      const key = [
        text(option.provider || option.hotel_provider || parent.provider),
        supplierRate || `room:${room}`,
        supplierRate ? '' : room,
        text(option.mealPlan || option.meal_plan || option.mealPlanCode),
      ].join('|');
      const existing = canonical.get(key);
      if (!existing) {
        canonical.set(key, option);
        continue;
      }
      const existingBase = amount(existing.baseTotalPrice || existing.baseStayPrice || existing.baseHotelCost || existing.basePricePerNight);
      const optionBase = amount(option.baseTotalPrice || option.baseStayPrice || option.baseHotelCost || option.basePricePerNight);
      const existingIsRouteNight = existing.offlineRouteNightApplied === true;
      const optionIsRouteNight = option.offlineRouteNightApplied === true;
      // If the same supplier identity appears once raw and once projected,
      // the lower base is the supplier amount. Keep legitimate distinct rates
      // separate by their supplier identity/room/meal key above.
      // Offline continuous-stay rows are also emitted as route-night rows.
      // The route-night projection is authoritative for the route being
      // persisted; never let the anchor-night copy win just because its
      // amount is lower.
      if (optionIsRouteNight !== existingIsRouteNight) {
        if (optionIsRouteNight) canonical.set(key, { ...existing, ...option });
      } else if (optionBase > 0 && (existingBase <= 0 || optionBase < existingBase)) {
        canonical.set(key, { ...existing, ...option });
      } else if (existing) {
        canonical.set(key, { ...option, ...existing });
      }
    }
    return Array.from(canonical.values());
  }

  private money(amount: number): number {
    return Math.round(Number(amount || 0) * 100) / 100;
  }

  private persistedRateOptionId(option: any, fallback?: unknown): string | null {
    const value = option?.rateOptionId || option?.optionKey || option?.searchReference || option?.bookingCode || fallback;
    const normalized = String(value || '').trim();
    return normalized ? normalized.slice(0, 255) : null;
  }

  private async getPlanPreferredHotelCategories(plan: any): Promise<number[]> {
    const raw = String(plan?.preferred_hotel_category ?? '').trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return this.resolveLogicalHotelCategories(parsed);
    } catch {
      // Legacy plans store this field as comma-separated text.
    }
    return this.resolveLogicalHotelCategories(raw.split(','));
  }

  private async resolveLogicalHotelCategories(values: unknown[]): Promise<number[]> {
    const ids = values.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
    if (ids.length === 0) return [];
    const masters = await this.prisma.dvi_hotel_category.findMany({
      where: { hotel_category_id: { in: ids }, deleted: 0 },
      select: { hotel_category_id: true, hotel_category_title: true, hotel_category_code: true },
    });
    const masterById = new Map(masters.map((row: any) => [Number(row.hotel_category_id), row]));
    return Array.from(new Set(ids.map((id) => {
      const master = masterById.get(id);
      return master
        ? mapHotelCategoryLabelToStar(`${master.hotel_category_title || ''} ${master.hotel_category_code || ''}`)
        : id;
    }).filter((value): value is number => Number.isFinite(value) && value > 0))).sort((a, b) => a - b);
  }

  private persistedHotelId(option: any, fallback?: unknown): number | null {
    const value = Number(
      option?.canonicalHotelId ??
      option?.canonical_hotel_id ??
      option?.hotel_id ??
      option?.hotelId ??
      fallback ??
      0,
    );
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  private hasSupplierIdentity(option: any): boolean {
    if (String(option?.provider || option?.hotel_provider || '').trim().toLowerCase() === 'offline') {
      return false;
    }
    return [
      option?.hotelCode,
      option?.providerHotelCode,
      option?.hotel_code,
      option?.rateOptionId,
      option?.optionKey,
      option?.searchReference,
      option?.bookingCode,
    ].some((value) => String(value ?? '').trim().length > 0);
  }

  private normalizeRoomIdentity(value: unknown): string {
    return String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  private rowMatchesRoomCategorySelection(selection: any, row: any): boolean {
    if (!selection?.__roomCategorySelection) return false;
    const snapshot = parseHotelSelectionSnapshot(selection) as any;
    const selectedHotelId = Number(snapshot?.hotelId || selection?.hotel_id || 0);
    const rowHotelId = Number(
      row?.hotelId ||
      row?.hotel_id ||
      row?.canonicalHotelId ||
      row?.canonical_hotel_id ||
      0,
    );
    if (selectedHotelId > 0 && rowHotelId > 0 && selectedHotelId !== rowHotelId) return false;

    const roomTypeKeys = Array.isArray(snapshot?.roomTypeKeys)
      ? snapshot.roomTypeKeys.map((value: unknown) => this.normalizeRoomIdentity(value)).filter(Boolean)
      : [];
    if (roomTypeKeys.length === 0) return true;

    const rowRoomIdentities = [row?.roomId, row?.roomType, row?.room_type]
      .map((value) => this.normalizeRoomIdentity(value))
      .filter(Boolean);
    return rowRoomIdentities.some((identity) => roomTypeKeys.includes(identity));
  }

  /**
   * Room-category selections are deliberately created without a supplier rate
   * identity. They are only a durable record of the room(s) selected in the
   * room editor. When a fresh availability snapshot contains that room inside
   * `rateOptions`, use the fresh option's money instead of copying the old
   * selection total onto the new row.
   */
  private currentRoomCategoryOption(selection: any, row: any): any | null {
    const rateOptions = Array.isArray(row?.rateOptions) ? row.rateOptions : [];
    return rateOptions.find((option: any) =>
      this.rowMatchesRoomCategorySelection(selection, { ...row, ...option }),
    ) || null;
  }

  /**
   * Resolve one complete fresh rate.  A persisted supplier rate id is the
   * strongest identity; room/meal/price matching is only a fallback for old
   * room-category selections that were saved without a rate id.
   */
  private selectedRateOption(selection: any, row: any): any | null {
    const rateOptions = Array.isArray(row?.rateOptions) ? row.rateOptions : [];
    if (rateOptions.length === 0) return null;
    const snapshot = parseHotelSelectionSnapshot(selection) as any;
    const selectedRateId = String(
      selection?.selected_rate_option_id || snapshot?.rateOptionId || '',
    ).trim();
    if (selectedRateId) {
      const exact = rateOptions.find((option: any) => [
        option?.rateOptionId,
        option?.rate_option_id,
        option?.optionKey,
        option?.searchReference,
        option?.bookingCode,
      ].some((value: unknown) => String(value ?? '').trim() === selectedRateId));
      // Once a persisted canonical rate id exists, an approximate
      // room/meal/price match is unsafe. It can combine the old selected
      // rate's money with another option's room label. The caller must treat
      // a missing exact option as unavailable and reconcile to a fresh
      // complete option instead.
      return exact || null;
    }
    return rateOptions.find((option: any) =>
      optionMatchesSelection(selection, { ...row, ...option }),
    ) || null;
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
      if (fallback) {
        const legacyResponse = await fallback();
        return this.sanitizeLegacyResponse(legacyResponse, plan);
      }
      throw new BadRequestException('Hotel availability has not been checked yet');
    }
    const latestPayload = this.parsePayload(latest.full_payload);

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
    const persistedPlanHotelRows = await (this.prisma as any).dvi_itinerary_plan_hotel_details.findMany({
      // Read the previous-night markers together with editable selections. The
      // marker is the durable source of truth for early-arrival billing when a
      // later hotel rebuild recreates the selected row without its metadata.
      where: { itinerary_plan_id: plan.itinerary_plan_ID, hotel_required: { in: [1, 2] }, deleted: 0, status: 1 },
      orderBy: { itinerary_plan_hotel_details_ID: 'desc' },
    });
    const planRows = persistedPlanHotelRows.filter((row: any) => Number(row?.hotel_required || 0) === 1);
    const earlyArrivalMarkers = persistedPlanHotelRows.filter((row: any) =>
      Number(row?.hotel_required || 0) === 2 && Number(row?.hotel_id || 0) === 0,
    );
    const roomDetailsModel = (this.prisma as any).dvi_itinerary_plan_hotel_room_details;
    const roomDetailRows = roomDetailsModel?.findMany
      ? await roomDetailsModel.findMany({
          where: { itinerary_plan_id: plan.itinerary_plan_ID, deleted: 0, status: 1 },
          orderBy: { itinerary_plan_hotel_room_details_ID: 'asc' },
        })
      : [];
    const roomTypeIds = Array.from(
      new Set(
        roomDetailRows
          .map((row: any) => Number(row.room_type_id || 0))
          .filter((id: number) => Number.isFinite(id) && id > 0),
      ),
    );
    const roomTypeModel = (this.prisma as any).dvi_hotel_roomtype;
    const roomTypeRows = roomTypeIds.length && roomTypeModel?.findMany
      ? await roomTypeModel.findMany({
          where: { room_type_id: { in: roomTypeIds }, deleted: 0 },
          select: { room_type_id: true, room_type_title: true },
        })
      : [];
    const roomTypeTitleById = new Map<number, string>();
    roomTypeRows.forEach((row: any) => {
      roomTypeTitleById.set(Number(row.room_type_id || 0), String(row.room_type_title || '').trim());
    });
    const routeDetailsModel = (this.prisma as any).dvi_itinerary_route_details;
    const currentRoutes = routeDetailsModel?.findMany
      ? await routeDetailsModel.findMany({
          where: { itinerary_plan_ID: plan.itinerary_plan_ID, deleted: 0 },
          orderBy: { itinerary_route_date: 'asc' },
          select: {
            itinerary_route_ID: true,
            itinerary_route_date: true,
            route_start_time: true,
            next_visiting_location: true,
            location_name: true,
          },
        })
      : [];
    const currentRouteIds = new Set(
      currentRoutes.map((route: any) => Number(route.itinerary_route_ID || 0)).filter(Boolean),
    );
    const toDateOnly = (value: unknown): string => {
      const raw = String(value || '').trim();
      if (!raw) return '';
      // Route dates are stored as UTC timestamps representing India-local
      // midnight (for example 2026-08-11T18:30:00.000Z = 2026-08-12 in IST).
      // Compare those business dates with supplier payload dates, rather than
      // comparing the previous UTC calendar day.
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
      const parsed = value instanceof Date ? value : new Date(raw);
      if (Number.isNaN(parsed.getTime())) return '';
      const businessDate = new Date(parsed.getTime() + 330 * 60 * 1000);
      return businessDate.toISOString().slice(0, 10);
    };
    const currentRouteByDate = new Map<string, any>();
    const currentRouteDateById = new Map<number, string>();
    currentRoutes.forEach((route: any) => {
      const date = toDateOnly(route.itinerary_route_date);
      if (date && !currentRouteByDate.has(date)) currentRouteByDate.set(date, route);
      const routeId = Number(route.itinerary_route_ID || 0);
      if (routeId > 0 && date) currentRouteDateById.set(routeId, date);
    });
    const rowStayDate = (row: any): string => toDateOnly(
      row?.itineraryRouteDate ??
        row?.itinerary_route_date ??
        row?.hotelCheckInDate ??
        row?.hotel_check_in_date ??
        row?.checkInDate ??
        row?.check_in_date ??
        row?.date,
    );
    const usableDestination = (value: unknown): string => {
      const label = String(value || '').trim();
      return /^(?:-|—|–|n\/a|na|unknown|null|undefined)$/i.test(label) ? '' : label;
    };
    const remapSnapshotRoute = (row: any): any => {
      if (!row) return null;
      const routeId = Number(row?.itineraryRouteId ?? row?.itinerary_route_id ?? 0);
      const date = rowStayDate(row);
      const currentDateForRoute = currentRouteDateById.get(routeId);
      // A route ID is not enough to identify a stay: route edits can retain
      // the numeric ID while changing its date. Do not let an old supplier
      // option or selection leak into the new stay under that reused ID.
      if (currentDateForRoute && date && currentDateForRoute !== date) return null;
      if (!currentRouteIds.size || currentRouteIds.has(routeId)) return row;

      // Availability rows can outlive a route rebuild. The old route ID is no
      // longer valid, but the persisted snapshot still has the stay date. Map
      // it to the current route for that date before filtering; otherwise Day 1
      // (and any other rebuilt day) disappears from the edit-mode hotel list.
      const currentRoute = currentRouteByDate.get(date);
      if (!currentRoute) return row;
      const currentRouteIndex = currentRoutes.findIndex(
        (candidate: any) => Number(candidate.itinerary_route_ID) === Number(currentRoute.itinerary_route_ID),
      );
      return {
        ...row,
        itineraryRouteId: Number(currentRoute.itinerary_route_ID),
        // Keep every route alias in sync. Supplier payloads commonly expose
        // `routeId` while persisted selections use `itinerary_route_id`; if
        // only one alias is remapped, a selection can be matched by the new
        // key but still be rendered as an unavailable row on the old route.
        routeId: Number(currentRoute.itinerary_route_ID),
        routeIds: [Number(currentRoute.itinerary_route_ID)],
        itineraryRouteDate: currentRoute.itinerary_route_date,
        itinerary_route_id: Number(currentRoute.itinerary_route_ID),
        itinerary_route_date: currentRoute.itinerary_route_date,
        day: row.day || `Day ${currentRouteIndex + 1} | ${date}`,
        destination: usableDestination(row.destination) ||
          usableDestination(currentRoute.next_visiting_location) ||
          usableDestination(currentRoute.location_name),
      };
    };
    // Persisted hotel selections and room-category rows can retain route IDs
    // from before an itinerary route rebuild. Normalize them with the same
    // date-based mapping used for availability rows before building the
    // selection map; otherwise a saved per-day meal-plan choice is invisible
    // to the current snapshot and the auto-selected row wins on reload.
    const remappedPlanRows = planRows.map(remapSnapshotRoute).filter(Boolean);
    const remappedRoomDetailRows = roomDetailRows.map(remapSnapshotRoute).filter(Boolean);
    const earlyArrivalMarkerByRouteGroup = new Map<string, any>(
      earlyArrivalMarkers.map((marker: any) => [
        `${Number(marker?.itinerary_route_id || 0)}-${Number(marker?.group_type || 0)}`,
        marker,
      ]),
    );
    // Early-arrival billing is an itinerary/route decision. A persisted
    // marker is written for every recommendation group, but supplier rows
    // from older snapshots can omit or carry a stale group_type. Keep the
    // exact group match first, then use the route marker as a safe fallback;
    // this only decorates the existing payable row and never changes its
    // selection identity, room, meal plan, or price.
    const earlyArrivalMarkerByRoute = new Map<number, any>();
    earlyArrivalMarkers.forEach((marker: any) => {
      const routeId = Number(marker?.itinerary_route_id || 0);
      if (routeId > 0 && !earlyArrivalMarkerByRoute.has(routeId)) {
        earlyArrivalMarkerByRoute.set(routeId, marker);
      }
    });
    const earlyArrivalSelectionRows = remappedPlanRows.map((row: any) => {
      const routeId = Number(row?.itinerary_route_id || row?.itineraryRouteId || 0);
      const groupType = Number(row?.group_type || row?.groupType || 0);
      const marker = earlyArrivalMarkerByRouteGroup.get(`${routeId}-${groupType}`) ||
        earlyArrivalMarkerByRoute.get(routeId);
      if (!marker) return row;

      const route = currentRoutes.find((candidate: any) => Number(candidate?.itinerary_route_ID || 0) === routeId);
      const routeDate = route?.itinerary_route_date || row?.itinerary_route_date;
      const hotelCheckOutDate = routeDate ? new Date(routeDate) : null;
      if (hotelCheckOutDate && !Number.isNaN(hotelCheckOutDate.getTime())) {
        hotelCheckOutDate.setUTCDate(hotelCheckOutDate.getUTCDate() + 1);
      }
      const actualGuestArrivalAt = (plan as any).trip_start_date_and_time || null;
      const blockedFromDate = marker?.itinerary_route_date || row?.itinerary_route_date || null;
      const arrivalDate = actualGuestArrivalAt || routeDate;
      const earlyCheckInNote = String(marker?.early_checkin_note || '').trim() ||
        `Guest has opted for early morning check-in with extra payment. Room to be blocked from ${String(blockedFromDate || '').slice(0, 10)}.`;

      return {
        ...row,
        early_checkin: 1,
        early_checkin_extra_payment_applicable: 1,
        early_checkin_payment_status: 'EXTRA_PAYMENT_APPLICABLE',
        hotel_check_in_date: blockedFromDate,
        hotel_check_out_date: hotelCheckOutDate || row?.hotel_check_out_date || null,
        actual_guest_arrival_at: arrivalDate,
        early_checkin_note: earlyCheckInNote,
      };
    });
    const noOfNights = Math.max(Number((plan as any).no_of_nights || 0), 0);
    const searchableRoutes = resolveHotelRequiredRoutes(currentRoutes, noOfNights);

    const selectedByRouteGroup = new Map<string, any>();
    for (const row of earlyArrivalSelectionRows) {
      const key = hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row);
      if (isSpecialHotelPlanRow(row)) continue;
      const current = selectedByRouteGroup.get(key);
      const rowHasSelectionMetadata = Boolean(
        String(row?.selected_rate_option_id || '').trim() ||
          String(row?.selected_price_snapshot || '').trim(),
      );
      const rowSelectionOrigin = selectionOriginFromRow(row);
      const currentHasSelectionMetadata = Boolean(
        String(current?.selected_rate_option_id || '').trim() ||
          String(current?.selected_price_snapshot || '').trim(),
      );
      const currentSelectionOrigin = selectionOriginFromRow(current);
      // The same table stores both availability option rows and the actual
      // persisted selection. Prefer the row carrying selection metadata;
      // otherwise a later AUTO_SELECTED availability row can hide a user's
      // meal-plan and hotel choice on the next page load. A USER_SELECTED
      // row is authoritative even when its numeric ID is older.
      if (
        !current ||
        (rowSelectionOrigin === 'USER_SELECTED' && currentSelectionOrigin !== 'USER_SELECTED') ||
        (rowHasSelectionMetadata && !currentHasSelectionMetadata)
      ) {
        selectedByRouteGroup.set(key, row);
      }
    }
    const roomSelectionsByRouteGroup = new Map<string, {
      hotelId: number;
      roomCount: number;
      roomTypeKeys: Set<string>;
      roomTypeLabels: string[];
      roomTypeAssignments: string[];
    }>();
    remappedRoomDetailRows.forEach((row: any) => {
      const key = hotelSelectionKey(
        plan.itinerary_plan_ID,
        Number(row.itinerary_route_id || 0),
        Number(row.group_type || 0),
        row.itinerary_route_date,
      );
      if (!key) return;
      const roomDetailSelectionId = Number(row.itinerary_plan_hotel_details_id || 0);
      const existingSelection = selectedByRouteGroup.get(key) || Array.from(selectedByRouteGroup.values()).find((candidate: any) => {
        const candidateSelectionId = Number(candidate?.itinerary_plan_hotel_details_ID || 0);
        const candidateRouteId = Number(candidate?.itinerary_route_id || candidate?.itineraryRouteId || 0);
        const candidateDate = String(candidate?.itinerary_route_date || candidate?.itineraryRouteDate || candidate?.date || '').slice(0, 10);
        const roomDate = String(row.itinerary_route_date || '').slice(0, 10);
        return roomDetailSelectionId > 0 && candidateSelectionId === roomDetailSelectionId &&
          candidateRouteId === Number(row.itinerary_route_id || 0) && candidateDate === roomDate;
      });
      const selectionKey = existingSelection
        ? hotelSelectionKeyFromRow(plan.itinerary_plan_ID, existingSelection)
        : key;
      const persistedSelectionId = Number(existingSelection?.itinerary_plan_hotel_details_ID || 0);
      // Room-detail rows are also persisted for every availability option.
      // Once a selected hotel row is known, only its room rows may participate
      // in reconciliation; otherwise the last availability option can replace
      // the actual selected hotel during edit-mode reconstruction.
      if (
        persistedSelectionId > 0 &&
        roomDetailSelectionId > 0 &&
        persistedSelectionId !== roomDetailSelectionId
      ) {
        return;
      }
      const existingSnapshot = existingSelection ? parseHotelSelectionSnapshot(existingSelection) as any : null;
      const providerRoomId = String(row.room_id || '').trim();
      const mappedRoomTypeTitle = String(
        roomTypeTitleById.get(Number(row.room_type_id || 0)) ||
        '',
      ).trim();
      const snapshotRoomType = String(
        existingSnapshot?.roomType ||
        existingSelection?.room_type ||
        '',
      ).trim();
      const roomTypeLabel = mappedRoomTypeTitle ||
        (providerRoomId && !/^\d+$/.test(providerRoomId) ? providerRoomId : '') ||
        snapshotRoomType ||
        String(row.room_type_id || '').trim();
      const roomTypeKey = this.normalizeRoomIdentity(
        (providerRoomId && !/^\d+$/.test(providerRoomId) ? providerRoomId : '') ||
        snapshotRoomType ||
        roomTypeLabel,
      );
      const current = roomSelectionsByRouteGroup.get(selectionKey) || {
        hotelId: Number(row.hotel_id || 0),
        roomCount: 0,
        roomTypeKeys: new Set<string>(),
        roomTypeLabels: [],
        roomTypeAssignments: [],
      };
      current.hotelId = Number(current.hotelId || row.hotel_id || 0);
      (current as any).routeId = Number(row.itinerary_route_id || 0);
      (current as any).groupType = Number(existingSelection?.group_type || existingSelection?.groupType || row.group_type || 0);
      (current as any).routeDate = existingSelection?.itinerary_route_date || row.itinerary_route_date || null;
      current.roomCount += Math.max(Number(row.room_qty || 1), 1);
      for (let index = 0; index < Math.max(Number(row.room_qty || 1), 1); index += 1) {
        if (roomTypeLabel) current.roomTypeAssignments.push(roomTypeLabel);
      }
      if (roomTypeKey) current.roomTypeKeys.add(roomTypeKey);
      if (roomTypeLabel && !current.roomTypeLabels.includes(roomTypeLabel)) current.roomTypeLabels.push(roomTypeLabel);
      roomSelectionsByRouteGroup.set(selectionKey, current);
    });
    roomSelectionsByRouteGroup.forEach((roomSelection: any, key: string) => {
      const existingSelection = selectedByRouteGroup.get(key) || Array.from(selectedByRouteGroup.values()).find((candidate: any) => {
        const candidateRouteId = Number(candidate?.itinerary_route_id ?? candidate?.itineraryRouteId ?? 0);
        const candidateGroupType = Number(candidate?.group_type ?? candidate?.groupType ?? 0);
        const candidateDate = rowStayDate(candidate);
        const sameStay = candidateRouteId === Number(roomSelection.routeId || 0) &&
          candidateDate === toDateOnly(roomSelection.routeDate);
        const sameGroup = candidateGroupType === Number(roomSelection.groupType || 0);
        const sameHotel = Number(candidate?.hotel_id || candidate?.hotelId || 0) === Number(roomSelection.hotelId || 0);
        return sameStay && sameGroup && sameHotel;
      });
      const selectionKey = existingSelection
        ? hotelSelectionKeyFromRow(plan.itinerary_plan_ID, existingSelection)
        : key;
      const existingSnapshot = existingSelection ? parseHotelSelectionSnapshot(existingSelection) as any : null;
      const existingHotelId = Number(existingSnapshot?.hotelId || existingSelection?.hotel_id || 0);
      const existingRoomKey = this.normalizeRoomIdentity(
        existingSnapshot?.roomType ||
        existingSelection?.room_type ||
        existingSelection?.room_id,
      );
      const shouldOverrideSelection =
        !existingSelection ||
        (Number(roomSelection.hotelId || 0) > 0 && existingHotelId > 0 && Number(roomSelection.hotelId) !== existingHotelId) ||
        (roomSelection.roomTypeKeys.size > 0 && existingRoomKey && !roomSelection.roomTypeKeys.has(existingRoomKey));
      const roomSelections = roomSelection.roomTypeAssignments.map((roomTypeTitle: string, index: number) => ({
        room_number: index + 1,
        room_type_title: roomTypeTitle,
        room_qty: 1,
      }));
      if (existingSelection) {
        selectedByRouteGroup.set(selectionKey, {
          ...existingSelection,
          roomSelections,
        });
      }
      if (!shouldOverrideSelection) return;
      const primaryRoomType = roomSelection.roomTypeLabels[0] || '';
      selectedByRouteGroup.set(selectionKey, {
        ...(existingSelection || {}),
        roomSelections,
        __roomCategorySelection: true,
        itinerary_plan_id: plan.itinerary_plan_ID,
        itinerary_route_id: Number(roomSelection.routeId || 0),
        group_type: Number(roomSelection.groupType || 0),
        itinerary_route_date: roomSelection.routeDate || null,
        hotel_id: Number(roomSelection.hotelId || 0),
        room_type: primaryRoomType,
        total_no_of_rooms: Math.max(Number(roomSelection.roomCount || 0), 1),
        selected_price_snapshot: JSON.stringify({
          hotelId: Number(roomSelection.hotelId || 0),
          roomType: primaryRoomType,
          roomTypeKeys: Array.from(roomSelection.roomTypeKeys || []),
          totalRooms: Math.max(Number(roomSelection.roomCount || 0), 1),
          selectionOrigin: 'USER_SELECTED',
        }),
      });
    });
    // Legacy persisted selections can retain a route/date alias that differs
    // from the current snapshot row after a route rebuild. Reconcile only
    // within the same group and stay, and only when the hotel identity agrees;
    // this prevents a selection from another day or property leaking in.
    const selectionForSnapshotRow = (row: any): any | undefined => {
      const key = hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row);
      const direct = selectedByRouteGroup.get(key);
      if (direct) return direct;

      const rowGroupType = Number(row?.groupType ?? row?.group_type ?? 0);
      const rowRouteId = Number(
        row?.itineraryRouteId ?? row?.routeId ?? row?.itinerary_route_id ?? 0,
      );
      const rowDate = rowStayDate(row);
      return Array.from(selectedByRouteGroup.values()).find((selection: any) => {
        if (Number(selection?.group_type || selection?.groupType || 0) !== rowGroupType) {
          return false;
        }
        const selectionRouteId = Number(
          selection?.itinerary_route_id ?? selection?.routeId ?? 0,
        );
        const selectionDate = rowStayDate(selection);
        const sameStay =
          (selectionRouteId > 0 && rowRouteId > 0 && selectionRouteId === rowRouteId) ||
          Boolean(selectionDate && rowDate && selectionDate === rowDate);
        return sameStay && hotelPropertyMatchesSelection(selection, row);
      });
    };

    const recommendationGroupTypes = this.normalizeRecommendationGroupTypes(
      remappedPlanRows,
      rows.map((row: any) => ({
        ...this.parsePayload(row.full_payload),
        groupType: Number(this.parsePayload(row.full_payload)?.groupType || row.group_type || 0),
      })),
    );
    const snapshotRows = rows.flatMap((row: any) => {
      const payload = this.parsePayload(row.full_payload);
      if (!payload) return [];
      if (payload.availabilityMarker === EMPTY_AVAILABILITY_MARKER) return [];
      const groupType = Number(payload.groupType || row.group_type || 0);
      // Cache columns are the durable boundary for route/date identity. Some
      // older payloads omitted date aliases, so fill them from the cache row
      // before applying the current-route version check.
      const normalized = {
        ...payload,
        itineraryRouteId: payload.itineraryRouteId ?? payload.routeId ?? row.route_id,
        itinerary_route_id: payload.itinerary_route_id ?? row.route_id,
        itineraryRouteDate: payload.itineraryRouteDate ?? payload.date ?? row.check_in_date,
        itinerary_route_date: payload.itinerary_route_date ?? row.check_in_date,
        date: payload.date ?? payload.checkInDate ?? row.check_in_date,
        checkInDate: payload.checkInDate ?? payload.date ?? row.check_in_date,
        checkOutDate: payload.checkOutDate ?? row.check_out_date,
        groupType,
      };
      const currentVersion = remapSnapshotRoute(normalized);
      if (!currentVersion) return [];
      const provider = String(normalized.provider || normalized.hotel_provider || '').trim().toLowerCase();
      if (provider !== 'offline' || groupType > 0) return [currentVersion];
      return recommendationGroupTypes.map((candidateGroupType) => ({
        ...currentVersion,
        groupType: candidateGroupType,
      }));
    });

    const effectiveMarginPercentage = await this.hotelPricingService.resolveEffectiveHotelMarginPercentage({});
    const selectedForSnapshotRows = new Map(selectedByRouteGroup);
    snapshotRows.forEach((row: any) => {
      const selection = selectionForSnapshotRow(row);
      if (selection) {
        selectedForSnapshotRows.set(
          hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row),
          selection,
        );
      }
    });
    let normalizedRows = snapshotRows
      .filter(Boolean)
      .map(remapSnapshotRoute)
      .filter(Boolean)
      .filter((row: any) => !currentRouteIds.size || currentRouteIds.has(Number(row.itineraryRouteId || 0)))
      .map((row: any) => this.normalizeRatePlanLabels(row))
      .map((row: any) => this.decorateSelection(row, selectedForSnapshotRows, plan.itinerary_plan_ID)) as any[];

    // A room-category edit intentionally changes the selected rate/room
    // identity. The availability snapshot can still contain the same hotel
    // property under a different room/rate, so first find an exact match and
    // only then fall back to the first row for the same property. Without this
    // two-pass mapping the old recommendation remains visible while the saved
    // selection is treated as unavailable.
    const exactSelectionKeys = new Set(
      normalizedRows
        .filter((row: any) => {
          const selection = selectedForSnapshotRows.get(hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row));
          return Boolean(selection && this.rowMatchesSelection(selection, row));
        })
        .map((row: any) => hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row)),
    );
    const propertyFallbackKeys = new Set<string>();
    normalizedRows = normalizedRows.map((row: any) => {
      const key = hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row);
      const selection = selectedForSnapshotRows.get(key);
      if (!selection || exactSelectionKeys.has(key) || propertyFallbackKeys.has(key)) return row;
      if (!hotelPropertyMatchesSelection(selection, row)) return row;
      propertyFallbackKeys.add(key);
      return this.decoratePropertySelection(row, selection, plan.itinerary_plan_ID);
    });

    const appliedRoomSelectionKeys = new Set<string>();
    normalizedRows = normalizedRows.map((row: any) => {
      const key = hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row);
      if (selectedForSnapshotRows.has(key)) return row;
      const roomSelection = roomSelectionsByRouteGroup.get(key);
      if (!roomSelection) return row;
      if (appliedRoomSelectionKeys.has(key)) return row;

      const rowHotelId = Number(
        row.hotelId ||
        row.hotel_id ||
        row.canonicalHotelId ||
        row.canonical_hotel_id ||
        0,
      );
      if (Number(roomSelection.hotelId || 0) > 0 && rowHotelId > 0 && Number(roomSelection.hotelId) !== rowHotelId) {
        return row;
      }

      const rowRoomIdentity = this.normalizeRoomIdentity(row.roomId || row.roomType || row.room_type);
      if (roomSelection.roomTypeKeys.size > 0 && rowRoomIdentity && !roomSelection.roomTypeKeys.has(rowRoomIdentity)) {
        return row;
      }

      appliedRoomSelectionKeys.add(key);
      const roomCount = Math.max(Number(roomSelection.roomCount || 0), Number(row.noOfRooms || 0), 1);
      return {
        ...row,
        isSelected: true,
        selectionOrigin: 'USER_SELECTED',
        selectionId: Number(row.selectionId || 0),
        selectionStatus: 'AVAILABLE',
        noOfRooms: roomCount,
        total_no_of_rooms: roomCount,
        selection: {
          ...hotelDisplaySnapshot(row),
          status: 'AVAILABLE',
          selectionOrigin: 'USER_SELECTED',
          selectionId: Number(row.selectionId || 0),
          totalRooms: roomCount,
        },
      };
    });

    // A missing selected option is selection metadata on the existing
    // route/day/group row, never a synthetic option row. This keeps row/day
    // cardinality equal to the availability snapshot and prevents fabricated
    // names such as "Previously selected hotel".
    const markedUnavailable = new Set<string>();
    const matchedSelectionKeys = new Set(
      normalizedRows
        .filter((row: any) => {
          const selection = selectedForSnapshotRows.get(hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row));
          return Boolean(selection && (
            row.isSelected ||
            this.rowMatchesSelection(selection, row) ||
            hotelPropertyMatchesSelection(selection, row)
          ));
        })
        .map((row: any) => hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row)),
    );
    normalizedRows = normalizedRows.map((row: any) => {
      const selection = selectedForSnapshotRows.get(hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row));
      if (!selection || this.rowMatchesSelection(selection, row)) return row;
      const key = hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row);
      if (matchedSelectionKeys.has(key)) return row;
      if (markedUnavailable.has(key)) return row;
      markedUnavailable.add(key);
      return this.decorateUnavailableSelection(row, selection);
    });

    // A requested meal plan is a pricing requirement, not a display label.
    // Keep differently-priced plans available for explicit selection, but do
    // not present them as an automatic selection for the requested plan.
    normalizedRows = this.decorateMealPlanAutoSelectionBlockers(
      normalizedRows,
      String((plan as any).meal_plan_code || '').trim(),
      selectedForSnapshotRows,
      plan.itinerary_plan_ID,
    );

    // A persisted supplier snapshot can be partial: a live search may return
    // an option for only some stays while the itinerary still has selected
    // hotels for the remaining route/day groups. Keep that selection on its
    // real route/day row as metadata. Never append a fabricated placeholder or
    // a second "previously selected" hotel row.
    const snapshotKeys = new Set(
      normalizedRows.map((row: any) => hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row)),
    );
    const missingSelectionKeys = new Set(
      Array.from(selectedByRouteGroup.keys()).filter((key) => !snapshotKeys.has(key)),
    );
    const missingSelectionHotelIds = Array.from(missingSelectionKeys)
      .map((key) => Number(selectedByRouteGroup.get(key)?.hotel_id || 0))
      .filter((hotelId) => hotelId > 0);
    const missingSelectionMasters = missingSelectionHotelIds.length && (this.prisma as any).dvi_hotel?.findMany
      ? await (this.prisma as any).dvi_hotel.findMany({
          where: { hotel_id: { in: missingSelectionHotelIds }, deleted: false },
          select: { hotel_id: true, hotel_name: true, hotel_category: true },
        })
      : [];
    const missingSelectionMasterById = new Map<number, any>(
      (missingSelectionMasters || []).map((master: any) => [Number(master.hotel_id), master]),
    );
    for (const key of missingSelectionKeys) {
      const selection = selectedByRouteGroup.get(key);
      if (!selection) continue;
      const routeId = Number(selection.itinerary_route_id || 0);
      const route = currentRoutes.find((candidate: any) => Number(candidate.itinerary_route_ID || 0) === routeId);
      const date = toDateOnly(selection.itinerary_route_date || route?.itinerary_route_date);
      if (!routeId || !date) continue;

      const selectionSnapshot = { ...selection, ...parseHotelSelectionSnapshot(selection) };
      const selectionOrigin = selectionOriginFromRow(selection);
      const selectionId = Number(selection.itinerary_plan_hotel_details_ID || 0);
      const master = missingSelectionMasterById.get(Number(selection.hotel_id || 0));
      const displaySnapshot = hotelDisplaySnapshot(selectionSnapshot);
      const displayName = String(displaySnapshot.hotelName || master?.hotel_name || '').trim();
      const display = {
        ...displaySnapshot,
        hotelName: displayName || null,
        category: displayName
          ? displaySnapshot.category || Number(master?.hotel_category || 0) || null
          : null,
      };
      const unavailableHotelLabel = displayName || 'Previously selected hotel unavailable';
      normalizedRows.push({
        ...display,
        groupType: Number(selection.group_type || 0),
        itineraryRouteId: routeId,
        day: `Day ${currentRoutes.findIndex((candidate: any) => Number(candidate.itinerary_route_ID || 0) === routeId) + 1} | ${date}`,
        date,
        destination: String(route?.next_visiting_location || route?.location_name || selection.itinerary_route_location || '').trim(),
        hotelId: Number(selection.hotel_id || 0),
        hotelCode: selection.hotel_code || selection.hotel_id || null,
        hotelName: unavailableHotelLabel,
        totalHotelCost: Number(selection.selected_total_price || selection.total_hotel_cost || 0),
        totalHotelTaxAmount: Number(selection.total_hotel_tax_amount || 0),
        isBookable: false,
        isSelectable: false,
        isSelected: true,
        selectionStatus: 'UNAVAILABLE',
        selectionOrigin,
        selectionId,
        itineraryPlanHotelDetailsId: selectionId,
        availabilityStatus: 'REVIEW_REQUIRED',
        showSelectionWarning: true,
        availabilityMessage: 'The selected hotel is not present in the latest availability snapshot. Check Availability to refresh options.',
        selection: {
          ...display,
          status: 'UNAVAILABLE',
          selectionOrigin,
          selectionId,
        },
      });
      snapshotKeys.add(key);
    }

    // Project the complete snapshot before calculating tab totals or compact
    // stay-summary rows.  Stored recommendation tabs and persisted selection
    // rows can contain supplier/base amounts while the client contract is
    // payable (base + margin).  Previously the later projection happened only
    // after `buildTabs`, so a legacy stored tab could keep returning the raw
    // base total even though the hotel card itself had a margin.
    const itineraryRoomCount = Math.max(Number((plan as any).preferred_room_count || 1), 1);
    normalizedRows = normalizedRows.map((row: any) => {
      const normalizedProvider = String(row?.provider || row?.hotel_provider || '').trim().toLowerCase();
      const nightlyRates = Array.isArray(row?.nightlyRates) ? row.nightlyRates : [];
      const routeDate = toDateOnly(row?.date || row?.checkInDate || row?.itineraryRouteDate);
      const routeNight = normalizedProvider === 'offline'
        ? nightlyRates.find((night: any) => String(night?.date || '').slice(0, 10) === routeDate)
        : null;
      const roomCount = Math.max(Number(row?.noOfRooms || row?.total_no_of_rooms || itineraryRoomCount), 1);
      if (!row?.isSelected || !routeNight) {
        return projectHotelPayablePricing({
          ...row,
          noOfRooms: roomCount,
          total_no_of_rooms: roomCount,
        }, effectiveMarginPercentage);
      }

      // A continuous offline stay keeps one offer and one nightlyRates array,
      // but each selected itinerary route must expose that route's payable
      // night. decorateSelection can merge the parent offer back onto the
      // selected row, so project it again here from the matching calendar
      // date before building tabs and returning the API response.
      const baseTotal = Math.max(Number(routeNight.baseAmount || 0), 0);
      const extraBedAmount = Math.max(Number(row?.extraBedAmount || 0), 0);
      const childWithBedAmount = Math.max(Number(row?.childWithBedAmount || 0), 0);
      const childWithoutBedAmount = Math.max(Number(row?.childWithoutBedAmount || 0), 0);
      const supplementTotal = Number((extraBedAmount + childWithBedAmount + childWithoutBedAmount).toFixed(2));
      const marginPercentage = Math.max(Number(row?.hotelMarginPercentage || effectiveMarginPercentage || 0), 0);
      const marginBase = Number((baseTotal + supplementTotal).toFixed(2));
      const marginAmount = Number((marginBase * marginPercentage / 100).toFixed(2));
      const payableTotal = Number((marginBase + marginAmount).toFixed(2));
      const projected = {
        ...row,
        noOfRooms: roomCount,
        total_no_of_rooms: roomCount,
        basePricePerNight: Number((baseTotal / roomCount).toFixed(2)),
        baseTotalPrice: baseTotal,
        baseHotelCost: baseTotal,
        totalRoomCost: baseTotal,
        pricePerNight: payableTotal,
        selectedPricePerNight: payableTotal,
        selected_price_per_night: payableTotal,
        totalPrice: payableTotal,
        selectedTotalPrice: payableTotal,
        selected_total_price: payableTotal,
        totalStayPrice: payableTotal,
        totalHotelCost: payableTotal,
        hotelMarginBaseAmount: marginBase,
        hotelMarginAmount: marginAmount,
        hotelMarginTotalAmount: marginAmount,
        hotelMarginPercentage: marginPercentage,
        selection: row.selection
          ? {
              ...row.selection,
              basePricePerNight: Number((baseTotal / roomCount).toFixed(2)),
              baseTotalPrice: baseTotal,
              pricePerNight: payableTotal,
              totalPrice: payableTotal,
              hotelMarginAmount: marginAmount,
              hotelMarginTotalAmount: marginAmount,
            }
          : row.selection,
      };
      return projectHotelPayablePricing(projected, effectiveMarginPercentage);
    });

    // Recommendation groups own only the automatic selection.  The day-pane
    // inventory must be shared, so retain the complete unfiltered snapshot
    // before applying any group/route pagination filters below.
    const allSharedInventoryRows = normalizedRows;

    if (options.groupType && options.groupType > 0) {
      normalizedRows = normalizedRows.filter((row) => Number(row.groupType || 0) === Number(options.groupType));
    }
    if (options.itineraryRouteId && options.itineraryRouteId > 0) {
      normalizedRows = normalizedRows.filter((row) => Number(row.itineraryRouteId || 0) === Number(options.itineraryRouteId));
    }

    const selectedPayableByRouteGroup = new Map<string, number>();
    const selectedPayableByGroup = new Map<number, number>();
    const selectedRouteIdsByGroup = new Map<number, Set<number>>();
    const selectedSnapshotKeys = new Set(
      allSharedInventoryRows
        .filter((row: any) => row?.isSelected === true)
        .map((row: any) => hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row)),
    );
    for (const key of selectedSnapshotKeys) {
      const selection = selectedForSnapshotRows.get(key);
      const selectedRowFromKey = allSharedInventoryRows.find(
        (row: any) => hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row) === key && row?.isSelected === true,
      );
      const routeId = Number(selectedRowFromKey?.itineraryRouteId || selectedRowFromKey?.routeId || 0);
      const groupType = Number(selectedRowFromKey?.groupType || selection?.group_type || 0);
      const selectedRow = allSharedInventoryRows.find((row: any) =>
        Number(row?.groupType || 0) === groupType &&
        Number(row?.itineraryRouteId || row?.routeId || 0) === routeId &&
        row?.isSelected === true,
      );
      const amount = hotelCardPayableAmount(selectedRow || projectHotelPayablePricing({
        ...selection,
        ...parseHotelSelectionSnapshot(selection),
        totalPrice: selection?.selected_total_price ?? selection?.total_hotel_cost,
        pricePerNight: selection?.selected_price_per_night,
      }, effectiveMarginPercentage));
      if (!routeId || groupType < 1 || groupType > 4 || amount <= 0) continue;
      selectedPayableByRouteGroup.set(`${routeId}-${groupType}`, amount);
      const selectedRouteIds = selectedRouteIdsByGroup.get(groupType) || new Set<number>();
      selectedRouteIds.add(routeId);
      selectedRouteIdsByGroup.set(groupType, selectedRouteIds);
      selectedPayableByGroup.set(
        groupType,
        this.money((selectedPayableByGroup.get(groupType) || 0) + amount),
      );
    }
    const builtTabs = this.buildTabs(
      normalizedRows,
      searchableRoutes,
      noOfNights,
      options.itineraryRouteId && options.itineraryRouteId > 0
        ? []
        : latestPayload?.recommendationTabs,
      options.groupType,
    );
    // buildTabs already resolves one authoritative payable option per logical
    // stay. Do not replace that result by summing USER_SELECTED rows: a
    // partial snapshot may contain a fresh selectable night plus an
    // unavailable persisted night, and summing only the latter drops the
    // fresh night's amount from the package total.
    // Persisted plan selections are the hard-reload authority for only their
    // own package. Preserve tab identity/order and replace no other group.
    const tabs = builtTabs.map((tab) => {
      const tabGroupType = Number(tab.groupType || 0);
      const selectedTotal = selectedPayableByGroup.get(tabGroupType) || 0;
      const selectedRouteIds = selectedRouteIdsByGroup.get(tabGroupType) || new Set<number>();
      // If a group has no persisted selection for some routes, derive only
      // those unresolved routes from the current snapshot. This preserves the
      // selected route prices while adding a price for any remaining route
      // that actually has an authoritative availability row. Do not derive
      // from the full group: that could replace a selected price with a
      // cheaper alternative or double-count a multi-night stay.
      const unresolvedRows = normalizedRows.filter((row: any) =>
        Number(row?.groupType || 0) === tabGroupType &&
        !selectedRouteIds.has(Number(row?.itineraryRouteId || 0)),
      );
      const unresolvedTabs = unresolvedRows.length > 0
        ? this.buildTabs(unresolvedRows, searchableRoutes, noOfNights, [], tabGroupType)
        : [];
      const unresolvedTotal = Number(unresolvedTabs[0]?.totalAmount || 0);
      const selectableRouteIds = new Set(normalizedRows
        .filter((row: any) =>
          Number(row?.groupType || 0) === tabGroupType &&
          Number(row?.itineraryRouteId || 0) > 0 &&
          row?.isPlaceholder !== true &&
          row?.isSelectable !== false &&
          row?.isBookable !== false,
        )
        .map((row: any) => Number(row.itineraryRouteId)));
      // A genuinely empty stay (for example a destination with no hotel
      // inventory) cannot have a persisted selection and must not prevent the
      // other selected routes from becoming the package price authority.
      const hasCompletePersistedCoverage = selectableRouteIds.size > 0 &&
        Array.from(selectableRouteIds).every((routeId) => selectedRouteIds.has(routeId));
      if (selectedTotal <= 0) return tab;

      // A recommendation can be incomplete when one or more destinations
      // have no selected hotel. The selected routes still have a real price,
      // so expose that partial amount instead of collapsing the whole package
      // to zero. The incomplete state remains visible to the client through
      // the existing tab/route selection metadata; missing routes are not
      // priced and remain the user's external-arrangement responsibility.
      return {
        ...tab,
        totalAmount: this.money(selectedTotal + (Number.isFinite(unresolvedTotal) ? unresolvedTotal : 0)),
        partialTotal: this.money(selectedTotal + (Number.isFinite(unresolvedTotal) ? unresolvedTotal : 0)),
        ...(hasCompletePersistedCoverage ? {} : { complete: false }),
      };
    });
    normalizedRows = decorateHotelCardPricing(
      normalizedRows.map((row) => projectHotelPayablePricing(row, effectiveMarginPercentage)),
      selectedPayableByRouteGroup,
    );
    const sharedInventoryRows = options.itineraryRouteId && options.itineraryRouteId > 0
      ? allSharedInventoryRows.filter((row: any) =>
          Number(row?.itineraryRouteId || row?.routeId || 0) === Number(options.itineraryRouteId),
        )
      : allSharedInventoryRows;
    const sharedHotelInventory = this.buildSharedHotelInventory(
      sharedInventoryRows,
      effectiveMarginPercentage,
    );
    const page = Math.max(1, Number(options.page || 1));
    // pageSize=0 is the complete-snapshot contract used by reset and by the
    // unfiltered edit/reload endpoint. Filtered and explicit page requests
    // remain bounded for the hotel-panel pagination flow.
    const unpaged = Number(options.pageSize) === 0;
    const pageSize = unpaged
      ? Math.max(normalizedRows.length, 1)
      : Math.min(100, Math.max(1, Number(options.pageSize || 20)));
    const total = normalizedRows.length;
    const start = (page - 1) * pageSize;
    const paged = unpaged ? normalizedRows : normalizedRows.slice(start, start + pageSize);
    const checkedAt = new Date(latest.synced_at);
    const recommendationAlgorithm = String(
      (latest as any).recommendation_algorithm_version ||
      latestPayload?.recommendationAlgorithm ||
      resolveHotelRecommendationAlgorithm(),
    ).toLowerCase() === 'v2' ? 'v2' : 'v1';
    const searchRunId = String(
      (latest as any).recommendation_search_run_id ||
      latestPayload?.searchRunId ||
      `legacy-hotel-${plan.itinerary_plan_ID}-${checkedAt.toISOString()}`,
    );
    const recommendationGeneration = {
      version: recommendationAlgorithm,
      algorithm: recommendationAlgorithm === 'v2' ? 'TARGET_PRICE_DIVERSITY_BEAM_SEARCH' : 'LEGACY_PRICE_PACKAGE',
      searchRunId,
      generatedAt: new Date((latest as any).recommendation_generated_at || checkedAt).toISOString(),
      warnings: [] as string[],
    } as const;
    // TBO booking codes are session-bound for 35 minutes. Keep the
    // availability state aligned with that validity window so confirmation
    // cannot treat a 35+ minute TBO row as fresh.
    const ttlMinutes = Math.max(Number(process.env.HOTEL_AVAILABILITY_TTL_MINUTES || 35), 1);
    const expiresAt = new Date(checkedAt.getTime() + ttlMinutes * 60 * 1000).toISOString();
    const hasUnavailableSelection = normalizedRows.some((row: any) => row.selectionStatus === 'UNAVAILABLE');
    const snapshotMessage = String(latestPayload?.availabilityMessage || '').trim();
    const placeholderRows: any[] = [];
    const availabilityState = this.getAvailabilityState(checkedAt, hasUnavailableSelection);
    const searchableRouteIds = new Set(searchableRoutes.map((route: any) => Number(route.itinerary_route_ID || 0)).filter(Boolean));
    const emptySearchRoutes = Array.from(searchableRouteIds).filter((routeId) => !normalizedRows.some((row: any) =>
      Number(row.itineraryRouteId || 0) === routeId &&
      row.isBookable !== false &&
      row.isPlaceholder !== true,
    )).length;
    const emptyStayBlocks = this.buildEmptyStayBlocks(searchableRoutes, normalizedRows, noOfNights);
    const mealPlanAutoSelectionBlocks = Array.from(
      new Map(
        normalizedRows
          .filter((row: any) => row?.autoSelectionBlocked === true)
          .map((row: any) => {
            const key = hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row);
            return [key, {
              routeId: Number(row.itineraryRouteId || row.routeId || 0),
              groupType: Number(row.groupType || 0),
              date: this.toDateOnly(row.date || row.checkInDate || row.itineraryRouteDate),
              destination: String(row.destination || '').trim(),
              requestedMealPlanCode: String(row.requestedMealPlanCode || '').trim(),
              availableMealPlanCodes: Array.isArray(row.availableMealPlanCodes)
                ? row.availableMealPlanCodes
                : [],
              code: String(row.autoSelectionBlockCode || ''),
              message: String(row.autoSelectionBlockMessage || ''),
            }];
          }),
      ).values(),
    );
    const stayRoutes = searchableRoutes
      .map((route: any, index: number) => {
        const parsedDate = new Date(route.itinerary_route_date);
        if (Number.isNaN(parsedDate.getTime())) return null;
        return {
          routeId: Number(route.itinerary_route_ID || 0),
          dayNumber: Number(route.day_number || route.dayNumber || index + 1),
          date: parsedDate.toISOString().slice(0, 10),
          destination: String(route.next_visiting_location || route.location_name || '').trim(),
        };
      })
      .filter((route): route is { routeId: number; dayNumber: number; date: string; destination: string } =>
        Boolean(route && route.routeId > 0 && route.date),
      );

    // The persisted snapshot can contain valid route/date rows for a stay
    // that is absent from the current route projection (for example after a
    // partial recommendation-group search). Keep those identities in the
    // response metadata so every frontend recommendation tab can render the
    // same complete itinerary timeline.
    const stayRouteById = new Map(stayRoutes.map((route) => [route.routeId, route]));
    normalizedRows.forEach((row: any) => {
      const routeId = Number(row?.itineraryRouteId || row?.routeId || 0);
      const date = this.toDateOnly(
        row?.date || row?.checkInDate || row?.itineraryRouteDate || row?.itinerary_route_date,
      );
      if (!routeId || !date || stayRouteById.has(routeId)) return;
      const dayMatch = String(row?.day || '').match(/Day\s+(\d+)/i);
      stayRouteById.set(routeId, {
        routeId,
        dayNumber: Number(row?.dayNumber || dayMatch?.[1] || 0),
        date,
        destination: String(row?.destination || '').trim(),
      });
    });
    const completeStayRoutes = Array.from(stayRouteById.values())
      .sort((a, b) => a.dayNumber - b.dayNumber || a.date.localeCompare(b.date))
      .map((route, index) => ({ ...route, dayNumber: route.dayNumber || index + 1 }));
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

    // The complete unfiltered read is consumed together with
    // hotelAvailability.sharedHotelInventory. Returning every option once per
    // recommendation group in `hotels` multiplies the JSON payload without
    // adding display information; the group-specific automatic selections are
    // already represented by hotelSelectionState. Keep one compact summary row
    // per route/stay in the legacy `hotels` field and leave the full selectable
    // inventory in the shared field used by the panes.
    const roomSelectionsForRow = (row: any): any[] | null => {
      const key = hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row);
      const direct = roomSelectionsByRouteGroup.get(key);
      const fallback = direct || Array.from(roomSelectionsByRouteGroup.values()).find((candidate: any) => {
        const rowRouteId = Number(row?.itineraryRouteId ?? row?.routeId ?? row?.itinerary_route_id ?? 0);
        const rowGroupType = Number(row?.groupType ?? row?.group_type ?? 0);
        const rowDate = rowStayDate(row);
        return Number(candidate?.routeId || 0) === rowRouteId &&
          Number(candidate?.groupType || 0) === rowGroupType &&
          toDateOnly(candidate?.routeDate) === rowDate &&
          Number(candidate?.hotelId || 0) === Number(row?.hotelId || row?.hotel_id || row?.canonicalHotelId || 0);
      });
      if (!fallback || !Array.isArray(fallback.roomTypeAssignments) || fallback.roomTypeAssignments.length === 0) return null;
      return fallback.roomTypeAssignments.map((roomTypeTitle: string, index: number) => ({
        room_number: index + 1,
        room_type_title: roomTypeTitle,
        room_qty: 1,
      }));
    };
    // Final response guard: the Day 0 display flag must survive every later
    // projection (room selections, pagination, and client-row normalization).
    // Apply the route-level persisted marker to every recommendation row for
    // the first hotel route. This is display metadata only; the payable row,
    // selection identity, room type, meal plan, and totals remain unchanged.
    const normalizedRowsWithEarlyArrival = normalizedRows.map((row: any) => {
      const routeId = Number(row?.itineraryRouteId || row?.itinerary_route_id || 0);
      const marker = earlyArrivalMarkerByRoute.get(routeId);
      if (!marker || isSpecialHotelPlanRow(row)) return row;
      return {
        ...row,
        ...this.earlyArrivalDisplayFields({
          early_checkin: 1,
          hotel_check_in_date: marker.itinerary_route_date,
          hotel_check_out_date: row.hotel_check_out_date,
          actual_guest_arrival_at: row.actual_guest_arrival_at || (plan as any).trip_start_date_and_time,
          early_checkin_note: marker.early_checkin_note,
        }),
      };
    });
    const normalizedRowsWithRoomSelections = normalizedRowsWithEarlyArrival.map((row: any) => {
      const roomSelections = roomSelectionsForRow(row);
      if (!roomSelections) return row;
      return {
        ...row,
        roomSelections,
        selection: row.selection && typeof row.selection === 'object'
          ? { ...row.selection, roomSelections }
          : row.selection,
      };
    });
    const roomSelectionsByResponseKey = new Map(
      normalizedRowsWithRoomSelections
        .filter((row: any) => Array.isArray(row?.roomSelections))
        .map((row: any) => [hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row), row.roomSelections]),
    );
    const authoritativeHotelSelectionState = buildHotelSelectionState({
      tabs,
      rows: normalizedRowsWithRoomSelections,
      requiredRoutes: searchableRoutes,
    });
    const synchronizedHotelTabs = synchronizeHotelTabTotals(
      tabs,
      authoritativeHotelSelectionState,
    );
    const responseRows = (unpaged
      ? this.buildClientStaySummaryRows(normalizedRowsWithRoomSelections)
      : paged).map((row: any) => {
        const roomSelections = roomSelectionsByResponseKey.get(hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row));
        if (!roomSelections) return row;
        return {
          ...row,
          roomSelections,
          selection: row.selection && typeof row.selection === 'object'
            ? { ...row.selection, roomSelections }
            : row.selection,
        };
      });
    const clientHotelRows = responseRows.map((row: any) => this.toClientHotelRow(row));

    return {
      quoteId,
      planId: plan.itinerary_plan_ID,
      mealPlanCode: String((plan as any).meal_plan_code || '').trim() || null,
      hotelRatesVisible: Boolean((plan as any).hotel_rates_visibility),
      showHotelMargins: String(process.env.SHOW_HOTEL_MARGINS || '').toLowerCase() === 'true',
      hotelTabs: synchronizedHotelTabs,
      hotelSelectionState: authoritativeHotelSelectionState,
      hotels: clientHotelRows,
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
        sharedHotelInventory,
        hasSupplierHotels: normalizedRows.some((row: any) => row.isBookable !== false && row.provider !== 'offline'),
        supplierHotelCount: normalizedRows.filter((row: any) => row.isBookable !== false && row.provider !== 'offline').length,
        placeholderRowCount: placeholderRows.length,
        totalSearchRoutes: searchableRouteIds.size,
        emptySearchRoutes,
        isPlaceholderOnly: false,
        message: hasUnavailableSelection
          ? 'A previously selected hotel is unavailable in the current snapshot. Review the selection or check availability again.'
          : snapshotMessage || (normalizedRows.length > 0
            ? 'Showing persisted hotel availability. Live suppliers are called only by Check Availability.'
            : 'No persisted hotel options are available yet. Click Check Availability to search.'),
        availabilityState,
        recommendationAlgorithm,
        recommendationGeneration,
        searchRunId,
        checkedAt: checkedAt.toISOString(),
        expiresAt,
        providerErrors: [],
        mealPlanAutoSelectionBlocks,
        emptyStayBlocks,
        stayRoutes: completeStayRoutes,
        offlineFetch: latestPayload?.offlineFetch,
        unavailableSelectionCount: remappedPlanRows.filter((row: any) => !isSpecialHotelPlanRow(row))
          .filter((row: any) => !normalizedRows.some((hotel: any) =>
            hotel.isSelected && Number(hotel.selectionId || 0) === Number(row.itinerary_plan_hotel_details_ID),
          )).length,
        earlyArrivalMarkers: earlyArrivalMarkers.map((marker: any) => ({
          routeId: Number(marker.itinerary_route_id || 0),
          groupType: Number(marker.group_type || 0),
          blockedFromDate: this.toDateOnly(marker.itinerary_route_date),
          location: String(marker.itinerary_route_location || '').trim(),
        })),
      } as any,
      recommendationAlgorithm,
      recommendationGeneration,
    };
  }

  async searchAndPersist(
    quoteId: string,
    requestType: 'CREATE' | 'CHECK_AVAILABILITY',
    createdBy = 0,
    resetSelections = false,
  ): Promise<{
    searchRunId: string;
    response: ItineraryHotelDetailsResponseDto;
    changeSummary: HotelAvailabilityChangeSummary;
  }> {
    // Check Availability is a fresh rebuild as well as an explicit supplier
    // refresh. Clear editable selections before reconciling the new snapshot
    // so a stale automatic offline row cannot survive after live options are
    // returned for the same stay. Explicit offline-only fetches use their
    // separate path and remain non-destructive.
    resetSelections = resetSelections || requestType === 'CHECK_AVAILABILITY';
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

      const cacheResetRequested = requestType === 'CREATE' || resetSelections;
      if (cacheResetRequested) {
        this.offlineHotelCatalog?.clearCache?.();
        await this.clearPersistedSearchCache(
          quoteId,
          Number(plan.itinerary_plan_ID),
          requestType === 'CREATE' ? 'FRESH_ITINERARY' : 'HOTEL_RESET_OR_EDIT',
        );
      }

      this.logger.log('[HOTEL_AVAILABILITY_START]', {
        quoteId,
        planId: plan.itinerary_plan_ID,
        searchRunId,
        requestType,
      });
      // Check Availability is an explicit refresh.  The supplier service keeps a
      // short-lived in-memory response cache for ordinary detail reads; using it
      // here would persist the old supplier-only response and hide newly merged
      // Offline/AxisRooms options from the UI.
      this.tboHotelDetails.clearCacheForQuote?.(quoteId);
      const logStage = (stage: string, stageStartedAt: number) => {
      const details = {
        quoteId,
        planId: plan.itinerary_plan_ID,
        searchRunId,
        stage,
        durationMs: Date.now() - stageStartedAt,
      };
      this.logger.log(`[HOTEL_AVAILABILITY_OUTER_STAGE] ${JSON.stringify(details)}`);
      HotelAvailabilityTimingLogger.log('HOTEL_AVAILABILITY_OUTER_STAGE', details);
      };
      const routes = await this.prisma.dvi_itinerary_route_details.findMany({
        where: { itinerary_plan_ID: plan.itinerary_plan_ID, deleted: 0 },
        orderBy: { itinerary_route_date: 'asc' },
      });
      const searchableRouteIds = this.getSearchableRouteIds(
        routes,
        Math.max(Number((plan as any).no_of_nights || 0), 0),
      );
      const liveSearchStartedAt = Date.now();
      const liveResponse = await this.tboHotelDetails.getHotelDetailsByQuoteIdFromTbo(
        quoteId,
        undefined,
        undefined,
        undefined,
        undefined,
        resetSelections,
        true,
        // A refresh must build recommendation packages only from the fresh
        // supplier result. Persisted selections are reconciled below, after
        // the new snapshot exists. Reading them here lets a stale selection
        // overwrite an incomplete package total immediately before that same
        // selection is deactivated by reconcileSelections().
        true,
      );
      logStage('supplier-and-provider-search', liveSearchStartedAt);
      // Supplier responses can contain a route id from the current itinerary
      // together with a stale stay date (this is especially easy to reproduce
      // after editing dates and then resetting availability).  Never persist
      // that mixed identity: the current route table is authoritative for the
      // stay dates used by the snapshot and by auto-selection.
      // The top-level `hotels` array contains recommendation candidates and
      // may already be reduced by category/meal rules. Reset persistence must
      // retain the complete group-neutral inventory returned by the supplier
      // search so every recommendation pane can display the same properties.
      const liveInventoryRows = Array.isArray((liveResponse as any)?.hotelAvailability?.sharedHotelInventory)
        ? (liveResponse as any).hotelAvailability.sharedHotelInventory
        : (Array.isArray(liveResponse.hotels) ? liveResponse.hotels : []);
      const currentDatedLiveRows = this.normalizeRowsToCurrentRouteDates(
        liveInventoryRows,
        routes,
      );
      let sourceRows = this.filterSearchableLiveRows(
        currentDatedLiveRows,
        searchableRouteIds,
      );
      sourceRows = await this.applyAuthoritativeAxisRoomsRates(sourceRows, plan);
      let authoritativeRecommendationRows = this.filterSearchableLiveRows(
        this.normalizeRowsToCurrentRouteDates(
          this.extractAuthoritativeRecommendationRows(liveResponse),
          routes,
        ),
        searchableRouteIds,
      );
      authoritativeRecommendationRows = await this.applyAuthoritativeAxisRoomsRates(
        authoritativeRecommendationRows,
        plan,
      );
      const hasUsableLiveInventory = sourceRows.some((row: any) => {
        const name = String(row?.hotelName || row?.hotel_name || '').trim().toLowerCase();
        return name &&
          name !== 'no hotel available' &&
          name !== 'no hotels available' &&
          name !== 'availability marker' &&
          name !== 'no availability';
      });
      if (!hasUsableLiveInventory && requestType !== 'CHECK_AVAILABILITY') {
        throw new ServiceUnavailableException({
          message: 'Hotel availability returned no usable inventory; the previous snapshot was retained.',
          code: 'HOTEL_AVAILABILITY_EMPTY',
          planId: plan.itinerary_plan_ID,
          quoteId,
          searchRunId,
          previousSnapshotRetained: true,
        });
      }
      // CREATE, RESET, and CHECK AVAILABILITY all need the same complete
      // inventory snapshot. Live rows win automatically; offline rows are used
      // only for a stay where no live selectable row exists.
      const noOfNights = Math.max(Number((plan as any).no_of_nights || 0), 0);
      const offlineFetchStartedAt = Date.now();
      const offlineByRoute = await this.offlineHotelCatalog.fetchOfflineHotelsForRoutes(
        routes,
        noOfNights,
        String((plan as any).guest_nationality || 'IN').trim().toUpperCase() || 'IN',
        Math.max(Number((plan as any).preferred_room_count || 1), 1),
        Math.max(Number((plan as any).total_adult || 0), 0),
        Math.max(Number((plan as any).total_children || 0), 0),
        [],
        String((plan as any).meal_plan_code || ''),
        [],
      );
      logStage('offline-fetch-in-reset-coordinator', offlineFetchStartedAt);
      const recommendationGroupTypes = await this.getRecommendationGroupTypes(plan.itinerary_plan_ID, [], sourceRows);
      const offlineRows = this.materializeOfflineRows(offlineByRoute, routes, recommendationGroupTypes);
      // Apply the same route-date authority to every provider, including the
      // offline catalog.  This keeps a mixed supplier response from becoming
      // a mixed-date cache row after an itinerary edit.
      let rows = this.normalizeRowsToCurrentRouteDates(
        [...sourceRows, ...offlineRows, ...authoritativeRecommendationRows],
        routes,
      );
      if (rows.length === 0 && requestType !== 'CHECK_AVAILABILITY') {
        throw new ServiceUnavailableException({
          message: 'Hotel availability returned no options; the previous snapshot was retained.',
          code: 'HOTEL_AVAILABILITY_EMPTY',
          planId: plan.itinerary_plan_ID,
          quoteId,
          searchRunId,
          previousSnapshotRetained: true,
        });
      }
      rows = this.applyCompleteStayAvailability(rows, routes, noOfNights);
      rows = this.dedupeRows(rows);
      const storageRows = this.coalesceRowsForCache(rows);
      const recommendationTabs = Array.isArray((liveResponse as any).hotelTabs)
        ? (liveResponse as any).hotelTabs
        : [];
      const cacheRows = storageRows.length > 0
        ? storageRows
        : [this.buildEmptySnapshotRow(plan, quoteId, searchRunId, checkedAt)];
      const persistenceStartedAt = Date.now();
      // Reset persists the complete supplier/offline snapshot and reconciles
      // selections in the same transaction.  A multi-stay itinerary can
      // legitimately exceed Prisma's 5s interactive-transaction default
      // while inserting the detail rows; allowing the default to expire
      // leaves the cache empty and the UI reports "No hotel groups available".
      const changeSummary = await this.prisma.$transaction(async (tx) => {
        const txCache = (tx as any).dvi_itinerary_hotel_search_cache;
        if (resetSelections) {
          await this.clearEditableHotelSelections(tx, plan.itinerary_plan_ID);
        }
        await txCache.deleteMany({
          where: { quote_id: quoteId, plan_id: plan.itinerary_plan_ID },
        });
        await txCache.createMany({
          data: cacheRows.map((row: any, index: number) => ({
            quote_id: quoteId,
            plan_id: plan.itinerary_plan_ID,
            route_id: Number(row.itineraryRouteId || row.routeId || row.route_id || 0),
            group_type: Number(row.groupType || row.group_type || 0),
            hotel_code: String(row.hotelCode || row.hotel_code || row.hotelId || '0'),
            provider: String(row.provider || row.hotel_provider || 'external').toLowerCase(),
            hotel_name: String(row.hotelName || row.hotel_name || 'Hotel'),
            // Prisma rejects NaN/undefined for required numeric fields. Some
            // supplier/offline rows do not carry a category/rating, so always
            // persist a finite fallback instead of allowing one malformed row
            // to abort the entire reset and replace the snapshot with EMPTY.
            rating: Number.isFinite(Number(row.category ?? row.rating))
              ? Number(row.category ?? row.rating)
              : 0,
            // `price` is the catalog/display amount stored with the snapshot.
            // Prefer the supplier stay total over a derived/gross field that
            // may include a margin. The selected payable total is stored on
            // the plan selection record and hydrated separately.
            price: Number.isFinite(Number(row.totalStayPrice ?? row.totalPrice ?? row.totalHotelCost ?? row.pricePerNight ?? row.price))
              ? Number(row.totalStayPrice ?? row.totalPrice ?? row.totalHotelCost ?? row.pricePerNight ?? row.price)
              : 0,
            room_type: String(row.roomType || row.room_type || '').slice(0, 255) || null,
            meal_plan: String(row.mealPlan || row.meal_plan || '').slice(0, 100) || null,
            search_reference: row.searchReference || row.search_reference ? String(row.searchReference || row.search_reference) : null,
            full_payload: row.full_payload && this.parsePayload(row.full_payload)?.availabilityMarker === EMPTY_AVAILABILITY_MARKER
              ? String(row.full_payload)
              : JSON.stringify({
                  ...row,
                  optionKey: this.optionKey(row),
                  searchRunId,
                  ...(recommendationTabs.length > 0 ? { recommendationTabs } : {}),
                }),
            check_in_date: this.toDate(row.date || row.checkInDate || row.check_in_date || checkedAt),
            check_out_date: row.checkOutDate || row.check_out_date
              ? this.toDate(row.checkOutDate || row.check_out_date)
              : this.addDays(this.toDate(row.date || row.checkInDate || row.check_in_date || checkedAt), Number(row.numberOfNights || 1)),
            sort_rank: index,
            synced_at: checkedAt,
            status: 1,
            deleted: 0,
            recommendation_algorithm_version: resolveHotelRecommendationAlgorithm(),
            recommendation_search_run_id: searchRunId,
            recommendation_generated_at: checkedAt,
          })),
        });

        return this.reconcileSelections(
          tx,
          plan.itinerary_plan_ID,
          rows,
          searchRunId,
          createdBy,
          false,
          undefined,
          this.getPlanMealPlanCode(plan),
          this.getPlanMealPlanFlags(plan),
        );
      }, { maxWait: 15000, timeout: 120000 });
      logStage('snapshot-persistence-and-selection-reconciliation', persistenceStartedAt);

      const readStartedAt = Date.now();
      const response = await this.readPersisted(quoteId, { page: 1, pageSize: 0 });
      logStage('read-persisted-response', readStartedAt);
      if (Array.isArray((response as any)?.hotelAvailability?.sharedHotelInventory)) {
        (response as any).hotelAvailability.sharedHotelInventory =
          (response as any).hotelAvailability.sharedHotelInventory.map((row: any) => ({
            ...row,
            rateOptions: this.canonicalizeRateOptions(row, row.rateOptions || []),
          }));
      }
      const hasPartialAvailability = Number(liveResponse.hotelAvailability?.emptySearchRoutes || 0) > 0 ||
        (Array.isArray(liveResponse.hotelAvailability?.providerErrors) && liveResponse.hotelAvailability.providerErrors.length > 0);
      (response as any).hotelAvailability = {
        ...(response as any).hotelAvailability,
        availabilityState: hasPartialAvailability ? 'PARTIAL' : 'FRESH',
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
      if (error instanceof ConflictException) {
        throw error;
      }

      // Reset is explicitly a fresh-itinerary operation. If a supplier or
      // provider dependency fails during that operation, retaining the old
      // selected rows recreates the exact misleading "previously selected
      // hotel unavailable" state the reset button is intended to remove.
      // Clear the editable selections anyway and persist an empty snapshot so
      // the UI shows the real partial-search state and all stay rows remain
      // visible after reload.
      if (resetSelections) {
        try {
          await this.prisma.$transaction(async (tx) => {
            await this.clearEditableHotelSelections(tx, plan.itinerary_plan_ID);
            const txCache = (tx as any).dvi_itinerary_hotel_search_cache;
            await txCache.deleteMany({
              where: { quote_id: quoteId, plan_id: plan.itinerary_plan_ID },
            });
            await txCache.create({
              data: this.buildEmptySnapshotRow(plan, quoteId, searchRunId, checkedAt),
            });
          });
          const response = await this.readPersisted(quoteId, { page: 1, pageSize: 0 });
          (response as any).hotelAvailability = {
            ...(response as any).hotelAvailability,
            availabilityState: 'PARTIAL',
            searchRunId,
            checkedAt: checkedAt.toISOString(),
            providerErrors: [],
          };
          this.logger.warn('[HOTEL_AVAILABILITY_RESET_PARTIAL]', {
            quoteId,
            planId: plan.itinerary_plan_ID,
            searchRunId,
            message: String((error as any)?.message || error || 'Live hotel search failed'),
          });
          return {
            searchRunId,
            response,
            changeSummary: { hasChanges: false, totalChanges: 0, changes: [] },
          };
        } catch (resetError) {
          this.logger.error('[HOTEL_AVAILABILITY_RESET_FAILED_TO_CLEAR]', String((resetError as any)?.message || resetError));
        }
      }
      if (error instanceof BadRequestException) {
        throw error;
      }
      if (error instanceof ServiceUnavailableException) {
        const response = error.getResponse();
        if (response && typeof response === 'object' && (response as any).previousSnapshotRetained === true) {
          throw error;
        }
      }
      throw new ServiceUnavailableException({
        message: 'Hotel availability refresh failed. The previous saved hotel snapshot was retained.',
        code: 'HOTEL_AVAILABILITY_REFRESH_FAILED',
        planId: plan.itinerary_plan_ID,
        quoteId,
        searchRunId,
        previousSnapshotRetained: true,
        cause: String((error as any)?.message || error || 'Hotel availability failed'),
      });
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

  /**
   * Add a supplier-scoped refresh to the current durable snapshot.  A selected
   * hotel refresh must participate in the same snapshot used by selection-cost
   * preview and final selection; returning fresh rows only to the browser would
   * leave those API validations reading stale availability.
   */
  async mergeSelectedHotelRates(
    quoteId: string,
    routeId: number,
    provider: string,
    hotelCode: string,
    hotels: any[],
  ): Promise<void> {
    const plan = await this.findPlan(quoteId);
    const normalizedRouteId = Number(routeId || 0);
    const normalizedProvider = String(provider || '').trim().toLowerCase() === 'ax'
      ? 'axisrooms'
      : String(provider || '').trim().toLowerCase();
    const normalizedHotelCode = String(hotelCode || '').trim();
    const rows = Array.isArray(hotels)
      ? hotels
        .map((row: any) => normalizeSupplierRateIdentity(row))
        .filter((row: any) => Number(row?.itineraryRouteId || row?.routeId || row?.route_id || 0) === normalizedRouteId)
      : [];
    if (normalizedRouteId <= 0 || !normalizedProvider || !normalizedHotelCode || rows.length === 0) {
      return;
    }

    const cache = (this.prisma as any).dvi_itinerary_hotel_search_cache;
    const latest = await cache.findFirst({
      where: { quote_id: quoteId, plan_id: plan.itinerary_plan_ID, deleted: 0, status: 1 },
      orderBy: [{ synced_at: 'desc' }, { id: 'desc' }],
      select: { synced_at: true },
    });
    const syncedAt = latest?.synced_at || new Date();
    const searchRunId = `selected-hotel-${plan.itinerary_plan_ID}-${randomUUID()}`;
    const rateOptions = rows.flatMap((row: any) =>
      Array.isArray(row?.rateOptions) && row.rateOptions.length > 0 ? row.rateOptions : [row],
    ).map((option: any) => normalizeSupplierRateIdentity(option));
    const row = normalizeSupplierRateIdentity({ ...rows[0], rateOptions });
    const numericRating = Number(row.rating);
    const categoryRating = Number(String(row.category || '').match(/\d+(?:\.\d+)?/)?.[0] || 0);
    const rating = Number.isFinite(numericRating) ? numericRating : categoryRating;

    await this.prisma.$transaction(async (tx) => {
      const txCache = (tx as any).dvi_itinerary_hotel_search_cache;
      const existingRows = await txCache.findMany({
        where: {
          quote_id: quoteId,
          route_id: normalizedRouteId,
          provider: normalizedProvider,
        },
        select: { hotel_code: true, full_payload: true },
      });
      const requestedCode = normalizedHotelCode.toLowerCase();
      const matchingExisting = existingRows.find((existing: any) => {
        const payload = this.parsePayload(existing.full_payload) || {};
        const aliases = [
          existing.hotel_code,
          payload.hotelCode,
          payload.providerHotelCode,
          payload.provider_hotel_code,
          payload.hotelId,
          payload.canonicalHotelId,
        ].map((value) => String(value ?? '').trim().toLowerCase()).filter(Boolean);
        return aliases.includes(requestedCode) || aliases.some((alias) =>
          Number(alias) > 0 && Number(alias) === Number(requestedCode));
      });
      // Older snapshots keyed STAAH by the canonical numeric hotel id while
      // the supplier refresh identifies the same property by provider code.
      // Keep that existing key when replacing the row; otherwise the upsert
      // would look up one unique key and attempt to create another.
      const persistedHotelCode = String(
        matchingExisting?.hotel_code ||
        row.hotelCode ||
        row.providerHotelCode ||
        row.hotel_code ||
        normalizedHotelCode,
      ).trim();
      const persistedGroupType = Number(row.groupType || row.group_type || 1);
      // The cache key is enforced by the database across all snapshot rows,
      // including rows that are not currently active. Replacing rows by
      // payload matching (the old implementation) can miss a stale row whose
      // hotel_code differs from the normalized supplier code, then fail with
      // P2002 on create. Upsert the database key directly so refresh is
      // idempotent and safe when the same preview is retried.
      const cacheData = {
          quote_id: quoteId,
          plan_id: plan.itinerary_plan_ID,
          route_id: normalizedRouteId,
          group_type: persistedGroupType,
          hotel_code: persistedHotelCode,
          provider: normalizedProvider,
          hotel_name: String(row.hotelName || row.hotel_name || 'Hotel'),
          rating: Number.isFinite(rating) ? rating : 0,
          price: Number(row.totalStayPrice ?? row.totalPrice ?? row.totalHotelCost ?? row.pricePerNight ?? row.price ?? 0),
          room_type: String(row.roomType || row.roomTypeName || row.room_type || '').slice(0, 255) || null,
          meal_plan: String(row.mealPlan || row.mealPlanCode || row.meal_plan || '').slice(0, 100) || null,
          search_reference: row.searchReference || row.search_reference ? String(row.searchReference || row.search_reference) : null,
          full_payload: JSON.stringify({ ...row, itineraryRouteId: normalizedRouteId, routeId: normalizedRouteId, provider: normalizedProvider, hotelCode: normalizedHotelCode, optionKey: this.optionKey(row), searchRunId }),
          check_in_date: this.toDate(row.date || row.checkInDate || row.check_in_date || new Date()),
          check_out_date: row.checkOutDate || row.check_out_date
            ? this.toDate(row.checkOutDate || row.check_out_date)
            : this.addDays(this.toDate(row.date || row.checkInDate || row.check_in_date || new Date()), Number(row.numberOfNights || 1)),
          sort_rank: 100000,
          synced_at: syncedAt,
          status: 1,
          deleted: 0,
          recommendation_algorithm_version: resolveHotelRecommendationAlgorithm(),
          recommendation_search_run_id: searchRunId,
          recommendation_generated_at: syncedAt,
      };
      await txCache.upsert({
        where: {
          quote_id_route_id_group_type_hotel_code_provider: {
            quote_id: quoteId,
            route_id: normalizedRouteId,
            group_type: persistedGroupType,
            hotel_code: persistedHotelCode,
            provider: normalizedProvider,
          },
        },
        create: cacheData,
        update: cacheData,
      });
    });
  }

  private async findPlan(quoteId: string): Promise<any> {
    const plan = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_quote_ID: String(quoteId).trim(), deleted: 0 },
    });
    if (!plan) throw new BadRequestException('Itinerary not found');
    return plan;
  }

  private async clearPersistedSearchCache(quoteId: string, planId: number, reason: string): Promise<void> {
    const cache = (this.prisma as any).dvi_itinerary_hotel_search_cache;
    if (!cache?.deleteMany) return;
    const result = await cache.deleteMany({
      where: { quote_id: String(quoteId).trim(), plan_id: Number(planId) },
    });
    this.logger.log('[HOTEL_AVAILABILITY_CACHE_CLEARED]', {
      quoteId,
      planId,
      reason,
      deletedRows: Number(result?.count || 0),
    });
  }

  private getSearchableRouteIds(routes: any[], noOfNights: number): Set<number> {
    return new Set(
      resolveHotelRequiredRoutes(routes || [], noOfNights)
        .map((route: any) => Number(route?.itinerary_route_ID || 0))
        .filter((routeId: number) => routeId > 0),
    );
  }

  private filterSearchableLiveRows(rows: any[], searchableRouteIds: Set<number>): any[] {
    if (searchableRouteIds.size === 0) return rows;
    return rows.filter((row: any) => {
      const routeId = Number(row?.itineraryRouteId || row?.routeId || row?.route_id || 0);
      return routeId > 0 && searchableRouteIds.has(routeId);
    });
  }

  async resetAndPersist(
    quoteId: string,
    createdBy = 0,
  ): Promise<{
    searchRunId: string;
    response: ItineraryHotelDetailsResponseDto;
    changeSummary: HotelAvailabilityChangeSummary;
  }> {
    // Reset is explicitly requested after admin pricebook edits. Offline
    // offers contain prices and are cached in-process, so retaining that cache
    // would persist the previous rate into the new snapshot even though the
    // database already contains the edited date-specific rate.
    this.offlineHotelCatalog?.clearCache?.();
    const result = await this.searchAndPersist(quoteId, 'CREATE', createdBy, true);
    const hotelRows = Array.isArray((result.response as any)?.hotels)
      ? (result.response as any).hotels
      : [];

    // Reset normally performs the fresh CREATE search above. If that search
    // leaves a persisted snapshot with no hotel rows, immediately retry via
    // the explicit live-availability path. This handles transient supplier
    // responses without making React invent hotel rows or totals from an
    // empty snapshot.
    if (hotelRows.length === 0) {
      this.logger.warn('[HOTEL_AVAILABILITY_RESET_EMPTY_FALLBACK]', {
        quoteId,
        initialSearchRunId: result.searchRunId,
        message: 'Reset persisted zero hotel rows; retrying live availability rebuild.',
      });
      return this.searchAndPersist(quoteId, 'CHECK_AVAILABILITY', createdBy, true);
    }

    return result;
  }

  /**
   * Reset is a fresh-itinerary operation: remove every editable selection
   * before the new live snapshot is reconciled.  The update is deliberately
   * scoped to hotel_required=1 so previous-night billing markers remain
   * intact, while the verification prevents a stale selection from being
   * projected back into the reset response as "unavailable".
   */
  private async clearEditableHotelSelections(tx: any, planId: number): Promise<void> {
    const resetData = { status: 0, deleted: 1, updatedon: new Date() };
    const selectionWhere = {
      itinerary_plan_id: Number(planId),
      hotel_required: 1,
      status: 1,
      deleted: 0,
    };

    await tx.dvi_itinerary_plan_hotel_room_details.updateMany({
      where: { itinerary_plan_id: Number(planId), status: 1, deleted: 0 },
      data: resetData,
    });
    await tx.dvi_itinerary_plan_hotel_room_amenities.updateMany({
      where: { itinerary_plan_id: Number(planId), status: 1, deleted: 0 },
      data: resetData,
    });
    await tx.dvi_itinerary_plan_hotel_details.updateMany({
      where: selectionWhere,
      data: resetData,
    });

    const remaining = await tx.dvi_itinerary_plan_hotel_details.findMany({
      where: selectionWhere,
      select: { itinerary_plan_hotel_details_ID: true },
    });
    if (remaining.length > 0) {
      throw new Error(`Hotel reset left ${remaining.length} editable selection(s) active`);
    }
  }

  async fetchOfflineForStay(
    quoteId: string,
    routeId?: number,
    createdBy = 0,
  ): Promise<{
    response: ItineraryHotelDetailsResponseDto;
    changeSummary: HotelAvailabilityChangeSummary;
  }> {
    const plan = await this.findPlan(quoteId);
    const routes = await this.prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: plan.itinerary_plan_ID, deleted: 0 },
      orderBy: { itinerary_route_date: 'asc' },
    });
    const noOfNights = Math.max(Number((plan as any).no_of_nights || 0), 0);
    const requestedRoutes = routeId
      ? this.getContinuousStayRoutes(routes, Number(routeId), noOfNights)
      : routes.filter((route: any, index: number) => !(index === routes.length - 1 && index >= noOfNights));
    const requestedRouteIds = new Set(requestedRoutes.map((route: any) => Number(route.itinerary_route_ID || 0)));
    if (requestedRouteIds.size === 0) throw new BadRequestException('Hotel stay route was not found');

    const roomCount = Math.max(Number((plan as any).preferred_room_count || 1), 1);
    const adultCount = Math.max(Number((plan as any).total_adult || 0), 0);
    const childCount = Math.max(Number((plan as any).total_children || 0), 0);
    const childAges = childCount > 0
      ? (await this.prisma.dvi_itinerary_traveller_details.findMany({
          where: { itinerary_plan_ID: plan.itinerary_plan_ID, traveller_type: 2, deleted: 0 },
          orderBy: { traveller_details_ID: 'asc' },
        })).map((traveller: any) => Math.trunc(Number(traveller.traveller_age)))
        .filter((age: number) => Number.isFinite(age) && age >= 0 && age <= 11)
      : [];
    const guestNationality = String((plan as any).guest_nationality || 'IN').trim().toUpperCase() || 'IN';
    const offlineByRoute = await this.offlineHotelCatalog.fetchOfflineHotelsForRoutes(
      requestedRoutes,
      Math.max(requestedRoutes.length, 1),
      guestNationality,
      roomCount,
      adultCount,
      childCount,
      childAges,
      String((plan as any).meal_plan_code || ''),
      [],
    );

    const cache = (this.prisma as any).dvi_itinerary_hotel_search_cache;
    const latest = await cache.findFirst({
      where: { quote_id: quoteId, plan_id: plan.itinerary_plan_ID, deleted: 0, status: 1 },
      orderBy: [{ synced_at: 'desc' }, { id: 'desc' }],
      select: { synced_at: true },
    });
    // A stay-level offline search is also valid before the first live snapshot.
    // This is the per-day recovery path shown when live hotels are unavailable;
    // it must not force the user to call the supplier search first. When there
    // is no snapshot, the existing persisted plan selections are reconciled by
    // readPersisted/reconcileSelections after the offline rows are stored.
    const currentCacheRows = latest?.synced_at
      ? await cache.findMany({
          where: { quote_id: quoteId, plan_id: plan.itinerary_plan_ID, deleted: 0, status: 1, synced_at: latest.synced_at },
          orderBy: [{ sort_rank: 'asc' }, { id: 'asc' }],
        })
      : [];
    const existingRows = currentCacheRows.map((row: any) => this.parsePayload(row.full_payload)).filter(Boolean);
    const preservedRows = existingRows.filter((row: any) => !(
      requestedRouteIds.has(Number(row.itineraryRouteId || row.routeId || 0)) &&
      String(row.provider || '').trim().toLowerCase() === 'offline'
    ));
    const recommendationGroupTypes = await this.getRecommendationGroupTypes(plan.itinerary_plan_ID);
    const offlineRows = this.materializeOfflineRows(offlineByRoute, requestedRoutes, recommendationGroupTypes);
    const offlineNoResultRouteIds = requestedRoutes
      .filter((route: any) => (offlineByRoute.get(Number(route.itinerary_route_ID || 0)) || []).length === 0)
      .map((route: any) => Number(route.itinerary_route_ID || 0))
      .filter((id: number) => id > 0);
    const offlineFetch = {
      requestedRouteIds: Array.from(requestedRouteIds),
      fetchedHotelCount: offlineRows.length,
      noResultRouteIds: offlineNoResultRouteIds,
    };
    const mergedRows = this.coalesceRowsForCache(this.dedupeRows([...preservedRows, ...offlineRows]));
    const searchRunId = `offline-${plan.itinerary_plan_ID}-${randomUUID()}`;
    const checkedAt = new Date();

    const changeSummary = await this.prisma.$transaction(async (tx) => {
      const txCache = (tx as any).dvi_itinerary_hotel_search_cache;
      await txCache.deleteMany({ where: { quote_id: quoteId, plan_id: plan.itinerary_plan_ID } });
      await txCache.createMany({
        data: mergedRows.map((row: any, index: number) => ({
          quote_id: quoteId,
          plan_id: plan.itinerary_plan_ID,
          route_id: Number(row.itineraryRouteId || row.routeId || 0),
          group_type: Number(row.groupType || 0),
          hotel_code: String(row.hotelCode || row.hotelId || '0'),
          provider: String(row.provider || 'external').toLowerCase(),
          hotel_name: String(row.hotelName || 'Hotel'),
          rating: Number(row.category || 0),
          price: Number(row.totalHotelCost || row.pricePerNight || 0),
          room_type: String(row.roomType || '').slice(0, 255) || null,
          meal_plan: String(row.mealPlan || '').slice(0, 100) || null,
          search_reference: row.searchReference ? String(row.searchReference) : null,
          full_payload: JSON.stringify({ ...row, optionKey: this.optionKey(row), searchRunId, offlineFetch }),
          check_in_date: this.toDate(row.date || row.checkInDate),
          check_out_date: row.checkOutDate
            ? this.toDate(row.checkOutDate)
            : this.addDays(this.toDate(row.date || row.checkInDate), Number(row.numberOfNights || 1)),
          sort_rank: index,
          synced_at: checkedAt,
          status: 1,
          deleted: 0,
          recommendation_algorithm_version: resolveHotelRecommendationAlgorithm(),
          recommendation_search_run_id: searchRunId,
          recommendation_generated_at: checkedAt,
        })),
      });
      return this.reconcileSelections(
        tx,
        plan.itinerary_plan_ID,
        mergedRows,
        searchRunId,
        createdBy,
        true,
        requestedRouteIds,
        this.getPlanMealPlanCode(plan),
        this.getPlanMealPlanFlags(plan),
      );
    });

    const response = await this.readPersisted(quoteId, { page: 1, pageSize: 0 });
    (response as any).hotelAvailability = {
      ...(response as any).hotelAvailability,
      availabilityState: 'FRESH',
      searchRunId,
      checkedAt: checkedAt.toISOString(),
      offlineFetch,
    };
    return { response, changeSummary };
  }

  private getContinuousStayRoutes(routes: any[], routeId: number, noOfNights: number): any[] {
    const eligibleRoutes = (routes || []).filter((route: any, index: number) =>
      !(index === routes.length - 1 && index >= noOfNights),
    );
    const targetIndex = eligibleRoutes.findIndex((route: any) => Number(route.itinerary_route_ID || 0) === routeId);
    if (targetIndex < 0) return [];
    const destinationOf = (route: any) => String(route.next_visiting_location || route.location_name || '').trim();
    const dateOf = (route: any) => new Date(route.itinerary_route_date).getTime();
    let start = targetIndex;
    let end = targetIndex;
    while (start > 0 && destinationOf(eligibleRoutes[start - 1]) === destinationOf(eligibleRoutes[targetIndex]) &&
      dateOf(eligibleRoutes[start]) - dateOf(eligibleRoutes[start - 1]) === 24 * 60 * 60 * 1000) start -= 1;
    while (end < eligibleRoutes.length - 1 && destinationOf(eligibleRoutes[end + 1]) === destinationOf(eligibleRoutes[targetIndex]) &&
      dateOf(eligibleRoutes[end + 1]) - dateOf(eligibleRoutes[end]) === 24 * 60 * 60 * 1000) end += 1;
    return eligibleRoutes.slice(start, end + 1);
  }

  private materializeOfflineRows(
    offlineByRoute: Map<number, any[]>,
    routes: any[],
    recommendationGroupTypes: number[] = [1],
  ): any[] {
    const groupTypes = this.normalizeRecommendationGroupTypes(recommendationGroupTypes);
    return (routes || []).flatMap((route: any, routeIndex: number) => {
      const routeId = Number(route?.itinerary_route_ID || 0);
      if (routeId <= 0) return [];
      const routeDate = route?.itinerary_route_date instanceof Date
        ? route.itinerary_route_date.toISOString().slice(0, 10)
        : String(route?.itinerary_route_date || '').slice(0, 10);
      const destination = String(route?.next_visiting_location || route?.location_name || '').trim();
      return (offlineByRoute.get(routeId) || []).flatMap((row: any) => {
        const isOffline = String(row?.provider || row?.hotel_provider || '').trim().toLowerCase() === 'offline';
        const nightlyRates = Array.isArray(row?.nightlyRates) ? row.nightlyRates : [];
        const routeNight = isOffline
          ? nightlyRates.find((night: any) => String(night?.date || '').slice(0, 10) === routeDate)
          : null;
        const roomCount = Math.max(Number(row?.roomCount || row?.noOfRooms || row?.total_no_of_rooms || 1), 1);
        const routeFields = routeNight
          ? {
              // Keep totalStayPrice/price as the full continuous-stay offer
              // total for recommendation ranking. These fields are the
              // route-night values consumed by a selected itinerary row.
              basePricePerNight: Number((Number(routeNight.baseAmount || 0) / roomCount).toFixed(2)),
              baseTotalPrice: Number(routeNight.baseAmount || 0),
              pricePerNight: Number(routeNight.sellAmount || 0),
              hotelMarginAmount: Number(routeNight.marginAmount || 0),
              offlineRouteNightApplied: true,
            }
          : {};
        return groupTypes.map((groupType) => ({
          ...row,
          ...routeFields,
          groupType,
          itineraryRouteId: routeId,
          routeId,
          itineraryRouteDate: routeDate,
          date: routeDate,
          day: row.day || `Day ${routeIndex + 1} | ${routeDate}`,
          destination: row.destination || destination,
        }));
      });
    });
  }

  private extractRecommendationGroupTypes(values: unknown[]): number[] {
    return Array.from(new Set((values || [])
      .map((value: any) => Number(value?.group_type ?? value?.groupType ?? value))
      .filter((value: number) => Number.isInteger(value) && value >= 1 && value <= 4)))
      .sort((a, b) => a - b);
  }

  private normalizeRecommendationGroupTypes(values: unknown[], fallbackValues: unknown[] = []): number[] {
    const groups = this.extractRecommendationGroupTypes(values);
    if (groups.length > 0) return groups;
    const fallbackGroups = this.extractRecommendationGroupTypes(fallbackValues);
    return fallbackGroups.length > 0 ? fallbackGroups : [1];
  }

  private async getRecommendationGroupTypes(planId: number, planRows: any[] = [], fallbackRows: any[] = []): Promise<number[]> {
    const persistedRows = planRows.length > 0
      ? planRows
      : await (this.prisma as any).dvi_itinerary_plan_hotel_details.findMany({
          where: { itinerary_plan_id: Number(planId || 0), deleted: 0, status: 1 },
          select: { group_type: true },
        }).catch(() => []);
    // An empty persisted selection set is not Group 1. Preserve that absence
    // so reset/create can derive all active package groups from the fresh
    // response. Previously normalizeRecommendationGroupTypes([]) returned
    // [1], causing offline inventory (and therefore auto-selection) to be
    // materialized only for Recommended #1.
    const persistedGroups = this.extractRecommendationGroupTypes(persistedRows);
    return planRows.length > 0 || persistedGroups.length > 0
      ? persistedGroups
      : this.normalizeRecommendationGroupTypes([], fallbackRows.length > 0 ? fallbackRows : [1, 2, 3, 4]);
  }

  private async sanitizeLegacyResponse(
    response: ItineraryHotelDetailsResponseDto,
    plan: any,
  ): Promise<ItineraryHotelDetailsResponseDto> {
    const hotels = (Array.isArray(response?.hotels) ? response.hotels : [])
      .filter((row: any) => {
        const name = String(row?.hotelName || '').trim().toLowerCase();
        if (row?.isPlaceholder === true || row?.synthetic === true) return false;
        if (name.includes('previously selected hotel') || name === 'no hotels available') return false;
        return Number(row?.itineraryRouteId || row?.routeId || 0) > 0 &&
          Boolean(String(row?.date || row?.checkInDate || '').trim());
        })
      .map((row: any) => this.toClientHotelRow(row));
    const availability = (response as any)?.hotelAvailability || {};
    const routeDetailsModel = (this.prisma as any).dvi_itinerary_route_details;
    const currentRoutes = routeDetailsModel?.findMany
      ? await routeDetailsModel.findMany({
          where: { itinerary_plan_ID: Number(plan?.itinerary_plan_ID || 0), deleted: 0 },
          orderBy: { itinerary_route_date: 'asc' },
          select: {
            itinerary_route_ID: true,
            itinerary_route_date: true,
            next_visiting_location: true,
            location_name: true,
          },
        })
      : [];
    const noOfNights = Math.max(Number(plan?.no_of_nights || 0), 0);
    const searchableRoutes = resolveHotelRequiredRoutes(currentRoutes, noOfNights);
    const toDateOnly = (value: unknown): string => {
      const raw = String(value || '').trim();
      if (!raw) return '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
      const parsed = value instanceof Date ? value : new Date(raw);
      if (Number.isNaN(parsed.getTime())) return '';
      const businessDate = new Date(parsed.getTime() + 330 * 60 * 1000);
      return businessDate.toISOString().slice(0, 10);
    };
    const stayRoutes = searchableRoutes
      .map((route: any, index: number) => {
        const routeId = Number(route?.itinerary_route_ID || 0);
        const date = toDateOnly(route?.itinerary_route_date);
        if (!routeId || !date) return null;
        return {
          routeId,
          dayNumber: index + 1,
          date,
          destination: String(route?.next_visiting_location || route?.location_name || '').trim(),
        };
      })
      .filter((route: any): route is { routeId: number; dayNumber: number; date: string; destination: string } => Boolean(route));
    const hotelRouteIds = new Set(
      hotels.map((row: any) => Number(row?.itineraryRouteId || row?.routeId || 0)).filter((id: number) => id > 0),
    );
    const emptyStayBlocks = stayRoutes
      .filter((route) => !hotelRouteIds.has(route.routeId))
      .map((route) => ({
        routeIds: [route.routeId],
        dayNumbers: [route.dayNumber],
        dates: [route.date],
        destination: route.destination,
      }));
    const supplierHotels = hotels.filter((row: any) => {
      const provider = String(row?.provider || row?.hotel_provider || '').trim().toLowerCase();
      return row?.isBookable !== false && provider !== 'offline' && provider !== 'external';
    });
    return {
      ...response,
      hotelSelectionState: buildHotelSelectionState({
        tabs: response.hotelTabs || [],
        rows: hotels,
        requiredRoutes: searchableRoutes,
      }),
      hotels,
      totalRoomCount: hotels.length,
      hotelAvailability: {
        ...availability,
        hasSupplierHotels: availability.hasSupplierHotels ?? supplierHotels.length > 0,
        supplierHotelCount: availability.supplierHotelCount ?? supplierHotels.length,
        placeholderRowCount: 0,
        totalSearchRoutes: stayRoutes.length,
        emptySearchRoutes: emptyStayBlocks.length,
        isPlaceholderOnly: false,
        availabilityState: availability.availabilityState || 'NOT_CHECKED',
        stayRoutes,
        emptyStayBlocks,
        message: hotels.length > 0
          ? 'Showing persisted hotel availability. Live suppliers are called only by Check Availability.'
          : 'No persisted hotel options are available yet. Click Check Availability to search.',
      },
    } as ItineraryHotelDetailsResponseDto;
  }

  private parsePayload(payload: unknown): any | null {
    if (payload && typeof payload === 'object') return payload;
    try { return JSON.parse(String(payload || '')); } catch { return null; }
  }

  private toClientHotelRow(row: any): any {
    const {
      recommendationTabs: _recommendationTabs,
      offlineFetch: _offlineFetch,
      authoritativeRecommendation: _authoritativeRecommendation,
      autoSelectionStatus: _autoSelectionStatus,
      autoSelectionCandidate: _autoSelectionCandidate,
      autoSelectionIdentity: _autoSelectionIdentity,
      autoSelectionFallbackFromGroup: _autoSelectionFallbackFromGroup,
      authoritativeStayKey: _authoritativeStayKey,
      authoritativeParentRouteId: _authoritativeParentRouteId,
      authoritativeRouteIds: _authoritativeRouteIds,
      authoritativeCheckInDate: _authoritativeCheckInDate,
      authoritativeCheckOutDate: _authoritativeCheckOutDate,
      ...clientRow
    } = row || {};
    if (Array.isArray(clientRow.rateOptions)) {
      clientRow.rateOptions = this.canonicalizeRateOptions(clientRow, clientRow.rateOptions)
        .map((option: any) => this.toClientRateOption(option));
    }
    return clientRow;
  }

  private toClientRateOption(option: any): any {
    const source = option && typeof option === 'object' ? option : {};
    const fields = [
      'rateOptionId', 'rate_option_id', 'optionKey', 'option_key', 'bookingCode', 'booking_code',
      'searchReference', 'search_reference', 'roomId', 'room_id', 'rateId', 'rate_id',
      'roomTypeId', 'room_type_id', 'roomType', 'roomTypeName', 'mealPlan', 'mealPlanCode',
      'ratePlanName', 'provider', 'providerDisplayName', 'providerHotelCode', 'currency',
      'pricePerNight', 'totalStayPrice', 'totalPrice', 'totalAmount', 'price', 'basePricePerNight',
      'baseTotalPrice', 'startingFromAmount', 'startingFromBaseAmount', 'priceDifference',
      'bookingMode', 'priceSource', 'isLiveRate', 'isLiveBookable', 'isSelectable',
      'requiresHotelApproval', 'approvalStatus', 'manualConfirmationStatus', 'isBookable',
      'availabilityStatus', 'availabilityState', 'availabilityMessage',
      'availableDates', 'unavailableDates', 'completeStayBookable', 'completeStayRouteIds', 'rateConditions',
      'cancellationPolicy', 'inclusions', 'facilities', 'amenities', 'mandatorySupplements',
      'supplementSummary',
      'hotelMarginPercentage', 'hotelMarginAmount', 'hotelMarginStayAmount',
      'hotelMarginTotalAmount', 'amountIncludesHotelMargin', 'pricingIncludesHotelMargin',
    ];
    return fields.reduce((result: any, field: string) => {
      if (source[field] !== undefined) result[field] = source[field];
      return result;
    }, {});
  }

  /**
   * Stored recommendation tabs are metadata, not another hotel inventory.
   * Older snapshots embedded complete package hotel arrays in each tab;
   * returning those arrays repeated the inventory on top of `hotels` and
   * `sharedHotelInventory`. Keep only the documented tab/stay fields needed
   * by the client for totals and group identity.
   */
  private toClientHotelTab(tab: any): any {
    const source = tab && typeof tab === 'object' ? tab : {};
    const stayResults = Array.isArray(source.stayResults)
      ? source.stayResults.map((stay: any) => ({
          stayKey: String(stay?.stayKey || '').trim(),
          parentRouteId: Number(stay?.parentRouteId || 0),
          routeIds: Array.isArray(stay?.routeIds)
            ? stay.routeIds.map((id: any) => Number(id || 0)).filter((id: number) => id > 0)
            : [],
          destination: String(stay?.destination || '').trim(),
          checkInDate: String(stay?.checkInDate || '').trim(),
          checkOutDate: String(stay?.checkOutDate || '').trim(),
          nights: Number(stay?.nights || 0),
          state: stay?.state,
          ...(stay?.reason ? { reason: String(stay.reason) } : {}),
          ...(stay?.totalPrice != null ? { totalPrice: Number(stay.totalPrice) } : {}),
        }))
      : [];

    return {
      groupType: Number(source.groupType || 0),
      label: String(source.label || '').trim(),
      totalAmount: source.totalAmount == null ? null : Number(source.totalAmount),
      ...(source.partialTotal != null ? { partialTotal: Number(source.partialTotal) } : {}),
      ...(source.targetAmount != null ? { targetAmount: Number(source.targetAmount) } : {}),
      ...(source.complete != null ? { complete: Boolean(source.complete) } : {}),
      ...(source.diversityScore != null ? { diversityScore: Number(source.diversityScore) } : {}),
      ...(Array.isArray(source.repeatedAcrossGroupsHotelIds)
        ? { repeatedAcrossGroupsHotelIds: source.repeatedAcrossGroupsHotelIds.map(String) }
        : {}),
      ...(Array.isArray(source.sameOptionAcrossGroups)
        ? { sameOptionAcrossGroups: source.sameOptionAcrossGroups.map(String) }
        : {}),
      ...(Array.isArray(source.duplicateWithinPackageHotelIds)
        ? { duplicateWithinPackageHotelIds: source.duplicateWithinPackageHotelIds.map(String) }
        : {}),
      ...(Array.isArray(source.repeatedFromGroups)
        ? { repeatedFromGroups: source.repeatedFromGroups.map((id: any) => Number(id || 0)).filter((id: number) => id > 0) }
        : {}),
      stayResults,
    };
  }

  private applyCompleteStayAvailability(rows: any[], routes: any[], noOfNights: number): any[] {
    const searchableRoutes = resolveHotelRequiredRoutes(routes || [], noOfNights);
    const normalizedDestination = (route: any): string =>
      String(route?.next_visiting_location || route?.location_name || '').trim().toLowerCase();
    const routeDate = (route: any): string => this.toDateOnly(route?.itinerary_route_date);
    const routeId = (route: any): number => Number(route?.itinerary_route_ID || 0);
    const stayBlocks: Array<{ routeIds: number[]; dates: string[] }> = [];

    for (const route of searchableRoutes) {
      const currentRouteId = routeId(route);
      const currentDate = routeDate(route);
      if (!currentRouteId || !currentDate) continue;
      const previousBlock = stayBlocks[stayBlocks.length - 1];
      const previousRouteId = previousBlock?.routeIds[previousBlock.routeIds.length - 1];
      const previousRoute = previousRouteId
        ? searchableRoutes.find((candidate: any) => routeId(candidate) === previousRouteId)
        : null;
      const previousDate = previousRoute ? routeDate(previousRoute) : '';
      const previousTime = previousDate ? new Date(`${previousDate}T00:00:00.000Z`).getTime() : NaN;
      const currentTime = new Date(`${currentDate}T00:00:00.000Z`).getTime();
      const continuous = Boolean(
        previousBlock && previousRoute &&
        normalizedDestination(previousRoute) === normalizedDestination(route) &&
        Number.isFinite(previousTime) && currentTime - previousTime === 24 * 60 * 60 * 1000,
      );
      if (continuous) {
        previousBlock.routeIds.push(currentRouteId);
        previousBlock.dates.push(currentDate);
      } else {
        stayBlocks.push({ routeIds: [currentRouteId], dates: [currentDate] });
      }
    }

    const blockByRouteId = new Map<number, { routeIds: number[]; dates: string[] }>();
    stayBlocks.forEach((block) => block.routeIds.forEach((id) => blockByRouteId.set(id, block)));
    const normalizeIdentity = (value: unknown): string => String(value ?? '').trim().toLowerCase();
    const propertyIdentity = (row: any): string => {
      const provider = normalizeIdentity(row?.provider || row?.hotel_provider);
      const canonicalHotelId = Number(row?.canonicalHotelId || row?.canonical_hotel_id || row?.hotelId || 0);
      if (canonicalHotelId > 0) return `${provider}|canonical:${canonicalHotelId}`;
      const providerHotelCode = normalizeIdentity(row?.providerHotelCode || row?.provider_hotel_code || row?.hotelCode || row?.hotel_code);
      if (providerHotelCode) return `${provider}|supplier:${providerHotelCode}`;
      return `${provider}|name:${normalizeIdentity(row?.hotelName || row?.hotel_name)}`;
    };
    const optionIdentity = (row: any): string => {
      const roomType = normalizeIdentity(row?.roomTypeName || row?.roomType || row?.room_type || row?.roomTypeId || row?.room_type_id);
      const mealPlan = normalizeIdentity(row?.mealPlan || row?.mealPlanCode || row?.meal_plan);
      if (roomType || mealPlan) return `${propertyIdentity(row)}|room:${roomType}|meal:${mealPlan}`;
      return `${propertyIdentity(row)}|rate:${normalizeIdentity(row?.rateOptionId || row?.rate_option_id || row?.optionKey || row?.option_key || row?.bookingCode || row?.booking_code || row?.searchReference || row?.search_reference || row?.rateId || row?.rate_id)}`;
    };
    const rowRouteIds = (row: any): number[] => {
      const routeIds: number[] = Array.isArray(row?.routeIds) ? row.routeIds.map(Number).filter((id: number) => id > 0) : [];
      const primaryRouteId = Number(row?.itineraryRouteId || row?.routeId || row?.route_id || row?.itinerary_route_id || 0);
      if (primaryRouteId > 0 && !routeIds.includes(primaryRouteId)) routeIds.unshift(primaryRouteId);
      return [...new Set(routeIds)];
    };
    const isAvailabilityEligible = (row: any): boolean => {
      const provider = normalizeIdentity(row?.provider || row?.hotel_provider);
      const availabilityStatus = String(row?.availabilityStatus || '').trim().toUpperCase();
      const approvalRequired = provider === 'offline' || availabilityStatus === 'OFFLINE_APPROVAL_REQUIRED' ||
        String(row?.bookingMode || '').trim().toUpperCase() === 'MANUAL_APPROVAL' || row?.requiresHotelApproval === true;
      if (row?.isSelectable === false) return false;
      if (!approvalRequired && row?.isBookable === false) return false;
      return row?.isPlaceholder !== true;
    };
    const propertyCoverage = new Map<string, Set<number>>();
    const optionCoverage = new Map<string, Set<number>>();
    for (const row of rows || []) {
      const routeIds = rowRouteIds(row);
      if (isAvailabilityEligible(row)) {
        const key = propertyIdentity(row);
        const covered = propertyCoverage.get(key) || new Set<number>();
        routeIds.forEach((id) => covered.add(id));
        propertyCoverage.set(key, covered);
      }
      const rateOptions = Array.isArray(row?.rateOptions) && row.rateOptions.length > 0 ? row.rateOptions : [row];
      for (const option of rateOptions) {
        const mergedOption = { ...row, ...option };
        if (!isAvailabilityEligible(mergedOption)) continue;
        const key = optionIdentity(mergedOption);
        const covered = optionCoverage.get(key) || new Set<number>();
        routeIds.forEach((id) => covered.add(id));
        optionCoverage.set(key, covered);
      }
    }
    const formatDate = (date: string): string => {
      const parsed = new Date(`${date}T00:00:00.000Z`);
      return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
    };
    const decorate = (row: any, coverage: Set<number>, block: { routeIds: number[]; dates: string[] }): any => {
      const availableDates = block.routeIds.map((id, index) => coverage.has(id) ? block.dates[index] : null).filter(Boolean) as string[];
      const unavailableDates = block.routeIds.map((id, index) => !coverage.has(id) ? block.dates[index] : null).filter(Boolean) as string[];
      const completeStayBookable = unavailableDates.length === 0;
      const availabilityMessage = completeStayBookable ? row?.availabilityMessage : [
        availableDates.length > 0 ? `Available on ${availableDates.map(formatDate).join(', ')}.` : null,
        unavailableDates.length > 0 ? `Not available on ${unavailableDates.map(formatDate).join(', ')}.` : null,
      ].filter(Boolean).join(' ');
      return {
        ...row,
        availableDates,
        unavailableDates,
        completeStayBookable,
        completeStayRouteIds: [...block.routeIds],
        ...(completeStayBookable ? {} : { isSelectable: false }),
        availabilityMessage,
      };
    };
    return (rows || []).map((row: any) => {
      const block = rowRouteIds(row).map((id) => blockByRouteId.get(id)).find(Boolean);
      if (!block) return row;
      const decoratedRow = decorate(row, propertyCoverage.get(propertyIdentity(row)) || new Set<number>(), block);
      if (!Array.isArray(row?.rateOptions)) return decoratedRow;
      return {
        ...decoratedRow,
        rateOptions: row.rateOptions.map((option: any) => {
          const mergedOption = { ...row, ...option };
          return decorate(option, optionCoverage.get(optionIdentity(mergedOption)) || new Set<number>(), block);
        }),
      };
    });
  }

  private buildSharedHotelInventory(rows: any[], effectiveMarginPercentage: number): any[] {
    const groupNeutralRows = (rows || []).map((row: any) => {
      const {
        selection: _selection,
        selectionId: _selectionId,
        selectionOrigin: _selectionOrigin,
        selectionStatus: _selectionStatus,
        isSelected: _isSelected,
        ...inventoryRow
      } = this.toClientHotelRow(projectHotelPayablePricing(row, effectiveMarginPercentage));

      return {
        ...inventoryRow,
        groupType: 0,
        isSelected: false,
        selectionId: 0,
        selectionStatus: 'AVAILABLE',
      };
    });

    const canonicalRows = this.coalesceRowsForCache(groupNeutralRows, false)
      .map((row: any) => ({
        ...row,
        rateOptions: this.canonicalizeRateOptions(row, row.rateOptions || []),
      }));
    // The shared inventory is the source for the hotel pane.  A property can
    // be present from both AxisRooms and the offline catalogue, but the pane
    // must expose one card per property/stay. Keep all concrete offers as
    // nested rateOptions and use the cheapest offer for the card summary;
    // AxisRooms wins a price tie over offline.
    const providerRank = (provider: unknown): number => {
      const normalized = String(provider || '').trim().toLowerCase();
      if (normalized === 'axisrooms') return 0;
      if (normalized === 'tbo') return 1;
      if (normalized === 'staah') return 2;
      if (normalized === 'offline') return 3;
      return 4;
    };
    const amountOf = (row: any): number => Number(
      row?.totalHotelCost ?? row?.totalStayPrice ?? row?.totalPrice ?? row?.totalAmount ?? row?.price ?? row?.pricePerNight ?? 0,
    );
    const propertyKey = (row: any): string => {
      const canonicalId = Number(row?.canonicalHotelId || row?.canonical_hotel_id || row?.hotelId || 0);
      const name = String(row?.hotelName || row?.hotel_name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
      const property = canonicalId > 0 ? `id:${canonicalId}` : `name:${name}`;
      return [
        Number(row?.itineraryRouteId || row?.routeId || 0),
        String(row?.date || row?.checkInDate || row?.itineraryRouteDate || '').slice(0, 10),
        property,
      ].join('|');
    };
    const grouped = new Map<string, any>();
    for (const row of canonicalRows) {
      const key = propertyKey(row);
      const existing = grouped.get(key);
      const offers = [
        ...(Array.isArray(row.rateOptions) && row.rateOptions.length > 0 ? row.rateOptions : [row]),
      ];
      if (!existing) {
        grouped.set(key, { ...row, rateOptions: offers });
        continue;
      }
      const existingAmount = amountOf(existing);
      const candidateAmount = amountOf(row);
      const candidateWins = candidateAmount < existingAmount || (
        candidateAmount === existingAmount &&
        providerRank(row.provider || row.hotel_provider) < providerRank(existing.provider || existing.hotel_provider)
      );
      const mergedOptions = this.canonicalizeRateOptions(existing, [
        ...(existing.rateOptions || []),
        ...offers,
      ]);
      grouped.set(key, {
        ...(candidateWins ? row : existing),
        rateOptions: mergedOptions,
      });
    }
    const oneCardPerProperty = Array.from(grouped.values()).map((row: any) => ({
      ...row,
      rateOptions: this.canonicalizeRateOptions(row, row.rateOptions || []),
    }));
    return decorateHotelCardPricing(
      // Shared inventory is deliberately group-neutral. The same physical
      // hotel/rate must appear once for a stay, not once per recommendation
      // group. Group identity belongs to the automatic selection state, not
      // to the common inventory shown in every pane.
      oneCardPerProperty,
      new Map(),
    );
  }

  private buildClientStaySummaryRows(rows: any[]): any[] {
    const byStay = new Map<string, any>();
    const stayKey = (row: any): string => {
      const groupType = Number(row?.groupType || row?.group_type || 0);
      const routeId = Number(row?.itineraryRouteId || row?.routeId || 0);
      const date = String(row?.date || row?.checkInDate || row?.itineraryRouteDate || '').slice(0, 10);
      // The compact response feeds all recommendation tabs. Group is part of
      // the identity; omitting it collapses Groups 2-4 into Group 1 before
      // the frontend can render their early-arrival Day 0 metadata.
      return `${groupType}|${routeId}|${date}`;
    };
    const rank = (row: any): number => {
      if (row?.isSelected === true || String(row?.selectionOrigin || '').trim()) return 0;
      if (row?.isPlaceholder === true) return 3;

      // The compact `hotels` response is also used for the itinerary header.
      // Live and offline rows can exist for the same stay, but offline must
      // never win merely because it was inserted first. Reset clears the
      // selection, so a live supplier row must be the visible fallback when
      // one exists; offline is only the fallback when no live row exists.
      const provider = String(row?.provider || row?.hotel_provider || '').trim().toLowerCase();
      if (provider === 'offline') return 2;
      if (row?.isBookable !== false && row?.isSelectable !== false) return 1;
      return 2;
    };

    const rowsWithContinuousStayCoverage = (rows || []).flatMap((row: any) => {
      // Only a selected continuous-stay row should project into the compact
      // client table. Unselected rows remain route-scoped so a live supplier
      // option is not hidden by an offline availability candidate.
      if (row?.isSelected !== true || row?.completeStayBookable !== true ||
        !Array.isArray(row?.completeStayRouteIds) || row.completeStayRouteIds.length < 2) {
        return [row];
      }

      const anchorDate = this.toDateOnly(row?.date || row?.checkInDate || row?.itineraryRouteDate);
      const availableDates = Array.isArray(row?.availableDates)
        ? row.availableDates.map((value: unknown) => this.toDateOnly(value))
        : [];
      const routeIds = row.completeStayRouteIds
        .map((value: unknown) => Number(value))
        .filter((value: number) => Number.isFinite(value) && value > 0);

      return routeIds.map((routeId: number, index: number) => {
        const date = availableDates[index] || (
          anchorDate
            ? this.addDays(this.toDate(anchorDate), index).toISOString().slice(0, 10)
            : ''
        );
        return {
          ...row,
          itineraryRouteId: routeId,
          routeId,
          itinerary_route_id: routeId,
          itineraryRouteDate: date,
          itinerary_route_date: date,
          date,
          checkInDate: date,
          check_in_date: date,
          routeIds: [routeId],
        };
      });
    });

    for (const row of rowsWithContinuousStayCoverage) {
      const key = stayKey(row);
      if (!key || key === '0|0|') continue;
      const current = byStay.get(key);
      if (!current || rank(row) < rank(current)) byStay.set(key, row);
    }
    return Array.from(byStay.values());
  }

  private buildEmptySnapshotRow(plan: any, quoteId: string, searchRunId: string, checkedAt: Date): Record<string, unknown> {
    const checkIn = this.toDate(plan?.trip_start_date_and_time || checkedAt);
    return {
      quote_id: quoteId,
      plan_id: Number(plan?.itinerary_plan_ID || 0),
      route_id: 0,
      group_type: 0,
      hotel_code: EMPTY_AVAILABILITY_MARKER,
      provider: 'system',
      hotel_name: 'Availability marker',
      rating: 0,
      price: 0,
      room_type: null,
      meal_plan: null,
      search_reference: null,
      full_payload: JSON.stringify({
        availabilityMarker: EMPTY_AVAILABILITY_MARKER,
        searchRunId,
        availabilityMessage: 'Live hotel availability could not be loaded. Click Check Availability to try again.',
      }),
      check_in_date: checkIn,
      check_out_date: this.addDays(checkIn, Number(plan?.no_of_nights || 1)),
      sort_rank: 0,
      synced_at: checkedAt,
      status: 1,
      deleted: 0,
      recommendation_algorithm_version: resolveHotelRecommendationAlgorithm(),
      recommendation_search_run_id: searchRunId,
      recommendation_generated_at: checkedAt,
    };
  }

  private dedupeRows(rows: any[]): any[] {
    const byIdentity = new Map<string, any>();
    const authoritativeFields = [
      'authoritativeRecommendation',
      'autoSelectionCandidate',
      'autoSelectionIdentity',
      'requestedCategory',
      'selectedCategory',
      'categoryFallbackApplied',
      'categoryFallbackReason',
      'autoSelectionFallbackFromGroup',
      'selectedRateOptionId',
      'selectedPriceSnapshot',
      'selectionOrigin',
    ];
    const rank = (row: any): number =>
      (row?.authoritativeRecommendation === true ? 8 : 0) +
      (row?.autoSelectionCandidate === true ? 4 : 0) +
      (row?.selectionOrigin === 'AUTO_SELECTED' ? 2 : 0);
    const identity = (row: any): string => {
      const canonical = Number(row?.canonicalHotelId || row?.canonical_hotel_id || 0);
      const property = canonical > 0
        ? `canonical:${canonical}`
        : [
            String(row?.provider || row?.hotel_provider || '').trim().toLowerCase(),
            String(row?.hotelCode || row?.hotel_code || row?.providerHotelCode || row?.provider_hotel_code || '').trim().toLowerCase(),
            String(row?.hotelName || row?.hotel_name || '').trim().toLowerCase(),
          ].join('|');
      const rate = String(
        row?.selectedRateOptionId || row?.selected_rate_option_id || row?.rateOptionId ||
        row?.rate_option_id || row?.rateId || row?.rate_id || row?.bookingCode ||
        row?.booking_code || row?.searchReference || row?.search_reference || this.optionKey(row),
      ).trim().toLowerCase();
      return [
        Number(row?.itineraryRouteId || row?.routeId || 0),
        Number(row?.groupType || 0),
        property,
        rate,
      ].join('|');
    };

    for (const row of rows) {
      const key = identity(row);
      const existing = byIdentity.get(key);
      if (!existing) {
        byIdentity.set(key, row);
        continue;
      }

      const preferred = rank(row) >= rank(existing) ? row : existing;
      const secondary = preferred === row ? existing : row;
      const merged = { ...secondary, ...preferred };
      const mergedRateOptions = [
        ...(Array.isArray(secondary?.rateOptions) ? secondary.rateOptions : []),
        ...(Array.isArray(preferred?.rateOptions) ? preferred.rateOptions : []),
      ];
      if (mergedRateOptions.length > 0) {
        const optionsByKey = new Map<string, any>();
        for (const option of mergedRateOptions) {
          optionsByKey.set(this.optionKey({ ...merged, ...option }), option);
        }
        merged.rateOptions = Array.from(optionsByKey.values());
      }
      // Preserve explicit authoritative fields even when the generic source
      // row was encountered later in the input array.
      for (const field of authoritativeFields) {
        if (preferred[field] !== undefined) merged[field] = preferred[field];
      }
      byIdentity.set(key, merged);
    }
    return Array.from(byIdentity.values());
  }

  /**
   * Some supplier rows carry the rate-plan identity only in a booking/rate
   * reference (for example CP_PLAN or MAP_PLAN) and leave mealPlan as '-'.
   * Normalize both the card row and nested rates before the UI filters them.
   */
  private normalizeRatePlanLabels(row: any): any {
    const rateOptions = Array.isArray(row?.rateOptions)
      ? row.rateOptions.map((option: any) => normalizeSupplierRateIdentity(option))
      : row?.rateOptions;
    return normalizeSupplierRateIdentity({
      ...row,
      ...(Array.isArray(rateOptions) ? { rateOptions } : {}),
    });
  }

  /**
   * The legacy cache has one uniqueness row per property/provider/stay, while
   * supplier search returns many room/rate rows for that property. Store one
   * canonical card row and retain every rate as nested `rateOptions`.
   */
  private coalesceRowsForCache(rows: any[], includeGroupType = true): any[] {
    const grouped = new Map<string, any>();
    for (const row of rows) {
      const key = [
        Number(row.itineraryRouteId || row.routeId || 0),
        ...(includeGroupType ? [Number(row.groupType || 0)] : []),
        String(row.provider || 'external').trim().toLowerCase(),
        String(row.hotelCode || row.hotelId || row.canonicalHotelId || '0'),
        String(row.hotelName || row.hotel_name || '').trim().toLowerCase(),
      ].join('|');
      const existing = grouped.get(key);
      const optionCandidates = Array.isArray(row.rateOptions) && row.rateOptions.length > 0
        ? row.rateOptions
        : [row];
      if (!existing) {
        grouped.set(key, {
          ...row,
          rateOptions: this.canonicalizeRateOptions(row, optionCandidates),
        });
        continue;
      }

      const options = this.canonicalizeRateOptions(existing, [
        ...(existing.rateOptions || []), ...optionCandidates,
      ]);
      const seenOptions = new Set<string>();
      existing.rateOptions = options.filter((option: any) => {
        const optionKey = this.optionKey({ ...existing, ...option });
        if (seenOptions.has(optionKey)) return false;
        seenOptions.add(optionKey);
        return true;
      });

      const currentPrice = Number(existing.totalHotelCost ?? existing.totalStayPrice ?? existing.price ?? 0);
      const candidatePrice = Number(row.totalHotelCost ?? row.totalStayPrice ?? row.price ?? 0);
      const currentProvider = String(existing.provider || '').toLowerCase();
      const candidateProvider = String(row.provider || '').toLowerCase();
      const shouldPromote = candidateProvider === 'offline' && row.offlineRouteNightApplied === true && existing.offlineRouteNightApplied !== true ||
        candidateProvider === 'axisrooms' && currentProvider !== 'axisrooms' ||
        candidateProvider !== 'offline' && currentProvider === 'offline' ||
        currentPrice <= 0 || candidatePrice > 0 && candidatePrice < currentPrice;
      if (shouldPromote) {
        grouped.set(key, { ...row, rateOptions: existing.rateOptions });
      }
    }
    return Array.from(grouped.values());
  }

  private decoratePropertySelection(row: any, selection: any, planId: number): any {
    const snapshot = parseHotelSelectionSnapshot(selection) as any;
    const selectionId = Number(selection?.itinerary_plan_hotel_details_ID || 0);
    const roomCount = Math.max(
      Number(snapshot?.totalRooms || snapshot?.total_no_of_rooms || selection?.total_no_of_rooms || 0),
      Number(row?.noOfRooms || row?.total_no_of_rooms || 0),
      1,
    );
    const selectedOption = this.selectedRateOption(selection, row);
    const persistedRateId = String(
      selection?.selected_rate_option_id || snapshot?.rateOptionId || '',
    ).trim();
    const currentRow = selectedOption ? { ...row, ...selectedOption } : row;
    // The property fallback is only an identity reconciliation. It must not
    // copy the persisted price from an older room/rate/provider onto the
    // current availability row. The current snapshot is authoritative for
    // price; persisted values are used only when the current row has none.
    const currentTotal = Number(
      currentRow?.totalPrice ??
      currentRow?.totalStayPrice ??
      currentRow?.totalHotelCost ??
      currentRow?.total_hotel_cost ??
      currentRow?.totalAmount ??
      currentRow?.price ??
      0,
    );
    const currentPerNight = Number(
      currentRow?.pricePerNight ??
      currentRow?.price_per_night ??
      currentRow?.perNightAmount ??
      currentRow?.price ??
      0,
    );
    const persistedTotal = Number(
      selection?.selected_total_price ||
      selection?.total_hotel_cost ||
      snapshot?.totalPrice ||
      0,
    );
    const snapshotHasSupplement = [
      snapshot?.extraBedAmount, snapshot?.childWithBedAmount, snapshot?.childWithoutBedAmount,
    ].some((value) => Number(value || 0) > 0);
    const snapshotTotal = Number(snapshot?.totalPrice ?? snapshot?.totalStayPrice ?? snapshot?.totalHotelCost ?? 0);
    const persistedPerNight = Number(
      selection?.selected_price_per_night ||
      snapshot?.pricePerNight ||
      0,
    );
    const hasPersistedSelection = Boolean(
      selection?.selected_rate_option_id ||
      selection?.selected_price_snapshot ||
      selection?.itinerary_plan_hotel_details_ID,
    );
    const selectedProvider = String(selection?.hotel_provider || snapshot?.provider || '').trim().toLowerCase();
    const currentProvider = String(row?.provider || row?.hotel_provider || '').trim().toLowerCase();
    const providerMatches = !selectedProvider || !currentProvider || selectedProvider === currentProvider;
    // Property fallback is used when the refreshed snapshot has the same
    // hotel/property but no exact room/rate identity. In that case the
    // persisted selection is still the financial source of truth. A stale
    // selection from another provider is rejected by hotelPropertyMatchesSelection
    // before this method is called, so this does not resurrect old TBO money
    // on a new offline/live row.
    const selectedTotal = snapshotHasSupplement && snapshotTotal > 0
      ? snapshotTotal
      : selectedOption && currentTotal > 0
      ? currentTotal
      : hasPersistedSelection && providerMatches && persistedTotal > 0
      ? persistedTotal
      : currentTotal > 0
        ? currentTotal
        : persistedTotal;
    const selectedPerNight = snapshotHasSupplement && Number(snapshot?.pricePerNight || 0) > 0
      ? Number(snapshot.pricePerNight)
      : selectedOption && currentPerNight > 0
      ? currentPerNight
      : hasPersistedSelection && providerMatches && persistedPerNight > 0
      ? persistedPerNight
      : currentPerNight > 0
        ? currentPerNight
        : persistedPerNight;
    const persistedBaseTotal = Number(
      snapshot?.baseTotalPrice ??
      snapshot?.base_total_price ??
      selection?.total_room_cost ??
      0,
    );
    const selectedBasePerNight = Number(
      snapshot?.basePricePerNight ??
      snapshot?.base_price_per_night ??
      selectedOption?.basePricePerNight ??
      selectedOption?.base_price_per_night ??
      selectedOption?.baseHotelCost ??
      currentRow?.basePricePerNight ??
      currentRow?.baseHotelCost ??
      (persistedBaseTotal > 0 ? persistedBaseTotal / roomCount : 0),
    );
    const explicitMarginPercentage = Number(
      snapshot?.hotelMarginPercentage ||
      selection?.hotel_margin_percentage ||
      selectedOption?.hotelMarginPercentage ||
      currentRow?.hotelMarginPercentage ||
      0,
    );
    const inferredMarginAmount = persistedBaseTotal > 0 && selectedTotal > persistedBaseTotal
      ? this.money(selectedTotal - persistedBaseTotal)
      : 0;
    const selectedMarginPercentage = explicitMarginPercentage > 0
      ? explicitMarginPercentage
      : persistedBaseTotal > 0 && inferredMarginAmount > 0
        ? Number(((inferredMarginAmount / persistedBaseTotal) * 100).toFixed(2))
        : 0;
    const selectedMarginAmount = Number(
      snapshot?.hotelMarginTotalAmount ||
      snapshot?.hotelMarginAmount ||
      selection?.hotel_margin_rate ||
      currentRow?.hotelMarginAmount ||
      inferredMarginAmount ||
      0,
    );
    const display = hotelDisplaySnapshot({
      ...currentRow,
      totalPrice: selectedTotal,
      pricePerNight: selectedPerNight,
    });
    // Persisted user selections are authoritative after a refresh. Supplier
    // rows can still contain the original/default CP label even when the
    // saved selection is MAP/AP.
    const roomType = String(
      currentRow?.roomTypeName ||
      currentRow?.roomType ||
      snapshot?.roomType ||
      snapshot?.roomTypeName ||
      snapshot?.room_type_title ||
      selection?.room_type ||
      '',
    ).trim();
    const mealPlan = currentRow?.mealPlan || currentRow?.mealPlanCode || snapshot?.mealPlan || selection?.meal_plan || null;

    return {
      ...currentRow,
      hotelName: display.hotelName || currentRow.hotelName,
      category: display.category || currentRow.category,
      hotelCode: display.hotelCode || currentRow.hotelCode,
      roomType: roomType || currentRow.roomType,
      mealPlan,
      totalPrice: selectedTotal || currentRow.totalPrice,
      totalHotelCost: selectedTotal || currentRow.totalHotelCost,
      totalStayPrice: selectedTotal || currentRow.totalStayPrice,
      pricePerNight: selectedPerNight || currentRow.pricePerNight,
      ...(selectedBasePerNight > 0 ? {
        basePricePerNight: selectedBasePerNight,
        baseHotelCost: this.money(selectedBasePerNight * roomCount),
      } : {}),
      ...(selectedMarginPercentage >= 0 ? {
        hotelMarginPercentage: selectedMarginPercentage,
        hotelMarginAmount: selectedMarginAmount,
      } : {}),
      noOfRooms: roomCount,
      total_no_of_rooms: roomCount,
      roomSelections: Array.isArray(selection.roomSelections) ? selection.roomSelections : undefined,
      isSelected: true,
      isSelectable: true,
      selectionOrigin: selectionOriginFromRow(selection),
      selectionId,
      itineraryPlanHotelDetailsId: selectionId,
      selectionStatus: 'AVAILABLE',
      selectedRateOptionId: selectedOption?.rateOptionId || selectedOption?.optionKey ||
        selectedOption?.searchReference || selectedOption?.bookingCode ||
        selection.selected_rate_option_id || snapshot.rateOptionId || null,
      selectedPricePerNight: selectedPerNight,
      selectedTotalPrice: selectedTotal,
      selectedCurrency: currentRow.currency || selection.selected_currency || snapshot.currency || 'INR',
      selectedPriceSnapshot: JSON.stringify({
        ...display,
        ...(snapshot || {}),
        ...(selectedBasePerNight > 0 ? {
          basePricePerNight: selectedBasePerNight,
          baseTotalPrice: this.money(selectedBasePerNight * roomCount),
          roomCostTaxAmount: Number(snapshot?.roomCostTaxAmount ?? 0),
          hotelMarginPercentage: selectedMarginPercentage,
          hotelMarginAmount: selectedMarginAmount,
        } : {}),
        selectionOrigin: selectionOriginFromRow(selection),
        selectionId,
      }),
      selection: {
        ...display,
        hotelName: display.hotelName || currentRow.hotelName,
        roomType: roomType || display.roomType,
        mealPlan,
        totalPrice: selectedTotal || display.totalPrice,
        pricePerNight: selectedPerNight || display.pricePerNight,
        totalRooms: roomCount,
        roomSelections: Array.isArray(selection.roomSelections) ? selection.roomSelections : undefined,
        status: 'AVAILABLE',
        selectionOrigin: selectionOriginFromRow(selection),
        selectionId,
      },
      optionKey: currentRow.optionKey || this.optionKey(currentRow),
    };
  }

  private earlyArrivalDisplayFields(selection: any): Record<string, unknown> {
    const earlyCheckIn = Number(selection?.early_checkin ?? 0) === 1 || selection?.earlyCheckIn === true;
    if (!earlyCheckIn) return {};

    const hotelCheckInDate = selection?.hotel_check_in_date ?? selection?.hotelCheckInDate ?? null;
    const hotelCheckOutDate = selection?.hotel_check_out_date ?? selection?.hotelCheckOutDate ?? null;
    const actualGuestArrivalAt = selection?.actual_guest_arrival_at ?? selection?.actualGuestArrivalAt ?? null;
    const earlyCheckInExtraPaymentApplicable =
      Number(selection?.early_checkin_extra_payment_applicable ?? 0) === 1 ||
      selection?.earlyCheckInExtraPaymentApplicable === true;
    const earlyCheckInPaymentStatus =
      selection?.early_checkin_payment_status ?? selection?.earlyCheckInPaymentStatus ?? null;
    const earlyCheckInNote = selection?.early_checkin_note ?? selection?.hotelierEarlyCheckInNote ?? null;

    return {
      earlyCheckIn: true,
      earlyCheckInExtraPaymentApplicable,
      earlyCheckInPaymentStatus,
      hotelCheckInDate,
      hotel_check_in_date: hotelCheckInDate,
      hotelCheckOutDate,
      hotel_check_out_date: hotelCheckOutDate,
      actualGuestArrivalAt,
      earlyCheckInNote,
      hotelierEarlyCheckInNote: earlyCheckInNote,
      previousDayBillingSynthetic: false,
    };
  }

  private decorateSelection(row: any, selectedByRouteGroup: Map<string, any>, planId: number): any {
      const selection = selectedByRouteGroup.get(hotelSelectionKeyFromRow(planId, row));
    // Availability rows may carry selection flags from an older snapshot.
    // Selection state must come only from the current plan selection rows;
    // otherwise a stale cached row can remain selected alongside the user's
    // current hotel after a reload.
    const normalized = {
      ...row,
      // Early-arrival billing belongs to the persisted route selection, not
      // to the supplier rate identity. Apply it before room/rate matching so
      // a stale or changed room option cannot hide Day 0 in one recommendation
      // group while another group still shows it.
      ...this.earlyArrivalDisplayFields(selection),
      optionKey: row.optionKey || this.optionKey(row),
      isSelected: false,
      // These fields belong to the previous persisted selection, not to the
      // current availability option. Leaving them on the normalized parent
      // makes hotelStayTotal() prefer stale money over a fresh nested rate.
      selectedRateOptionId: undefined,
      selected_rate_option_id: undefined,
      selectedPricePerNight: undefined,
      selected_price_per_night: undefined,
      selectedTotalPrice: undefined,
      selected_total_price: undefined,
      selectedPriceSnapshot: undefined,
      selected_price_snapshot: undefined,
      selectionOrigin: undefined,
      selectionId: undefined,
      itineraryPlanHotelDetailsId: undefined,
      selectionStatus: undefined,
      selection: undefined,
    };
      if (!selection) return normalized;
      if (this.rowMatchesRoomCategorySelection(selection, normalized)) {
        const snapshot = parseHotelSelectionSnapshot(selection) as any;
        const roomCount = Math.max(Number(snapshot?.totalRooms || selection?.total_no_of_rooms || 0), Number(normalized.noOfRooms || 0), 1);
        const persistedTotal = Number(
          selection?.selected_total_price ??
          selection?.total_hotel_cost ??
          snapshot?.totalPrice ??
          0,
        );
        const persistedPerNight = Number(
          selection?.selected_price_per_night ??
          snapshot?.pricePerNight ??
          0,
        );
        const currentOption = this.selectedRateOption(selection, normalized) ||
          this.currentRoomCategoryOption(selection, normalized);
        const currentRateRow = currentOption ? { ...normalized, ...currentOption } : normalized;
        const currentTotal = hotelStayTotal(currentRateRow, 1);
        const currentPerNight = Number(
          currentRateRow?.pricePerNight ??
          currentRateRow?.price_per_night ??
          currentRateRow?.perNightAmount ??
          0,
        );
        const snapshotTotal = Number(snapshot?.totalPrice ?? snapshot?.totalStayPrice ?? snapshot?.totalHotelCost ?? 0);
        const snapshotPerNight = Number(snapshot?.pricePerNight ?? snapshot?.selectedPricePerNight ?? 0);
        const snapshotHasSupplement = [
          snapshot?.extraBedAmount, snapshot?.childWithBedAmount, snapshot?.childWithoutBedAmount,
        ].some((value) => Number(value || 0) > 0);
        // The room editor identifies a room category, not an old supplier
        // quote. A fresh matching rate is authoritative; the persisted amount
        // is only a fallback for legacy snapshots without current pricing.
        const selectedTotal = snapshotHasSupplement && snapshotTotal > 0
          ? snapshotTotal : currentTotal > 0 ? currentTotal : persistedTotal;
        const selectedPerNight = snapshotHasSupplement && snapshotPerNight > 0
          ? snapshotPerNight
          : currentPerNight > 0 ? currentPerNight : persistedPerNight;
        const persistedBaseTotal = Number(
          snapshot?.baseTotalPrice ?? snapshot?.base_total_price ??
          selection?.total_room_cost ?? 0,
        );
        const rawSelectedBasePerNight = Number(
          currentRateRow?.basePricePerNight ?? currentRateRow?.base_price_per_night ??
          currentRateRow?.baseHotelCost ??
          (persistedBaseTotal > 0 ? persistedBaseTotal / roomCount : 0),
        );
        const selectedProvider = String(
          currentRateRow?.provider || currentRateRow?.hotel_provider || snapshot?.provider || selection?.hotel_provider || '',
        ).trim().toLowerCase();
        const basePerNightIsOccupancyTotal = roomCount > 1 &&
          persistedBaseTotal > 0 &&
          Math.abs(rawSelectedBasePerNight - persistedBaseTotal) < 0.01;
        const selectedBasePerNight = (selectedProvider === 'offline' || basePerNightIsOccupancyTotal) && persistedBaseTotal > 0
          ? this.money(persistedBaseTotal / roomCount)
          : rawSelectedBasePerNight;
        // Cache inventory can legitimately carry 0 while the persisted
        // selection stores the hotel-specific margin. Zero is not an
        // authoritative override in that merge.
        const explicitMarginPercentage = Number(
          currentRateRow?.hotelMarginPercentage ||
          selection?.hotel_margin_percentage ||
          snapshot?.hotelMarginPercentage ||
          0,
        );
        const inferredMarginAmount = persistedBaseTotal > 0 && selectedTotal > persistedBaseTotal
          ? this.money(selectedTotal - persistedBaseTotal)
          : 0;
        const selectedMarginPercentage = explicitMarginPercentage > 0
          ? explicitMarginPercentage
          : persistedBaseTotal > 0 && inferredMarginAmount > 0
            ? Number(((inferredMarginAmount / persistedBaseTotal) * 100).toFixed(2))
            : 0;
        const selectedMarginAmount = Number(
          snapshot?.hotelMarginTotalAmount ||
          snapshot?.hotelMarginAmount ||
          selection?.hotel_margin_rate ||
          currentRateRow?.hotelMarginAmount ||
          inferredMarginAmount ||
          0,
        );
        const selectedRateOptionId = currentRateRow.rateOptionId || currentRateRow.optionKey ||
          currentRateRow.searchReference || currentRateRow.bookingCode ||
          selection?.selected_rate_option_id || snapshot?.rateOptionId || null;
        const selectedOptionKey = this.selectedRateOptionKey(currentRateRow, selectedRateOptionId);
        const selectedSnapshot = {
          ...hotelDisplaySnapshot({
            ...currentRateRow,
            optionKey: selectedOptionKey,
            rateOptionId: selectedRateOptionId,
            totalPrice: selectedTotal,
            pricePerNight: selectedPerNight,
          }),
          ...(snapshot || {}),
          ...(selectedBasePerNight > 0 ? {
            basePricePerNight: selectedBasePerNight,
            baseTotalPrice: this.money(selectedBasePerNight * roomCount),
          } : {}),
          hotelMarginPercentage: selectedMarginPercentage,
          hotelMarginAmount: selectedMarginAmount,
        };
        return {
          ...normalized,
          ...(currentOption || {}),
          ...this.earlyArrivalDisplayFields(selection),
          isSelected: true,
          selectionOrigin: 'USER_SELECTED',
          selectionId: Number(selection.itinerary_plan_hotel_details_ID || 0),
          itineraryPlanHotelDetailsId: Number(selection.itinerary_plan_hotel_details_ID || 0),
          noOfRooms: roomCount,
          total_no_of_rooms: roomCount,
          roomSelections: Array.isArray(selection.roomSelections) ? selection.roomSelections : undefined,
          ...(selectedTotal > 0
            ? {
                selectedTotalPrice: selectedTotal,
                selected_total_price: selectedTotal,
                totalPrice: selectedTotal,
                totalHotelCost: selectedTotal,
                totalStayPrice: selectedTotal,
                totalAmount: selectedTotal,
                price: selectedPerNight,
              }
            : {}),
          ...(snapshotTotal > 0 ? {
            extraBedCount: Number(snapshot?.extraBedCount ?? snapshot?.extra_bed_count ?? 0),
            extraBedRate: Number(snapshot?.extraBedRate ?? snapshot?.extra_bed_rate ?? 0),
            extraBedAmount: Number(snapshot?.extraBedAmount ?? snapshot?.extra_bed_amount ?? 0),
            childWithBedCount: Number(snapshot?.childWithBedCount ?? snapshot?.child_with_bed_count ?? 0),
            childWithBedRate: Number(snapshot?.childWithBedRate ?? snapshot?.child_with_bed_rate ?? 0),
            childWithBedAmount: Number(snapshot?.childWithBedAmount ?? snapshot?.child_with_bed_amount ?? 0),
            childWithoutBedCount: Number(snapshot?.childWithoutBedCount ?? snapshot?.child_without_bed_count ?? 0),
            childWithoutBedRate: Number(snapshot?.childWithoutBedRate ?? snapshot?.child_without_bed_rate ?? 0),
            childWithoutBedAmount: Number(snapshot?.childWithoutBedAmount ?? snapshot?.child_without_bed_amount ?? 0),
          } : {}),
          ...(selectedBasePerNight > 0 ? {
            basePricePerNight: selectedBasePerNight,
            baseTotalPrice: this.money(persistedBaseTotal > 0 ? persistedBaseTotal : selectedBasePerNight * roomCount),
            baseHotelCost: this.money(selectedBasePerNight * roomCount),
          } : {}),
          hotelMarginPercentage: selectedMarginPercentage,
          hotelMarginAmount: selectedMarginAmount,
          ...(selectedPerNight > 0
            ? {
                selectedPricePerNight: selectedPerNight,
                selected_price_per_night: selectedPerNight,
                pricePerNight: selectedPerNight,
              }
            : {}),
          selectedRateOptionId,
          roomType: currentRateRow.roomTypeName || currentRateRow.roomType || normalized.roomType,
          mealPlan: currentRateRow.mealPlan || currentRateRow.mealPlanCode || normalized.mealPlan,
          roomId: currentRateRow.roomId || currentRateRow.room_id || normalized.roomId,
          rateId: currentRateRow.rateId || currentRateRow.rate_id || normalized.rateId,
          rateOptionId: selectedRateOptionId,
          optionKey: selectedOptionKey,
          selectedPriceSnapshot: JSON.stringify(selectedSnapshot),
          selectionStatus: 'AVAILABLE',
          selection: {
            ...hotelDisplaySnapshot({
              ...normalized,
              ...currentRateRow,
              ...this.earlyArrivalDisplayFields(selection),
              optionKey: selectedOptionKey,
              rateOptionId: selectedRateOptionId,
              ...(selectedTotal > 0 ? { totalPrice: selectedTotal } : {}),
              ...(selectedPerNight > 0 ? { pricePerNight: selectedPerNight } : {}),
            }),
            status: 'AVAILABLE',
            selectionOrigin: 'USER_SELECTED',
            selectionId: Number(selection.itinerary_plan_hotel_details_ID || 0),
            totalRooms: roomCount,
            roomSelections: Array.isArray(selection.roomSelections) ? selection.roomSelections : undefined,
          },
        };
      }
    const nestedOption = Array.isArray(normalized.rateOptions)
      ? normalized.rateOptions.find((option: any) => optionMatchesSelection(selection, { ...normalized, ...option }))
      : null;
    const matched = Boolean(nestedOption) || optionMatchesSelection(selection, normalized);
    if (!matched) return normalized;
    const selectionOrigin = selectionOriginFromRow(selection);
    const persistedTotal = Number(
      selection?.selected_total_price ??
      selection?.total_hotel_cost ??
      parseHotelSelectionSnapshot(selection)?.totalPrice ??
      0,
    );
    const persistedPerNight = Number(
      selection?.selected_price_per_night ??
      parseHotelSelectionSnapshot(selection)?.pricePerNight ??
      0,
    );
    const currentRateRow = nestedOption ? { ...normalized, ...nestedOption } : normalized;
    const currentTotal = hotelStayTotal(currentRateRow, 1);
    const currentPerNight = Number(
      currentRateRow?.pricePerNight ??
      currentRateRow?.price_per_night ??
      currentRateRow?.perNightAmount ??
      currentRateRow?.price ??
      0,
    );
    // The matched option is from the current availability snapshot. Its
    // amount is authoritative after Reset/Check Availability; persisted money
    // is only a fallback for legacy rows where the supplier returned no price.
    // Once the persisted rate-option ID matches the current row, the saved
    // selection snapshot is authoritative when there is no matching nested
    // option. The parent row may still be the cheapest/default occupancy rate
    // (for example ₹3,200) while the selected option is ₹5,040.
    // A saved user selection contains the authoritative payable amount. The
    // nested availability option may be the raw supplier/base amount (for
    // example ₹4,200) while the selection stores the same option after the
    // configured margin (₹5,040). Never let that raw parent/nested amount
    // downgrade a persisted selected rate on reload.
    const hasPersistedUserPrice = selectionOriginFromRow(selection) === 'USER_SELECTED' &&
      persistedTotal > 0 && persistedPerNight > 0;
    const selectedTotal = hasPersistedUserPrice
      ? persistedTotal
      : nestedOption
        ? (currentTotal > 0 ? currentTotal : persistedTotal)
        : (persistedTotal > 0 ? persistedTotal : currentTotal);
    const selectedPerNight = hasPersistedUserPrice
      ? persistedPerNight
      : nestedOption
        ? (currentPerNight > 0 ? currentPerNight : persistedPerNight)
        : (persistedPerNight > 0 ? persistedPerNight : currentPerNight);
    const selectedSnapshot = parseHotelSelectionSnapshot(selection);
    const selectedFinancialSnapshot = selectedSnapshot as any;
    const selectedBaseTotal = Number(
      selectedFinancialSnapshot?.baseTotalPrice ??
      selectedFinancialSnapshot?.base_total_price ??
      selection?.total_room_cost ??
      0,
    );
    const selectedRoomCount = Math.max(
      Number(selectedFinancialSnapshot?.totalRooms || selection?.total_no_of_rooms || normalized?.noOfRooms || 0),
      1,
    );
    const rawSelectedBasePerNight = Number(
      selectedFinancialSnapshot?.basePricePerNight ??
      selectedFinancialSnapshot?.base_price_per_night ??
      (selectedBaseTotal > 0 ? selectedBaseTotal / selectedRoomCount : 0),
    );
    const selectedProvider = String(
      currentRateRow?.provider || currentRateRow?.hotel_provider || selection?.hotel_provider || selectedFinancialSnapshot?.provider || '',
    ).trim().toLowerCase();
    const basePerNightIsOccupancyTotal = selectedRoomCount > 1 &&
      selectedBaseTotal > 0 &&
      Math.abs(rawSelectedBasePerNight - selectedBaseTotal) < 0.01;
    const selectedBasePerNight = (selectedProvider === 'offline' || basePerNightIsOccupancyTotal) && selectedBaseTotal > 0
      ? this.money(selectedBaseTotal / selectedRoomCount)
      : rawSelectedBasePerNight;
    const explicitSelectedMarginPercentage = Number(
      selectedFinancialSnapshot?.hotelMarginPercentage || selection?.hotel_margin_percentage || 0,
    );
    const inferredSelectedMarginAmount = selectedBaseTotal > 0 && selectedTotal > selectedBaseTotal
      ? this.money(selectedTotal - selectedBaseTotal)
      : 0;
    const selectedMarginPercentage = explicitSelectedMarginPercentage > 0
      ? explicitSelectedMarginPercentage
      : selectedBaseTotal > 0 && inferredSelectedMarginAmount > 0
        ? Number(((inferredSelectedMarginAmount / selectedBaseTotal) * 100).toFixed(2))
        : 0;
    const selectedMarginAmount = Number(
      selectedFinancialSnapshot?.hotelMarginTotalAmount ||
      selectedFinancialSnapshot?.hotelMarginAmount ||
      selection?.hotel_margin_rate ||
      inferredSelectedMarginAmount ||
      0,
    );
    const selectedRateOptionId = String(
      selection?.selected_rate_option_id ||
      selectedSnapshot?.rateOptionId ||
      currentRateRow?.rateOptionId ||
      currentRateRow?.optionKey ||
      currentRateRow?.searchReference ||
      currentRateRow?.bookingCode ||
      '',
    ).trim() || null;
    const selectedOptionKey = this.selectedRateOptionKey(currentRateRow, selectedRateOptionId);
    const effectiveSelectionDisplay = hotelDisplaySnapshot({
        ...currentRateRow,
        requestedCategory: currentRateRow?.requestedCategory ?? selection?.requestedCategory ?? (selectedSnapshot as any)?.requestedCategory,
        selectedCategory: currentRateRow?.selectedCategory ?? selection?.selectedCategory ?? (selectedSnapshot as any)?.selectedCategory,
        categoryFallbackApplied: currentRateRow?.categoryFallbackApplied ?? selection?.categoryFallbackApplied ?? (selectedSnapshot as any)?.categoryFallbackApplied,
        categoryFallbackReason: currentRateRow?.categoryFallbackReason ?? selection?.categoryFallbackReason ?? (selectedSnapshot as any)?.categoryFallbackReason,
        optionKey: selectedOptionKey,
        rateOptionId: selectedRateOptionId,
        totalPrice: selectedTotal,
        pricePerNight: selectedPerNight,
      });
    const freshSelectedSnapshot = {
      ...effectiveSelectionDisplay,
      selectionOrigin,
      selectionId: Number(selection.itinerary_plan_hotel_details_ID || 0),
        rateOptionId: selectedRateOptionId,
      ...(selectedBasePerNight > 0 ? { basePricePerNight: selectedBasePerNight } : {}),
      ...(selectedBaseTotal > 0 ? { baseTotalPrice: selectedBaseTotal } : {}),
      ...(selectedMarginPercentage > 0 ? { hotelMarginPercentage: selectedMarginPercentage } : {}),
      ...(selectedMarginAmount > 0 ? {
        hotelMarginAmount: selectedMarginAmount,
        hotelMarginTotalAmount: selectedMarginAmount,
      } : {}),
    };
    return {
      ...normalized,
      ...(nestedOption || {}),
      ...this.earlyArrivalDisplayFields(selection),
      rateOptions: normalized.rateOptions,
      ...(selectedTotal > 0
        ? {
            totalPrice: selectedTotal,
            totalHotelCost: selectedTotal,
            totalStayPrice: selectedTotal,
          }
        : {}),
      ...(selectedPerNight > 0 ? { pricePerNight: selectedPerNight } : {}),
      ...(selectedPerNight > 0 ? { price: selectedPerNight } : {}),
      ...(selectedTotal > 0 ? { totalAmount: selectedTotal, netAmount: selectedTotal } : {}),
      ...(selectedBasePerNight > 0 ? {
        basePricePerNight: selectedBasePerNight,
        baseTotalPrice: selectedBaseTotal > 0
          ? this.money(selectedBaseTotal)
          : this.money(selectedBasePerNight * selectedRoomCount),
        baseHotelCost: selectedBaseTotal > 0 ? selectedBaseTotal : selectedBasePerNight,
      } : {}),
      ...(selectedMarginPercentage > 0 ? { hotelMarginPercentage: selectedMarginPercentage } : {}),
      ...(selectedMarginAmount > 0 ? { hotelMarginAmount: selectedMarginAmount } : {}),
      isSelected: true,
      selectionOrigin,
      selectionId: Number(selection.itinerary_plan_hotel_details_ID || 0),
      itineraryPlanHotelDetailsId: Number(selection.itinerary_plan_hotel_details_ID || 0),
      // The persisted selection identity wins over the parent cache row. The
      // parent may represent another room/meal option in rateOptions.
      selectedRateOptionId,
      optionKey: selectedOptionKey,
      roomType: currentRateRow.roomTypeName || currentRateRow.roomType || normalized.roomType,
      mealPlan: currentRateRow.mealPlan || currentRateRow.mealPlanCode || normalized.mealPlan,
      roomId: currentRateRow.roomId || currentRateRow.room_id || normalized.roomId,
      rateId: currentRateRow.rateId || currentRateRow.rate_id || normalized.rateId,
      rateOptionId: selectedRateOptionId,
      selectedPricePerNight: selectedPerNight || selection.selected_price_per_night,
      selectedTotalPrice: selectedTotal || selection.selected_total_price,
      selectedCurrency: selection.selected_currency,
      requiresPriceReacceptance: Boolean(selection.requires_price_reacceptance),
      selectedPriceSnapshot: JSON.stringify(freshSelectedSnapshot),
      selectionStatus: 'AVAILABLE',
      selection: {
        ...hotelDisplaySnapshot({
          ...selection,
          ...parseHotelSelectionSnapshot(selection),
          ...currentRateRow,
          ...this.earlyArrivalDisplayFields(selection),
          optionKey: selectedOptionKey,
          rateOptionId: selectedRateOptionId,
          totalPrice: selectedTotal,
          pricePerNight: selectedPerNight,
        }),
        status: 'AVAILABLE',
        selectionOrigin,
        selectionId: Number(selection.itinerary_plan_hotel_details_ID || 0),
      },
    };
  }

  private selectedRateOptionKey(row: any, selectedRateOptionId?: string | null): string {
    return this.optionKey({
      ...row,
      optionKey: undefined,
      rateOptionId: selectedRateOptionId || row?.rateOptionId,
    });
  }

  private rowMatchesSelection(selection: any, row: any): boolean {
    if (this.rowMatchesRoomCategorySelection(selection, row)) return true;
    if (optionMatchesSelection(selection, row)) return true;
    return Array.isArray(row?.rateOptions) && row.rateOptions.some((option: any) =>
      optionMatchesSelection(selection, { ...row, ...option }),
    );
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
    const ttlMinutes = Math.max(Number(process.env.HOTEL_AVAILABILITY_TTL_MINUTES || 35), 1);
    const isFresh = Date.now() - checkedAt.getTime() < ttlMinutes * 60 * 1000;
    if (hasUnavailableSelection) return 'PARTIAL';
    return isFresh ? 'FRESH' : 'STALE';
  }

  private buildTabs(
    rows: any[],
    routes: any[] = [],
    noOfNights = 0,
    persistedRecommendationTabs: any[] = [],
    requestedGroupType?: number,
  ): ItineraryHotelTabDto[] {
    const requestedGroup = Number(requestedGroupType || 0);
    const storedTabs = (Array.isArray(persistedRecommendationTabs) ? persistedRecommendationTabs : [])
      .map((tab: any) => {
        const clientTab = this.toClientHotelTab(tab);
        const stayResults = Array.isArray(clientTab?.stayResults) ? clientTab.stayResults : [];
        // stayResults are the package-level source of truth. A refresh can
        // legitimately produce an incomplete package, and an old persisted
        // selection must not leave a positive tab amount attached to stays
        // that the same payload marks UNAVAILABLE.
        const derivedPartialTotal = stayResults.length > 0
          ? stayResults.reduce((sum: number, stay: any) => {
              if (String(stay?.state || '').trim().toUpperCase() === 'UNAVAILABLE') return sum;
              const amount = Number(stay?.totalPrice || 0);
              return Number.isFinite(amount) && amount > 0 ? sum + amount : sum;
            }, 0)
          : Number(tab?.partialTotal ?? 0);
        const partialTotal = Number.isFinite(derivedPartialTotal)
          ? Number(derivedPartialTotal.toFixed(2))
          : 0;
        const totalAmount = clientTab?.complete === false
          ? partialTotal
          : (tab?.totalAmount == null
              ? (tab?.partialTotal == null ? null : Number(tab.partialTotal))
              : Number(tab.totalAmount));
        return {
          ...clientTab,
          groupType: Number(clientTab?.groupType || 0),
          label: String(clientTab?.label || `Recommended #${Number(clientTab?.groupType || 0)}`),
          partialTotal,
          totalAmount,
        };
      })
      .filter((tab: any) => tab.groupType >= 1 && tab.groupType <= 4)
      .filter((tab: any) => !requestedGroup || tab.groupType === requestedGroup)
      .sort((left: any, right: any) => left.groupType - right.groupType);

    const ensureFourStoredTabs = (tabs: any[]): any[] => {
      // A v2 refresh always writes four recommendation packages, but older
      // snapshots may contain only one or two tabs. Normalize those snapshots
      // on read so the UI contract remains stable without recalculating live
      // availability during a normal page load.
      if (requestedGroup || tabs.length === 0) return tabs;
      const normalized = tabs.slice(0, 4).map((tab: any) => {
        const groupType = Number(tab?.groupType || 0);
        const repeatedFallback = tab?.distinctFromPrevious === false;
        if (repeatedFallback) {
          return {
            groupType,
            label: `Recommended #${groupType}`,
            hotels: [],
            stayResults: [],
            totalAmount: 0,
            partialTotal: 0,
            complete: false,
            distinctFromPrevious: false,
            diversityScore: 0,
            repeatedAcrossGroupsHotelIds: [],
            sameOptionAcrossGroups: [],
            duplicateWithinPackageHotelIds: [],
            repeatedFromGroups: [],
            fallbackReasons: ['No distinct hotel package is available for this recommendation group.'],
          };
        }
        return {
          ...tab,
          groupType,
          label: `Recommended #${groupType}`,
          stayResults: Array.isArray(tab.stayResults) ? [...tab.stayResults] : tab.stayResults,
        };
      });
      const byGroup = new Map(normalized.map((tab: any) => [Number(tab.groupType || 0), tab]));
      return [1, 2, 3, 4].map((groupType) => byGroup.get(groupType) || {
          groupType,
          label: `Recommended #${groupType}`,
          hotels: [],
          stayResults: [],
          totalAmount: 0,
          partialTotal: 0,
          complete: false,
          distinctFromPrevious: false,
          diversityScore: 0,
          repeatedAcrossGroupsHotelIds: [],
          sameOptionAcrossGroups: [],
          duplicateWithinPackageHotelIds: [],
          repeatedFromGroups: [],
          fallbackReasons: ['No distinct hotel package is available for this recommendation group.'],
        });
    };
    const orderTabsForDisplay = (tabs: any[]): any[] => {
      if (requestedGroup) return tabs;
      return [...tabs]
        .sort((left, right) => Number(left?.groupType || 0) - Number(right?.groupType || 0))
        .map((tab) => ({ ...tab, label: `Recommended #${Number(tab.groupType || 0)}` }));
    };

    // Recommendation metadata is generated before a user changes a room,
    // meal plan, or hotel. Keep the package shape and diversity metadata, but
    // overlay any currently persisted selected payable amount onto the
    // matching stay. Otherwise the table can show the selected row while the
    // recommendation tab and page summary continue to show the old catalog
    // amount (for example 4,300 instead of the payable 4,730).
    const normalizeDateOnly = (value: unknown): string => {
      const raw = String(value ?? '').trim();
      return raw.match(/\\d{4}-\\d{2}-\\d{2}/)?.[0] || raw.slice(0, 10);
    };
    const selectedAmount = (row: any): number => {
      const amount = Number(
        row?.selectedTotalPrice ??
          row?.selected_total_price ??
          row?.totalStayPrice ??
          row?.totalPrice ??
          row?.totalHotelCost ??
          0,
      );
      return Number.isFinite(amount) && amount > 0 ? amount : 0;
    };
    const hasSelectionMarker = (row: any): boolean => Boolean(
      row?.isSelected === true ||
      String(row?.selectionOrigin || '').trim() ||
      Number(row?.selectionId || row?.itineraryPlanHotelDetailsId || 0) > 0,
    );
    const isExplicitlyEmptyRecommendationTab = (tab: any): boolean =>
      tab?.complete === false &&
      Array.isArray(tab?.stayResults) &&
      tab.stayResults.length === 0;
    const overlayUserSelectedTabTotal = (tab: any): any => {
      // An empty package is an intentional optimizer result. Inventory and
      // persisted selections are materialized for every group, so overlaying
      // those rows here would manufacture a recommendation that never
      // existed (typically copying group 1 into group 4).
      if (isExplicitlyEmptyRecommendationTab(tab)) return tab;
      const groupRows = (rows || []).filter((row: any) =>
        Number(row?.groupType || 0) === Number(tab?.groupType || 0),
      );
      const selectedRows = groupRows.filter((row: any) =>
        String(row?.selectionOrigin || '').trim().toUpperCase() === 'USER_SELECTED',
      );
      if (selectedRows.length === 0) return tab;

      // A partial snapshot can contain a user-selected unavailable night and
      // a fresh selectable night. Summing only USER_SELECTED rows drops the
      // fresh night; summing every row double-counts a multi-night stay. Use
      // one authoritative amount per route/date/stay identity instead.
      const stayIdentity = (row: any): string => {
        const stayKey = String(row?.stayKey || row?.stay_key || '').trim();
        if (stayKey) return stayKey;
        const routeIds = [
          row?.itineraryRouteId,
          row?.routeId,
          ...(Array.isArray(row?.routeIds) ? row.routeIds : []),
        ].map((value: unknown) => Number(value || 0)).filter((value: number) => value > 0).sort((a, b) => a - b);
        const date = String(row?.date || row?.checkInDate || row?.itineraryRouteDate || '').slice(0, 10);
        return `${routeIds.join(',')}|${date}`;
      };
      const byStay = new Map<string, any[]>();
      groupRows.forEach((row: any) => {
        const key = stayIdentity(row);
        byStay.set(key, [...(byStay.get(key) || []), row]);
      });
      const totalAmount = Array.from(byStay.values()).reduce((sum: number, stayRows: any[]) => {
        const selected = stayRows.find((row: any) =>
          String(row?.selectionOrigin || '').trim().toUpperCase() === 'USER_SELECTED',
        );
        const selectable = stayRows.filter((row: any) =>
          row?.isBookable !== false && row?.isSelectable !== false && row?.isPlaceholder !== true,
        );
        const chosen = selected || [...selectable, ...stayRows]
          .filter((row: any) => selectedAmount(row) > 0)
          .sort((left: any, right: any) => selectedAmount(left) - selectedAmount(right))[0];
        return sum + selectedAmount(chosen);
      }, 0);
      if (!Number.isFinite(totalAmount) || totalAmount <= 0) return tab;
      return {
        ...tab,
        totalAmount: Number(totalAmount.toFixed(2)),
        partialTotal: tab.partialTotal == null ? tab.partialTotal : Number(totalAmount.toFixed(2)),
      };
    };
    const rowMatchesStay = (row: any, stay: any): boolean => {
      const stayKey = String(stay?.stayKey || '').trim();
      const rowStayKey = String(row?.stayKey || row?.stay_key || '').trim();
      if (stayKey && rowStayKey && stayKey === rowStayKey) return true;
      const parentRouteId = Number(stay?.parentRouteId || 0);
      const rowRouteIds = [
        row?.itineraryRouteId,
        row?.routeId,
        ...(Array.isArray(row?.routeIds) ? row.routeIds : []),
      ]
        .map((value: unknown) => Number(value || 0))
        .filter((value: number) => Number.isFinite(value) && value > 0);
      if (!parentRouteId || !rowRouteIds.includes(parentRouteId)) return false;
      const stayDate = normalizeDateOnly(stay?.checkInDate || stay?.date);
      const rowDate = normalizeDateOnly(
        row?.date || row?.checkInDate || row?.hotelCheckInDate || row?.itineraryRouteDate,
      );
      // Route identity is authoritative here. Stored recommendation dates may
      // be UTC timestamps while the supplier rows use the itinerary's local
      // business date; rejecting that same-route row leaves stale tab totals.
      return !stayDate || !rowDate || stayDate === rowDate || Boolean(parentRouteId);
    };
    const overlayStoredTabSelections = (tab: any): any => {
      if (!Array.isArray(tab?.stayResults) || tab.stayResults.length === 0) return tab;
      const tabRows = (rows || []).filter((row: any) =>
        Number(row?.groupType || 0) === Number(tab.groupType || 0) && hasSelectionMarker(row),
      );
      if (tabRows.length === 0) return tab;
      let changed = false;
      const stayResults = tab.stayResults.map((stay: any) => {
        const selected = tabRows
          .filter((row: any) => rowMatchesStay(row, stay))
          .sort((left: any, right: any) => Number(right.selectionId || 0) - Number(left.selectionId || 0))[0];
        const amount = selectedAmount(selected);
        if (!selected || amount <= 0) return stay;
        changed = true;
        return { ...stay, totalPrice: Number(amount.toFixed(2)) };
      });
      if (!changed) return tab;
      const totalAmount = stayResults.reduce((sum: number, stay: any) => {
        const amount = Number(stay?.totalPrice || 0);
        return Number.isFinite(amount) && amount > 0 ? sum + amount : sum;
      }, 0);
      return {
        ...tab,
        stayResults,
        totalAmount: Number(totalAmount.toFixed(2)),
        partialTotal: tab.partialTotal == null ? tab.partialTotal : Number(totalAmount.toFixed(2)),
      };
    };

    const reconcileStoredTabTotalFromCurrentSelections = (tab: any): any => {
      if (isExplicitlyEmptyRecommendationTab(tab)) return tab;
      const selectedRows = (rows || []).filter((row: any) =>
        Number(row?.groupType || 0) === Number(tab?.groupType || 0) &&
        hasSelectionMarker(row) &&
        String(row?.selectionStatus || '').trim().toUpperCase() !== 'UNAVAILABLE' &&
        selectedAmount(row) > 0,
      );
      if (selectedRows.length === 0) return tab;

      // One persisted selection is repeated on every night of a continuous
      // stay. Count the selection once, otherwise a two-night hotel becomes
      // double-priced when the package total is rebuilt from route rows.
      const seen = new Set<string>();
      const totalAmount = selectedRows.reduce((sum: number, row: any) => {
        const selectionId = Number(row?.selectionId || row?.selection_id || row?.itineraryPlanHotelDetailsId || 0);
        const stayKey = String(row?.stayKey || row?.stay_key || row?.authoritativeStayKey || '').trim();
        const commercialKey = String(
          row?.selectionKey || row?.optionKey ||
          `${String(row?.provider || '').trim().toLowerCase()}|${String(row?.hotelCode || row?.hotelId || '').trim()}|${String(row?.roomType || row?.roomTypeName || '').trim()}|${String(row?.mealPlan || row?.mealPlanCode || '').trim()}`,
        ).trim();
        const key = selectionId > 0
          ? `selection:${selectionId}`
          : stayKey
            ? `stay:${stayKey}`
            : `option:${commercialKey}`;
        if (seen.has(key)) return sum;
        seen.add(key);
        return sum + selectedAmount(row);
      }, 0);
      if (!Number.isFinite(totalAmount) || totalAmount <= 0) return tab;
      return {
        ...tab,
        totalAmount: Number(totalAmount.toFixed(2)),
        partialTotal: tab.partialTotal == null ? tab.partialTotal : Number(totalAmount.toFixed(2)),
      };
    };

    // Recommendation metadata is tied to the route IDs that produced the
    // availability snapshot. Editing an itinerary can recreate route rows
    // without changing the visible dates, leaving the old tab metadata in
    // the persisted payload. Reusing those tabs then makes every package
    // display the same stale total. Only trust stored tabs when their stays
    // still refer to the current snapshot's route identities.
    const currentAvailabilityRouteIds = new Set<number>(
      (rows || [])
        .flatMap((row: any) => [
          row?.itineraryRouteId,
          row?.routeId,
          ...(Array.isArray(row?.routeIds) ? row.routeIds : []),
        ])
        .map((value: unknown) => Number(value || 0))
        .filter((value: number) => Number.isFinite(value) && value > 0),
    );
    const storedTabsMatchCurrentRoutes = storedTabs.length > 0 && (
      !routes.length ||
      currentAvailabilityRouteIds.size === 0 ||
      storedTabs.every((tab: any) =>
      isExplicitlyEmptyRecommendationTab(tab) || (
      Array.isArray(tab?.stayResults) &&
      tab.stayResults.length > 0 &&
      tab.stayResults.every((stay: any) => {
        const stayRouteIds = [
          stay?.parentRouteId,
          ...(Array.isArray(stay?.routeIds) ? stay.routeIds : []),
        ]
          .map((value: unknown) => Number(value || 0))
          .filter((value: number) => Number.isFinite(value) && value > 0);
        return stayRouteIds.some((routeId: number) => currentAvailabilityRouteIds.has(routeId));
      })),
      )
    );

    // Fresh searches carry the totals generated by the recommendation engine.
    // Reuse them when reading the persisted snapshot; the snapshot contains
    // every availability option and cannot derive a package total by summing
    // all of those rows.
    if (
      storedTabsMatchCurrentRoutes &&
      storedTabs.length > 0 &&
      storedTabs.every((tab: any) => Number.isFinite(tab.totalAmount) && tab.totalAmount >= 0)
    ) return orderTabsForDisplay(ensureFourStoredTabs(storedTabs
      .map(overlayStoredTabSelections)
      .map(overlayUserSelectedTabTotal)
      .map(reconcileStoredTabTotalFromCurrentSelections)));

    const searchableRoutes = resolveHotelRequiredRoutes(routes || [], noOfNights);
    const stayKeyByRouteId = new Map<number, string>();
    const destinationOf = (route: any): string =>
      String(route?.next_visiting_location || route?.location_name || '').trim().toLowerCase();
    const dateOf = (route: any): number => new Date(route?.itinerary_route_date || '').getTime();
    const dateLabel = (route: any): string => {
      const date = new Date(route?.itinerary_route_date || '');
      return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
    };
    let block: any[] = [];
    const flushBlock = () => {
      if (block.length === 0) return;
      const first = block[0];
      const key = `${Number(first.itinerary_route_ID || 0)}|${dateLabel(first)}|${dateLabel(block[block.length - 1])}`;
      block.forEach((route) => stayKeyByRouteId.set(Number(route.itinerary_route_ID || 0), key));
      block = [];
    };
    searchableRoutes.forEach((route: any) => {
      const previous = block[block.length - 1];
      const continuous = Boolean(
        previous &&
        destinationOf(previous) === destinationOf(route) &&
        dateOf(route) - dateOf(previous) === 24 * 60 * 60 * 1000,
      );
      if (!continuous) flushBlock();
      block.push(route);
    });
    flushBlock();

    const amountOf = (row: any): number => hotelStayTotal(row, noOfNights) + Number(row?.totalHotelTaxAmount || 0);
    const isSelectable = (row: any): boolean =>
      row?.isBookable !== false && row?.isSelectable !== false && row?.isPlaceholder !== true;
    const isLive = (row: any): boolean => {
      const provider = String(row?.provider || '').trim().toLowerCase();
      return provider !== 'offline' && provider !== 'external' && provider !== 'system';
    };
    const groups = new Map<number, Map<string, any[]>>();
    for (const row of rows || []) {
      const groupType = Number(row?.groupType || 0);
      if (groupType < 1 || groupType > 4) continue;
      const routeId = Number(row?.itineraryRouteId || row?.routeId || 0);
      const date = String(row?.date || row?.checkInDate || '').slice(0, 10);
      const stayKey = String(row?.stayKey || row?.stay_key || '').trim() ||
        stayKeyByRouteId.get(routeId) || `${routeId}|${date}`;
      const group = groups.get(groupType) || new Map<string, any[]>();
      const stayRows = group.get(stayKey) || [];
      stayRows.push(row);
      group.set(stayKey, stayRows);
      groups.set(groupType, group);
    }

    const derivedTabs = Array.from(groups.entries())
      .sort(([left], [right]) => left - right)
      .map(([groupType, stays]) => {
        let totalAmount = 0;
        for (const stayRows of stays.values()) {
          const usable = stayRows.filter((row) => isSelectable(row) && amountOf(row) > 0);
          const live = usable.filter(isLive);
          // Keep an unavailable persisted selection in the total only when
          // that stay has no current selectable option. This preserves the
          // existing edit-mode summary without allowing stale rows to inflate
          // a stay that has live availability.
          const pricedRows = stayRows.filter((row) => amountOf(row) > 0);
          const candidates = live.length > 0 ? live : usable.length > 0 ? usable : pricedRows;
          const selected = [...candidates].sort((left, right) => amountOf(left) - amountOf(right))[0];
          if (selected) totalAmount += amountOf(selected);
        }
        return {
          groupType,
          label: `Recommended #${groupType}`,
          totalAmount: Number(totalAmount.toFixed(2)),
        };
      })
      .filter((tab) => !requestedGroup || tab.groupType === requestedGroup);
    return orderTabsForDisplay(derivedTabs);
  }

  private buildEmptyStayBlocks(routes: any[], rows: any[], noOfNights: number): EmptyHotelStayBlock[] {
    const eligibleRoutes = (routes || []).filter((route: any, index: number) =>
      !(index === routes.length - 1 && index >= noOfNights),
    );
    const blocks: Array<{ routes: any[] }> = [];

    for (const route of eligibleRoutes) {
      const routeDate = new Date(route.itinerary_route_date);
      if (Number.isNaN(routeDate.getTime())) continue;
      const destination = String(route.next_visiting_location || route.location_name || '').trim();
      const previousBlock = blocks[blocks.length - 1];
      const previousRoute = previousBlock?.routes[previousBlock.routes.length - 1];
      const previousDate = previousRoute ? new Date(previousRoute.itinerary_route_date) : null;
      const isContinuous = Boolean(
        previousBlock &&
        String(previousRoute.next_visiting_location || previousRoute.location_name || '').trim() === destination &&
        previousDate &&
        routeDate.getTime() - previousDate.getTime() === 24 * 60 * 60 * 1000,
      );

      if (isContinuous) previousBlock.routes.push(route);
      else blocks.push({ routes: [route] });
    }

    return blocks
      .filter((block) => {
        const routeIds = new Set(block.routes.map((route: any) => Number(route.itinerary_route_ID || 0)));
        const hasLive = rows.some((row: any) =>
          routeIds.has(Number(row.itineraryRouteId || row.routeId || 0)) &&
          String(row.provider || '').trim().toLowerCase() !== 'offline' &&
          row.isBookable !== false &&
          row.isPlaceholder !== true,
        );
        const hasOffline = rows.some((row: any) =>
          routeIds.has(Number(row.itineraryRouteId || row.routeId || 0)) &&
          String(row.provider || '').trim().toLowerCase() === 'offline',
        );
        return !hasLive && !hasOffline;
      })
      .map((block) => ({
        routeIds: block.routes.map((route: any) => Number(route.itinerary_route_ID || 0)),
        dayNumbers: block.routes.map((route: any, index: number) => Number(route.day_number || route.dayNumber || index + 1)),
        dates: block.routes.map((route: any) => new Date(route.itinerary_route_date).toISOString().slice(0, 10)),
        destination: String(block.routes[0]?.next_visiting_location || block.routes[0]?.location_name || '').trim(),
      }));
  }

  private async reconcileSelections(
    tx: any,
    planId: number,
    rows: any[],
    searchRunId: string,
    createdBy: number,
    allowOfflineAutoSelection = true,
    eligibleRouteIds?: Set<number>,
    preferredMealPlanCode?: string | null,
    preferredMealPlanFlags?: { breakfast: number; lunch: number; dinner: number },
  ): Promise<HotelAvailabilityChangeSummary> {
    const changes: HotelAvailabilityChange[] = [];
    await this.removeStaleSelectionVersions(tx, planId);
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
        // Duplicate cleanup is an internal data-repair operation. It has no
        // hotel/rate transition to show the user, so do not expose an empty
        // Previous/Current card in the availability-refresh dialog.
      }

      if (isProtectedHotelSelection(selection)) continue;
      // Explicit offline fetches may add/refresh options, but they must not
      // replace an offline hotel the user already selected for this stay.
      if (allowOfflineAutoSelection && String(selection.hotel_provider || '').trim().toLowerCase() === 'offline') continue;

      const origin = selectionOriginFromRow(selection);
      const allOptions = this.expandRateOptions(rows.filter((row: any) =>
        hotelSelectionKeyFromRow(planId, row) === selectionKey,
      ));
      // A global meal plan controls automatic/default selections. A user
      // override is intentionally preserved across refreshes even when it
      // uses another meal plan.
      const authoritativeGroup = allOptions.some((row: any) => row.authoritativeRecommendation === true);
      const authoritativeAutoOptions = allOptions.filter((row: any) =>
        row.autoSelectionCandidate === true &&
        this.autoSelectionIdentityMatches(row, row.autoSelectionIdentity),
      );
      let options = origin === 'USER_SELECTED'
        ? allOptions
        : this.getEffectiveAutoSelectionPool(
            allOptions,
            preferredMealPlanCode,
            preferredMealPlanFlags,
            authoritativeAutoOptions,
            authoritativeGroup,
          );
      if (origin !== 'USER_SELECTED') {
        const liveOptions = allOptions.filter((option: any) =>
          String(option?.provider || option?.hotel_provider || '').trim().toLowerCase() !== 'offline',
        );
        const selectedLiveOptions = options.filter((option: any) =>
          String(option?.provider || option?.hotel_provider || '').trim().toLowerCase() !== 'offline',
        );
        // A meal-plan-filtered pool must not make an offline row look like the
        // only option when a live hotel exists for this route/day. Keep the
        // live option and let its actual meal plan be shown as the fallback.
        if (options.length > 0 && liveOptions.length > 0 && selectedLiveOptions.length === 0) {
          options = liveOptions;
        }
      }
      // Match the exact persisted supplier rate first. A parent hotel row can
      // contain several nested room/meal options and must never win with a
      // different identity or price.
      const matchedCandidate = options.find((row: any) => optionMatchesSelection(selection, row));
      const liveOptionsForSelection = options.filter((row: any) =>
        String(row?.provider || row?.hotel_provider || '').trim().toLowerCase() !== 'offline',
      );
      // A persisted AUTO_SELECTED offline row may still match the refreshed
      // snapshot. It must not win merely because its identity survived: when
      // a live option exists for this route/day, recompute the selection from
      // the live pool. Explicit USER_SELECTED offline rows are protected.
      const matched = origin !== 'USER_SELECTED' && liveOptionsForSelection.length > 0 &&
        String(matchedCandidate?.provider || matchedCandidate?.hotel_provider || '').trim().toLowerCase() === 'offline'
        ? null
        : matchedCandidate;
      // AUTO_SELECTED is recomputed from the current eligible snapshot. It
      // must never be pulled toward the previous price. USER_SELECTED keeps
      // the existing nearest same-property fallback for legacy review flows,
      // but an auto selection always follows the current lowest-price policy.
      const sameHotel = origin === 'USER_SELECTED'
        ? this.findNearestReplacement(
            selection,
            options.filter((row: any) => hotelPropertyMatchesSelection(selection, row)),
          )
        : null;
      const replacement = matched || sameHotel || (
        origin === 'USER_SELECTED'
          ? this.findNearestReplacement(selection, options)
          : this.findLowestReplacement(options)
      );
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
        } else {
          // An automatic selection is derived state. If the fresh snapshot no
          // longer has an option satisfying the itinerary meal plan, retaining
          // the old row falsely presents an EP/CP rate as the requested MAP.
          await tx.dvi_itinerary_plan_hotel_details.update({
            where: { itinerary_plan_hotel_details_ID: selection.itinerary_plan_hotel_details_ID },
            data: { status: 0, deleted: 1, updatedon: new Date() },
          });
          await tx.dvi_itinerary_plan_hotel_room_details.updateMany({
            where: { itinerary_plan_hotel_details_id: selection.itinerary_plan_hotel_details_ID, deleted: 0 },
            data: { status: 0, deleted: 1, updatedon: new Date() },
          });
          changes.push(this.buildChange('SELECTION_UNAVAILABLE', selection, null, {
            previous,
            selectionOrigin: origin,
          }));
        }
        continue;
      }

      const next = hotelDisplaySnapshot(replacement);
      // Any non-exact match means the old persisted rate is unavailable,
      // even when the same property has another fresh room/meal rate. The
      // replacement is therefore a complete fresh auto-selection.
      const replacementWasUnavailable = !matched;
      const nextSelectionOrigin = replacementWasUnavailable ? 'AUTO_SELECTED' : origin;
      const displayPriceDelta = Number(next.totalPrice || 0) - Number(previous.totalPrice || 0);

      await tx.dvi_itinerary_plan_hotel_details.update({
        where: { itinerary_plan_hotel_details_ID: selection.itinerary_plan_hotel_details_ID },
        data: this.buildSelectionUpdate(selection, replacement, nextSelectionOrigin, searchRunId),
      });
      await this.syncSelectedRoom(tx, selection, replacement, createdBy);

      if (replacementWasUnavailable) {
        changes.push(this.buildChange(origin === 'AUTO_SELECTED' ? 'AUTO_SELECTION_CHANGED' : 'SELECTION_REPLACED', selection, replacement, {
          previous,
          current: next,
          priceDelta: displayPriceDelta,
          selectionOrigin: origin,
        }));
      } else if (!matched && sameHotel) {
        changes.push(this.buildChange('RATE_CHANGED', selection, replacement, {
          previous,
          current: next,
          priceDelta: displayPriceDelta,
          selectionOrigin: origin,
        }));
      } else if (matched && Math.abs(displayPriceDelta) > 0.009) {
        changes.push(this.buildChange('PRICE_CHANGED', selection, replacement, {
          previous,
          current: next,
          priceDelta: displayPriceDelta,
          selectionOrigin: origin,
        }));
      }
    }

    // Existing rows are reconciled first. This invalidates stale automatic
    // selections after a category change before any new candidate is created.
    await this.ensureAutoSelections(
      tx,
      planId,
      rows,
      searchRunId,
      createdBy,
      allowOfflineAutoSelection,
      eligibleRouteIds,
      preferredMealPlanCode,
      preferredMealPlanFlags,
    );

    return { hasChanges: changes.length > 0, totalChanges: changes.length, changes };
  }

  /**
   * Make supplier rows safe to persist after a route/date edit.
   *
   * A supplier row is identified by its current route id, not by whatever
   * date the provider (or an in-memory response cache) happened to return.
   * Keeping both values creates a particularly bad failure mode: the stale
   * row can be auto-selected and its old price is then shown as the current
   * itinerary's price.  Normalize all date aliases before cache persistence
   * and before selection reconciliation.
   */
  private normalizeRowsToCurrentRouteDates(rows: any[], routes: any[]): any[] {
    const routeById = new Map<number, any>(
      (routes || [])
        .map((route: any) => [Number(route?.itinerary_route_ID || 0), route] as const)
        .filter(([routeId]) => routeId > 0),
    );

    const dateOnly = (value: unknown): string => this.toDateOnly(value);
    const routeIdsForRow = (row: any): number[] => {
      const rawRouteIds = Array.isArray(row?.routeIds)
        ? row.routeIds
        : Array.isArray(row?.route_ids)
          ? row.route_ids
          : [];
      const routeId = Number(row?.itineraryRouteId || row?.routeId || row?.route_id || 0);
      const routeIds: number[] = rawRouteIds
        .map((value: unknown): number => Number(value))
        .filter((value: number): boolean => value > 0);
      if (routeId > 0 && !routeIds.includes(routeId)) routeIds.unshift(routeId);
      return [...new Set(routeIds)];
    };

    return (rows || []).map((row: any) => {
      const routeIds = routeIdsForRow(row);
      const parentRouteId = Number(row?.itineraryRouteId || row?.routeId || row?.route_id || routeIds[0] || 0);
      const parentRoute = routeById.get(parentRouteId);
      if (!parentRoute) return row;

      const currentCheckIn = dateOnly(parentRoute.itinerary_route_date);
      if (!currentCheckIn) return row;

      const stayRoutes = (routeIds.length > 0 ? routeIds : [parentRouteId])
        .map((routeId) => routeById.get(routeId))
        .filter(Boolean);
      const lastStayRoute = stayRoutes[stayRoutes.length - 1] || parentRoute;
      const currentCheckOut = this.addDays(
        this.toDate(lastStayRoute.itinerary_route_date),
        1,
      ).toISOString().slice(0, 10);
      const priorDate = dateOnly(row?.date || row?.checkInDate || row?.check_in_date);

      if (priorDate && priorDate !== currentCheckIn) {
        this.logger.warn('[HOTEL_AVAILABILITY_ROUTE_DATE_NORMALIZED]', {
          routeId: parentRouteId,
          provider: row?.provider || row?.hotel_provider || 'unknown',
          hotelCode: row?.hotelCode || row?.hotel_code || row?.hotelId || null,
          supplierDate: priorDate,
          currentRouteDate: currentCheckIn,
        });
      }

      return {
        ...row,
        itineraryRouteId: parentRouteId,
        routeId: parentRouteId,
        itinerary_route_id: parentRouteId,
        routeIds: routeIds.length > 0 ? routeIds : [parentRouteId],
        itineraryRouteDate: currentCheckIn,
        itinerary_route_date: currentCheckIn,
        date: currentCheckIn,
        checkInDate: currentCheckIn,
        check_in_date: currentCheckIn,
        hotelCheckInDate: currentCheckIn,
        hotel_check_in_date: currentCheckIn,
        checkOutDate: currentCheckOut,
        check_out_date: currentCheckOut,
        hotelCheckOutDate: currentCheckOut,
        hotel_check_out_date: currentCheckOut,
      };
    });
  }

  /**
   * AxisRooms rows are database-backed. Reconcile every live row with the
   * newest covering occupancy row before it can enter the cache or selection
   * tables. This is deliberately a last-mile guard because older persisted
   * supplier snapshots can still contain baseHotelCost/price values.
   */
  private async applyAuthoritativeAxisRoomsRates(rows: any[], plan: any): Promise<any[]> {
    const axisRows = (rows || []).filter((row: any) =>
      String(row?.provider || row?.hotel_provider || '').trim().toLowerCase() === 'axisrooms',
    );
    if (axisRows.length === 0) return rows;

    const identities = axisRows.map((row: any) => {
      const reference = String(row?.rateOptionId || row?.rate_option_id || row?.bookingCode || row?.booking_code || '').trim();
      const match = reference.match(/(?:axisrooms:|AX-)([^:|-]+)[:|-]([^:|-]+)[:|-]([^:|-]+)(?::([^:|-]+))?/i);
      return {
        row,
        hotelId: Number(row?.canonicalHotelId || row?.hotelId || row?.hotel_id || match?.[1] || 0),
        roomId: Number(row?.roomId || row?.room_id || match?.[2] || 0),
        rateplanId: String(row?.rateplanId || row?.ratePlanId || row?.rateplan_id || match?.[3] || '').trim(),
        date: String(row?.date || row?.checkInDate || row?.check_in_date || '').slice(0, 10),
      };
    }).filter((item: any) => item.hotelId > 0 && item.roomId > 0 && item.rateplanId && /^\d{4}-\d{2}-\d{2}$/.test(item.date));
    if (identities.length === 0) return rows;

    const hotelIds = [...new Set(identities.map((item: any) => item.hotelId))];
    const roomIds = [...new Set(identities.map((item: any) => item.roomId))];
    const requestedMealPlanCode = this.getPlanMealPlanCode(plan);
    const requestedRateplanId = requestedMealPlanCode ? `${requestedMealPlanCode}_PLAN` : '';
    const rateplanIds = [...new Set([
      ...identities.map((item: any) => item.rateplanId),
      ...(requestedRateplanId ? [requestedRateplanId] : []),
    ])];
    const dates = identities.map((item: any) => item.date).sort();
    const occupancyRows = await (this.prisma as any).dvi_hotel_occupancy_rate.findMany({
      where: {
        hotel_id: { in: hotelIds },
        room_id: { in: roomIds },
        rateplan_id: { in: rateplanIds },
        start_date: { lte: new Date(`${dates[dates.length - 1]}T00:00:00.000Z`) },
        end_date: { gte: new Date(`${dates[0]}T00:00:00.000Z`) },
      },
      select: { hotel_id: true, room_id: true, rateplan_id: true, start_date: true, end_date: true, received_at: true, occupancy_rates: true },
    });

    const adults = Math.max(Math.trunc(Number(plan?.total_adult || 0)), 0);
    const roomCount = Math.max(Math.trunc(Number(plan?.preferred_room_count || 1)), 1);
    const adultsPerRoom = Math.max(Math.ceil(adults / roomCount), 1);
    const occupancyKey = adultsPerRoom <= 1 ? 'SINGLE' : 'DOUBLE';
    const extraBedCount = Math.max(Math.trunc(Number(plan?.total_extra_bed || 0)), 0);
    const childWithBedCount = Math.max(Math.trunc(Number(plan?.total_child_with_bed || 0)), 0);
    const childWithoutBedCount = Math.max(Math.trunc(Number(plan?.total_child_without_bed || 0)), 0);
    const rowKey = (hotelId: number, roomId: number, rateplanId: string) => `${hotelId}|${roomId}|${rateplanId}`;
    const matchingRows = new Map<string, any[]>();
    for (const occupancy of occupancyRows || []) {
      const key = rowKey(Number(occupancy.hotel_id), Number(occupancy.room_id), String(occupancy.rateplan_id || ''));
      const list = matchingRows.get(key) || [];
      list.push(occupancy);
      matchingRows.set(key, list);
    }

    const corrected = new Map<any, any>();
    for (const identity of identities) {
      // The supplier row may carry the first plan returned (for example AP)
      // while the itinerary requests CP.  The occupancy table is authoritative
      // for the requested plan, so use that plan's row when it exists instead
      // of treating a rateConditions label as a priced CP offer.
      const coversDate = (candidate: any): boolean =>
        new Date(candidate.start_date).getTime() <= new Date(`${identity.date}T00:00:00.000Z`).getTime() &&
        new Date(candidate.end_date).getTime() >= new Date(`${identity.date}T00:00:00.000Z`).getTime();
      const requestedCandidates = requestedRateplanId
        ? (matchingRows.get(rowKey(identity.hotelId, identity.roomId, requestedRateplanId)) || []).filter(coversDate)
        : [];
      const originalCandidates = (matchingRows.get(rowKey(identity.hotelId, identity.roomId, identity.rateplanId)) || []).filter(coversDate);
      const sourceCandidates = requestedCandidates.length > 0 ? requestedCandidates : originalCandidates;
      const effectiveRateplanId = requestedCandidates.length > 0
        ? requestedRateplanId
        : identity.rateplanId;
      const candidates = sourceCandidates
        .sort((a: any, b: any) => new Date(b.received_at || 0).getTime() - new Date(a.received_at || 0).getTime());
      let rates: any = null;
      for (const candidate of candidates) {
        const parsed = typeof candidate.occupancy_rates === 'string' ? this.parsePayload(candidate.occupancy_rates) : candidate.occupancy_rates;
        if (parsed && Number(parsed[occupancyKey]) > 0) { rates = parsed; break; }
      }
      const row = identity.row;
      if (!rates) {
        corrected.set(row, { ...row, price: 0, pricePerNight: 0, totalPrice: 0, totalStayPrice: 0, totalHotelCost: 0, isSelectable: false, isBookable: false, availabilityStatus: 'UNAVAILABLE', availabilityMessage: 'Hotel rate not available' });
        continue;
      }
      const roomRate = Number(rates[occupancyKey]);
      const extraBedRate = Number(rates.EXTRABED || rates.EXTRAADULT || 0);
      const childWithBedRate = Number(rates.CHILD_WITH_BED || 0);
      const childWithoutBedRate = Number(rates.CHILD_WITHOUT_BED || 0);
      const extraBedAmount = extraBedRate * extraBedCount;
      const childWithBedAmount = childWithBedRate * childWithBedCount;
      const childWithoutBedAmount = childWithoutBedRate * childWithoutBedCount;
      const rawTotal = roomRate * roomCount + extraBedAmount + childWithBedAmount + childWithoutBedAmount;
      const planLabel = requestedCandidates.length > 0 ? requestedMealPlanCode : null;
      const replaceRateplan = (value: unknown): string => String(value || '').replace(
        /(?:AP|MAP|CP|EP)_PLAN/i,
        effectiveRateplanId,
      );
      const correctedRateOptions = Array.isArray(row.rateOptions)
        ? row.rateOptions.map((option: any) => {
            const optionReference = String(option?.rateOptionId || option?.rate_option_id || option?.bookingCode || '').trim();
            const optionMatch = optionReference.match(/(?:axisrooms:|AX-)([^:|-]+)[:|-]([^:|-]+)[:|-]([^:|-]+)/i);
            const optionRateplan = String(option?.rateplanId || option?.ratePlanId || option?.rateplan_id || optionMatch?.[3] || '').trim();
            if (optionRateplan !== identity.rateplanId) return option;
            return {
              ...option,
              ...(planLabel ? {
                mealPlan: planLabel,
                mealPlanCode: planLabel,
                rateplanId: effectiveRateplanId,
                rateOptionId: replaceRateplan(option.rateOptionId || option.rate_option_id),
                bookingCode: replaceRateplan(option.bookingCode || option.booking_code),
                searchReference: replaceRateplan(option.searchReference || option.search_reference),
              } : {}),
              basePricePerNight: roomRate,
              baseHotelCost: roomRate * roomCount,
              baseTotalPrice: roomRate * roomCount,
              price: rawTotal,
              pricePerNight: rawTotal,
              totalPrice: rawTotal,
              totalStayPrice: rawTotal,
              totalHotelCost: rawTotal,
              extraBedRate,
              extraBedAmount,
              childWithBedRate,
              childWithBedAmount,
              childWithoutBedRate,
              childWithoutBedAmount,
              priceSource: 'DATABASE',
            };
          })
        : row.rateOptions;
      corrected.set(row, {
        ...row,
        ...(planLabel ? {
          mealPlan: planLabel,
          mealPlanCode: planLabel,
          rateplanId: effectiveRateplanId,
          rateOptionId: replaceRateplan(row.rateOptionId || row.rate_option_id),
          bookingCode: replaceRateplan(row.bookingCode || row.booking_code),
          searchReference: replaceRateplan(row.searchReference || row.search_reference),
        } : {}),
        basePricePerNight: roomRate,
        baseHotelCost: roomRate * roomCount,
        baseTotalPrice: roomRate * roomCount,
        price: rawTotal,
        pricePerNight: rawTotal,
        totalPrice: rawTotal,
        totalStayPrice: rawTotal,
        totalHotelCost: rawTotal,
        extraBedRate,
        extraBedAmount,
        childWithBedRate,
        childWithBedAmount,
        childWithoutBedRate,
        childWithoutBedAmount,
        rateOptions: correctedRateOptions,
        priceSource: 'DATABASE',
        isSelectable: true,
        isBookable: true,
        availabilityStatus: 'AVAILABLE',
        availabilityMessage: null,
      });
    }
    return (rows || []).map((row: any) => corrected.get(row) || row);
  }

  /**
   * Keep the group-scoped automatic recommendation separate from the
   * group-neutral shared inventory used by the manual hotel picker.
   */
  private extractAuthoritativeRecommendationRows(response: any): any[] {
    const rows = Array.isArray(response?.hotels) ? response.hotels : [];
    return rows.filter((row: any) => {
      const groupType = Number(row?.groupType || row?.group_type || 0);
      return groupType >= 1 && groupType <= 4 && (
        row?.authoritativeRecommendation === true ||
        row?.autoSelectionCandidate === true
      );
    });
  }

  /**
   * Route edits may retain a route ID while changing its calendar date. An
   * active selection from the previous route version must not remain eligible
   * for totals or block auto-selection of the current option.
   */
  private async removeStaleSelectionVersions(tx: any, planId: number): Promise<void> {
    const routeModel = tx?.dvi_itinerary_route_details;
    const selectionModel = tx?.dvi_itinerary_plan_hotel_details;
    if (!routeModel?.findMany || !selectionModel?.findMany || !selectionModel?.update || !planId) return;

    const routes = await routeModel.findMany({
      where: { itinerary_plan_ID: planId, deleted: 0 },
      select: { itinerary_route_ID: true, itinerary_route_date: true },
    });
    const routeDateById = new Map<number, string>();
    for (const route of routes || []) {
      const routeId = Number(route?.itinerary_route_ID || 0);
      const date = this.toDateOnly(route?.itinerary_route_date);
      if (routeId > 0 && date) routeDateById.set(routeId, date);
    }
    if (routeDateById.size === 0) return;

    const selections = await selectionModel.findMany({
      where: { itinerary_plan_id: planId, deleted: 0, status: 1, hotel_required: 1 },
      select: {
        itinerary_plan_hotel_details_ID: true,
        itinerary_route_id: true,
        itinerary_route_date: true,
        hotel_check_in_date: true,
        hotel_check_out_date: true,
        early_checkin: true,
        selected_price_snapshot: true,
      },
    });
    for (const selection of selections || []) {
      const routeId = Number(selection?.itinerary_route_id || 0);
      const expectedDate = routeDateById.get(routeId);
      if (!expectedDate) continue;

      const actualRouteDate = this.toDateOnly(selection?.itinerary_route_date);
      const earlyCheckIn = Number(selection?.early_checkin || 0) === 1;
      const actualHotelCheckIn = this.toDateOnly(selection?.hotel_check_in_date);
      const snapshot: any = parseHotelSelectionSnapshot(selection);
      const snapshotDate = this.toDateOnly(
        snapshot?.itineraryRouteDate ||
        snapshot?.itinerary_route_date ||
        snapshot?.checkInDate ||
        snapshot?.check_in_date ||
        snapshot?.date,
      );
      const hasRouteDateMismatch = Boolean(actualRouteDate && actualRouteDate !== expectedDate);
      const hasHotelDateMismatch = Boolean(
        !earlyCheckIn && actualHotelCheckIn && actualHotelCheckIn !== expectedDate,
      );
      const hasSnapshotDateMismatch = Boolean(
        !earlyCheckIn && snapshotDate && snapshotDate !== expectedDate,
      );
      if (!hasRouteDateMismatch && !hasHotelDateMismatch && !hasSnapshotDateMismatch) continue;

      await selectionModel.update({
        where: { itinerary_plan_hotel_details_ID: selection.itinerary_plan_hotel_details_ID },
        data: { status: 0, deleted: 1, updatedon: new Date() },
      });
      await tx?.dvi_itinerary_plan_hotel_room_details?.updateMany?.({
        where: { itinerary_plan_hotel_details_id: selection.itinerary_plan_hotel_details_ID, deleted: 0 },
        data: { status: 0, deleted: 1, updatedon: new Date() },
      });
    }
  }

  private getPlanMealPlanCode(plan: any): string | null {
    const explicit = inferCanonicalHotelRatePlanCode(String(plan?.meal_plan_code || ''));
    if (explicit) return explicit;
    const hasMealPlanFlags = Boolean(
      Number(plan?.meal_plan_breakfast || 0) ||
        Number(plan?.meal_plan_lunch || 0) ||
        Number(plan?.meal_plan_dinner || 0),
    );
    if (!hasMealPlanFlags) return null;
    return inferCanonicalHotelRatePlanCodeFromMealFlags(
      Number(plan?.meal_plan_breakfast || 0),
      Number(plan?.meal_plan_lunch || 0),
      Number(plan?.meal_plan_dinner || 0),
    );
  }

  private getPlanMealPlanFlags(plan: any): { breakfast: number; lunch: number; dinner: number } {
    return {
      breakfast: Number(plan?.meal_plan_breakfast || 0) === 1 ? 1 : 0,
      lunch: Number(plan?.meal_plan_lunch || 0) === 1 ? 1 : 0,
      dinner: Number(plan?.meal_plan_dinner || 0) === 1 ? 1 : 0,
    };
  }

  private getRowMealPlanCode(row: any): string | null {
    const values = [row?.mealPlan, row?.meal_plan, row?.mealPlanCode, row?.ratePlanName];
    for (const value of values) {
      const direct = inferCanonicalHotelRatePlanCode(String(value || ''));
      if (direct) return direct;
      const fromText = inferCanonicalHotelRatePlanCodeFromMealText(String(value || ''));
      if (fromText) return fromText;
    }
    return null;
  }

  private filterRowsByMealPlan(rows: any[], preferredMealPlanCode?: string | null): any[] {
    const normalized = String(preferredMealPlanCode || '').trim().toUpperCase();
    if (!normalized) return rows;
    return rows.filter((row: any) => this.getRowMealPlanCode(row) === normalized);
  }

  /**
   * Prefer the exact requested meal plan. When MAP has no priced option, CP is
   * preferred as the automatic fallback, followed by EP. The supplier identity
   * and meal plan are persisted unchanged; a fallback is never relabelled as MAP.
   */
  private getAutoSelectionPool(
    rows: any[],
    preferredMealPlanCode?: string | null,
    _preferredMealPlanFlags?: { breakfast: number; lunch: number; dinner: number },
  ): any[] {
    const preferred = String(preferredMealPlanCode || '').trim().toUpperCase();
    if (!preferred) return rows;
    const exactMatches = this.filterRowsByMealPlan(rows, preferred);
    if (exactMatches.length > 0) return exactMatches;
    if (preferred !== 'MAP') return [];
    const cpMatches = this.filterRowsByMealPlan(rows, 'CP');
    return cpMatches.length > 0 ? cpMatches : this.filterRowsByMealPlan(rows, 'EP');
  }

  /**
   * Apply the authoritative recommendation scope without allowing a missing
   * requested MAP rate to suppress a valid CP/EP fallback. The authoritative
   * scope remains preferred whenever it contains a compatible rate; only when
   * it does not do we fall back to the complete eligible pool.
   */
  private getEffectiveAutoSelectionPool(
    allOptions: any[],
    preferredMealPlanCode?: string | null,
    preferredMealPlanFlags?: { breakfast: number; lunch: number; dinner: number },
    authoritativeOptions: any[] = [],
    authoritativeGroup = false,
  ): any[] {
    const scopedOptions = Array.isArray(authoritativeOptions) && authoritativeOptions.length > 0
      ? authoritativeOptions
      : [];
    if (scopedOptions.length === 0) {
      if (authoritativeGroup && String(preferredMealPlanCode || '').trim().toUpperCase() !== 'MAP') return [];
      if (authoritativeGroup && String(preferredMealPlanCode || '').trim().toUpperCase() === 'MAP') {
        const completeMapFallback = this.getAutoSelectionPool(
          allOptions,
          preferredMealPlanCode,
          preferredMealPlanFlags,
        );
        if (completeMapFallback.length > 0) return completeMapFallback;
        return [];
      }
      return this.getAutoSelectionPool(allOptions, preferredMealPlanCode, preferredMealPlanFlags);
    }

    const preferred = String(preferredMealPlanCode || '').trim().toUpperCase();
    if (!preferred) return scopedOptions;

    if (preferred === 'MAP') {
      const scopedMap = this.filterRowsByMealPlan(scopedOptions, 'MAP');
      if (scopedMap.length > 0) return scopedMap;

      // Prefer CP over EP even when the authoritative subset contains only
      // EP. A MAP request with no MAP rate is explicitly allowed to use the
      // available CP rate without relabelling it.
      const scopedCp = this.filterRowsByMealPlan(scopedOptions, 'CP');
      if (scopedCp.length > 0) return scopedCp;
      const completeCp = this.filterRowsByMealPlan(allOptions, 'CP');
      if (completeCp.length > 0) return completeCp;
      const scopedEp = this.filterRowsByMealPlan(scopedOptions, 'EP');
      if (scopedEp.length > 0) return scopedEp;
      const completeEp = this.filterRowsByMealPlan(allOptions, 'EP');
      if (completeEp.length > 0) return completeEp;
      return scopedOptions;
    }

    const scopedCompatible = this.getAutoSelectionPool(
      scopedOptions,
      preferredMealPlanCode,
      preferredMealPlanFlags,
    );
    if (scopedCompatible.length > 0) return scopedCompatible;

    return scopedOptions;
  }

  private decorateMealPlanAutoSelectionBlockers(
    rows: any[],
    preferredMealPlanCode?: string | null,
    selectedByRouteGroup: Map<string, any> = new Map(),
    planId = 0,
  ): any[] {
    const preferred = String(preferredMealPlanCode || '').trim().toUpperCase();
    if (!preferred || rows.length === 0) return rows;

    const rowsByStay = new Map<string, any[]>();
    for (const row of rows) {
      const key = hotelSelectionKeyFromRow(planId, row);
      rowsByStay.set(key, [...(rowsByStay.get(key) || []), row]);
    }

    const blockedStayDetails = new Map<string, { codes: string[]; message: string }>();
    for (const [key, bucket] of rowsByStay.entries()) {
      const persisted = selectedByRouteGroup.get(key);
      if (persisted && selectionOriginFromRow(persisted) === 'USER_SELECTED') continue;

      const selectableOptions = this.expandRateOptions(bucket).filter((option: any) =>
        option?.isSelectable !== false &&
        option?.isBookable !== false &&
        option?.isPlaceholder !== true,
      );
      if (selectableOptions.length === 0) continue;
      if (selectableOptions.some((option: any) => this.getRowMealPlanCode(option) === preferred)) continue;

      const codes = Array.from(new Set(
        selectableOptions
          .map((option: any) => this.getRowMealPlanCode(option))
          .filter((code): code is string => Boolean(code)),
      )).sort();
      if (codes.length === 0) continue;
      const mealPlanFallbackApplied = preferred === 'MAP' && (codes.includes('CP') || codes.includes('EP'));
      blockedStayDetails.set(key, {
        codes,
        message: mealPlanFallbackApplied
          ? `${preferred} requested — price unavailable.`
          : `${preferred} requested — price unavailable. Select ${codes.join(' or ')} if acceptable.`,
      });
    }

    return rows.map((row: any) => {
      const details = blockedStayDetails.get(hotelSelectionKeyFromRow(planId, row));
      if (!details) return row;
      return {
        ...row,
        requestedMealPlanCode: preferred,
        availableMealPlanCodes: details.codes,
        autoSelectionBlocked: true,
        autoSelectionBlockCode: 'REQUESTED_MEAL_PLAN_PRICE_UNAVAILABLE',
        autoSelectionBlockMessage: details.message,
      };
    });
  }

  /**
   * Turn each cached hotel container into complete, concrete rate options for
   * reconciliation. The parent row is retained only when it has no nested
   * options; otherwise matching and persistence operate on one nested option
   * at a time so room/meal/identity/price fields cannot be mixed.
   */
  private expandRateOptions(rows: any[]): any[] {
    return (Array.isArray(rows) ? rows : []).flatMap((row: any) => {
      const nested = Array.isArray(row?.rateOptions) ? row.rateOptions : [];
      if (nested.length === 0) return [row];
      return nested.map((option: any) => ({
        ...row,
        ...option,
        provider: option?.provider || row?.provider,
        canonicalHotelId: option?.canonicalHotelId ?? row?.canonicalHotelId,
        hotelId: option?.hotelId ?? row?.hotelId,
        hotelCode: option?.hotelCode || row?.hotelCode || row?.providerHotelCode,
        hotelName: option?.hotelName || row?.hotelName,
        roomType: option?.roomType || option?.roomTypeName || row?.roomType,
        roomTypeName: option?.roomTypeName || option?.roomType || row?.roomTypeName,
        roomTypeId: option?.roomTypeId ?? option?.room_type_id ?? row?.roomTypeId,
        mealPlan: option?.mealPlan || option?.mealPlanCode || row?.mealPlan,
        rateOptionId: option?.rateOptionId || option?.rate_option_id,
        optionKey: option?.optionKey || option?.option_key,
        roomId: option?.roomId || option?.room_id,
        rateId: option?.rateId || option?.rate_id,
        bookingCode: option?.bookingCode || row?.bookingCode,
        searchReference: option?.searchReference || row?.searchReference,
      }));
    });
  }

  private async ensureAutoSelections(
    tx: any,
    planId: number,
    rows: any[],
    searchRunId: string,
    createdBy: number,
    allowOfflineAutoSelection = true,
    eligibleRouteIds?: Set<number>,
    preferredMealPlanCode?: string | null,
    preferredMealPlanFlags?: { breakfast: number; lunch: number; dinner: number },
  ): Promise<void> {
    if (!tx?.dvi_itinerary_plan_hotel_details?.findMany || !tx?.dvi_itinerary_plan_hotel_details?.create) return;

    const globalSettings = tx?.dvi_global_settings?.findFirst
      ? await tx.dvi_global_settings.findFirst({
          where: { deleted: 0, status: 1 },
          orderBy: { global_settings_ID: 'asc' },
          select: { hotel_margin: true },
        })
      : null;
    const defaultHotelMarginPercentage = Math.max(
      Number(globalSettings?.hotel_margin ?? process.env.HOTEL_MARGIN ?? 0),
      0,
    );
    const planModel = tx?.dvi_itinerary_plan_details?.findUnique
      ? tx.dvi_itinerary_plan_details
      : this.prisma?.dvi_itinerary_plan_details;
    const plan = planModel?.findUnique
      ? await planModel.findUnique({
          where: { itinerary_plan_ID: Number(planId) },
          select: {
            total_adult: true,
            total_child_with_bed: true,
            total_child_without_bed: true,
            total_extra_bed: true,
          } as any,
        })
      : null;

    // A hotel is not a valid automatic choice when the itinerary requests a
    // paid supplement but the selected rate does not provide that price. In
    // that case the hotel may have rooms, but it cannot fulfil this booking
    // request. Keep this rule in the backend so reset/rebuild cannot persist
    // a restricted hotel merely because its base room price is lowest.
    const missingRequiredSupplementReasons = (row: any): string[] => {
      const snapshot: any = parseHotelSelectionSnapshot(row);
      const hasRate = (...values: unknown[]): boolean =>
        values.some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
      const reasons: string[] = [];
      if (Number(plan?.total_extra_bed || 0) > 0 && !hasRate(
        row?.extraBedRate,
        row?.extra_bed_rate,
        row?.extraBedAmount,
        row?.total_extra_bed_cost,
        snapshot?.extraBedRate,
        snapshot?.extra_bed_rate,
        snapshot?.extraBedAmount,
      )) {
        reasons.push('Extra bed not available');
      }
      if (Number(plan?.total_child_with_bed || 0) > 0 && !hasRate(
        row?.childWithBedRate,
        row?.child_with_bed_rate,
        row?.childWithBedAmount,
        row?.total_childwith_bed_cost,
        snapshot?.childWithBedRate,
        snapshot?.child_with_bed_rate,
        snapshot?.childWithBedAmount,
      )) {
        reasons.push('Child with bed not available');
      }
      if (Number(plan?.total_child_without_bed || 0) > 0 && !hasRate(
        row?.childWithoutBedRate,
        row?.child_without_bed_rate,
        row?.childWithoutBedAmount,
        snapshot?.childWithoutBedRate,
        snapshot?.child_without_bed_rate,
        snapshot?.childWithoutBedAmount,
      )) {
        reasons.push('Child without bed not available');
      }
      return reasons;
    };

    const existing = await tx.dvi_itinerary_plan_hotel_details.findMany({
      where: { itinerary_plan_id: planId, deleted: 0, status: 1, hotel_required: 1 },
      select: {
        // Existing auto selections are updated or retired below. Keep the
        // primary key in this projection; without it Prisma receives
        // `where: { itinerary_plan_hotel_details_ID: undefined }` when a
        // duplicate recommendation is reconciled.
        itinerary_plan_hotel_details_ID: true,
        itinerary_route_id: true,
        itinerary_route_date: true,
        group_type: true,
        hotel_id: true,
        hotel_code: true,
        hotel_provider: true,
        hotel_booking_mode: true,
        price_source: true,
        selected_price_snapshot: true,
      },
    });
    const optionsByKey = new Map<string, any[]>();
    // Supplier hotel containers may expose the visible/default meal plan on
    // the parent row while the requested MAP/CP/AP variants live in
    // `rateOptions`. Automatic persistence must select a concrete nested rate,
    // not reject the whole hotel because only the parent's label was checked.
    for (const rawRow of this.expandRateOptions(rows)) {
      const authoritativeParentRouteId = Number(rawRow?.authoritativeParentRouteId || 0);
      const authoritativeRouteIds = Array.isArray(rawRow?.authoritativeRouteIds)
        ? rawRow.authoritativeRouteIds.map(Number).filter((value: number) => value > 0)
        : [];
      const row = authoritativeParentRouteId > 0
        ? {
            ...rawRow,
            itineraryRouteId: authoritativeParentRouteId,
            routeId: authoritativeParentRouteId,
            date: rawRow.authoritativeCheckInDate || rawRow.date || rawRow.checkInDate,
            checkInDate: rawRow.authoritativeCheckInDate || rawRow.checkInDate || rawRow.date,
            checkOutDate: rawRow.authoritativeCheckOutDate || rawRow.checkOutDate,
            routeIds: authoritativeRouteIds.length > 0 ? authoritativeRouteIds : rawRow.routeIds,
          }
        : rawRow;
      const rowProvider = String(row?.provider || row?.hotel_provider || '').trim().toLowerCase();
      const rowDate = String(row?.date || row?.checkInDate || row?.itineraryRouteDate || '').slice(0, 10);
      const routeNight = rowProvider === 'offline' && Array.isArray(row?.nightlyRates)
        ? row.nightlyRates.find((night: any) => String(night?.date || '').slice(0, 10) === rowDate)
        : null;
      const routeRoomCount = Math.max(Number(row?.roomCount || row?.noOfRooms || row?.total_no_of_rooms || 1), 1);
      const routePricedRow = routeNight
        ? {
            ...row,
            // Automatic selections are persisted per route/night. The offer's
            // totalStayPrice remains the continuous-stay amount, while these
            // fields must come from the matching nightlyRates entry.
            basePricePerNight: Number((Number(routeNight.baseAmount || 0) / routeRoomCount).toFixed(2)),
            baseTotalPrice: Number(routeNight.baseAmount || 0),
            baseHotelCost: Number(routeNight.baseAmount || 0),
            pricePerNight: Number(routeNight.sellAmount || 0),
            price: Number(routeNight.sellAmount || 0),
            hotelMarginAmount: Number(routeNight.marginAmount || 0),
          }
        : row;
      const canonicalHotelId = this.persistedHotelId(routePricedRow);
      const routeId = Number(routePricedRow.itineraryRouteId || routePricedRow.routeId || 0);
      const groupType = Number(routePricedRow.groupType || 0);
      if (eligibleRouteIds && !eligibleRouteIds.has(routeId)) continue;
      const approvalRequired = routePricedRow.requiresHotelApproval === true ||
        String(routePricedRow.requiresHotelApproval || '').trim().toLowerCase() === 'true' ||
        String(routePricedRow.availabilityStatus || '').trim().toUpperCase() === 'OFFLINE_APPROVAL_REQUIRED' ||
        String(routePricedRow.bookingMode || '').trim().toUpperCase() === 'MANUAL_APPROVAL';
      const approvalCandidate = routePricedRow.isBookable === false && approvalRequired && routePricedRow.isSelectable !== false;
      if ((!canonicalHotelId && !this.hasSupplierIdentity(routePricedRow)) || !routeId || !groupType ||
        (routePricedRow.isBookable === false && !approvalCandidate) || routePricedRow.isSelectable === false ||
        missingRequiredSupplementReasons(routePricedRow).length > 0) continue;
      const key = hotelSelectionKeyFromRow(planId, routePricedRow);
      const bucket = optionsByKey.get(key) || [];
      bucket.push({ ...routePricedRow, canonicalHotelId });
      optionsByKey.set(key, bucket);
    }

    // The inventory is shared by all recommendation groups, but automatic
    // selections must be distinct within a route. Existing manual/protected
    // selections are reserved first. Duplicate AUTO_SELECTED rows from an
    // older snapshot are retired so the next pass can fill that group with
    // the next unused hotel (or leave it unavailable when none remains).
    const reservedHotelIdsByRoute = new Map<number, Set<string>>();
    const hotelIdentity = (option: any): string => {
      const canonicalId = Number(option?.canonicalHotelId || option?.hotelId || 0);
      if (canonicalId > 0) return `id:${canonicalId}`;
      const name = String(option?.hotelName || '').trim().toLowerCase();
      const normalizedName = name.replace(/[^a-z0-9]+/g, '');
      if (normalizedName) return `name:${normalizedName}`;
      const provider = String(option?.provider || '').trim().toLowerCase();
      const code = String(option?.hotelCode || option?.providerHotelCode || option?.hotel_code || '').trim().toLowerCase();
      return `property:${provider}:${code}`;
    };
    const existingKeys = new Set<string>();
    const reserveExisting = (row: any): void => {
      const routeId = Number(row?.itinerary_route_id || 0);
      if (!routeId) return;
      const bucket = reservedHotelIdsByRoute.get(routeId) || new Set<string>();
      const identity = hotelIdentity(row);
      if (identity !== 'property::') bucket.add(identity);
      reservedHotelIdsByRoute.set(routeId, bucket);
      existingKeys.add(hotelSelectionKeyFromRow(planId, row));
    };

    const protectedExisting = existing.filter((row: any) =>
      isProtectedHotelSelection(row) || selectionOriginFromRow(row) === 'USER_SELECTED',
    );
    protectedExisting.forEach(reserveExisting);

    const autoExisting = existing
      .filter((row: any) => !protectedExisting.includes(row))
      .sort((left: any, right: any) => Number(left.group_type || 0) - Number(right.group_type || 0));
    for (const row of autoExisting) {
      const routeId = Number(row?.itinerary_route_id || 0);
      const identity = hotelIdentity(row);
      const bucket = reservedHotelIdsByRoute.get(routeId) || new Set<string>();
      if (missingRequiredSupplementReasons(row).length > 0) {
        if (tx.dvi_itinerary_plan_hotel_details?.update) {
          await tx.dvi_itinerary_plan_hotel_details.update({
            where: { itinerary_plan_hotel_details_ID: row.itinerary_plan_hotel_details_ID },
            data: { status: 0, deleted: 1, updatedon: new Date() },
          });
        }
        if (tx.dvi_itinerary_plan_hotel_room_details?.updateMany) {
          await tx.dvi_itinerary_plan_hotel_room_details.updateMany({
            where: { itinerary_plan_hotel_details_id: row.itinerary_plan_hotel_details_ID, deleted: 0 },
            data: { status: 0, deleted: 1, updatedon: new Date() },
          });
        }
        continue;
      }
      const fallbackFromGroup = Number((parseHotelSelectionSnapshot(row) as any)?.autoSelectionFallbackFromGroup || 0);
      const allowsFallbackDuplicate = Number(row?.group_type || 0) === 4 && fallbackFromGroup === 3;
      if (identity !== 'property::' && bucket.has(identity) && !allowsFallbackDuplicate) {
        if (tx.dvi_itinerary_plan_hotel_details?.update) {
          await tx.dvi_itinerary_plan_hotel_details.update({
            where: { itinerary_plan_hotel_details_ID: row.itinerary_plan_hotel_details_ID },
            data: { status: 0, deleted: 1, updatedon: new Date() },
          });
        }
        if (tx.dvi_itinerary_plan_hotel_room_details?.updateMany) {
          await tx.dvi_itinerary_plan_hotel_room_details.updateMany({
            where: { itinerary_plan_hotel_details_id: row.itinerary_plan_hotel_details_ID, deleted: 0 },
            data: { status: 0, deleted: 1, updatedon: new Date() },
          });
        }
        continue;
      }
      reserveExisting(row);
    }

    const orderedOptions = [...optionsByKey.entries()].sort(([leftKey], [rightKey]) => {
      const leftParts = leftKey.split('|');
      const rightParts = rightKey.split('|');
      return Number(leftParts[1] || 0) - Number(rightParts[1] || 0) ||
        Number(leftParts[2] || 0) - Number(rightParts[2] || 0) ||
        leftKey.localeCompare(rightKey);
    });
    const optionsByRoute = new Map<number, any[]>();
    for (const routeOptions of optionsByKey.values()) {
      for (const option of routeOptions) {
        const routeId = Number(option?.itineraryRouteId || option?.routeId || 0);
        const bucket = optionsByRoute.get(routeId) || [];
        bucket.push(option);
        optionsByRoute.set(routeId, bucket);
      }
    }

    for (const [key, options] of orderedOptions) {
      if (existingKeys.has(key)) continue;
      const optionRouteId = Number(options[0]?.itineraryRouteId || options[0]?.routeId || 0);
      const authoritativeGroup = options.some((option: any) => option.authoritativeRecommendation === true);
      const authoritativeOptions = options.filter((option: any) =>
        option.autoSelectionCandidate === true &&
        this.autoSelectionIdentityMatches(option, option.autoSelectionIdentity),
      );
      const selectionPool = this.getEffectiveAutoSelectionPool(
        options,
        preferredMealPlanCode,
        preferredMealPlanFlags,
        authoritativeOptions,
        authoritativeGroup,
      );
      // Automatic selection is per route/day. Prefer any live supplier option
      // in this route/group pool; only use offline catalog pricing when this
      // pool contains no live option. Manual/user-selected offline rows are
      // protected earlier and are not changed by this rule.
      const liveOptions = selectionPool.filter((option: any) =>
        String(option?.provider || option?.hotel_provider || '').trim().toLowerCase() !== 'offline',
      );
      const allLiveOptions = options.filter((option: any) =>
        String(option?.provider || option?.hotel_provider || '').trim().toLowerCase() !== 'offline',
      );
      const liveOptionsForStay = (optionsByRoute.get(optionRouteId) || []).filter((option: any) =>
        String(option?.provider || option?.hotel_provider || '').trim().toLowerCase() !== 'offline',
      );
      const eligibleLiveOptions = liveOptions.length > 0 ? liveOptions : allLiveOptions;
      const liveStayFallback = liveOptionsForStay.length > 0 && eligibleLiveOptions.length === 0
        ? liveOptionsForStay.map((option: any) => ({ ...option, groupType: options[0]?.groupType }))
        : [];
      // The offline fallback rule is scoped to the complete stay/day, not to
      // one recommendation tab. If any live option exists for this route,
      // never create an automatic offline selection for another group on the
      // same stay. Rebind the live candidate to the current group so the
      // recommendation package remains structurally valid.
      const eligibleOptions = liveStayFallback.length > 0
        ? liveStayFallback
        : selectionPool.length > 0 && allLiveOptions.length > 0
          ? eligibleLiveOptions
          : selectionPool;
      if (eligibleOptions.length === 0) continue;
      const sortedOptions = [...eligibleOptions].sort((a, b) => {
        const priceDelta = this.authoritativeAutoTotal(a) - this.authoritativeAutoTotal(b);
        if (priceDelta !== 0) return priceDelta;
        // When the payable amounts tie, prefer a live AxisRooms rate over
        // the offline catalogue.  The provider must be deterministic here;
        // optionKey ordering is not a business rule and could select the
        // offline copy merely because it sorts first.
        const providerRank = (provider: unknown): number => {
          const normalized = String(provider || '').trim().toLowerCase();
          if (normalized === 'axisrooms') return 0;
          if (normalized === 'tbo') return 1;
          if (normalized === 'staah') return 2;
          if (normalized === 'offline') return 3;
          return 4;
        };
        const providerDelta = providerRank(a?.provider || a?.hotel_provider) -
          providerRank(b?.provider || b?.hotel_provider);
        if (providerDelta !== 0) return providerDelta;
        return this.optionKey(a).localeCompare(this.optionKey(b));
      });
      const routeId = Number(sortedOptions[0]?.itineraryRouteId || sortedOptions[0]?.routeId || 0);
      const reserved = reservedHotelIdsByRoute.get(routeId) || new Set<string>();
      const distinctOption = sortedOptions.find((candidate: any) => {
        if (!reserved.has(hotelIdentity(candidate))) return true;
        return Number(candidate.groupType || 0) === 4 &&
          Number(candidate.autoSelectionFallbackFromGroup || 0) === 3;
      });
      // Distinct properties are preferred, but diversity is not an
      // availability requirement. Sparse routes (for example one valid
      // offline hotel for a requested category fallback) must still receive
      // an authoritative selection in every recommendation group.
      let option = distinctOption || sortedOptions[0];
      if (!option) continue;
      reserved.add(hotelIdentity(option));
      reservedHotelIdsByRoute.set(routeId, reserved);

      const provider = String(option.provider || 'external').trim().toLowerCase();
      const roomCount = Math.max(Number(option.roomCount || option.totalNoOfRooms || 1), 1);
      const persistedOptionHotelId = this.persistedHotelId(option);
      const hotelMaster = provider === 'axisrooms' && persistedOptionHotelId > 0 && tx?.dvi_hotel?.findUnique
        ? await tx.dvi_hotel.findUnique({
            where: { hotel_id: persistedOptionHotelId },
            select: { hotel_margin: true },
          })
        : null;
      const hotelMasterMargin = Number(hotelMaster?.hotel_margin || 0);
      const rawTotalPrice = hotelStayTotal(option, 1);
      const rawPricePerNight = Number(option.pricePerNight ?? option.price_per_night ?? option.price ?? rawTotalPrice);
      let baseTotalPrice = provider === 'staah'
        ? Math.max(Number(
            option.baseTotalPrice ??
            option.base_total_price ??
            option.baseHotelCost ??
            option.base_hotel_cost ??
            option.totalRoomCost ??
            option.total_room_cost ??
          rawPricePerNight * roomCount,
          ), 0)
        : provider === 'offline'
          ? Math.max(Number(
              option.baseTotalPrice ??
              option.base_total_price ??
              option.baseHotelCost ??
              option.base_hotel_cost ??
              option.totalRoomCost ??
              option.total_room_cost ??
              0,
            ), 0)
        : 0;
      let marginPercentage = provider === 'staah'
        ? Math.max(Number(option.hotelMarginPercentage ?? defaultHotelMarginPercentage), 0)
        : provider === 'axisrooms'
          ? Math.max(hotelMasterMargin > 0
            ? hotelMasterMargin
            : Number(option.hotelMarginPercentage ?? defaultHotelMarginPercentage), 0)
          : Number(option.hotelMarginPercentage ?? 0);
      const supplementAmount = (amount: unknown, cost: unknown, count: unknown, rate: unknown): number => {
        const explicit = Number(amount ?? cost ?? 0);
        if (Number.isFinite(explicit) && explicit > 0) return explicit;
        const quantity = Number(count ?? 0);
        const unitRate = Number(rate ?? 0);
        return Number.isFinite(quantity) && Number.isFinite(unitRate) && quantity > 0 && unitRate > 0
          ? quantity * unitRate
          : 0;
      };
      const supplementCount = (value: unknown, planValue: unknown): number => {
        const selectedCount = Number(value ?? 0);
        if (Number.isFinite(selectedCount) && selectedCount > 0) return selectedCount;
        const itineraryCount = Number(planValue ?? 0);
        return Number.isFinite(itineraryCount) && itineraryCount > 0 ? itineraryCount : 0;
      };
      const extraBedAmount = supplementAmount(
        option.extraBedAmount ?? option.extra_bed_amount,
        option.extraBedCost ?? option.totalExtraBedCost ?? option.total_extra_bed_cost,
        supplementCount(option.extraBedCount ?? option.extra_bed_count, plan?.total_extra_bed),
        option.extraBedRate ?? option.extra_bed_rate,
      );
      const childWithBedAmount = supplementAmount(
        option.childWithBedAmount ?? option.child_with_bed_amount,
        option.childWithBedCost ?? option.totalChildWithBedCost ?? option.total_childwith_bed_cost,
        supplementCount(option.childWithBedCount ?? option.child_with_bed_count, plan?.total_child_with_bed),
        option.childWithBedRate ?? option.child_with_bed_rate,
      );
      const childWithoutBedAmount = supplementAmount(
        option.childWithoutBedAmount ?? option.child_without_bed_amount,
        option.childWithoutBedCost ?? option.totalChildWithoutBedCost ?? option.total_childwithout_bed_cost,
        supplementCount(option.childWithoutBedCount ?? option.child_without_bed_count, plan?.total_child_without_bed),
        option.childWithoutBedRate ?? option.child_without_bed_rate,
      );
      const supplementTotal = Number((extraBedAmount + childWithBedAmount + childWithoutBedAmount).toFixed(2));
      let marginBaseTotal = Number((baseTotalPrice + supplementTotal).toFixed(2));
      let roomTaxAmount = provider === 'staah'
        ? Math.max(Number(option.totalHotelTaxAmount ?? option.taxAmount ?? 0), 0)
        : 0;
      let calculatedMargin = baseTotalPrice > 0
        ? Number((marginBaseTotal * marginPercentage / 100).toFixed(2))
        : 0;
      let totalPrice = provider === 'staah' && baseTotalPrice > 0
        ? Number(Math.max(rawTotalPrice, marginBaseTotal + roomTaxAmount + calculatedMargin).toFixed(2))
        : rawTotalPrice;
      let pricePerNight = provider === 'staah' && totalPrice > 0
        ? Number((totalPrice / roomCount).toFixed(2))
        : rawPricePerNight;

      if (provider === 'offline' && baseTotalPrice > 0) {
        marginBaseTotal = Number((baseTotalPrice + supplementTotal).toFixed(2));
        calculatedMargin = Number((marginBaseTotal * marginPercentage / 100).toFixed(2));
        totalPrice = Number((marginBaseTotal + calculatedMargin).toFixed(2));
        pricePerNight = totalPrice;
        option = {
          ...option,
          basePricePerNight: Number((baseTotalPrice / roomCount).toFixed(2)),
          baseTotalPrice,
          baseHotelCost: baseTotalPrice,
          extraBedCount: supplementCount(option.extraBedCount, plan?.total_extra_bed),
          extraBedRate: Number(option.extraBedRate ?? option.extra_bed_rate ?? 0),
          extraBedAmount,
          childWithBedCount: supplementCount(option.childWithBedCount, plan?.total_child_with_bed),
          childWithBedRate: Number(option.childWithBedRate ?? option.child_with_bed_rate ?? 0),
          childWithBedAmount,
          childWithoutBedCount: supplementCount(option.childWithoutBedCount, plan?.total_child_without_bed),
          childWithoutBedRate: Number(option.childWithoutBedRate ?? option.child_without_bed_rate ?? 0),
          childWithoutBedAmount,
          hotelMarginPercentage: marginPercentage,
          hotelMarginAmount: calculatedMargin,
          hotelMarginBaseAmount: marginBaseTotal,
          hotelMarginTotalAmount: calculatedMargin,
          pricePerNight,
          totalPrice,
          totalStayPrice: totalPrice,
          totalHotelCost: totalPrice,
        };
      }

      // AxisRooms occupancy rates are the authoritative room price for a
      // selected rate. The normalized supplier option can still carry an old
      // base/total pair from a previous search, so resolve the matching ARI
      // row before writing the durable hotel-detail row.
      if (provider === 'axisrooms') {
        // Occupancy rates are the only authoritative AxisRooms source.
        // Do not revive the legacy cached/base price when no rate exists.
        const axisBase = await this.resolveAxisRoomsBasePrice(tx, option, plan, roomCount);
        if (axisBase > 0) {
          baseTotalPrice = axisBase;
          marginBaseTotal = Number((baseTotalPrice + supplementTotal).toFixed(2));
          marginPercentage = Math.max(
            hotelMasterMargin > 0
              ? hotelMasterMargin
              : Number(option.hotelMarginPercentage ?? defaultHotelMarginPercentage),
            0,
          );
          roomTaxAmount = Math.max(Number(option.totalHotelTaxAmount ?? option.taxAmount ?? 0), 0);
          calculatedMargin = Number((marginBaseTotal * marginPercentage / 100).toFixed(2));
          totalPrice = Number((marginBaseTotal + roomTaxAmount + calculatedMargin).toFixed(2));
          pricePerNight = Number((totalPrice / roomCount).toFixed(2));
          option = {
            ...option,
            basePricePerNight: Number((baseTotalPrice / roomCount).toFixed(2)),
            baseTotalPrice,
            baseHotelCost: baseTotalPrice,
            hotelMarginPercentage: marginPercentage,
            hotelMarginAmount: calculatedMargin,
            hotelMarginBaseAmount: marginBaseTotal,
            extraBedAmount,
            childWithBedAmount,
            childWithoutBedAmount,
            hotelMarginTotalAmount: calculatedMargin,
            pricePerNight,
            totalPrice,
            totalStayPrice: totalPrice,
            totalHotelCost: totalPrice,
          };
        }
      }
      const optionKey = this.optionKey(option);
      const created = await tx.dvi_itinerary_plan_hotel_details.create({
        data: {
          itinerary_plan_id: planId,
          itinerary_route_id: Number(option.itineraryRouteId || option.routeId),
          itinerary_route_date: this.toDate(option.date || option.checkInDate),
          itinerary_route_location: String(option.destination || '').trim() || null,
          group_type: Number(option.groupType || 0),
          hotel_required: 1,
          hotel_category_id: Number(option.category || option.hotelCategory || 0),
          hotel_id: this.persistedHotelId(option),
          hotel_code: String(option.hotelCode || option.providerHotelCode || option.hotel_code || option.hotelId || '').trim() || null,
          hotel_provider: provider,
          hotel_booking_mode: option.bookingMode || (provider === 'offline' ? 'OFFLINE_MANUAL' : 'LIVE_API'),
          price_source: option.priceSource || (provider === 'offline' ? 'OFFLINE_DB' : 'LIVE_API'),
          is_live_rate: provider === 'offline' ? false : true,
          selected_rate_option_id: this.persistedRateOptionId(option),
          selected_price_per_night: pricePerNight,
          selected_total_price: totalPrice,
          selected_currency: option.currency || 'INR',
          selected_price_snapshot: JSON.stringify({
            ...hotelDisplaySnapshot(option),
            optionKey,
            ...(option.authoritativeStayKey ? {
              authoritativeStayKey: option.authoritativeStayKey,
              authoritativeParentRouteId: Number(option.authoritativeParentRouteId || option.itineraryRouteId || option.routeId || 0) || null,
              authoritativeRouteIds: Array.isArray(option.authoritativeRouteIds) ? option.authoritativeRouteIds.map(Number) : undefined,
              authoritativeCheckInDate: option.authoritativeCheckInDate || option.checkInDate || option.date || null,
              authoritativeCheckOutDate: option.authoritativeCheckOutDate || option.checkOutDate || null,
            } : {}),
            ...(option.itineraryMealPlanOverride === true ? {
              itineraryMealPlanOverride: true,
              sourceRateMealPlan: option.sourceRateMealPlan || null,
              mealPlan: option.mealPlan,
              mealPlanCode: option.mealPlanCode || option.mealPlan,
            } : {}),
            ...((provider === 'staah' || provider === 'axisrooms') && baseTotalPrice > 0 ? {
              basePricePerNight: Number((baseTotalPrice / roomCount).toFixed(2)),
              baseTotalPrice,
              roomCostTaxAmount: roomTaxAmount,
              hotelMarginPercentage: marginPercentage,
              hotelMarginAmount: calculatedMargin,
              hotelMarginBaseAmount: marginBaseTotal,
              extraBedAmount,
              childWithBedAmount,
              childWithoutBedAmount,
              pricePerNight,
              totalPrice,
            } : {}),
            selectionOrigin: 'AUTO_SELECTED',
            ...(Number(option.autoSelectionFallbackFromGroup || 0) > 0
              ? { autoSelectionFallbackFromGroup: Number(option.autoSelectionFallbackFromGroup) }
              : {}),
            availabilityStatus: provider === 'offline' ? 'OFFLINE_APPROVAL_REQUIRED' : 'AVAILABLE',
            searchRunId,
          }),
          hotel_approval_status: provider === 'offline' ? 'PENDING_APPROVAL' : 'NOT_REQUIRED',
          manual_confirmation_status: 'NOT_STARTED',
          total_no_of_rooms: roomCount,
          total_room_cost: hotelStayTotal({
            ...option,
            totalStayPrice: provider === 'staah' && baseTotalPrice > 0
              ? baseTotalPrice
              : provider === 'axisrooms' && baseTotalPrice > 0
                ? baseTotalPrice
              : option.baseHotelCost ?? option.totalHotelCost ?? totalPrice,
            pricePerNight,
          }, 1),
          total_extra_bed_cost: Number(option.extraBedAmount || 0),
          total_childwith_bed_cost: Number(option.childWithBedAmount || 0),
          hotel_margin_percentage: marginPercentage,
          hotel_margin_rate: calculatedMargin,
          total_room_gst_amount: roomTaxAmount,
          total_hotel_cost: totalPrice,
          total_hotel_tax_amount: roomTaxAmount,
          hotel_check_in_date: this.toDate(option.checkInDate || option.date),
          hotel_check_out_date: this.toDate(option.checkOutDate || this.addDays(this.toDate(option.checkInDate || option.date), 1)),
          createdby: createdBy || 0,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });
      await this.syncSelectedRoom(tx, created, option, createdBy);
      existingKeys.add(key);
    }
  }

  private findNearestReplacement(selection: any, options: any[], allowOfflineFallback = false): any | null {
    const selectable = options.filter((row: any) =>
      row?.isBookable !== false && row?.isSelectable !== false,
    );
    if (selectable.length === 0) return null;

    // Keep automatic replacement on live supplier inventory when any live
    // option exists. Offline options are a fallback only when the stay has no
    // live candidate; explicit user selections remain protected above.
    const liveOptions = selectable.filter((row: any) => String(row?.provider || '').toLowerCase() !== 'offline');
    const candidates = liveOptions.length > 0
      ? liveOptions
      : allowOfflineFallback
        ? selectable
        : [];
    const previousPrice = Number(
      selection?.selected_total_price ||
        selection?.total_hotel_cost ||
        parseHotelSelectionSnapshot(selection).totalPrice ||
        0,
    );
    const providerRank = (provider: unknown): number => {
      const normalized = String(provider || '').trim().toLowerCase();
      if (normalized === 'axisrooms') return 0;
      if (normalized === 'tbo') return 1;
      if (normalized === 'staah') return 2;
      if (normalized === 'offline') return 3;
      return 4;
    };
    const amount = (row: any): number => Number(
      row?.pricePerNight ?? row?.price_per_night ?? row?.totalHotelCost ?? row?.totalPrice ?? row?.totalStayPrice ?? row?.totalAmount ?? row?.price ?? 0,
    );

    return [...candidates].sort((left: any, right: any) => {
      const leftAmount = amount(left);
      const rightAmount = amount(right);
      const leftDistance = previousPrice > 0 && leftAmount > 0 ? Math.abs(leftAmount - previousPrice) : Number.MAX_SAFE_INTEGER;
      const rightDistance = previousPrice > 0 && rightAmount > 0 ? Math.abs(rightAmount - previousPrice) : Number.MAX_SAFE_INTEGER;
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      if (leftAmount !== rightAmount) return leftAmount - rightAmount;
      const providerDelta = providerRank(left?.provider) - providerRank(right?.provider);
      if (providerDelta !== 0) return providerDelta;
      return this.optionKey(left).localeCompare(this.optionKey(right));
    })[0] || null;
  }

  /**
   * AUTO_SELECTED policy: current eligible price first, deterministic
   * identity second. Historical selected price and supplier rank are not
   * inputs to this decision.
   */
  private authoritativeAutoTotal(row: any): number {
    const amount = Number(
      row?.totalStayPrice ??
      row?.totalPrice ??
      row?.totalHotelCost ??
      row?.totalAmountAfterTax ??
      row?.totalAmount ??
      row?.price ??
      row?.pricePerNight ??
      0,
    );
    return Number.isFinite(amount) && amount > 0 ? amount : Number.MAX_SAFE_INTEGER;
  }

  private autoSelectionIdentityMatches(option: any, identity: any): boolean {
    return strictAutoSelectionIdentityMatches(option, identity);
  }

  private findLowestReplacement(options: any[], allowOfflineFallback = true): any | null {
    const selectable = (options || []).filter((row: any) =>
      row?.isBookable !== false && row?.isSelectable !== false,
    );
    if (selectable.length === 0) return null;
    // Automatic selection is route/day scoped: a live supplier option always
    // wins when one exists for this route/day, regardless of price. Offline
    // catalog pricing is only an automatic fallback when this pool has no
    // live option. Explicit USER_SELECTED rows are handled separately and are
    // never replaced by this method.
    const liveOptions = selectable.filter((row: any) =>
      String(row?.provider || row?.hotel_provider || '').trim().toLowerCase() !== 'offline',
    );
    const candidates = liveOptions.length > 0
      ? liveOptions
      : allowOfflineFallback
        ? selectable
        : [];
    const providerRank = (provider: unknown): number => {
      const normalized = String(provider || '').trim().toLowerCase();
      if (normalized === 'axisrooms') return 0;
      if (normalized === 'tbo') return 1;
      if (normalized === 'staah') return 2;
      if (normalized === 'offline') return 3;
      return 4;
    };
    return [...candidates].sort((left, right) => {
      const priceDelta = this.authoritativeAutoTotal(left) - this.authoritativeAutoTotal(right);
      if (priceDelta !== 0) return priceDelta;
      const providerDelta = providerRank(left?.provider || left?.hotel_provider) -
        providerRank(right?.provider || right?.hotel_provider);
      return providerDelta || this.optionKey(left).localeCompare(this.optionKey(right));
    })[0] || null;
  }

  private buildSelectionUpdate(selection: any, option: any, origin: string, searchRunId: string): Record<string, unknown> {
    const priorSnapshot = parseHotelSelectionSnapshot(selection);
    const { autoSelectionFallbackFromGroup: _oldFallback, ...priorSnapshotWithoutFallback } = priorSnapshot as any;
    const optionKey = String(option.optionKey || hotelOptionKey(option));
    const pricePerNight = Number(option.pricePerNight || option.price_per_night || option.price || option.totalHotelCost || option.totalStayPrice || 0);
    const totalPrice = hotelStayTotal(option, 1);
    return {
      hotel_id: this.persistedHotelId(option, selection.hotel_id),
      hotel_code: String(option.hotelCode || option.providerHotelCode || option.hotel_code || option.hotelId || selection.hotel_code || '').trim() || null,
      hotel_category_id: Number(option.category || selection.hotel_category_id || 0),
      hotel_provider: option.provider || selection.hotel_provider || null,
      hotel_booking_mode: option.bookingMode || selection.hotel_booking_mode || 'LIVE_API',
      price_source: option.priceSource || selection.price_source || 'LIVE_API',
      itinerary_route_id: Number(option.itineraryRouteId || option.routeId || selection.itinerary_route_id || 0),
      itinerary_route_date: this.toDate(option.date || option.checkInDate || selection.itinerary_route_date),
      itinerary_route_location: option.destination || selection.itinerary_route_location || null,
      hotel_check_in_date: option.checkInDate || option.date
        ? this.toDate(option.checkInDate || option.date)
        : selection.hotel_check_in_date || null,
      hotel_check_out_date: option.checkOutDate
        ? this.toDate(option.checkOutDate)
        : selection.hotel_check_out_date || null,
      is_live_rate: option.provider === 'offline' ? false : true,
      selected_rate_option_id: this.persistedRateOptionId(option, selection.selected_rate_option_id),
      selected_price_per_night: pricePerNight,
      selected_total_price: totalPrice,
      selected_currency: option.currency || selection.selected_currency || null,
      total_room_cost: Number(option.baseTotalPrice || option.baseHotelCost || option.totalHotelCost || totalPrice),
      total_extra_bed_cost: Number(option.extraBedAmount || 0),
      total_childwith_bed_cost: Number(option.childWithBedAmount || 0),
      total_hotel_cost: totalPrice,
      total_hotel_tax_amount: Number(option.totalHotelTaxAmount || selection.total_hotel_tax_amount || 0),
      selected_price_snapshot: JSON.stringify({
        ...priorSnapshotWithoutFallback,
        ...hotelDisplaySnapshot(option),
        optionKey,
        ...(option.authoritativeStayKey ? {
          authoritativeStayKey: option.authoritativeStayKey,
          authoritativeParentRouteId: Number(option.authoritativeParentRouteId || option.itineraryRouteId || option.routeId || 0) || null,
          authoritativeRouteIds: Array.isArray(option.authoritativeRouteIds) ? option.authoritativeRouteIds.map(Number) : undefined,
          authoritativeCheckInDate: option.authoritativeCheckInDate || option.checkInDate || option.date || null,
          authoritativeCheckOutDate: option.authoritativeCheckOutDate || option.checkOutDate || null,
        } : {}),
        rateOptionId: option.rateOptionId || option.optionKey || option.searchReference || option.bookingCode || null,
        extraBedCount: Number(option.extraBedCount || 0),
        extraBedRate: Number(option.extraBedRate || 0),
        extraBedAmount: Number(option.extraBedAmount || 0),
        childWithBedCount: Number(option.childWithBedCount || 0),
        childWithBedRate: Number(option.childWithBedRate || 0),
        childWithBedAmount: Number(option.childWithBedAmount || 0),
        selectionOrigin: origin,
        ...(Number(option.autoSelectionFallbackFromGroup || 0) > 0
          ? { autoSelectionFallbackFromGroup: Number(option.autoSelectionFallbackFromGroup) }
          : {}),
        availabilityStatus: 'AVAILABLE',
        searchRunId,
      }),
      requires_price_reacceptance: origin === 'USER_SELECTED' &&
        Number(selection.selected_total_price || selection.total_hotel_cost || 0) > 0 &&
        Math.abs(Number(selection.selected_total_price || selection.total_hotel_cost || 0) - totalPrice) > 0.009,
      updatedon: new Date(),
    };
  }

  private async resolveAxisRoomsBasePrice(
    tx: any,
    option: any,
    plan: any,
    roomCount: number,
  ): Promise<number> {
    const reference = String(
      option?.rateOptionId || option?.rate_option_id || option?.bookingCode || option?.booking_code || '',
    ).trim();
    const match = reference.match(/(?:axisrooms:|AX-)([^:|-]+)[:|-]([^:|-]+)[:|-]([^:|-]+)/i);
    const hotelId = Number(option?.canonicalHotelId || option?.hotelId || option?.hotel_id || match?.[1] || 0);
    const roomId = Number(option?.roomId || option?.room_id || match?.[2] || 0);
    const rateplanId = String(option?.rateplanId || option?.ratePlanId || option?.rateplan_id || match?.[3] || '').trim();
    const dateText = String(option?.date || option?.checkInDate || '').slice(0, 10);
    const occupancyModel = tx?.dvi_hotel_occupancy_rate;
    if (!hotelId || !roomId || !rateplanId || !/^\d{4}-\d{2}-\d{2}$/.test(dateText) || !occupancyModel?.findMany) {
      return 0;
    }

    const rows = await occupancyModel.findMany({
      where: {
        hotel_id: hotelId,
        room_id: roomId,
        rateplan_id: rateplanId,
        start_date: { lte: new Date(`${dateText}T00:00:00.000Z`) },
        end_date: { gte: new Date(`${dateText}T00:00:00.000Z`) },
      },
      select: { occupancy_rates: true, start_date: true, received_at: true },
      orderBy: [{ start_date: 'desc' }, { received_at: 'desc' }],
    });
    const adults = Math.max(Math.trunc(Number(plan?.total_adult || 0)), 0);
    const adultsPerRoom = Math.max(Math.ceil(adults / Math.max(roomCount, 1)), 1);
    const occupancyKey = adultsPerRoom <= 1 ? 'SINGLE' : 'DOUBLE';

    const sortedRows = [...(Array.isArray(rows) ? rows : [])].sort((a: any, b: any) => {
      const receivedDelta = new Date(b?.received_at || 0).getTime() - new Date(a?.received_at || 0).getTime();
      if (receivedDelta !== 0) return receivedDelta;
      return new Date(b?.start_date || 0).getTime() - new Date(a?.start_date || 0).getTime();
    });
    let rates: Record<string, unknown> | null = null;
    for (const candidate of sortedRows) {
      try {
        const parsed = typeof candidate?.occupancy_rates === 'string'
          ? JSON.parse(candidate.occupancy_rates)
          : (candidate?.occupancy_rates || {});
        const candidateRate = Number(parsed?.[occupancyKey]);
        if (Number.isFinite(candidateRate) && candidateRate > 0) {
          rates = parsed;
          break;
        }
      } catch {
        // Ignore malformed historical rows and continue looking for a valid rate.
      }
    }
    if (!rates) return 0;
    const roomRate = Number(rates[occupancyKey]);

    const extraBeds = Math.max(Math.trunc(Number(plan?.total_extra_bed || 0)), 0);
    const extraBedRate = Number(rates.EXTRABED ?? rates.EXTRAADULT ?? rates.EXTRACHILD ?? 0);
    const total = roomRate * Math.max(roomCount, 1) +
      (Number.isFinite(extraBedRate) && extraBedRate > 0 ? extraBedRate * extraBeds : 0);
    return Number.isFinite(total) && total > 0 ? Number(total.toFixed(2)) : 0;
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
    const requestedBreakfast = Number(option.mealPlanBreakfast);
    const requestedLunch = Number(option.mealPlanLunch);
    const requestedDinner = Number(option.mealPlanDinner);
    const hasExplicitMealFlags = [requestedBreakfast, requestedLunch, requestedDinner]
      .every((value) => value === 0 || value === 1);
    // Supplier room identifiers are often opaque strings (for example
    // `room-1`).  They are kept in the availability snapshot, but this legacy
    // room-details table stores only the local numeric room id.  Passing
    // Number('room-1') produces NaN, which Prisma rejects and which previously
    // rolled back the entire availability snapshot during reset.
    const persistedHotelId = this.persistedHotelId(option, selection.hotel_id);
    const hotelRoomRows = (tx as any).dvi_hotel_rooms?.findMany && persistedHotelId > 0
      ? await (tx as any).dvi_hotel_rooms.findMany({
        where: { hotel_id: persistedHotelId, deleted: 0 },
        select: { room_ID: true, room_type_id: true, room_title: true, room_ref_code: true },
      })
      : [];
    const normalizeRoomText = (value: unknown): string =>
      String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
    const incomingRoomTitle = normalizeRoomText(
      option.roomTypeName || option.roomType || option.roomName || option.room_type,
    );
    const incomingRoomRef = normalizeRoomText(option.roomId || option.roomCode || option.roomRefCode);
    const incomingRoomTypeId = Number(option.roomTypeId || 0);
    const matchedLocalRoom = hotelRoomRows.find((candidate: any) =>
      (incomingRoomRef && normalizeRoomText(candidate.room_ref_code) === incomingRoomRef) ||
      (incomingRoomTitle && normalizeRoomText(candidate.room_title) === incomingRoomTitle) ||
      (incomingRoomTypeId > 0 && Number(candidate.room_type_id || 0) === incomingRoomTypeId),
    );
    const existingRoomTypeId = Number(room?.room_type_id || selection.room_type_id || 0);
    const existingRoomId = Number(room?.room_id || selection.room_id || 0);
    // Room-category edits are user choices. Never replace a valid local room
    // category with a supplier's opaque/zero roomTypeId during availability
    // reconciliation. Supplier data is only used when no local category has
    // been selected yet.
    const roomTypeId = existingRoomTypeId > 0
      ? existingRoomTypeId
      : Number(matchedLocalRoom?.room_type_id || incomingRoomTypeId || 0);
    const roomId = existingRoomId > 0
      ? existingRoomId
      : Number(matchedLocalRoom?.room_ID || option.roomId || 0) || 0;
    const pricePerNight = Number(option.pricePerNight || option.price_per_night || option.price || option.totalHotelCost || option.totalStayPrice || 0);
    const roomData = {
      group_type: Number(selection.group_type || option.groupType || 0),
      itinerary_plan_id: Number(selection.itinerary_plan_id),
      itinerary_route_id: Number(selection.itinerary_route_id),
      itinerary_route_date: this.toDate(option.date || option.checkInDate || selection.itinerary_route_date),
      hotel_id: persistedHotelId,
      room_type_id: roomTypeId,
      room_id: roomId,
      room_qty: Math.max(Number(selection.total_no_of_rooms || 1), 1),
      room_rate: pricePerNight,
      total_room_cost: hotelStayTotal(option, 1),
      breakfast_required: hasExplicitMealFlags ? requestedBreakfast : (/CP|MAP|AP|BREAKFAST|ALL/.test(meal) ? 1 : 0),
      lunch_required: hasExplicitMealFlags ? requestedLunch : (/MAP|AP|LUNCH|ALL/.test(meal) ? 1 : 0),
      dinner_required: hasExplicitMealFlags ? requestedDinner : (/MAP|AP|DINNER|ALL/.test(meal) ? 1 : 0),
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

  private toDateOnly(value: unknown): string {
    const parsed = value instanceof Date ? value : new Date(String(value || ''));
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
  }

  private addDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setUTCDate(result.getUTCDate() + Math.max(1, days || 1));
    return result;
  }
}
