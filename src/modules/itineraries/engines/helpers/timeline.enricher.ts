import { HotspotDetailRow } from "./types";
import { TimeConverter } from "./time-converter";

export class TimelineEnricher {
  static async enrich(tx: any, planId: number, rows: HotspotDetailRow[]): Promise<any[]> {
    // 1. Fetch hotspot names
    const hotspotIds = rows
      .filter((r) => r.item_type === 4 && r.hotspot_ID)
      .map((r) => r.hotspot_ID as number);

    const hotspotMasters = await tx.dvi_hotspot_place.findMany({
      where: { hotspot_ID: { in: hotspotIds } },
      select: { hotspot_ID: true, hotspot_name: true },
    });
    const hotspotMap = new Map(
      hotspotMasters.map((h: any) => [Number(h.hotspot_ID), h.hotspot_name])
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
    return rows.map((row) => {
      const startTime = TimeConverter.toTimeString(row.hotspot_start_time);
      const endTime = TimeConverter.toTimeString(row.hotspot_end_time);
      const timeRange = `${this.formatTime(startTime)} - ${this.formatTime(endTime)}`;
      
      // ════════════════════════════════════════════════════════════════
      // PROOF LOGGING: For hotspot type items
      // ════════════════════════════════════════════════════════════════
      if (row.item_type === 4) {
        const hotspotName = hotspotMap.get(Number(row.hotspot_ID)) || `Hotspot#${row.hotspot_ID}`;
        console.log(`\n[TimelineEnricher][PROOF] Enriching hotspot row:`, {
          hotspot_ID: row.hotspot_ID,
          hotspot_name: hotspotName,
          hotspot_order: row.hotspot_order,
          hotspot_plan_own_way: row.hotspot_plan_own_way,
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

      switch (row.item_type) {
        case 1:
          text = "Refreshment / Buffer";
          type = "refreshment";
          break;
        case 2:
        case 3:
          const route = routeMap.get(Number(row.itinerary_route_ID)) as any || {};
          const toName = row.hotspot_ID 
            ? hotspotMap.get(Number(row.hotspot_ID)) 
            : (row.via_location_name || (route as any)?.next_visiting_location || "next destination");
          text = `Travel to ${toName}`;
          type = "travel";
          break;
        case 4:
          text = (hotspotMap.get(Number(row.hotspot_ID)) || "Hotspot Visit") as string;
          type = "attraction";
          break;
        case 5:
          text = "Travel to Hotel";
          type = "travel";
          break;
        case 6:
          text = "Hotel Stay";
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

      return {
        ...row,
        text,
        timeRange,
        type,
        locationId: row.hotspot_ID, // Add locationId field for frontend compatibility
        isConflict: (row as any).isConflict || false,
        conflictReason: (row as any).conflictReason || null,
      };
    });
  }

  private static formatTime(timeStr: string): string {
    if (!timeStr) return "";
    const [h, m] = timeStr.split(":");
    let hour = parseInt(h, 10);
    const ampm = hour >= 12 ? "PM" : "AM";
    hour = hour % 12;
    hour = hour ? hour : 12; // the hour '0' should be '12'
    const minutes = m.padStart(2, "0");
    return `${hour}:${minutes} ${ampm}`;
  }
}
