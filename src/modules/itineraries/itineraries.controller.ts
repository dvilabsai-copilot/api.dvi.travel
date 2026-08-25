// FILE: src/itineraries/itineraries.controller.ts
// Fixes Prisma error by:
// 1) Moving @Get(':id') to the VERY END (so it wont swallow /customer-info, /confirmed, etc.)
// 2) Enforcing numeric :id with ParseIntPipe (so "confirmed" never becomes NaN)
// 3) Importing Request type correctly (your file used Request without import)

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
  ForbiddenException,
  NotFoundException,
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
import { TransportEarlyArrivalOption } from './transport-early-arrival';
import { LatestItineraryQueryDto } from './dto/latest-itinerary-query.dto';
import { ConfirmQuotationDto } from './dto/confirm-quotation.dto';
import { CancelItineraryDto } from './dto/cancel-itinerary.dto';
import { CancelHotelVouchersDto } from './dto/cancel-hotel-vouchers.dto';
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
import {
  HotelArrivalPolicyRequestDto,
  HotelArrivalPolicyResponseDto,
} from './dto/hotel-arrival-policy.dto';
import { StayExtensionPreviewDto } from './dto/stay-extension-preview.dto';
import { ItineraryHotelDetailsService } from './itinerary-hotel-details.service';
import { ItineraryHotelDetailsTboService } from './itinerary-hotel-details-tbo.service';
import { HotelAvailabilitySnapshotService } from './services/hotel-availability-snapshot.service';
import { ItineraryExportService } from './itinerary-export.service';
import { HotelVoucherService, AddCancellationPolicyDto, CreateVoucherDto } from './hotel-voucher.service';
import {
  VehicleVoucherService,
  AddVehicleCancellationPolicyDto,
  CreateVehicleVoucherDto,
  UpdateVehicleVoucherConfirmationDto,
} from './vehicle-voucher.service';
import { ArrivalHotelPolicyService } from './services/arrival-hotel-policy.service';
import { Public } from '../../auth/public.decorator';
import { Response, Request } from 'express';
import { RouteSuggestionsService } from './route-suggestions.service';
import { RouteSuggestionsV2Service } from './route-suggestions-v2.service';
import { ItineraryClipboardService } from './itinerary-clipboard.service';
import { ItineraryPdfService } from './itinerary-pdf.service';
import { ItineraryBookingConfirmationEmailNotifierService } from './services/itinerary-booking-confirmation-email-notifier.service';
import { HotelStayBlockValidationService } from './services/hotel-stay-block-validation.service';
import { SameCityCrossDayOptimizerService } from './services/same-city-cross-day-optimizer.service';
import { ItineraryAccessService } from './services/itinerary-access.service';

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
    private readonly hotelAvailabilitySnapshotService: HotelAvailabilitySnapshotService,
    private readonly exportService: ItineraryExportService,
    private readonly routeSuggestionsService: RouteSuggestionsService,
    private readonly routeSuggestionsV2Service: RouteSuggestionsV2Service,
    private readonly hotelVoucherService: HotelVoucherService,
    private readonly vehicleVoucherService: VehicleVoucherService,
   private readonly clipboardService: ItineraryClipboardService,
