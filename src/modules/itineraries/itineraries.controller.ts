// FILE: src/itineraries/itineraries.controller.ts
// ✅ Fixes Prisma error by:
// 1) Moving @Get(':id') to the VERY END (so it won’t swallow /customer-info, /confirmed, etc.)
// 2) Enforcing numeric :id with ParseIntPipe (so "confirmed" never becomes NaN)
// 3) Importing Request type correctly (your file used Request without import)
import { TourDetailsResponseDto } from './dto/tour-details.response.dto';
import {
  Body,
  Controller,
  Param,
  Post,
  Get,
  Patch,
  Query,
  Req,
  Delete,
  Res,
  ParseIntPipe,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiBody,
  ApiExtraModels,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiBearerAuth,
  ApiParam,
  ApiOkResponse,
} from '@nestjs/swagger';
import {
  CreateItineraryDto,
  CreatePlanDto,
  CreateRouteDto,
  CreateTravellerDto,
  CreateVehicleDto,
} from './dto/create-itinerary.dto';
import { LatestItineraryQueryDto } from './dto/latest-itinerary-query.dto';
import { ConfirmQuotationDto } from './dto/confirm-quotation.dto';
import { CancelItineraryDto } from './dto/cancel-itinerary.dto';
import {
  GetHotelRoomCategoriesDto,
  UpdateRoomCategoryDto,
  HotelRoomCategoriesListResponseDto,
} from './dto/hotel-room-selection.dto';
import { ItinerariesService } from './itineraries.service';
import { ItineraryDetailsService } from './itinerary-details.service';
import {
  ItineraryHotelDetailsResponseDto,
  ItineraryHotelRoomDetailsResponseDto,
} from './itinerary-hotel-details.service';
import { ItineraryHotelDetailsService } from './itinerary-hotel-details.service';
import { ItineraryHotelDetailsTboService } from './itinerary-hotel-details-tbo.service';
import { ItineraryExportService } from './itinerary-export.service';
import { HotelVoucherService, AddCancellationPolicyDto, CreateVoucherDto } from './hotel-voucher.service';
import { Public } from '../../auth/public.decorator';
import { Response, Request } from 'express';
import { RouteSuggestionsService } from './route-suggestions.service';
import { RouteSuggestionsV2Service } from './route-suggestions-v2.service';

@ApiTags('Itineraries')
@ApiBearerAuth()
@ApiExtraModels(
  CreateItineraryDto,
  CreatePlanDto,
  CreateRouteDto,
  CreateVehicleDto,
  CreateTravellerDto,
)
@Controller('itineraries')
export class ItinerariesController {
  private logger = new Logger('ItinerariesController');

  constructor(
    private readonly svc: ItinerariesService,
    private readonly detailsService: ItineraryDetailsService,
    private readonly hotelDetailsService: ItineraryHotelDetailsService,
    private readonly hotelDetailsTboService: ItineraryHotelDetailsTboService,
    private readonly exportService: ItineraryExportService,
    private readonly routeSuggestionsService: RouteSuggestionsService,
    private readonly routeSuggestionsV2Service: RouteSuggestionsV2Service,
    private readonly hotelVoucherService: HotelVoucherService,
  ) {}

