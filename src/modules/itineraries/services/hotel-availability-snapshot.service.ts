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
import { OfflineHotelCatalogService } from './offline-hotel-catalog.service';
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

    const rowRoomIdentity = this.normalizeRoomIdentity(row?.roomId || row?.roomType || row?.room_type);
    return Boolean(rowRoomIdentity) && roomTypeKeys.includes(rowRoomIdentity);
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
    const roomDetailRows = await (this.prisma as any).dvi_itinerary_plan_hotel_room_details.findMany({
      where: { itinerary_plan_id: plan.itinerary_plan_ID, deleted: 0, status: 1 },
      orderBy: { itinerary_plan_hotel_room_details_ID: 'asc' },
    });
    const roomTypeIds = Array.from(
      new Set(
        roomDetailRows
          .map((row: any) => Number(row.room_type_id || 0))
          .filter((id: number) => Number.isFinite(id) && id > 0),
      ),
    );
    const roomTypeRows = roomTypeIds.length
      ? await (this.prisma as any).dvi_hotel_roomtype.findMany({
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
      const parsed = value instanceof Date ? value : new Date(String(value || ''));
      return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
    };
    const currentRouteByDate = new Map<string, any>();
    currentRoutes.forEach((route: any) => {
      const date = toDateOnly(route.itinerary_route_date);
      if (date && !currentRouteByDate.has(date)) currentRouteByDate.set(date, route);
    });
    const remapSnapshotRoute = (row: any): any => {
      const routeId = Number(row?.itineraryRouteId ?? row?.itinerary_route_id ?? 0);
      if (!currentRouteIds.size || currentRouteIds.has(routeId)) return row;

      // Availability rows can outlive a route rebuild. The old route ID is no
      // longer valid, but the persisted snapshot still has the stay date. Map
      // it to the current route for that date before filtering; otherwise Day 1
      // (and any other rebuilt day) disappears from the edit-mode hotel list.
      const date = toDateOnly(
        row?.itineraryRouteDate ??
          row?.itinerary_route_date ??
          row?.hotelCheckInDate ??
          row?.hotel_check_in_date ??
          row?.date,
      );
      const currentRoute = currentRouteByDate.get(date);
      if (!currentRoute) return row;
      const currentRouteIndex = currentRoutes.findIndex(
        (candidate: any) => Number(candidate.itinerary_route_ID) === Number(currentRoute.itinerary_route_ID),
      );
      return {
        ...row,
        itineraryRouteId: Number(currentRoute.itinerary_route_ID),
        itineraryRouteDate: currentRoute.itinerary_route_date,
        itinerary_route_id: Number(currentRoute.itinerary_route_ID),
        itinerary_route_date: currentRoute.itinerary_route_date,
        day: row.day || `Day ${currentRouteIndex + 1} | ${date}`,
        destination: row.destination || currentRoute.next_visiting_location || currentRoute.location_name,
      };
    };
    const noOfNights = Math.max(Number((plan as any).no_of_nights || 0), 0);
    const searchableRoutes = currentRoutes.filter((route: any, index: number) => {
      const isLastRoute = index === currentRoutes.length - 1;
      return !(isLastRoute && index >= noOfNights);
    });

    const selectedByRouteGroup = new Map<string, any>();
    for (const row of planRows) {
      const key = hotelSelectionKeyFromRow(plan.itinerary_plan_ID, row);
      if (!selectedByRouteGroup.has(key) && !isSpecialHotelPlanRow(row)) {
        selectedByRouteGroup.set(key, row);
      }
    }
    const roomSelectionsByRouteGroup = new Map<string, {
      hotelId: number;
      roomCount: number;
      roomTypeKeys: Set<string>;
      roomTypeLabels: string[];
    }>();
    roomDetailRows.forEach((row: any) => {
      const key = hotelSelectionKey(
        plan.itinerary_plan_ID,
        Number(row.itinerary_route_id || 0),
        Number(row.group_type || 0),
        row.itinerary_route_date,
      );
      if (!key) return;
      const existingSelection = selectedByRouteGroup.get(key);
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
      planRows,
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
      const normalized = { ...payload, groupType };
      const provider = String(normalized.provider || normalized.hotel_provider || '').trim().toLowerCase();
      if (provider !== 'offline' || groupType > 0) return [normalized];
      return recommendationGroupTypes.map((candidateGroupType) => ({
        ...normalized,
        groupType: candidateGroupType,
      }));
    });

    let normalizedRows = snapshotRows
      .filter(Boolean)
      .map(remapSnapshotRoute)
      .filter((row: any) => !currentRouteIds.size || currentRouteIds.has(Number(row.itineraryRouteId || 0)))
      .map((row: any) => this.decorateSelection(row, selectedByRouteGroup, plan.itinerary_plan_ID)) as any[];

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
          return Boolean(selection && this.rowMatchesSelection(selection, row));
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

    const tabs = this.buildTabs(normalizedRows);
    const page = Math.max(1, Number(options.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(options.pageSize || 20)));
    const total = normalizedRows.length;
    const start = (page - 1) * pageSize;
    const paged = normalizedRows.slice(start, start + pageSize);
    const checkedAt = new Date(latest.synced_at);
    const latestPayload = this.parsePayload(latest.full_payload);
    const searchRunId = String(latestPayload?.searchRunId || `legacy-hotel-${plan.itinerary_plan_ID}-${checkedAt.toISOString()}`);
    const ttlMinutes = Math.max(Number(process.env.HOTEL_AVAILABILITY_TTL_MINUTES || 60), 1);
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
        searchRunId,
        checkedAt: checkedAt.toISOString(),
        expiresAt,
        providerErrors: [],
        emptyStayBlocks,
        stayRoutes,
        offlineFetch: latestPayload?.offlineFetch,
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
      const liveResponse = await this.tboHotelDetails.getHotelDetailsByQuoteIdFromTbo(
        quoteId,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
      );
      const sourceRows = Array.isArray(liveResponse.hotels) ? liveResponse.hotels : [];
      if (sourceRows.length === 0 && requestType !== 'CHECK_AVAILABILITY') {
        throw new ServiceUnavailableException({
          message: 'Hotel availability returned no options; the previous snapshot was retained.',
          code: 'HOTEL_AVAILABILITY_EMPTY',
          planId: plan.itinerary_plan_ID,
          quoteId,
          searchRunId,
          previousSnapshotRetained: true,
        });
      }

      // Refresh must search both sources so the comparison can see a newly
      // available offline option, but offline inventory is never allowed to
      // become a silent fallback or replace a live selection.
      let rows: any[] = sourceRows;
      if (requestType === 'CHECK_AVAILABILITY') {
        const routes = await this.prisma.dvi_itinerary_route_details.findMany({
          where: { itinerary_plan_ID: plan.itinerary_plan_ID, deleted: 0 },
          orderBy: { itinerary_route_date: 'asc' },
        });
        const noOfNights = Math.max(Number((plan as any).no_of_nights || 0), 0);
        const offlineByRoute = await this.offlineHotelCatalog.fetchOfflineHotelsForRoutes(
          routes,
          noOfNights,
          String((plan as any).guest_nationality || 'IN').trim().toUpperCase() || 'IN',
          Math.max(Number((plan as any).preferred_room_count || 1), 1),
          Math.max(Number((plan as any).total_adult || 0), 0),
          Math.max(Number((plan as any).total_children || 0), 0),
        );
        const recommendationGroupTypes = await this.getRecommendationGroupTypes(plan.itinerary_plan_ID, [], sourceRows);
        rows = [...sourceRows, ...this.materializeOfflineRows(offlineByRoute, routes, recommendationGroupTypes)];
      }
      rows = this.dedupeRows(rows);
      const storageRows = this.coalesceRowsForCache(rows);
      const cacheRows = storageRows.length > 0
        ? storageRows
        : [this.buildEmptySnapshotRow(plan, quoteId, searchRunId, checkedAt)];
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
            price: Number(row.totalHotelCost || row.pricePerNight || row.price || 0),
            room_type: String(row.roomType || row.room_type || '').slice(0, 255) || null,
            meal_plan: String(row.mealPlan || row.meal_plan || '').slice(0, 100) || null,
            search_reference: row.searchReference || row.search_reference ? String(row.searchReference || row.search_reference) : null,
            full_payload: row.full_payload && this.parsePayload(row.full_payload)?.availabilityMarker === EMPTY_AVAILABILITY_MARKER
              ? String(row.full_payload)
              : JSON.stringify({ ...row, optionKey: this.optionKey(row), searchRunId }),
            check_in_date: this.toDate(row.date || row.checkInDate || row.check_in_date || checkedAt),
            check_out_date: row.checkOutDate || row.check_out_date
              ? this.toDate(row.checkOutDate || row.check_out_date)
              : this.addDays(this.toDate(row.date || row.checkInDate || row.check_in_date || checkedAt), Number(row.numberOfNights || 1)),
            sort_rank: index,
            synced_at: checkedAt,
            status: 1,
            deleted: 0,
          })),
        });

        return this.reconcileSelections(tx, plan.itinerary_plan_ID, rows, searchRunId, createdBy);
      });

      const response = await this.readPersisted(quoteId, { page: 1, pageSize: 100 });
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

  private async findPlan(quoteId: string): Promise<any> {
    const plan = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_quote_ID: String(quoteId).trim(), deleted: 0 },
    });
    if (!plan) throw new BadRequestException('Itinerary not found');
    return plan;
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
      const parsed = value instanceof Date ? value : new Date(String(value || ''));
      return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
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

  private decorateSelection(row: any, selectedByRouteGroup: Map<string, any>, planId: number): any {
      const selection = selectedByRouteGroup.get(hotelSelectionKeyFromRow(planId, row));
      const normalized = { ...row, optionKey: row.optionKey || this.optionKey(row) };
      if (!selection) return normalized;
      if (this.rowMatchesRoomCategorySelection(selection, normalized)) {
        const snapshot = parseHotelSelectionSnapshot(selection) as any;
        const roomCount = Math.max(Number(snapshot?.totalRooms || selection?.total_no_of_rooms || 0), Number(normalized.noOfRooms || 0), 1);
        return {
          ...normalized,
          isSelected: true,
          selectionOrigin: 'USER_SELECTED',
          selectionId: Number(selection.itinerary_plan_hotel_details_ID || 0),
          itineraryPlanHotelDetailsId: Number(selection.itinerary_plan_hotel_details_ID || 0),
          noOfRooms: roomCount,
          total_no_of_rooms: roomCount,
          selectionStatus: 'AVAILABLE',
          selection: {
            ...hotelDisplaySnapshot(normalized),
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
    return {
      ...normalized,
      ...(nestedOption || {}),
      rateOptions: normalized.rateOptions,
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
  ): Promise<HotelAvailabilityChangeSummary> {
    const changes: HotelAvailabilityChange[] = [];
    await this.ensureAutoSelections(tx, planId, rows, searchRunId, createdBy, allowOfflineAutoSelection, eligibleRouteIds);
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
      // Explicit offline fetches may add/refresh options, but they must not
      // replace an offline hotel the user already selected for this stay.
      if (allowOfflineAutoSelection && String(selection.hotel_provider || '').trim().toLowerCase() === 'offline') continue;

      const options = rows.filter((row: any) => hotelSelectionKeyFromRow(planId, row) === selectionKey);
      const origin = selectionOriginFromRow(selection);
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
      const replacementWasUnavailable = !matched && !sameHotel;
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
      }
    }

    return { hasChanges: changes.length > 0, totalChanges: changes.length, changes };
  }

  private async ensureAutoSelections(
    tx: any,
    planId: number,
    rows: any[],
    searchRunId: string,
    createdBy: number,
    allowOfflineAutoSelection = false,
    eligibleRouteIds?: Set<number>,
  ): Promise<void> {
    if (!tx?.dvi_itinerary_plan_hotel_details?.findMany || !tx?.dvi_itinerary_plan_hotel_details?.create) return;

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
      const isOffline = String(row.provider || '').trim().toLowerCase() === 'offline';
      if (eligibleRouteIds && !eligibleRouteIds.has(routeId)) continue;
      if (!allowOfflineAutoSelection && isOffline) continue;
      if ((!canonicalHotelId && !this.hasSupplierIdentity(row)) || !routeId || !groupType || row.isBookable === false || row.isSelectable === false) continue;
      const key = hotelSelectionKeyFromRow(planId, row);
      const bucket = optionsByKey.get(key) || [];
      bucket.push({ ...row, canonicalHotelId });
      optionsByKey.set(key, bucket);
    }

    const providerRank = (provider: unknown): number => {
      const value = String(provider || '').trim().toLowerCase();
      if (value === 'axisrooms') return 0;
      if (value === 'offline') return 2;
      return 1;
    };
    for (const [key, options] of optionsByKey.entries()) {
      if (existingKeys.has(key)) continue;
      const option = [...options].sort((a, b) => {
        const providerDelta = providerRank(a.provider) - providerRank(b.provider);
        if (providerDelta !== 0) return providerDelta;
        const priceDelta = Number(a.totalStayPrice ?? a.totalHotelCost ?? a.totalPrice ?? 0) -
          Number(b.totalStayPrice ?? b.totalHotelCost ?? b.totalPrice ?? 0);
        if (priceDelta !== 0) return priceDelta;
        return this.optionKey(a).localeCompare(this.optionKey(b));
      })[0];
      if (!option) continue;

      const provider = String(option.provider || 'external').trim().toLowerCase();
      const totalPrice = Number(option.totalStayPrice ?? option.totalHotelCost ?? option.totalPrice ?? 0);
      const pricePerNight = Number(option.pricePerNight ?? option.totalHotelCost ?? option.price ?? totalPrice);
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
            selectionOrigin: 'AUTO_SELECTED',
            availabilityStatus: provider === 'offline' ? 'OFFLINE_APPROVAL_REQUIRED' : 'AVAILABLE',
            searchRunId,
          }),
          hotel_approval_status: provider === 'offline' ? 'PENDING_APPROVAL' : 'NOT_REQUIRED',
          manual_confirmation_status: 'NOT_STARTED',
          total_no_of_rooms: Math.max(Number(option.roomCount || option.totalNoOfRooms || 1), 1),
          total_room_cost: Number(option.baseHotelCost ?? option.totalHotelCost ?? totalPrice),
          total_hotel_cost: totalPrice,
          total_hotel_tax_amount: Number(option.totalHotelTaxAmount || 0),
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

    // Keep automatic replacement on live supplier inventory. Offline options
    // are used only by an explicit offline fetch, never as a live fallback.
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
    const pricePerNight = Number(option.pricePerNight || option.totalHotelCost || option.totalStayPrice || 0);
    const totalPrice = Number(option.totalStayPrice || option.totalHotelCost || option.totalPrice || 0);
    return {
      hotel_id: this.persistedHotelId(option, selection.hotel_id),
      hotel_code: String(option.hotelCode || option.providerHotelCode || option.hotel_code || option.hotelId || selection.hotel_code || '').trim() || null,
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
      hotel_id: this.persistedHotelId(option, selection.hotel_id),
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