private readonly arrivalHotelPolicyService: ArrivalHotelPolicyService,
private readonly itineraryPdfService: ItineraryPdfService,
private readonly bookingConfirmationEmailNotifier: ItineraryBookingConfirmationEmailNotifierService,
private readonly hotelStayBlockValidationService: HotelStayBlockValidationService,
private readonly sameCityCrossDayOptimizerService: SameCityCrossDayOptimizerService,
private readonly itineraryAccessService: ItineraryAccessService,
  ) {}

  private parseClipboardGroupTypes(query: Record<string, any>): number[] {
    const collect = (value: unknown): number[] => {
      if (Array.isArray(value)) {
        return value.map((v) => Number(v)).filter((v) => Number.isInteger(v));
      }
      if (value === undefined || value === null || value === '') {
        return [];
      }
      return [Number(value)].filter((v) => Number.isInteger(v));
    };

    const groupTypeValues = collect(query.groupType);
    const recommendedValues = [
      ...collect(query.recommended1),
      ...collect(query.recommended2),
      ...collect(query.recommended3),
      ...collect(query.recommended4),
    ];

    const combined = [...groupTypeValues, ...recommendedValues];
    const unique = Array.from(new Set(combined));

    return unique.filter((v) => v >= 1 && v <= 4);
  }

  private denyItineraryAccess(redirectTo: string): never {
    throw new ForbiddenException({
      message: 'You are not authorized to access this itinerary.',
      redirectTo,
    });
  }

  @Get('clipboard/:quoteId')
  @ApiOperation({
    summary: 'Generate clipboard HTML for recommended mode',
    description: 'PHP-parity clipboard output for recommended itinerary content',
  })
  async getClipboardRecommended(
    @Param('quoteId') quoteId: string,
    @Query() query: Record<string, any>,
    @Req() req: Request,
  ) {
    const access = await this.itineraryAccessService.getQuoteAccessDecision(
      quoteId,
      (req as any).user,
    );
    if (!access.exists || !access.allowed) {
      return this.denyItineraryAccess(access.redirectTo || '/latest-itinerary');
    }

    const groupTypes = this.parseClipboardGroupTypes(query);
    return this.clipboardService.generateClipboardByQuoteId(
      quoteId,
      'recommended',
      groupTypes,
    );
  }

  @Get('clipboard-highlights/:quoteId')
  @ApiOperation({
    summary: 'Generate clipboard HTML for highlights mode',
    description: 'PHP-parity clipboard output for highlights itinerary content',
  })
  async getClipboardHighlights(
    @Param('quoteId') quoteId: string,
    @Query() query: Record<string, any>,
    @Req() req: Request,
  ) {
    const access = await this.itineraryAccessService.getQuoteAccessDecision(
      quoteId,
      (req as any).user,
    );
    if (!access.exists || !access.allowed) {
      return this.denyItineraryAccess(access.redirectTo || '/latest-itinerary');
    }

    const groupTypes = this.parseClipboardGroupTypes(query);
    return this.clipboardService.generateClipboardByQuoteId(
      quoteId,
      'highlights',
      groupTypes,
    );
  }

  @Get('clipboard-para/:quoteId')
  @ApiOperation({
    summary: 'Generate clipboard HTML for paragraph mode',
    description: 'PHP-parity clipboard output for paragraph itinerary content',
  })
  async getClipboardPara(
    @Param('quoteId') quoteId: string,
    @Query() query: Record<string, any>,
    @Req() req: Request,
  ) {
    const access = await this.itineraryAccessService.getQuoteAccessDecision(
      quoteId,
      (req as any).user,
    );
    if (!access.exists || !access.allowed) {
      return this.denyItineraryAccess(access.redirectTo || '/latest-itinerary');
    }

    const groupTypes = this.parseClipboardGroupTypes(query);
    return this.clipboardService.generateClipboardByQuoteId(
      quoteId,
      'para',
      groupTypes,
    );
  }

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
    const routeCount = Array.isArray((dto as any)?.routes) ? (dto as any).routes.length : 0;
    return this.svc.createPlan(dto, req, shouldOptimizeRoute, type);
  }

  @Get('details/:quoteId')
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
    @Req() req: Request,
    @Query('groupType') groupType?: string,
  ) {
    const access = await this.itineraryAccessService.getQuoteAccessDecision(
      quoteId,
      (req as any).user,
    );
    if (!access.exists || !access.allowed) return this.denyItineraryAccess(access.redirectTo || '/latest-itinerary');

    const groupTypeNum = groupType !== undefined ? Number(groupType) : undefined;
    return this.detailsService.getItineraryDetails(
      quoteId,
      groupTypeNum,
      (req as any)?.user?.role,
    );
  }

   @Get(':id/guides/availability')
  @ApiOperation({ summary: 'Check whether guide prices are available for itinerary days' })
  async getGuideAvailability(
    @Param('id', ParseIntPipe) planId: number,
  ) {
    return this.svc.getGuideAvailability(planId);
  }

  @Get(':id/guides')
  @ApiOperation({ summary: 'List itinerary guide assignments for a draft itinerary' })
  async listGuideAssignments(
    @Param('id', ParseIntPipe) planId: number,
  ) {
    return this.svc.listGuideAssignments(planId);
  }

  @Get(':id/guides/options')
  @ApiOperation({ summary: 'Get guide modal options and existing assignment data' })
  async getGuideAssignmentOptions(
    @Param('id', ParseIntPipe) planId: number,
    @Query('routeGuideId') routeGuideId?: string,
  ) {
    return this.svc.getGuideAssignmentOptions(
      planId,
      routeGuideId ? Number(routeGuideId) : undefined,
    );
  }

  @Post(':id/guides')
  @ApiOperation({ summary: 'Create or update a draft itinerary guide assignment' })
  async saveGuideAssignment(
    @Param('id', ParseIntPipe) planId: number,
    @Body()
    body: {
      routeGuideId?: number;
      routeId?: number;
      routeDate?: string;
      guideType?: number;
      guideLanguage: number;
      guideSlots?: number[];
    },
    @Req() req: any,
  ) {
    const userId = Number(req.user?.userId ?? 1);
    return this.svc.saveGuideAssignment(planId, body, userId);
  }

  @Delete(':id/guides/:routeGuideId')
  @ApiOperation({ summary: 'Delete a draft itinerary guide assignment' })
  async deleteGuideAssignment(
    @Param('id', ParseIntPipe) planId: number,
    @Param('routeGuideId', ParseIntPipe) routeGuideId: number,
    @Query('routeId') routeId?: string,
  ) {
    return this.svc.deleteGuideAssignment(
      planId,
      routeGuideId,
      routeId ? Number(routeId) : undefined,
    );
  }

  @Get('hotel_details/:quoteId')
  @ApiOperation({
    summary: 'Get persisted hotel availability snapshot',
    description:
      'Database-only read of the latest persisted hotel availability snapshot. Live suppliers are called only by the explicit Check Availability command.',
  })
  @ApiParam({
    name: 'quoteId',
    required: true,
    description: 'Quote ID generated for the itinerary',
    example: 'DVI202512032',
  })
  @ApiOkResponse({ description: 'Persisted hotel availability snapshot' })
  async getItineraryHotelDetails(
    @Param('quoteId') quoteId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('groupType') groupType?: string,
    @Query('itineraryRouteId') itineraryRouteId?: string,
  ): Promise<ItineraryHotelDetailsResponseDto> {
    const startTime = Date.now();
 this.logger.log('\n');
 this.logger.log(' INCOMING ITINERARY HOTEL DETAILS REQUEST (PERSISTED)');
 this.logger.log(` Request Timestamp: ${new Date().toISOString()}`);
 this.logger.log(` Quote ID: ${quoteId}`);
 this.logger.log('');

    try {
 // Read the persisted snapshot; the fallback is also database-only and
 // exposes legacy selected rows for itineraries created before snapshots.
      const pageNum = page ? Math.max(1, parseInt(page, 10) || 1) : 1;
      // An unfiltered page load is the edit/reload contract: it must rebuild
      // the hotel panel from the complete persisted snapshot. Pagination is
      // still used for explicit group/stay requests and load-more calls.
      const isCompleteSnapshotRead = !page && !groupType && !itineraryRouteId;
      const pageSizeNum = isCompleteSnapshotRead
        ? 0
        : pageSize ? Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20)) : 100;
      const groupTypeNum = groupType ? parseInt(groupType, 10) : undefined;
      const itineraryRouteIdNum = itineraryRouteId
        ? Math.max(0, parseInt(itineraryRouteId, 10) || 0)
        : undefined;
      const result = await this.hotelAvailabilitySnapshotService.readPersisted(
        quoteId,
        { page: pageNum, pageSize: pageSizeNum, groupType: groupTypeNum, itineraryRouteId: itineraryRouteIdNum },
        () => this.hotelDetailsService.getHotelDetailsByQuoteId(quoteId),
      );
      const duration = Date.now() - startTime;

 this.logger.log('\n PERSISTED HOTEL SNAPSHOT READ');
 this.logger.log(` Hotel Tabs: ${result.hotelTabs?.length || 0} packages`);
 this.logger.log(` Hotel Rows: ${result.hotels?.length || 0} total hotels`);
 this.logger.log(` Total Duration: ${duration}ms`);
 this.logger.log('\n');

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
 this.logger.error('\n HOTEL PACKAGES GENERATION FAILED');
 this.logger.error(` Error Message: ${errorMessage}`);
 this.logger.error(` Duration: ${duration}ms`);
 this.logger.log('\n');
      throw error;
    }
  }

  @Get('hotel_details/:quoteId/persisted')
  @ApiOperation({
    summary: 'Get persisted hotel availability snapshot',
    description: 'Database-only alias for clients that need an explicit persisted-read contract.',
  })
  async getPersistedItineraryHotelDetails(
    @Param('quoteId') quoteId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('groupType') groupType?: string,
    @Query('itineraryRouteId') itineraryRouteId?: string,
    @Query('includeInventory') includeInventory?: string,
  ): Promise<ItineraryHotelDetailsResponseDto> {
    const persisted = await this.hotelAvailabilitySnapshotService.readPersisted(
      quoteId,
      {
        page: page ? Math.max(1, parseInt(page, 10) || 1) : 1,
        pageSize: !page && !groupType && !itineraryRouteId
          ? 0
          : page
            ? Math.min(100, Math.max(1, parseInt(pageSize || '20', 10) || 20))
            : 100,
        groupType: groupType ? parseInt(groupType, 10) : undefined,
        itineraryRouteId: itineraryRouteId ? Math.max(0, parseInt(itineraryRouteId, 10) || 0) : undefined,
      },
      () => this.hotelDetailsService.getHotelDetailsByQuoteId(quoteId),
    );

    if (page || groupType || itineraryRouteId || String(includeInventory || '').toLowerCase() === 'true') {
      return persisted;
    }

    return this.buildCompactHotelAvailabilityResponse(
      { response: persisted, changeSummary: null },
      null,
    ).hotelDetails;
  }

  @Post('hotel_details/:quoteId/check-availability')
  @ApiOperation({
    summary: 'Explicitly check hotel availability',
    description: 'Calls enabled live suppliers and offline inventory for comparison, then atomically replaces the persisted snapshot. Live rates are preferred; offline inventory is auto-selected only for stays with no live selectable rate.',
  })
  async checkItineraryHotelAvailability(
    @Param('quoteId') quoteId: string,
    @Req() req: any,
  ) {
    const result = await this.hotelAvailabilitySnapshotService.searchAndPersist(
      quoteId,
      'CHECK_AVAILABILITY',
      Number(req.user?.userId || 0),
    );
    const itinerary = await this.detailsService.getItineraryDetails(
      quoteId,
      undefined,
      req.user?.role,
    );
    // Reset already has the complete persisted snapshot in result.response.
    // Return it directly so the client does not issue a second /persisted
    // request just to restore inventory and rate options for the hotel pane.
    return {
      hotelDetails: result.response,
      changeSummary: result.changeSummary,
      financialSummary: {
        overallCost: itinerary?.overallCost ?? null,
        costBreakdown: itinerary?.costBreakdown ?? null,
      },
    };
  }

  @Post('hotel_details/:quoteId/selected-hotel-refresh')
  @ApiOperation({ summary: 'Refresh the latest rates for one selected supplier hotel' })
  async refreshSelectedHotelRates(
    @Param('quoteId') quoteId: string,
    @Body() body: { routeId?: number; provider?: string; hotelCode?: string; groupType?: number },
  ) {
    const result = await this.hotelDetailsTboService.getSelectedHotelRates(
      quoteId,
      Number(body?.routeId || 0),
      String(body?.provider || ''),
      String(body?.hotelCode || ''),
      Number(body?.groupType || 0),
    );
    await this.hotelAvailabilitySnapshotService.mergeSelectedHotelRates(
      quoteId,
      Number(body?.routeId || 0),
      String(body?.provider || ''),
      String(body?.hotelCode || ''),
      Array.isArray(result?.hotels) ? result.hotels : [],
    );
    return result;
  }

  @Post('hotel_details/:quoteId/reset')
  @ApiOperation({
    summary: 'Reset hotel selections and rebuild availability',
    description: 'Clears the current editable hotel selections, then performs the fresh live supplier hotel search used during itinerary creation.',
  })
  async resetItineraryHotelAvailability(
    @Param('quoteId') quoteId: string,
    @Req() req: any,
  ) {
    const result = await this.hotelAvailabilitySnapshotService.resetAndPersist(
      quoteId,
      Number(req.user?.userId || 0),
    );
    // Reset persists the authoritative selection snapshots. Read them again
    // after the transaction so the response cannot reuse a stale in-memory
    // availability row for room/supplement totals.
    result.response = await this.hotelAvailabilitySnapshotService.readPersisted(
      quoteId,
      { page: 1, pageSize: 0 },
    );
    const itinerary = await this.detailsService.getItineraryDetails(
      quoteId,
      undefined,
      req.user?.role,
    );
    return this.buildCompactHotelAvailabilityResponse(result, itinerary);
  }

  @Post('hotel_details/:quoteId/offline-availability')
  @ApiOperation({
    summary: 'Fetch offline hotels for one stay group or all stay groups',
    description: 'Does not call live suppliers. Existing hotel selections are preserved; missing groups may be auto-selected from the explicitly requested offline inventory.',
  })
  async fetchOfflineItineraryHotelAvailability(
    @Param('quoteId') quoteId: string,
    @Body() body: { routeId?: number },
    @Req() req: any,
  ) {
    const result = await this.hotelAvailabilitySnapshotService.fetchOfflineForStay(
      quoteId,
      body?.routeId ? Number(body.routeId) : undefined,
      Number(req.user?.userId || 0),
    );
    const itinerary = await this.detailsService.getItineraryDetails(
      quoteId,
      undefined,
      req.user?.role,
    );
    return this.buildCompactHotelAvailabilityResponse(result, itinerary);
  }

  private buildCompactHotelAvailabilityResponse(result: any, itinerary: any) {
    const {
      recommendationAlgorithm: _recommendationAlgorithm,
      recommendationGeneration: _recommendationGeneration,
      hotelAvailability,
      ...resetHotelDetails
    } = result.response;
    const {
      recommendationAlgorithm: _availabilityRecommendationAlgorithm,
      recommendationGeneration: _availabilityRecommendationGeneration,
      sharedHotelInventory,
      ...compactAvailability
    } = hotelAvailability || ({} as any);

    // Keep the complete route/day inventory in reset and offline-availability
    // responses. The compact response intentionally removes rate internals,
    // but removing this list also removes the alternative hotels needed by
    // HotelListTable's per-day hotel editor. The selected `hotels` rows alone
    // are not sufficient because they contain only the current recommendation.
    const toCompactHotelRow = (row: any) => {
      const {
        rateOptions: _rateOptions,
        roomTypes: _roomTypes,
        nightlyRates: _nightlyRates,
        supplementSummary: _supplementSummary,
        selection: _selection,
        selectedPriceSnapshot: _selectedPriceSnapshot,
        selected_price_snapshot: _selectedPriceSnapshotLegacy,
        itinerary_route_id: _itineraryRouteIdLegacy,
        itinerary_route_date: _itineraryRouteDateLegacy,
        check_in_date: _checkInDateLegacy,
        check_out_date: _checkOutDateLegacy,
        hotelCheckInDate: _hotelCheckInDateLegacy,
        hotel_check_in_date: _hotelCheckInDateSnake,
        hotelCheckOutDate: _hotelCheckOutDateLegacy,
        hotel_check_out_date: _hotelCheckOutDateSnake,
        ...summaryRow
      } = row || {};
      return summaryRow;
    };

    return {
      hotelDetails: {
        ...resetHotelDetails,
        hotels: (result.response.hotels || []).map(toCompactHotelRow),
        hotelAvailability: {
          ...compactAvailability,
          sharedHotelInventory: Array.isArray(sharedHotelInventory)
            ? sharedHotelInventory.map(toCompactHotelRow)
            : [],
        },
        hotelTabs: (result.response.hotelTabs || []).map((tab: any) => ({
          groupType: tab.groupType,
          label: tab.label,
          totalAmount: tab.totalAmount,
          partialTotal: tab.partialTotal,
          complete: tab.complete,
          stayResults: (tab.stayResults || []).map((stay: any) => ({
            stayKey: stay.stayKey,
            parentRouteId: stay.parentRouteId,
            routeIds: stay.routeIds,
            destination: stay.destination,
            checkInDate: stay.checkInDate,
            checkOutDate: stay.checkOutDate,
            nights: stay.nights,
          })),
        })),
        hotelSelectionState: (result.response.hotelSelectionState || []).map((group: any) => ({
          ...group,
          routes: (group.routes || []).map((route: any) => {
            if (!route?.selected) return route;
            const snapshot = route.selected.selectedPriceSnapshot &&
              typeof route.selected.selectedPriceSnapshot === 'object'
              ? route.selected.selectedPriceSnapshot
              : {};
            const { selectedPriceSnapshot: _selectedPriceSnapshot, ...selected } = route.selected;
            // The snapshot is the authoritative payable selection produced by
            // the hotel availability rebuild. Legacy scalar columns can be
            // stale (for example room count and supplement totals after a
            // reset), so they must not overwrite the snapshot values.
            return { ...route, selected: { ...selected, ...snapshot } };
          }),
        })),
      },
      changeSummary: result.changeSummary,
      financialSummary: {
        overallCost: itinerary?.overallCost ?? null,
        costBreakdown: itinerary?.costBreakdown ?? null,
      },
    };
  }

  @Post('hotel_details/:quoteId/rebuild')
  @ApiOperation({
    summary: 'Rebuild hotel cache for a quote and return fresh hotel details',
    description:
      'Deprecated compatibility command. Performs the same explicit availability refresh without clearing the active snapshot first.',
  })
  @ApiParam({
    name: 'quoteId',
    required: true,
    description: 'Quote ID generated for the itinerary',
    example: 'DVI_EXAMPLE_QUOTE_ID',
  })
  @ApiQuery({ name: 'page', required: false, example: 1, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, example: 20, type: Number })
  @ApiQuery({ name: 'groupType', required: false, example: 1, type: Number })
  async rebuildItineraryHotelDetails(
    @Param('quoteId') quoteId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('groupType') groupType?: string,
  ): Promise<ItineraryHotelDetailsResponseDto> {
    const pageNum = page ? Math.max(1, parseInt(page, 10) || 1) : 1;
    const pageSizeNum = pageSize ? Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20)) : 20;
    const groupTypeNum = groupType ? parseInt(groupType, 10) : undefined;

    const result = await this.hotelAvailabilitySnapshotService.searchAndPersist(
      quoteId,
      'CHECK_AVAILABILITY',
      0,
    );
    return this.hotelAvailabilitySnapshotService.readPersisted(quoteId, {
      page: pageNum,
      pageSize: pageSizeNum,
      groupType: groupTypeNum,
    });
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
  async getItineraryHotelRoomDetails(
    @Param('quoteId') quoteId: string,
    @Query('itineraryRouteId') itineraryRouteId?: string,
    @Query('clearCache') clearCache?: string,
  ): Promise<ItineraryHotelRoomDetailsResponseDto> {
    const startTime = Date.now();
 this.logger.log('\n');
 this.logger.log(' INCOMING ITINERARY HOTEL ROOM DETAILS REQUEST (TBO - FRESH DATA)');
 this.logger.log(` Request Timestamp: ${new Date().toISOString()}`);
 this.logger.log(` Quote ID: ${quoteId}`);
    if (itineraryRouteId) {
 this.logger.log(` Filter Route ID: ${itineraryRouteId}`);
    }
    if (clearCache === 'true') {
 this.logger.log(` Clear Cache Requested: YES`);
    }
 this.logger.log('');

    try {
 // Clear backend memory cache if requested
      if (clearCache === 'true') {
        this.hotelDetailsTboService.clearCacheForQuote(quoteId);
 this.logger.log(' Backend cache cleared - will fetch fresh data from TBO');
      }

 // Use TBO service to fetch FRESH room details (no stale data)
 // Pass optional itineraryRouteId to filter results
      const routeIdNum = itineraryRouteId ? parseInt(itineraryRouteId, 10) : undefined;
      const result = await this.hotelDetailsTboService.getHotelRoomDetailsFromTbo(
        quoteId,
        routeIdNum,
      );
      const duration = Date.now() - startTime;

 this.logger.log('\n FRESH ROOM DETAILS GENERATED FROM TBO');
 this.logger.log(` Room Entries: ${result.rooms?.length || 0}`);
 this.logger.log(` Total Duration: ${duration}ms`);
 this.logger.log('\n');

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
 this.logger.error('\n FRESH ROOM DETAILS GENERATION FAILED');
 this.logger.error(` Error Message: ${errorMessage}`);
 this.logger.error(` Duration: ${duration}ms`);
 this.logger.log('\n');
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
  async getLatestLocations(@Req() req: Request) {
    return this.svc.getLocationsForLatestFilter(req);
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

  @Post('hotel-arrival-policy')
  @ApiOperation({
    summary: 'Resolve arrival-time hotel decision policy',
    description:
      'Computes hotel search/check-in strategy from arrival time, route day, and normalized city context.',
  })
  @ApiBody({ type: HotelArrivalPolicyRequestDto })
  @ApiOkResponse({ type: HotelArrivalPolicyResponseDto })
  async resolveHotelArrivalPolicy(
    @Body() body: HotelArrivalPolicyRequestDto,
    @Req() req: Request,
  ): Promise<HotelArrivalPolicyResponseDto> {
    this.itineraryAccessService.assertVehicleAgentHotelMutation((req as any).user);
    return this.arrivalHotelPolicyService.resolvePolicy(body);
  }

  @Get('activities/available/:hotspotId')
  @ApiOperation({ summary: 'Get available activities for a hotspot location' })
  @ApiParam({
    name: 'hotspotId',
    example: 123,
    description: 'Hotspot Location ID',
  })
  @ApiOkResponse({ description: 'List of available activities' })
async getAvailableActivities(
  @Param('hotspotId') hotspotId: string,
  @Query('planId') planId?: string,
  @Query('routeId') routeId?: string,
) {
  return this.svc.getAvailableActivities(
    Number(hotspotId),
    planId ? Number(planId) : undefined,
    routeId ? Number(routeId) : undefined,
  );
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

  @Post('activities/preview-all-hotspots')
  @ApiOperation({ summary: 'Preview activity addition across all hotspots in a route (day view)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        planId: { type: 'number', example: 17940 },
        routeId: { type: 'number', example: 1 },
        activityId: { type: 'number', example: 5 },
      },
      required: ['planId', 'routeId', 'activityId'],
    },
  })
  @ApiOkResponse({ description: 'Activity preview for all hotspots with fit/conflict status' })
  async previewActivityForAllHotspots(@Body() body: any) {
    return this.svc.previewActivityForAllHotspots(body);
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

  @Post(':planId/activity/smart-preview')
  @ApiOperation({ summary: 'Preview smart activity fit for a selected route insertion gap' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        routeId: { type: 'number', example: 1 },
        activityId: { type: 'number', example: 789 },
        gapIndex: { type: 'number', example: 1, nullable: true },
        hotspotId: { type: 'number', example: 456, nullable: true },
        routeHotspotId: { type: 'number', example: 123, nullable: true },
        mode: { type: 'string', example: 'preview', nullable: true },
      },
      required: ['routeId', 'activityId'],
    },
  })
  @ApiOkResponse({ description: 'Smart fit preview generated successfully' })
  async smartPreviewActivity(@Param('planId') planId: string, @Body() body: any) {
    return this.svc.smartPreviewActivity(Number(planId), body);
  }

  @Post(':planId/activity/smart-insert')
  @ApiOperation({ summary: 'Apply smart activity insertion to selected route gap' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        routeId: { type: 'number', example: 1 },
        activityId: { type: 'number', example: 789 },
        gapIndex: { type: 'number', example: 1 },
        hotspotId: { type: 'number', example: 456, nullable: true },
        routeHotspotId: { type: 'number', example: 123, nullable: true },
        allowTopPriorityRemoval: { type: 'boolean', example: false, nullable: true },
      },
      required: ['routeId', 'activityId', 'gapIndex'],
    },
  })
  @ApiOkResponse({ description: 'Smart activity insertion completed successfully' })
  async smartInsertActivity(@Param('planId') planId: string, @Body() body: any) {
    return this.svc.smartInsertActivity(Number(planId), body);
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

  @Post('hotspots/available-for-anchor')
  @ApiOperation({ summary: 'Get available hotspots for a specific travel anchor on a route' })
  async getAvailableHotspotsForAnchor(
    @Body()
    body: {
      planId: number;
      routeId: number;
      anchorType: 'after_travel';
      anchorIndex: number;
    },
  ) {
    return this.svc.getAvailableHotspotsForAnchor({
      planId: Number(body.planId),
      routeId: Number(body.routeId),
      anchorType: body.anchorType,
      anchorIndex: Number(body.anchorIndex),
    });
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
        hotelId: {
          type: 'number',
          nullable: true,
          example: 123,
          description: 'Canonical dvi_hotel.hotel_id when mapped; null for live supplier-only rows such as TBO.',
        },
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
      required: ['planId', 'routeId', 'roomTypeId'],
    },
  })
  @ApiOkResponse({ description: 'Hotel selected successfully' })
  async selectHotel(@Body() body: any, @Req() req: Request) {
    this.itineraryAccessService.assertVehicleAgentHotelMutation((req as any).user);
    await this.itineraryAccessService.assertCanEditPlan(Number(body.planId), (req as any).user);
    return this.svc.selectHotel({
      ...body,
      requestedBy: Number((req as any).user?.userId || 1),
    });
  }

  @Post('hotels/select-intent')
  @ApiOperation({ summary: 'Refresh, resolve, validate, and persist a hotel selection intent' })
  async selectHotelIntent(@Body() body: any, @Req() req: Request) {
    this.itineraryAccessService.assertVehicleAgentHotelMutation((req as any).user);
    await this.itineraryAccessService.assertCanEditPlan(Number(body.planId), (req as any).user);
    return this.svc.selectHotelIntent({
      ...body,
      requestedBy: Number((req as any).user?.userId || 1),
    });
  }

  @Post('hotels/select-intent-preview')
  @ApiOperation({ summary: 'Resolve a hotel selection intent without persisting it' })
  async previewHotelIntent(@Body() body: any, @Req() req: Request) {
    this.itineraryAccessService.assertVehicleAgentHotelMutation((req as any).user);
    await this.itineraryAccessService.assertCanEditPlan(Number(body.planId), (req as any).user);
    return this.svc.previewHotelIntent({
      ...body,
      requestedBy: Number((req as any).user?.userId || 1),
    });
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
  async bulkSaveHotels(@Body() body: { planId: number; hotels: any[] }, @Req() req: Request) {
    this.itineraryAccessService.assertVehicleAgentHotelMutation((req as any).user);
    await this.itineraryAccessService.assertCanEditPlan(Number(body.planId), (req as any).user);
    return this.svc.bulkSaveHotels(
      body.planId,
      body.hotels,
      Number((req as any).user?.userId || 1),
    );
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
  async selectVehicleVendor(
    @Body() body: any,
    @Req() req: Request,
  ) {
    await this.itineraryAccessService.assertCanEditPlan(
      Number(body.planId),
      (req as any).user,
    );

    return this.svc.selectVehicleVendor(
      body,
      (req as any)?.user?.role,
    );
  }
  @Post('vehicles/select-slab')
  @ApiOperation({ summary: 'Select slab for a vendor vehicle and recalculate vehicle pricing' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        planId: { type: 'number', example: 17940 },
        vehicleTypeId: { type: 'number', example: 1 },
        vendorEligibleId: { type: 'number', example: 123 },
        timeLimitId: { type: 'number', example: 230 },
      },
      required: ['planId', 'vehicleTypeId', 'vendorEligibleId', 'timeLimitId'],
    },
  })
  @ApiOkResponse({ description: 'Vehicle slab selected and pricing recalculated successfully' })
  async selectVehicleSlab(@Body() body: any, @Req() req: Request) {
    await this.itineraryAccessService.assertCanEditPlan(Number(body.planId), (req as any).user);
    return this.svc.selectVehicleSlab(body);
  }

  @Post('vehicles/auto-select-slabs')
  @ApiOperation({ summary: 'Auto select the best slab for vendor vehicles based on effective KM/time and recalculate pricing' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        planId: { type: 'number', example: 17940 },
        vehicleTypeId: { type: 'number', example: 1 },
      },
      required: ['planId'],
    },
  })
  @ApiOkResponse({ description: 'Vehicle slabs auto-selected and pricing recalculated successfully' })
  async autoSelectVehicleSlabs(@Body() body: any, @Req() req: Request) {
    await this.itineraryAccessService.assertCanEditPlan(Number(body.planId), (req as any).user);
    return this.svc.autoSelectVehicleSlabs(body);
  }

  @Post(':planId/permit-build-sync')
  @ApiOperation({ summary: 'Run permit charge rebuild synchronously for staged itinerary loading' })
  @ApiParam({ name: 'planId', example: 17940, description: 'Itinerary Plan ID' })
  @ApiOkResponse({ description: 'Permit build completed successfully' })
  async buildPermitsSync(
    @Param('planId', ParseIntPipe) planId: number,
    @Req() req?: Request,
  ) {
    return this.svc.buildPermitsSync(planId, req);
  }

  @Post(':planId/vehicle-build-sync')
  @ApiOperation({ summary: 'Run vehicle rebuild synchronously for staged itinerary loading' })
  @ApiParam({ name: 'planId', example: 17940, description: 'Itinerary Plan ID' })
  @ApiOkResponse({ description: 'Vehicle build completed successfully' })
  async buildVehiclesSync(
    @Param('planId', ParseIntPipe) planId: number,
    @Req() req?: Request,
  ) {
    return this.svc.buildVehiclesSync(planId, req);
  }

  @Get('edit/:id')
  @ApiOperation({ summary: 'Get itinerary raw plan data for editing' })
  @ApiParam({ name: 'id', example: 17940, description: 'Itinerary Plan ID' })
  @ApiOkResponse({
    description: 'Returns plan, routes, and vehicles for editing in the form',
  })
  async getPlanForEdit(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
  ) {
    const access = await this.itineraryAccessService.getPlanAccessDecision(
      id,
      (req as any).user,
    );
    if (!access.exists || !access.allowed) return this.denyItineraryAccess(access.redirectTo || '/latest-itinerary');

    return this.svc.getPlanForEdit(id);
  }

 @Get('export/:id')
