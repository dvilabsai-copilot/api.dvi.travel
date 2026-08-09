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
import { OfflineHotelCatalogService } from './offline-hotel-catalog.service';
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
  parseHotelSelectionSnapshot,
  selectionOriginFromRow,
  selectedOptionKeyFromRow,
} from '../utils/hotel-selection-identity.util';
import { resolveHotelRecommendationAlgorithm } from './hotel-recommendation-package.service';
import {
  inferCanonicalHotelRatePlanCode,
  inferCanonicalHotelRatePlanCodeFromMealFlags,
  inferCanonicalHotelRatePlanCodeFromMealText,
} from '../../hotels/hotel-rate-plans';
import { hotelStayTotal } from '../utils/hotel-stay-pricing.util';

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
  ) {}

  optionKey(row: any): string {
    return hotelOptionKey(row);
  }

  private money(amount: number): number {
    return Math.round(Number(amount || 0) * 100) / 100;
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
      if (exact) return exact;
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
    const planRows = await (this.prisma as any).dvi_itinerary_plan_hotel_details.findMany({
      // Only hotel_required=1 rows are editable hotel selections.  Previous
      // night billing markers (2) and non-required legacy rows must never be
      // allowed to reappear as a selected hotel after a reset.
      where: { itinerary_plan_id: plan.itinerary_plan_ID, hotel_required: 1, deleted: 0, status: 1 },
      orderBy: { itinerary_plan_hotel_details_ID: 'desc' },
    });
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
        destination: row.destination || currentRoute.next_visiting_location || currentRoute.location_name,
      };
    };
    // Persisted hotel selections and room-category rows can retain route IDs
    // from before an itinerary route rebuild. Normalize them with the same
    // date-based mapping used for availability rows before building the
    // selection map; otherwise a saved per-day meal-plan choice is invisible
    // to the current snapshot and the auto-selected row wins on reload.
    const remappedPlanRows = planRows.map(remapSnapshotRoute).filter(Boolean);
    const remappedRoomDetailRows = roomDetailRows.map(remapSnapshotRoute).filter(Boolean);
    const noOfNights = Math.max(Number((plan as any).no_of_nights || 0), 0);
    const searchableRoutes = currentRoutes.filter((route: any, index: number) => {
      const isLastRoute = index === currentRoutes.length - 1;
      return !(isLastRoute && index >= noOfNights);
    });

    const selectedByRouteGroup = new Map<string, any>();
    for (const row of remappedPlanRows) {
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
    }>();
    remappedRoomDetailRows.forEach((row: any) => {
      const key = hotelSelectionKey(
        plan.itinerary_plan_ID,
        Number(row.itinerary_route_id || 0),
        Number(row.group_type || 0),
        row.itinerary_route_date,
      );
      if (!key) return;
      const existingSelection = selectedByRouteGroup.get(key);
      const persistedSelectionId = Number(existingSelection?.itinerary_plan_hotel_details_ID || 0);
      const roomDetailSelectionId = Number(row.itinerary_plan_hotel_details_id || 0);
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
      const current = roomSelectionsByRouteGroup.get(key) || {
        hotelId: Number(row.hotel_id || 0),
        roomCount: 0,
        roomTypeKeys: new Set<string>(),
        roomTypeLabels: [],
      };
      current.hotelId = Number(current.hotelId || row.hotel_id || 0);
      (current as any).routeId = Number(row.itinerary_route_id || 0);
      (current as any).groupType = Number(row.group_type || 0);
      (current as any).routeDate = row.itinerary_route_date || null;
      current.roomCount += Math.max(Number(row.room_qty || 1), 1);
      if (roomTypeKey) current.roomTypeKeys.add(roomTypeKey);
      if (roomTypeLabel && !current.roomTypeLabels.includes(roomTypeLabel)) current.roomTypeLabels.push(roomTypeLabel);
      roomSelectionsByRouteGroup.set(key, current);
    });
    roomSelectionsByRouteGroup.forEach((roomSelection: any, key: string) => {
      const existingSelection = selectedByRouteGroup.get(key);
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
      if (!shouldOverrideSelection) return;
      const primaryRoomType = roomSelection.roomTypeLabels[0] || '';
      selectedByRouteGroup.set(key, {
        ...(existingSelection || {}),
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

    let normalizedRows = snapshotRows
      .filter(Boolean)
      .map(remapSnapshotRoute)
      .filter(Boolean)
      .filter((row: any) => !currentRouteIds.size || currentRouteIds.has(Number(row.itineraryRouteId || 0)))
      .map((row: any) => this.normalizeRatePlanLabels(row))
      .map((row: any) => this.decorateSelection(row, selectedByRouteGroup, plan.itinerary_plan_ID)) as any[];

    // A room-category edit intentionally changes the selected rate/room
    // identity. The availability snapshot can still contain the same hotel
    // property under a different room/rate, so first find an exact match and
    // only then fall back to the first row for the same property. Without this
    // two-pass mapping the old recommendation remains visible while the saved
    // selection is treated as unavailable.
    const exactSelectionKeys = new Set(
      normalizedRows
        .filter((row: any) => {
          const selection = selectedByRouteGroup.get(hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row));
          return Boolean(selection && this.rowMatchesSelection(selection, row));
        })
        .map((row: any) => hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row)),
    );
    const propertyFallbackKeys = new Set<string>();
    normalizedRows = normalizedRows.map((row: any) => {
      const key = hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row);
      const selection = selectedByRouteGroup.get(key);
      if (!selection || exactSelectionKeys.has(key) || propertyFallbackKeys.has(key)) return row;
      if (!hotelPropertyMatchesSelection(selection, row)) return row;
      propertyFallbackKeys.add(key);
      return this.decoratePropertySelection(row, selection, plan.itinerary_plan_ID);
    });

    const appliedRoomSelectionKeys = new Set<string>();
    normalizedRows = normalizedRows.map((row: any) => {
      const key = hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row);
      if (selectedByRouteGroup.has(key)) return row;
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
          const selection = selectedByRouteGroup.get(hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row));
          return Boolean(selection && (
            row.isSelected ||
            this.rowMatchesSelection(selection, row) ||
            hotelPropertyMatchesSelection(selection, row)
          ));
        })
        .map((row: any) => hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row)),
    );
    normalizedRows = normalizedRows.map((row: any) => {
      const selection = selectedByRouteGroup.get(hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row));
      if (!selection || this.rowMatchesSelection(selection, row)) return row;
      const key = hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row);
      if (matchedSelectionKeys.has(key)) return row;
      if (markedUnavailable.has(key)) return row;
      markedUnavailable.add(key);
      return this.decorateUnavailableSelection(row, selection);
    });

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

    if (options.groupType && options.groupType > 0) {
      normalizedRows = normalizedRows.filter((row) => Number(row.groupType || 0) === Number(options.groupType));
    }
    if (options.itineraryRouteId && options.itineraryRouteId > 0) {
      normalizedRows = normalizedRows.filter((row) => Number(row.itineraryRouteId || 0) === Number(options.itineraryRouteId));
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
    // The recommendation payload is historical metadata. Once a user has
    // selected rates, the selected payable rows are the authoritative package
    // total for that group; keep the tab and summary on the same calculation.
    const selectedTotalsByGroup = new Map<number, number>();
    normalizedRows
      .filter((row: any) => String(row?.selectionOrigin || '').trim().toUpperCase() === 'USER_SELECTED')
      .forEach((row: any) => {
        const group = Number(row?.groupType || 0);
        const amount = Number(row?.selectedTotalPrice ?? row?.totalPrice ?? row?.totalHotelCost ?? 0);
        if (group >= 1 && group <= 4 && Number.isFinite(amount) && amount > 0) {
          selectedTotalsByGroup.set(group, Number(((selectedTotalsByGroup.get(group) || 0) + amount).toFixed(2)));
        }
      });
    const tabs = builtTabs.map((tab: any) => {
      const selectedTotal = selectedTotalsByGroup.get(Number(tab?.groupType || 0));
      return selectedTotal && selectedTotal > 0
        ? { ...tab, totalAmount: selectedTotal, partialTotal: tab.partialTotal == null ? tab.partialTotal : selectedTotal }
        : tab;
    });
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
        emptyStayBlocks,
        stayRoutes,
        offlineFetch: latestPayload?.offlineFetch,
        unavailableSelectionCount: remappedPlanRows.filter((row: any) => !isSpecialHotelPlanRow(row))
          .filter((row: any) => !normalizedRows.some((hotel: any) =>
            hotel.isSelected && Number(hotel.selectionId || 0) === Number(row.itinerary_plan_hotel_details_ID),
          )).length,
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
        resetSelections,
      );
      logStage('supplier-and-provider-search', liveSearchStartedAt);
      // Supplier responses can contain a route id from the current itinerary
      // together with a stale stay date (this is especially easy to reproduce
      // after editing dates and then resetting availability).  Never persist
      // that mixed identity: the current route table is authoritative for the
      // stay dates used by the snapshot and by auto-selection.
      const currentDatedLiveRows = this.normalizeRowsToCurrentRouteDates(
        Array.isArray(liveResponse.hotels) ? liveResponse.hotels : [],
        routes,
      );
      const sourceRows = this.filterSearchableLiveRows(
        currentDatedLiveRows,
        searchableRouteIds,
      );
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
      );
      logStage('offline-fetch-in-reset-coordinator', offlineFetchStartedAt);
      const recommendationGroupTypes = await this.getRecommendationGroupTypes(plan.itinerary_plan_ID, [], sourceRows);
      const offlineRows = this.materializeOfflineRows(offlineByRoute, routes, recommendationGroupTypes);
      // Apply the same route-date authority to every provider, including the
      // offline catalog.  This keeps a mixed supplier response from becoming
      // a mixed-date cache row after an itinerary edit.
      let rows = this.normalizeRowsToCurrentRouteDates(
        [...sourceRows, ...offlineRows],
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
      rows = this.dedupeRows(rows);
      const storageRows = this.coalesceRowsForCache(rows);
      const recommendationTabs = Array.isArray((liveResponse as any).hotelTabs)
        ? (liveResponse as any).hotelTabs
        : [];
      const cacheRows = storageRows.length > 0
        ? storageRows
        : [this.buildEmptySnapshotRow(plan, quoteId, searchRunId, checkedAt)];
      const persistenceStartedAt = Date.now();
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
            rating: Number(row.category || row.rating || 0),
            // `price` is the catalog/display amount stored with the snapshot.
            // Prefer the supplier stay total over a derived/gross field that
            // may include a margin. The selected payable total is stored on
            // the plan selection record and hydrated separately.
            price: Number(row.totalStayPrice ?? row.totalPrice ?? row.totalHotelCost ?? row.pricePerNight ?? row.price ?? 0),
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
        );
      });
      logStage('snapshot-persistence-and-selection-reconciliation', persistenceStartedAt);

      const readStartedAt = Date.now();
      const response = await this.readPersisted(quoteId, { page: 1, pageSize: 0 });
      logStage('read-persisted-response', readStartedAt);
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
          const response = await this.readPersisted(quoteId, { page: 1, pageSize: 100 });
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
      ? hotels.filter((row: any) => Number(row?.itineraryRouteId || row?.routeId || row?.route_id || 0) === normalizedRouteId)
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
    );
    const row = { ...rows[0], rateOptions };
    const numericRating = Number(row.rating);
    const categoryRating = Number(String(row.category || '').match(/\d+(?:\.\d+)?/)?.[0] || 0);
    const rating = Number.isFinite(numericRating) ? numericRating : categoryRating;

    await this.prisma.$transaction(async (tx) => {
      const txCache = (tx as any).dvi_itinerary_hotel_search_cache;
      const existingRows = await txCache.findMany({
        where: {
          quote_id: quoteId,
          plan_id: plan.itinerary_plan_ID,
          route_id: normalizedRouteId,
          provider: normalizedProvider,
          status: 1,
          deleted: 0,
        },
        select: { id: true, hotel_code: true, full_payload: true },
      });
      const matchingIds = existingRows
        .filter((existing: any) => {
          const payload = this.parsePayload(existing.full_payload) || {};
          const existingCode = String(
            existing.hotel_code ||
            payload.hotelCode ||
            payload.providerHotelCode ||
            payload.hotelId ||
            '',
          ).trim().toLowerCase();
          const requestedCode = normalizedHotelCode.toLowerCase();
          return existingCode === requestedCode ||
            (Number(existingCode) > 0 && Number(existingCode) === Number(requestedCode));
        })
        .map((existing: any) => Number(existing.id))
        .filter((id: number) => id > 0);
      if (matchingIds.length > 0) {
        await txCache.deleteMany({ where: { id: { in: matchingIds } } });
      }
      await txCache.create({
        data: {
          quote_id: quoteId,
          plan_id: plan.itinerary_plan_ID,
          route_id: normalizedRouteId,
          group_type: Number(row.groupType || row.group_type || 1),
          hotel_code: String(row.hotelCode || row.providerHotelCode || row.hotel_code || normalizedHotelCode),
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
        },
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

  private getSearchableRouteIds(routes: any[], noOfNights: number): Set<number> {
    return new Set(
      (routes || [])
        .filter((route: any, index: number) => {
          if (index === routes.length - 1 && index >= noOfNights) return false;
          if (route?.hotelRequired === false || route?.hotel_required === false) return false;
          if (route?.isDeparture || route?.isTransit || route?.isActivityOnly) return false;
          return true;
        })
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
    return this.searchAndPersist(quoteId, 'CREATE', createdBy, true);
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
      return this.reconcileSelections(tx, plan.itinerary_plan_ID, mergedRows, searchRunId, createdBy, true, requestedRouteIds);
    });

    const response = await this.readPersisted(quoteId, { page: 1, pageSize: 100 });
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
      return (offlineByRoute.get(routeId) || []).flatMap((row: any) => groupTypes.map((groupType) => ({
        ...row,
        groupType,
        itineraryRouteId: routeId,
        routeId,
        itineraryRouteDate: routeDate,
        date: routeDate,
        day: row.day || `Day ${routeIndex + 1} | ${routeDate}`,
        destination: row.destination || destination,
      })));
    });
  }

  private normalizeRecommendationGroupTypes(values: unknown[], fallbackValues: unknown[] = []): number[] {
    const groups = Array.from(new Set((values || [])
      .map((value: any) => Number(value?.group_type ?? value?.groupType ?? value))
      .filter((value: number) => Number.isInteger(value) && value >= 1 && value <= 4)))
      .sort((a, b) => a - b);
    if (groups.length > 0) return groups;
    const fallbackGroups = Array.from(new Set((fallbackValues || [])
      .map((value: any) => Number(value?.group_type ?? value?.groupType ?? value))
      .filter((value: number) => Number.isInteger(value) && value >= 1 && value <= 4)))
      .sort((a, b) => a - b);
    return fallbackGroups.length > 0 ? fallbackGroups : [1];
  }

  private async getRecommendationGroupTypes(planId: number, planRows: any[] = [], fallbackRows: any[] = []): Promise<number[]> {
    const persistedRows = planRows.length > 0
      ? planRows
      : await (this.prisma as any).dvi_itinerary_plan_hotel_details.findMany({
          where: { itinerary_plan_id: Number(planId || 0), deleted: 0, status: 1 },
          select: { group_type: true },
        }).catch(() => []);
    const persistedGroups = this.normalizeRecommendationGroupTypes(persistedRows);
    return planRows.length > 0 || persistedGroups.length > 0
      ? persistedGroups
      : this.normalizeRecommendationGroupTypes([], fallbackRows);
  }

  private async sanitizeLegacyResponse(
    response: ItineraryHotelDetailsResponseDto,
    plan: any,
  ): Promise<ItineraryHotelDetailsResponseDto> {
    const hotels = (Array.isArray(response?.hotels) ? response.hotels : []).filter((row: any) => {
      const name = String(row?.hotelName || '').trim().toLowerCase();
      if (row?.isPlaceholder === true || row?.synthetic === true) return false;
      if (name.includes('previously selected hotel') || name === 'no hotels available') return false;
      return Number(row?.itineraryRouteId || row?.routeId || 0) > 0 &&
        Boolean(String(row?.date || row?.checkInDate || '').trim());
    });
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
    const searchableRoutes = currentRoutes.filter((route: any, index: number) =>
      !(index === currentRoutes.length - 1 && index >= noOfNights),
    );
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
    const seen = new Set<string>();
    return rows.filter((row) => {
      const key = this.optionKey(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Some supplier rows carry the rate-plan identity only in a booking/rate
   * reference (for example CP_PLAN or MAP_PLAN) and leave mealPlan as '-'.
   * Normalize both the card row and nested rates before the UI filters them.
   */
  private normalizeRatePlanLabels(row: any): any {
    const inferFrom = (...values: unknown[]): string | null => {
      for (const value of values) {
        const raw = String(value || '');
        const direct = inferCanonicalHotelRatePlanCode(raw);
        if (direct) return direct;
        const fromText = inferCanonicalHotelRatePlanCodeFromMealText(raw);
        if (fromText) return fromText;

        // AxisRooms references are namespaced, e.g.
        // axisrooms:95:231:CP_PLAN:2026-08-13.
        const embeddedPlan = raw.toUpperCase().match(/(?:^|[^A-Z0-9])(MAP|CP|AP|EP)_PLAN(?:$|[^A-Z0-9])/);
        if (embeddedPlan?.[1]) return embeddedPlan[1];
      }
      return null;
    };

    const normalizeOption = (option: any): any => {
      const mealPlan = inferFrom(
        option?.mealPlan,
        option?.meal_plan,
        option?.mealPlanCode,
        option?.ratePlanName,
        option?.rateOptionId,
        option?.rateId,
        option?.bookingCode,
        option?.searchReference,
      );
      return mealPlan && (!option?.mealPlan || String(option.mealPlan).trim() === '-')
        ? { ...option, mealPlan }
        : option;
    };

    const rateOptions = Array.isArray(row?.rateOptions)
      ? row.rateOptions.map(normalizeOption)
      : row?.rateOptions;
    const mealPlan = inferFrom(
      row?.mealPlan,
      row?.meal_plan,
      row?.mealPlanCode,
      row?.ratePlanName,
      row?.selectedRateOptionId,
      row?.selected_rate_option_id,
      row?.rateOptionId,
      row?.rateId,
      row?.bookingCode,
      row?.searchReference,
      row?.optionKey,
    );

    return {
      ...row,
      ...(mealPlan && (!row?.mealPlan || String(row.mealPlan).trim() === '-'))
        ? { mealPlan }
        : {},
      ...(Array.isArray(rateOptions) ? { rateOptions } : {}),
    };
  }

  /**
   * The legacy cache has one uniqueness row per property/provider/stay, while
   * supplier search returns many room/rate rows for that property. Store one
   * canonical card row and retain every rate as nested `rateOptions`.
   */
  private coalesceRowsForCache(rows: any[]): any[] {
    const grouped = new Map<string, any>();
    for (const row of rows) {
      const key = [
        Number(row.itineraryRouteId || row.routeId || 0),
        Number(row.groupType || 0),
        String(row.hotelCode || row.hotelId || '0'),
        String(row.provider || 'external').trim().toLowerCase(),
      ].join('|');
      const existing = grouped.get(key);
      const optionCandidates = Array.isArray(row.rateOptions) && row.rateOptions.length > 0
        ? row.rateOptions
        : [row];
      if (!existing) {
        grouped.set(key, {
          ...row,
          rateOptions: optionCandidates,
        });
        continue;
      }

      const options = [...(existing.rateOptions || []), ...optionCandidates];
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
      const shouldPromote = candidateProvider === 'axisrooms' && currentProvider !== 'axisrooms' ||
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
    const selectedTotal = hasPersistedSelection && providerMatches && persistedTotal > 0
      ? persistedTotal
      : currentTotal > 0
        ? currentTotal
        : persistedTotal;
    const selectedPerNight = hasPersistedSelection && providerMatches && persistedPerNight > 0
      ? persistedPerNight
      : currentPerNight > 0
        ? currentPerNight
        : persistedPerNight;
    const selectedBasePerNight = Number(
      snapshot?.basePricePerNight ??
      snapshot?.base_price_per_night ??
      selectedOption?.basePricePerNight ??
      selectedOption?.base_price_per_night ??
      selectedOption?.baseHotelCost ??
      currentRow?.basePricePerNight ??
      currentRow?.baseHotelCost ??
      0,
    );
    const selectedMarginPercentage = Number(
      snapshot?.hotelMarginPercentage ??
      selectedOption?.hotelMarginPercentage ??
      currentRow?.hotelMarginPercentage ??
      0,
    );
    const selectedMarginAmount = selectedBasePerNight > 0 && selectedPerNight > 0
      ? this.money((selectedPerNight - selectedBasePerNight) * roomCount)
      : Number(currentRow?.hotelMarginAmount || 0);
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
        status: 'AVAILABLE',
        selectionOrigin: selectionOriginFromRow(selection),
        selectionId,
      },
      optionKey: currentRow.optionKey || this.optionKey(currentRow),
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
        // The room editor identifies a room category, not an old supplier
        // quote. A fresh matching rate is authoritative; the persisted amount
        // is only a fallback for legacy snapshots without current pricing.
        const selectedTotal = currentTotal > 0 ? currentTotal : persistedTotal;
        const selectedPerNight = currentPerNight > 0 ? currentPerNight : persistedPerNight;
        const selectedBasePerNight = Number(
          currentRateRow?.basePricePerNight ?? currentRateRow?.base_price_per_night ??
          currentRateRow?.baseHotelCost ?? 0,
        );
        const selectedMarginPercentage = Number(currentRateRow?.hotelMarginPercentage ?? 0);
        const selectedMarginAmount = selectedBasePerNight > 0 && selectedPerNight > 0
          ? this.money((selectedPerNight - selectedBasePerNight) * roomCount)
          : Number(currentRateRow?.hotelMarginAmount || 0);
        const selectedSnapshot = selection?.selected_price_snapshot || null;
        return {
          ...normalized,
          ...(currentOption || {}),
          isSelected: true,
          selectionOrigin: 'USER_SELECTED',
          selectionId: Number(selection.itinerary_plan_hotel_details_ID || 0),
          itineraryPlanHotelDetailsId: Number(selection.itinerary_plan_hotel_details_ID || 0),
          noOfRooms: roomCount,
          total_no_of_rooms: roomCount,
          ...(selectedTotal > 0
            ? {
                selectedTotalPrice: selectedTotal,
                selected_total_price: selectedTotal,
                totalPrice: selectedTotal,
                totalHotelCost: selectedTotal,
                totalStayPrice: selectedTotal,
              }
            : {}),
          ...(selectedBasePerNight > 0 ? {
            basePricePerNight: selectedBasePerNight,
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
          selectedRateOptionId: currentRateRow.rateOptionId || currentRateRow.optionKey ||
            currentRateRow.searchReference || currentRateRow.bookingCode ||
            selection?.selected_rate_option_id || snapshot?.rateOptionId || null,
          roomType: currentRateRow.roomTypeName || currentRateRow.roomType || normalized.roomType,
          mealPlan: currentRateRow.mealPlan || currentRateRow.mealPlanCode || normalized.mealPlan,
          roomId: currentRateRow.roomId || currentRateRow.room_id || normalized.roomId,
          rateId: currentRateRow.rateId || currentRateRow.rate_id || normalized.rateId,
          rateOptionId: currentRateRow.rateOptionId || currentRateRow.optionKey ||
            currentRateRow.searchReference || currentRateRow.bookingCode || null,
          selectedPriceSnapshot: selectedSnapshot,
          selectionStatus: 'AVAILABLE',
          selection: {
            ...hotelDisplaySnapshot({
              ...normalized,
              ...(selectedTotal > 0 ? { totalPrice: selectedTotal } : {}),
              ...(selectedPerNight > 0 ? { pricePerNight: selectedPerNight } : {}),
            }),
            status: 'AVAILABLE',
            selectionOrigin: 'USER_SELECTED',
            selectionId: Number(selection.itinerary_plan_hotel_details_ID || 0),
            totalRooms: roomCount,
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
    const selectedRateOptionId = String(
      selection?.selected_rate_option_id ||
      selectedSnapshot?.rateOptionId ||
      currentRateRow?.rateOptionId ||
      currentRateRow?.optionKey ||
      currentRateRow?.searchReference ||
      currentRateRow?.bookingCode ||
      '',
    ).trim() || null;
    const freshSelectedSnapshot = {
      ...hotelDisplaySnapshot({
        ...currentRateRow,
        totalPrice: selectedTotal,
        pricePerNight: selectedPerNight,
      }),
      selectionOrigin,
      selectionId: Number(selection.itinerary_plan_hotel_details_ID || 0),
      rateOptionId: selectedRateOptionId,
    };
    return {
      ...normalized,
      ...(nestedOption || {}),
      rateOptions: normalized.rateOptions,
      ...(selectedTotal > 0
        ? {
            totalPrice: selectedTotal,
            totalHotelCost: selectedTotal,
            totalStayPrice: selectedTotal,
          }
        : {}),
      ...(selectedPerNight > 0 ? { pricePerNight: selectedPerNight } : {}),
      isSelected: true,
      selectionOrigin,
      selectionId: Number(selection.itinerary_plan_hotel_details_ID || 0),
      itineraryPlanHotelDetailsId: Number(selection.itinerary_plan_hotel_details_ID || 0),
      // The persisted selection identity wins over the parent cache row. The
      // parent may represent another room/meal option in rateOptions.
      selectedRateOptionId,
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
        ...hotelDisplaySnapshot({ ...selection, ...parseHotelSelectionSnapshot(selection) }),
        status: 'AVAILABLE',
        selectionOrigin,
        selectionId: Number(selection.itinerary_plan_hotel_details_ID || 0),
      },
    };
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
      .map((tab: any) => ({
        ...tab,
        groupType: Number(tab?.groupType || 0),
        label: String(tab?.label || `Recommended #${Number(tab?.groupType || 0)}`),
        // Incomplete recommendation packages intentionally have a null
        // totalAmount. Their partialTotal is still the package total for the
        // available stay blocks and is the value the UI should display.
        totalAmount: tab?.totalAmount == null
          ? (tab?.partialTotal == null ? null : Number(tab.partialTotal))
          : Number(tab.totalAmount),
      }))
      .filter((tab: any) => tab.groupType >= 1 && tab.groupType <= 4)
      .filter((tab: any) => !requestedGroup || tab.groupType === requestedGroup)
      .sort((left: any, right: any) => left.groupType - right.groupType);

    const ensureFourStoredTabs = (tabs: any[]): any[] => {
      // A v2 refresh always writes four recommendation packages, but older
      // snapshots may contain only one or two tabs. Normalize those snapshots
      // on read so the UI contract remains stable without recalculating live
      // availability during a normal page load.
      if (requestedGroup || tabs.length === 0) return tabs;
      const normalized = tabs.slice(0, 4).map((tab: any, index: number) => ({
        ...tab,
        groupType: index + 1,
        label: `Recommended #${index + 1}`,
        stayResults: Array.isArray(tab.stayResults) ? [...tab.stayResults] : tab.stayResults,
      }));
      while (normalized.length < 4) {
        const source = normalized[normalized.length - 1];
        const groupType = normalized.length + 1;
        normalized.push({
          ...source,
          groupType,
          label: `Recommended #${groupType}`,
          stayResults: Array.isArray(source.stayResults) ? [...source.stayResults] : source.stayResults,
          distinctFromPrevious: false,
        });
      }
      return normalized;
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
    const overlayUserSelectedTabTotal = (tab: any): any => {
      const selectedRows = (rows || []).filter((row: any) =>
        Number(row?.groupType || 0) === Number(tab?.groupType || 0) &&
        String(row?.selectionOrigin || '').trim().toUpperCase() === 'USER_SELECTED',
      );
      if (selectedRows.length === 0) return tab;
      const totalAmount = selectedRows.reduce((sum: number, row: any) =>
        sum + selectedAmount(row), 0);
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
    const storedTabsMatchCurrentRoutes = storedTabs.length > 0 && storedTabs.every((tab: any) =>
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
      }),
    );

    // Fresh searches carry the totals generated by the recommendation engine.
    // Reuse them when reading the persisted snapshot; the snapshot contains
    // every availability option and cannot derive a package total by summing
    // all of those rows.
    if (
      storedTabsMatchCurrentRoutes &&
      storedTabs.length > 0 &&
      storedTabs.every((tab: any) => Number.isFinite(tab.totalAmount) && tab.totalAmount >= 0)
    ) return ensureFourStoredTabs(storedTabs
      .map(overlayStoredTabSelections)
      .map(overlayUserSelectedTabTotal));

    const searchableRoutes = (routes || []).filter((route: any, index: number) =>
      !(index === routes.length - 1 && index >= noOfNights),
    );
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

    return Array.from(groups.entries())
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
    allowOfflineAutoSelection = false,
    eligibleRouteIds?: Set<number>,
    preferredMealPlanCode?: string | null,
  ): Promise<HotelAvailabilityChangeSummary> {
    const changes: HotelAvailabilityChange[] = [];
    await this.removeStaleSelectionVersions(tx, planId);
    await this.ensureAutoSelections(
      tx,
      planId,
      rows,
      searchRunId,
      createdBy,
      allowOfflineAutoSelection,
      eligibleRouteIds,
      preferredMealPlanCode,
    );
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
      const options = origin === 'USER_SELECTED'
        ? allOptions
        : this.filterRowsByMealPlan(allOptions, preferredMealPlanCode);
      // Match the exact persisted supplier rate first. A parent hotel row can
      // contain several nested room/meal options and must never win with a
      // different identity or price.
      const matched = options.find((row: any) => optionMatchesSelection(selection, row));
      const sameHotel = this.findNearestReplacement(
        selection,
        options.filter((row: any) => hotelPropertyMatchesSelection(selection, row)),
      );
      const replacement = matched || sameHotel || this.findNearestReplacement(selection, options);
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
    allowOfflineAutoSelection = false,
    eligibleRouteIds?: Set<number>,
    preferredMealPlanCode?: string | null,
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

    const existing = await tx.dvi_itinerary_plan_hotel_details.findMany({
      where: { itinerary_plan_id: planId, deleted: 0, status: 1, hotel_required: 1 },
      select: {
        itinerary_route_id: true,
        itinerary_route_date: true,
        group_type: true,
      },
    });
    const existingKeys = new Set(existing.map((row: any) => hotelSelectionKeyFromRow(planId, row)));
    const optionsByKey = new Map<string, any[]>();
    for (const row of rows) {
      const canonicalHotelId = this.persistedHotelId(row);
      const routeId = Number(row.itineraryRouteId || row.routeId || 0);
      const groupType = Number(row.groupType || 0);
      if (eligibleRouteIds && !eligibleRouteIds.has(routeId)) continue;
      if ((!canonicalHotelId && !this.hasSupplierIdentity(row)) || !routeId || !groupType || row.isBookable === false || row.isSelectable === false) continue;
      const key = hotelSelectionKeyFromRow(planId, row);
      const bucket = optionsByKey.get(key) || [];
      bucket.push({ ...row, canonicalHotelId });
      optionsByKey.set(key, bucket);
    }

    // Offline inventory is a fallback only when the same stay/group has no
    // live selectable inventory. Explicit offline fetches may still include
    // both providers, with the normal provider ranking choosing live first.
    const liveSelectionKeys = new Set<string>();
    for (const [key, options] of optionsByKey.entries()) {
      if (options.some((option: any) => String(option.provider || '').trim().toLowerCase() !== 'offline')) {
        liveSelectionKeys.add(key);
      }
    }

    const providerRank = (provider: unknown): number => {
      const value = String(provider || '').trim().toLowerCase();
      if (value === 'axisrooms') return 0;
      if (value === 'offline') return 2;
      return 1;
    };
    for (const [key, options] of optionsByKey.entries()) {
      if (existingKeys.has(key)) continue;
      const mealPlanOptions = this.filterRowsByMealPlan(options, preferredMealPlanCode);
      const eligibleOptions = mealPlanOptions.filter((option: any) =>
        allowOfflineAutoSelection ||
        String(option.provider || '').trim().toLowerCase() !== 'offline' ||
        !liveSelectionKeys.has(key),
      );
      if (eligibleOptions.length === 0) continue;
      const option = [...mealPlanOptions].sort((a, b) => {
        const providerDelta = providerRank(a.provider) - providerRank(b.provider);
        if (providerDelta !== 0) return providerDelta;
        const priceDelta = Number(a.totalStayPrice ?? a.totalHotelCost ?? a.totalPrice ?? 0) -
          Number(b.totalStayPrice ?? b.totalHotelCost ?? b.totalPrice ?? 0);
        if (priceDelta !== 0) return priceDelta;
        return this.optionKey(a).localeCompare(this.optionKey(b));
      }).find((candidate) => eligibleOptions.includes(candidate));
      if (!option) continue;

      const provider = String(option.provider || 'external').trim().toLowerCase();
      const roomCount = Math.max(Number(option.roomCount || option.totalNoOfRooms || 1), 1);
      const rawTotalPrice = hotelStayTotal(option, 1);
      const rawPricePerNight = Number(option.pricePerNight ?? option.price_per_night ?? option.price ?? rawTotalPrice);
      const baseTotalPrice = provider === 'staah'
        ? Math.max(Number(
            option.baseTotalPrice ??
            option.base_total_price ??
            option.baseHotelCost ??
            option.base_hotel_cost ??
            option.totalRoomCost ??
            option.total_room_cost ??
            rawPricePerNight * roomCount,
          ), 0)
        : 0;
      const marginPercentage = provider === 'staah'
        ? Math.max(Number(option.hotelMarginPercentage ?? defaultHotelMarginPercentage), 0)
        : Number(option.hotelMarginPercentage ?? 0);
      const roomTaxAmount = provider === 'staah'
        ? Math.max(Number(option.totalHotelTaxAmount ?? option.taxAmount ?? 0), 0)
        : 0;
      const calculatedMargin = baseTotalPrice > 0
        ? Number((baseTotalPrice * marginPercentage / 100).toFixed(2))
        : 0;
      const totalPrice = provider === 'staah' && baseTotalPrice > 0
        ? Number(Math.max(rawTotalPrice, baseTotalPrice + roomTaxAmount + calculatedMargin).toFixed(2))
        : rawTotalPrice;
      const pricePerNight = provider === 'staah' && totalPrice > 0
        ? Number((totalPrice / roomCount).toFixed(2))
        : rawPricePerNight;
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
          selected_rate_option_id: option.rateOptionId || option.optionKey || option.searchReference || option.bookingCode || null,
          selected_price_per_night: pricePerNight,
          selected_total_price: totalPrice,
          selected_currency: option.currency || 'INR',
          selected_price_snapshot: JSON.stringify({
            ...hotelDisplaySnapshot(option),
            optionKey,
            ...(provider === 'staah' && baseTotalPrice > 0 ? {
              basePricePerNight: Number((baseTotalPrice / roomCount).toFixed(2)),
              baseTotalPrice,
              roomCostTaxAmount: roomTaxAmount,
              hotelMarginPercentage: marginPercentage,
              hotelMarginAmount: calculatedMargin,
              pricePerNight,
              totalPrice,
            } : {}),
            selectionOrigin: 'AUTO_SELECTED',
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
              : option.baseHotelCost ?? option.totalHotelCost ?? totalPrice,
            pricePerNight,
          }, 1),
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

  private buildSelectionUpdate(selection: any, option: any, origin: string, searchRunId: string): Record<string, unknown> {
    const priorSnapshot = parseHotelSelectionSnapshot(selection);
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
