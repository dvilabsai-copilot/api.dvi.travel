import type { PrismaService } from '../../../prisma.service';
import { normalizeCityName } from './city-normalization.util';
import { isHouseboatHotel } from './hotel-category.util';

export type HouseboatCity = { id: number; name: string; stateName: string | null };

export function getHouseboatCityIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is number => Number.isSafeInteger(id) && id > 0))];
}

export async function readHouseboatCities(
  prisma: PrismaService,
  ids: number[],
): Promise<HouseboatCity[]> {
  if (ids.length === 0) return [];
  const cities = await prisma.dvi_cities.findMany({
    where: { id: { in: ids }, deleted: 0 },
    select: { id: true, name: true, state_id: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  const states = await prisma.dvi_states.findMany({
    where: { id: { in: [...new Set(cities.map(city => city.state_id))] } },
    select: { id: true, name: true },
  });
  const stateNames = new Map(states.map(state => [state.id, state.name]));
  return cities.map(city => ({
    id: city.id, name: city.name, stateName: stateNames.get(city.state_id) ?? null,
  }));
}

export async function loadHouseboatCities(prisma: PrismaService): Promise<HouseboatCity[]> {
  const settings = await prisma.dvi_global_settings?.findFirst?.({
    where: { deleted: 0 },
    orderBy: { global_settings_ID: 'asc' },
    select: { houseboat_only_city_ids: true },
  });
  return readHouseboatCities(prisma, getHouseboatCityIds(settings?.houseboat_only_city_ids));
}

export function isHouseboatOnlyCity(destination: string, cities: readonly HouseboatCity[]): boolean {
  const [name, region] = destination.trim().split(',').map(part => part.trim());
  if (!name) return false;
  if (/^\d+$/.test(name)) return cities.some(city => city.id === Number(name));
  const key = normalizeCityName(name);
  return cities.some(city => normalizeCityName(city.name) === key &&
    (!region || /^india$/i.test(region) || !city.stateName ||
      normalizeCityName(region) === normalizeCityName(city.stateName)));
}

export async function getHouseboatCityRouteIds(prisma: PrismaService, routes: Array<{
  itinerary_route_ID: number;
  next_visiting_location?: string | null;
  location_name?: string | null;
}>, configuredCities?: readonly HouseboatCity[]): Promise<Set<number>> {
  const cities = configuredCities ?? await loadHouseboatCities(prisma);
  return new Set(routes
    .filter(route => isHouseboatOnlyCity(route.next_visiting_location || route.location_name || '', cities))
    .map(route => Number(route.itinerary_route_ID)));
}

export function matchesHouseboatPreference(hotel: unknown, preferHouseboats: boolean | undefined): boolean {
  const classified = (hotel as { isHouseboat?: boolean } | null)?.isHouseboat;
  return preferHouseboats === undefined || (classified ?? isHouseboatHotel(hotel)) === preferHouseboats;
}

export function sameHouseboatPreference(
  first?: { prefer_houseboats?: boolean } | null,
  second?: { prefer_houseboats?: boolean } | null,
): boolean {
  return (first?.prefer_houseboats === true) === (second?.prefer_houseboats === true);
}