@ApiOperation({ summary: 'Export itinerary to Excel' })
@ApiParam({ name: 'id', example: 14, description: 'Itinerary Plan ID' })
async exportToExcel(
  @Param('id', ParseIntPipe) id: number,
  @Req() req: any,
  @Res() res: Response,
) {
  const role = Number(req.user?.role ?? req.user?.roleId ?? 0);
  const staffId = Number(req.user?.staffId ?? req.user?.staff_id ?? 0);

  const isAgent = role === 4;
  const isAccounts = role === 6;

  const isTravelExpert =
    (role === 3 || role === 8 || staffId > 0) &&
    !isAgent &&
    !isAccounts;

  const canDownloadExcel =
 role === 1 || // Admin
    isTravelExpert ||
    isAccounts;

  if (!canDownloadExcel) {
    throw new ForbiddenException(
      'Excel export is available only for Admin, Travel Expert, and Accounts users.',
    );
  }

  const access = await this.itineraryAccessService.getPlanAccessDecision(
    id,
    req.user,
  );
  if (!access.exists) {
    throw new NotFoundException('Itinerary plan not found');
  }
  if (!access.allowed) {
    throw new ForbiddenException('You are not allowed to access this itinerary.');
  }

  const { workbook, fileName } =
    await this.exportService.exportItineraryToExcel(id);

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );

  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
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

  @Post('hotels/prebook')
  @ApiOperation({ summary: 'Prebook selected hotels before final quotation confirmation' })
  async prebookHotels(
    @Body()
    body: {
      itinerary_plan_ID: number;
      hotel_bookings: any[];
      endUserIp?: string;
    },
    @Req() req: Request,
  ) {
    this.itineraryAccessService.assertVehicleAgentHotelMutation((req as any).user);
    await this.itineraryAccessService.assertCanEditPlan(Number(body.itinerary_plan_ID), (req as any).user);
    return this.svc.prebookHotels(body);
  }

  @Post(':planId/hotels/stay-extension-preview')
  @ApiOperation({ summary: 'Preview continuous multi-night hotel booking from current supplier availability' })
  async previewHotelStayExtension(
    @Param('planId', ParseIntPipe) planId: number,
    @Body() body: StayExtensionPreviewDto,
    @Req() req: Request,
  ) {
    this.itineraryAccessService.assertVehicleAgentHotelMutation((req as any).user);
    await this.itineraryAccessService.assertCanEditPlan(planId, (req as any).user);
    return this.hotelStayBlockValidationService.previewStayExtension({
      planId,
      routeId: Number(body.routeId),
      provider: body.provider,
      hotelCode: body.hotelCode,
      hotelName: body.hotelName,
      roomId: body.roomId,
      rateId: body.rateId,
      roomType: body.roomType,
      mealPlan: body.mealPlan,
      checkInDate: body.checkInDate,
      groupType: body.groupType,
    });
  }

