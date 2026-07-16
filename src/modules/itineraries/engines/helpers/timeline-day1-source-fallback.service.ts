import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export interface TimelineDay1SourceFallbackCallbacks {
  normalizeCityName: (value: string) => string;
  hotspotLocationMatchesCity: (hotspotLocation: string | null, targetLocation: string | null) => boolean;
}

/**
 * Selects the small source-city fallback pool used when the first route needs
 * priority hotspots before the normal route scheduler has a complete pool.
 *
 * The query and ordering intentionally stay equivalent to the legacy builder
 * path. The builder supplies the city-matching policy so this helper does not
 * create a second normalization dialect.
 */
export class TimelineDay1SourceFallbackService {
  private callbacks: TimelineDay1SourceFallbackCallbacks = {
    normalizeCityName: (value) => value,
    hotspotLocationMatchesCity: () => false,
  };

  setCallbacks(callbacks: TimelineDay1SourceFallbackCallbacks): void {
    this.callbacks = callbacks;
  }

  async fetch(
    tx: Tx,
    planId: number,
    routeId: number,
    sourceCity: string,
    _destinationCity: string,
    excludedHotspotIds?: Set<number>,
    maxResults: number = 3,
    includeZeroPriority: boolean = false,
  ): Promise<any[]> {
    try {
      const route = (await (tx as any).dvi_itinerary_route_details?.findFirst({
        where: {
          itinerary_plan_ID: planId,
          itinerary_route_ID: routeId,
          deleted: 0,
          status: 1,
        },
      })) as any | null;

      if (!route) return [];

      let startLat = 0;
      let startLon = 0;
      if (route.location_id) {
        const storedLoc = await (tx as any).dvi_stored_locations?.findFirst({
          where: { location_ID: BigInt(route.location_id), deleted: 0, status: 1 },
        });
        if (storedLoc) {
          startLat = Number(storedLoc.source_location_lattitude ?? 0);
          startLon = Number(storedLoc.source_location_longitude ?? 0);
        }
      }

      const allHotspots = (await (tx as any).dvi_hotspot_place?.findMany({
        where: includeZeroPriority
          ? { deleted: 0, status: 1 }
          : { deleted: 0, status: 1, hotspot_priority: { gt: 0 } },
      })) || [];

      const normalizedSourceCity = this.callbacks.normalizeCityName(sourceCity);
      const sourceHotspots: any[] = [];
      for (const hotspot of allHotspots) {
        const hotspotId = Number(hotspot.hotspot_ID ?? 0);
        if (hotspotId <= 0 || excludedHotspotIds?.has(hotspotId)) continue;

        const hotspotLocation = String(hotspot.hotspot_location || '');
        const hotspotToLocation = String(hotspot.hotspot_to_location || hotspotLocation || '');
        const sourceMatch =
          this.callbacks.hotspotLocationMatchesCity(hotspotLocation, sourceCity) ||
          this.callbacks.hotspotLocationMatchesCity(hotspotToLocation, sourceCity) ||
          this.callbacks.hotspotLocationMatchesCity(hotspotLocation, normalizedSourceCity) ||
          this.callbacks.hotspotLocationMatchesCity(hotspotToLocation, normalizedSourceCity);
        if (!sourceMatch) continue;

        const hsLat = Number(hotspot.hotspot_latitude ?? 0);
        const hsLon = Number(hotspot.hotspot_longitude ?? 0);
        let distance = 0;
        if (startLat && startLon && hsLat && hsLon) {
          const earthRadius = 6371;
          const dLat = ((hsLat - startLat) * Math.PI) / 180;
          const dLon = ((hsLon - startLon) * Math.PI) / 180;
          const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos((startLat * Math.PI) / 180) *
              Math.cos((hsLat * Math.PI) / 180) *
              Math.sin(dLon / 2) *
              Math.sin(dLon / 2);
          distance = earthRadius * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))) * 1.5;
        }
        sourceHotspots.push({ ...hotspot, hotspot_distance: distance });
      }

      sourceHotspots.sort((a: any, b: any) => {
        const aPriority = Number(a.hotspot_priority ?? 0);
        const bPriority = Number(b.hotspot_priority ?? 0);
        if (aPriority !== bPriority) return aPriority - bPriority;
        return a.hotspot_distance - b.hotspot_distance;
      });

      const limit = Number.isFinite(maxResults) && maxResults > 0 ? Math.floor(maxResults) : 3;
      return sourceHotspots.slice(0, limit).map((hotspot: any) => ({
        hotspot_ID: Number(hotspot.hotspot_ID ?? 0),
        display_order: Number(hotspot.hotspot_priority ?? 0),
        hotspot_priority: Number(hotspot.hotspot_priority ?? 0),
        hotspot_distance: Number(hotspot.hotspot_distance ?? 0) || 0,
        hotspot_name: String(hotspot.hotspot_name || ''),
        hotspot_location: String(hotspot.hotspot_location || ''),
        hotspot_to_location: String(hotspot.hotspot_to_location || hotspot.hotspot_location || ''),
        matched_bucket: 'source_fallback',
      }));
    } catch (err) {
      console.error('[fetchDay1TopPrioritySourceHotspots] Error:', err);
      return [];
    }
  }
}
