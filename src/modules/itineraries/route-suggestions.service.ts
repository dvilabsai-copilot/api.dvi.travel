import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';

interface RouteDetailsRow {
  stored_route_location_ID: number;
  route_location_name: string;
}

export interface RouteResponse {
  no_routes_found?: boolean;
  no_matching_routes_found?: boolean;
  no_routes_message?: string;
  tabs?: string;
  tabContents?: string;
}

interface RouteTab {
  tabIndex: number;
  routeDetails: RouteDetailsRow[];
  startDate: string;
  startLocation: string;
  endLocation: string;
  noOfDays: number;
}

@Injectable()
export class RouteSuggestionsService {
  constructor(private prisma: PrismaService) {}

 /**
   * Get location_id from source and destination locations
   * Maps to PHP: getSTOREDLOCATION_ID_FROM_SOURCE_AND_DESTINATION
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
 console.log(
      `[getStoredRoutes] Searching for routes: locationId=${locationId}, noOfNights=${noOfNights}`,
    );
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
  ): Promise<RouteDetailsRow[]> {
    return (this.prisma as any).dvi_stored_route_location_details.findMany({
      where: {
        stored_route_id: storedRouteId,
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
   * Build the response with tabs and table content
 */
  private buildTabsAndContent(
    routeTabs: RouteTab[],
  ): { tabs: string; tabContents: string } {
    let tabs = '';
    let tabContents = '';

    routeTabs.forEach((routeTab, index) => {
      const tabIndex = index + 1;
      const isActive = index === 0 ? 'active' : '';
      const activeClass = isActive ? 'show active' : '';

 // Build tab header
      tabs += `<li class="nav-item">
        <a class="nav-link ${isActive}" id="route-tab-${tabIndex}" data-bs-toggle="tab" href="#route-${tabIndex}" role="tab" aria-controls="route-${tabIndex}" aria-selected="${isActive ? 'true' : 'false'}">
            Route ${tabIndex}
        </a>
    </li>`;

 // Build tab content
      let tabContent = `<div class="tab-pane fade ${activeClass}" id="route-${tabIndex}" role="tabpanel" aria-labelledby="route-tab-${tabIndex}">`;

      tabContent += `<table id="custom_route_details_LIST_${tabIndex}" class="table table-borderless" style="width:100%">
        <thead class="table-header-color">
            <tr>
                <th class="text-start" width="8%">DAY</th>
                <th class="text-start">DATE</th>
                <th class="text-start">SOURCE DESTINATION</th>
                <th class="text-start">NEXT DESTINATION</th>
                <th class="text-start">VIA ROUTE</th>
                <th class="text-start" colspan="2">DIRECT DESTINATION VISIT</th>
                <th style="width: 0; padding: 0px;"></th>
            </tr>
        </thead>
        <tbody id="custom_route_details_tbody_${tabIndex}">`;

 // Add route detail rows
      let routeDate = this.parseAndFormatDate(routeTab.startDate);
      let sourceLocation = routeTab.startLocation;
      let nextVisitingLocation = '';

      routeTab.routeDetails.forEach((detail, dayIndex) => {
        const dayCounter = dayIndex + 1;
        nextVisitingLocation = detail.route_location_name;

        tabContent += `<tr id="route_details_${tabIndex}_${detail.stored_route_location_ID}" class="route_details" data-itinerary_route_ID="" data-day-no="${dayCounter}">
            <td class="day text-start" width="8%">DAY ${dayCounter}</td>
            <td class="date" id="route_date_${tabIndex}_${dayCounter}">${routeDate}</td>
            <td>
                <input type="text" name="source_location_${tabIndex}[]" id="source_location_${tabIndex}_${dayCounter}" class="bg-body form-select form-control location" value="${this.htmlspecialchars(sourceLocation)}">
                <input type="hidden" name="hidden_itinerary_route_ID_${tabIndex}[]" value="${routeDate}">
                <input type="hidden" id="itinerary_route_date_${tabIndex}_${dayCounter}" name="hidden_itinerary_route_date_${tabIndex}[]" value="${routeDate}">
            </td>
            <td>
                <select name="next_visiting_location_${tabIndex}[]" id="next_visiting_location_${tabIndex}_${dayCounter}" class="next_visiting_location text-start form-select form-control location" required>
                    <option value="${this.htmlspecialchars(nextVisitingLocation)}" ${routeTab.endLocation === nextVisitingLocation ? 'selected' : ''}>${this.htmlspecialchars(nextVisitingLocation)}</option>
                </select>
            </td>
            <td>
                <button type="button" class="btn btn-outline-primary btn-sm add_via_route" onclick="addDEFAULTVIAROUTE(${dayCounter}, '', '', ${tabIndex})"><i class="ti ti-route ti-tada-hover"></i></button>
            </td>
            <td>
                <label class="switch switch-sm">
                    <input type="checkbox" id="direct_destination_visit_${tabIndex}_${dayCounter}" name="direct_destination_visit_${tabIndex}[${dayCounter}][]" class="switch-input">
                    <span class="switch-toggle-slider">
                        <span class="switch-on"><i class="ti ti-check"></i></span>
                        <span class="switch-off"><i class="ti ti-x"></i></span>
                    </span>
                </label>
            </td>
            <td></td>
        </tr>`;

 // Update date and source for next day
        routeDate = this.addDaysToDate(routeDate, 1);
        sourceLocation = nextVisitingLocation;
      });

 // Add last day row
      const lastDayCounter = routeTab.routeDetails.length + 1;
      tabContent += `<tr id="route_details_${tabIndex}_last" class="route_details" data-itinerary_route_ID="" data-day-no="${lastDayCounter}">
            <td class="day text-start" width="8%">DAY ${lastDayCounter}</td>
            <td class="date" id="route_date_${tabIndex}_${lastDayCounter}">${routeDate}</td>
            <td>
                <input type="text" name="source_location_${tabIndex}[]" id="source_location_${tabIndex}_${lastDayCounter}" class="bg-body form-select form-control location" value="${this.htmlspecialchars(nextVisitingLocation)}">
                <input type="hidden" name="hidden_itinerary_route_ID_${tabIndex}[]" value="">
                <input type="hidden" id="itinerary_route_date_${tabIndex}_${lastDayCounter}" name="hidden_itinerary_route_date_${tabIndex}[]" value="${routeDate}">
            </td>
            <td>
                <select name="next_visiting_location_${tabIndex}[]" id="next_visiting_location_${tabIndex}_${lastDayCounter}" class="next_visiting_location text-start form-select form-control location" required>
                    <option value="${this.htmlspecialchars(routeTab.endLocation)}" selected>${this.htmlspecialchars(routeTab.endLocation)}</option>
                </select>
            </td>
            <td>
                <button type="button" class="btn btn-outline-primary btn-sm add_via_route" onclick="addDEFAULTVIAROUTE(${lastDayCounter}, '', '', ${tabIndex})"><i class="ti ti-route ti-tada-hover"></i></button>
            </td>
            <td>
                <label class="switch switch-sm">
                    <input type="checkbox" id="direct_destination_visit_${tabIndex}_${lastDayCounter}" name="direct_destination_visit_${tabIndex}[${lastDayCounter}][]" class="switch-input">
                    <span class="switch-toggle-slider">
                        <span class="switch-on"><i class="ti ti-check"></i></span>
                        <span class="switch-off"><i class="ti ti-x"></i></span>
                    </span>
                </label>
            </td>
            <td></td>
        </tr>`;

      tabContent += `</tbody></table>`;

 // Add "Add Day" button
      tabContent += `<div class="text-start">
        <button type="button" id="route_add_days_btn_${tabIndex}" class="btn btn-outline-dribbble btn-sm addNextDayPlan" onclick="addDayToRoute(${tabIndex})" data-tab-index="${tabIndex}">
            <i class="ti ti-plus ti-tada-hover"></i>Add Day
        </button>
    </div>`;

      tabContent += `</div>`;
      tabContents += tabContent;
    });

    return { tabs, tabContents };
  }