@Post('confirm-quotation')
@ApiOperation({
  summary:
    'Confirm quotation with guest details and optional TBO hotel bookings',
})
@ApiBody({
  type: ConfirmQuotationDto,
})
@ApiOkResponse({
  description:
    'Quotation confirmed successfully',
})
async confirmQuotation(
  @Body() dto: ConfirmQuotationDto,
  @Req() req: Request,
) {
  this.itineraryAccessService.assertVehicleAgentHotelMutation((req as any).user);
  await this.itineraryAccessService.assertCanEditPlan(Number(dto.itinerary_plan_ID), (req as any).user);
  const baseResult =
    await this.svc.confirmQuotation(dto);

  let finalResult: any;

  if (
    dto.hotel_bookings &&
    dto.hotel_bookings.length > 0
  ) {
    const forwardedFor =
      req.headers['x-forwarded-for'];

    const clientIp = String(
      req.ip ||
        (
          Array.isArray(forwardedFor)
            ? forwardedFor[0]
            : forwardedFor
        ) ||
        '192.168.1.1',
    );

    /*
     * This returns successfully only after
     * selected supplier hotel bookings have
     * completed successfully.
     */
    finalResult =
      await this.svc
        .processConfirmationWithTboBookings(
          baseResult,
          dto,
          clientIp,
        );
  } else {
    const confirmedPlanId = Number(
      baseResult
        ?.confirmed_itinerary_plan_ID ||
        0,
    );

    const confirmedHotelDetails =
      confirmedPlanId > 0
        ? await this.svc
            .getConfirmedItineraryDetails(
              confirmedPlanId,
            )
        : null;

    finalResult = {
      ...baseResult,
      confirmedHotelDetails,
    };
  }

  const itineraryPlanId = Number(
    finalResult?.itinerary_plan_ID ||
      baseResult?.itinerary_plan_ID ||
      dto.itinerary_plan_ID ||
      0,
  );

  /*
   * The email notifier catches its own
   * errors. Email failure will not cancel
   * a successfully confirmed booking.
   */
  if (itineraryPlanId > 0) {
    await this
      .bookingConfirmationEmailNotifier
      .sendBookingConfirmationNotifications(
        itineraryPlanId,
      );
  }

  return finalResult;
}

  @Post(':planId/hotels/selection-cost-preview')
  @ApiOperation({ summary: 'Preview temporary hotel selection costs without saving draft rows' })
  async previewHotelSelectionCost(
    @Param('planId', ParseIntPipe) planId: number,
    @Body() body: { selections?: Record<string, any> | any[]; groupType?: number },
    @Req() req: Request,
  ) {
    this.itineraryAccessService.assertVehicleAgentHotelMutation((req as any).user);
    await this.itineraryAccessService.assertCanViewPlan(planId, (req as any).user);
    return this.detailsService.previewHotelSelectionCost({
      planId,
      selections: body?.selections || {},
      groupType: body?.groupType ? Number(body.groupType) : undefined,
    });
  }

    @Post('cancel')
  @ApiOperation({ summary: 'Cancel a confirmed itinerary' })
  @ApiBody({ type: CancelItineraryDto })
  @ApiOkResponse({ description: 'Itinerary cancelled successfully' })
  async cancelItinerary(@Body() dto: CancelItineraryDto) {
    return this.svc.cancelItinerary(dto);
  }

  @Get(':planId/cancellation-options')
  @ApiOperation({
    summary: 'Get cancellable components and their cancellation policies for a confirmed itinerary',
  })
  async getItineraryCancellationOptions(
    @Param('planId', ParseIntPipe) planId: number,
  ) {
    return this.svc.getItineraryCancellationDetails(planId);
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
  async getConfirmedLocations(@Req() req: Request) {
    return this.svc.getLocationsForFilter(req);
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
  async getConfirmedItineraryDetails(
    @Param('confirmedId', ParseIntPipe) confirmedId: number,
    @Req() req: Request,
  ) {
    const access =
      await this.itineraryAccessService.getConfirmedPlanAccessDecision(
        confirmedId,
        (req as any).user,
      );
    if (!access.exists || !access.allowed) return this.denyItineraryAccess(access.redirectTo || '/latest-itinerary');

    return this.svc.getConfirmedItineraryDetails(confirmedId);
  }

  @Get('confirmed/:confirmedId/guides')
  @ApiOperation({ summary: 'List confirmed itinerary guide assignments with slot costs' })
  async getConfirmedGuideAssignments(
    @Param('confirmedId', ParseIntPipe) confirmedId: number,
  ) {
    return this.svc.listConfirmedGuideAssignments(confirmedId);
  }

  @Post('confirmed/:confirmedId/guides/cancel-slot')
  @ApiOperation({ summary: 'Cancel a confirmed itinerary guide slot' })
  async cancelConfirmedGuideSlot(
    @Param('confirmedId', ParseIntPipe) confirmedId: number,
    @Body()
    body: {
      routeGuideId: number;
      guideSlotCostDetailsId: number;
      itineraryRouteId?: number;
      cancellationPercentage?: number;
      defectType?: string;
      reason?: string;
    },
    @Req() req: any,
  ) {
    const userId = Number(req.user?.userId ?? 1);
    return this.svc.cancelConfirmedGuideSlot(confirmedId, body, userId);
  }

  @Get(':id/voucher-details')
  @ApiOperation({ summary: 'Get voucher details for a confirmed itinerary' })
  async getVoucherDetails(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getVoucherDetails(id);
  }

  @Get(':id/voucher-pdf')
  @ApiOperation({ summary: 'Download voucher details PDF for a confirmed itinerary' })
  async downloadVoucherPdf(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ) {
    await this.itineraryPdfService.downloadVoucherPdf(id, res);
  }

  @Get(':id/hotel-voucher-pdf')
  @ApiOperation({ summary: 'Download hotel voucher PDF for a confirmed itinerary' })
  async downloadHotelVoucherPdf(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ) {
    await this.itineraryPdfService.downloadHotelVoucherPdf(id, res);
  }

  @Get(':id/vehicle-voucher-pdf')
  @ApiOperation({ summary: 'Download vehicle voucher PDF for a confirmed itinerary' })
  async downloadVehicleVoucherPdf(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ) {
    await this.itineraryPdfService.downloadVehicleVoucherPdf(id, res);
  }

  @Get(':id/pluck-card-data')
  @ApiOperation({ summary: 'Get pluck card data for a confirmed itinerary' })
  async getPluckCardData(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getPluckCardData(id);
  }

  @Get(':id/pluck-card-pdf')
  @ApiOperation({ summary: 'Download pluck card PDF for a confirmed itinerary' })
  async downloadPluckCardPdf(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ) {
    await this.itineraryPdfService.downloadPluckCardPdf(id, res);
  }

 // Hotel Voucher Endpoints
  @Get(':id/hotel-vouchers/cancellation-policies')
  @ApiOperation({ summary: 'Get all cancellation policies for itinerary hotels' })
  async getAllHotelCancellationPolicies(
    @Param('id', ParseIntPipe) itineraryPlanId: number,
    @Req() req: Request,
  ) {
    this.itineraryAccessService.assertVehicleAgentHotelMutation((req as any).user);
    await this.itineraryAccessService.assertCanViewPlan(itineraryPlanId, (req as any).user);
    return this.hotelVoucherService.getAllCancellationPolicies(itineraryPlanId);
  }

  @Get(':id/hotel-vouchers/:hotelId/cancellation-policies')
  @ApiOperation({ summary: 'Get cancellation policies for a specific hotel' })
  async getHotelCancellationPolicies(
    @Param('id', ParseIntPipe) itineraryPlanId: number,
    @Param('hotelId', ParseIntPipe) hotelId: number,
    @Req() req: Request,
  ) {
    this.itineraryAccessService.assertVehicleAgentHotelMutation((req as any).user);
    await this.itineraryAccessService.assertCanViewPlan(itineraryPlanId, (req as any).user);
    return this.hotelVoucherService.getHotelCancellationPolicies(itineraryPlanId, hotelId);
  }

  @Post(':id/hotel-vouchers/cancellation-policies')
  @ApiOperation({ summary: 'Add a cancellation policy for a hotel' })
  async addCancellationPolicy(
    @Param('id', ParseIntPipe) itineraryPlanId: number,
    @Body() dto: AddCancellationPolicyDto,
    @Req() req: any,
  ) {
    this.itineraryAccessService.assertVehicleAgentHotelMutation((req as any).user);
    await this.itineraryAccessService.assertCanEditPlan(itineraryPlanId, (req as any).user);
    const userId = Number(req.user?.userId ?? 1);
    return this.hotelVoucherService.addCancellationPolicy(
      { ...dto, itineraryPlanId },
      userId,
    );
  }

  @Delete(':id/hotel-vouchers/cancellation-policies/:policyId')
  @ApiOperation({ summary: 'Delete a cancellation policy' })
  async deleteCancellationPolicy(
    @Param('id', ParseIntPipe) itineraryPlanId: number,
    @Param('policyId', ParseIntPipe) policyId: number,
    @Req() req: Request,
  ) {
    this.itineraryAccessService.assertVehicleAgentHotelMutation((req as any).user);
    await this.itineraryAccessService.assertCanEditPlan(itineraryPlanId, (req as any).user);
    return this.hotelVoucherService.deleteCancellationPolicy(policyId);
  }

  @Post(':id/hotel-vouchers')
  @ApiOperation({ summary: 'Create hotel vouchers' })
  async createHotelVouchers(
    @Param('id', ParseIntPipe) itineraryPlanId: number,
    @Body() dto: CreateVoucherDto,
    @Req() req: any,
  ) {
    this.itineraryAccessService.assertVehicleAgentHotelMutation((req as any).user);
    await this.itineraryAccessService.assertCanEditPlan(itineraryPlanId, (req as any).user);
    const userId = Number(req.user?.userId ?? 1);
    return this.hotelVoucherService.createHotelVouchers(
      { ...dto, itineraryPlanId },
      userId,
    );
  }

  @Post(':id/hotel-cancellations')
  @ApiOperation({ summary: 'Cancel hotels for selected routes/hotel details or full itinerary' })
  async cancelHotelVouchers(
    @Param('id', ParseIntPipe) itineraryPlanId: number,
    @Body() dto: CancelHotelVouchersDto,
    @Req() req: any,
  ) {
    this.itineraryAccessService.assertVehicleAgentHotelMutation((req as any).user);
    await this.itineraryAccessService.assertCanEditPlan(itineraryPlanId, (req as any).user);
    const userId = Number(req.user?.userId ?? 1);
    return this.hotelVoucherService.cancelHotelsForItinerary(
      itineraryPlanId,
      dto,
      userId,
    );
  }

  @Get(':id/hotel-vouchers/default-terms')
  @ApiOperation({ summary: 'Get default voucher terms from global settings' })
  async getDefaultVoucherTerms(
    @Param('id', ParseIntPipe) itineraryPlanId: number,
    @Req() req: Request,
  ) {
    this.itineraryAccessService.assertVehicleAgentHotelMutation((req as any).user);
    await this.itineraryAccessService.assertCanViewPlan(itineraryPlanId, (req as any).user);
    return { terms: await this.hotelVoucherService.getDefaultVoucherTerms() };
  }

  @Get(':id/hotel-vouchers/:hotelId')
  @ApiOperation({ summary: 'Get existing voucher for a hotel' })
  async getHotelVoucher(
    @Param('id', ParseIntPipe) itineraryPlanId: number,
    @Param('hotelId', ParseIntPipe) hotelId: number,
    @Req() req: Request,
  ) {
    this.itineraryAccessService.assertVehicleAgentHotelMutation((req as any).user);
    await this.itineraryAccessService.assertCanViewPlan(itineraryPlanId, (req as any).user);
    return this.hotelVoucherService.getHotelVoucher(itineraryPlanId, hotelId);
  }

  @Get(':id/vehicle-vouchers/cancellation-policies')
  @ApiOperation({ summary: 'Get all cancellation policies for itinerary vehicles' })
  async getAllVehicleCancellationPolicies(
    @Param('id', ParseIntPipe) itineraryPlanId: number,
    @Req() req: Request,
  ) {
    await this.itineraryAccessService.assertCanViewPlan(itineraryPlanId, (req as any).user);
    return this.vehicleVoucherService.getAllCancellationPolicies(itineraryPlanId);
  }

  @Get(':id/vehicle-vouchers/:vendorId/:vendorVehicleTypeId/cancellation-policies')
  @ApiOperation({ summary: 'Get cancellation policies for a specific vendor vehicle type' })
  async getVehicleCancellationPolicies(
    @Param('id', ParseIntPipe) itineraryPlanId: number,
    @Param('vendorId', ParseIntPipe) vendorId: number,
    @Param('vendorVehicleTypeId', ParseIntPipe) vendorVehicleTypeId: number,
    @Req() req: Request,
  ) {
    await this.itineraryAccessService.assertCanViewPlan(itineraryPlanId, (req as any).user);
    return this.vehicleVoucherService.getVehicleCancellationPolicies(
      itineraryPlanId,
      vendorId,
      vendorVehicleTypeId,
    );
  }

  @Post(':id/vehicle-vouchers/cancellation-policies')
  @ApiOperation({ summary: 'Add a cancellation policy for a vehicle voucher group' })
  async addVehicleCancellationPolicy(
    @Param('id', ParseIntPipe) itineraryPlanId: number,
    @Body() dto: AddVehicleCancellationPolicyDto,
    @Req() req: any,
  ) {
    await this.itineraryAccessService.assertCanEditPlan(itineraryPlanId, (req as any).user);
    const userId = Number(req.user?.userId ?? 1);
    return this.vehicleVoucherService.addCancellationPolicy(
      { ...dto, itineraryPlanId },
      userId,
    );
  }

  @Delete(':id/vehicle-vouchers/cancellation-policies/:policyId')
  @ApiOperation({ summary: 'Delete a vehicle cancellation policy' })
  async deleteVehicleCancellationPolicy(
    @Param('id', ParseIntPipe) itineraryPlanId: number,
    @Param('policyId', ParseIntPipe) policyId: number,
    @Req() req: Request,
  ) {
    await this.itineraryAccessService.assertCanEditPlan(itineraryPlanId, (req as any).user);
    return this.vehicleVoucherService.deleteCancellationPolicy(policyId);
  }

  @Post(':id/vehicle-vouchers')
  @ApiOperation({ summary: 'Create or update vehicle vouchers' })
  async createVehicleVouchers(
    @Param('id', ParseIntPipe) itineraryPlanId: number,
    @Body() dto: CreateVehicleVoucherDto,
    @Req() req: any,
  ) {
    await this.itineraryAccessService.assertCanEditPlan(itineraryPlanId, (req as any).user);
    const userId = Number(req.user?.userId ?? 1);
    return this.vehicleVoucherService.createVehicleVouchers(
      { ...dto, itineraryPlanId },
      userId,
    );
  }

  @Get(':id/vehicle-vouchers/default-terms')
  @ApiOperation({ summary: 'Get default vehicle voucher terms from global settings' })
  async getDefaultVehicleVoucherTerms(@Param('id', ParseIntPipe) itineraryPlanId: number, @Req() req: Request) {
    await this.itineraryAccessService.assertCanViewPlan(itineraryPlanId, (req as any).user);
    return { terms: await this.vehicleVoucherService.getDefaultVoucherTerms() };
  }

  @Get(':id/vehicle-vouchers/:vendorEligibleId')
  @ApiOperation({ summary: 'Get existing voucher for a vehicle vendor-eligible row' })
  async getVehicleVoucher(
    @Param('id', ParseIntPipe) itineraryPlanId: number,
    @Param('vendorEligibleId', ParseIntPipe) vendorEligibleId: number,
    @Req() req: Request,
  ) {
    await this.itineraryAccessService.assertCanViewPlan(itineraryPlanId, (req as any).user);
    return this.vehicleVoucherService.getVehicleVoucher(itineraryPlanId, vendorEligibleId);
  }

  @Patch(':id/vehicle-vouchers/:vendorEligibleId/confirmation')
  @ApiOperation({ summary: 'Update supplier confirmation details for a vehicle voucher' })
  async updateVehicleVoucherConfirmation(
    @Param('id', ParseIntPipe) itineraryPlanId: number,
    @Param('vendorEligibleId', ParseIntPipe) vendorEligibleId: number,
    @Body() dto: UpdateVehicleVoucherConfirmationDto,
    @Req() req: Request,
  ) {
    await this.itineraryAccessService.assertCanEditPlan(itineraryPlanId, (req as any).user);
    return this.vehicleVoucherService.updateVehicleVoucherConfirmation(
      itineraryPlanId,
      vendorEligibleId,
      dto,
    );
  }

  @Get('confirmed/:confirmedId/pluck-card-data')
  @ApiOperation({ summary: 'Get pluck card data by confirmed plan id' })
  async getPluckCardDataByConfirmedId(@Param('confirmedId', ParseIntPipe) confirmedId: number) {
    return this.svc.getPluckCardDataByConfirmedId(confirmedId);
  }

  @Get(':id/invoice-data')
  @ApiOperation({ summary: 'Get invoice data for a confirmed itinerary' })
  @Public()
  async getInvoiceData(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getInvoiceData(id);
  }

  @Get(':id/invoice-pdf')
  @ApiOperation({ summary: 'Download tax or proforma invoice PDF for a confirmed itinerary' })
  @ApiQuery({ name: 'type', required: false, enum: ['tax', 'proforma'] })
  @Public()
  async downloadInvoicePdf(
    @Param('id', ParseIntPipe) id: number,
    @Query('type') type: 'tax' | 'proforma' = 'tax',
    @Res() res: Response,
  ) {
    const normalizedType = String(type || 'tax').trim().toLowerCase() === 'proforma' ? 'proforma' : 'tax';
    await this.itineraryPdfService.downloadInvoicePdf(id, normalizedType, res);
  }

  @Post(':id/manual-hotspot/preview')
  @ApiOperation({ summary: 'Preview adding a manual hotspot to a route' })
  async previewManualHotspot(
    @Param('id', ParseIntPipe) planId: number,
    @Body()
    body: {
      routeId: number;
      hotspotId: number;
      hotspotIds?: number[];
      anchorType?: 'after_travel';
      anchorIndex?: number;
      allowTopPriorityRemoval?: boolean;
      selectedHotspotIds?: number[];
      debug?: boolean;
    },
  ) {
    const rawHotspotIds = Array.isArray(body.hotspotIds) && body.hotspotIds.length > 0
      ? body.hotspotIds
      : [body.hotspotId, ...(Array.isArray(body.selectedHotspotIds) ? body.selectedHotspotIds : [])];
    const resolvedHotspotIds = Array.from(new Set(
      (rawHotspotIds || [])
        .map((id) => Number(id || 0))
        .filter((id) => Number.isFinite(id) && id > 0),
    ));

    return this.svc.previewManualHotspotsBatch(planId, body.routeId, resolvedHotspotIds, {
      anchorType: body.anchorType,
      anchorIndex: body.anchorIndex,
      allowTopPriorityRemoval: body.allowTopPriorityRemoval === true,
      debug: body.debug === true,
      focusHotspotId: Number(body.hotspotId || 0) > 0 ? Number(body.hotspotId) : undefined,
      previewOnly: true,
    });
  }

  @Post(':id/manual-hotspot')
  @ApiOperation({ summary: 'Add a manual hotspot to a route and rebuild timeline' })
  async addManualHotspot(
    @Param('id', ParseIntPipe) planId: number,
    @Body()
    body: {
      routeId: number;
      hotspotId: number;
      anchorType?: 'after_travel';
      anchorIndex?: number;
      allowTopPriorityRemoval?: boolean;
    },
    @Req() req: any,
  ) {
    const userId = Number(req.user?.userId ?? 1);
    return this.svc.addManualHotspot(planId, body.routeId, body.hotspotId, userId, {
      anchorType: body.anchorType,
      anchorIndex: body.anchorIndex,
      allowTopPriorityRemoval: body.allowTopPriorityRemoval === true,
    });
  }

  @Post(':planId/manual-hotspot/fit-preview')
  @ApiOperation({ summary: 'Preview exact Fit Here manual hotspot insertion and cache the attempt' })
  async previewManualHotspotFitHere(
    @Param('planId', ParseIntPipe) planId: number,
    @Body()
    body: {
      routeId: number;
      selectedHotspotId: number;
      anchor: {
        anchorType?: 'BETWEEN_ROWS' | 'BEFORE_ROW' | 'AFTER_ROW' | 'BEFORE_HOTEL' | 'after_travel';
        anchorIndex?: number;
        anchorIntent?: 'AFTER_START' | 'AFTER_ATTRACTION';
        beforeRowId?: string | number | null;
        afterRowId?: string | number | null;
        beforeRowType?: string | null;      // NEW: accept from frontend
        afterRowType?: string | null;       // NEW: accept from frontend
        beforeHotspotId?: number | null;
        afterHotspotId?: number | null;
        beforeRouteHotspotId?: number | null; // NEW: accept from frontend
        afterRouteHotspotId?: number | null;  // NEW: accept from frontend
        anchorFrom?: string | null;
        anchorTo?: string | null;
        anchorLabel?: string | null;          // NEW: accept from frontend
        anchorTimeRange?: string | null;
      };
      allowP3Removal?: boolean;
      allowP1P2Removal?: boolean;
    },
  ) {
    return this.svc.previewManualHotspotFitHere(planId, body);
  }
  @Post(':planId/manual-hotspot/auto-fit-preview')
  @ApiOperation({ summary: 'Auto-preview selected manual hotspot across all valid Fit Here positions' })
  async previewManualHotspotAutoFitHere(
    @Param('planId', ParseIntPipe) planId: number,
    @Body()
    body: {
      routeId: number;
      selectedHotspotId: number;
      anchors: Array<{
        anchorType?: 'BETWEEN_ROWS';
        anchorIntent?: 'AFTER_START' | 'AFTER_ATTRACTION';
        anchorIndex?: number;
        beforeHotspotId?: number | null;
        afterHotspotId?: number | null;
        beforeRouteHotspotId?: number | null;
        afterRouteHotspotId?: number | null;
        anchorFrom?: string | null;
        anchorTo?: string | null;
        anchorLabel?: string | null;
        anchorTimeRange?: string | null;
        afterRowType?: string | null;
        beforeRowType?: string | null;
      }>;
      allowP3Removal?: boolean;
      allowP1P2Removal?: boolean;
    },
  ) {
    return this.svc.previewManualHotspotAutoFitHere(planId, body);
  }

  @Post(':planId/manual-hotspot/fit-confirm')
  @ApiOperation({ summary: 'Confirm a cached Fit Here manual hotspot insertion attempt' })
  async confirmManualHotspotFitHere(
    @Param('planId', ParseIntPipe) planId: number,
    @Body() body: {
      attemptId: string;
      allowTimingRisk?: boolean;
      allowPriorityRemoval?: boolean;
      allowClosedHotspotConflict?: boolean;
      acknowledgedRemovedHotspotIds?: number[];
    },
    @Req() req: any,
  ) {
    return this.svc.confirmManualHotspotFitHere(
      planId,
      {
        attemptId: String(body?.attemptId || ''),
        allowTimingRisk: body?.allowTimingRisk === true,
        allowPriorityRemoval: body?.allowPriorityRemoval === true,
        allowClosedHotspotConflict: body?.allowClosedHotspotConflict === true,
        acknowledgedRemovedHotspotIds: Array.isArray(body?.acknowledgedRemovedHotspotIds)
          ? body.acknowledgedRemovedHotspotIds.map((id: any) => Number(id)).filter((id: number) => id > 0)
          : [],
      },
      Number(req?.user?.userId || 1),
    );
  }

  @Post(':planId/routes/:routeId/manual-hotspots/:candidateHotspotId/build-matrix')
  @ApiOperation({ summary: 'Build focused manual hotspot matrix for selected route slot pairs' })
  async buildManualHotspotMatrix(
    @Param('planId') planId: string,
    @Param('routeId') routeId: string,
    @Param('candidateHotspotId') candidateHotspotId: string,
    @Req() req: any,
  ) {
    const normalizedPlanId = Number(planId || 0);
    const normalizedRouteId = Number(routeId || 0);
    const normalizedCandidateHotspotId = Number(candidateHotspotId || 0);

    if (!Number.isInteger(normalizedPlanId) || normalizedPlanId <= 0) {
      throw new BadRequestException('planId must be a positive integer');
    }
    if (!Number.isInteger(normalizedRouteId) || normalizedRouteId <= 0) {
      throw new BadRequestException('routeId must be a positive integer');
    }
    if (!Number.isInteger(normalizedCandidateHotspotId) || normalizedCandidateHotspotId <= 0) {
      throw new BadRequestException('candidateHotspotId must be a positive integer');
    }

    return this.svc.buildMissingManualHotspotMatrix({
      planId: normalizedPlanId,
      routeId: normalizedRouteId,
      candidateHotspotId: normalizedCandidateHotspotId,
      userId: Number(req?.user?.userId || 1),
    });
  }

  @Post(':id/manual-hotspots/apply')
  @ApiOperation({ summary: 'Apply manual hotspots to a route as one optimized batch' })
  async applyManualHotspots(
    @Param('id', ParseIntPipe) planId: number,
    @Body()
    body: {
      routeId: number;
      hotspotIds: number[];
      anchorType?: 'after_travel';
      anchorIndex?: number;
      allowTopPriorityRemoval?: boolean;
      forceConflictInsertion?: boolean;
      manualTimingPolicy?: any;
      matrixPreferredSlot?: {
        fromHotspotId?: number;
        toHotspotId?: number;
        slotIndex?: number;
        source?: 'BEST_FIT';
      };
    },
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    const userId = Number(req.user?.userId ?? 1);
    const result: any = await this.svc.applyManualHotspotsBatch(planId, body.routeId, body.hotspotIds, userId, {
      anchorType: body.anchorType,
      anchorIndex: body.anchorIndex,
      allowTopPriorityRemoval: body.allowTopPriorityRemoval === true,
      forceConflictInsertion: body.forceConflictInsertion === true,
      manualTimingPolicy: body.manualTimingPolicy,
      matrixPreferredSlot: body.matrixPreferredSlot,
    });

    if (String(result?.code || '') === 'MANUAL_INSERT_EXCEEDS_DAY_END') {
      res.status(409);
    } else if (
      result?.success === false
      || (
        result?.inserted === false
        && String(result?.code || '') !== 'MANUAL_HOTSPOT_ALREADY_EXISTS_IN_ROUTE'
      )
    ) {
      res.status(409);
    }

    return result;
  }

  @Delete(':id/manual-hotspot/:hotspotId')
  @ApiOperation({ summary: 'Remove a manual hotspot and rebuild timeline' })
  async removeManualHotspot(
    @Param('id', ParseIntPipe) planId: number,
    @Param('hotspotId', ParseIntPipe) hotspotId: number,
    @Req() req: any,
  ) {
    const userId = Number(req.user?.userId ?? 1);
    return this.svc.removeManualHotspot(planId, hotspotId, userId);
  }

  @Post(':id/route/:routeId/rebuild')
  @ApiOperation({ summary: 'Rebuild hotspots for a route (clears exclusions and rebuilds fresh)' })
  @ApiParam({ name: 'id', example: 33977, description: 'Plan ID' })
  @ApiParam({ name: 'routeId', example: 207447, description: 'Route ID' })
  async rebuildRoute(
    @Param('id', ParseIntPipe) planId: number,
    @Param('routeId', ParseIntPipe) routeId: number,
    @Req() req: any,
  ) {
    const userId = Number(req.user?.userId ?? 1);
    return this.svc.rebuildRouteHotspotsForDay(planId, routeId, userId);
  }

  @Post(':planId/routes/:routeId/rebuild-hotspots')
  @ApiOperation({ summary: 'Reset and rebuild hotspots for a specific day/route' })
  @ApiParam({ name: 'planId', example: 33977, description: 'Plan ID' })
  @ApiParam({ name: 'routeId', example: 207447, description: 'Route ID' })
  async rebuildRouteHotspotsForDay(
    @Param('planId', ParseIntPipe) planId: number,
    @Param('routeId', ParseIntPipe) routeId: number,
    @Req() req: any,
  ) {
    const userId = Number(req.user?.userId ?? 1);
    return this.svc.rebuildRouteHotspotsForDay(planId, routeId, userId);
  }

  @Patch(':id/route/:routeId/times')
  @ApiOperation({ summary: 'Update route start and end times' })
  async updateRouteTimes(
    @Param('id', ParseIntPipe) planId: number,
    @Param('routeId', ParseIntPipe) routeId: number,
    @Body()
    body: {
      startTime: string;
      endTime: string;
      previousDayBillingDecisionProvided?: boolean;
      previousDayBillingConfirmed?: boolean;
      transportEarlyArrivalOption?: TransportEarlyArrivalOption | null;
      transportEarlyArrivalHotelName?: string | null;
      transportEarlyArrivalRestMinutes?: number | null;
      changeType?: 'ROUTE_START' | 'ROUTE_END' | 'FINAL_DAY_DEPARTURE';
    },
    @Req() req: any,
  ) {
    const userId = Number(req.user?.userId ?? 1);
    return this.svc.updateRouteTimes(
      planId,
      routeId,
      body.startTime,
      body.endTime,
      body.previousDayBillingDecisionProvided,
      body.previousDayBillingConfirmed,
      body.transportEarlyArrivalOption,
      body.transportEarlyArrivalHotelName,
      body.transportEarlyArrivalRestMinutes,
      body.changeType,
      userId,
    );
  }

  @Post(':id/cross-day-optimizer/dry-run')
  @ApiOperation({ summary: 'Dry-run the same-city cross-day hotspot optimizer' })
  async dryRunSameCityCrossDayOptimizer(
    @Param('id', ParseIntPipe) planId: number,
    @Body()
    body: {
      quoteId?: string;
      maxMoves?: number;
    },
  ) {
    return this.sameCityCrossDayOptimizerService.analyzePlanId(planId, {
      quoteId: body?.quoteId,
      dryRun: true,
      maxMoves: body?.maxMoves,
    });
  }

  @Post(':id/cross-day-optimizer/apply')
  @ApiOperation({ summary: 'Apply the same-city cross-day hotspot optimizer' })
  async applySameCityCrossDayOptimizer(
    @Param('id', ParseIntPipe) planId: number,
    @Body()
    body: {
      quoteId?: string;
      maxMoves?: number;
    },
    @Req() req: any,
  ) {
    const userId = Number(req.user?.userId ?? 1);
    const result = await this.sameCityCrossDayOptimizerService.analyzePlanId(planId, {
      quoteId: body?.quoteId,
      dryRun: false,
      maxMoves: body?.maxMoves,
    });

    return {
      ...result,
      requestedByUserId: userId,
    };
  }

  @Post('templates/save')
  @ApiOperation({ summary: 'Save reusable itinerary template from an existing plan' })
  async saveReusableTemplate(
    @Body() body: { planId: number; templateName?: string },
    @Req() req: any,
  ) {
    const userId = Number(req.user?.userId ?? 1);
    return this.svc.saveReusableTemplate(body, userId);
  }

  @Get('templates/match')
  @ApiOperation({ summary: 'Load latest reusable itinerary template by source, destination, and day count' })
  async getReusableTemplateMatch(
    @Query('sourceLocation') sourceLocation: string,
    @Query('destinationLocation') destinationLocation: string,
    @Query('dayCount') dayCount: string,
    @Query('scope') scope?: string,
  ) {
    const parsedDayCount = Number(dayCount || 0);
    if (!Number.isInteger(parsedDayCount) || parsedDayCount <= 0) {
      throw new BadRequestException('dayCount must be a positive integer');
    }

    return this.svc.getReusableTemplateMatch(
      sourceLocation,
      destinationLocation,
      parsedDayCount,
      scope,
    );
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
  async getHotelRoomCategories(@Query() query: GetHotelRoomCategoriesDto, @Req() req: Request) {
    this.itineraryAccessService.assertVehicleAgentHotelMutation((req as any).user);
    await this.itineraryAccessService.assertCanViewPlan(Number(query.itinerary_plan_id), (req as any).user);
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
      hotel_code: query.hotel_code,
      provider: query.provider,
      hotel_name: query.hotel_name,
    });
  }

  @Post('hotel-rooms/update-category')
  @ApiOperation({ summary: 'Update room category selection' })
  @ApiBody({ type: UpdateRoomCategoryDto })
  async updateRoomCategory(@Body() dto: UpdateRoomCategoryDto, @Req() req: Request) {
    this.itineraryAccessService.assertVehicleAgentHotelMutation((req as any).user);
    await this.itineraryAccessService.assertCanEditPlan(Number(dto.itinerary_plan_id), (req as any).user);
    return this.svc.updateRoomCategory({
      itinerary_plan_hotel_room_details_ID: dto.itinerary_plan_hotel_room_details_ID,
      itinerary_plan_hotel_details_ID: dto.itinerary_plan_hotel_details_ID,
      itinerary_plan_id: dto.itinerary_plan_id,
      itinerary_route_id: dto.itinerary_route_id,
      hotel_id: dto.hotel_id,
      group_type: dto.group_type,
      hotel_code: dto.hotel_code,
      provider: dto.provider,
      hotel_name: dto.hotel_name,
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
    @Req() req: Request,
    @Query('groupType') groupType?: string,
  ) {
    const access = await this.itineraryAccessService.getPlanAccessDecision(
      id,
      (req as any).user,
    );
    if (!access.exists || !access.allowed) return this.denyItineraryAccess(access.redirectTo || '/latest-itinerary');

    const groupTypeNum = groupType ? Number(groupType) : undefined;
    return this.detailsService.findOne(id, groupTypeNum, (req as any)?.user?.role);
  }
}
