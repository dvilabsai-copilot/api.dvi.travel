import { Injectable } from '@nestjs/common';
import { HotelSearchResult } from '../../hotels/interfaces/hotel-provider.interface';

export type HotelPricePackage = {
  groupType: number;
  label: string;
  hotels: Array<HotelSearchResult & { routeId: number }>;
};

export interface HotelPricePackageCallbacks {
  log?: (message: string) => void;
  warn?: (message: string) => void;
  debug?: (message: string) => void;
  money?: (value: number) => number;
  applyInvisibleHotelMargin?: (amount: number, hotel: any) => number;
}

/** Builds the four customer-facing hotel price tiers for each itinerary route. */
@Injectable()
export class ItineraryHotelPricePackageService {
  generate(
    hotelsByRoute: Map<number, HotelSearchResult[] | null>,
    routes: any[],
    callbacks: HotelPricePackageCallbacks = {},
  ): HotelPricePackage[] {
    const log = callbacks.log || (() => undefined);
    const warn = callbacks.warn || (() => undefined);
    const debug = callbacks.debug || (() => undefined);
    const money = callbacks.money || ((value: number) => Number(Number(value || 0).toFixed(2)));
    const applyInvisibleHotelMargin =
      callbacks.applyInvisibleHotelMargin || ((amount: number) => money(amount));
    const packages: HotelPricePackage[] = [];

    const labels = [
      'Budget Hotels',
      'Mid-Range Hotels',
      'Premium Hotels',
      'Luxury Hotels',
    ];

    log(`\n   PRICE TIER GENERATION DEBUG (PER-DESTINATION):`);
    log(`   Total routes: ${routes.length}`);
    hotelsByRoute.forEach((hotels, routeId) => {
      const prices = (hotels || []).map((h) => h.price).join(', ');
      log(`   Route ${routeId}: ${(hotels || []).length} hotels (Prices: ${prices})`);
    });

    const hotelGroupAssignments = new Map<string, number>();

    for (const route of routes) {
      const routeId = (route as any).itinerary_route_ID;
      const availableHotels = hotelsByRoute.get(routeId);

      if (availableHotels === null) {
        warn(`      Provider/system failure for route ${routeId} — skipping placeholder row. See previous logs for error.`);
        continue;
      }
      if (!Array.isArray(availableHotels) || availableHotels.length === 0) {
        warn(`      No hotels available for route ${routeId}`);
        continue;
      }

      const sortedHotels = [...availableHotels].sort((a, b) => a.price - b.price);

      if (sortedHotels.length === 1) {
        const hotel = sortedHotels[0];
        for (let groupType = 1; groupType <= 4; groupType++) {
          const key = `${routeId}-${hotel.hotelCode || hotel.hotelName}`;
          hotelGroupAssignments.set(`${key}:${groupType}`, groupType);
        }
        debug(`   Route ${routeId}: 1 hotel - "${hotel.hotelName}" (${hotel.price}) assigned to ALL groups`);
      } else {
        const numHotels = sortedHotels.length;

        sortedHotels.forEach((hotel, index) => {
          let groupType = 1;
          if (numHotels <= 4) {
            groupType = Math.min(index + 1, 4);
          } else {
            groupType = Math.floor((index / numHotels) * 4) + 1;
            groupType = Math.min(groupType, 4);
          }

          const key = `${routeId}-${hotel.hotelCode || hotel.hotelName}`;
          hotelGroupAssignments.set(`${key}:${groupType}`, groupType);
        });

        debug(`   Route ${routeId}: ${numHotels} hotels - Distributed across groups by price order`);
      }
    }

    for (let tier = 0; tier < 4; tier++) {
      const groupType = tier + 1;
      const tieredHotels: Array<HotelSearchResult & { routeId: number }> = [];

      for (const route of routes) {
        const routeId = (route as any).itinerary_route_ID;
        const availableHotels = hotelsByRoute.get(routeId);

        if (availableHotels === null) {
          warn(`   Provider/system failure for route ${routeId} — not inserting placeholder row. See previous logs for error.`);
          continue;
        }
        if (!Array.isArray(availableHotels) || availableHotels.length === 0) {
          debug(`   Tier ${groupType}, Route ${routeId}: No hotels available`);
          tieredHotels.push({
            hotelCode: '0',
            hotelName: 'No Hotels Available',
            roomType: '-',
            mealPlan: '-',
            price: 0,
            rating: 0,
            routeId,
            provider: 'external',
            isBookable: false,
            externalStay: true,
            availabilityStatus: 'NO_SUPPLIER_AVAILABILITY',
            availabilityMessage:
              'No supplier hotel rooms are available for this city/date. Customer must arrange stay manually.',
          } as HotelSearchResult & { routeId: number });
          continue;
        }

        let foundForGroup = false;
        for (const hotel of availableHotels) {
          const key = `${routeId}-${hotel.hotelCode || hotel.hotelName}`;
          const assignedGroupType = hotelGroupAssignments.get(`${key}:${groupType}`);

          if (assignedGroupType === groupType) {
            tieredHotels.push({ ...hotel, routeId } as HotelSearchResult & { routeId: number });
            foundForGroup = true;
          }
        }

        if (!foundForGroup && availableHotels.length > 0) {
          const sortedHotels = [...availableHotels].sort((a, b) => (a.price || 0) - (b.price || 0));
          const fallbackHotel = sortedHotels[Math.min(groupType - 1, sortedHotels.length - 1)];
          if (fallbackHotel) {
            tieredHotels.push({
              ...fallbackHotel,
              routeId,
              __fallbackAssigned: true,
            } as HotelSearchResult & { routeId: number });
            debug(`   Tier ${groupType}, Route ${routeId}: overlap fallback -> ${fallbackHotel.hotelName}`);
          }
        }
      }

      if (tieredHotels.length > 0) {
        const totalPrice = money(
          tieredHotels.reduce(
            (sum, hotel) => sum + applyInvisibleHotelMargin(Number(hotel.price || 0), hotel),
            0,
          ),
        );
        packages.push({ groupType, label: labels[tier], hotels: tieredHotels });
        log(`   Group ${groupType} (${labels[tier]}): ${tieredHotels.length} hotels total, ${totalPrice} combined`);
      } else {
        log(`   Group ${groupType} (${labels[tier]}): No hotels found for any route`);
      }
    }

    log(`Generated ${packages.length} price tier packages\n`);
    return packages;
  }
}
