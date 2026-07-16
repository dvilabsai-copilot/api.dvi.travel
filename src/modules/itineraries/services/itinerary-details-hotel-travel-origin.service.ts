import { Injectable } from '@nestjs/common';

export interface HotelTravelOriginProjection {
  fromName: string;
  toName: string;
  shouldSuppress: boolean;
}

@Injectable()
export class ItineraryDetailsHotelTravelOriginService {
  resolve(context: {
    hotelInfo: any;
    isVehicleOnly: boolean;
    location: any;
    route: any;
    plan: any;
    previousDayHotelName: string | null;
    routeHotspots: any[];
    hotspotMap: Map<number, any>;
    startTimeText: string | null;
    formatTime: (value: any) => string;
    timeToMinutes: (value: string | null | undefined) => number;
  }): HotelTravelOriginProjection {
    const {
      hotelInfo,
      isVehicleOnly,
      location,
      route,
      plan,
      previousDayHotelName,
      routeHotspots,
      hotspotMap,
      startTimeText,
      formatTime,
      timeToMinutes,
    } = context;
    const toName = isVehicleOnly
      ? 'Hotel'
      : (
        hotelInfo?.hotel_name ??
        hotelInfo?.hotel_city ??
        location?.destination_location ??
        route.next_visiting_location ??
        'Hotel'
      );
    const normalizeLabel = (value?: string | null) => String(value ?? '').trim().toLowerCase();
    const sourceCityName = location?.source_location ?? route.location_name ?? '';
    const destinationCityName = location?.destination_location ?? route.next_visiting_location ?? '';
    const isSameCityRoute =
      normalizeLabel(sourceCityName) !== '' &&
      normalizeLabel(sourceCityName) === normalizeLabel(destinationCityName);
    const isCityFallbackDestination =
      !hotelInfo?.hotel_name &&
      normalizeLabel(toName) !== '' &&
      normalizeLabel(toName) === normalizeLabel(destinationCityName);
    const travelStartMins = startTimeText ? timeToMinutes(startTimeText) : null;
    let fromName =
      previousDayHotelName ??
      location?.source_location ??
      route.location_name ??
      plan.arrival_location ??
      '';

    if (travelStartMins !== null) {
      let bestAttractionName: string | null = null;
      let bestAttractionEnd = -1;
      for (const candidate of routeHotspots) {
        const candidateType = Number((candidate as any).item_type ?? 0);
        if (candidateType !== 4 || Number(candidate.hotspot_ID ?? 0) <= 0) continue;
        const candidateEndText = formatTime((candidate as any).hotspot_end_time ?? null);
        if (!candidateEndText) continue;
        const candidateEndMins = timeToMinutes(candidateEndText);
        if (candidateEndMins <= travelStartMins && candidateEndMins >= bestAttractionEnd) {
          const candidateMaster = hotspotMap.get(candidate.hotspot_ID as number);
          if (candidateMaster?.hotspot_name?.trim()) {
            bestAttractionName = candidateMaster.hotspot_name;
            bestAttractionEnd = candidateEndMins;
          }
        }
      }
      if (bestAttractionName) fromName = bestAttractionName;
    }

    return {
      fromName,
      toName,
      shouldSuppress:
        isSameCityRoute &&
        isCityFallbackDestination &&
        normalizeLabel(fromName) !== '' &&
        normalizeLabel(fromName) === normalizeLabel(toName),
    };
  }
}
