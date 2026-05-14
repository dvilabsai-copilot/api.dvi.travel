import { HotspotDetailRow } from "./types";
import { TimeConverter } from "./time-converter";

export class TimelineEnricher {
  static async enrich(tx: any, planId: number, rows: HotspotDetailRow[]): Promise<any[]> {
    // 1. Fetch hotspot names, priorities, and metadata
    const hotspotIds = rows
      .filter((r) => r.item_type === 4 && r.hotspot_ID)
      .map((r) => r.hotspot_ID as number);

    const hotspotMasters = await tx.dvi_hotspot_place.findMany({
      where: { hotspot_ID: { in: hotspotIds } },
      select: { 
        hotspot_ID: true, 
        hotspot_name: true,
        hotspot_priority: true,
        hotspot_description: true,
        hotspot_video_url: true,
      },
    });
    
    // âœ… FIX: Store both name AND priority for each hotspot
    const hotspotMap = new Map<number, { name: string; priority: number; description: string | null; videoUrl: string | null }>(
      hotspotMasters.map((h: any) => [Number(h.hotspot_ID), {
        name: h.hotspot_name,
        priority: Number(h.hotspot_priority || 0),
        description: h.hotspot_description || null,
        videoUrl: h.hotspot_video_url || null,
      }])
    );

    // 2. Fetch route details for city names
    const routes = await tx.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: planId },
      select: { itinerary_route_ID: true, location_name: true, next_visiting_location: true },
    });
    const routeMap = new Map<number, any>(
      routes.map((r: any) => [Number(r.itinerary_route_ID), r])
    );

    // 3. Map rows to enriched segments
    const enrichedRows = rows.map((row) => {
      const startTime = TimeConverter.toTimeString(row.hotspot_start_time);
      const endTime = TimeConverter.toTimeString(row.hotspot_end_time);
      const timeRange = `${this.formatTime(startTime)} - ${this.formatTime(endTime)}`;
      
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // PROOF LOGGING: For hotspot type items
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      if (row.item_type === 4) {
        const hotspotData = hotspotMap.get(Number(row.hotspot_ID));
        const hotspotName = hotspotData?.name || `Hotspot#${row.hotspot_ID}`;
        const isManual = Number(row.hotspot_plan_own_way || 0) === 1;
        const displayPriority = isManual && Number(hotspotData?.priority || 0) === 0 ? 4 : Number(hotspotData?.priority || 0);
        console.log(`\n[TimelineEnricher][PROOF] Enriching hotspot row:`, {
          hotspot_ID: row.hotspot_ID,
          hotspot_name: hotspotName,
          hotspot_order: row.hotspot_order,
          hotspot_plan_own_way: row.hotspot_plan_own_way,
          isManual: isManual,
          masterPriority: Number(hotspotData?.priority || 0),
          displayPriority: displayPriority,
          raw_start_time: row.hotspot_start_time,
          raw_end_time: row.hotspot_end_time,
          converted_start_time: startTime,
          converted_end_time: endTime,
          formatted_timeRange: timeRange,
          note: startTime === endTime ? 'WARNING: START === END (NO DURATION)' : 'OK: Start != End',
        });
      }
      
      let text = "";
      let type = "";
      let isZeroDurationHotel = false;

      switch (row.item_type) {
        case 1:
          text = "Refreshment / Buffer";
          type = "refreshment";
          break;
        case 2:
        case 3:
          if (Number((row as any).allow_break_hours ?? 0) === 1) {
            text = "Waiting / Buffer";
            type = "break";
            break;
          }
          const route = routeMap.get(Number(row.itinerary_route_ID)) as any || {};
          const hotspotDataTravel = row.hotspot_ID ? hotspotMap.get(Number(row.hotspot_ID)) : null;
          const toName = hotspotDataTravel
            ? hotspotDataTravel.name
            : (row.via_location_name || (route as any)?.next_visiting_location || "next destination");
          text = `Travel to ${toName}`;
          type = "travel";
          break;
        case 4:
          const hotspotDataAttr = hotspotMap.get(Number(row.hotspot_ID));
          text = (hotspotDataAttr?.name || "Hotspot Visit") as string;
          type = "attraction";
          break;
        case 5:
          text = "Travel to Hotel";
          type = "travel";
          break;
        case 6:
          // âœ… FIX: Check if hotel segment is zero-duration (check-in)
          if (startTime === endTime) {
            text = "Check-in at Hotel";
            isZeroDurationHotel = true;
          } else {
            text = "Hotel Stay";
          }
          type = "hotel";
          break;
        case 7:
          text = "Return Journey";
          type = "return";
          break;
        default:
          text = "Unknown Segment";
          type = "unknown";
      }

      // âœ… FIX: Add priority information for manual hotspots
      let priority: number | null = null;
      let isManual = false;
      let priorityLabel: string | null = null;
      
      if (row.item_type === 4) {
        isManual = Number(row.hotspot_plan_own_way || 0) === 1;
        const hotspotData = hotspotMap.get(Number(row.hotspot_ID));
        const masterPriority = Number(hotspotData?.priority || 0);
        
        // Manual hotspots always display and schedule as P4, never master priority
        if (isManual) {
          priority = 4;
          priorityLabel = "Manual / P4";
        } else {
          priority = masterPriority || null;
          if (masterPriority > 0) priorityLabel = `P${masterPriority}`;
        }
      }

      return {
        ...row,
        text,
        timeRange,
        type,
        priority,
        isManual,
        priorityLabel,
        isZeroDurationHotel,
        locationId: row.hotspot_ID, // Add locationId field for frontend compatibility
        isConflict: (row as any).isConflict || false,
        conflictReason: (row as any).conflictReason || null,
      };
    });

    // === Step 4: Sort enriched rows chronologically, then inject non-overlapping
    //             waiting segments only where a real gap > 60 min exists.

    // 4a. Sort by hotspot_start_time ascending
    const sorted = [...enrichedRows].sort((a, b) => {
      const at = a.hotspot_start_time ? new Date(a.hotspot_start_time).getTime() : 0;
      const bt = b.hotspot_start_time ? new Date(b.hotspot_start_time).getTime() : 0;
      return at - bt;
    });

    // 4b. Fetch timing data for attraction hotspots (for reason text)
    const attrIds = sorted
      .filter((r) => Number(r.item_type) === 4 && r.hotspot_ID)
      .map((r) => Number(r.hotspot_ID));

    const timingRows = attrIds.length > 0
      ? await tx.dvi_hotspot_timing.findMany({
          where: { hotspot_ID: { in: attrIds }, deleted: 0 },
          select: {
            hotspot_ID: true,
            hotspot_open_all_time: true,
            hotspot_start_time: true,
            hotspot_closed: true,
          },
          orderBy: { hotspot_timing_ID: 'asc' },
        })
      : [];

    // 4c. Build timing map: first non-closed row per hotspot wins
    const timingMap = new Map<number, { isOpenAllTime: boolean; openTimeStr: string | null }>();
    for (const t of timingRows) {
      const id = Number(t.hotspot_ID);
      if (timingMap.has(id)) continue;
      if (Number(t.hotspot_closed) === 1) continue;
      const isOpenAllTime = Number(t.hotspot_open_all_time) === 1;
      const openTimeStr = !isOpenAllTime && t.hotspot_start_time
        ? this.formatTime(TimeConverter.toTimeString(t.hotspot_start_time))
        : null;
      timingMap.set(id, { isOpenAllTime, openTimeStr });
    }

    // 4d. Scan consecutive sorted pairs; insert waiting only where gap > 60 min with no overlap
    const GAP_THRESHOLD_MINUTES = 60;
    const enrichedWithGaps: any[] = [];

    for (let i = 0; i < sorted.length; i++) {
      enrichedWithGaps.push(sorted[i]);

      if (i >= sorted.length - 1) continue;

      const prev = sorted[i];
      const next = sorted[i + 1];

      // Skip synthetic/waiting segments on either side
      if (Number(prev.item_type) === -1 || prev.type === 'waiting') continue;
      if (Number(next.item_type) === -1 || next.type === 'waiting') continue;

      // Next segment must be an attraction (not travel, hotel, etc.)
      if (Number(next.item_type) !== 4) continue;

      // Must be same route
      if (Number(prev.itinerary_route_ID) !== Number(next.itinerary_route_ID)) continue;

      // Both endpoints must be valid
      if (!prev.hotspot_end_time || !next.hotspot_start_time) continue;
      const prevEndMs = new Date(prev.hotspot_end_time).getTime();
      const nextStartMs = new Date(next.hotspot_start_time).getTime();
      if (isNaN(prevEndMs) || isNaN(nextStartMs)) continue;

      // Prev must end strictly before next starts (no overlap)
      if (prevEndMs >= nextStartMs) continue;

      const gapMinutes = Math.round((nextStartMs - prevEndMs) / 60000);
      if (gapMinutes <= GAP_THRESHOLD_MINUTES) continue;

      // Build reason text using DB timing data
      const prevEndStr   = this.formatTime(TimeConverter.toTimeString(prev.hotspot_end_time));
      const nextStartStr = this.formatTime(TimeConverter.toTimeString(next.hotspot_start_time));
      const nextName     = hotspotMap.get(Number(next.hotspot_ID))?.name || 'next hotspot';
      const timing       = timingMap.get(Number(next.hotspot_ID));

      let reason: string;
      if (!timing || timing.isOpenAllTime) {
        reason = 'Idle time before next scheduled visit';
      } else if (timing.openTimeStr) {
        reason = `${nextName} opens at ${timing.openTimeStr}`;
      } else {
        reason = 'Idle time before next scheduled visit';
      }

      enrichedWithGaps.push({
        item_type: -1,
        type: 'waiting',
        text: 'Waiting for opening time',
        timeRange: `${prevEndStr} - ${nextStartStr}`,
        reason,
        gapMinutes,
        itinerary_route_ID: prev.itinerary_route_ID,
        hotspot_start_time: prev.hotspot_end_time,
        hotspot_end_time:   next.hotspot_start_time,
        isConflict: false,
        conflictReason: null,
        isSyntheticWaiting: true,
      });
    }

    return enrichedWithGaps;
  }

  private static formatTime(timeStr: string): string {
    if (!timeStr) return "";
    const [h, m] = timeStr.split(":");
    let hour = parseInt(h, 10);
    const ampm = hour >= 12 ? "PM" : "AM";
    hour = hour % 12;
    hour = hour ? hour : 12;
    const minutes = m.padStart(2, "0");
    return `${hour}:${minutes} ${ampm}`;
  }
}