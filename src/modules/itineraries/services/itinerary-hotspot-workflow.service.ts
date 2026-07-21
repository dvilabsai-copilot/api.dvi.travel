import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { HotspotEngineService } from '../engines/hotspot-engine.service';
import { TimeConverter } from '../engines/helpers/time-converter';
import { formatClosedDaysLabel, getClosedDays } from '../utils/route-hotspot-operating-hours.util';

type HotspotWorkflowCallbacks = {
  classifyManualHotspotCityContext: (...args: any[]) => any;
  deriveLooseCityKey: (...args: any[]) => any;
  hmsToSeconds: (...args: any[]) => any;
  normalizeLocationText: (...args: any[]) => any;
  previewManualHotspot: (...args: any[]) => Promise<any>;
};

@Injectable()
export class ItineraryHotspotWorkflowService {
  private callbacks: HotspotWorkflowCallbacks | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly hotspotEngine: HotspotEngineService,
  ) {}

  setCallbacks(callbacks: HotspotWorkflowCallbacks): void {
    this.callbacks = callbacks;
  }

  private get policy(): HotspotWorkflowCallbacks {
    if (!this.callbacks) throw new Error('Hotspot workflow callbacks are not configured');
    return this.callbacks;
  }

  private classifyManualHotspotCityContext(...args: any[]): any {
    return this.policy.classifyManualHotspotCityContext(...args);
  }

  private deriveLooseCityKey(...args: any[]): any {
    return this.policy.deriveLooseCityKey(...args);
  }

  private hmsToSeconds(...args: any[]): any {
    return this.policy.hmsToSeconds(...args);
  }

  private normalizeLocationText(...args: any[]): any {
    return this.policy.normalizeLocationText(...args);
  }

  private previewManualHotspot(...args: any[]): Promise<any> {
    return this.policy.previewManualHotspot(...args);
  }

  async getAvailableHotspots(routeId: number) {
    // 1) Route
    const route = await (this.prisma as any).dvi_itinerary_route_details.findFirst({
      where: { itinerary_route_ID: routeId, deleted: 0 },
    });

    if (!route || !route.location_id) return [];

    // 2) Location master
    const location = await (this.prisma as any).dvi_stored_locations.findFirst({
      where: { location_ID: Number(route.location_id), deleted: 0 },
    });

    if (!location) return [];

    const sourceName: string | null = (location as any).source_location ?? null;
    const destName: string | null = (location as any).destination_location ?? null;

    const directDestination = Number(route.direct_to_next_visiting_place || 0) === 1;

    // 3) Already-added hotspots across the WHOLE PLAN (all routes) so we never
    //    offer a hotspot that is already scheduled on another day.
    //    We also track which ones are on THIS route specifically (for visitAgain).
    const planId = Number(route.itinerary_plan_ID);
    const allPlanAddedRowsRaw = await (this.prisma as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        deleted: 0,
        status: 1,
        item_type: 4,
      },
      select: {
        hotspot_ID: true,
        itinerary_route_ID: true,
        route_hotspot_ID: true,
        hotspot_plan_own_way: true,
      },
    });

    // Guard against stale/orphan rows from replaced routes during rebuilds.
    // Availability should only consider hotspots tied to currently active routes.
    const activePlanRoutes = await (this.prisma as any).dvi_itinerary_route_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        deleted: 0,
        status: 1,
      },
      select: { itinerary_route_ID: true },
    });
    const activeRouteIds = new Set<number>(
      (activePlanRoutes || [])
        .map((r: any) => Number(r.itinerary_route_ID || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    );
    const allPlanAddedRows = (allPlanAddedRowsRaw || []).filter((r: any) =>
      activeRouteIds.has(Number(r.itinerary_route_ID || 0)),
    );

    // Hotspots already on THIS route → mark as visitAgain instead of hiding
    const thisRouteAddedIds = new Set<number>(
      (allPlanAddedRows || [])
        .filter((r: any) => Number(r.itinerary_route_ID) === Number(routeId))
        .map((r: any) => Number(r.hotspot_ID))
        .filter((n: number) => Number.isFinite(n) && n > 0),
    );
    const thisRouteAddedRowByHotspotId = new Map<number, {
      routeHotspotId: number | null;
      planOwnWay: boolean;
      isManual: boolean;
    }>();
    for (const row of allPlanAddedRows || []) {
      if (Number(row?.itinerary_route_ID || 0) !== Number(routeId)) continue;
      const hotspotId = Number(row?.hotspot_ID || 0);
      if (!(hotspotId > 0) || thisRouteAddedRowByHotspotId.has(hotspotId)) continue;
      const isManual = Number(row?.hotspot_plan_own_way || 0) === 1;
      thisRouteAddedRowByHotspotId.set(hotspotId, {
        routeHotspotId: Number(row?.route_hotspot_ID || 0) || null,
        planOwnWay: isManual,
        isManual,
      });
    }

    // Hotspots on OTHER routes of the same plan
    const otherRouteAddedIds = new Set<number>(
      (allPlanAddedRows || [])
        .filter((r: any) => Number(r.itinerary_route_ID) !== Number(routeId))
        .map((r: any) => Number(r.hotspot_ID))
        .filter((n: number) => Number.isFinite(n) && n > 0),
    );

    // 3.5) Get excluded hotspot IDs (deleted by user)
    const excludedIds = new Set<number>(
      (route.excluded_hotspot_ids as number[]) || []
    );

    // 4) Pool fetcher (priority DESC + stable tie-break)
    const fetchPool = async (cityName: string | null) => {
      if (!cityName) return [];
      return await (this.prisma as any).dvi_hotspot_place.findMany({
        where: {
          status: 1,
          deleted: 0,
          hotspot_location: { contains: cityName },
        },
        select: {
          hotspot_ID: true,
          hotspot_name: true,
          hotspot_adult_entry_cost: true,
          hotspot_description: true,
          hotspot_duration: true,
          hotspot_location: true,
          hotspot_to_location: true,
          hotspot_priority: true,
          hotspot_video_url: true,
        },
        orderBy: [{ hotspot_priority: "asc" }, { hotspot_ID: "asc" }],
      });
    };

    const sourcePool = await fetchPool(sourceName);
    const destPool = await fetchPool(destName);

    // 5) Build final ordered list
    const seen = new Set<number>();
    const ordered: any[] = [];
    const DEBUG_HOTSPOT_ID = 219;

    const logPoolSuppression = (payload: {
      hotspotId: number;
      hotspotName?: string | null;
      reason: 'duplicate_in_final_de_dup';
      source?: string;
    }) => {
      console.log('[HOTSPOT_POOL_SUPPRESSION]', JSON.stringify({
        routeId,
        hotspotId: payload.hotspotId,
        hotspotName: payload.hotspotName ?? null,
        reason: payload.reason,
        source: payload.source ?? null,
      }));
    };

    const pushUnique = (h: any) => {
      const id = Number(h?.hotspot_ID);
      if (!id) return;
      if (seen.has(id)) {
        logPoolSuppression({
          hotspotId: id,
          hotspotName: h?.hotspot_name ?? null,
          reason: 'duplicate_in_final_de_dup',
          source: String(h?.hotspot_location ?? h?.matched_bucket ?? 'unknown'),
        });
        return;
      }
      // Keep excluded hotspots visible so users can re-add items deleted by mistake.
      // Excluded badge and behavior are handled in the UI / apply flow.
      seen.add(id);
      ordered.push(h);
    };

    if (directDestination) {
      // direct = true => destination only
      for (const h of destPool) pushUnique(h);
    } else {
      // direct = false => interleave 3-by-3 source/dest
      const CHUNK = 3;
      let i = 0;
      let j = 0;

      while (i < sourcePool.length || j < destPool.length) {
        for (let k = 0; k < CHUNK && i < sourcePool.length; k++, i++) pushUnique(sourcePool[i]);
        for (let k = 0; k < CHUNK && j < destPool.length; k++, j++) pushUnique(destPool[j]);
      }
    }

    if (ordered.length === 0) return [];

    const hotspotIds = ordered.map((h: any) => Number(h.hotspot_ID));

    const hotspotGalleryRows = await (this.prisma as any).dvi_hotspot_gallery_details.findMany({
      where: { hotspot_ID: { in: hotspotIds }, deleted: 0 },
      orderBy: { hotspot_gallery_details_id: 'asc' },
      select: { hotspot_ID: true, hotspot_gallery_name: true },
    });

    const hotspotGalleryMap = new Map<number, string[]>();
    for (const g of hotspotGalleryRows || []) {
      const hotspotId = Number(g?.hotspot_ID || 0);
      const fileName = String(g?.hotspot_gallery_name || '').trim();
      if (!hotspotId || !fileName) continue;
      const urls = hotspotGalleryMap.get(hotspotId) || [];
      urls.push(`/uploads/hotspot_gallery/${fileName}`);
      hotspotGalleryMap.set(hotspotId, urls);
    }

    // 7) Timings
    const routeDate = route?.itinerary_route_date ? new Date(route.itinerary_route_date) : null;
    const routeDayOfWeek = routeDate && Number.isFinite(routeDate.getTime())
      ? (routeDate.getDay() + 6) % 7
      : null;
    const routeDayLabel = routeDate && Number.isFinite(routeDate.getTime())
      ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][routeDate.getDay()]
      : null;
    const timings = await (this.prisma as any).dvi_hotspot_timing.findMany({
      where: {
        hotspot_ID: { in: hotspotIds },
        deleted: 0,
        status: 1,
      },
      orderBy: [
        { hotspot_start_time: "asc" },
        { hotspot_timing_ID: "asc" },
      ],
    });

    const timingMap = new Map<number, string>();
    const formatTime = (date: Date | null) => {
      if (!date) return "";
      const h = date.getUTCHours();
      const m = date.getUTCMinutes();
      const ampm = h >= 12 ? "PM" : "AM";
      const h12 = h % 12 || 12;
      return `${String(h12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${ampm}`;
    };

    // Collect all distinct open windows per hotspot (ordered by start time)
    const timingWindowsMap = new Map<number, Set<string>>();
    const timingRowsByHotspot = new Map<number, any[]>();
    const routeDayTimingCountMap = new Map<number, number>();
    const routeDayOpenTimingCountMap = new Map<number, number>();
    for (const t of timings) {
      const hotspotId = Number(t?.hotspot_ID || 0);
      if (!hotspotId) continue;
      const allRows = timingRowsByHotspot.get(hotspotId) || [];
      allRows.push(t);
      timingRowsByHotspot.set(hotspotId, allRows);

      if (routeDayOfWeek !== null && Number(t?.hotspot_timing_day) !== routeDayOfWeek) continue;
      routeDayTimingCountMap.set(hotspotId, (routeDayTimingCountMap.get(hotspotId) || 0) + 1);

      if (Number(t.hotspot_closed || 0) === 1) continue;
      routeDayOpenTimingCountMap.set(hotspotId, (routeDayOpenTimingCountMap.get(hotspotId) || 0) + 1);

      let timeStr = "";
      if (t.hotspot_open_all_time === 1) {
        timeStr = "Open 24 Hours";
      } else if (t.hotspot_start_time && t.hotspot_end_time) {
        const start = formatTime(t.hotspot_start_time);
        const end = formatTime(t.hotspot_end_time);
        timeStr = `${start} - ${end}`;
      }

      if (timeStr) {
        if (!timingWindowsMap.has(t.hotspot_ID)) {
          timingWindowsMap.set(t.hotspot_ID, new Set<string>());
        }
        timingWindowsMap.get(t.hotspot_ID)!.add(timeStr);
      }
    }

    for (const [hotspotId, windowSet] of timingWindowsMap.entries()) {
      // "Open 24 Hours" takes precedence over specific windows
      if (windowSet.has("Open 24 Hours")) {
        timingMap.set(hotspotId, "Open 24 Hours");
      } else {
        timingMap.set(hotspotId, Array.from(windowSet).join(", "));
      }
    }

    // 8) Response (+ visitAgain)
    // Treat priority 0 as "unset" (lowest) so it sorts after real P1-P18
    const normPriority = (raw: any) => {
      const n = Number(raw ?? 0);
      return n > 0 ? n : 9999;
    };
    const response = ordered
      .sort((a: any, b: any) => normPriority(a.hotspot_priority) - normPriority(b.hotspot_priority))
      .map((h: any) => {
        const hotspotId = Number(h.hotspot_ID || 0);
        const isActiveThisRoute = thisRouteAddedIds.has(hotspotId);
        const isActiveOtherRoute = !isActiveThisRoute && otherRouteAddedIds.has(hotspotId);
        const isExcludedByRoute = excludedIds.has(hotspotId);

        const isClosedOnRouteDate = routeDayOfWeek !== null
          && (routeDayTimingCountMap.get(hotspotId) || 0) > 0
          && (routeDayOpenTimingCountMap.get(hotspotId) || 0) === 0;
        const closedDays = getClosedDays(timingRowsByHotspot.get(hotspotId) || []);
        const closedDaysLabel = formatClosedDaysLabel(closedDays);
        let availabilityStatus: 'AVAILABLE' | 'ACTIVE_THIS_ROUTE' | 'ACTIVE_OTHER_ROUTE' | 'EXCLUDED_BY_ROUTE' | 'MASTER_INACTIVE' | 'CLOSED_ON_ROUTE_DATE' = 'AVAILABLE';
        let availabilityReason = 'Hotspot is available for preview and add.';

        if (isClosedOnRouteDate) {
          availabilityStatus = 'CLOSED_ON_ROUTE_DATE';
          availabilityReason = `Hotspot is closed on ${closedDaysLabel || routeDayLabel || 'this route date'}. Preview and insertion are disabled.`;
        } else if (isActiveThisRoute) {
          availabilityStatus = 'ACTIVE_THIS_ROUTE';
          availabilityReason = 'Hotspot is already active on this route.';
        } else if (isExcludedByRoute) {
          availabilityStatus = 'EXCLUDED_BY_ROUTE';
          availabilityReason = 'Hotspot is currently excluded for this route.';
        } else if (isActiveOtherRoute) {
          availabilityStatus = 'ACTIVE_OTHER_ROUTE';
          availabilityReason = 'Hotspot is also active on another route in this plan.';
        }

        const actionDisabled = isClosedOnRouteDate
          || availabilityStatus === 'ACTIVE_THIS_ROUTE'
          || availabilityStatus === 'EXCLUDED_BY_ROUTE';
        const activeRouteRow = thisRouteAddedRowByHotspotId.get(hotspotId) || null;
        const cityContext = this.classifyManualHotspotCityContext({
          location_name: sourceName,
          next_visiting_location: destName,
        }, {
          hotspot_location: h.hotspot_location,
          hotspot_name: h.hotspot_name,
        });

        return {
          id: hotspotId,
          name: h.hotspot_name,
          priority: normPriority(h.hotspot_priority),
          amount: h.hotspot_adult_entry_cost || 0,
          description: h.hotspot_description || "",
          timeSpend: h.hotspot_duration ? new Date(h.hotspot_duration).getUTCHours() : 0,
          locationMap: h.hotspot_location || null,
          hotspot_location: h.hotspot_location || null,
          hotspot_to_location: h.hotspot_to_location || h.hotspot_location || null,
          timings: isClosedOnRouteDate ? 'Closed' : (timingMap.get(h.hotspot_ID) || "No timings available"),
          isClosedOnRouteDate,
          closedDays,
          closedDaysLabel,
          routeDayLabel,
          routeDate: routeDate && Number.isFinite(routeDate.getTime()) ? routeDate.toISOString() : null,
          image: (hotspotGalleryMap.get(hotspotId) || [])[0] || null,
          galleryImages: hotspotGalleryMap.get(hotspotId) || [],
          videoUrl: h.hotspot_video_url || null,
          visitAgain: isActiveThisRoute || isActiveOtherRoute,
          alreadyAdded: isActiveThisRoute || isActiveOtherRoute,
          alreadyAddedOnOtherRoute: isActiveOtherRoute,
          routeHotspotId: activeRouteRow?.routeHotspotId ?? null,
          planOwnWay: activeRouteRow?.planOwnWay === true,
          isManual: activeRouteRow?.isManual === true,
          availabilityStatus,
          availabilityReason,
          actionDisabled,
          buttonLabel: isClosedOnRouteDate ? 'Closed' : (actionDisabled ? 'Already added' : 'Preview'),
          cityContext,
        };
      });

    const debugPayload = {
      routeId: Number(routeId),
      planId,
      thisRouteAddedIds: Array.from(thisRouteAddedIds).sort((a, b) => a - b),
      otherRouteAddedIds: Array.from(otherRouteAddedIds).sort((a, b) => a - b),
      activeRouteIds: Array.from(activeRouteIds).sort((a, b) => a - b),
      excludedHotspotIds: Array.from(excludedIds).sort((a, b) => a - b),
      hotspot219: {
        appearsInAllPlanAddedRows: (allPlanAddedRows || []).some((row: any) => Number(row?.hotspot_ID || 0) === DEBUG_HOTSPOT_ID),
        appearsInThisRouteAddedIds: thisRouteAddedIds.has(DEBUG_HOTSPOT_ID),
        appearsInOtherRouteAddedIds: otherRouteAddedIds.has(DEBUG_HOTSPOT_ID),
        appearsInExcludedHotspotIds: excludedIds.has(DEBUG_HOTSPOT_ID),
        appearsInFinalResponse: response.some((row: any) => Number(row?.id || 0) === DEBUG_HOTSPOT_ID),
        finalAvailabilityStatus: (response.find((row: any) => Number(row?.id || 0) === DEBUG_HOTSPOT_ID) as any)?.availabilityStatus || null,
        finalActionDisabled: (response.find((row: any) => Number(row?.id || 0) === DEBUG_HOTSPOT_ID) as any)?.actionDisabled ?? null,
      },
    };
    console.log('[AVAILABLE_HOTSPOTS_DEBUG]', JSON.stringify(debugPayload));

    return response;
  }

  // Backward-compatible wrapper: anchor payload is accepted for older callers.
  async getAvailableHotspotsForAnchor(data: {
    planId: number;
    routeId: number;
    anchorType: 'after_travel';
    anchorIndex: number;
  }) {
    const routeId = Number(data?.routeId || 0);
    const anchorIndex = Number(data?.anchorIndex || 0);
    const baseHotspots = await this.getAvailableHotspots(routeId);
    const safeBaseHotspots = Array.isArray(baseHotspots) ? baseHotspots : [];

    const fallbackMeta = {
      directToggleOff: false,
      sourceCityKey: '',
      destinationCityKey: '',
      destinationReachedTime: null as string | null,
      destinationReachedAfter3Pm: false,
      destinationCityHotspotsHidden: 0,
      destinationCityHotspotsVisibleAfter3Pm: true,
      routeMovementHotspotsHidden: 0,
      anchorType: data?.anchorType || null,
      anchorIndex,
      anchorFrom: null as string | null,
      anchorTo: null as string | null,
      anchorRepresentsRouteMovement: false,
      filterFallbackUsed: false,
    };

    try {
      const route = await (this.prisma as any).dvi_itinerary_route_details.findFirst({
        where: {
          itinerary_route_ID: routeId,
          deleted: 0,
        },
        select: {
          itinerary_plan_ID: true,
          location_name: true,
          next_visiting_location: true,
          direct_to_next_visiting_place: true,
        },
      });

      const sourceCityKey = this.deriveLooseCityKey(String(route?.location_name || ''));
      const destinationCityKey = this.deriveLooseCityKey(String(route?.next_visiting_location || ''));
      const directToggleOff = Number(route?.direct_to_next_visiting_place || 0) !== 1;

      const routeRows = await (this.prisma as any).dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_route_ID: routeId,
          deleted: 0,
          status: 1,
          item_type: { in: [3, 4, 5, 6] },
        },
        select: {
          route_hotspot_ID: true,
          hotspot_ID: true,
          hotspot_order: true,
          item_type: true,
          via_location_name: true,
          hotspot_start_time: true,
          hotspot_end_time: true,
        },
        orderBy: [
          { hotspot_order: 'asc' },
          { route_hotspot_ID: 'asc' },
        ],
      });

      const hotspotIds = Array.from(
        new Set(
          (routeRows || [])
            .map((row: any) => Number(row?.hotspot_ID || 0))
            .filter((id: number) => Number.isFinite(id) && id > 0),
        ),
      );

      const hotspotMasters = hotspotIds.length > 0
        ? await (this.prisma as any).dvi_hotspot_place.findMany({
            where: {
              hotspot_ID: { in: hotspotIds },
              deleted: 0,
            },
            select: {
              hotspot_ID: true,
              hotspot_name: true,
              hotspot_location: true,
            },
          })
        : [];
      const masterById = new Map<number, any>(
        (hotspotMasters || []).map((row: any) => [Number(row?.hotspot_ID || 0), row]),
      );

      const toMinutesFromDate = (value: unknown): number | null => {
        if (!value) return null;
        try {
          const hms = TimeConverter.toTimeString(value as any);
          if (!hms) return null;
          return Math.floor(this.hmsToSeconds(hms) / 60);
        } catch {
          return null;
        }
      };

      const toDisplayTime = (value: unknown): string | null => {
        if (!value) return null;
        try {
          const hms = TimeConverter.toTimeString(value as any);
          const [hh, mm] = String(hms || '').split(':');
          if (!hh || !mm) return null;
          return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
        } catch {
          return null;
        }
      };

      const parseTravelFromTo = (value: unknown): { from: string; to: string } => {
        const raw = String(value || '').trim();
        if (!raw) return { from: '', to: '' };

        const fromToMatch = raw.match(/^travell?ing\s+from\s+(.+?)\s+to\s+(.+)$/i);
        if (fromToMatch) {
          return {
            from: String(fromToMatch[1] || '').trim(),
            to: String(fromToMatch[2] || '').trim(),
          };
        }

        const toOnlyMatch = raw.match(/^travel\s+to\s+(.+)$/i);
        if (toOnlyMatch) {
          return {
            from: '',
            to: String(toOnlyMatch[1] || '').trim(),
          };
        }

        return { from: '', to: '' };
      };

      const isDestinationMatch = (value: unknown): boolean => {
        const normalized = this.normalizeLocationText(value || '');
        const key = this.deriveLooseCityKey(String(value || ''));
        if (!destinationCityKey) return false;
        if (key && key === destinationCityKey) return true;
        return normalized.includes(destinationCityKey);
      };

      let destinationReachedMinutes: number | null = null;
      let destinationReachedTime: string | null = null;
      let destinationReachedOrder: number | null = null;

      for (const row of routeRows || []) {
        if (!row) continue;
        const itemType = Number(row?.item_type || 0);
        const hotspotId = Number(row?.hotspot_ID || 0);
        const master = masterById.get(hotspotId);
        const rowName = String(master?.hotspot_name || '');
        const rowLocation = String(master?.hotspot_location || '');

        const startMinutes = toMinutesFromDate(row?.hotspot_start_time);
        const endMinutes = toMinutesFromDate(row?.hotspot_end_time);
        const candidateMinutes = startMinutes ?? endMinutes;

        if (itemType === 6 && candidateMinutes !== null) {
          destinationReachedMinutes = candidateMinutes;
          destinationReachedTime = toDisplayTime(row?.hotspot_start_time || row?.hotspot_end_time);
          destinationReachedOrder = Number(row?.hotspot_order || 0) || null;
          break;
        }

        if (itemType === 4 && candidateMinutes !== null) {
          const matchedDestination = isDestinationMatch(rowLocation) || isDestinationMatch(rowName);
          if (matchedDestination) {
            destinationReachedMinutes = candidateMinutes;
            destinationReachedTime = toDisplayTime(row?.hotspot_start_time || row?.hotspot_end_time);
            destinationReachedOrder = Number(row?.hotspot_order || 0) || null;
            break;
          }
        }
      }

      const destinationReachedAfter3Pm = destinationReachedMinutes !== null && destinationReachedMinutes >= (15 * 60);

      const travelRows = (routeRows || []).filter((row: any) => {
        const itemType = Number(row?.item_type || 0);
        return itemType === 3 || itemType === 5;
      });
      const selectedAnchorRow = travelRows[anchorIndex] || null;
      const anchorOrder = Number(selectedAnchorRow?.hotspot_order || 0) || null;
      const parsedAnchor = parseTravelFromTo(selectedAnchorRow?.via_location_name || '');
      const selectedAnchorMaster = masterById.get(Number(selectedAnchorRow?.hotspot_ID || 0));
      const previousVisitedRow = [...(routeRows || [])]
        .filter((row: any) =>
          Number(row?.item_type || 0) === 4 &&
          Number(row?.hotspot_order || 0) < Number(selectedAnchorRow?.hotspot_order || 0),
        )
        .sort((a: any, b: any) => Number(b?.hotspot_order || 0) - Number(a?.hotspot_order || 0))[0] || null;
      const previousVisitedMaster = masterById.get(Number(previousVisitedRow?.hotspot_ID || 0));
      const previousVisitedMatchesSelected =
        Number(previousVisitedRow?.hotspot_ID || 0) > 0 &&
        Number(previousVisitedRow?.hotspot_ID || 0) === Number(selectedAnchorRow?.hotspot_ID || 0);

      const resolvedAnchorFrom = String(
        parsedAnchor.from ||
        (previousVisitedMatchesSelected ? '' : previousVisitedMaster?.hotspot_name) ||
        route?.location_name ||
        '',
      ).trim();
      const resolvedAnchorTo = String(
        parsedAnchor.to ||
        selectedAnchorMaster?.hotspot_name ||
        (Number(selectedAnchorRow?.item_type || 0) === 5 ? 'Hotel' : '') ||
        route?.next_visiting_location ||
        '',
      ).trim();

      const anchorFromKey = this.deriveLooseCityKey(resolvedAnchorFrom || '');
      const anchorToKey = this.deriveLooseCityKey(resolvedAnchorTo || '');

      const anchorInsideSourcePortion = !!sourceCityKey && (
        anchorFromKey === sourceCityKey
        || anchorToKey === sourceCityKey
      );
      const anchorBeforeDestination = destinationReachedOrder != null && anchorOrder != null
        ? anchorOrder < destinationReachedOrder
        : anchorInsideSourcePortion;

      console.log('[AddHotspotFilter] route_context', {
        planId: Number(route?.itinerary_plan_ID || data?.planId || 0),
        routeId,
        directToggleOff,
        sourceCityKey,
        destinationCityKey,
        anchorType: data?.anchorType || null,
        anchorIndex,
        anchorFrom: resolvedAnchorFrom || null,
        anchorTo: resolvedAnchorTo || null,
        anchorInsideSourcePortion,
        anchorBeforeDestination,
      });

      console.log('[AddHotspotFilter] destination_after_3pm', {
        destinationReachedTime,
        destinationReachedAfter3Pm,
        destinationReachedOrder,
      });

      // Manual hotspot insertion is now relaxed:
      // destination-city hotspots must remain visible even if the destination is reached after 3 PM.
      // Users can continue the itinerary and reach the hotel by 11 PM.
      // Keep route-movement filtering below, but do not hide destination-city hotspots here.
      const shouldHideDestinationHotspots = false;

      const splitLocationTokens = (value: unknown): string[] => {
        return String(value || '')
          .split('|')
          .flatMap((part) => String(part || '').split(','))
          .map((part) => this.normalizeLocationText(part))
          .filter(Boolean);
      };

      const tokenMatchesCity = (value: unknown, cityKey: string): boolean => {
        if (!cityKey) return false;

        return splitLocationTokens(value).some((token) => (
          token === cityKey
          || token.startsWith(`${cityKey} `)
          || token.includes(` ${cityKey} `)
          || token.endsWith(` ${cityKey}`)
        ));
      };

      const hotspotLocationRaw = (row: any): string => String(
        row?.hotspot_location
        || row?.hotspotLocation
        || row?.locationMap
        || '',
      ).trim();

      const hotspotToLocationRaw = (row: any): string => String(
        row?.hotspot_to_location
        || row?.hotspotToLocation
        || row?.toLocationMap
        || row?.hotspot_location
        || row?.hotspotLocation
        || row?.locationMap
        || '',
      ).trim();

      const isRouteMovementHotspot = (row: any): boolean => {
        const fromRaw = hotspotLocationRaw(row);
        const toRaw = hotspotToLocationRaw(row);

        if (!fromRaw || !toRaw) return false;

        const fromTokens = splitLocationTokens(fromRaw);
        const toTokens = splitLocationTokens(toRaw);

        if (!fromTokens.length || !toTokens.length) return false;

        return fromTokens.join('|') !== toTokens.join('|');
      };

      const isHotspotForCurrentRoutePair = (row: any): boolean => {
        const fromRaw = hotspotLocationRaw(row);
        const toRaw = hotspotToLocationRaw(row);

        const fromMatchesSource = tokenMatchesCity(fromRaw, sourceCityKey);
        const fromMatchesDest = tokenMatchesCity(fromRaw, destinationCityKey);
        const toMatchesSource = tokenMatchesCity(toRaw, sourceCityKey);
        const toMatchesDest = tokenMatchesCity(toRaw, destinationCityKey);

        const sameCityRoute =
          !!sourceCityKey &&
          !!destinationCityKey &&
          sourceCityKey === destinationCityKey;

        if (sameCityRoute) {
          return (
            fromMatchesSource ||
            fromMatchesDest ||
            toMatchesSource ||
            toMatchesDest
          );
        }

        return (
          (fromMatchesSource && toMatchesDest) ||
          (fromMatchesDest && toMatchesSource)
        );
      };

      const anchorFromRaw = resolvedAnchorFrom;
      const anchorToRaw = resolvedAnchorTo;

      const anchorFromMatchesSource = tokenMatchesCity(anchorFromRaw, sourceCityKey);
      const anchorFromMatchesDestination = tokenMatchesCity(anchorFromRaw, destinationCityKey);
      const anchorToMatchesSource = tokenMatchesCity(anchorToRaw, sourceCityKey);
      const anchorToMatchesDestination = tokenMatchesCity(anchorToRaw, destinationCityKey);

      const routeIsSameCity =
        !!sourceCityKey &&
        !!destinationCityKey &&
        sourceCityKey === destinationCityKey;

      const hasConcreteAnchorLeg = !!anchorFromRaw || !!anchorToRaw;

      const anchorRepresentsRouteMovement =
        !routeIsSameCity &&
        hasConcreteAnchorLeg &&
        (
          (anchorFromMatchesSource && anchorToMatchesDestination) ||
          (anchorFromMatchesDestination && anchorToMatchesSource)
        );

      const isHotspotAllowedForCurrentAnchor = (row: any): boolean => {
        if (!isRouteMovementHotspot(row)) return true;

        if (hasConcreteAnchorLeg && !anchorRepresentsRouteMovement) {
          return false;
        }

        return isHotspotForCurrentRoutePair(row);
      };

      let routeMovementHotspotsHidden = 0;
      const hotspots = safeBaseHotspots.filter((row: any) => {
        const name = String(row?.name || row?.hotspot_name || '').trim();
        const fromRaw = hotspotLocationRaw(row);
        const toRaw = hotspotToLocationRaw(row);

        if (!isHotspotAllowedForCurrentAnchor(row)) {
          routeMovementHotspotsHidden += 1;
          console.log('[AddHotspotFilter] hiding_route_movement_hotspot_wrong_anchor', {
            hotspotId: Number(row?.id || row?.hotspot_ID || 0),
            hotspotName: name,
            hotspotLocation: fromRaw,
            hotspotToLocation: toRaw,
            sourceCityKey,
            destinationCityKey,
            anchorFrom: anchorFromRaw || null,
            anchorTo: anchorToRaw || null,
            anchorRepresentsRouteMovement,
          });
          return false;
        }

        // Destination-city hotspots are no longer hidden for manual insertion.
        // This allows the destination-city tab and destination hotspots to be shown.
        // Route-movement hotspots are still filtered above when the anchor is wrong.
        return true;
      });

      const hotspotFilterMeta = {
        directToggleOff,
        sourceCityKey,
        destinationCityKey,
        destinationReachedTime,
        destinationReachedAfter3Pm,
        destinationCityHotspotsHidden: 0,
        destinationCityHotspotsVisibleAfter3Pm: true,
        routeMovementHotspotsHidden,
        anchorType: data?.anchorType || null,
        anchorIndex,
        anchorFrom: resolvedAnchorFrom || null,
        anchorTo: resolvedAnchorTo || null,
        anchorRepresentsRouteMovement,
        filterFallbackUsed: false,
      };

      console.log('[AddHotspotFilter] result_counts', {
        beforeCount: safeBaseHotspots.length,
        afterCount: hotspots.length,
        destinationCityHotspotsHidden: 0,
        destinationCityHotspotsVisibleAfter3Pm: true,
        routeMovementHotspotsHidden,
        shouldHideDestinationHotspots,
        anchorFrom: anchorFromRaw || null,
        anchorTo: anchorToRaw || null,
        anchorRepresentsRouteMovement,
      });

      return {
        hotspots,
        hotspotFilterMeta,
      };
    } catch (error: any) {
      console.error('[AddHotspotFilter] fallback_due_to_error', {
        routeId,
        planId: Number(data?.planId || 0),
        anchorType: data?.anchorType || null,
        anchorIndex,
        message: String(error?.message || error),
        stack: String(error?.stack || ''),
      });

      return {
        hotspots: safeBaseHotspots,
        hotspotFilterMeta: {
          ...fallbackMeta,
          filterFallbackUsed: true,
        },
      };
    }
  }


  /**
   * Add a hotspot to an itinerary route
   */
  async addHotspot(data: { planId: number; routeId: number; hotspotId: number }) {
    const userId = 1;

    // 1) Insert the manual hotspot record first
    // We mark it with hotspot_plan_own_way = 1 so the engine preserves it
    await (this.prisma as any).dvi_itinerary_route_hotspot_details.create({
      data: {
        itinerary_plan_ID: data.planId,
        itinerary_route_ID: data.routeId,
        hotspot_ID: data.hotspotId,
        item_type: 4, // Hotspot/Attraction type
        hotspot_plan_own_way: 1, // MARK AS MANUAL
        createdby: userId,
        createdon: new Date(),
        status: 1,
        deleted: 0,
      },
    });

    // 1.5) Remove from excluded list if it was previously deleted
    const route = await (this.prisma as any).dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: data.routeId },
    });

    const excluded = (route?.excluded_hotspot_ids as number[]) || [];
    const filteredExcluded = excluded.filter((id: number) => id !== data.hotspotId);

    await (this.prisma as any).dvi_itinerary_route_details.update({
      where: { itinerary_route_ID: data.routeId },
      data: { excluded_hotspot_ids: filteredExcluded },
    });

    // 2) Trigger a full rebuild of the hotspots for this plan
    // The engine will now see the manual hotspot, keep it, and calculate all travel times/hotel shifts
    const result = await this.prisma.$transaction(async (tx) => {
      return await this.hotspotEngine.rebuildRouteHotspots(tx, data.planId);
    }, { timeout: 60000 });

    return {
      success: true,
      message: 'Hotspot added and timeline recalculated successfully',
      shiftedItems: result.shiftedItems,
      droppedItems: result.droppedItems,
      rebuildSummary: result.rebuildSummary,
      warnings: result.warnings,
    };
  }

  /**
   * Preview adding a hotspot to an itinerary route
   */
  async previewAddHotspot(data: { planId: number; routeId: number; hotspotId: number }) {
    return this.previewManualHotspot(data.planId, data.routeId, data.hotspotId);
  }

  /**
   * Get available hotels for a route (within 20km radius)
   */
}
