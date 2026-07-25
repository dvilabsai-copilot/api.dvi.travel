import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { resolveCityRecordByName } from '../utils/city-normalization.util';

interface RouteValidation {
  routeIndex: number;
  locationName: string;
  nextVisitingLocation: string;
  hasHotels: boolean;
  hotelCount: number;
}

@Injectable()
export class RouteValidationService {
  constructor(private readonly prisma: PrismaService) {}

 /**
   * Validates that all overnight locations have available hotels
   * Throws BadRequestException with details if validation fails
 */
  async validateHotelAvailability(
    routes: Array<{ location_name: string; next_visiting_location: string }>,
    preferredCategory: number = 2
  ): Promise<RouteValidation[]> {
    const validations: RouteValidation[] = [];
    const totalRoutes = routes.length;

    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      const isLastRoute = (i === totalRoutes - 1);

 // Skip last route - no overnight stay needed on departure day
      if (isLastRoute) {
        validations.push({
          routeIndex: i,
          locationName: route.location_name,
          nextVisitingLocation: route.next_visiting_location,
 hasHotels: true, // Not needed
 hotelCount: -1, // N/A
        });
        continue;
      }

 // Hotel is booked at next_visiting_location (destination city)
      const city = route.next_visiting_location;

 // STRATEGY: Resolve city name to city ID, then match hotels by city ID (as string)
 // Normalize city name: try full, comma split, and first word (legacy PHP logic)
      let citySearchTerms: string[] = [city];
      if (city.includes(',')) {
        const parts = city.split(',').map(p => p.trim());
        citySearchTerms.push(...parts);
        if (parts.length >= 2) {
          citySearchTerms.push(parts[1]);
        }
      }
 // Always try first word (e.g., "Chennai Central" -> "Chennai")
      const firstWord = city.trim().split(' ')[0];
      if (!citySearchTerms.includes(firstWord)) {
        citySearchTerms.push(firstWord);
      }

 // Add common aliases (e.g., "Alleppey" -> "Alappuzha")
      const CITY_ALIASES: Record<string, string[]> = {
        alleppey: ['Alappuzha'],
        alleppe: ['Alappuzha'],
        cochin: ['Kochi'],
        calicut: ['Kozhikode'],
        trivandrum: ['Thiruvananthapuram', 'TRIVANDRUM'],
        pondicherry: ['Puducherry'],
        bangalore: ['Bengaluru'],
      };

      const extraTerms: string[] = [];
      for (const term of citySearchTerms) {
        const lowerTerm = term.toLowerCase();
        if (CITY_ALIASES[lowerTerm]) {
          extraTerms.push(...CITY_ALIASES[lowerTerm]);
        }
      }
      citySearchTerms.push(...extraTerms);

 // Try to find city in dvi_cities
      let cityId: number | null = null;
      for (const searchTerm of citySearchTerms) {
        const foundCity = await resolveCityRecordByName(this.prisma, searchTerm);
        if (foundCity) {
          cityId = foundCity.id;
          break;
        }
      }
      let hotelCount = 0;
      if (cityId !== null) {
 // hotel_city is stored as string, but is actually city ID
        const hotels = await (this.prisma as any).dvi_hotel.findMany({
          where: {
            hotel_category: preferredCategory,
            hotel_city: String(cityId),
            status: 1,
            deleted: { not: true },
          },
          select: { hotel_id: true },
        });
        hotelCount = hotels.length;
      }
 // Fallback: If no cityId or no hotels, try LIKE search on hotel address/name
      if (hotelCount === 0) {
        for (const searchTerm of citySearchTerms) {
          const hotelsLike = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
            SELECT COUNT(*) as count
            FROM dvi_hotel
            WHERE hotel_category = ${preferredCategory}
              AND status = 1
              AND (deleted = 0 OR deleted IS NULL)
              AND (hotel_city LIKE ${`%${searchTerm}%`}
                OR hotel_name LIKE ${`%${searchTerm}%`}
                OR hotel_address LIKE ${`%${searchTerm}%`})
          `;
          hotelCount = Number(hotelsLike[0]?.count || 0);
          if (hotelCount > 0) break;
        }
      }
      validations.push({
        routeIndex: i,
        locationName: route.location_name,
        nextVisitingLocation: route.next_visiting_location,
        hasHotels: hotelCount > 0,
        hotelCount,
      });
    }

 // Check if any overnight location has no hotels
    const missingHotels = validations.filter(v => v.hotelCount === 0);

    if (missingHotels.length > 0) {
      const cities = missingHotels.map(v => v.nextVisitingLocation).join(', ');
      const details = missingHotels.map(v =>
        `Day ${v.routeIndex + 1}: ${v.locationName} → ${v.nextVisitingLocation} (0 hotels found)`
      ).join('\n');

      throw new BadRequestException({
        message: `No hotels available in the following cities: ${cities}`,
        details: details,
        missingHotels: missingHotels.map(v => ({
          day: v.routeIndex + 1,
          city: v.nextVisitingLocation,
        })),
        suggestion: 'Please choose cities with available hotels or adjust your route.',
      });
    }

    return validations;
  }

 /**
   * Checks if hotels exist in a specific city
 */
  async hasHotelsInCity(city: string, preferredCategory: number = 2): Promise<boolean> {
 // STRATEGY: Resolve city name to city ID, then match hotels by city ID (as string)
 // Normalize city name: try full, comma split, and first word (legacy PHP logic)
    let citySearchTerms: string[] = [city];
    if (city.includes(',')) {
      const parts = city.split(',').map(p => p.trim());
      citySearchTerms.push(...parts);
      if (parts.length >= 2) {
        citySearchTerms.push(parts[1]);
      }
    }
 // Always try first word (e.g., "Chennai Central" -> "Chennai")
    const firstWord = city.trim().split(' ')[0];
    if (!citySearchTerms.includes(firstWord)) {
      citySearchTerms.push(firstWord);
    }
    let cityId: number | null = null;
    for (const searchTerm of citySearchTerms) {
      const foundCity = await resolveCityRecordByName(this.prisma, searchTerm);
      if (foundCity) {
        cityId = foundCity.id;
        break;
      }
    }
    if (cityId !== null) {
      const count = await (this.prisma as any).dvi_hotel.count({
        where: {
          hotel_category: preferredCategory,
          hotel_city: String(cityId),
          status: 1,
          deleted: { not: true },
        },
      });
      if (count > 0) return true;
    }
 // Fallback: Try LIKE search on address/name
    for (const searchTerm of citySearchTerms) {
      const hotelsLike = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) as count
        FROM dvi_hotel
        WHERE hotel_category = ${preferredCategory}
          AND status = 1
          AND (deleted = 0 OR deleted IS NULL)
          AND (hotel_city LIKE ${`%${searchTerm}%`}
            OR hotel_name LIKE ${`%${searchTerm}%`}
            OR hotel_address LIKE ${`%${searchTerm}%`})
      `;
      if (Number(hotelsLike[0]?.count || 0) > 0) return true;
    }
    return false;
  }
}
