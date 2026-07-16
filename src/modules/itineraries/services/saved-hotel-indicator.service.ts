import { Injectable } from '@nestjs/common';

export interface SavedHotelIndicatorCallbacks {
  loadRows: () => Promise<Array<{ itinerary_route_id?: number | null }>>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/** Loads route IDs that already have saved hotel rows for provider filtering decisions. */
@Injectable()
export class SavedHotelIndicatorService {
  async load(planId: number, callbacks: SavedHotelIndicatorCallbacks): Promise<Map<number, string>> {
    const indicators = new Map<number, string>();
    try {
      for (const row of await callbacks.loadRows()) {
        const routeId = Number(row.itinerary_route_id || 0);
        if (routeId > 0) indicators.set(routeId, 'SAVED');
      }
      if (indicators.size > 0) callbacks.log?.(`Found ${indicators.size} routes with saved hotels`);
    } catch (error) {
      callbacks.warn?.(`Failed to load saved hotel indicators: ${error instanceof Error ? error.message : String(error)}`);
    }
    return indicators;
  }
}