  @Post()
  @ApiOperation({
    summary:
      'Create OR Update plan + routes + vehicles + travellers (NO hotspots yet). Use plan.itinerary_plan_id for update.',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    description: 'Optional: "itineary_basic_info_with_optimized_route" to optimize route order before saving',
    example: 'itineary_basic_info_with_optimized_route',
    type: String,
  })
  @ApiBody({
    type: CreateItineraryDto,
    examples: {
      create: {
        summary: 'Create (no ids)',
        value: {
          plan: {
            agent_id: 126,
            staff_id: 0,
            location_id: 0,
            arrival_point: 'Chennai International Airport',
            departure_point: 'Pondicherry',
            itinerary_preference: 3,
            itinerary_type: 2,
            preferred_hotel_category: [13],
            hotel_facilities: ['24hr-business-center', '24hr-checkin'],
            trip_start_date: '2025-11-29T12:00:00+05:30',
            trip_end_date: '2025-12-01T12:00:00+05:30',
            pick_up_date_and_time: '2025-11-29T12:00:00+05:30',
            arrival_type: 1,
            departure_type: 1,
            no_of_nights: 2,
            no_of_days: 3,
            budget: 15000,
            entry_ticket_required: 0,
            guide_for_itinerary: 0,
            nationality: 101,
            food_type: 1,
            adult_count: 2,
            child_count: 0,
            infant_count: 0,
            special_instructions: '',
          },
          routes: [
            {
              location_name: 'Chennai International Airport',
              next_visiting_location: 'Chennai',
              itinerary_route_date: '2025-11-29T00:00:00+05:30',
              no_of_days: 1,
              no_of_km: '',
              direct_to_next_visiting_place: 1,
              via_route: '',
              via_routes: [
                {
                  itinerary_via_location_ID: 101,
                  itinerary_via_location_name: 'Mahabalipuram',
                },
              ],
            },
            {
              location_name: 'Chennai',
              next_visiting_location: 'Pondicherry',
              itinerary_route_date: '2025-11-30T00:00:00+05:30',
              no_of_days: 2,
              no_of_km: '',
              direct_to_next_visiting_place: 1,
              via_route: '',
            },
            {
              location_name: 'Pondicherry',
              next_visiting_location: 'Pondicherry',
              itinerary_route_date: '2025-12-01T00:00:00+05:30',
              no_of_days: 3,
              no_of_km: '',
              direct_to_next_visiting_place: 1,
              via_route: '',
            },
          ],
          vehicles: [{ vehicle_type_id: 20, vehicle_count: 1 }],
          travellers: [
            { room_id: 1, traveller_type: 1 },
            { room_id: 1, traveller_type: 1 },
          ],
        },
      },

      update: {
        summary:
          'Update (PHP-like hidden IDs): plan.itinerary_plan_id + routes[].itinerary_route_id + vehicles[].vehicle_details_id',
        value: {
          plan: {
            itinerary_plan_id: 28230, // <-- UPDATE EXISTING PLAN
            agent_id: 126,
            staff_id: 0,
            location_id: 0,
            arrival_point: 'Chennai International Airport',
            departure_point: 'Pondicherry',
            itinerary_preference: 3,
            itinerary_type: 2,
            preferred_hotel_category: [13],
            hotel_facilities: ['24hr-business-center', '24hr-checkin'],
            trip_start_date: '2025-11-29T12:00:00+05:30',
            trip_end_date: '2025-12-01T12:00:00+05:30',
            pick_up_date_and_time: '2025-11-29T12:00:00+05:30',
            arrival_type: 1,
            departure_type: 1,
            no_of_nights: 2,
            no_of_days: 3,
            budget: 15000,
            entry_ticket_required: 0,
            guide_for_itinerary: 0,
            nationality: 101,
            food_type: 1,
            adult_count: 2,
            child_count: 0,
            infant_count: 0,
            special_instructions: '',
          },
          routes: [
            {
              itinerary_route_id: 19, // <-- UPDATE EXISTING ROUTE
              location_name: 'Chennai International Airport',
              next_visiting_location: 'Chennai',
              itinerary_route_date: '2025-11-29T00:00:00+05:30',
              no_of_days: 1,
              no_of_km: '',
              direct_to_next_visiting_place: 1,
              via_route: '',
              via_routes: [
                {
                  itinerary_via_location_ID: 101,
                  itinerary_via_location_name: 'Mahabalipuram',
                },
              ],
            },
            {
              itinerary_route_id: 20, // <-- UPDATE EXISTING ROUTE
              location_name: 'Chennai',
              next_visiting_location: 'Pondicherry',
              itinerary_route_date: '2025-11-30T00:00:00+05:30',
              no_of_days: 2,
              no_of_km: '',
              direct_to_next_visiting_place: 1,
              via_route: '',
            },
            {
              itinerary_route_id: 21, // <-- UPDATE EXISTING ROUTE
              location_name: 'Pondicherry',
              next_visiting_location: 'Pondicherry',
              itinerary_route_date: '2025-12-01T00:00:00+05:30',
              no_of_days: 3,
              no_of_km: '',
              direct_to_next_visiting_place: 1,
              via_route: '',
            },
          ],
          vehicles: [
            {
              vehicle_details_id: 19879, // <-- UPDATE EXISTING VEHICLE ROW
              vehicle_type_id: 1,
              vehicle_count: 1,
            },
          ],
          travellers: [
            { room_id: 1, traveller_type: 1 },
            { room_id: 1, traveller_type: 1 },
          ],
        },
      },
    },
  })
  async createPlan(
    @Body() dto: CreateItineraryDto,
    @Query('type') type?: string,
    @Req() req?: Request,
  ) {
    // Check if route optimization is requested
    const shouldOptimizeRoute = type === 'itineary_basic_info_with_optimized_route';
    return this.svc.createPlan(dto, req, shouldOptimizeRoute);
  }
@Get('details/:quoteId')
@Public()
@ApiOperation({
  summary: 'Get full itinerary details by Quote ID',
  description:
    'Returns PHP-like consolidated itinerary details (plan, routes, vehicles, hotspots, hotels, costs, etc.) for a given Quote ID.',
})
@ApiParam({
  name: 'quoteId',
  required: true,
  description: 'Quote ID generated for the itinerary',
  example: 'DVI202512032',
  schema: { type: 'string', default: 'DVI202512032' },
})
@ApiQuery({
  name: 'groupType',
  required: false,
  description: 'Optional filter for hotel recommendation category (1-4)',
  example: 4,
  type: Number,
})
@ApiOkResponse({ description: 'Full itinerary details for the given quoteId' })
async getItineraryDetails(
  @Param('quoteId') quoteId: string,
  @Query('groupType') groupType?: string,
) {
  const groupTypeNum = groupType !== undefined ? Number(groupType) : undefined;
  return this.detailsService.getItineraryDetails(quoteId, groupTypeNum);
}

@Get('tour-details/:quoteId')
@Public()
@ApiOperation({
  summary: 'Get tour header details by Quote ID',
  description:
    'Returns top-level Tour Itinerary Plan details (start/end, nights/days, pax, room count, nationality, entry ticket required).',
})
@ApiParam({
  name: 'quoteId',
  required: true,
  example: 'DVI2026021007',
})
@ApiOkResponse({ description: 'Tour details for the given quoteId', type: TourDetailsResponseDto })
async getTourDetails(@Param('quoteId') quoteId: string) {
  return this.detailsService.getTourDetails(quoteId);
}

