import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';

interface DayDetail {
  dayNo: number;
  date: string;
  sourceLocation: string;
  nextLocation: string;
  viaRoute?: string;
  directVisit?: boolean;
}

interface RouteData {
  routeId: number;
  routeName: string;
  noOfDays: number;
  days: DayDetail[];
}

export interface RouteResponse {
  success: boolean;
  no_routes_found?: boolean;
  no_routes_message?: string;
  routes?: RouteData[];
}

@Injectable()
export class RouteSuggestionsV2Service {
  constructor(private prisma: PrismaService) {}

  /**
   * Get location_id from source and destination locations
   */
  async getLocationIdFromSourceDestination(
    source: string,
    destination: string,
  ): Promise<number | null> {
    const trimmedSource = source?.trim() || '';
    const trimmedDest = destination?.trim() || '';

    const location = await (this.prisma as any).dvi_stored_locations.findFirst({
      where: {
        source_location: trimmedSource,
        destination_location: trimmedDest,
      },
      select: {
        location_ID: true,
      },
    });

    // Convert BigInt to number
    return location?.location_ID ? Number(location.location_ID) : null;
  }

  /**
   * Get stored routes matching location_id and no_of_nights
   */
  async getStoredRoutes(
    locationId: number,
    noOfNights: number,
  ): Promise<any[]> {
    return (this.prisma as any).dvi_stored_routes.findMany({
      where: {
        location_id: Number(locationId),
        deleted: 0,
        status: 1,
        no_of_nights: Number(noOfNights),
      },
      select: {
        stored_route_ID: true,
        route_name: true,
      },
    });
  }

  /**
   * Get route location details for a specific route
   */
  async getRouteLocationDetails(
    storedRouteId: number,
    limit: number,
  ): Promise<any[]> {
    return (this.prisma as any).dvi_stored_route_location_details.findMany({
      where: {
        stored_route_id: Number(storedRouteId),
        deleted: 0,
        status: 1,
      },
      select: {
        stored_route_location_ID: true,
        route_location_name: true,
      },
      take: limit,
    });
  }

  /**
   * Check available routes with different night counts for the location
   */
  async checkAvailableRoutes(
    locationId: number,
    requestedNights: number,
  ): Promise<{
    exactCount: number;
    greaterCount: number;
    minNights: number | null;
    availableNights: number[];
  }> {
    // Check exact routes
    const exactResult = await (
      this.prisma as any
    ).dvi_stored_routes.aggregate({
      where: {
        location_id: Number(locationId),
        deleted: 0,
        status: 1,
        no_of_nights: Number(requestedNights),
      },
      _count: {
        stored_route_ID: true,
      },
    });

    const exactCount = exactResult._count.stored_route_ID;

    // Check greater routes - use findMany instead of aggregateRaw
    const greaterRoutes = await (
      this.prisma as any
    ).dvi_stored_routes.findMany({
      where: {
        location_id: Number(locationId),
        deleted: 0,
        status: 1,
        no_of_nights: { gt: Number(requestedNights) },
      },
      select: { no_of_nights: true },
    });

    const greaterCount = greaterRoutes.length;
    const minNights =
      greaterRoutes.length > 0
        ? Math.min(...greaterRoutes.map((r) => r.no_of_nights))
        : null;

    // Check shorter routes
    const shorterRoutes = await (
      this.prisma as any
    ).dvi_stored_routes.findMany({
      where: {
        location_id: Number(locationId),
        deleted: 0,
        status: 1,
        no_of_nights: { lt: Number(requestedNights) },
      },
      distinct: ['no_of_nights'],
      orderBy: { no_of_nights: 'asc' },
      select: { no_of_nights: true },
    });

    const availableNights = shorterRoutes.map((r) => r.no_of_nights);

    return {
      exactCount,
      greaterCount,
      minNights,
      availableNights,
    };
  }

  /**
   * Parse and format date - convert d-m-Y to d/m/Y for display
   */
  private parseAndFormatDate(dateStr: string): string {
    return dateStr.replace(/-/g, '/');
  }

