import { Injectable } from '@nestjs/common';
import { HotelSearchResult } from '../../hotels/interfaces/hotel-provider.interface';

export interface SecondaryProviderFetchCallbacks {
  searchHobse?: (input: any) => Promise<HotelSearchResult[]>;
  searchResavenue?: (input: any) => Promise<HotelSearchResult[]>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

/** Fetches HOBSE and ResAvenue route hotels while preserving their provider-specific request contracts. */
@Injectable()
export class ItineraryHotelSecondaryProviderFetchService {
  async fetchHobse(
    routes: any[],
    noOfNights: number,
    cityCodeMap: Record<string, string>,
    callbacks: SecondaryProviderFetchCallbacks,
  ): Promise<Map<number, HotelSearchResult[]>> {
    const hotelsByRoute = new Map<number, HotelSearchResult[]>();
    const log = callbacks.log || (() => undefined);
    const warn = callbacks.warn || (() => undefined);
    log(`HOBSE HOTEL FETCH: Attempting to fetch HOBSE hotels for ${routes.length} routes`);

    try {
      for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
        const route = routes[routeIndex];
        const routeId = route.itinerary_route_ID;
        if (routeIndex === routes.length - 1 && routeIndex >= noOfNights) {
          log(`Skipping HOBSE route ${routeIndex + 1} (last route - departure day)`);
          continue;
        }

        const destination = route.next_visiting_location;
        const cityCode = cityCodeMap[destination];
        if (!cityCode) {
          warn(`No HOBSE city code for destination "${destination}" - skipping HOBSE search`);
          hotelsByRoute.set(routeId, []);
          continue;
        }

        const routeDate = new Date(route.itinerary_route_date);
        const checkOutDate = new Date(routeDate);
        checkOutDate.setDate(checkOutDate.getDate() + 1);
        try {
          const hotels = await callbacks.searchHobse!({
            cityCode,
            checkInDate: routeDate.toISOString().split('T')[0],
            checkOutDate: checkOutDate.toISOString().split('T')[0],
            roomCount: 1,
            guestCount: 2,
          });
          hotelsByRoute.set(routeId, hotels?.length ? hotels : []);
          log(`${hotels?.length ? 'Found ' + hotels.length : 'No hotels found'} in HOBSE route ${routeId}`);
        } catch (error) {
          warn(`HOBSE Route ${routeId} search failed: ${this.errorMessage(error)}`);
          hotelsByRoute.set(routeId, []);
        }
      }
    } catch (error) {
      callbacks.error?.(`HOBSE HOTEL FETCH FAILED: ${this.errorMessage(error)}`);
    }
    return hotelsByRoute;
  }

  async fetchResavenue(
    routes: any[],
    noOfNights: number,
    guestNationality: string,
    roomCount: number,
    adultCount: number,
    childCount: number,
    callbacks: SecondaryProviderFetchCallbacks,
  ): Promise<Map<number, HotelSearchResult[]>> {
    const hotelsByRoute = new Map<number, HotelSearchResult[]>();
    const log = callbacks.log || (() => undefined);
    const warn = callbacks.warn || (() => undefined);
    const safeAdultCount = adultCount > 0 ? adultCount : 1;
    const safeChildCount = childCount >= 0 ? childCount : 0;
    const safeRoomCount = Math.max(Number(roomCount || 1), 1);
    const guestCount = safeAdultCount + safeChildCount;
    log(`RESAVENUE HOTEL FETCH: Attempting to fetch ResAvenue hotels for ${routes.length} routes`);

    try {
      for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
        const route = routes[routeIndex];
        const routeId = route.itinerary_route_ID;
        if (routeIndex === routes.length - 1 && routeIndex >= noOfNights) {
          log(`Skipping ResAvenue route ${routeIndex + 1} (last route - departure day)`);
          continue;
        }

        const destination = route.next_visiting_location;
        const routeDate = new Date(route.itinerary_route_date);
        const checkOutDate = new Date(routeDate);
        checkOutDate.setDate(checkOutDate.getDate() + 1);
        try {
          const hotels = await callbacks.searchResavenue!({
            cityCode: destination,
            checkInDate: routeDate.toISOString().split('T')[0],
            checkOutDate: checkOutDate.toISOString().split('T')[0],
            roomCount: safeRoomCount,
            guestCount,
            adultCount: safeAdultCount,
            childCount: safeChildCount,
            guestNationality,
            providers: ['resavenue'],
          });
          hotelsByRoute.set(routeId, hotels?.length ? hotels : []);
          log(`${hotels?.length ? 'Found ' + hotels.length : 'No hotels found'} in ResAvenue route ${routeId}`);
        } catch (error) {
          warn(`ResAvenue Route ${routeId} search failed: ${this.errorMessage(error)}`);
          hotelsByRoute.set(routeId, []);
        }
      }
    } catch (error) {
      callbacks.error?.(`RESAVENUE HOTEL FETCH FAILED: ${this.errorMessage(error)}`);
    }
    return hotelsByRoute;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
