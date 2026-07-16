import { Injectable } from '@nestjs/common';

export interface TimelineRouteCoordinateResolution {
  currentLocationName: string;
  currentCoords: { lat: number; lon: number } | undefined;
  destCityCoords: { lat: number; lon: number } | undefined;
  sourceCity: string;
  destinationCity: string;
}

@Injectable()
export class TimelineRouteCoordinateResolutionService {
  async resolve(context: {
    tx: any;
    route: any;
    plan: any;
    hasUsableCoords: (value: { lat: number; lon: number } | undefined) => boolean;
    resolvePlaceCoords: (tx: any, place: string, side: 'source' | 'destination') => Promise<{ lat: number; lon: number } | undefined>;
  }): Promise<TimelineRouteCoordinateResolution> {
    const { tx, route, plan, hasUsableCoords, resolvePlaceCoords } = context;
    const rawStartLocation =
      (route.location_name as string) ||
      (route.next_visiting_location as string) ||
      (plan.departure_location as string) ||
      '';
    const currentLocationName = rawStartLocation.split('|')[0].trim();
    const routeSourceCity = String((route as any).location_name || '').split('|')[0].trim();
    const routeDestinationCity = String((route as any).next_visiting_location || '').split('|')[0].trim();
    let sourceCity = routeSourceCity;
    let destinationCity = routeDestinationCity;
    let currentCoords: { lat: number; lon: number } | undefined;
    let destCityCoords: { lat: number; lon: number } | undefined;

    if (route.location_id) {
      const storedLoc = await tx.dvi_stored_locations?.findFirst({
        where: { location_ID: Number(route.location_id), deleted: 0, status: 1 },
      });
      if (storedLoc) {
        currentCoords = {
          lat: Number(storedLoc.source_location_lattitude ?? 0),
          lon: Number(storedLoc.source_location_longitude ?? 0),
        };
        destCityCoords = {
          lat: Number(storedLoc.destination_location_lattitude ?? 0),
          lon: Number(storedLoc.destination_location_longitude ?? 0),
        };
        if (!sourceCity) sourceCity = String(storedLoc.source_location || '').split('|')[0].trim();
        if (!destinationCity) destinationCity = String(storedLoc.destination_location || '').split('|')[0].trim();
      }
    }

    if (!hasUsableCoords(currentCoords)) {
      currentCoords =
        (await resolvePlaceCoords(tx, sourceCity, 'source')) ||
        (await resolvePlaceCoords(tx, routeSourceCity, 'source')) ||
        undefined;
    }
    if (!hasUsableCoords(destCityCoords)) {
      destCityCoords =
        (await resolvePlaceCoords(tx, destinationCity, 'destination')) ||
        (await resolvePlaceCoords(tx, routeDestinationCity, 'destination')) ||
        undefined;
    }

    if (!sourceCity) sourceCity = String((route as any).location_name || '').split('|')[0].trim();
    if (!destinationCity) destinationCity = String((route as any).next_visiting_location || '').split('|')[0].trim();

    return { currentLocationName, currentCoords, destCityCoords, sourceCity, destinationCity };
  }
}
