import { Injectable } from '@nestjs/common';

export interface HotelStayBlock {
  destination: string;
  checkInDate: string;
  checkOutDate: string;
  routeIds: number[];
}

@Injectable()
export class ItineraryHotelStayBlockService {
  private static readonly ONE_DAY_MS = 24 * 60 * 60 * 1000;

  build(
    routes: any[],
    noOfNights: number,
    log: (message: string) => void = () => undefined,
  ): HotelStayBlock[] {
    const blocks: HotelStayBlock[] = [];
    const totalRoutes = routes.length;
    let currentBlock: (HotelStayBlock & { lastDate: Date }) | null = null;

    for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
      const route = routes[routeIndex];
      const isLastRoute = routeIndex === totalRoutes - 1;
      if (isLastRoute && routeIndex >= noOfNights) {
        log(`   ⏭️  Skipping route ${routeIndex + 1} (last route - departure day, no hotel needed)`);
        continue;
      }

      const routeId = Number(route.itinerary_route_ID);
      const destination = String(route.next_visiting_location || '').trim();
      const routeDate = new Date(route.itinerary_route_date);
      const checkInDate = routeDate.toISOString().split('T')[0];
      const nextDay = new Date(routeDate.getTime() + ItineraryHotelStayBlockService.ONE_DAY_MS);
      const checkOutDate = nextDay.toISOString().split('T')[0];

      if (!currentBlock) {
        currentBlock = { destination, checkInDate, checkOutDate, routeIds: [routeId], lastDate: routeDate };
        continue;
      }

      const isSameDestination = destination === currentBlock.destination;
      const isConsecutiveDay =
        routeDate.getTime() - currentBlock.lastDate.getTime() === ItineraryHotelStayBlockService.ONE_DAY_MS;
      if (isSameDestination && isConsecutiveDay) {
        currentBlock.checkOutDate = checkOutDate;
        currentBlock.routeIds.push(routeId);
        currentBlock.lastDate = routeDate;
      } else {
        blocks.push({
          destination: currentBlock.destination,
          checkInDate: currentBlock.checkInDate,
          checkOutDate: currentBlock.checkOutDate,
          routeIds: currentBlock.routeIds,
        });
        currentBlock = { destination, checkInDate, checkOutDate, routeIds: [routeId], lastDate: routeDate };
      }
    }

    if (currentBlock) {
      blocks.push({
        destination: currentBlock.destination,
        checkInDate: currentBlock.checkInDate,
        checkOutDate: currentBlock.checkOutDate,
        routeIds: currentBlock.routeIds,
      });
    }
    return blocks;
  }
}
