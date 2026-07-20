import { BadRequestException, ConflictException, Injectable, InternalServerErrorException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { CreateItineraryDto } from '../dto/create-itinerary.dto';
import { PlanEngineService } from '../engines/plan-engine.service';
import { RouteEngineService } from '../engines/route-engine.service';
import { HotspotEngineService } from '../engines/hotspot-engine.service';
import { HotelEngineService } from '../engines/hotel-engine.service';
import { TravellersEngineService } from '../engines/travellers-engine.service';
import { ViaRoutesEngine } from '../engines/via-routes.engine';
import { RouteValidationService } from '../validation/route-validation.service';
import { ItineraryVehicleBuildService } from './itinerary-vehicle-build.service';
import { TransportEarlyArrivalValidationService } from '../validation/transport-early-arrival-validation.service';
import { RouteVehicleRestrictionService } from '../../route-vehicle-restrictions/route-vehicle-restriction.service';

type RouteFamilyQuote = {
  baseQuoteId: string;
  routeVariantIndex: number | null;
};

@Injectable()
export class ItineraryPlanPersistenceService {
  private optimizeRouteOrderFn: ((routes: any[]) => Promise<any[]>) | null = null;
  private applySameCityOptimizerFn: ((planId: number, quoteId?: string | null) => Promise<void>) | null = null;
  private getPlanForEditFn: ((planId: number) => Promise<any>) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly planEngine: PlanEngineService,
    private readonly routeEngine: RouteEngineService,
    private readonly hotspotEngine: HotspotEngineService,
    private readonly hotelEngine: HotelEngineService,
    private readonly travellersEngine: TravellersEngineService,
    private readonly viaRoutesEngine: ViaRoutesEngine,
    private readonly routeValidation: RouteValidationService,
    private readonly vehicleBuildService: ItineraryVehicleBuildService,
    private readonly transportEarlyArrivalValidation: TransportEarlyArrivalValidationService,
    private readonly routeVehicleRestrictions: RouteVehicleRestrictionService,
  ) {}

  setCallbacks(callbacks: {
    optimizeRouteOrder: (routes: any[]) => Promise<any[]>;
    applySameCityOptimizer: (planId: number, quoteId?: string | null) => Promise<void>;
    getPlanForEdit: (planId: number) => Promise<any>;
  }): void {
    this.optimizeRouteOrderFn = callbacks.optimizeRouteOrder;
    this.applySameCityOptimizerFn = callbacks.applySameCityOptimizer;
    this.getPlanForEditFn = callbacks.getPlanForEdit;
  }

  private async optimizeRouteOrder(routes: any[]): Promise<any[]> {
    if (!this.optimizeRouteOrderFn) throw new Error('Route optimizer is not configured');
    return this.optimizeRouteOrderFn(routes);
  }

  private async applySameCityCrossDayOptimizerAfterSave(planId: number, quoteId?: string | null): Promise<void> {
    if (!this.applySameCityOptimizerFn) throw new Error('Same-city optimizer is not configured');
    return this.applySameCityOptimizerFn(planId, quoteId);
  }

  private async getPlanForEdit(planId: number): Promise<any> {
    if (!this.getPlanForEditFn) throw new Error('Plan edit reader is not configured');
    return this.getPlanForEditFn(planId);
  }

  private logItineraryApiTiming(params: {
    api: 'save_basic_info';
    step: string;
    startedAt: number;
    stepStartedAt: number;
    planId?: number | null;
    quoteId?: string | null;
  }): number {
    const now = Date.now();
    console.log('[ITINERARY_API_TIMING]', {
      api: params.api,
      planId: params.planId ?? null,
      quoteId: params.quoteId ?? null,
      step: params.step,
      durationMs: now - params.stepStartedAt,
      totalElapsedMs: now - params.startedAt,
    });
    return now;
  }

  private parseRouteFamilyQuote(quoteId: string | undefined | null): RouteFamilyQuote | null {
    const raw = String(quoteId || '').trim();
    if (!raw) return null;
    const match = raw.match(/^(.*)-R(\d+)$/i);
    if (!match) return { baseQuoteId: raw, routeVariantIndex: null };

    const baseQuoteId = String(match[1] || '').trim();
    const routeVariantIndex = Number.parseInt(String(match[2] || ''), 10);
    if (!baseQuoteId || !Number.isFinite(routeVariantIndex) || routeVariantIndex <= 0) {
      return { baseQuoteId: raw, routeVariantIndex: null };
    }
    return { baseQuoteId, routeVariantIndex };
  }

  async createPlan(
    dto: CreateItineraryDto,
    req: any,
    shouldOptimizeRoute: boolean = false,
    requestType?: string,
  ) {
    const apiStartedAt = Date.now();
    let stepStartedAt = apiStartedAt;
    const debugVehicleTrace =
      process.env.DEBUG_DVI20260594_INSERT === 'true' ||
      process.env.DEBUG_VEHICLE_DUPLICATE_TRACE === 'true';
    if (process.env.DEBUG_DVI20260594_INSERT === 'true') {
      console.log('[CREATE_API_ENTRY]', {
        type: requestType,
        itinerary_plan_id: Number((dto as any)?.plan?.itinerary_plan_id || 0),
        routes: (dto?.routes || []).map((r: any) => ({
          location_name: r?.location_name,
          next_visiting_location: r?.next_visiting_location,
          no_of_km: r?.no_of_km,
        })),
        vehicles: dto?.vehicles || [],
      });
    }
    if (debugVehicleTrace) {
      console.log('[CREATE_PLAN_ENTRY]', {
        planId: Number((dto as any)?.plan?.itinerary_plan_id || 0),
        vehicles: dto?.vehicles || [],
        routesCount: Array.isArray(dto?.routes) ? dto.routes.length : 0,
      });
    }
    const u: any = (req as any).user ?? {};
    const userId = Number(u.userId ?? 1);
    const agentId = Number(u.agentId ?? 0);
    const staffId = Number(u.staffId ?? 0);
    const shouldCheckLocalDbHotels =
      String(process.env.LOCAL_DB_HOTEL_CHECK || 'true').toLowerCase() === 'true';

    // If user is an agent, force their agentId
    if (agentId > 0) {
      dto.plan.agent_id = agentId;
    }
    // If user is a staff/travel expert, force their staffId
    if (staffId > 0) {
      dto.plan.staff_id = staffId;
    }

    let createPlanStage = 'route_optimization';
    try {

    // 🚀 ROUTE OPTIMIZATION: If requested, optimize route order before saving
    if (shouldOptimizeRoute && dto.routes && dto.routes.length > 0) {
      console.log('[ItinerariesService] 🔄 Route optimization REQUESTED');
      console.log('[ItinerariesService] 📍 Original route order:', dto.routes.map((r: any) => `${r.location_name}→${r.next_visiting_location}`).join(' | '));
      dto.routes = await this.optimizeRouteOrder(dto.routes);
      console.log('[ItinerariesService] ✅ Routes optimized and reordered');
      console.log('[ItinerariesService] 📍 New route order:', dto.routes.map((r: any) => `${r.location_name}→${r.next_visiting_location}`).join(' | '));
    } else {
      console.log('[ItinerariesService] ⚠️  Route optimization NOT triggered. shouldOptimizeRoute=', shouldOptimizeRoute, 'routeCount=', dto.routes?.length);
    }
    stepStartedAt = this.logItineraryApiTiming({
      api: 'save_basic_info',
      step: 'route_optimization',
      startedAt: apiStartedAt,
      stepStartedAt,
      planId: Number((dto as any)?.plan?.itinerary_plan_id || 0),
    });

    const perfStart = Date.now();
    createPlanStage = 'pre_transaction_validation';

    this.transportEarlyArrivalValidation.validate(dto.plan);
    await this.routeVehicleRestrictions.assertCreateRequest(dto);

    // Validate hotel availability BEFORE starting the transaction
    // Only validate if hotels are needed (itinerary_preference 1 or 3)
    if (
      shouldCheckLocalDbHotels &&
      (dto.plan.itinerary_preference === 1 || dto.plan.itinerary_preference === 3)
    ) {
      const categoryStr = String(dto.plan.preferred_hotel_category || '');
      const categories = categoryStr
        .split(',')
        .map((c) => Number(c.trim()))
        .filter((c) => c > 0);
      const preferredCategory = categories[0] || 2;

      try {
        const validations = await this.routeValidation.validateHotelAvailability(
          dto.routes,
          preferredCategory
        );
        
        // Log successful validation
        console.log('[ItinerariesService] Hotel validation passed:', validations.length, 'routes checked');
      } catch (error) {
        // Re-throw BadRequestException with hotel availability details
        if (error instanceof BadRequestException) {
          throw error;
        }
        // Handle unexpected validation errors
        throw new BadRequestException({
          message: 'Failed to validate hotel availability',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (!shouldCheckLocalDbHotels) {
      console.log('[ItinerariesService] LOCAL_DB_HOTEL_CHECK disabled, skipping local hotel availability validation');
    }
    stepStartedAt = this.logItineraryApiTiming({
      api: 'save_basic_info',
      step: 'pre_transaction_validation',
      startedAt: apiStartedAt,
      stepStartedAt,
      planId: Number((dto as any)?.plan?.itinerary_plan_id || 0),
    });

    const txStart = Date.now();
    createPlanStage = 'transaction_rebuild';
    const normalizedRequestType = String(requestType || '').trim().toLowerCase();
    const isFullBasicInfoRebuildType =
      normalizedRequestType === 'itineary_basic_info'
      || normalizedRequestType === 'itineary_basic_info_with_optimized_route';
    const isPlanUpdate = Number((dto?.plan as any)?.itinerary_plan_id || 0) > 0;
    const shouldResetManualHotspotsForFullRebuild = isFullBasicInfoRebuildType && isPlanUpdate;
    
    // Increase interactive transaction timeout; hotspot rebuild + hotel lookups can exceed default 5s
    const result = await this.prisma.$transaction(async (tx) => {
      const opStart = Date.now();
      const planId = await this.planEngine.upsertPlanHeader(
        dto.plan,
        dto.travellers,
        tx,
        userId,
      );
      stepStartedAt = this.logItineraryApiTiming({
        api: 'save_basic_info',
        step: 'plan_lookup_upsert',
        startedAt: apiStartedAt,
        stepStartedAt,
        planId,
      });
      console.log('[PERF] upsertPlanHeader:', Date.now() - opStart, 'ms');

      // ⚡ PRESERVE HOTSPOT CONTEXT: Fetch existing hotspots and their route dates BEFORE routes are deleted
      // This ensures that when we rebuild hotspots later, we know which day each "tombstone" (deleted hotspot) belonged to.
      const oldRoutes = await (tx as any).dvi_itinerary_route_details.findMany({
        where: { itinerary_plan_ID: planId },
        select: { itinerary_route_ID: true, itinerary_route_date: true }
      });
      const oldRouteDateMap = new Map(oldRoutes.map((r: any) => [r.itinerary_route_ID, r.itinerary_route_date]));
      
      if (shouldResetManualHotspotsForFullRebuild) {
        const manualCleanupResult = await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
          where: {
            itinerary_plan_ID: planId,
            item_type: 4,
            hotspot_plan_own_way: 1,
            deleted: 0,
          },
          data: {
            deleted: 1,
            status: 0,
            updatedon: new Date(),
          },
        });

        console.log('[RebuildManualCleanup][beforeRebuild]', {
          planId,
          requestType: normalizedRequestType,
          updatedRows: Number((manualCleanupResult as any)?.count || 0),
        });
      }

      // Preserve only generated hotspots for full basic-info rebuild.
      const oldHotspots = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_plan_ID: planId,
          item_type: 4,
          deleted: 0,
          status: 1,
          hotspot_plan_own_way: { not: 1 },
        }
      });
      
      const existingHotspotsWithDates = oldHotspots.map((h: any) => ({
        ...h,
        route_date: oldRouteDateMap.get(h.itinerary_route_ID)
      }));

      // Some environments enforce FK constraints from route-linked tables to route_details.
      // Clear old route-linked rows before deleting/recreating routes to avoid update 500s.
      if (isPlanUpdate) {
        const oldRouteIds = oldRoutes
          .map((r: any) => Number(r?.itinerary_route_ID || 0))
          .filter((id: number) => Number.isFinite(id) && id > 0);

        if (oldRouteIds.length > 0) {
          await (tx as any).dvi_itinerary_route_hotspot_parking_charge.deleteMany({
            where: {
              itinerary_plan_ID: planId,
              itinerary_route_ID: { in: oldRouteIds },
            },
          });

          await (tx as any).dvi_itinerary_route_hotspot_details.deleteMany({
            where: {
              itinerary_plan_ID: planId,
              itinerary_route_ID: { in: oldRouteIds },
            },
          });

          await (tx as any).dvi_itinerary_via_route_details.deleteMany({
            where: {
              itinerary_plan_ID: planId,
              itinerary_route_ID: { in: oldRouteIds },
            },
          });

          await (tx as any).dvi_itinerary_plan_route_permit_charge.deleteMany({
            where: {
              itinerary_plan_ID: planId,
              itinerary_route_ID: { in: oldRouteIds },
            },
          });
        }
      }

      let opStart2 = Date.now();
      const routes = await this.routeEngine.rebuildRoutes(
        planId,
        dto.plan,
        dto.routes,
        tx,
        userId,
      );
      stepStartedAt = this.logItineraryApiTiming({
        api: 'save_basic_info',
        step: 'routes_lookup_rebuild',
        startedAt: apiStartedAt,
        stepStartedAt,
        planId,
      });
      console.log('[PERF] rebuildRoutes:', Date.now() - opStart2, 'ms');
      console.log('[ITINERARY_BASIC_INFO_BUILD_PATH]', {
        planId,
        type: normalizedRequestType || null,
        routeCount: Array.isArray(routes) ? routes.length : 0,
        callsTimelineBuilder: true,
      });
      for (const r of (routes || [])) {
        console.log('[ROUTE_PERSISTED_DEBUG]', {
          itinerary_route_ID: Number((r as any)?.itinerary_route_ID || 0),
          location_id: Number((r as any)?.location_id || 0),
          location_name: String((r as any)?.location_name || ''),
          next_visiting_location: String((r as any)?.next_visiting_location || ''),
          no_of_km: Number((r as any)?.no_of_km || 0),
          direct_to_next_visiting_place: Number((r as any)?.direct_to_next_visiting_place || 0),
          via_route: String((r as any)?.via_route || ''),
          via_routes: (r as any)?.via_routes ?? [],
        });
      }

      // Rebuild via routes AFTER routes are created and BEFORE hotspots
      opStart2 = Date.now();
      const routeIds = routes.map((r: any) => r.itinerary_route_ID);
      await this.viaRoutesEngine.rebuildViaRoutes(tx, planId, dto.routes, routeIds, userId);
      stepStartedAt = this.logItineraryApiTiming({
        api: 'save_basic_info',
        step: 'location_dropdown_lookup_via_routes',
        startedAt: apiStartedAt,
        stepStartedAt,
        planId,
      });
      console.log('[PERF] rebuildViaRoutes:', Date.now() - opStart2, 'ms');

      // Via routes are part of the permit location chain, so permits must be
      // rebuilt after the via-route rows have been persisted.
      opStart2 = Date.now();
      await this.routeEngine.rebuildPermitCharges(tx, planId, userId);
      stepStartedAt = this.logItineraryApiTiming({
        api: 'save_basic_info',
        step: 'permit_calculation_after_via_routes',
        startedAt: apiStartedAt,
        stepStartedAt,
        planId,
      });
      console.log('[PERF] rebuildPermitChargesAfterViaRoutes:', Date.now() - opStart2, 'ms');

      opStart2 = Date.now();
      await this.planEngine.updateNoOfRoutes(planId, tx);
      console.log('[PERF] updateNoOfRoutes:', Date.now() - opStart2, 'ms');

      opStart2 = Date.now();
      await this.travellersEngine.rebuildTravellers(
        planId,
        dto.travellers,
        tx,
        userId,
      );
      stepStartedAt = this.logItineraryApiTiming({
        api: 'save_basic_info',
        step: 'traveller_lookup_rebuild',
        startedAt: apiStartedAt,
        stepStartedAt,
        planId,
      });
      console.log('[PERF] rebuildTravellers:', Date.now() - opStart2, 'ms');

      if (
        dto.plan.itinerary_preference === 1 ||
        dto.plan.itinerary_preference === 3
      ) {
        opStart2 = Date.now();
        await this.hotelEngine.rebuildPlanHotels(
          planId,
          tx,
          userId,
          
        );

        const firstHotelRoute = (routes || [])[0] as any;
        const arrivalTimeMatch = String(dto.plan.trip_start_date || '').match(
          /T(\d{2}):(\d{2})(?::(\d{2}))?/,
        );
        const arrivalSeconds = arrivalTimeMatch
          ? (Number(arrivalTimeMatch[1]) * 3600) +
            (Number(arrivalTimeMatch[2]) * 60) +
            Number(arrivalTimeMatch[3] || 0)
          : -1;
        const shouldApplyPreviousDayBilling =
          (Number(dto.plan.itinerary_preference) === 1 ||
            Number(dto.plan.itinerary_preference) === 3) &&
          Boolean(dto.previousDayBillingDecisionProvided) &&
          Boolean(dto.previousDayBillingConfirmed) &&
          arrivalSeconds >= 3600 &&
          arrivalSeconds < 28800 &&
          Number(firstHotelRoute?.itinerary_route_ID || 0) > 0;

        if (shouldApplyPreviousDayBilling) {
          const firstRouteDate = new Date(firstHotelRoute.itinerary_route_date);
          if (!Number.isNaN(firstRouteDate.getTime())) {
            const actualGuestArrivalAt = new Date(Date.UTC(
              firstRouteDate.getUTCFullYear(),
              firstRouteDate.getUTCMonth(),
              firstRouteDate.getUTCDate(),
              Number(arrivalTimeMatch?.[1] || 0),
              Number(arrivalTimeMatch?.[2] || 0),
              Number(arrivalTimeMatch?.[3] || 0),
            ));
            const previousDayDate = new Date(Date.UTC(
              firstRouteDate.getUTCFullYear(),
              firstRouteDate.getUTCMonth(),
              firstRouteDate.getUTCDate(),
              0,
              0,
              0,
            ));
            previousDayDate.setUTCDate(previousDayDate.getUTCDate() - 1);

            const hotelCheckOutDate = new Date(Date.UTC(
              firstRouteDate.getUTCFullYear(),
              firstRouteDate.getUTCMonth(),
              firstRouteDate.getUTCDate(),
              0,
              0,
              0,
            ));
            hotelCheckOutDate.setUTCDate(hotelCheckOutDate.getUTCDate() + 1);

            const routeLocation = String(
              firstHotelRoute.next_visiting_location ||
              firstHotelRoute.location_name ||
              '',
            ).trim();
            const blockedFromDateIso = previousDayDate.toISOString().slice(0, 10);
            const actualArrivalDateIso = String(dto.plan.trip_start_date).slice(0, 10);
            const actualArrivalTime = arrivalTimeMatch
              ? `${arrivalTimeMatch[1]}:${arrivalTimeMatch[2]}:${arrivalTimeMatch[3] || '00'}`
              : '';
            const earlyCheckInNote =
              `Guest has opted for early morning check-in with extra payment. ` +
              `Room to be blocked from ${blockedFromDateIso}, with actual guest arrival/check-in ` +
              `on ${actualArrivalDateIso} at ${actualArrivalTime}.`;

            await (tx as any).dvi_itinerary_plan_hotel_details.createMany({
              data: [1, 2, 3, 4].map((groupType) => ({
                group_type: groupType,
                itinerary_plan_id: planId,
                itinerary_route_id: Number(firstHotelRoute.itinerary_route_ID),
                itinerary_route_date: previousDayDate,
                itinerary_route_location: routeLocation || null,
                hotel_required: 2,
                hotel_id: 0,
                total_no_of_rooms: 0,
                total_hotel_cost: 0,
                total_hotel_tax_amount: 0,
                createdby: userId,
                createdon: new Date(),
                status: 1,
                deleted: 0,
              })),
            });

            await (tx as any).dvi_itinerary_plan_hotel_details.updateMany({
              where: {
                itinerary_plan_id: planId,
                itinerary_route_id: Number(firstHotelRoute.itinerary_route_ID),
                hotel_required: 1,
                hotel_id: { gt: 0 },
                deleted: 0,
              },
              data: {
                hotel_check_in_date: previousDayDate,
                actual_guest_arrival_at: actualGuestArrivalAt,
                hotel_check_out_date: hotelCheckOutDate,
                early_checkin: 1,
                early_checkin_extra_payment_applicable: 1,
                early_checkin_payment_status: 'EXTRA_PAYMENT_APPLICABLE',
                early_checkin_note: earlyCheckInNote,
                updatedon: new Date(),
              },
            });
          }
        }
        stepStartedAt = this.logItineraryApiTiming({
          api: 'save_basic_info',
          step: 'hotel_details_lookup_rebuild',
          startedAt: apiStartedAt,
          stepStartedAt,
          planId,
        });
        console.log('[PERF] rebuildPlanHotels:', Date.now() - opStart2, 'ms');
      }

      opStart2 = Date.now();
      await this.hotspotEngine.rebuildRouteHotspots(tx, planId, existingHotspotsWithDates);
      await this.routeVehicleRestrictions.assertPersistedPlan(planId, 'create-itinerary-timeline', tx);
      stepStartedAt = this.logItineraryApiTiming({
        api: 'save_basic_info',
        step: 'hotspot_details_lookup_rebuild',
        startedAt: apiStartedAt,
        stepStartedAt,
        planId,
      });
      console.log('[PERF] rebuildRouteHotspots:', Date.now() - opStart2, 'ms');

      if (shouldResetManualHotspotsForFullRebuild) {
        const staleManualCleanupResult = await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
          where: {
            itinerary_plan_ID: planId,
            item_type: 4,
            hotspot_plan_own_way: 1,
            deleted: 0,
          },
          data: {
            deleted: 1,
            status: 0,
            updatedon: new Date(),
          },
        });

        console.log('[RebuildManualCleanup][afterRebuild]', {
          planId,
          requestType: normalizedRequestType,
          updatedRows: Number((staleManualCleanupResult as any)?.count || 0),
        });
      }

      opStart2 = Date.now();
      const planRow = await (tx as any).dvi_itinerary_plan_details.findUnique({
        where: { itinerary_plan_ID: planId },
        select: { itinerary_quote_ID: true },
      });
      stepStartedAt = this.logItineraryApiTiming({
        api: 'save_basic_info',
        step: 'transaction_rebuild_complete',
        startedAt: apiStartedAt,
        stepStartedAt,
        planId,
        quoteId: String(planRow?.itinerary_quote_ID || ''),
      });
      console.log('[PERF] getPlanRow:', Date.now() - opStart2, 'ms');
      console.log('[PERF] TOTAL TRANSACTION:', Date.now() - txStart, 'ms');

      return {
        planId,
        quoteId: planRow?.itinerary_quote_ID,
        routeIds: routes.map((r: any) => r.itinerary_route_ID),
        message:
          "Plan created/updated with routes, travellers, hotspots, and hotels.",
      };
    }, { timeout: 120000, maxWait: 20000 }); // Increased to 120s while we optimize further

    // Rebuild parking charges AFTER routes and hotspots
    createPlanStage = 'post_transaction_parking_rebuild';
    let postStart = Date.now();
    try {
      await this.hotspotEngine.rebuildParkingCharges(result.planId, userId);
      stepStartedAt = this.logItineraryApiTiming({
        api: 'save_basic_info',
        step: 'parking_calculation',
        startedAt: apiStartedAt,
        stepStartedAt,
        planId: result.planId,
        quoteId: String(result?.quoteId || ''),
      });
      console.log('[PERF] rebuildParkingCharges:', Date.now() - postStart, 'ms');
    } catch (parkingError: any) {
      console.error('[ItinerariesService] rebuildParkingCharges failed (continuing createPlan response):', {
        planId: result.planId,
        message: String(parkingError?.message || parkingError || 'Unknown parking rebuild error'),
      });
    }

    const shouldBuildVehicles =
      Number(dto?.plan?.itinerary_preference || 0) === 2 ||
      Number(dto?.plan?.itinerary_preference || 0) === 3;

    if (shouldBuildVehicles) {
      createPlanStage = 'post_transaction_vehicle_build_sync';
      const buildRunId = this.vehicleBuildService.createBuildRunId(result.planId);
      await this.vehicleBuildService.startRecord(result.planId, buildRunId, userId);
      void this.vehicleBuildService.buildVehiclesSynchronously(
        result.planId,
        Array.isArray(dto.vehicles) ? dto.vehicles : [],
        userId,
        result?.quoteId ? String(result.quoteId) : undefined,
        { buildRunId },
      ).catch((error) => {
        console.error('[ItinerariesService] Background vehicle build failed:', {
          planId: result.planId,
          message: String(error?.message || error || 'Unknown vehicle build error'),
          buildRunId,
        });
      });
      stepStartedAt = this.logItineraryApiTiming({
        api: 'save_basic_info',
        step: 'vehicle_details_lookup_and_sync_build',
        startedAt: apiStartedAt,
        stepStartedAt,
        planId: result.planId,
        quoteId: String(result?.quoteId || ''),
      });
    }

    if (isFullBasicInfoRebuildType) {
      createPlanStage = 'post_transaction_cross_day_optimizer';
      try {
        await this.applySameCityCrossDayOptimizerAfterSave(
          result.planId,
          String(result?.quoteId || ''),
        );
      } catch (optimizerError) {
        console.error('[ItinerariesService] same-city cross-day optimizer failed (continuing createPlan response):', {
          planId: result.planId,
          message: String((optimizerError as any)?.message || optimizerError || 'Unknown optimizer error'),
        });
      }
    }

    // Step 10: Persist a reusable template snapshot for this itinerary shape.
    createPlanStage = 'post_transaction_template_snapshot';
    try {
      await this.saveReusableTemplateFromPlan(result.planId, userId);
    } catch (templateError) {
      console.error('[ItinerariesService] Failed to persist reusable template:', templateError);
    }
    stepStartedAt = this.logItineraryApiTiming({
      api: 'save_basic_info',
      step: 'final_response_mapping',
      startedAt: apiStartedAt,
      stepStartedAt,
      planId: result.planId,
      quoteId: String(result?.quoteId || ''),
    });

    console.log('[PERF] TOTAL createPlan:', Date.now() - perfStart, 'ms');

    const parsedRouteFamilyQuote = this.parseRouteFamilyQuote(String(result?.quoteId || ''));

    return {
      ...result,
      routeFamilyBaseQuoteId: parsedRouteFamilyQuote?.baseQuoteId ?? null,
      routeVariantIndex: parsedRouteFamilyQuote?.routeVariantIndex ?? null,
      vehicleBuildStatus: shouldBuildVehicles ? 'PROCESSING' : undefined,
    };
    } catch (error: any) {
      const message = String(error?.message || error || 'Unknown createPlan failure');
      if (error instanceof BadRequestException || error instanceof NotFoundException || error instanceof ConflictException || error instanceof UnprocessableEntityException) {
        throw error;
      }

      throw new InternalServerErrorException('Internal server error');
    }
  }

  async saveReusableTemplate(data: { planId: number; templateName?: string }, userId: number) {
    const planId = Number(data?.planId || 0);
    if (!planId) {
      throw new BadRequestException('planId is required');
    }

    return this.saveReusableTemplateFromPlan(planId, userId, data?.templateName);
  }

  async getReusableTemplateMatch(
    sourceLocation: string,
    destinationLocation: string,
    dayCount: number,
    scope?: string,
  ) {
    const source = String(sourceLocation || '').trim();
    const destination = String(destinationLocation || '').trim();
    const days = Number(dayCount || 0);
    const templateScope = String(scope || 'full').trim().toLowerCase();

    if (!source || !destination || !days) {
      throw new BadRequestException('sourceLocation, destinationLocation, and dayCount are required');
    }

    await this.ensureReusableTemplateTable();

    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
      SELECT
        template_id,
        source_location,
        destination_location,
        day_count,
        template_name,
        template_payload,
        metadata_payload,
        created_from_plan_id,
        createdon
      FROM dvi_itinerary_reusable_templates
      WHERE deleted = 0
        AND status = 1
        AND LOWER(TRIM(source_location)) = LOWER(TRIM(?))
        AND LOWER(TRIM(destination_location)) = LOWER(TRIM(?))
        AND day_count = ?
      ORDER BY template_id DESC
      LIMIT 1
      `,
      source,
      destination,
      days,
    );

    if (!rows.length) {
      return {
        found: false,
        sourceLocation: source,
        destinationLocation: destination,
        dayCount: days,
      };
    }

    const row = rows[0];
    const fullTemplate: any = this.parseJsonSafely(row.template_payload);
    const routeOnlyTemplate = {
      routes: Array.isArray(fullTemplate?.routes) ? fullTemplate.routes : [],
    };

    return {
      found: true,
      templateId: Number(row.template_id),
      sourceLocation: row.source_location,
      destinationLocation: row.destination_location,
      dayCount: Number(row.day_count),
      templateName: row.template_name,
      createdFromPlanId: row.created_from_plan_id ? Number(row.created_from_plan_id) : null,
      createdOn: row.createdon,
      metadata: this.parseJsonSafely(row.metadata_payload),
      template: templateScope === 'routes' ? routeOnlyTemplate : fullTemplate,
    };
  }

  private async saveReusableTemplateFromPlan(
    planId: number,
    userId: number,
    templateName?: string,
  ) {
    const snapshot = await this.buildReusableTemplateSnapshot(planId);

    const sourceLocation = String(snapshot.plan?.arrival_location || '').trim();
    const destinationLocation = String(snapshot.plan?.departure_location || '').trim();
    const dayCount = Number(snapshot.plan?.no_of_days || snapshot.routes.length || 0);

    if (!sourceLocation || !destinationLocation || !dayCount) {
      throw new BadRequestException('Unable to build reusable template: missing source/destination/day_count');
    }

    await this.ensureReusableTemplateTable();

    const payload = {
      plan: snapshot.plan,
      routes: snapshot.routes,
      vehicles: snapshot.vehicles,
      hotspots: snapshot.hotspots,
      manual_hotspots: snapshot.manualHotspots,
      activities: snapshot.activities,
    };

    const metadata = {
      itinerary_type: snapshot.plan?.itinerary_type ?? null,
      itinerary_preference: snapshot.plan?.itinerary_preference ?? null,
      preferred_hotel_category: snapshot.plan?.preferred_hotel_category ?? null,
      hotel_facilities: snapshot.plan?.hotel_facilities ?? null,
      entry_ticket_required: snapshot.plan?.entry_ticket_required ?? null,
      guide_for_itinerary: snapshot.plan?.guide_for_itinerary ?? null,
      nationality: snapshot.plan?.nationality ?? null,
      food_type: snapshot.plan?.food_type ?? null,
      source_location: sourceLocation,
      destination_location: destinationLocation,
      day_count: dayCount,
    };

    const resolvedTemplateName = String(templateName || '').trim() ||
      `${sourceLocation} to ${destinationLocation} (${dayCount}D)`;

    await this.prisma.$executeRawUnsafe(
      `
      INSERT INTO dvi_itinerary_reusable_templates
      (
        source_location,
        destination_location,
        day_count,
        template_name,
        template_payload,
        metadata_payload,
        created_from_plan_id,
        createdby,
        createdon,
        updatedon,
        status,
        deleted
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1, 0)
      `,
      sourceLocation,
      destinationLocation,
      dayCount,
      resolvedTemplateName,
      JSON.stringify(payload),
      JSON.stringify(metadata),
      Number(planId),
      Number(userId || 1),
    );

    const inserted = await this.prisma.$queryRawUnsafe<any[]>(
      'SELECT LAST_INSERT_ID() AS template_id',
    );

    return {
      success: true,
      templateId: Number(inserted?.[0]?.template_id || 0),
      sourceLocation,
      destinationLocation,
      dayCount,
      templateName: resolvedTemplateName,
    };
  }

  private async buildReusableTemplateSnapshot(planId: number) {
    const editData = await this.getPlanForEdit(planId);

    const hotspots = await (this.prisma as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        item_type: 4,
        deleted: 0,
      },
      orderBy: [
        { itinerary_route_ID: 'asc' },
        { hotspot_order: 'asc' },
      ],
    });

    const activities = await (this.prisma as any).dvi_itinerary_route_activity_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        deleted: 0,
      },
      orderBy: [
        { itinerary_route_ID: 'asc' },
        { route_hotspot_ID: 'asc' },
        { activity_order: 'asc' },
      ],
    });

    const manualHotspots = hotspots.filter((h: any) => Number(h.hotspot_plan_own_way || 0) === 1);

    return {
      plan: editData.plan,
      routes: editData.routes,
      vehicles: editData.vehicles,
      hotspots,
      manualHotspots,
      activities,
    };
  }

  private async ensureReusableTemplateTable() {
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS dvi_itinerary_reusable_templates (
        template_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        source_location VARCHAR(255) NOT NULL,
        destination_location VARCHAR(255) NOT NULL,
        day_count INT NOT NULL,
        template_name VARCHAR(255) NULL,
        template_payload LONGTEXT NOT NULL,
        metadata_payload LONGTEXT NULL,
        created_from_plan_id INT NULL,
        createdby INT NOT NULL DEFAULT 1,
        createdon DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedon DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        status TINYINT NOT NULL DEFAULT 1,
        deleted TINYINT NOT NULL DEFAULT 0,
        PRIMARY KEY (template_id),
        KEY idx_template_match (source_location, destination_location, day_count, deleted, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  }

  private parseJsonSafely(raw: unknown) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return null;

    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}