  @Get('hotel_details/:quoteId')
  @ApiOperation({
    summary: 'Get dynamic hotel packages from TBO API',
    description:
      'Fetches itinerary dates/destinations and generates 4 hotel packages from TBO in real-time. Returns Budget, Mid-Range, Premium, and Luxury options.',
  })
  @ApiParam({
    name: 'quoteId',
    required: true,
    description: 'Quote ID generated for the itinerary',
    example: 'DVI202512032',
  })
  @ApiOkResponse({ description: 'Dynamic hotel packages from TBO API' })
  @Public()
  async getItineraryHotelDetails(
    @Param('quoteId') quoteId: string,
  ): Promise<ItineraryHotelDetailsResponseDto> {
    const startTime = Date.now();
    this.logger.log('\n════════════════════════════════════════════════════════════════════════════════════════');
    this.logger.log('🏨 INCOMING ITINERARY HOTEL DETAILS REQUEST (TBO)');
    this.logger.log(`📍 Request Timestamp: ${new Date().toISOString()}`);
    this.logger.log(`📋 Quote ID: ${quoteId}`);
    this.logger.log('────────────────────────────────────────────────────────────────────────────────────────');

    try {
      // Use TBO service to fetch dynamic packages
      const result = await this.hotelDetailsService.getHotelDetailsByQuoteId(quoteId);
      const duration = Date.now() - startTime;

      this.logger.log('\n✅ HOTEL PACKAGES GENERATED FROM TBO');
      this.logger.log(`📊 Hotel Tabs: ${result.hotelTabs?.length || 0} packages`);
      this.logger.log(`📊 Hotel Rows: ${result.hotels?.length || 0} total hotels`);
      this.logger.log(`⏱️  Total Duration: ${duration}ms`);
      this.logger.log('════════════════════════════════════════════════════════════════════════════════════════\n');

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('\n❌ HOTEL PACKAGES GENERATION FAILED');
      this.logger.error(`🚨 Error Message: ${errorMessage}`);
      this.logger.error(`⏱️  Duration: ${duration}ms`);
      this.logger.log('════════════════════════════════════════════════════════════════════════════════════════\n');
      throw error;
    }
  }

  @Get('hotel_room_details/:quoteId')
  @ApiOperation({
    summary: 'Get hotel ROOM details for an itinerary by Quote ID',
    description:
      'Returns FRESH hotel room details from TBO API in real-time (no stale data). Structured per route / hotel / room / roomType. Optionally filter by specific itinerary route.',
  })
  @ApiParam({
    name: 'quoteId',
    required: true,
    description: 'Quote ID generated for the itinerary',
    example: 'DVI202512032',
  })
  @ApiQuery({
    name: 'itineraryRouteId',
    required: false,
    description: 'Optional: Filter rooms for a specific itinerary route/day',
    example: '12345',
    type: 'integer',
  })
  @ApiQuery({
    name: 'clearCache',
    required: false,
    description: 'Optional: Clear backend memory cache before fetching fresh data from TBO',
    example: 'true',
    type: 'boolean',
  })
  @ApiOkResponse({ description: 'Fresh hotel room details from TBO API' })
  @Public()
  async getItineraryHotelRoomDetails(
    @Param('quoteId') quoteId: string,
    @Query('itineraryRouteId') itineraryRouteId?: string,
    @Query('clearCache') clearCache?: string,
  ): Promise<ItineraryHotelRoomDetailsResponseDto> {
    const startTime = Date.now();
    this.logger.log('\n════════════════════════════════════════════════════════════════════════════════════════');
    this.logger.log('🏨 INCOMING ITINERARY HOTEL ROOM DETAILS REQUEST (TBO - FRESH DATA)');
    this.logger.log(`📍 Request Timestamp: ${new Date().toISOString()}`);
    this.logger.log(`📋 Quote ID: ${quoteId}`);
    if (itineraryRouteId) {
      this.logger.log(`🔍 Filter Route ID: ${itineraryRouteId}`);
    }
    if (clearCache === 'true') {
      this.logger.log(`🗑️  Clear Cache Requested: YES`);
    }
    this.logger.log('────────────────────────────────────────────────────────────────────────────────────────');

    try {
      // ✅ Clear backend memory cache if requested
      if (clearCache === 'true') {
        this.hotelDetailsTboService.clearCacheForQuote(quoteId);
        this.logger.log('🗑️  Backend cache cleared - will fetch fresh data from TBO');
      }
      
      // Use TBO service to fetch FRESH room details (no stale data)
      // Pass optional itineraryRouteId to filter results
      const routeIdNum = itineraryRouteId ? parseInt(itineraryRouteId, 10) : undefined;
      const result = await this.hotelDetailsTboService.getHotelRoomDetailsFromTbo(
        quoteId,
        routeIdNum,
      );
      const duration = Date.now() - startTime;

      this.logger.log('\n✅ FRESH ROOM DETAILS GENERATED FROM TBO');
      this.logger.log(`📊 Room Entries: ${result.rooms?.length || 0}`);
      this.logger.log(`⏱️  Total Duration: ${duration}ms`);
      this.logger.log('════════════════════════════════════════════════════════════════════════════════════════\n');

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('\n❌ FRESH ROOM DETAILS GENERATION FAILED');
      this.logger.error(`🚨 Error Message: ${errorMessage}`);
      this.logger.error(`⏱️  Duration: ${duration}ms`);
      this.logger.log('════════════════════════════════════════════════════════════════════════════════════════\n');
      throw error;
    }
  }

