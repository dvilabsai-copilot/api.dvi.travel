import type { PrismaService } from '../../../prisma.service';

type BookedHotelRoute = {
  itinerary_route_id?: number | null;
  itinerary_route_location?: string | null;
};

export function getHotelLocationLabel(value: string | null | undefined): string {
  const label = String(value || '').trim();
  return /^[\d,\s]+$/.test(label) ? '' : label;
}

export async function loadConfirmedHotelRouteDestinations(
  prisma: Pick<PrismaService, 'dvi_itinerary_route_details'>,
  planId: number,
  hotels: readonly BookedHotelRoute[],
): Promise<Map<number, string>> {
  const routeIds = [...new Set(hotels
    .filter(hotel => !getHotelLocationLabel(hotel.itinerary_route_location))
    .map(hotel => Number(hotel.itinerary_route_id || 0))
    .filter(id => Number.isInteger(id) && id > 0))];
  if (!routeIds.length) return new Map();

  const routes = await prisma.dvi_itinerary_route_details.findMany({
    where: { itinerary_plan_ID: planId, itinerary_route_ID: { in: routeIds }, deleted: 0 },
    select: { itinerary_route_ID: true, next_visiting_location: true, location_name: true },
  });
  return new Map(routes.map(route => [
    route.itinerary_route_ID,
    getHotelLocationLabel(route.next_visiting_location) || getHotelLocationLabel(route.location_name),
  ]));
}

export function getConfirmedHotelDestination(hotel: BookedHotelRoute, routeDestinations: ReadonlyMap<number, string>): string {
  return getHotelLocationLabel(hotel.itinerary_route_location) ||
    routeDestinations.get(Number(hotel.itinerary_route_id || 0)) || '';
}