 /**
   * Get default route suggestions
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

      const response: RouteResponse = {};
      const adjustedDays = noOfRouteDays - 1;

 // Get location ID
      const locationId = await this.getLocationIdFromSourceDestination(
        arrivalLocation,
        departureLocation,
      );

 console.log(`[getDefaultRouteSuggestions] locationId=${locationId}`);

      if (!locationId) {
        response.no_routes_found = true;
        response.no_routes_message =
          'No location found for the selected source and destination.';
        return response;
      }

 // Get stored routes
    const storedRoutes = await this.getStoredRoutes(locationId, adjustedDays);

    if (storedRoutes.length === 0) {
      response.no_routes_found = true;

 // Check available alternatives
      const availabilityInfo = await this.checkAvailableRoutes(
        locationId,
        adjustedDays,
      );

      if (availabilityInfo.exactCount > 0) {
        response.no_routes_message = `Routes are available for exactly ${adjustedDays} nights.`;
      } else if (availabilityInfo.greaterCount > 0) {
        response.no_routes_message = `Routes are not available for ${adjustedDays} night(s), but available for the minimum no_of_nights: ${availabilityInfo.minNights} and above.`;
      } else if (availabilityInfo.availableNights.length > 0) {
        response.no_routes_message = `Routes are not available for ${adjustedDays} nights, but available for the following no_of_nights: ${availabilityInfo.availableNights.join(', ')}.`;
      } else {
        response.no_routes_message =
          'No routes are available for this location.';
      }

      return response;
    }

 // Process routes - limit to 5
    response.no_routes_found = false;
    const selectedRoutes = storedRoutes.slice(0, 5);
    const routeTabs: RouteTab[] = [];

    for (const route of selectedRoutes) {
      const routeDetails = await this.getRouteLocationDetails(
        route.stored_route_ID,
        adjustedDays,
      );

      routeTabs.push({
        tabIndex: routeTabs.length + 1,
        routeDetails,
        startDate: formattedStartDate,
        startLocation: arrivalLocation,
        endLocation: departureLocation,
        noOfDays: adjustedDays,
      });
    }

    if (routeTabs.length > 0) {
      response.no_matching_routes_found = false;
      const { tabs, tabContents } = this.buildTabsAndContent(routeTabs);
      response.tabs = tabs;
      response.tabContents = tabContents;
    } else {
      response.no_matching_routes_found = true;
    }

    return response;
    } catch (error) {
 console.error('[getDefaultRouteSuggestions] Error:', error);
      return {
        no_routes_found: true,
        no_routes_message: 'An error occurred while fetching route suggestions.',
      };
    }
  }

 /**
   * Helper: Format date string from d-m-Y to d/m/Y
 */
  private parseAndFormatDate(dateStr: string): string {
 // Input: "06-01-2026" -> Output: "06/01/2026"
    return dateStr.replace(/-/g, '/');
  }

 /**
   * Helper: Add days to date string
 */
  private addDaysToDate(dateStr: string, days: number): string {
 // Input: "06/01/2026" -> Add 1 day -> "07/01/2026"
    const parts = dateStr.split('/');
    if (parts.length !== 3) return dateStr;

    const date = new Date(
      parseInt(parts[2]),
      parseInt(parts[1]) - 1,
      parseInt(parts[0]),
    );
    date.setDate(date.getDate() + days);

    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();

    return `${day}/${month}/${year}`;
  }

 /**
   * Helper: Escape HTML special characters
 */
  private htmlspecialchars(str: string): string {
    const entityMap: { [key: string]: string } = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return String(str).replace(/[&<>"']/g, (s) => entityMap[s]);
  }
}