  @Get('latest')
  @ApiOperation({ summary: 'Latest itineraries datatable' })
  async latest(@Query() q: LatestItineraryQueryDto, @Req() req: Request) {
    return this.detailsService.getLatestItinerariesDataTable(q, req);
  }

  @Get('latest/agents')
  @ApiOperation({ summary: 'Get agents for latest itineraries filter' })
  async getLatestAgents(@Req() req: Request) {
    return this.svc.getAgentsForFilter(req);
  }

  @Get('latest/locations')
  @ApiOperation({ summary: 'Get origin/destination locations from latest itineraries' })
  async getLatestLocations() {
    return this.svc.getLocationsForLatestFilter();
  }

  @Delete('hotspot/:planId/:routeId/:hotspotId')
  @ApiOperation({ summary: 'Delete a hotspot from an itinerary route' })
  @ApiParam({ name: 'planId', example: 17940, description: 'Itinerary Plan ID' })
  @ApiParam({ name: 'routeId', example: 1, description: 'Route ID' })
  @ApiParam({ name: 'hotspotId', example: 123, description: 'Route Hotspot ID' })
  @ApiOkResponse({ description: 'Hotspot deleted successfully' })
  async deleteHotspot(
    @Param('planId') planId: string,
    @Param('routeId') routeId: string,
    @Param('hotspotId') hotspotId: string,
  ) {
    return this.svc.deleteHotspot(
      Number(planId),
      Number(routeId),
      Number(hotspotId),
    );
  }

