// REPLACE-WHOLE-FILE
// FILE: src/modules/itineraries/engines/hotspot-engine.service.ts

import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../../prisma.service";
import { TimelineBuilder } from "./helpers/timeline.builder";
import { TimelineEnricher } from "./helpers/timeline.enricher";

type Tx = Prisma.TransactionClient;

@Injectable()
export class HotspotEngineService {
  private readonly logger = new Logger(HotspotEngineService.name);

  // We don't use Nest DI for helpers so you don't have to touch the module.
  private readonly timelineBuilder = new TimelineBuilder();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Main entry called from ItinerariesService inside a prisma.$transaction.
   * Mirrors PHP: wipes old hotspot timeline & parking charges and rebuilds them.
   */
  async rebuildRouteHotspots(
    tx: Tx,
    planId: number,
    existingHotspotsFromService?: any[],
    options?: {
      protectedRouteHotspotIds?: number[];
      protectedHotspotIds?: number[];
      anchorOrderByRoute?: Record<number, number>;
    },
  ): Promise<any> {
    // 1) Fetch ALL current hotspots (manual and auto) INCLUDING soft-deleted ones for reference
    // Note: We include deleted:1 records, but the timeline builder/selector will exclude them
    // This ensures deleted hotspots are NOT re-added during rebuild
    let existingHotspots = existingHotspotsFromService;
    
    if (!existingHotspots) {
      existingHotspots = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_plan_ID: planId,
          item_type: 4, // Only actual hotspot visits
        },
      });
    }

    // 1.5) EXTRACT MANUAL HOTSPOTS BEFORE DELETION
    // Manual hotspots (hotspot_plan_own_way=1) must be preserved and reinserted with proper timings
    const manualHotspots = existingHotspots.filter((h: any) => 
      Number(h.hotspot_plan_own_way || 0) === 1 && Number(h.deleted || 0) === 0
    );
    const manualHotspotIds = new Set(manualHotspots.map((h: any) => Number(h.hotspot_ID || 0)));

    console.log('[ManualHotspot][rebuildRouteHotspots] extracted manual hotspots', {
      planId,
      manualHotspotCount: manualHotspots.length,
      manualHotspotIds: Array.from(manualHotspotIds),
    });

    // 2) Delete ONLY active hotspot details before rebuilding. 
    // We keep deleted: 1 records as "tombstones" to prevent auto-selection.
    await (tx as any).dvi_itinerary_route_hotspot_details.deleteMany({
      where: { 
        itinerary_plan_ID: planId,
        deleted: 0,
      },
    });

    await (tx as any).dvi_itinerary_route_hotspot_parking_charge.deleteMany({
      where: { itinerary_plan_ID: planId },
    });

    // 3) Build new timeline rows in memory (WITHOUT manual hotspots)
    // Pass existing hotspots (including deleted ones) to the builder
    // The builder/selector will filter out deleted:1 hotspots so they are NOT re-added
    const { hotspotRows, parkingRows } =
      await this.timelineBuilder.buildTimelineForPlan(tx, planId, existingHotspots);

    console.log('[ManualHotspot][rebuildRouteHotspots] start', {
      planId,
      hotspotRowCount: Array.isArray(hotspotRows) ? hotspotRows.length : 0,
      protectedHotspotIdsCount: Array.isArray(options?.protectedHotspotIds) ? options!.protectedHotspotIds!.length : 0,
      protectedRouteHotspotIdsCount: Array.isArray(options?.protectedRouteHotspotIds) ? options!.protectedRouteHotspotIds!.length : 0,
    });

    // Initialize tracking arrays
    const shiftedItems: any[] = [];
    const droppedItems: any[] = [];

    // 4) Safety filter for final persisted timeline:
    //    - Drop unschedulable AUTO hotspots from rebuild output.
    //    - Preserve manual hotspots for manual-confirmed flows.
    const protectedRouteHotspotIds = new Set(
      (options?.protectedRouteHotspotIds || [])
        .map((id) => Number(id || 0))
        .filter((id) => id > 0),
    );
    const protectedHotspotIds = new Set(
      (options?.protectedHotspotIds || [])
        .map((id) => Number(id || 0))
        .filter((id) => id > 0),
    );

    // ✅ ADD MANUAL HOTSPOTS TO PROTECTION SET SO THEY ARE NOT FILTERED OUT
    for (const manualId of manualHotspotIds) {
      protectedHotspotIds.add(manualId);
    }

    const anchorOrderByRoute = options?.anchorOrderByRoute || {};

    const droppedAutoConflicts = new Set<string>();
    for (const row of hotspotRows as any[]) {
      const isHotspotVisit = Number((row as any).item_type || 0) === 4;
      if (!isHotspotVisit) continue;

      const rowRouteHotspotId = Number((row as any).route_hotspot_ID || 0);
      const rowHotspotId = Number((row as any).hotspot_ID || 0);
      const isProtected =
        protectedRouteHotspotIds.has(rowRouteHotspotId) ||
        protectedHotspotIds.has(rowHotspotId);
      if (isProtected) {
        continue;
      }

      const isConflict = (row as any).isConflict === true;
      const isManual =
        Number((row as any).hotspot_plan_own_way || 0) === 1 ||
        (row as any).isManual === true;

      if (isConflict && !isManual) {
        droppedAutoConflicts.add(
          `${Number((row as any).itinerary_route_ID || 0)}|${Number((row as any).hotspot_order || 0)}|${Number((row as any).hotspot_ID || 0)}`,
        );
      }
    }

    // 4.1) Enforce one occurrence per hotspot_ID per route.
    // Keep the anchored/protected occurrence and drop duplicate auto-selected ghosts.
    const visitRows = (hotspotRows as any[]).filter(
      (row) => Number((row as any).item_type || 0) === 4 && Number((row as any).hotspot_ID || 0) > 0,
    );
    const grouped = new Map<string, any[]>();
    for (const row of visitRows) {
      const routeId = Number((row as any).itinerary_route_ID || 0);
      const hotspotId = Number((row as any).hotspot_ID || 0);
      const key = `${routeId}|${hotspotId}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(row);
    }

    for (const [key, rows] of grouped.entries()) {
      if (rows.length <= 1) continue;

      const [routeIdStr] = key.split('|');
      const routeId = Number(routeIdStr || 0);
      const preferredOrder = Number((anchorOrderByRoute as any)[routeId] || 0);

      let keep = rows.find((r: any) =>
        protectedRouteHotspotIds.has(Number((r as any).route_hotspot_ID || 0)),
      );

      if (!keep && preferredOrder > 0) {
        keep = [...rows].sort((a: any, b: any) => {
          const da = Math.abs(Number((a as any).hotspot_order || 0) - preferredOrder);
          const db = Math.abs(Number((b as any).hotspot_order || 0) - preferredOrder);
          return da - db;
        })[0];
      }

      if (!keep) {
        keep = rows[0];
      }

      for (const row of rows) {
        if (row === keep) continue;
        droppedAutoConflicts.add(
          `${Number((row as any).itinerary_route_ID || 0)}|${Number((row as any).hotspot_order || 0)}|${Number((row as any).hotspot_ID || 0)}`,
        );
      }
    }

    const filteredHotspotRows = (hotspotRows as any[]).filter((row) => {
      const key = `${Number((row as any).itinerary_route_ID || 0)}|${Number((row as any).hotspot_order || 0)}|${Number((row as any).hotspot_ID || 0)}`;
      if (droppedAutoConflicts.has(key)) return false;

      // Some travel rows may not carry hotspot_ID; drop by route+order fallback.
      if (Number((row as any).item_type || 0) === 3) {
        const fallbackKey = `${Number((row as any).itinerary_route_ID || 0)}|${Number((row as any).hotspot_order || 0)}|0`;
        if (droppedAutoConflicts.has(fallbackKey)) return false;
      }

      return true;
    });

    // Populate droppedItems from all dropped/conflict auto-hotspot entries
    const droppedHotspotIdList: number[] = [];
    for (const key of droppedAutoConflicts) {
      const parts = key.split('|');
      const hId = Number(parts[2] || 0);
      if (hId > 0 && !droppedHotspotIdList.includes(hId)) droppedHotspotIdList.push(hId);
    }
    if (droppedHotspotIdList.length > 0) {
      const droppedMasters = await (tx as any).dvi_hotspot_place.findMany({
        where: { hotspot_ID: { in: droppedHotspotIdList } },
        select: { hotspot_ID: true, hotspot_name: true, hotspot_priority: true },
      });
      const droppedNameMap = new Map<number, any>(
        droppedMasters.map((m: any) => [Number(m.hotspot_ID), m]),
      );
      for (const key of droppedAutoConflicts) {
        const [rIdStr, ordStr, hIdStr] = key.split('|');
        const hId = Number(hIdStr || 0);
        const rId = Number(rIdStr || 0);
        const ord = Number(ordStr || 0);
        if (hId <= 0) continue;
        const master = droppedNameMap.get(hId);
        const origRow = (hotspotRows as any[]).find(
          (r: any) =>
            Number(r.itinerary_route_ID) === rId &&
            Number(r.hotspot_order) === ord &&
            Number(r.hotspot_ID) === hId,
        );
        droppedItems.push({
          itineraryRouteId: rId,
          hotspotId: hId,
          routeHotspotId: Number(origRow?.route_hotspot_ID || 0),
          name: String(master?.hotspot_name || `Hotspot #${hId}`),
          hotspotOrder: ord,
          priority: Number(master?.hotspot_priority || 0),
          reason: 'Removed lower-priority hotspot to fit fixed manual hotspot',
        });
      }
    }

    const droppedRouteHotspotPairs = new Set<string>();
    for (const key of droppedAutoConflicts) {
      const [routeId, _order, hotspotId] = key.split('|');
      droppedRouteHotspotPairs.add(`${routeId}|${hotspotId}`);
    }

    const filteredParkingRows = parkingRows.filter((row: any) => {
      const pair = `${Number((row as any).itinerary_route_ID || 0)}|${Number((row as any).hotspot_ID || 0)}`;
      return !droppedRouteHotspotPairs.has(pair);
    });

    // ============================================================================
    // 4.5) INJECT MANUAL HOTSPOTS INTO FILTERED TIMELINE
    // Manual hotspots with order=999 must be inserted with proper order and timing
    // ============================================================================
    if (manualHotspots.length > 0) {
      console.log('[ManualHotspot][rebuildRouteHotspots] injecting manual hotspots', {
        planId,
        manualCount: manualHotspots.length,
      });

      // Group filteredHotspotRows by route for easier insertion
      const rowsByRoute = new Map<number, any[]>();
      for (const row of filteredHotspotRows as any[]) {
        const routeId = Number((row as any).itinerary_route_ID || 0);
        if (!rowsByRoute.has(routeId)) rowsByRoute.set(routeId, []);
        rowsByRoute.get(routeId)!.push(row);
      }

      // Process each manual hotspot
      for (const manualHotspot of manualHotspots) {
        const routeId = Number(manualHotspot.itinerary_route_ID || 0);
        const hotspotId = Number(manualHotspot.hotspot_ID || 0);
        const routeRows = rowsByRoute.get(routeId) || [];

        if (routeRows.length === 0) {
          console.warn('[ManualHotspot] No auto hotspots found for route, cannot inject manual hotspot', {
            routeId,
            hotspotId,
          });
          continue;
        }

        // Find all hotspot visit rows for this route (item_type = 4)
        const visitRows = routeRows.filter((r: any) => Number(r.item_type || 0) === 4);

        if (visitRows.length === 0) {
          console.warn('[ManualHotspot][PROOF] No visit rows found - using first position', {
            routeId,
            hotspotId,
          });
          manualHotspot.hotspot_order = 1;
          rowsByRoute.get(routeId)!.push(manualHotspot);
          continue;
        }

        // Find insertion point: insert after last visit hotspot
        const lastVisitIndex = Math.max(
          ...visitRows.map((r: any) => rowsByRoute.get(routeId)!.indexOf(r))
        );
        const insertionPoint = lastVisitIndex + 1;

        // ════════════════════════════════════════════════════════════════
        // PROOF: Log last visit row details
        // ════════════════════════════════════════════════════════════════
        const lastVisitRow = visitRows[visitRows.length - 1];
        console.log(`\n[ManualHotspot][PROOF][${hotspotId}] LAST VISIT ROW DETAILS:`, {
          routeId,
          hotspotId: hotspotId,
          lastVisitRow_route_hotspot_ID: lastVisitRow?.route_hotspot_ID,
          lastVisitRow_hotspot_ID: lastVisitRow?.hotspot_ID,
          lastVisitRow_item_type: lastVisitRow?.item_type,
          lastVisitRow_hotspot_order: lastVisitRow?.hotspot_order,
          lastVisitRow_hotspot_start_time: lastVisitRow?.hotspot_start_time,
          lastVisitRow_hotspot_end_time: lastVisitRow?.hotspot_end_time,
          lastVisitRow_hotspot_plan_own_way: lastVisitRow?.hotspot_plan_own_way,
        });

        const lastVisitEndTime = lastVisitRow?.hotspot_end_time || lastVisitRow?.hotspot_start_time;
        console.log(`[ManualHotspot][PROOF] Extracted lastVisitEndTime:`, {
          value: lastVisitEndTime,
          source: lastVisitRow?.hotspot_end_time ? 'hotspot_end_time' : 'hotspot_start_time',
        });

        // Get route to find bounds
        const route = await (tx as any).dvi_itinerary_route_details.findUnique({
          where: { itinerary_route_ID: routeId },
          select: { route_start_time: true, route_end_time: true },
        });

        // ════════════════════════════════════════════════════════════════
        // PROOF: Log manualStartTime decision tree
        // ════════════════════════════════════════════════════════════════
        const manualStartTime = lastVisitEndTime || route?.route_start_time || new Date();
        console.log(`[ManualHotspot][PROOF] Calculated manualStartTime:`, {
          value: manualStartTime,
          source: lastVisitEndTime ? 'lastVisitEndTime' : (route?.route_start_time ? 'route_start_time' : 'new Date()'),
          lastVisitEndTime_exists: !!lastVisitEndTime,
          route_start_time: route?.route_start_time,
        });

        // ════════════════════════════════════════════════════════════════
        // PROOF: Fetch hotspot master to see if duration exists
        // ════════════════════════════════════════════════════════════════
        const hotspotMaster = await (tx as any).dvi_hotspot_place.findUnique({
          where: { hotspot_ID: hotspotId },
          select: {
            hotspot_ID: true,
            hotspot_name: true,
            hotspot_duration: true,
            hotspot_priority: true,
          },
        });
        console.log(`[ManualHotspot][PROOF] Hotspot master data:`, {
          hotspot_ID: hotspotMaster?.hotspot_ID,
          hotspot_name: hotspotMaster?.hotspot_name,
          hotspot_duration: hotspotMaster?.hotspot_duration,
          hotspot_priority: hotspotMaster?.hotspot_priority,
        });

        // ════════════════════════════════════════════════════════════════
        // CURRENT BEHAVIOR: manualEndTime = manualStartTime (NO DURATION)
        // ════════════════════════════════════════════════════════════════
        const manualEndTime = manualStartTime;
        console.log(`[ManualHotspot][PROOF] Set manualEndTime to manualStartTime (NO DURATION APPLIED):`, {
          manualStartTime,
          manualEndTime,
          sameValue: manualStartTime === manualEndTime,
          note: 'END TIME EQUALS START TIME - THIS IS A BUG',
        });

        // Update manual hotspot with real order and timing
        manualHotspot.hotspot_order = Math.max(...visitRows.map((r: any) => Number(r.hotspot_order || 0))) + 1;
        manualHotspot.hotspot_start_time = manualStartTime;
        manualHotspot.hotspot_end_time = manualEndTime;

        console.log('[ManualHotspot][rebuildRouteHotspots] injected manual hotspot', {
          planId,
          routeId,
          hotspotId,
          assignedOrder: manualHotspot.hotspot_order,
          startTime: manualStartTime,
        });

        // Insert the manual hotspot at the injection point
        rowsByRoute.get(routeId)!.splice(insertionPoint, 0, manualHotspot);
      }

      // Rebuild filteredHotspotRows from updated rowsByRoute
      const rebuiltRows: any[] = [];
      for (const [routeId, routes] of rowsByRoute.entries()) {
        rebuiltRows.push(...routes);
      }

      // Re-assign sequential order numbers for all hotspot visits in each route
      const routed = new Map<number, any[]>();
      for (const row of rebuiltRows) {
        const routeId = Number(row.itinerary_route_ID || 0);
        if (!routed.has(routeId)) routed.set(routeId, []);
        routed.get(routeId)!.push(row);
      }

      for (const [routeId, rows] of routed.entries()) {
        let orderIndex = 1;
        for (const row of rows) {
          if (Number(row.item_type || 0) === 4) {
            row.hotspot_order = orderIndex;
            orderIndex++;
          }
        }
      }

      // Replace filteredHotspotRows with rebuilt version
      filteredHotspotRows.length = 0;
      filteredHotspotRows.push(...rebuiltRows);
    }

    // 5) CRITICAL: Delete old active manual placeholder rows before persisting final rebuilt timeline
    // This ensures no old order=999 placeholder/manual rows remain in DB
    if (manualHotspotIds.size > 0) {
      const manualIdArray = Array.from(manualHotspotIds);
      await (tx as any).dvi_itinerary_route_hotspot_details.deleteMany({
        where: {
          itinerary_plan_ID: planId,
          hotspot_ID: { in: manualIdArray },
          hotspot_plan_own_way: 1,
          deleted: 0,
        },
      });
      console.log('[ManualHotspot][rebuildRouteHotspots] deleted old manual placeholder rows', {
        planId,
        manualHotspotIds: manualIdArray,
      });
    }

    // 5.5) DEDUPE final timeline rows before persistence
    // Remove exact duplicates: same route + item_type + hotspot_id + same timing
    const dedupeMap = new Map<string, any>();
    const beforeDedupeCount = filteredHotspotRows.length;
    
    for (const row of filteredHotspotRows as any[]) {
      const routeId = Number(row.itinerary_route_ID || 0);
      const itemType = Number(row.item_type || 0);
      const hotspotId = Number(row.hotspot_ID || 0);
      const startTime = row.hotspot_start_time ? new Date(row.hotspot_start_time).getTime() : 0;
      const endTime = row.hotspot_end_time ? new Date(row.hotspot_end_time).getTime() : 0;
      
      // Dedup key: route + item_type + hotspot_id + timing
      // Keep the key without the unique row_hotspot_ID so duplicates are caught
      const dedupKey = `${routeId}|${itemType}|${hotspotId}|${startTime}|${endTime}`;
      
      // Keep first occurrence (prefer protected/manual hotspots if already in map)
      if (!dedupeMap.has(dedupKey)) {
        dedupeMap.set(dedupKey, row);
      } else {
        // If this is a protected/manual hotspot, prefer it over what's already in the map
        const existing = dedupeMap.get(dedupKey)!;
        const rowIsProtected = protectedHotspotIds.has(hotspotId);
        const existingIsProtected = protectedHotspotIds.has(Number(existing.hotspot_ID || 0));
        if (rowIsProtected && !existingIsProtected) {
          dedupeMap.set(dedupKey, row);
        }
      }
    }
    
    const dedupenedRows = Array.from(dedupeMap.values());
    const afterDedupeCount = dedupenedRows.length;
    
    console.log('[ManualHotspot][rebuildRouteHotspots] deduped final rows', {
      planId,
      beforeDedupeCount,
      afterDedupeCount,
      duplicatesRemoved: beforeDedupeCount - afterDedupeCount,
    });

    // 5.7) SORT final timeline rows by hotspot_start_time ASC (chronological)
    // Item type priority when times are equal: 1 (start) < 3 (travel) < 4 (attraction) < 5 (hotel travel) < 6 (hotel)
    const itemTypePriority: Record<number, number> = {
      1: 0, // refreshment/start
      3: 1, // travel
      4: 2, // attraction
      5: 3, // hotel travel
      6: 4, // hotel/checkin
    };
    
    const sortedRows = [...dedupenedRows].sort((a: any, b: any) => {
      const aTime = a.hotspot_start_time ? new Date(a.hotspot_start_time).getTime() : 0;
      const bTime = b.hotspot_start_time ? new Date(b.hotspot_start_time).getTime() : 0;
      
      if (aTime !== bTime) {
        return aTime - bTime; // Chronological
      }
      
      // Same time: sort by item_type priority
      const aPriority = itemTypePriority[Number(a.item_type || 0)] ?? 99;
      const bPriority = itemTypePriority[Number(b.item_type || 0)] ?? 99;
      
      return aPriority - bPriority;
    });

    console.log('[ManualHotspot][rebuildRouteHotspots] sorted final rows by timestamp', {
      planId,
      rowCount: sortedRows.length,
    });

    // 5.9) REASSIGN hotspot_order sequentially after sort (normalize order numbers)
    // Process per-route to ensure correct order per route
    const routeOrdering = new Map<number, number>();
    for (const row of sortedRows as any[]) {
      const routeId = Number(row.itinerary_route_ID || 0);
      const itemType = Number(row.item_type || 0);
      
      if (itemType === 4) { // Only hotspot visits get order
        if (!routeOrdering.has(routeId)) {
          routeOrdering.set(routeId, 1);
        }
        const currentOrder = routeOrdering.get(routeId)!;
        row.hotspot_order = currentOrder;
        routeOrdering.set(routeId, currentOrder + 1);
      }
    }

    console.log('[ManualHotspot][rebuildRouteHotspots] reassigned hotspot_order after sort', {
      planId,
      sortedRowCount: sortedRows.length,
      routesProcessed: routeOrdering.size,
    });

    // 6) Insert hotspot details (using the final sorted, deduped, normalized rows)
    const dbHotspotRows = sortedRows.map(row => {
      // Strip out UI-only fields before saving to DB
      const { 
        isConflict, 
        conflictReason, 
        isManual, 
        type, 
        text, 
        timeRange, 
        locationId,
        ...dbRow 
      } = row as any;
      
      return {
        ...dbRow,
        is_conflict: isConflict ? 1 : 0,
        conflict_reason: conflictReason || null,
      };
    });

    const targetIndex = dbHotspotRows.findIndex((row: any) =>
      Number((row as any).itinerary_plan_ID || 0) === 268 &&
      Number((row as any).itinerary_route_ID || 0) === 1238 &&
      Number((row as any).hotspot_ID || 0) === 13 &&
      Number((row as any).item_type || 0) === 4,
    );

    if (targetIndex >= 0) {
      const target = dbHotspotRows[targetIndex] as any;
      const prev = targetIndex > 0 ? (dbHotspotRows[targetIndex - 1] as any) : null;
      const startDate = target.hotspot_start_time ? new Date(target.hotspot_start_time) : null;
      const endDate = target.hotspot_end_time ? new Date(target.hotspot_end_time) : null;
      const startSeconds = startDate
        ? startDate.getUTCHours() * 3600 + startDate.getUTCMinutes() * 60 + startDate.getUTCSeconds()
        : null;
      const endSeconds = endDate
        ? endDate.getUTCHours() * 3600 + endDate.getUTCMinutes() * 60 + endDate.getUTCSeconds()
        : null;

      console.log('[RouteHotspotWrite][PROOF] createMany payload target row', {
        planId,
        routeId: target.itinerary_route_ID,
        hotspotId: target.hotspot_ID,
        routeHotspotId: null,
        previousRowInfo: prev
          ? {
              itemType: prev.item_type,
              hotspotId: prev.hotspot_ID,
              hotspotOrder: prev.hotspot_order,
              start: prev.hotspot_start_time,
              end: prev.hotspot_end_time,
            }
          : null,
        computedStart: target.hotspot_start_time,
        computedEnd: target.hotspot_end_time,
        absoluteSeconds: {
          startSeconds,
          endSeconds,
        },
        wrappedTimes: {
          start: startDate ? `${String(startDate.getUTCHours()).padStart(2, '0')}:${String(startDate.getUTCMinutes()).padStart(2, '0')}:${String(startDate.getUTCSeconds()).padStart(2, '0')}` : null,
          end: endDate ? `${String(endDate.getUTCHours()).padStart(2, '0')}:${String(endDate.getUTCMinutes()).padStart(2, '0')}:${String(endDate.getUTCSeconds()).padStart(2, '0')}` : null,
        },
        endBeforeStart: startSeconds !== null && endSeconds !== null ? endSeconds < startSeconds : null,
        isConflictToPersist: target.is_conflict,
        conflictReasonToPersist: target.conflict_reason,
      });
    }

    await (tx as any).dvi_itinerary_route_hotspot_details.createMany({
      data: dbHotspotRows,
    });

    if (targetIndex >= 0) {
      const target = dbHotspotRows[targetIndex] as any;
      const persistedTarget = await (tx as any).dvi_itinerary_route_hotspot_details.findFirst({
        where: {
          itinerary_plan_ID: Number(target.itinerary_plan_ID || 0),
          itinerary_route_ID: Number(target.itinerary_route_ID || 0),
          hotspot_ID: Number(target.hotspot_ID || 0),
          item_type: Number(target.item_type || 0),
          hotspot_order: Number(target.hotspot_order || 0),
          hotspot_start_time: target.hotspot_start_time,
          hotspot_end_time: target.hotspot_end_time,
          deleted: 0,
        },
        orderBy: { route_hotspot_ID: 'desc' },
        select: {
          route_hotspot_ID: true,
          itinerary_route_ID: true,
          hotspot_ID: true,
          hotspot_start_time: true,
          hotspot_end_time: true,
          is_conflict: true,
        },
      });

      console.log('[RouteHotspotWrite][PROOF] createMany persisted target row lookup', {
        planId,
        routeId: persistedTarget?.itinerary_route_ID ?? target.itinerary_route_ID,
        hotspotId: persistedTarget?.hotspot_ID ?? target.hotspot_ID,
        routeHotspotId: persistedTarget?.route_hotspot_ID ?? null,
        persistedStart: persistedTarget?.hotspot_start_time ?? null,
        persistedEnd: persistedTarget?.hotspot_end_time ?? null,
        persistedIsConflict: persistedTarget?.is_conflict ?? null,
      });
    }

    // 6) Insert parking charge rows (if any)
    if (filteredParkingRows.length) {
      await (tx as any).dvi_itinerary_route_hotspot_parking_charge.createMany({
        data: filteredParkingRows,
      });
    }

    // 7) VERIFY manual hotspots were properly persisted with real order and timing
    if (manualHotspotIds.size > 0) {
      const manualIds = Array.from(manualHotspotIds);
      const persistedManualRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_plan_ID: planId,
          item_type: 4,
          hotspot_ID: { in: manualIds },
          deleted: 0,
        },
        select: {
          route_hotspot_ID: true,
          hotspot_ID: true,
          itinerary_route_ID: true,
          hotspot_order: true,
          hotspot_start_time: true,
          hotspot_end_time: true,
          hotspot_plan_own_way: true,
        },
      });

      for (const mRow of persistedManualRows) {
        const order = Number(mRow.hotspot_order || 0);
        const startTime = mRow.hotspot_start_time ? new Date(mRow.hotspot_start_time).getTime() : 0;
        const isPlaceholder = order === 999 || startTime === new Date('1970-01-01T00:00:00Z').getTime();
        
        if (isPlaceholder) {
          console.error('[ManualHotspot][rebuildRouteHotspots] ERROR: manual hotspot persisted with placeholder values', {
            planId,
            hotspotId: mRow.hotspot_ID,
            routeId: mRow.itinerary_route_ID,
            order,
            startTime: mRow.hotspot_start_time,
          });
          // Do NOT silently accept this - the injection logic failed
          throw new Error(`Manual hotspot ${mRow.hotspot_ID} was not properly integrated: order=${order}, hasPlaceholderTime=${isPlaceholder}`);
        }
      }

      console.log('[ManualHotspot][rebuildRouteHotspots] manual hotspot persistence verification passed', {
        planId,
        manualHotspotIds: manualIds,
        persistedManualCount: persistedManualRows.length,
        details: persistedManualRows.map((r: any) => ({
          hotspotId: r.hotspot_ID,
          routeId: r.itinerary_route_ID,
          order: r.hotspot_order,
          startTime: r.hotspot_start_time,
        })),
      });
    }

    return { shiftedItems, droppedItems };
  }

  /**
   * Rebuild ONLY parking charges for a plan (called after vendor vehicles are created).
   * This is needed because parking charge builder requires vendor vehicle details.
   */
  async rebuildParkingCharges(planId: number, userId: number): Promise<void> {
    await this.prisma.$transaction(async (tx: Tx) => {
      // Delete existing parking charges
      await (tx as any).dvi_itinerary_route_hotspot_parking_charge.deleteMany({
        where: { itinerary_plan_ID: planId },
      });

      // Get all route hotspot details for this plan
      const hotspotDetails = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_plan_ID: planId,
          item_type: 4, // Only actual hotspot visits (not travel segments)
          deleted: 0,
          status: 1,
        },
        orderBy: { route_hotspot_ID: 'asc' },
      });

      const parkingRows = [];
      for (const detail of hotspotDetails) {
        const parkingRowsForHotspot = await this.timelineBuilder.parkingBuilder.buildForHotspot(tx, {
          planId,
          routeId: detail.itinerary_route_ID,
          hotspotId: detail.hotspot_ID,
          userId,
        });
        if (parkingRowsForHotspot && parkingRowsForHotspot.length > 0) {
          parkingRows.push(...parkingRowsForHotspot);
        }
      }

      // Insert parking charges
      if (parkingRows.length) {
        await (tx as any).dvi_itinerary_route_hotspot_parking_charge.createMany({
          data: parkingRows,
        });
      }
    }, { timeout: 60000 });
  }

  /**
   * Preview adding a manual hotspot without saving to DB.
   */
  async previewManualHotspotAdd(
    tx: Tx,
    planId: number,
    routeId: number,
    hotspotId: number,
    options?: {
      droppedItems?: any[];
      shiftedItems?: any[];
      resolution?: any;
    },
  ): Promise<any> {
    console.log(`\n🔍 PREVIEW-ADD: planId=${planId}, routeId=${routeId}, hotspotId=${hotspotId}`);
    console.log('[ManualHotspot][previewManualHotspotAdd] input', {
      planId,
      routeId,
      hotspotId,
      stillUnschedulable: options?.resolution?.stillUnschedulable,
      droppedItemsCount: Array.isArray(options?.droppedItems) ? options!.droppedItems!.length : 0,
    });
    
    // 1) Fetch the current route details
    const currentRoute = await (tx as any).dvi_itinerary_route_details.findFirst({
      where: { itinerary_route_ID: routeId },
      select: {
        itinerary_route_ID: true,
        location_name: true,
        next_visiting_location: true,
        direct_to_next_visiting_place: true,
        itinerary_route_date: true,
        route_start_time: true,
        route_end_time: true,
      },
    });

    if (!currentRoute) {
      throw new Error(`Route ${routeId} not found`);
    }
    
    console.log(`📍 Route ${routeId}: ${currentRoute.location_name} → ${currentRoute.next_visiting_location}`);
    console.log(`⏰ Route timing: ${currentRoute.route_start_time} to ${currentRoute.route_end_time}`);

    // 2) Check if there's a next route that connects to this one
    let nextRoute = null;
    let shouldIncludeNextDay = false;

    const currentDestination = (currentRoute.next_visiting_location || "").split("|")[0].trim();
    
    // Find next route by checking date order
    const allRoutes = await (tx as any).dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: planId },
      orderBy: { itinerary_route_date: 'asc' },
      select: {
        itinerary_route_ID: true,
        location_name: true,
        next_visiting_location: true,
        direct_to_next_visiting_place: true,
        itinerary_route_date: true,
      },
    });

    const currentRouteIndex = allRoutes.findIndex((r: any) => r.itinerary_route_ID === routeId);
    
    if (currentRouteIndex !== -1 && currentRouteIndex + 1 < allRoutes.length) {
      const potentialNextRoute = allRoutes[currentRouteIndex + 1];
      const nextSource = (potentialNextRoute.location_name || "").split("|")[0].trim();
      const isDirectToNext = Number(potentialNextRoute.direct_to_next_visiting_place || 0) === 1;

      // Check if next route's source matches current route's destination AND it's not direct
      if (nextSource === currentDestination && !isDirectToNext) {
        nextRoute = potentialNextRoute;
        shouldIncludeNextDay = true;
      }
    }

    // 3) Resolve current/next route scope for preview rendering
    const routeIdsToInclude = [routeId];
    if (shouldIncludeNextDay && nextRoute) {
      routeIdsToInclude.push(nextRoute.itinerary_route_ID);
    }

    const shiftedItems: any[] = options?.shiftedItems ?? [];
    const passedDroppedItems: any[] = Array.isArray(options?.droppedItems) ? options!.droppedItems! : [];

    // Branch A: adaptive insertion already succeeded. Read current rebuilt DB state directly.
    // Do NOT re-run a competing timeline builder path here.
    if (options?.resolution?.stillUnschedulable === false) {
      console.log('[ManualHotspot][previewManualHotspotAdd] success branch hit', {
        planId,
        routeId,
        hotspotId,
      });

      const persistedRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_plan_ID: planId,
          itinerary_route_ID: { in: routeIdsToInclude },
          deleted: 0,
        },
        orderBy: [
          { itinerary_route_ID: 'asc' },
          { hotspot_order: 'asc' },
          { route_hotspot_ID: 'asc' },
        ],
      });

      const enrichedTimeline = await TimelineEnricher.enrich(tx, planId, persistedRows as any[]);
      const newHotspotRow = enrichedTimeline.find(
        (r) => Number(r.itinerary_route_ID) === Number(routeId) &&
               Number(r.hotspot_ID) === Number(hotspotId) &&
               Number(r.item_type) === 4,
      );

      console.log('[ManualHotspot][previewManualHotspotAdd] success branch timeline snapshot', {
        planId,
        routeId,
        hotspotId,
        persistedRowsCount: persistedRows.length,
        enrichedTimelineCount: enrichedTimeline.length,
        selectedHotspotFound: !!newHotspotRow,
      });

      if (!newHotspotRow) {
        console.error('[ManualHotspot][previewManualHotspotAdd] success branch failed: selected hotspot row missing in rebuilt persisted timeline', {
          planId,
          routeId,
          hotspotId,
          persistedRowsCount: persistedRows.length,
          enrichedTimelineCount: enrichedTimeline.length,
        });
        throw new Error('Resolved preview expected selected hotspot in rebuilt persisted timeline but none was found');
      }

      const removedIds = new Set<number>(
        passedDroppedItems
          .map((d: any) => Number(d?.hotspotId || d?.id || 0))
          .filter((id: number) => Number.isFinite(id) && id > 0),
      );

      const otherConflicts = enrichedTimeline.filter(
        (r: any) =>
          Number(r.item_type) === 4 &&
          r.isConflict === true &&
          !(Number(r.itinerary_route_ID) === Number(routeId) && Number(r.hotspot_ID) === Number(hotspotId)) &&
          !removedIds.has(Number(r.hotspot_ID || 0)),
      );

      return {
        newHotspot: newHotspotRow || null,
        otherConflicts: otherConflicts.map((c: any) => ({
          hotspotId: c.hotspot_ID,
          reason: c.conflictReason,
        })),
        shiftedItems,
        droppedItems: passedDroppedItems,
        fullTimeline: enrichedTimeline,
        includedRouteIds: routeIdsToInclude,
        nextRouteIncluded: shouldIncludeNextDay,
        resolution: options?.resolution,
      };
    }

    // ========== BRANCH B: FALLBACK - Adaptive insertion failed ==========
    console.log('[ManualHotspot][previewManualHotspotAdd] fallback branch hit', {
      planId,
      routeId,
      hotspotId,
      stillUnschedulable: options?.resolution?.stillUnschedulable,
    });

    // 1) Read persisted hotspot rows from DB directly (no buildTimelineForPlan)
    const hotspotRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        itinerary_route_ID: { in: routeIdsToInclude },
        deleted: 0,
      },
    });

    // 2) Filter to included routes only
    const filteredRows = hotspotRows.filter(row => 
      routeIdsToInclude.includes(Number(row.itinerary_route_ID))
    );

    // 3) Enrich rows with UI fields
    const enrichedTimeline = await TimelineEnricher.enrich(tx, planId, filteredRows);

    // 4) Find the manual hotspot in persisted data (already inserted by ensureManualHotspotRow)
    const newHotspotRow = enrichedTimeline.find(
      (r) => Number(r.itinerary_route_ID) === Number(routeId) && 
             Number(r.hotspot_ID) === Number(hotspotId) && 
             r.item_type === 4
    );

    // 5) Mark the newly added hotspot as conflict (since adaptive insertion failed)
    if (newHotspotRow) {
      (newHotspotRow as any).isConflict = true;
      (newHotspotRow as any).conflictReason = 'Manual insertion could not fit in schedule.';
      console.log(`📊 [FALLBACK] Marked hotspot ${hotspotId} as conflict (adaptive insertion failed)`);
    } else {
      console.warn(`⚠️ [FALLBACK] Could not find hotspot ${hotspotId} in persisted data`);
    }

    // 6) Check for other conflicts (excluding the manual hotspot itself)
    const otherConflicts = enrichedTimeline.filter(
      (r) => r.item_type === 4 && 
             (r as any).isConflict && 
             !(Number(r.itinerary_route_ID) === Number(routeId) && Number(r.hotspot_ID) === Number(hotspotId))
    );

    console.log(`[ManualHotspot][previewManualHotspotAdd] fallback result:`, {
      foundNewHotspot: !!newHotspotRow,
      otherConflicts: otherConflicts.length,
    });

    // 7) Return result with conflict marking
    return {
      newHotspot: newHotspotRow || null,
      otherConflicts: otherConflicts.map(c => ({
        hotspotId: c.hotspot_ID,
        reason: (c as any).conflictReason
      })),
      shiftedItems: [],
      droppedItems: passedDroppedItems,
      fullTimeline: enrichedTimeline,
      includedRouteIds: routeIdsToInclude,
      nextRouteIncluded: shouldIncludeNextDay,
      resolution: options?.resolution,
    };
  }
}