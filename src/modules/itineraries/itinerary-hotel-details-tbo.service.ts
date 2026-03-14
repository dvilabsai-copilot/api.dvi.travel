// FILE: src/modules/itineraries/itinerary-hotel-details-tbo.service.ts

import { Injectable, NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { HotelSearchService } from '../hotels/services/hotel-search.service';
import { HobseHotelProvider } from '../hotels/providers/hobse-hotel.provider';
import { HotelSearchResult } from '../hotels/interfaces/hotel-provider.interface';
import {
  ItineraryHotelTabDto,
  ItineraryHotelRowDto,
  ItineraryHotelDetailsResponseDto,
  ItineraryHotelRoomDetailsResponseDto,
  ItineraryHotelRoomDto,
} from './itinerary-hotel-details.service';

/**
 * This service generates dynamic hotel packages from TBO API
 * instead of retrieving them from the database
 */
@Injectable()
export class ItineraryHotelDetailsTboService {
  private readonly logger = new Logger(ItineraryHotelDetailsTboService.name);
  
  // Cache structure: key = "quoteId:routeId" or "quoteId" (no route filter)
  // Stores the entire response to avoid re-fetching TBO data
  private hotelRoomDetailsCache = new Map<string, {
    data: ItineraryHotelRoomDetailsResponseDto;
    timestamp: number;
  }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly hotelSearchService: HotelSearchService,
    private readonly hobseProvider: HobseHotelProvider,
  ) {}

  /**
   * Get hotel details with dynamic packages from TBO API
   * Creates 4 different price tier packages: Budget, Mid-Range, Premium, Luxury
   */
  async getHotelDetailsByQuoteIdFromTbo(
    quoteId: string,
  ): Promise<ItineraryHotelDetailsResponseDto> {
    const startTime = Date.now();
    this.logger.log(`\n📡 TBO HOTEL PACKAGES: Fetching dynamic packages for quote: ${quoteId}`);

    // Step 1: Get itinerary plan
    const plan = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_quote_ID: quoteId, deleted: 0 },
    });

    if (!plan) {
      this.logger.warn(`⚠️  Quote ID not found: ${quoteId}`);
      throw new NotFoundException('Itinerary not found');
    }

    const planId = plan.itinerary_plan_ID;
    this.logger.log(`✅ Found plan ID: ${planId}`);

    // Step 2: Get itinerary routes (days and destinations)
    const routes = await this.prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: planId, deleted: 0 },
      orderBy: { itinerary_route_date: 'asc' },
    });

    this.logger.log(`📅 Routes Query Result: ${JSON.stringify({
      total: routes.length,
      routes: routes.map(r => ({ id: (r as any).itinerary_route_ID, location: (r as any).location_name, date: (r as any).itinerary_route_date }))
    })}`);

    if (routes.length === 0) {
      this.logger.warn(`⚠️  No routes found for plan ${planId}`);
      throw new BadRequestException('Itinerary has no routes');
    }

    this.logger.log(`📅 Found ${routes.length} routes to process`);

    // Get number of nights from plan to determine which routes need hotels
    const noOfNights = Number((plan as any).no_of_nights || 0);
    this.logger.log(`🌙 Plan has ${noOfNights} nights`);

    // Step 3: Fetch hotels from TBO for each route (except last route if it's departure day)
    const hotelsByRoute = await this.fetchHotelsForRoutes(routes, noOfNights);
    
    // Step 3.5: Fetch HOBSE hotels and merge with TBO hotels
    // First, create a HOBSE-specific city code map using hobse_city_code
    const hobseCityCodeMap = await this.batchMapDestinationsToHobseCityCodes(routes);
    const hobseHotelsByRoute = await this.fetchHobseHotelsForRoutes(routes, noOfNights, hobseCityCodeMap);
    
    // Merge HOBSE hotels into the TBO hotel map
    hobseHotelsByRoute.forEach((hobseHotels, routeId) => {
      const existingHotels = hotelsByRoute.get(routeId) || [];
      hotelsByRoute.set(routeId, [...existingHotels, ...hobseHotels]);
    });
    
    // Debug: Check if any hotels were found
    const hotelEntries = Array.from(hotelsByRoute.entries());
    this.logger.log(`\n📊 HOTEL FETCH RESULTS (TBO + HOBSE):`);
    hotelEntries.forEach(([routeId, hotels]) => {
      const tboCount = hotels.filter(h => h.provider === 'tbo').length;
      const hobseCount = hotels.filter(h => h.provider === 'hobse').length;
      this.logger.log(`   Route ${routeId}: ${hotels.length} hotels (TBO: ${tboCount}, HOBSE: ${hobseCount})`);
      if (hotels.length > 0) {
        this.logger.log(`      - ${hotels.map(h => `${h.hotelName} (${h.provider})`).join(', ')}`);
      }
    });
    
    if (hotelEntries.every(([_, hotels]) => hotels.length === 0)) {
      this.logger.warn(`\n❌ WARNING: ALL ROUTES RETURNED ZERO HOTELS!\n`);
    }
    
    this.logger.log(`🏨 Hotels by Route: ${JSON.stringify(Object.fromEntries(hotelsByRoute))}`);

    // Step 4: Generate 4 price tier packages
    const packages = this.generatePricePackages(hotelsByRoute, routes);

    // Step 5: Build response
    const response = await this.buildHotelDetailsResponse(
      quoteId,
      planId,
      packages,
      hotelsByRoute,
      routes,
      noOfNights,
    );

    const duration = Date.now() - startTime;
    this.logger.log(`✅ Generated ${packages.length} hotel packages`);
    this.logger.log(`⏱️  Total TBO Service Time: ${duration}ms\n`);

    return response;
  }

  /**
   * Fetch available hotels from TBO for each route with OPTIMIZED city mapping
   * Uses batch city lookup and parallel processing instead of sequential queries
   */
  private async fetchHotelsForRoutes(
    routes: any[],
    noOfNights: number,
  ): Promise<Map<number, HotelSearchResult[]>> {
    const hotelsByRoute = new Map<number, HotelSearchResult[]>();
    const totalRoutes = routes.length;

    // 🔥 OPTIMIZATION 1: Batch load ALL cities upfront instead of querying per route
    const cityCodeMap = await this.batchMapDestinationsToCityCodes(routes);
    this.logger.log(`✅ Pre-loaded ${Object.keys(cityCodeMap).length} city codes for all routes`);

    // 🔥 OPTIMIZATION 2: Prepare all hotel search tasks for parallel execution
    const searchTasks: Promise<void>[] = [];

    for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
      const route = routes[routeIndex];
      const routeId = (route as any).itinerary_route_ID;
      
      // Skip hotel generation for the last route (departure day) if routeIndex >= noOfNights
      const isLastRoute = routeIndex === totalRoutes - 1;
      if (isLastRoute && routeIndex >= noOfNights) {
        this.logger.log(`   ⏭️  Skipping route ${routeIndex + 1} (last route - departure day, no hotel needed)`);
        continue;
      }
      
      // Push search task to run in parallel
      searchTasks.push(
        this.searchHotelsForRoute(route, routeIndex, cityCodeMap, hotelsByRoute).catch(error => {
          const routeId = (route as any).itinerary_route_ID;
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.error(`❌ HOTEL SEARCH ERROR for route ${routeId}: ${errorMsg}`);
          hotelsByRoute.set(routeId, []);
        })
      );
    }

    // 🔥 OPTIMIZATION 3: Execute all searches in parallel instead of sequentially
    this.logger.log(`⏳ Starting ${searchTasks.length} parallel hotel searches...`);
    await Promise.all(searchTasks);
    this.logger.log(`✅ All parallel searches completed`);

    return hotelsByRoute;
  }

  /**
   * Batch load city codes for all destinations in one pass
   * Reduces database queries from N×3 (N routes × 3 attempts) to 1 query
   */
  private async batchMapDestinationsToCityCodes(routes: any[]): Promise<Record<string, string>> {
    const cityCodeMap: Record<string, string> = {};
    
    // Extract unique destinations from all routes
    const uniqueDestinations = [...new Set(routes.map(r => (r as any).next_visiting_location))];
    this.logger.log(`📍 Extracting city codes for ${uniqueDestinations.length} unique destinations`);

    if (uniqueDestinations.length === 0) return cityCodeMap;

    // ⚡ Load ALL cities from database in ONE query instead of per-route queries
    const allCities = await this.prisma.dvi_cities.findMany({
      select: { name: true, tbo_city_code: true },
    });
    this.logger.log(`✅ Loaded ${allCities.length} cities from database in single query`);

    // Build a map for fast lookup
    const cityNameMap: Record<string, string> = {};
    const cityPrefixMap: Record<string, string> = {};
    
    allCities.forEach(city => {
      if (city.tbo_city_code) {
        cityNameMap[city.name.toLowerCase()] = city.tbo_city_code;
        const prefix = city.name.split(',')[0].trim().toUpperCase();
        cityPrefixMap[prefix] = city.tbo_city_code;
      }
    });

    // Map each destination to city code
    uniqueDestinations.forEach(destination => {
      if (!destination) return;

      // Try exact match (case-insensitive)
      let cityCode = cityNameMap[destination.toLowerCase()];
      
      if (!cityCode) {
        // Try partial match with first part
        const firstPart = destination.split(',')[0].trim();
        cityCode = cityNameMap[firstPart.toLowerCase()];
      }

      if (!cityCode) {
        // Try prefix match
        const prefix = destination.split(',')[0].trim().toUpperCase();
        cityCode = cityPrefixMap[prefix];
      }

      if (cityCode) {
        this.logger.log(`✅ "${destination}" → TBO Code: ${cityCode}`);
        cityCodeMap[destination] = cityCode;
      } else {
        this.logger.warn(`❌ No city code found for: "${destination}"`);
      }
    });

    return cityCodeMap;
  }

  /**
     * Batch load HOBSE city codes for all destinations using hobse_city_code field.
     */
    private async batchMapDestinationsToHobseCityCodes(routes: any[]): Promise<Record<string, string>> {
      const cityCodeMap: Record<string, string> = {};
      const uniqueDestinations = [...new Set(routes.map(r => (r as any).next_visiting_location))] as string[];

      this.logger.log(`📍 Loading HOBSE city codes for ${uniqueDestinations.length} unique destinations`);
      if (uniqueDestinations.length === 0) return cityCodeMap;

      const allCities = await this.prisma.dvi_cities.findMany({
        select: { name: true, hobse_city_code: true } as any,
      });
      this.logger.log(`✅ Loaded ${allCities.length} cities for HOBSE code lookup`);

      const cityNameMap: Record<string, string> = {};
      const cityPrefixMap: Record<string, string> = {};

      allCities.forEach((city: any) => {
        if (city.hobse_city_code) {
          cityNameMap[city.name.toLowerCase()] = String(city.hobse_city_code);
          const prefix = city.name.split(',')[0].trim().toLowerCase();
          cityPrefixMap[prefix] = String(city.hobse_city_code);
        }
      });

      uniqueDestinations.forEach(destination => {
        if (!destination) return;
        const lower = destination.toLowerCase();
        let code = cityNameMap[lower];

        if (!code) {
          const firstPart = destination.split(/[,\(\-]/)[0].trim().toLowerCase();
          code = cityNameMap[firstPart] || cityPrefixMap[firstPart];
        }

        if (code) {
          this.logger.log(`✅ HOBSE "${destination}" -> code: ${code}`);
          cityCodeMap[destination] = code;
        } else {
          this.logger.warn(`❌ No HOBSE city code found for: "${destination}"`);
        }
      });

      return cityCodeMap;
  }

  /**
   * Search hotels for a single route (used in parallel execution)
   */
  private async searchHotelsForRoute(
    route: any,
    routeIndex: number,
    cityCodeMap: Record<string, string>,
    hotelsByRoute: Map<number, HotelSearchResult[]>,
  ): Promise<void> {
    const routeId = (route as any).itinerary_route_ID;
    const destination = (route as any).next_visiting_location;
    const routeDate = new Date((route as any).itinerary_route_date);

    // Set check-out to next day (standard 1-night stay)
    const checkOutDate = new Date(routeDate);
    checkOutDate.setDate(checkOutDate.getDate() + 1);

    this.logger.log(`🔍 Route ${routeId}: Searching hotels for "${destination}" (${routeDate.toISOString().split('T')[0]})`);

    // Get city code from pre-loaded map (no database query!)
    const cityCode = cityCodeMap[destination];
    
    if (!cityCode) {
      this.logger.warn(`❌ Route ${routeId}: No city code for "${destination}" - skipping`);
      hotelsByRoute.set(routeId, []);
      return;
    }

    const searchCriteria = {
      cityCode,
      checkInDate: routeDate.toISOString().split('T')[0],
      checkOutDate: checkOutDate.toISOString().split('T')[0],
      roomCount: 1,
      guestCount: 2,
      providers: ['tbo', 'resavenue'], // Only TBO + ResAvenue - HOBSE will be merged separately
    };

    this.logger.log(`   🏨 Searching hotels with cityCode: ${cityCode}`);
    const hotels = await this.hotelSearchService.searchHotels(searchCriteria);
    this.logger.log(`   ✅ Found ${hotels ? hotels.length : 0} hotels for route ${routeId} (TBO only at this stage)`);
    
    if (hotels && hotels.length > 0) {
      this.logger.log(`   📋 TBO Hotels for route ${routeId}:`);
      hotels.forEach((h, idx) => {
        this.logger.log(`      ${idx + 1}. ${h.hotelName} (${h.provider}) - ₹${h.price}`);
      });
    } else {
      this.logger.log(`   ⚠️  WARNING: TBO search returned ZERO hotels for route ${routeId}!`);
    }
    
    hotelsByRoute.set(routeId, hotels || []);
  }

  /**
   * Fetch HOBSE hotels for each route
   * Maps destinations to HOBSE city codes and calls HOBSE provider
   */
  private async fetchHobseHotelsForRoutes(
    routes: any[],
    noOfNights: number,
    cityCodeMap: Record<string, string>,
  ): Promise<Map<number, HotelSearchResult[]>> {
    const hotelsByRoute = new Map<number, HotelSearchResult[]>();
    const totalRoutes = routes.length;

    this.logger.log(`\n🏨 HOBSE HOTEL FETCH: Attempting to fetch HOBSE hotels for ${routes.length} routes`);

    try {
      for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
        const route = routes[routeIndex];
        const routeId = (route as any).itinerary_route_ID;
        
        // Skip hotel generation for the last route (departure day) if routeIndex >= noOfNights
        const isLastRoute = routeIndex === totalRoutes - 1;
        if (isLastRoute && routeIndex >= noOfNights) {
          this.logger.log(`   ⏭️  Skipping HOBSE route ${routeIndex + 1} (last route - departure day)`);
          continue;
        }
        
        const destination = (route as any).next_visiting_location;
        // Get the HOBSE city code from the pre-built map
        const cityCode = cityCodeMap[destination];
        
        if (!cityCode) {
          this.logger.warn(`   ⚠️  No HOBSE city code for destination "${destination}" - skipping HOBSE search`);
          hotelsByRoute.set(routeId, []);
          continue;
        }
        const routeDate = new Date((route as any).itinerary_route_date);
        const checkOutDate = new Date(routeDate);
        checkOutDate.setDate(checkOutDate.getDate() + 1);

        try {
          // Pass city code (number) instead of destination name (string)
          const hobseHotels = await this.hobseProvider.search({
            cityCode: cityCode,
            checkInDate: routeDate.toISOString().split('T')[0],
            checkOutDate: checkOutDate.toISOString().split('T')[0],
            roomCount: 1,
            guestCount: 2,
          });

          if (hobseHotels && hobseHotels.length > 0) {
            this.logger.log(`   ✅ HOBSE Route ${routeId}: Found ${hobseHotels.length} hotels in ${destination}`);
            hotelsByRoute.set(routeId, hobseHotels);
          } else {
            this.logger.log(`   ℹ️  HOBSE Route ${routeId}: No hotels found in ${destination}`);
            hotelsByRoute.set(routeId, []);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.warn(`   ⚠️  HOBSE Route ${routeId} search failed: ${errorMsg}`);
          hotelsByRoute.set(routeId, []);
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`❌ HOBSE HOTEL FETCH FAILED: ${errorMsg}`);
    }

    return hotelsByRoute;
  }

  /**
   * Generate 4 price tier packages: Budget, Mid-Range, Premium, Luxury
   * Ensures INCREASING price order: Budget < Mid-Range < Premium < Luxury
   */
  private generatePricePackages(
    hotelsByRoute: Map<number, HotelSearchResult[]>,
    routes: any[],
  ): Array<{ groupType: number; label: string; hotels: Array<HotelSearchResult & { routeId: number }> }> {
    const packages: Array<{
      groupType: number;
      label: string;
      hotels: Array<HotelSearchResult & { routeId: number }>;
    }> = [];

    const labels = [
      'Budget Hotels',
      'Mid-Range Hotels',
      'Premium Hotels',
      'Luxury Hotels',
    ];

    // Debug: Log all available hotels
    this.logger.log(`\n   📊 PRICE TIER GENERATION DEBUG (PER-DESTINATION):`);
    this.logger.log(`   Total routes: ${routes.length}`);
    hotelsByRoute.forEach((hotels, routeId) => {
      const prices = hotels.map(h => h.price).join(', ');
      this.logger.log(`   Route ${routeId}: ${hotels.length} hotels (Prices: ${prices})`);
    });

    // NEW LOGIC: Assign hotels to groups PER DESTINATION (per route)
    // Rule: If 1 hotel -> put in all 4 groups
    //       If 2+ hotels -> distribute in ascending price order across groups
    
    // First pass: Determine groupType for each hotel based on its destination
    const hotelGroupAssignments = new Map<string, number>(); // key: "routeId-hotelCode" -> groupType
    
    for (const route of routes) {
      const routeId = (route as any).itinerary_route_ID;
      const availableHotels = hotelsByRoute.get(routeId) || [];

      if (availableHotels.length === 0) {
        this.logger.warn(`      ⚠️  No hotels available for route ${routeId}`);
        continue;
      }

      // Sort hotels by price (ascending) for this destination
      const sortedHotels = [...availableHotels].sort((a, b) => a.price - b.price);

      if (sortedHotels.length === 1) {
        // Single hotel: assign to ALL 4 groups
        const hotel = sortedHotels[0];
        for (let groupType = 1; groupType <= 4; groupType++) {
          const key = `${routeId}-${hotel.hotelCode || hotel.hotelName}`;
          hotelGroupAssignments.set(`${key}:${groupType}`, groupType);
        }
        this.logger.debug(`   Route ${routeId}: 1 hotel - "${hotel.hotelName}" (₹${hotel.price}) assigned to ALL groups`);
      } else {
        // Multiple hotels: distribute across groups by price order
        const numHotels = sortedHotels.length;
        const groupsNeeded = Math.min(numHotels, 4);
        
        sortedHotels.forEach((hotel, index) => {
          // Map hotels to groups in ascending price order
          let groupType = 1;
          if (numHotels <= 4) {
            // Fewer hotels than groups: distribute evenly
            groupType = Math.min(index + 1, 4);
          } else {
            // More hotels than groups: distribute proportionally
            groupType = Math.floor((index / numHotels) * 4) + 1;
            groupType = Math.min(groupType, 4);
          }
          
          const key = `${routeId}-${hotel.hotelCode || hotel.hotelName}`;
          hotelGroupAssignments.set(`${key}:${groupType}`, groupType);
        });
        
        this.logger.debug(`   Route ${routeId}: ${numHotels} hotels - Distributed across groups by price order`);
        sortedHotels.forEach((h, i) => {
          const key = `${routeId}-${h.hotelCode || h.hotelName}`;
          let groupType = 1;
          if (numHotels <= 4) {
            groupType = Math.min(i + 1, 4);
          } else {
            groupType = Math.floor((i / numHotels) * 4) + 1;
            groupType = Math.min(groupType, 4);
          }
          this.logger.debug(`      "${h.hotelName}" (₹${h.price}) -> Group ${groupType}`);
        });
      }
    }

    // Second pass: Build packages from the assignments
    for (let tier = 0; tier < 4; tier++) {
      const groupType = tier + 1;
      const tieredHotels: Array<HotelSearchResult & { routeId: number }> = [];

      for (const route of routes) {
        const routeId = (route as any).itinerary_route_ID;
        const availableHotels = hotelsByRoute.get(routeId) || [];

        if (availableHotels.length === 0) {
          this.logger.debug(`   Tier ${groupType}, Route ${routeId}: No hotels available`);
          // CREATE PLACEHOLDER FOR NO HOTELS - price 0
          const placeholderHotel: any = {
            hotelCode: '0',
            hotelName: 'No Hotels Available',
            roomType: '-',
            mealPlan: '-',
            price: 0,
            rating: 0,
            routeId: routeId
          };
          tieredHotels.push(placeholderHotel);
          continue;
        }

        // Get hotels that belong to this tier for this route
        for (const hotel of availableHotels) {
          const key = `${routeId}-${hotel.hotelCode || hotel.hotelName}`;
          const assignedGroupType = hotelGroupAssignments.get(`${key}:${groupType}`);
          
          if (assignedGroupType === groupType) {
            const hotelWithRoute = { ...hotel, routeId } as HotelSearchResult & { routeId: number };
            tieredHotels.push(hotelWithRoute);
          }
        }
      }

      // Add package with ALL matching hotels for this tier
      if (tieredHotels.length > 0) {
        const totalPrice = tieredHotels.reduce((sum, h) => sum + h.price, 0);
        packages.push({
          groupType: groupType,
          label: labels[tier],
          hotels: tieredHotels,
        });
        this.logger.log(`   ✅ Group ${groupType} (${labels[tier]}): ${tieredHotels.length} hotels total, ₹${totalPrice} combined`);
      } else {
        this.logger.log(`   ⚠️  Group ${groupType} (${labels[tier]}): No hotels found for any route`);
      }
    }

    this.logger.log(`📦 Generated ${packages.length} price tier packages\n`);
    return packages;
  }

  /**
   * Build the response DTO
   */
  private async buildHotelDetailsResponse(
    quoteId: string,
    planId: number,
    packages: Array<{ groupType: number; label: string; hotels: Array<HotelSearchResult & { routeId: number }> }>,
    hotelsByRoute: Map<number, HotelSearchResult[]>,
    routes: any[],
    noOfNights: number,
  ): Promise<ItineraryHotelDetailsResponseDto> {
    // Build hotel tabs (one per package with total cost)
    const hotelTabs: ItineraryHotelTabDto[] = packages.map((pkg) => {
      const totalAmount = pkg.hotels.reduce((sum, h) => sum + h.price, 0);
      return {
        groupType: pkg.groupType,
        label: pkg.label,
        totalAmount,
      };
    });

    // Fetch all hotel details from database to get IDs and voucher status
    const hotelDetailsInDb = await this.prisma.dvi_itinerary_plan_hotel_details.findMany({
      where: { itinerary_plan_id: planId, deleted: 0 },
      select: {
        itinerary_plan_hotel_details_ID: true,
        itinerary_route_id: true,
        hotel_id: true,
        group_type: true,
      },
    });

    // Fetch voucher cancellation statuses
    const hotelDetailsIds = hotelDetailsInDb.map(h => h.itinerary_plan_hotel_details_ID);
    const voucherStatuses = hotelDetailsIds.length > 0
      ? await this.prisma.dvi_confirmed_itinerary_plan_hotel_voucher_details.findMany({
          where: {
            itinerary_plan_id: planId,
            itinerary_plan_hotel_details_ID: { in: hotelDetailsIds },
            deleted: 0,
          },
          select: {
            itinerary_plan_hotel_details_ID: true,
            hotel_voucher_cancellation_status: true,
          },
        })
      : [];

    // Create maps for quick lookup
    const detailsMap = new Map(
      hotelDetailsInDb.map(d => [
        `${d.itinerary_route_id}-${d.hotel_id}-${d.group_type}`,
        d.itinerary_plan_hotel_details_ID
      ])
    );
    
    const voucherStatusMap = new Map(
      voucherStatuses.map(v => [
        v.itinerary_plan_hotel_details_ID,
        v.hotel_voucher_cancellation_status === 1
      ])
    );

    // Build hotel rows (detail rows for each package)
    const hotelRows: ItineraryHotelRowDto[] = [];

    for (const pkg of packages) {
      for (const hotel of pkg.hotels) {
        // Find the route using the routeId attached to the hotel
        const route = routes.find((r: any) => r.itinerary_route_ID === hotel.routeId);
        if (!route) {
          this.logger.warn(`⚠️  Route ${hotel.routeId} not found for hotel ${hotel.hotelName}`);
          continue;
        }
        
        // Skip departure day (last route when routeIndex >= noOfNights)
        const routeIndex = routes.indexOf(route);
        const isLastRoute = routeIndex === routes.length - 1;
        if (isLastRoute && routeIndex >= noOfNights) {
          this.logger.log(`   ⏭️  Skipping route ${hotel.routeId} from response (departure day)`);
          continue;
        }
        
        // Use next_visiting_location (where you're staying) for destination display
        const destination = (route as any).next_visiting_location || (route as any).location_name || '';
        
        // Use actual hotel name from TBO API response
        const displayHotelName = hotel.hotelName;
        
        // Handle both TBO (numeric) and HOBSE (UUID string) hotel codes
        const hotelId = isNaN(parseInt(hotel.hotelCode)) ? 0 : parseInt(hotel.hotelCode);
        const routeId = (route as any).itinerary_route_ID;
        const dateLabel = new Date((route as any).itinerary_route_date).toISOString().split('T')[0];
        
        // Lookup hotel details ID and voucher status (only for TBO numeric IDs)
        const lookupKey = hotelId > 0 ? `${routeId}-${hotelId}-${pkg.groupType}` : '';
        const hotelDetailsId = lookupKey ? detailsMap.get(lookupKey) : undefined;
        const voucherCancelled = hotelDetailsId ? (voucherStatusMap.get(hotelDetailsId) || false) : false;

        hotelRows.push({
          groupType: pkg.groupType,
          itineraryRouteId: routeId,
          day: `Day ${routeIndex + 1} | ${dateLabel}`,
          destination: destination,
          hotelId: hotelId,
          hotelName: displayHotelName,
          category: hotel.rating ? parseInt(String(hotel.rating)) : 0,
          roomType: hotel.roomType || '',
          mealPlan: hotel.mealPlan || '-',
          totalHotelCost: Math.round(hotel.price),
          totalHotelTaxAmount: 0,
          searchReference: hotel.searchReference,
          bookingCode: hotel.hotelCode, // Use actual hotelCode (works for both TBO and HOBSE - can be numeric or UUID string)
          provider: hotel.provider || 'tbo',
          voucherCancelled: voucherCancelled,
          itineraryPlanHotelDetailsId: hotelDetailsId || 0,
          date: dateLabel,
        });

        // Log HOBSE hotel codes for debugging
        if (hotel.provider === 'HOBSE') {
          this.logger.debug(`✅ HOBSE Hotel Response: hotelCode="${hotel.hotelCode}", provider="${hotel.provider}"`);
        }
      }
    }

    return {
      quoteId,
      planId,
      hotelRatesVisible: true,
      hotelTabs,
      hotels: hotelRows,
      totalRoomCount: hotelRows.length,
    };
  }

  /**
   * Get fresh hotel room details from TBO API (no stale data)
   * Fetches real-time data and returns in room details format
   * Uses caching by route to minimize TBO API calls within a session
   * @param quoteId - The quote ID to fetch hotel rooms for
   * @param filterRouteId - Optional: Filter results to only this route ID
   */
  async getHotelRoomDetailsFromTbo(
    quoteId: string,
    filterRouteId?: number,
  ): Promise<ItineraryHotelRoomDetailsResponseDto> {
    const startTime = Date.now();
    this.logger.log(`\n📡 FRESH ROOM DETAILS FROM TBO: Fetching live data for quote: ${quoteId}`);
    if (filterRouteId) {
      this.logger.log(`🔍 Filtering to route ID: ${filterRouteId}`);
    }

    // ✅ CHECK CACHE FIRST (per-route caching)
    const cachedResult = this.getCachedRoomDetails(quoteId, filterRouteId);
    if (cachedResult) {
      return cachedResult;
    }

    // Step 1: Get itinerary plan
    const plan = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_quote_ID: quoteId, deleted: 0 },
    });

    if (!plan) {
      this.logger.warn(`⚠️  Quote ID not found: ${quoteId}`);
      throw new NotFoundException('Itinerary not found');
    }

    const planId = plan.itinerary_plan_ID;
    this.logger.log(`✅ Found plan ID: ${planId}`);

    // Step 2: Get itinerary routes (days and destinations)
    const routes = await this.prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: planId, deleted: 0 },
      orderBy: { itinerary_route_date: 'asc' },
    });

    if (routes.length === 0) {
      this.logger.warn(`⚠️  No routes found for plan ${planId}`);
      throw new BadRequestException('Itinerary has no routes');
    }

    const noOfNights = Number((plan as any).no_of_nights || 0);
    this.logger.log(`🌙 Plan has ${noOfNights} nights`);

    // Step 3: Fetch FRESH hotels from TBO
    // OPTIMIZATION: If filterRouteId provided, only fetch hotels for that specific route
    let routesToProcess = routes;
    if (filterRouteId) {
      routesToProcess = routes.filter(r => (r as any).itinerary_route_ID === filterRouteId);
      if (routesToProcess.length === 0) {
        this.logger.warn(`⚠️  Route ID ${filterRouteId} not found`);
        throw new BadRequestException(`Route ID ${filterRouteId} not found in this itinerary`);
      }
      this.logger.log(`✅ Optimized: Fetching hotels for 1 route only (filtered)`);
    }

    const hotelsByRoute = await this.fetchHotelsForRoutes(routesToProcess, noOfNights);

    // Step 4: Transform fresh TBO data into room details format
    const roomDetailsList: ItineraryHotelRoomDto[] = [];
    let roomDetailsId = 1;

    // Create a map to track unique hotels per route
    const hotelsByRouteAndGroup = new Map<string, any[]>();

    // Group hotels by route and hotelCode
    hotelsByRoute.forEach((hotelsForRoute, routeId) => {
      // FILTER: Only process this route if filterRouteId is not provided OR if it matches
      if (filterRouteId && routeId !== filterRouteId) {
        this.logger.debug(`🔍 Skipping route ${routeId} (filter: ${filterRouteId})`);
        return;
      }

      // ✅ Extract all prices for this route to calculate quartiles
      const allPrices = hotelsForRoute.map((h: HotelSearchResult) => h.price || 0);

      hotelsForRoute.forEach((hotel: HotelSearchResult) => {
        // ✅ Assign groupType based on PRICE QUARTILE, not array position
        const hotelPrice = hotel.price || 0;
        const groupType = this.getGroupTypeFromPrice(hotelPrice, allPrices);
        const key = `${routeId}-${hotel.hotelCode || hotel.hotelName}`;
        
        if (!hotelsByRouteAndGroup.has(key)) {
          hotelsByRouteAndGroup.set(key, []);
        }
        hotelsByRouteAndGroup.get(key)!.push({ ...hotel, groupType });
      });
    });

    // Build room entries from fresh TBO data
    // ✅ FIXED: Iterate through ALL hotels in each group, not just the first one
    hotelsByRouteAndGroup.forEach((hotelArray, _key) => {
      const routeId = parseInt(_key.split('-')[0]);
      const route = routes.find(r => (r as any).itinerary_route_ID === routeId);

      // ✅ Loop through ALL unique hotels in this route/group (not just first)
      hotelArray.forEach((hotel: any) => {
        // ✅ FIXED: Use actual room type from TBO, not groupType
        const firstRoomType = hotel.roomTypes?.[0];
        const actualRoomTypeId = firstRoomType?.roomTypeId || 1;
        const actualRoomTypeName = firstRoomType?.roomName || 'Standard Room';

        roomDetailsList.push({
          itineraryPlanId: planId,
          itineraryRouteId: routeId,
          itineraryPlanHotelRoomDetailsId: roomDetailsId++,
          hotelId: parseInt(hotel.hotelCode) || 0,
          hotelName: hotel.hotelName || 'Hotel',
          hotelCategory: this.getCategoryFromRating(hotel.category || hotel.rating),
          groupType: hotel.groupType || 1, // ✅ ADD: Include groupType (tier: 1-4)
          roomTypeId: actualRoomTypeId, // ✅ FIXED: Use actual TBO room type ID
          roomTypeName: actualRoomTypeName, // ✅ FIXED: Use actual TBO room type name
          roomId: parseInt(hotel.hotelCode) || 0,
          availableRoomTypes: (hotel.roomTypes || []).map((rt, idx) => ({
            roomTypeId: rt.roomTypeId || idx + 1,
            roomTypeTitle: rt.roomName,
          })),
          pricePerNight: Number(hotel.price || 0),
          numberOfNights: noOfNights,
          totalPrice: Number(hotel.price || 0) * noOfNights,
          currency: hotel.currency || 'INR',
          mealPlan: hotel.mealPlan || 'Not Specified',
        } as any);
      });
    });

    const duration = Date.now() - startTime;
    this.logger.log(`✅ FRESH ROOM DETAILS GENERATED`);
    this.logger.log(`📊 Room Entries: ${roomDetailsList.length}`);
    if (filterRouteId) {
      this.logger.log(`🔍 Filter Applied: Route ID ${filterRouteId}`);
    } else {
      this.logger.log(`📅 All Routes Included`);
    }
    this.logger.log(`⏱️  Duration: ${duration}ms\n`);

    const result = {
      quoteId: (plan as any).itinerary_quote_ID ?? '',
      planId,
      rooms: roomDetailsList,
    };

    // ✅ CACHE THE RESULT for future requests
    this.setCachedRoomDetails(quoteId, result, filterRouteId);

    return result;
  }

  /**
   * Determine group type (price tier) based on hotel price relative to all hotels
   * Distributes hotels across 4 tiers: Budget (1), Mid-Range (2), Premium (3), Luxury (4)
   */
  private getGroupTypeFromPrice(
    hotelPrice: number,
    allPrices: number[]
  ): number {
    if (allPrices.length === 0) return 1;
    if (allPrices.length === 1) return 1;

    // Sort prices to find quartiles
    const sortedPrices = [...allPrices].sort((a, b) => a - b);
    
    // Calculate quartile boundaries
    const q1 = sortedPrices[Math.floor(sortedPrices.length * 0.25)];
    const q2 = sortedPrices[Math.floor(sortedPrices.length * 0.50)];
    const q3 = sortedPrices[Math.floor(sortedPrices.length * 0.75)];

    // Assign tier based on price quartile
    if (hotelPrice <= q1) return 1; // Budget (bottom 25%)
    if (hotelPrice <= q2) return 2; // Mid-Range (25-50%)
    if (hotelPrice <= q3) return 3; // Premium (50-75%)
    return 4; // Luxury (top 25%)
  }

  /**
   * Convert rating/category string to numeric category (1-4)
   */
  private getCategoryFromRating(ratingOrCategory: string | number | undefined): number {
    if (!ratingOrCategory) return 2; // Default to Mid-Range
    
    const val = typeof ratingOrCategory === 'string' 
      ? parseInt(ratingOrCategory)
      : ratingOrCategory;
    
    if (val >= 5 || val === 4) return 4; // Luxury (5-star)
    if (val === 3) return 3; // Premium (3-star equivalent)
    if (val === 2) return 2; // Mid-Range (2-star)
    return 1; // Budget
  }

  /**
   * Generate cache key for hotel room details
   * Format: "quoteId" or "quoteId:routeId" if filtered
   */
  private getCacheKey(quoteId: string, routeId?: number): string {
    if (routeId) {
      return `${quoteId}:${routeId}`;
    }
    return quoteId;
  }

  /**
   * Get cached hotel room details if available
   */
  private getCachedRoomDetails(quoteId: string, routeId?: number): ItineraryHotelRoomDetailsResponseDto | null {
    const cacheKey = this.getCacheKey(quoteId, routeId);
    const cached = this.hotelRoomDetailsCache.get(cacheKey);
    
    if (cached) {
      this.logger.log(`💾 [CACHE HIT] Using cached data for ${cacheKey}`);
      return cached.data;
    }
    
    return null;
  }

  /**
   * Store hotel room details in cache
   */
  private setCachedRoomDetails(
    quoteId: string,
    data: ItineraryHotelRoomDetailsResponseDto,
    routeId?: number,
  ): void {
    const cacheKey = this.getCacheKey(quoteId, routeId);
    this.hotelRoomDetailsCache.set(cacheKey, {
      data,
      timestamp: Date.now(),
    });
    this.logger.log(`💾 [CACHE SET] Cached data for ${cacheKey}`);
  }

  /**
   * Clear cache for a specific quote (called on refresh/update)
   * Clears both general cache (quoteId) and route-specific caches (quoteId:routeId)
   */
  clearCacheForQuote(quoteId: string): void {
    const keysToDelete: string[] = [];
    
    for (const key of this.hotelRoomDetailsCache.keys()) {
      if (key.startsWith(`${quoteId}:`)) { // Matches "quoteId:routeId"
        keysToDelete.push(key);
      }
    }
    
    // Also delete the base key
    keysToDelete.push(quoteId);
    
    for (const key of keysToDelete) {
      this.hotelRoomDetailsCache.delete(key);
      this.logger.log(`🗑️  [CACHE CLEARED] Removed cache for ${key}`);
    }
  }

  /**
   * Get current cache size and stats (for debugging)
   */
  getCacheStats(): { size: number; entries: string[] } {
    return {
      size: this.hotelRoomDetailsCache.size,
      entries: Array.from(this.hotelRoomDetailsCache.keys()),
    };
  }
}