  @Post('default-route-suggestions')
  @Public()
  @ApiOperation({
    summary:
      'Get default route suggestions based on arrival/departure locations and travel dates',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        _no_of_route_days: {
          type: 'number',
          example: 4,
          description: 'Number of route days',
        },
        _arrival_location: {
          type: 'string',
          example: 'Chennai International Airport',
          description: 'Arrival location name',
        },
        _departure_location: {
          type: 'string',
          example: 'Chennai International Airport',
          description: 'Departure location name',
        },
        _formattedStartDate: {
          type: 'string',
          example: '06-01-2026',
          description: 'Start date in d-m-Y format',
        },
        _formattedEndDate: {
          type: 'string',
          example: '09-01-2026',
          description: 'End date in d-m-Y format',
        },
      },
      required: [
        '_no_of_route_days',
        '_arrival_location',
        '_departure_location',
        '_formattedStartDate',
        '_formattedEndDate',
      ],
    },
  })
  async getDefaultRouteSuggestions(@Body() body: any) {
    return this.routeSuggestionsService.getDefaultRouteSuggestions(
      body._no_of_route_days,
      body._arrival_location,
      body._departure_location,
      body._formattedStartDate,
      body._formattedEndDate,
    );
  }

  @Post('default-route-suggestions/v2')
  @Public()
  @ApiOperation({
    summary: 'Get default route suggestions with minimal JSON data (recommended)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        _no_of_route_days: {
          type: 'number',
          example: 5,
          description: 'Number of route days',
        },
        _arrival_location: {
          type: 'string',
          example: 'Chennai International Airport',
          description: 'Arrival location name',
        },
        _departure_location: {
          type: 'string',
          example: 'Madurai Airport',
          description: 'Departure location name',
        },
        _formattedStartDate: {
          type: 'string',
          example: '06-01-2026',
          description: 'Start date in d-m-Y format',
        },
        _formattedEndDate: {
          type: 'string',
          example: '10-01-2026',
          description: 'End date in d-m-Y format',
        },
      },
      required: [
        '_no_of_route_days',
        '_arrival_location',
        '_departure_location',
        '_formattedStartDate',
        '_formattedEndDate',
      ],
    },
  })
  async getDefaultRouteSuggestionsV2(@Body() body: any) {
    return this.routeSuggestionsV2Service.getDefaultRouteSuggestions(
      body._no_of_route_days,
      body._arrival_location,
      body._departure_location,
      body._formattedStartDate,
      body._formattedEndDate,
    );
  }

  @Get('activities/available/:hotspotId')
  @ApiOperation({ summary: 'Get available activities for a hotspot location' })
  @ApiParam({
    name: 'hotspotId',
    example: 123,
    description: 'Hotspot Location ID',
  })
  @ApiOkResponse({ description: 'List of available activities' })
  async getAvailableActivities(@Param('hotspotId') hotspotId: string) {
    return this.svc.getAvailableActivities(Number(hotspotId));
  }

  @Post('activities/preview')
  @ApiOperation({ summary: 'Preview activity addition to check for timing conflicts' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        planId: { type: 'number', example: 17940 },
        routeId: { type: 'number', example: 1 },
        routeHotspotId: { type: 'number', example: 123 },
        hotspotId: { type: 'number', example: 35 },
        activityId: { type: 'number', example: 180 },
      },
      required: ['planId', 'routeId', 'routeHotspotId', 'hotspotId', 'activityId'],
    },
  })
  @ApiOkResponse({ description: 'Activity preview with conflict information' })
  async previewActivityAddition(@Body() body: any) {
    return this.svc.previewActivityAddition(body);
  }

  @Post('activities/add')
  @ApiOperation({ summary: 'Add an activity to a hotspot in the itinerary' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        planId: { type: 'number', example: 17940 },
        routeId: { type: 'number', example: 1 },
        routeHotspotId: { type: 'number', example: 123 },
        hotspotId: { type: 'number', example: 456 },
        activityId: { type: 'number', example: 789 },
        amount: { type: 'number', example: 500 },
        startTime: { type: 'string', example: '10:00:00', nullable: true },
        endTime: { type: 'string', example: '11:00:00', nullable: true },
        duration: { type: 'string', example: '01:00:00', nullable: true },
        skipConflictCheck: { type: 'boolean', example: false, nullable: true },
      },
      required: ['planId', 'routeId', 'routeHotspotId', 'hotspotId', 'activityId'],
    },
  })
  @ApiOkResponse({ description: 'Activity added successfully' })
  async addActivity(@Body() body: any) {
    return this.svc.addActivity(body);
  }

  @Delete('activities/:planId/:routeId/:activityId')
  @ApiOperation({ summary: 'Delete an activity from an itinerary route' })
  @ApiParam({ name: 'planId', example: 17940, description: 'Itinerary Plan ID' })
  @ApiParam({ name: 'routeId', example: 1, description: 'Route ID' })
  @ApiParam({
    name: 'activityId',
    example: 123,
    description: 'Route Activity ID',
  })
  @ApiOkResponse({ description: 'Activity deleted successfully' })
  async deleteActivity(
    @Param('planId') planId: string,
    @Param('routeId') routeId: string,
    @Param('activityId') activityId: string,
  ) {
    return this.svc.deleteActivity(
      Number(planId),
      Number(routeId),
      Number(activityId),
    );
  }

  @Get('hotspots/available/:routeId')
  @ApiOperation({ summary: 'Get available hotspots for a route' })
  @ApiParam({ name: 'routeId', example: 123, description: 'Route ID' })
  @ApiOkResponse({ description: 'List of available hotspots' })
  async getAvailableHotspots(@Param('routeId') routeId: string) {
    return this.svc.getAvailableHotspots(Number(routeId));
  }

  @Post('hotspots/add')
  @ApiOperation({ summary: 'Add a hotspot to an itinerary route' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        planId: { type: 'number', example: 17940 },
        routeId: { type: 'number', example: 1 },
        hotspotId: { type: 'number', example: 456 },
      },
      required: ['planId', 'routeId', 'hotspotId'],
    },
  })
  @ApiOkResponse({ description: 'Hotspot added successfully' })
  async addHotspot(@Body() body: any) {
    return this.svc.addHotspot(body);
  }

  @Post('hotspots/preview-add')
  @ApiOperation({ summary: 'Preview adding a hotspot to an itinerary route' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        planId: { type: 'number', example: 17940 },
        routeId: { type: 'number', example: 1 },
        hotspotId: { type: 'number', example: 456 },
      },
      required: ['planId', 'routeId', 'hotspotId'],
    },
  })
  @ApiOkResponse({ description: 'Preview data for adding hotspot' })
  async previewAddHotspot(@Body() body: any) {
    return this.svc.previewAddHotspot(body);
  }

  @Get('hotels/available/:routeId')
  @ApiOperation({ summary: 'Get available hotels for a route' })
  @ApiParam({ name: 'routeId', example: 1, description: 'Route ID' })
  @ApiOkResponse({ description: 'List of available hotels' })
  async getAvailableHotels(@Param('routeId') routeId: string) {
    return this.svc.getAvailableHotels(Number(routeId));
  }

  @Post('hotels/select')
  @ApiOperation({ summary: 'Select/update hotel for a route' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        planId: { type: 'number', example: 17940 },
        routeId: { type: 'number', example: 1 },
        hotelId: { type: 'number', example: 123 },
        roomTypeId: { type: 'number', example: 456 },
        groupType: { type: 'number', example: 2, description: '1=Budget, 2=Mid-Range, 3=Premium, 4=Luxury' },
        mealPlan: {
          type: 'object',
          properties: {
            all: { type: 'boolean' },
            breakfast: { type: 'boolean' },
            lunch: { type: 'boolean' },
            dinner: { type: 'boolean' },
          },
        },
      },
      required: ['planId', 'routeId', 'hotelId', 'roomTypeId'],
    },
  })
  @ApiOkResponse({ description: 'Hotel selected successfully' })
  async selectHotel(@Body() body: any) {
    return this.svc.selectHotel(body);
  }

  @Post('hotels/bulk-save')
  @ApiOperation({ summary: 'Save multiple hotel selections at once before confirming itinerary' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        planId: { type: 'number', example: 3 },
        hotels: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              routeId: { type: 'number', example: 89 },
              hotelId: { type: 'number', example: 1089687 },
              roomTypeId: { type: 'number', example: 1 },
              groupType: { type: 'number', example: 1, description: '1=Budget, 2=Mid-Range, 3=Premium, 4=Luxury' },
              mealPlan: {
                type: 'object',
                properties: {
                  all: { type: 'boolean' },
                  breakfast: { type: 'boolean' },
                  lunch: { type: 'boolean' },
                  dinner: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
      required: ['planId', 'hotels'],
    },
  })
  @ApiOkResponse({ description: 'All hotels saved successfully' })
  async bulkSaveHotels(@Body() body: { planId: number; hotels: any[] }) {
    return this.svc.bulkSaveHotels(body.planId, body.hotels);
  }

  @Post('vehicles/select-vendor')
  @ApiOperation({ summary: 'Select/update vehicle vendor for a vehicle type' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        planId: { type: 'number', example: 17940 },
        vehicleTypeId: { type: 'number', example: 1 },
        vendorEligibleId: { type: 'number', example: 123 },
      },
      required: ['planId', 'vehicleTypeId', 'vendorEligibleId'],
    },
  })
  @ApiOkResponse({ description: 'Vehicle vendor selected successfully' })
  async selectVehicleVendor(@Body() body: any) {
    return this.svc.selectVehicleVendor(body);
  }

  @Get('edit/:id')
  @ApiOperation({ summary: 'Get itinerary raw plan data for editing' })
  @ApiParam({ name: 'id', example: 17940, description: 'Itinerary Plan ID' })
  @ApiOkResponse({
    description: 'Returns plan, routes, and vehicles for editing in the form',
  })
  async getPlanForEdit(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getPlanForEdit(id);
  }

  @Get('export/:id')
  @Public()
  @ApiOperation({ summary: 'Export itinerary to Excel' })
  @ApiParam({ name: 'id', example: 14, description: 'Itinerary Plan ID' })
  async exportToExcel(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ) {
    const workbook = await this.exportService.exportItineraryToExcel(id);

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="ITINERARY-DVI${id}.xlsx"`,
    );

    await workbook.xlsx.write(res);
    res.end();
  }

  @Get('customer-info/:planId')
  @ApiOperation({ summary: 'Get customer info form data for confirm quotation' })
  @ApiParam({ name: 'planId', example: 12, description: 'Itinerary Plan ID' })
  @ApiOkResponse({
    description: 'Returns quotation number, agent name, and wallet balance',
  })
  async getCustomerInfoForm(@Param('planId', ParseIntPipe) planId: number) {
    return this.svc.getCustomerInfoForm(planId);
  }

  @Get('wallet-balance/:agentId')
  @ApiOperation({ summary: 'Check agent wallet balance' })
  @ApiParam({ name: 'agentId', example: 3, description: 'Agent ID' })
  @ApiOkResponse({ description: 'Returns agent wallet balance and sufficiency status' })
  async checkWalletBalance(@Param('agentId', ParseIntPipe) agentId: number) {
    return this.svc.checkWalletBalance(agentId);
  }

  @Public()
  @Post('confirm-quotation')
  @ApiOperation({ summary: 'Confirm quotation with guest details and optional TBO hotel bookings' })
  @ApiBody({ type: ConfirmQuotationDto })
  @ApiOkResponse({ description: 'Quotation confirmed successfully' })
  async confirmQuotation(@Body() dto: ConfirmQuotationDto, @Req() req: Request) {
    const baseResult = await this.svc.confirmQuotation(dto);
    
    // If hotel bookings are selected, process bookings outside the transaction
    if (dto.hotel_bookings && dto.hotel_bookings.length > 0) {
      const clientIp = (req.ip || req.headers['x-forwarded-for'] || '192.168.1.1') as string;
      return await this.svc.processConfirmationWithTboBookings(
        baseResult,
        dto,
        clientIp,
      );
    }
    
    return baseResult;
  }

  @Post('cancel')
  @ApiOperation({ summary: 'Cancel a confirmed itinerary' })
  @ApiBody({ type: CancelItineraryDto })
  @ApiOkResponse({ description: 'Itinerary cancelled successfully' })
  async cancelItinerary(@Body() dto: CancelItineraryDto) {
    return this.svc.cancelItinerary(dto);
  }

  @Get('confirmed')
  @ApiOperation({
    summary: 'Get confirmed itineraries list with pagination and filters',
  })
  @ApiQuery({ type: LatestItineraryQueryDto })
  async getConfirmedItineraries(
    @Query() query: LatestItineraryQueryDto,
    @Req() req: Request,
  ) {
    return this.svc.getConfirmedItineraries(query, req);
  }

  @Get('cancelled')
  @ApiOperation({
    summary: 'Get cancelled itineraries list with pagination and filters',
  })
  @ApiQuery({ type: LatestItineraryQueryDto })
  async getCancelledItineraries(
    @Query() query: LatestItineraryQueryDto,
    @Req() req: Request,
  ) {
    return this.svc.getCancelledItineraries(query, req);
  }

  @Get('accounts')
  @ApiOperation({
    summary: 'Get accounts itineraries list with pagination and filters',
  })
  @ApiQuery({ type: LatestItineraryQueryDto })
  async getAccountsItineraries(
    @Query() query: LatestItineraryQueryDto,
    @Req() req: Request,
  ) {
    return this.svc.getAccountsItineraries(query, req);
  }
  @Get('confirmed/agents')
  @ApiOperation({ summary: 'Get agents for confirmed itineraries filter' })
  @ApiOkResponse({ description: 'Returns list of agents with id and name' })
  async getConfirmedAgents(@Req() req: any) {
    return this.svc.getAgentsForFilter(req);
  }

  @Get('confirmed/locations')
  @ApiOperation({ summary: 'Get origin/destination locations from confirmed itineraries' })
  @ApiOkResponse({ description: 'Returns unique locations from arrival and departure' })
  async getConfirmedLocations() {
    return this.svc.getLocationsForFilter();
  }

  @Get('confirmed/:confirmedId')
  @ApiOperation({ 
    summary: 'Get confirmed itinerary details by ID',
    description: 'Returns confirmed itinerary with booked hotel details from database'
  })
  @ApiParam({ 
    name: 'confirmedId', 
    example: 31, 
    description: 'Confirmed Plan ID' 
  })
  @Public()
  async getConfirmedItineraryDetails(
    @Param('confirmedId', ParseIntPipe) confirmedId: number,
  ) {
    return this.svc.getConfirmedItineraryDetails(confirmedId);
  }

  @Get(':id/voucher-details')
  @ApiOperation({ summary: 'Get voucher details for a confirmed itinerary' })
  async getVoucherDetails(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getVoucherDetails(id);
  }

  @Get(':id/pluck-card-data')
  @ApiOperation({ summary: 'Get pluck card data for a confirmed itinerary' })
  async getPluckCardData(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getPluckCardData(id);
  }

  // Hotel Voucher Endpoints
  @Get(':id/hotel-vouchers/:hotelId/cancellation-policies')
  @ApiOperation({ summary: 'Get cancellation policies for a specific hotel' })
  async getHotelCancellationPolicies(
    @Param('id', ParseIntPipe) itineraryPlanId: number,
    @Param('hotelId', ParseIntPipe) hotelId: number,
  ) {
    return this.hotelVoucherService.getHotelCancellationPolicies(itineraryPlanId, hotelId);
  }

  @Post(':id/hotel-vouchers/cancellation-policies')
  @ApiOperation({ summary: 'Add a cancellation policy for a hotel' })
  async addCancellationPolicy(
    @Param('id', ParseIntPipe) itineraryPlanId: number,
    @Body() dto: AddCancellationPolicyDto,
    @Req() req: any,
  ) {
    const userId = Number(req.user?.userId ?? 1);
    return this.hotelVoucherService.addCancellationPolicy(
      { ...dto, itineraryPlanId },
      userId,
    );
  }

  @Delete(':id/hotel-vouchers/cancellation-policies/:policyId')
  @ApiOperation({ summary: 'Delete a cancellation policy' })
  async deleteCancellationPolicy(
    @Param('policyId', ParseIntPipe) policyId: number,
  ) {
    return this.hotelVoucherService.deleteCancellationPolicy(policyId);
  }

  @Get(':id/hotel-vouchers/:hotelId')
  @ApiOperation({ summary: 'Get existing voucher for a hotel' })
  async getHotelVoucher(
    @Param('id', ParseIntPipe) itineraryPlanId: number,
    @Param('hotelId', ParseIntPipe) hotelId: number,
  ) {
    return this.hotelVoucherService.getHotelVoucher(itineraryPlanId, hotelId);
  }

  @Post(':id/hotel-vouchers')
  @ApiOperation({ summary: 'Create hotel vouchers' })
  async createHotelVouchers(
    @Param('id', ParseIntPipe) itineraryPlanId: number,
    @Body() dto: CreateVoucherDto,
    @Req() req: any,
  ) {
    const userId = Number(req.user?.userId ?? 1);
    return this.hotelVoucherService.createHotelVouchers(
      { ...dto, itineraryPlanId },
      userId,
    );
  }

  @Get(':id/hotel-vouchers/default-terms')
  @ApiOperation({ summary: 'Get default voucher terms from global settings' })
  async getDefaultVoucherTerms() {
    return { terms: await this.hotelVoucherService.getDefaultVoucherTerms() };
  }

  @Get('confirmed/:confirmedId/pluck-card-data')
  @ApiOperation({ summary: 'Get pluck card data by confirmed plan id' })
  async getPluckCardDataByConfirmedId(@Param('confirmedId', ParseIntPipe) confirmedId: number) {
    return this.svc.getPluckCardDataByConfirmedId(confirmedId);
  }

  @Get(':id/invoice-data')
  @ApiOperation({ summary: 'Get invoice data for a confirmed itinerary' })
  async getInvoiceData(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getInvoiceData(id);
  }

  @Post(':id/manual-hotspot/preview')
  @ApiOperation({ summary: 'Preview adding a manual hotspot to a route' })
  async previewManualHotspot(
    @Param('id', ParseIntPipe) planId: number,
    @Body() body: { routeId: number; hotspotId: number },
  ) {
    return this.svc.previewManualHotspot(planId, body.routeId, body.hotspotId);
  }

  @Post(':id/manual-hotspot')
  @ApiOperation({ summary: 'Add a manual hotspot to a route and rebuild timeline' })
  async addManualHotspot(
    @Param('id', ParseIntPipe) planId: number,
    @Body() body: { routeId: number; hotspotId: number },
    @Req() req: any,
  ) {
    const userId = Number(req.user?.userId ?? 1);
    return this.svc.addManualHotspot(planId, body.routeId, body.hotspotId, userId);
  }

  @Delete(':id/manual-hotspot/:hotspotId')
  @ApiOperation({ summary: 'Remove a manual hotspot and rebuild timeline' })
  async removeManualHotspot(
    @Param('id', ParseIntPipe) planId: number,
    @Param('hotspotId', ParseIntPipe) hotspotId: number,
  ) {
    return this.svc.removeManualHotspot(planId, hotspotId);
  }

  @Post(':id/route/:routeId/rebuild')
  @ApiOperation({ summary: 'Rebuild hotspots for a route (clears exclusions and rebuilds fresh)' })
  @ApiParam({ name: 'id', example: 33977, description: 'Plan ID' })
  @ApiParam({ name: 'routeId', example: 207447, description: 'Route ID' })
  async rebuildRoute(
    @Param('id', ParseIntPipe) planId: number,
    @Param('routeId', ParseIntPipe) routeId: number,
  ) {
    return this.svc.rebuildRoute(planId, routeId);
  }

  @Patch(':id/route/:routeId/times')
  @ApiOperation({ summary: 'Update route start and end times' })
  async updateRouteTimes(
    @Param('id', ParseIntPipe) planId: number,
    @Param('routeId', ParseIntPipe) routeId: number,
    @Body() body: { startTime: string; endTime: string },
  ) {
    return this.svc.updateRouteTimes(planId, routeId, body.startTime, body.endTime);
  }

  /**
   * Hotel Cancellation Endpoints
   */
  @Get('cancellation/:confirmedPlanId')
  @ApiOperation({ summary: 'Get confirmed itinerary with hotels for cancellation page' })
  @ApiParam({ name: 'confirmedPlanId', example: 1, description: 'Confirmed Plan ID' })
  async getConfirmedItineraryForCancellation(
    @Param('confirmedPlanId', ParseIntPipe) confirmedPlanId: number,
  ) {
    return this.svc.getConfirmedItineraryForCancellation(confirmedPlanId);
  }

  @Post('cancellation/:confirmedPlanId/charges')
  @ApiOperation({ summary: 'Get cancellation charges for entire day' })
  @ApiParam({ name: 'confirmedPlanId', example: 1, description: 'Confirmed Plan ID' })
  async getEntireDayCancellationCharges(
    @Param('confirmedPlanId', ParseIntPipe) confirmedPlanId: number,
    @Body() body: { hotel_id: number; date: string; cancellation_percentage?: number },
  ) {
    return this.svc.getEntireDayCancellationCharges(
      confirmedPlanId,
      body.hotel_id,
      body.date,
      body.cancellation_percentage || 10,
    );
  }

  @Post('cancellation/:confirmedPlanId/cancel-hotel')
  @ApiOperation({ summary: 'Execute hotel cancellation' })
  @ApiParam({ name: 'confirmedPlanId', example: 1, description: 'Confirmed Plan ID' })
  async cancelHotel(
    @Param('confirmedPlanId', ParseIntPipe) confirmedPlanId: number,
    @Body()
    body: {
      hotel_id: number;
      date: string;
      total_cancellation_charge: number;
      total_refund_amount: number;
      defect_type?: string;
    },
  ) {
    return this.svc.cancelHotel(
      confirmedPlanId,
      body.hotel_id,
      body.date,
      body.total_cancellation_charge,
      body.total_refund_amount,
      body.defect_type || 'dvi',
    );
  }

  @Get('hotel-rooms/categories')
  @ApiOperation({ summary: 'Get hotel room categories for selection modal' })
  @ApiQuery({ name: 'itinerary_plan_hotel_details_ID', required: true, type: Number })
  @ApiQuery({ name: 'itinerary_plan_id', required: true, type: Number })
  @ApiQuery({ name: 'itinerary_route_id', required: true, type: Number })
  @ApiQuery({ name: 'hotel_id', required: true, type: Number })
  @ApiQuery({ name: 'group_type', required: true, type: Number })
  @ApiOkResponse({ type: HotelRoomCategoriesListResponseDto })
  async getHotelRoomCategories(@Query() query: GetHotelRoomCategoriesDto) {
    // Parse and validate group_type
    const groupType = Number(query.group_type);
    if (!groupType || groupType < 1 || groupType > 4) {
      throw new BadRequestException('Invalid group_type. Must be between 1-4 (Budget, Mid-Range, Premium, Luxury)');
    }
    
    return this.svc.getHotelRoomCategories({
      itinerary_plan_hotel_details_ID: Number(query.itinerary_plan_hotel_details_ID),
      itinerary_plan_id: Number(query.itinerary_plan_id),
      itinerary_route_id: Number(query.itinerary_route_id),
      hotel_id: Number(query.hotel_id),
      group_type: groupType,
    });
  }

  @Post('hotel-rooms/update-category')
  @ApiOperation({ summary: 'Update room category selection' })
  @ApiBody({ type: UpdateRoomCategoryDto })
  async updateRoomCategory(@Body() dto: UpdateRoomCategoryDto) {
    return this.svc.updateRoomCategory({
      itinerary_plan_hotel_room_details_ID: dto.itinerary_plan_hotel_room_details_ID,
      itinerary_plan_hotel_details_ID: dto.itinerary_plan_hotel_details_ID,
      itinerary_plan_id: dto.itinerary_plan_id,
      itinerary_route_id: dto.itinerary_route_id,
      hotel_id: dto.hotel_id,
      group_type: dto.group_type,
      room_type_id: dto.room_type_id,
      room_qty: dto.room_qty,
      all_meal_plan: dto.all_meal_plan,
      breakfast_meal_plan: dto.breakfast_meal_plan,
      lunch_meal_plan: dto.lunch_meal_plan,
      dinner_meal_plan: dto.dinner_meal_plan,
    });
  }

  /**
   * ✅ MUST BE LAST.
   * Otherwise it will swallow routes like /customer-info/:planId, /confirmed, /latest, etc.
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get itinerary by plan id' })
  @ApiParam({ name: 'id', example: 17940 })
  @ApiQuery({
    name: 'groupType',
    required: false,
    description: 'Hotel recommendation group type (1-4)',
  })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @Query('groupType') groupType?: string,
  ) {
    const groupTypeNum = groupType ? Number(groupType) : undefined;
    return this.detailsService.findOne(id, groupTypeNum);
  }
}