  /**
   * Main method: Get default route suggestions
   * Returns: Clean JSON data with routes
   */
  async getDefaultRouteSuggestions(
    noOfRouteDays: number,
    arrivalLocation: string,
    departureLocation: string,
    formattedStartDate: string,
    formattedEndDate: string,
  ): Promise<RouteResponse> {
    try {
      console.log(
        `[getDefaultRouteSuggestions] Called with: ${arrivalLocation} → ${departureLocation}, ${noOfRouteDays} days`,
      );

      const adjustedDays = noOfRouteDays - 1;

      // Get location ID
      const locationId = await this.getLocationIdFromSourceDestination(
        arrivalLocation,
        departureLocation,
      );

      console.log(`[getDefaultRouteSuggestions] locationId=${locationId}`);

      if (!locationId) {
        return {
          success: false,
          no_routes_found: true,
          no_routes_message:
            'No location found for the selected source and destination.',
        };
      }

      // Get stored routes
      const storedRoutes = await this.getStoredRoutes(locationId, adjustedDays);

      console.log(
        `[getDefaultRouteSuggestions] Found ${storedRoutes.length} stored routes`,
      );

      if (storedRoutes.length === 0) {
        // Check available alternatives
        const availabilityInfo = await this.checkAvailableRoutes(
          locationId,
          adjustedDays,
        );

        let messageText = 'No routes are available for this location.';

        if (availabilityInfo.exactCount > 0) {
          messageText = `Routes are available for exactly ${adjustedDays} nights.`;
        } else if (availabilityInfo.greaterCount > 0) {
          messageText = `Routes are not available for ${adjustedDays} night(s), but available for minimum ${availabilityInfo.minNights} nights and above.`;
        } else if (availabilityInfo.availableNights.length > 0) {
          messageText = `Routes are not available for ${adjustedDays} nights, but available for: ${availabilityInfo.availableNights.join(', ')} nights.`;
        }

        return {
          success: false,
          no_routes_found: true,
          no_routes_message: messageText,
        };
      }

      // Process routes - limit to 5
      const selectedRoutes = storedRoutes;
      const routes: RouteData[] = [];

      for (const route of selectedRoutes) {
        const routeDetails = await this.getRouteLocationDetails(
          route.stored_route_ID,
          adjustedDays,
        );

        // Build day details
        const days: DayDetail[] = [];
        
        // Parse DD/MM/YYYY format date
        const dateParts = formattedStartDate.split('/');
        const day = parseInt(dateParts[0], 10);
        const month = parseInt(dateParts[1], 10);
        const year = parseInt(dateParts[2], 10);
        
        console.log(`[getDefaultRouteSuggestions] Parsing date: ${formattedStartDate} -> D:${day}, M:${month}, Y:${year}`);
        
        const startDate = new Date(year, month - 1, day);
        console.log(`[getDefaultRouteSuggestions] Calculated startDate: ${startDate.toString()}`);

        // Stored route rows are saved by night/stay count, but the create-itinerary
        // form renders travel segments by day. For a 4N/5D round-trip we therefore
        // need 5 rows: airport -> stop1 ... last stop -> departure.
        for (let i = 0; i < noOfRouteDays; i++) {
          const currentDate = new Date(startDate);
          currentDate.setDate(currentDate.getDate() + i);

          // Format as DD/MM/YYYY (with slashes, matching Customize mode)
          const dateStr = `${String(currentDate.getDate()).padStart(2, '0')}/${String(currentDate.getMonth() + 1).padStart(2, '0')}/${currentDate.getFullYear()}`;
          
          console.log(`[getDefaultRouteSuggestions] Day ${i + 1}: ${dateStr}`);

          const sourceLocation =
            i === 0
              ? arrivalLocation
              : routeDetails[i - 1]?.route_location_name || '';

          const nextLocation =
            routeDetails[i]?.route_location_name ||
            (i === noOfRouteDays - 1 ? departureLocation : '');

          days.push({
            dayNo: i + 1,
            date: dateStr,
            sourceLocation,
            nextLocation,
            viaRoute: '',
            directVisit: false,
          });
        }

        routes.push({
          routeId: route.stored_route_ID,
          routeName: route.route_name,
          noOfDays: noOfRouteDays,
          days,
        });
      }

      return {
        success: true,
        no_routes_found: false,
        routes,
      };
    } catch (error) {
      console.error('[getDefaultRouteSuggestions] Error:', error);
      return {
        success: false,
        no_routes_found: true,
        no_routes_message: 'An error occurred while fetching route suggestions.',
      };
    }
  }
}
