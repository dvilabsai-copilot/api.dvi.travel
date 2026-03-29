// REPLACE-WHOLE-FILE
// FILE: src/itineraries/itineraries.service.ts

import { Injectable, BadRequestException, NotFoundException, ConflictException } from "@nestjs/common";
import { PrismaService } from "../../prisma.service";
import {
  CreateItineraryDto,
} from "./dto/create-itinerary.dto";
import { ConfirmQuotationDto } from "./dto/confirm-quotation.dto";
import { CancelItineraryDto } from "./dto/cancel-itinerary.dto";
import { LatestItineraryQueryDto } from "./dto/latest-itinerary-query.dto";
import { PlanEngineService } from "./engines/plan-engine.service";
import { RouteEngineService } from "./engines/route-engine.service";
import { HotspotEngineService } from "./engines/hotspot-engine.service";
import { HotelEngineService } from "./engines/hotel-engine.service";
import { TravellersEngineService } from "./engines/travellers-engine.service";
import { VehiclesEngineService } from "./engines/vehicles-engine.service";
import { ViaRoutesEngine } from "./engines/via-routes.engine";
import { ItineraryVehiclesEngine } from "./engines/itinerary-vehicles.engine";
import { RouteValidationService } from "./validation/route-validation.service";
import { ItineraryDetailsService } from "./itinerary-details.service";
import { TimeConverter } from "./engines/helpers/time-converter";
import { HotspotDetailRow } from "./engines/helpers/types";
import { TboHotelBookingService } from "./services/tbo-hotel-booking.service";
import { ResAvenueHotelBookingService } from "./services/resavenue-hotel-booking.service";
import { HobseHotelBookingService } from "./services/hobse-hotel-booking.service";
import { ItineraryHotelDetailsTboService } from "./itinerary-hotel-details-tbo.service";
import { normalizePassengerTitle } from "../../common/utils/passenger-title.util";
import { SupplementNormalizerService } from "../../modules/hotels/services/supplement-normalizer.service";

@Injectable()
export class ItinerariesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly planEngine: PlanEngineService,
    private readonly routeEngine: RouteEngineService,
    private readonly hotspotEngine: HotspotEngineService,
    private readonly hotelEngine: HotelEngineService,
    private readonly travellersEngine: TravellersEngineService,
    private readonly vehiclesEngine: VehiclesEngineService,
    private readonly viaRoutesEngine: ViaRoutesEngine,
    private readonly itineraryVehiclesEngine: ItineraryVehiclesEngine,
    private readonly routeValidation: RouteValidationService,
    private readonly itineraryDetails: ItineraryDetailsService,
    private readonly tboHotelBooking: TboHotelBookingService,
    private readonly resavenueHotelBooking: ResAvenueHotelBookingService,
    private readonly hobseHotelBooking: HobseHotelBookingService,
    private readonly hotelDetailsTboService: ItineraryHotelDetailsTboService,
    private readonly supplementNormalizer: SupplementNormalizerService,
  ) {}

  /**
   * Normalize field values to arrays safely.
   * Handles string, array, object, null, undefined without spreading strings into characters.
   */
  private normalizeToArray(value: any): any[] {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim()) return [value.trim()];
    if (value && typeof value === 'object') return [value];
    return [];
  }

  async createPlan(dto: CreateItineraryDto, req: any, shouldOptimizeRoute: boolean = false) {
    const u: any = (req as any).user ?? {};
    const userId = Number(u.userId ?? 1);
    const agentId = Number(u.agentId ?? 0);
    const staffId = Number(u.staffId ?? 0);

    // If user is an agent, force their agentId
    if (agentId > 0) {
      dto.plan.agent_id = agentId;
    }
    // If user is a staff/travel expert, force their staffId
    if (staffId > 0) {
      dto.plan.staff_id = staffId;
    }

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

    const perfStart = Date.now();

    // Validate hotel availability BEFORE starting the transaction
    // Only validate if hotels are needed (itinerary_preference 1 or 3)
    if (dto.plan.itinerary_preference === 1 || dto.plan.itinerary_preference === 3) {
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
    }

    const txStart = Date.now();
    
    // Increase interactive transaction timeout; hotspot rebuild + hotel lookups can exceed default 5s
    const result = await this.prisma.$transaction(async (tx) => {
      const opStart = Date.now();
      const planId = await this.planEngine.upsertPlanHeader(
        dto.plan,
        dto.travellers,
        tx,
        userId,
      );
      console.log('[PERF] upsertPlanHeader:', Date.now() - opStart, 'ms');

      // ⚡ PRESERVE HOTSPOT CONTEXT: Fetch existing hotspots and their route dates BEFORE routes are deleted
      // This ensures that when we rebuild hotspots later, we know which day each "tombstone" (deleted hotspot) belonged to.
      const oldRoutes = await (tx as any).dvi_itinerary_route_details.findMany({
        where: { itinerary_plan_ID: planId },
        select: { itinerary_route_ID: true, itinerary_route_date: true }
      });
      const oldRouteDateMap = new Map(oldRoutes.map((r: any) => [r.itinerary_route_ID, r.itinerary_route_date]));
      
      // ✅ FIX: Only fetch non-deleted hotspots when preparing for rebuild
      // This prevents deleted hotspots from being re-added during rebuild
      const oldHotspots = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
        where: { itinerary_plan_ID: planId, item_type: 4, deleted: 0 }
      });
      
      const existingHotspotsWithDates = oldHotspots.map((h: any) => ({
        ...h,
        route_date: oldRouteDateMap.get(h.itinerary_route_ID)
      }));

      let opStart2 = Date.now();
      const routes = await this.routeEngine.rebuildRoutes(
        planId,
        dto.plan,
        dto.routes,
        tx,
        userId,
      );
      console.log('[PERF] rebuildRoutes:', Date.now() - opStart2, 'ms');

      // Rebuild permit charges after routes are created
      opStart2 = Date.now();
      await this.routeEngine.rebuildPermitCharges(tx, planId, userId);
      console.log('[PERF] rebuildPermitCharges:', Date.now() - opStart2, 'ms');

      // Rebuild via routes AFTER routes are created and BEFORE hotspots
      opStart2 = Date.now();
      const routeIds = routes.map((r: any) => r.itinerary_route_ID);
      await this.viaRoutesEngine.rebuildViaRoutes(tx, planId, dto.routes, routeIds, userId);
      console.log('[PERF] rebuildViaRoutes:', Date.now() - opStart2, 'ms');

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
      console.log('[PERF] rebuildTravellers:', Date.now() - opStart2, 'ms');

      opStart2 = Date.now();
      await this.vehiclesEngine.rebuildPlanVehicles(
        planId,
        dto.vehicles,
        tx,
        userId,
      );
      console.log('[PERF] rebuildPlanVehicles:', Date.now() - opStart2, 'ms');

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
        console.log('[PERF] rebuildPlanHotels:', Date.now() - opStart2, 'ms');
      }

      opStart2 = Date.now();
      await this.hotspotEngine.rebuildRouteHotspots(tx, planId, existingHotspotsWithDates);
      console.log('[PERF] rebuildRouteHotspots:', Date.now() - opStart2, 'ms');

      opStart2 = Date.now();
      const planRow = await (tx as any).dvi_itinerary_plan_details.findUnique({
        where: { itinerary_plan_ID: planId },
        select: { itinerary_quote_ID: true },
      });
      console.log('[PERF] getPlanRow:', Date.now() - opStart2, 'ms');
      console.log('[PERF] TOTAL TRANSACTION:', Date.now() - txStart, 'ms');

      return {
        planId,
        quoteId: planRow?.itinerary_quote_ID,
        routeIds: routes.map((r: any) => r.itinerary_route_ID),
        message:
          "Plan created/updated with routes, vehicles, travellers, hotspots, and hotels.",
      };
    }, { timeout: 120000, maxWait: 20000 }); // Increased to 120s while we optimize further

    // Rebuild parking charges AFTER routes and hotspots
    let postStart = Date.now();
    await this.hotspotEngine.rebuildParkingCharges(result.planId, userId);
    console.log('[PERF] rebuildParkingCharges:', Date.now() - postStart, 'ms');

    // Rebuild vendor eligible list and vendor vehicle details AFTER transaction completes
    // (requires committed routes & hotspots data)
    postStart = Date.now();
    await this.itineraryVehiclesEngine.rebuildEligibleVendorList({
      planId: result.planId,
      createdBy: userId,
    });
    console.log('[PERF] rebuildEligibleVendorList:', Date.now() - postStart, 'ms');
    console.log('[PERF] TOTAL createPlan:', Date.now() - perfStart, 'ms');

    return result;
  }

  /**
   * Delete a hotspot from an itinerary route
   * Hard deletes the hotspot from timeline and adds to excluded_hotspot_ids
   */
  async deleteHotspot(planId: number, routeId: number, hotspotId: number) {
    const userId = 1;

    await this.prisma.$transaction(async (tx) => {
      // First, fetch the hotspot record to get the actual hotspot_ID
      const hotspotRecord = await (tx as any).dvi_itinerary_route_hotspot_details.findUnique({
        where: {
          route_hotspot_ID: hotspotId,
        },
      });

      if (!hotspotRecord) {
        throw new BadRequestException('Hotspot not found');
      }

      const actualHotspotId = hotspotRecord.hotspot_ID; // This is the master hotspot ID

      // Hard delete activities associated with this hotspot
      await (tx as any).dvi_itinerary_route_activity_details.deleteMany({
        where: {
          itinerary_plan_ID: planId,
          itinerary_route_ID: routeId,
          route_hotspot_ID: hotspotId,
        },
      });

      // Hard delete the hotspot record completely
      const deleted = await (tx as any).dvi_itinerary_route_hotspot_details.deleteMany({
        where: {
          itinerary_plan_ID: planId,
          itinerary_route_ID: routeId,
          route_hotspot_ID: hotspotId,
        },
      });

      if (deleted.count === 0) {
        throw new BadRequestException('Hotspot not found');
      }

      // Get current route to update excluded_hotspot_ids
      const route = await (tx as any).dvi_itinerary_route_details.findUnique({
        where: { itinerary_route_ID: routeId },
      });

      // ✅ FIX: Add the actual hotspot_ID (not route_hotspot_ID) to excluded list
      // This allows the selector to properly filter hotspots by their master hotspot_ID
      const excluded = (route?.excluded_hotspot_ids as number[]) || [];
      if (!excluded.includes(actualHotspotId)) {
        excluded.push(actualHotspotId);
      }

      // Update route with excluded list and timestamp
      await (tx as any).dvi_itinerary_route_details.update({
        where: { itinerary_route_ID: routeId },
        data: {
          excluded_hotspot_ids: excluded,
          updatedon: new Date(),
        },
      });

      // Trigger a full rebuild of the hotspots for this plan
      // This ensures travel times and hotel arrival are recalculated after deletion
      await this.hotspotEngine.rebuildRouteHotspots(tx, planId);
    }, { timeout: 60000 });

    // Rebuild parking charges after deletion
    await this.hotspotEngine.rebuildParkingCharges(planId, userId);

    return {
      success: true,
      message: 'Hotspot deleted and timeline recalculated successfully',
    };
  }

  /**
   * Get available activities for a hotspot location
   */
  async getAvailableActivities(hotspotId: number) {
    const activities = await (this.prisma as any).dvi_activity.findMany({
      where: {
        hotspot_id: hotspotId,
        deleted: 0,
        status: 1,
      },
      select: {
        activity_id: true,
        activity_title: true,
        activity_description: true,
        activity_duration: true,
        max_allowed_person_count: true,
      },
      orderBy: { activity_title: 'asc' },
    });

    // Fetch time slots for each activity
    const activitiesWithSlots = await Promise.all(
      activities.map(async (a: any) => {
        const timeSlots = await (this.prisma as any).dvi_activity_time_slot_details.findMany({
          where: {
            activity_id: a.activity_id,
            deleted: 0,
            status: 1,
          },
          select: {
            activity_time_slot_ID: true,
            time_slot_type: true,
            special_date: true,
            start_time: true,
            end_time: true,
          },
          orderBy: { start_time: 'asc' },
        });

        return {
          id: a.activity_id,
          title: a.activity_title || '',
          description: a.activity_description || '',
          duration: a.activity_duration || null,
          maxPersons: a.max_allowed_person_count || 0,
          timeSlots: timeSlots.map((ts: any) => ({
            id: ts.activity_time_slot_ID,
            type: ts.time_slot_type,
            specialDate: ts.special_date,
            startTime: ts.start_time,
            endTime: ts.end_time,
          })),
        };
      })
    );

    return activitiesWithSlots;
  }

  /**
   * Add an activity to a hotspot in the itinerary
   */
  async addActivity(data: {
    planId: number;
    routeId: number;
    routeHotspotId: number;
    hotspotId: number;
    activityId: number;
    amount?: number;
    startTime?: string;
    endTime?: string;
    duration?: string;
    skipConflictCheck?: boolean;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const userId = 1;

      // Get activity details
      const activity = await (tx as any).dvi_activity.findUnique({
        where: { activity_id: data.activityId },
        select: {
          activity_duration: true,
        },
      });

      if (!activity) {
        throw new NotFoundException('Activity not found');
      }

      // Get current hotspot timing
      const routeHotspot = await (tx as any).dvi_itinerary_route_hotspot_details.findFirst({
        where: {
          route_hotspot_ID: data.routeHotspotId,
          itinerary_plan_ID: data.planId,
          deleted: 0,
        },
        select: {
          hotspot_start_time: true,
          hotspot_end_time: true,
        },
      });

      if (!routeHotspot) {
        throw new NotFoundException('Route hotspot not found');
      }

      // Enforce uniqueness: same activity can be added only once per
      // itinerary plan + route + hotspot combination.
      const duplicate = await (tx as any).dvi_itinerary_route_activity_details.findFirst({
        where: {
          itinerary_plan_ID: data.planId,
          itinerary_route_ID: data.routeId,
          hotspot_ID: data.hotspotId,
          activity_ID: data.activityId,
          deleted: 0,
          status: 1,
        },
        select: { route_activity_ID: true },
      });

      if (duplicate) {
        throw new ConflictException('This activity is already added for this hotspot');
      }

      // Get the next activity order and calculate start time
      const existingActivities = await (tx as any).dvi_itinerary_route_activity_details.findMany({
        where: {
          itinerary_plan_ID: data.planId,
          itinerary_route_ID: data.routeId,
          route_hotspot_ID: data.routeHotspotId,
          deleted: 0,
        },
        select: { 
          activity_order: true,
          activity_end_time: true,
        },
        orderBy: { activity_order: 'desc' },
        take: 1,
      });

      const nextOrder = existingActivities.length > 0 
        ? existingActivities[0].activity_order + 1 
        : 1;

      // Calculate activity start time
      let activityStartTime = routeHotspot.hotspot_start_time;
      
      if (existingActivities.length > 0 && existingActivities[0].activity_end_time) {
        activityStartTime = existingActivities[0].activity_end_time;
      }

      // Calculate end time based on duration
      const durationMinutes = activity.activity_duration 
        ? this.timeToMinutes(activity.activity_duration) 
        : 30; // Default 30 mins
      
      const activityEndTime = this.addMinutesToTime(activityStartTime, durationMinutes);

      // Insert the activity
      const result = await (tx as any).dvi_itinerary_route_activity_details.create({
        data: {
          itinerary_plan_ID: data.planId,
          itinerary_route_ID: data.routeId,
          route_hotspot_ID: data.routeHotspotId,
          hotspot_ID: data.hotspotId,
          activity_ID: data.activityId,
          activity_order: nextOrder,
          activity_amout: data.amount || 0,
          activity_traveling_time: activity.activity_duration,
          activity_start_time: activityStartTime,
          activity_end_time: activityEndTime,
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });

      // If activity extends beyond hotspot end time, update and rebuild timeline
      if (activityEndTime > routeHotspot.hotspot_end_time) {
        await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
          where: { route_hotspot_ID: data.routeHotspotId },
          data: {
            hotspot_end_time: activityEndTime,
            updatedon: new Date(),
          },
        });
        // Do not rebuild full hotspot timeline here because rebuild re-derives
        // hotspot timing windows and can overwrite this explicit extension.
      }

      return {
        success: true,
        message: 'Activity added successfully',
        activityId: result.route_activity_ID,
        timing: {
          startTime: activityStartTime,
          endTime: activityEndTime,
        },
      };
    }, { timeout: 30000 });
  }

  /**
   * Preview activity addition to check for timing conflicts
   */
  async previewActivityAddition(data: {
    planId: number;
    routeId: number;
    routeHotspotId: number;
    hotspotId: number;
    activityId: number;
  }) {
    // 1. Get activity details including duration
    const activity = await (this.prisma as any).dvi_activity.findUnique({
      where: { activity_id: data.activityId },
      select: {
        activity_id: true,
        activity_title: true,
        activity_duration: true,
      },
    });

    if (!activity) {
      throw new NotFoundException('Activity not found');
    }

    // 2. Get activity time slots
    const timeSlots = await (this.prisma as any).dvi_activity_time_slot_details.findMany({
      where: {
        activity_id: data.activityId,
        deleted: 0,
        status: 1,
      },
    });

    // 3. Get current hotspot timing + order in the itinerary
    const routeHotspot = await (this.prisma as any).dvi_itinerary_route_hotspot_details.findFirst({
      where: {
        route_hotspot_ID: data.routeHotspotId,
        itinerary_plan_ID: data.planId,
        deleted: 0,
      },
      select: {
        hotspot_start_time: true,
        hotspot_end_time: true,
        hotspot_order: true,
        hotspot_ID: true,
        item_type: true,
      },
    });

    if (!routeHotspot) {
      throw new NotFoundException('Route hotspot not found');
    }

    // 4. Compute where the activity will be inserted in this hotspot
    const existingActivities = await (this.prisma as any).dvi_itinerary_route_activity_details.findMany({
      where: {
        itinerary_plan_ID: data.planId,
        itinerary_route_ID: data.routeId,
        route_hotspot_ID: data.routeHotspotId,
        deleted: 0,
      },
      select: {
        activity_order: true,
        activity_end_time: true,
      },
      orderBy: { activity_order: 'desc' },
      take: 1,
    });

    const nextOrder = existingActivities.length > 0
      ? existingActivities[0].activity_order + 1
      : 1;

    const proposedStartTime =
      existingActivities.length > 0 && existingActivities[0].activity_end_time
        ? existingActivities[0].activity_end_time
        : routeHotspot.hotspot_start_time;

    const durationMinutes = activity.activity_duration
      ? this.timeToMinutes(activity.activity_duration)
      : 30;

    const proposedEndTime = this.addMinutesToTime(proposedStartTime, durationMinutes);

    // 5. Check for timing conflicts against the proposed inserted slot
    const conflicts = this.checkActivityTimingConflicts(
      activity,
      timeSlots,
      proposedStartTime,
      proposedEndTime
    );

    // 6. Compute day cascade — how many minutes does the hotspot extend?
    const hotspotExtensionMinutes =
      proposedEndTime > routeHotspot.hotspot_end_time
        ? this.timeToMinutes(proposedEndTime) - this.timeToMinutes(routeHotspot.hotspot_end_time)
        : 0;

    let cascade: {
      shiftMinutes: number;
      affectedSegments: Array<{
        type: string;
        name: string;
        oldStartTime: Date | null;
        oldEndTime: Date | null;
        newStartTime: Date | null;
        newEndTime: Date | null;
      }>;
      originalDayEndTime: Date | null;
      newDayEndTime: Date | null;
    } = {
      shiftMinutes: hotspotExtensionMinutes,
      affectedSegments: [],
      originalDayEndTime: null,
      newDayEndTime: null,
    };

    if (hotspotExtensionMinutes > 0) {
      // Fetch all subsequent route hotspot rows (ordered by hotspot_order)
      const subsequentRows = await (this.prisma as any).dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_plan_ID: data.planId,
          itinerary_route_ID: data.routeId,
          hotspot_order: { gt: routeHotspot.hotspot_order },
          deleted: 0,
        },
        select: {
          route_hotspot_ID: true,
          hotspot_ID: true,
          item_type: true,
          hotspot_start_time: true,
          hotspot_end_time: true,
          hotspot_order: true,
          hotspot_traveling_time: true,
          allow_break_hours: true,
          allow_via_route: true,
          via_location_name: true,
        },
        orderBy: { hotspot_order: 'asc' },
      });

      // Collect all hotspot_IDs to batch-fetch names
      const hotspotIds = subsequentRows
        .map((r: any) => r.hotspot_ID)
        .filter((id: any) => id && id > 0);

      const masterHotspots = hotspotIds.length > 0
        ? await (this.prisma as any).dvi_hotspot_place.findMany({
            where: { hotspot_ID: { in: hotspotIds } },
            select: { hotspot_ID: true, hotspot_name: true },
          })
        : [];

      const hotspotNameMap = new Map<number, string>(
        masterHotspots.map((h: any) => [h.hotspot_ID, h.hotspot_name])
      );

      // Determine original day end time (last segment's end time)
      const lastRow = subsequentRows[subsequentRows.length - 1];
      cascade.originalDayEndTime = lastRow?.hotspot_end_time ?? routeHotspot.hotspot_end_time;
      cascade.newDayEndTime = cascade.originalDayEndTime
        ? this.addMinutesToTime(cascade.originalDayEndTime, hotspotExtensionMinutes)
        : null;

      for (const row of subsequentRows) {
        const itemType = Number(row.item_type ?? 0);
        const oldStart: Date | null = row.hotspot_start_time ?? null;
        const oldEnd: Date | null = row.hotspot_end_time ?? null;
        const newStart = oldStart ? this.addMinutesToTime(oldStart, hotspotExtensionMinutes) : null;
        const newEnd = oldEnd ? this.addMinutesToTime(oldEnd, hotspotExtensionMinutes) : null;

        let segType = 'hotspot';
        let segName = 'Unknown';

        if (itemType === 2) {
          segType = 'travel';
          segName = 'Travel';
        } else if (itemType === 3) {
          if (Number(row.allow_break_hours) === 1) {
            segType = 'break';
            segName = hotspotNameMap.get(row.hotspot_ID) ?? 'Break';
          } else if (Number(row.allow_via_route) === 1) {
            segType = 'travel';
            segName = `Travel via ${row.via_location_name ?? 'route'}`;
          } else {
            segType = 'travel';
            segName = 'Travel';
          }
        } else if (itemType === 4) {
          segType = 'hotspot';
          segName = hotspotNameMap.get(row.hotspot_ID) ?? 'Hotspot';
        } else if (itemType === 5) {
          segType = 'hotel';
          segName = 'Hotel Check-in';
        } else if (itemType === 6 || itemType === 7) {
          segType = 'return';
          segName = 'Return';
        } else {
          continue; // Skip item_type 1 (already handled as current hotspot)
        }

        cascade.affectedSegments.push({ type: segType, name: segName, oldStartTime: oldStart, oldEndTime: oldEnd, newStartTime: newStart, newEndTime: newEnd });
      }
    }

    return {
      activity: {
        id: activity.activity_id,
        title: activity.activity_title,
        duration: activity.activity_duration,
      },
      hotspotTiming: {
        startTime: routeHotspot.hotspot_start_time,
        endTime: routeHotspot.hotspot_end_time,
      },
      proposedTiming: {
        order: nextOrder,
        startTime: proposedStartTime,
        endTime: proposedEndTime,
        willExtendHotspot: proposedEndTime > routeHotspot.hotspot_end_time,
      },
      conflicts,
      hasConflicts: conflicts.length > 0,
      cascade,
    };
  }

  /**
   * Delete an activity from an itinerary route
   */
  async deleteActivity(planId: number, routeId: number, activityId: number) {
    const userId = 1;

    const deleted = await (this.prisma as any).dvi_itinerary_route_activity_details.deleteMany({
      where: {
        itinerary_plan_ID: planId,
        itinerary_route_ID: routeId,
        route_activity_ID: activityId,
      },
    });

    if (deleted.count === 0) {
      throw new BadRequestException('Activity not found');
    }

    // Update route details timestamp
    await (this.prisma as any).dvi_itinerary_route_details.updateMany({
      where: {
        itinerary_plan_ID: planId,
        itinerary_route_ID: routeId,
      },
      data: {
        updatedon: new Date(),
        createdby: userId,
      },
    });

    return {
      success: true,
      message: 'Activity deleted successfully',
    };
  }

  /**
   * Preview activity addition for ALL hotspots on a route (for day view)
   */
  async previewActivityForAllHotspots(data: {
    planId: number;
    routeId: number;
    activityId: number;
  }) {
    // 1. Get activity details including duration
    const activity = await (this.prisma as any).dvi_activity.findUnique({
      where: { activity_id: data.activityId },
      select: {
        activity_id: true,
        activity_title: true,
        activity_duration: true,
      },
    });

    if (!activity) {
      throw new NotFoundException('Activity not found');
    }

    // 2. Get activity time slots
    const timeSlots = await (this.prisma as any).dvi_activity_time_slot_details.findMany({
      where: {
        activity_id: data.activityId,
        deleted: 0,
        status: 1,
      },
    });

    // 3. Get ALL hotspots for this route (not deleted, in timeline)
    const routeHotspots = await (this.prisma as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: data.planId,
        itinerary_route_ID: data.routeId,
        deleted: 0,
        status: 1,
        item_type: 4, // Only attraction hotspots
      },
      select: {
        route_hotspot_ID: true,
        hotspot_ID: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
      },
      orderBy: { hotspot_start_time: 'asc' }, // Order by time on timeline
    });

    if (!routeHotspots || routeHotspots.length === 0) {
      throw new NotFoundException('No hotspots found for this route');
    }

      const hotspotIds = routeHotspots
        .map((h: any) => Number(h.hotspot_ID || 0))
        .filter((id: number) => id > 0);

      const hotspotMasters = hotspotIds.length > 0
        ? await (this.prisma as any).dvi_hotspot_place.findMany({
            where: {
              hotspot_ID: { in: hotspotIds },
            },
            select: {
              hotspot_ID: true,
              hotspot_name: true,
            },
          })
        : [];

      const hotspotNameMap = new Map<number, string>(
        hotspotMasters.map((h: any) => [Number(h.hotspot_ID), String(h.hotspot_name || '')])
      );

    // 4. For each hotspot, compute the preview
    const hotspotsPreview = await Promise.all(
      routeHotspots.map(async (hotspot: any) => {
        // Check if activity already exists for this hotspot
        const duplicate = await (this.prisma as any).dvi_itinerary_route_activity_details.findFirst({
          where: {
            itinerary_plan_ID: data.planId,
            itinerary_route_ID: data.routeId,
            route_hotspot_ID: hotspot.route_hotspot_ID,
            activity_ID: data.activityId,
            deleted: 0,
            status: 1,
          },
          select: { route_activity_ID: true },
        });

        if (duplicate) {
          return {
            routeHotspotId: hotspot.route_hotspot_ID,
            hotspotId: hotspot.hotspot_ID,
            hotspotName: hotspotNameMap.get(Number(hotspot.hotspot_ID || 0)) || null,
            hotspotTiming: {
              startTime: hotspot.hotspot_start_time,
              endTime: hotspot.hotspot_end_time,
            },
            proposedTiming: null,
            conflicts: [{ reason: 'Activity already added for this hotspot' }],
            hasConflicts: true,
            isAlreadyAdded: true,
          };
        }

        // Get existing activities for this hotspot
        const existingActivities = await (this.prisma as any).dvi_itinerary_route_activity_details.findMany({
          where: {
            itinerary_plan_ID: data.planId,
            itinerary_route_ID: data.routeId,
            route_hotspot_ID: hotspot.route_hotspot_ID,
            deleted: 0,
          },
          select: {
            activity_order: true,
            activity_end_time: true,
          },
          orderBy: { activity_order: 'desc' },
          take: 1,
        });

        const nextOrder = existingActivities.length > 0
          ? existingActivities[0].activity_order + 1
          : 1;

        const proposedStartTime =
          existingActivities.length > 0 && existingActivities[0].activity_end_time
            ? existingActivities[0].activity_end_time
            : hotspot.hotspot_start_time;

        const durationMinutes = activity.activity_duration
          ? this.timeToMinutes(activity.activity_duration)
          : 30;

        const proposedEndTime = this.addMinutesToTime(proposedStartTime, durationMinutes);

        // Check for timing conflicts
        const conflicts = this.checkActivityTimingConflicts(
          activity,
          timeSlots,
          proposedStartTime,
          proposedEndTime
        );

        return {
          routeHotspotId: hotspot.route_hotspot_ID,
          hotspotId: hotspot.hotspot_ID,
          hotspotName: hotspotNameMap.get(Number(hotspot.hotspot_ID || 0)) || null,
          hotspotTiming: {
            startTime: hotspot.hotspot_start_time,
            endTime: hotspot.hotspot_end_time,
          },
          proposedTiming: {
            order: nextOrder,
            startTime: proposedStartTime,
            endTime: proposedEndTime,
            willExtendHotspot: proposedEndTime > hotspot.hotspot_end_time,
          },
          conflicts,
          hasConflicts: conflicts.length > 0,
          isAlreadyAdded: false,
        };
      })
    );

    return {
      activity: {
        id: activity.activity_id,
        title: activity.activity_title,
        duration: activity.activity_duration,
      },
      hotspots: hotspotsPreview,
    };
  }

  /**
   * Get available hotspots for a route
   */
  /**
   * Get available hotspots for a route
   *
   * NEW RULES:
   * - direct_to_next_visiting_place === 1  => destination pool only, priority DESC
   * - direct_to_next_visiting_place === 0  => interleave source/destination in chunks of 3
   * - already added hotspots => mark visitAgain=true (and include them even if not in pool)
   */
  async getAvailableHotspots(routeId: number) {
    // 1) Route
    const route = await (this.prisma as any).dvi_itinerary_route_details.findFirst({
      where: { itinerary_route_ID: routeId, deleted: 0 },
    });

    if (!route || !route.location_id) return [];

    // 2) Location master
    const location = await (this.prisma as any).dvi_stored_locations.findFirst({
      where: { location_ID: Number(route.location_id), deleted: 0 },
    });

    if (!location) return [];

    const sourceName: string | null = (location as any).source_location ?? null;
    const destName: string | null = (location as any).destination_location ?? null;

    const directDestination = Number(route.direct_to_next_visiting_place || 0) === 1;

    // 3) Already-added hotspots for this route => visitAgain
    const alreadyAddedRows = await (this.prisma as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_route_ID: routeId,
        deleted: 0,
        status: 1,
        item_type: 4,
      },
      select: { hotspot_ID: true },
    });

    const alreadyAddedIds = new Set<number>(
      (alreadyAddedRows || [])
        .map((r: any) => Number(r.hotspot_ID))
        .filter((n: number) => Number.isFinite(n) && n > 0),
    );

    // 3.5) Get excluded hotspot IDs (deleted by user)
    const excludedIds = new Set<number>(
      (route.excluded_hotspot_ids as number[]) || []
    );

    // 4) Pool fetcher (priority DESC + stable tie-break)
    const fetchPool = async (cityName: string | null) => {
      if (!cityName) return [];
      return await (this.prisma as any).dvi_hotspot_place.findMany({
        where: {
          status: 1,
          deleted: 0,
          hotspot_location: { contains: cityName },
        },
        select: {
          hotspot_ID: true,
          hotspot_name: true,
          hotspot_adult_entry_cost: true,
          hotspot_description: true,
          hotspot_duration: true,
          hotspot_location: true,
          hotspot_priority: true,
        },
        orderBy: [{ hotspot_priority: "desc" }, { hotspot_ID: "asc" }],
      });
    };

    const sourcePool = await fetchPool(sourceName);
    const destPool = await fetchPool(destName);

    // 5) Build final ordered list
    const seen = new Set<number>();
    const ordered: any[] = [];

    const pushUnique = (h: any) => {
      const id = Number(h?.hotspot_ID);
      if (!id || seen.has(id)) return;
      if (excludedIds.has(id)) return; // ✅ Skip excluded hotspots
      seen.add(id);
      ordered.push(h);
    };

    if (directDestination) {
      // direct = true => destination only
      for (const h of destPool) pushUnique(h);
    } else {
      // direct = false => interleave 3-by-3 source/dest
      const CHUNK = 3;
      let i = 0;
      let j = 0;

      while (i < sourcePool.length || j < destPool.length) {
        for (let k = 0; k < CHUNK && i < sourcePool.length; k++, i++) pushUnique(sourcePool[i]);
        for (let k = 0; k < CHUNK && j < destPool.length; k++, j++) pushUnique(destPool[j]);
      }
    }

    // 6) Add missing already-added hotspots (if not present in pools)
    const missingAddedIds = [...alreadyAddedIds].filter((id) => !seen.has(id));
    if (missingAddedIds.length > 0) {
      const missing = await (this.prisma as any).dvi_hotspot_place.findMany({
        where: { hotspot_ID: { in: missingAddedIds } },
        select: {
          hotspot_ID: true,
          hotspot_name: true,
          hotspot_adult_entry_cost: true,
          hotspot_description: true,
          hotspot_duration: true,
          hotspot_location: true,
          hotspot_priority: true,
        },
        orderBy: [{ hotspot_priority: "desc" }, { hotspot_ID: "asc" }],
      });
      for (const h of missing) pushUnique(h);
    }

    if (ordered.length === 0) return [];

    // 7) Timings
    const hotspotIds = ordered.map((h: any) => Number(h.hotspot_ID));
    const timings = await (this.prisma as any).dvi_hotspot_timing.findMany({
      where: { hotspot_ID: { in: hotspotIds }, deleted: 0, status: 1 },
      orderBy: { hotspot_start_time: "asc" },
    });

    const timingMap = new Map<number, string>();
    const formatTime = (date: Date | null) => {
      if (!date) return "";
      const h = date.getUTCHours();
      const m = date.getUTCMinutes();
      const ampm = h >= 12 ? "PM" : "AM";
      const h12 = h % 12 || 12;
      return `${String(h12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${ampm}`;
    };

    for (const t of timings) {
      if (t.hotspot_closed === 1) continue;

      let timeStr = "";
      if (t.hotspot_open_all_time === 1) {
        timeStr = "Open 24 Hours";
      } else if (t.hotspot_start_time && t.hotspot_end_time) {
        const start = formatTime(t.hotspot_start_time);
        const end = formatTime(t.hotspot_end_time);
        timeStr = `${start} - ${end}`;
      }

      if (timeStr && !timingMap.has(t.hotspot_ID)) {
        timingMap.set(t.hotspot_ID, timeStr);
      }
    }

    // 8) Response (+ visitAgain)
    return ordered.map((h: any) => ({
      id: h.hotspot_ID,
      name: h.hotspot_name,
      amount: h.hotspot_adult_entry_cost || 0,
      description: h.hotspot_description || "",
      timeSpend: h.hotspot_duration ? new Date(h.hotspot_duration).getUTCHours() : 0,
      locationMap: h.hotspot_location || null,
      timings: timingMap.get(h.hotspot_ID) || "No timings available",
      visitAgain: alreadyAddedIds.has(Number(h.hotspot_ID)),
    }));
  }


  /**
   * Add a hotspot to an itinerary route
   */
  async addHotspot(data: { planId: number; routeId: number; hotspotId: number }) {
    const userId = 1;

    // 1) Insert the manual hotspot record first
    // We mark it with hotspot_plan_own_way = 1 so the engine preserves it
    await (this.prisma as any).dvi_itinerary_route_hotspot_details.create({
      data: {
        itinerary_plan_ID: data.planId,
        itinerary_route_ID: data.routeId,
        hotspot_ID: data.hotspotId,
        item_type: 4, // Hotspot/Attraction type
        hotspot_plan_own_way: 1, // MARK AS MANUAL
        createdby: userId,
        createdon: new Date(),
        status: 1,
        deleted: 0,
      },
    });

    // 1.5) Remove from excluded list if it was previously deleted
    const route = await (this.prisma as any).dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: data.routeId },
    });

    const excluded = (route?.excluded_hotspot_ids as number[]) || [];
    const filteredExcluded = excluded.filter((id: number) => id !== data.hotspotId);

    await (this.prisma as any).dvi_itinerary_route_details.update({
      where: { itinerary_route_ID: data.routeId },
      data: { excluded_hotspot_ids: filteredExcluded },
    });

    // 2) Trigger a full rebuild of the hotspots for this plan
    // The engine will now see the manual hotspot, keep it, and calculate all travel times/hotel shifts
    const result = await this.prisma.$transaction(async (tx) => {
      return await this.hotspotEngine.rebuildRouteHotspots(tx, data.planId);
    }, { timeout: 60000 });

    return {
      success: true,
      message: 'Hotspot added and timeline recalculated successfully',
      shiftedItems: result.shiftedItems,
      droppedItems: result.droppedItems,
    };
  }

  /**
   * Preview adding a hotspot to an itinerary route
   */
  async previewAddHotspot(data: { planId: number; routeId: number; hotspotId: number }) {
    const result = await this.prisma.$transaction(async (tx) => {
      return await this.hotspotEngine.previewManualHotspotAdd(
        tx,
        data.planId,
        data.routeId,
        data.hotspotId,
      );
    }, { timeout: 60000 });

    return result;
  }

  /**
   * Get available hotels for a route (within 20km radius)
   */
  async getAvailableHotels(routeId: number) {
    // Get route details
    const route = await (this.prisma as any).dvi_itinerary_route_details.findFirst({
      where: { itinerary_route_ID: routeId },
    });

    if (!route || !route.location_id) {
      return [];
    }

    // Get location coordinates separately
    const location = await (this.prisma as any).dvi_stored_locations.findFirst({
      where: { location_ID: Number(route.location_id) },
      select: {
        destination_location_lattitude: true,
        destination_location_longitude: true,
      },
    });

    if (!location || !location.destination_location_lattitude || !location.destination_location_longitude) {
      return [];
    }

    const destLat = Number(location.destination_location_lattitude);
    const destLng = Number(location.destination_location_longitude);

    // Fetch hotels with Haversine distance calculation
    const hotels = await this.prisma.$queryRaw`
      SELECT 
        h.hotel_id,
        h.hotel_name,
        h.hotel_address,
        h.hotel_latitude,
        h.hotel_longitude,
        h.hotel_category,
        (6371 * acos(
          cos(radians(${destLat})) * 
          cos(radians(h.hotel_latitude)) * 
          cos(radians(h.hotel_longitude) - radians(${destLng})) + 
          sin(radians(${destLat})) * 
          sin(radians(h.hotel_latitude))
        )) AS distance_in_km
      FROM dvi_hotel h
      WHERE h.status = 1 
        AND h.deleted = 0
        AND h.hotel_latitude IS NOT NULL
        AND h.hotel_longitude IS NOT NULL
      HAVING distance_in_km <= 20
      ORDER BY distance_in_km ASC
      LIMIT 20
    `;

    return (hotels as any[]).map(h => ({
      id: h.hotel_id,
      name: h.hotel_name,
      address: h.hotel_address,
      category: h.hotel_category,
      distance: Number(h.distance_in_km).toFixed(2),
    }));
  }

  /**
   * Select/update hotel for a route
   */
  async selectHotel(data: { 
    planId: number; 
    routeId: number; 
    hotelId: number; 
    roomTypeId: number;
    groupType?: number;  // ✅ ADD groupType parameter
    mealPlan?: { all?: boolean; breakfast?: boolean; lunch?: boolean; dinner?: boolean; };
  }) {
    const userId = 1;

    // Get the quote ID to clear the cache
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: data.planId },
    });
    const quoteId = (plan as any)?.itinerary_quote_ID || '';

    // Check if hotel assignment already exists in hotel_details
    const existingHotelDetails = await (this.prisma as any).dvi_itinerary_plan_hotel_details.findFirst({
      where: {
        itinerary_plan_id: data.planId,
        itinerary_route_id: data.routeId,
        deleted: 0,
      },
    });

    const mealBreakfast = data.mealPlan?.breakfast || data.mealPlan?.all ? 1 : 0;
    const mealLunch = data.mealPlan?.lunch || data.mealPlan?.all ? 1 : 0;
    const mealDinner = data.mealPlan?.dinner || data.mealPlan?.all ? 1 : 0;

    let hotelDetailsId: number;

    if (existingHotelDetails) {
      // Update existing hotel assignment
      console.log(`📝 Updating existing hotel - Old ID: ${existingHotelDetails.hotel_id}, New ID: ${data.hotelId}, GroupType: ${data.groupType}`);
      await (this.prisma as any).dvi_itinerary_plan_hotel_details.update({
        where: { itinerary_plan_hotel_details_ID: existingHotelDetails.itinerary_plan_hotel_details_ID },
        data: {
          hotel_id: data.hotelId,
          group_type: data.groupType || 1,  // ✅ Save groupType
          updatedon: new Date(),
        },
      });
      const updated = await (this.prisma as any).dvi_itinerary_plan_hotel_details.findUnique({
        where: { itinerary_plan_hotel_details_ID: existingHotelDetails.itinerary_plan_hotel_details_ID },
      });
      console.log(`✅ Updated. New values - hotel_id: ${(updated as any).hotel_id}, group_type: ${(updated as any).group_type}`);
      hotelDetailsId = existingHotelDetails.itinerary_plan_hotel_details_ID;
    } else {
      // Create new hotel assignment
      console.log(`✨ Creating new hotel - ID: ${data.hotelId}, GroupType: ${data.groupType}`);
      const created = await (this.prisma as any).dvi_itinerary_plan_hotel_details.create({
        data: {
          itinerary_plan_id: data.planId,
          itinerary_route_id: data.routeId,
          hotel_id: data.hotelId,
          group_type: data.groupType || 1,  // ✅ Save groupType
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });
      console.log(`✅ Created. Values - hotel_id: ${(created as any).hotel_id}, group_type: ${(created as any).group_type}`);
      hotelDetailsId = created.itinerary_plan_hotel_details_ID;
    }

    // Check if room details already exist
    const existingRoomDetails = await (this.prisma as any).dvi_itinerary_plan_hotel_room_details.findFirst({
      where: {
        itinerary_plan_id: data.planId,
        itinerary_route_id: data.routeId,
        hotel_id: data.hotelId,
        deleted: 0,
      },
    });

    if (existingRoomDetails) {
      // Update existing room details
      await (this.prisma as any).dvi_itinerary_plan_hotel_room_details.update({
        where: { itinerary_plan_hotel_room_details_ID: existingRoomDetails.itinerary_plan_hotel_room_details_ID },
        data: {
          room_type_id: data.roomTypeId,
          breakfast_required: mealBreakfast,
          lunch_required: mealLunch,
          dinner_required: mealDinner,
          updatedon: new Date(),
        },
      });
    } else {
      // Create new room details
      await (this.prisma as any).dvi_itinerary_plan_hotel_room_details.create({
        data: {
          itinerary_plan_hotel_details_id: hotelDetailsId,
          itinerary_plan_id: data.planId,
          itinerary_route_id: data.routeId,
          hotel_id: data.hotelId,
          room_type_id: data.roomTypeId,
          breakfast_required: mealBreakfast,
          lunch_required: mealLunch,
          dinner_required: mealDinner,
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });
    }

    // ✅ Clear cache for this quote so next request gets fresh data
    if (quoteId) {
      this.hotelDetailsTboService.clearCacheForQuote(quoteId);
    }

    return {
      success: true,
      message: 'Hotel selected successfully',
    };
  }

  /**
   * Bulk save hotel selections - used before confirming itinerary
   */
  async bulkSaveHotels(planId: number, hotels: any[]) {
    const userId = 1;

    // Get the quote ID to clear the cache
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: planId },
    });
    const quoteId = (plan as any)?.itinerary_quote_ID || '';

    console.log(`📦 Bulk saving ${hotels.length} hotel(s) for plan ${planId}`);

    for (const hotel of hotels) {
      await this.selectHotel({
        planId,
        routeId: hotel.routeId,
        hotelId: hotel.hotelId,
        roomTypeId: hotel.roomTypeId || 1,
        groupType: hotel.groupType,
        mealPlan: hotel.mealPlan,
      });
    }

    // Clear cache once at the end
    if (quoteId) {
      this.hotelDetailsTboService.clearCacheForQuote(quoteId);
    }

    return {
      success: true,
      message: `Successfully saved ${hotels.length} hotel selections`,
    };
  }

  async selectVehicleVendor(data: {
    planId: number;
    vehicleTypeId: number;
    vendorEligibleId: number;
  }) {
    // First, reset all vendors for this vehicle type to unassigned (0)
    await (this.prisma as any).dvi_itinerary_plan_vendor_eligible_list.updateMany({
      where: {
        itinerary_plan_id: data.planId,
        vehicle_type_id: data.vehicleTypeId,
      },
      data: {
        itineary_plan_assigned_status: 0,
      },
    });

    // Then, set the selected vendor to assigned (1)
    await (this.prisma as any).dvi_itinerary_plan_vendor_eligible_list.update({
      where: {
        itinerary_plan_vendor_eligible_ID: data.vendorEligibleId,
      },
      data: {
        itineary_plan_assigned_status: 1,
      },
    });

    return {
      success: true,
      message: 'Vehicle vendor selected successfully',
    };
  }

  async getPlanForEdit(planId: number) {
    // Fetch the plan
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: planId },
    });

    if (!plan) {
      throw new BadRequestException(`Plan ${planId} not found`);
    }

    // Fetch routes
    const routes = await this.prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: planId, deleted: 0 },
      orderBy: { no_of_days: 'asc' },
    });

    // Fetch via routes for each route
    const routesWithVia = await Promise.all(
      routes.map(async (route) => {
        const viaRoutes = await this.prisma.dvi_itinerary_via_route_details.findMany({
          where: {
            itinerary_plan_ID: planId,
            itinerary_route_ID: route.itinerary_route_ID,
            deleted: 0,
          },
          orderBy: { itinerary_via_route_ID: 'asc' },
        });

        return {
          ...route,
          via_routes: viaRoutes.map(v => ({
            itinerary_via_location_ID: v.itinerary_via_location_ID,
            itinerary_via_location_name: v.itinerary_via_location_name,
          })),
        };
      })
    );

    // Fetch vehicles - note: this table uses lowercase itinerary_plan_id
    const vehicles = await this.prisma.dvi_itinerary_plan_vehicle_details.findMany({
      where: { itinerary_plan_id: planId, deleted: 0 },
      orderBy: { vehicle_details_ID: 'asc' },
    });

    return {
      plan,
      routes: routesWithVia,
      vehicles,
    };
  }

  async getCustomerInfoForm(planId: number) {
    // Get plan details
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: planId },
      select: {
        itinerary_quote_ID: true,
        agent_id: true,
      },
    });

    if (!plan) {
      throw new BadRequestException('Itinerary plan not found');
    }

    // Get agent details
    const agent = await this.prisma.dvi_agent.findUnique({
      where: { agent_ID: plan.agent_id },
      select: {
        agent_name: true,
        total_cash_wallet: true,
      },
    });

    if (!agent) {
      throw new BadRequestException('Agent not found');
    }

    const walletBalance = Number(agent.total_cash_wallet || 0);
    const formattedBalance = walletBalance.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

    return {
      quotation_no: plan.itinerary_quote_ID || '',
      agent_name: agent.agent_name,
      agent_id: plan.agent_id,
      wallet_balance: formattedBalance,
      balance_sufficient: walletBalance > 0,
    };
  }

  async checkWalletBalance(agentId: number) {
    const agent = await this.prisma.dvi_agent.findUnique({
      where: { agent_ID: agentId },
      select: {
        total_cash_wallet: true,
      },
    });

    if (!agent) {
      throw new BadRequestException('Agent not found');
    }

    const balance = Number(agent.total_cash_wallet || 0);
    const formattedBalance = `₹ ${balance.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

    return {
      balance,
      formatted_balance: formattedBalance,
      is_sufficient: balance > 0,
    };
  }

  async getAgentWalletBalance(agentId: number) {
    const agent = await this.prisma.dvi_agent.findUnique({
      where: { agent_ID: agentId },
      select: { total_cash_wallet: true },
    });

    return { balance: Number(agent?.total_cash_wallet || 0) };
  }

  async confirmQuotation(dto: ConfirmQuotationDto) {
    const userId = 1; // TODO: Get from authenticated user

    // 1. Get plan details and cost breakdown
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: dto.itinerary_plan_ID },
    });

    if (!plan) {
      throw new NotFoundException('Itinerary plan not found');
    }

    // TEMP: Allow re-confirmation for testing TBO booking flow
    // TODO: Remove this when TBO booking is fully implemented
    // if (plan.quotation_status === 1) {
    //   throw new BadRequestException('Quotation is already confirmed');
    // }

    const quoteId = plan.itinerary_quote_ID;
    if (!quoteId) {
      throw new BadRequestException('Quote ID not found for this plan');
    }

    const details = await this.itineraryDetails.getItineraryDetails(quoteId);
    const cost = details.costBreakdown;

    // 2. Check wallet balance
    const walletInfo = await this.getAgentWalletBalance(dto.agent);
    if (walletInfo.balance < cost.netPayable) {
      throw new BadRequestException(`Insufficient wallet balance. Required: ${cost.netPayable}, Available: ${walletInfo.balance}`);
    }

    // Parse arrival and departure dates
    const parseDateTime = (dateTimeStr: string) => {
      // Format: "12-12-2025 9:00 AM"
      const [datePart, timePart, meridiem] = dateTimeStr.split(' ');
      const [day, month, year] = datePart.split('-');
      let [hours, minutes] = timePart.split(':').map(Number);
      
      if (meridiem === 'PM' && hours !== 12) hours += 12;
      if (meridiem === 'AM' && hours === 12) hours = 0;
      
      return new Date(Number(year), Number(month) - 1, Number(day), hours, Number(minutes));
    };

    const arrivalDateTime = parseDateTime(dto.arrival_date_time);
    const departureDateTime = parseDateTime(dto.departure_date_time);

    // 2.5 Save draft hotel records with group_type BEFORE transaction
    if (dto.hotel_bookings && dto.hotel_bookings.length > 0) {
      const groupType = Number(dto.hotel_group_type) || 1;
      console.log(`[Confirm Quotation] Saving ${dto.hotel_bookings.length} draft hotel records with group_type=${groupType}`);
      
      for (const booking of dto.hotel_bookings) {
        // For HOBSE: use hotel_code field (16-char alphanumeric like "40fec763d4c6e09e")
        // For TBO/ResAvenue: use hotel_id field (numeric like 6102544)
        const isHobse = booking.provider === 'HOBSE';
        const hotelId = isHobse ? 0 : parseInt(booking.hotelCode);
        
        // Check if draft hotel record already exists
        const findWhere = isHobse
          ? {
              itinerary_plan_id: dto.itinerary_plan_ID,
              itinerary_route_id: booking.routeId,
              hotel_code: booking.hotelCode,
              deleted: 0,
            }
          : {
              itinerary_plan_id: dto.itinerary_plan_ID,
              itinerary_route_id: booking.routeId,
              hotel_id: hotelId,
              deleted: 0,
            };

        const existing = await this.prisma.dvi_itinerary_plan_hotel_details.findFirst({
          where: findWhere as any,
        });

        if (existing) {
          // Update with correct group_type
          await this.prisma.dvi_itinerary_plan_hotel_details.update({
            where: {
              itinerary_plan_hotel_details_ID: existing.itinerary_plan_hotel_details_ID,
            },
            data: {
              group_type: groupType,
              total_hotel_cost: booking.netAmount || 0,
              updatedon: new Date(),
            },
          });
          const hotelIdentifier = isHobse ? booking.hotelCode : hotelId;
          console.log(`✅ Updated draft hotel ${hotelIdentifier} for route ${booking.routeId} with group_type=${groupType}`);
        } else {
          // Create new draft hotel record
          const createData: any = {
            itinerary_plan_id: dto.itinerary_plan_ID,
            itinerary_route_id: booking.routeId,
            group_type: groupType,
            total_hotel_cost: booking.netAmount || 0,
            hotel_required: 1,
            createdby: userId,
            createdon: new Date(),
            status: 1,
            deleted: 0,
          };

          if (isHobse) {
            createData.hotel_id = 0;
            createData.hotel_code = booking.hotelCode;
          } else {
            createData.hotel_id = hotelId;
          }

          await this.prisma.dvi_itinerary_plan_hotel_details.create({
            data: createData,
          });
          const hotelIdentifier = isHobse ? booking.hotelCode : hotelId;
          console.log(`✅ Created draft hotel ${hotelIdentifier} for route ${booking.routeId} with group_type=${groupType}`);
        }
      }
    }

    // 3. Start Transaction
    return await this.prisma.$transaction(async (tx) => {
      // A. Deduct from wallet
      await tx.dvi_cash_wallet.create({
        data: {
          agent_id: dto.agent,
          transaction_date: new Date(),
          transaction_amount: cost.netPayable,
          transaction_type: 2, // Debit
          remarks: `Confirmed Itinerary: ${quoteId}`,
          transaction_id: quoteId,
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });

      // Update agent balance
      await tx.dvi_agent.update({
        where: { agent_ID: dto.agent },
        data: {
          total_cash_wallet: {
            decrement: cost.netPayable,
          },
        },
      });

      // B. Insert into dvi_confirmed_itinerary_plan_details
      const confirmedPlan = await tx.dvi_confirmed_itinerary_plan_details.create({
        data: {
          itinerary_plan_ID: plan.itinerary_plan_ID,
          agent_id: dto.agent,
          staff_id: plan.staff_id || 0,
          location_id: plan.location_id || 0n,
          arrival_location: plan.arrival_location,
          departure_location: plan.departure_location,
          itinerary_quote_ID: plan.itinerary_quote_ID,
          trip_start_date_and_time: plan.trip_start_date_and_time,
          trip_end_date_and_time: plan.trip_end_date_and_time,
          arrival_type: plan.arrival_type || 0,
          departure_type: plan.departure_type || 0,
          expecting_budget: plan.expecting_budget || 0,
          itinerary_type: plan.itinerary_type || 0,
          entry_ticket_required: plan.entry_ticket_required || 0,
          no_of_routes: plan.no_of_routes || 0,
          no_of_days: plan.no_of_days || 0,
          no_of_nights: plan.no_of_nights || 0,
          total_adult: plan.total_adult || 0,
          total_children: plan.total_children || 0,
          total_infants: plan.total_infants || 0,
          nationality: plan.nationality || 0,
          itinerary_preference: plan.itinerary_preference || 0,
          meal_plan_breakfast: plan.meal_plan_breakfast || 0,
          meal_plan_lunch: plan.meal_plan_lunch || 0,
          meal_plan_dinner: plan.meal_plan_dinner || 0,
          preferred_room_count: plan.preferred_room_count || 0,
          total_extra_bed: plan.total_extra_bed || 0,
          total_child_with_bed: plan.total_child_with_bed || 0,
          total_child_without_bed: plan.total_child_without_bed || 0,
          guide_for_itinerary: plan.guide_for_itinerary || 0,
          food_type: plan.food_type || 0,
          special_instructions: plan.special_instructions,
          pick_up_date_and_time: plan.pick_up_date_and_time,
          hotel_terms_condition: (plan as any).hotel_terms_condition,
          vehicle_terms_condition: (plan as any).vehicle_terms_condition,
          hotel_rates_visibility: plan.hotel_rates_visibility || 0,
          
          // Costs from breakdown
          total_hotspot_charges: cost.totalHotspotCost || 0,
          total_activity_charges: cost.totalActivityCost || 0,
          total_hotel_charges: cost.totalHotelAmount || 0,
          total_vehicle_charges: cost.totalVehicleAmount || 0,
          total_guide_charges: cost.totalGuideCost || 0,
          itinerary_sub_total: (cost.totalHotelAmount || 0) + (cost.totalVehicleAmount || 0),
          itinerary_agent_margin_charges: cost.agentMargin || 0,
          itinerary_gross_total_amount: cost.totalAmount || 0,
          itinerary_total_margin_cost: cost.additionalMargin || 0,
          itinerary_total_net_payable_amount: cost.netPayable,
          itinerary_total_paid_amount: cost.netPayable,
          itinerary_total_balance_amount: 0,
          
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });

      const confirmedPlanId = confirmedPlan.confirmed_itinerary_plan_ID;

      // C. Insert Primary Guest
      const primaryCustomerSalutation =
        normalizePassengerTitle(dto.primary_guest_salutation) || dto.primary_guest_salutation || '';
      const additionalAdultPassengerTitles =
        dto.hotel_bookings?.[0]?.passengers
          ?.filter((passenger) => Number(passenger.paxType) === 1 && !passenger.leadPassenger)
          .map((passenger) => normalizePassengerTitle(passenger.title) || '') || [];

      await tx.dvi_confirmed_itinerary_customer_details.create({
        data: {
          confirmed_itinerary_plan_ID: confirmedPlanId,
          itinerary_plan_ID: dto.itinerary_plan_ID,
          agent_id: dto.agent,
          primary_customer: 1,
          customer_type: 1, // Adult
          customer_salutation: primaryCustomerSalutation,
          customer_name: dto.primary_guest_name,
          customer_age: parseInt(dto.primary_guest_age) || 0,
          primary_contact_no: dto.primary_guest_contact_no,
          altenative_contact_no: dto.primary_guest_alternative_contact_no || '',
          email_id: dto.primary_guest_email_id || '',
          arrival_date_and_time: arrivalDateTime,
          arrival_place: dto.arrival_place,
          arrival_flight_details: dto.arrival_flight_details || '',
          departure_date_and_time: departureDateTime,
          departure_place: dto.departure_place,
          departure_flight_details: dto.departure_flight_details || '',
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });

      // D. Insert Additional Adults
      if (dto.adult_name && dto.adult_name.length > 0) {
        for (let i = 0; i < dto.adult_name.length; i++) {
          if (dto.adult_name[i]) {
            await tx.dvi_confirmed_itinerary_customer_details.create({
              data: {
                confirmed_itinerary_plan_ID: confirmedPlanId,
                itinerary_plan_ID: dto.itinerary_plan_ID,
                agent_id: dto.agent,
                primary_customer: 0,
                customer_type: 1, // Adult
                customer_salutation: additionalAdultPassengerTitles[i] || '',
                customer_name: dto.adult_name[i],
                customer_age: parseInt(dto.adult_age?.[i] || '0') || 0,
                createdby: userId,
                createdon: new Date(),
                status: 1,
                deleted: 0,
              },
            });
          }
        }
      }

      // E. Insert Children
      if (dto.child_name && dto.child_name.length > 0) {
        for (let i = 0; i < dto.child_name.length; i++) {
          if (dto.child_name[i]) {
            await tx.dvi_confirmed_itinerary_customer_details.create({
              data: {
                confirmed_itinerary_plan_ID: confirmedPlanId,
                itinerary_plan_ID: dto.itinerary_plan_ID,
                agent_id: dto.agent,
                primary_customer: 0,
                customer_type: 2, // Child
                customer_name: dto.child_name[i],
                customer_age: parseInt(dto.child_age?.[i] || '0') || 0,
                createdby: userId,
                createdon: new Date(),
                status: 1,
                deleted: 0,
              },
            });
          }
        }
      }

      // F. Insert Infants
      if (dto.infant_name && dto.infant_name.length > 0) {
        for (let i = 0; i < dto.infant_name.length; i++) {
          if (dto.infant_name[i]) {
            await tx.dvi_confirmed_itinerary_customer_details.create({
              data: {
                confirmed_itinerary_plan_ID: confirmedPlanId,
                itinerary_plan_ID: dto.itinerary_plan_ID,
                agent_id: dto.agent,
                primary_customer: 0,
                customer_type: 3, // Infant
                customer_name: dto.infant_name[i],
                customer_age: parseInt(dto.infant_age?.[i] || '0') || 0,
                createdby: userId,
                createdon: new Date(),
                status: 1,
                deleted: 0,
              },
            });
          }
        }
      }

      // G. Copy related tables (Travellers, Vehicles, Routes, Via Routes, Hotels, Hotspots, Activities)
      await this.copyDraftToConfirmed(tx, dto.itinerary_plan_ID, confirmedPlanId, userId);

      // H. Insert into dvi_accounts_itinerary_details
      await tx.dvi_accounts_itinerary_details.create({
        data: {
          itinerary_plan_ID: dto.itinerary_plan_ID,
          agent_id: dto.agent,
          staff_id: plan.staff_id || 0,
          confirmed_itinerary_plan_ID: confirmedPlanId,
          itinerary_quote_ID: plan.itinerary_quote_ID,
          trip_start_date_and_time: plan.trip_start_date_and_time,
          trip_end_date_and_time: plan.trip_end_date_and_time,
          total_billed_amount: cost.netPayable,
          total_received_amount: cost.netPayable,
          total_receivable_amount: 0,
          total_payable_amount: cost.totalAmount, // Total cost before agent margin
          total_payout_amount: 0,
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });

      // I. Update draft plan status
      await tx.dvi_itinerary_plan_details.update({
        where: { itinerary_plan_ID: dto.itinerary_plan_ID },
        data: {
          quotation_status: 1, // Confirmed
          updatedon: new Date(),
        },
      });

      return {
        success: true,
        message: 'Quotation confirmed successfully',
        itinerary_plan_ID: dto.itinerary_plan_ID,
        confirmed_itinerary_plan_ID: confirmedPlanId,
        bookingResults: null, // Will be set after transaction
      };
    });
  }

  async prebookHotels(payload: {
    itinerary_plan_ID: number;
    hotel_bookings: Array<{
      routeId: number;
      provider: string;
      hotelCode: string;
      bookingCode: string;
      roomType: string;
      checkInDate: string;
      checkOutDate: string;
      numberOfRooms: number;
      guestNationality: string;
      netAmount: number;
      searchInitiatedAt?: string;
      occupancies?: Array<{
        adults: number;
        children: number;
        childrenAges?: number[];
      }>;
      passengers: Array<{
        title: string;
        firstName: string;
        middleName?: string;
        lastName: string;
        email?: string;
        paxType: number;
        leadPassenger: boolean;
        age: number;
        pan?: string;
        panNo?: string;
        passportNo?: string;
        passportIssueDate?: string;
        passportExpDate?: string;
        phoneNo?: string;
        gstNumber?: string;
        gstCompanyName?: string;
      }>;
    }>;
    endUserIp?: string;
  }) {
    if (!payload?.hotel_bookings || payload.hotel_bookings.length === 0) {
      throw new BadRequestException('hotel_bookings is required for prebook');
    }

    const tboHotels = payload.hotel_bookings.filter(
      (hotel) => String(hotel.provider || '').toLowerCase() === 'tbo',
    );

    if (tboHotels.length === 0) {
      return {
        success: true,
        message: 'No TBO hotels selected for prebook',
        itinerary_plan_ID: payload.itinerary_plan_ID,
        hotels: [],
        updatedTotalPrice: 0,
        finalPrice: 0,
        totalAmount: 0,
        cancellationPolicy: null,
        cancellationPoliciesText: null,
        roomPromotion: null,
        rateConditions: [],
        mandatorySupplements: [],
        normalizedSupplements: [], // ✅ NEW
      };
    }

    const prebookResults: any[] = [];

    for (const hotel of tboHotels) {
      const resolvedBookingCode = await this.resolvePrebookBookingCode(
        payload.itinerary_plan_ID,
        hotel,
      );

      const selection = {
        hotelCode: hotel.hotelCode,
        bookingCode: resolvedBookingCode,
        roomType: hotel.roomType,
        checkInDate: hotel.checkInDate,
        checkOutDate: hotel.checkOutDate,
        numberOfRooms: hotel.numberOfRooms,
        guestNationality: hotel.guestNationality,
        netAmount: hotel.netAmount,
        searchInitiatedAt: hotel.searchInitiatedAt,
        occupancies: hotel.occupancies,
        passengers: (hotel.passengers || []).map((p) => ({
          title: p.title,
          firstName: p.firstName,
          middleName: p.middleName,
          lastName: p.lastName,
          email: p.email,
          paxType: p.paxType,
          leadPassenger: p.leadPassenger,
          age: p.age,
          pan: p.pan || p.panNo,
          passportNo: p.passportNo,
          passportIssueDate: p.passportIssueDate,
          passportExpDate: p.passportExpDate,
          phoneNo: p.phoneNo,
          gstNumber: p.gstNumber,
          gstCompanyName: p.gstCompanyName,
        })),
      };

      const prebookResponse = await this.tboHotelBooking.preBookHotel(selection as any);
      const prebookRequestPayload = (prebookResponse as any)?.__requestPayload || null;
      const rawRoomDetails = [
        ...this.normalizeToArray(prebookResponse?.HotelRoomsDetails),
        ...this.normalizeToArray(prebookResponse?.HotelResult)
          .flatMap((hotelResult: any) => this.normalizeToArray(hotelResult?.Rooms)),
      ].filter(Boolean);

      const prebookCancelPoliciesDebug = rawRoomDetails
        .flatMap((room: any) => this.normalizeToArray(room?.CancelPolicies ?? room?.CancellationPolicy))
        .filter(Boolean);
      console.log(
        '[ItinerariesService] 📥 PreBook API room snapshot:',
        JSON.stringify({
          routeId: hotel.routeId,
          hotelCode: hotel.hotelCode,
          status: prebookResponse?.Status,
          bookingCode: prebookResponse?.BookingCode || hotel.bookingCode,
          roomCount: rawRoomDetails.length,
          cancelPoliciesCount: prebookCancelPoliciesDebug.length,
          sampleCancelPolicy: prebookCancelPoliciesDebug[0] || null,
        }),
      );
      console.log(
        '[ItinerariesService] 📥 Full PreBook API response:',
        JSON.stringify(prebookResponse),
      );
      
      // Extract raw mandatory supplements
      const mandatorySupplements = rawRoomDetails
        .flatMap((room: any) => this.normalizeToArray(room?.MandatorySupplements ?? room?.MandatorySupplement))
        .filter(Boolean);
      
      // ✅ Extract raw supplements if present
      const rawSupplements = rawRoomDetails
        .flatMap((room: any) => this.normalizeToArray(room?.Supplements))
        .filter(Boolean);

      // ✅ Normalize all supplements for display
      const normalizedMandatorySupplements = this.supplementNormalizer.normalizeSupplements(
        mandatorySupplements,
        'prebook',
      );
      const normalizedSupplements = this.supplementNormalizer.normalizeSupplements(
        rawSupplements,
        'prebook',
      );
      const allNormalizedSupplements = [
        ...normalizedMandatorySupplements,
        ...normalizedSupplements,
      ];

      const roomPromotions = rawRoomDetails
        .flatMap((room: any) => this.normalizeToArray(room?.RoomPromotion ?? room?.RoomPromotions))
        .filter(Boolean);
      const rateConditions = rawRoomDetails
        .flatMap((room: any) => this.normalizeToArray(room?.RateConditions))
        .filter(Boolean);
      const cancellationPolicies = rawRoomDetails
        .flatMap((room: any) => this.normalizeToArray(room?.CancelPolicies ?? room?.CancellationPolicy))
        .filter(Boolean);
      const inclusions = rawRoomDetails
        .flatMap((room: any) => this.normalizeToArray(room?.Inclusion))
        .filter(Boolean);

      const candidatePrices = [
        prebookResponse?.NetAmount,
        prebookResponse?.TotalFare,
        prebookResponse?.PriceVerification?.FinalPrice,
        ...rawRoomDetails.map((room: any) => room?.TotalFare),
      ];
      const finalPriceCandidate = candidatePrices.find(
        (price) => typeof price === 'number' || (typeof price === 'string' && price !== ''),
      );
      const finalPrice = finalPriceCandidate !== undefined ? Number(finalPriceCandidate) : 0;

      prebookResults.push({
        routeId: hotel.routeId,
        hotelCode: hotel.hotelCode,
        bookingCode: prebookResponse?.BookingCode || hotel.bookingCode,
        updatedTotalPrice: finalPrice,
        finalPrice,
        totalAmount: finalPrice,
        cancellationPolicy: cancellationPolicies,
        cancellationPoliciesText: cancellationPolicies.length
          ? JSON.stringify(cancellationPolicies)
          : null,
        roomPromotion: roomPromotions.length ? roomPromotions.join(', ') : null,
        rateConditions,
        inclusions,
        mandatorySupplements,
        // ✅ NEW: include normalized supplements
        normalizedSupplements: allNormalizedSupplements,
        supplements: rawSupplements,
        isPriceChanged: Boolean(prebookResponse?.IsPriceChanged),
        isCancellationPolicyChanged: Boolean(prebookResponse?.IsCancellationPolicyChanged),
        rawStatus: prebookResponse?.Status,
        certificationTrace: {
          guestNationality: selection.guestNationality,
          prebookRequest: prebookRequestPayload,
        },
      });
    }

    const totalAmount = prebookResults.reduce(
      (sum, item) => sum + Number(item.finalPrice || item.updatedTotalPrice || 0),
      0,
    );
    const cancellationPoliciesAll = prebookResults.flatMap((item) => item.cancellationPolicy || []);
    const roomPromotionsAll = prebookResults
      .flatMap((item) => (item.roomPromotion ? [item.roomPromotion] : []))
      .filter(Boolean);
    const rateConditionsAll = prebookResults.flatMap((item) => item.rateConditions || []);
    const inclusionsAll = prebookResults.flatMap((item) => item.inclusions || []);
    const mandatorySupplementsAll = prebookResults.flatMap((item) => item.mandatorySupplements || []);
    // ✅ NEW: Extract normalized supplements from prebook results
    const normalizedSupplementsAll = prebookResults.flatMap((item) => item.normalizedSupplements || []);

    return {
      success: true,
      message: `Prebook completed for ${prebookResults.length} hotel(s)`,
      itinerary_plan_ID: payload.itinerary_plan_ID,
      hotels: prebookResults,
      updatedTotalPrice: totalAmount,
      finalPrice: totalAmount,
      totalAmount,
      cancellationPolicy: cancellationPoliciesAll.length
        ? JSON.stringify(cancellationPoliciesAll)
        : null,
      cancellationPoliciesText: cancellationPoliciesAll.length
        ? JSON.stringify(cancellationPoliciesAll)
        : null,
      roomPromotion: roomPromotionsAll.length ? roomPromotionsAll.join(', ') : null,
      rateConditions: rateConditionsAll,
      inclusions: inclusionsAll,
      mandatorySupplements: mandatorySupplementsAll,
      // ✅ NEW: include normalized supplements for frontend display
      normalizedSupplements: normalizedSupplementsAll,
    };
  }

  private async resolvePrebookBookingCode(
    itineraryPlanId: number,
    hotel: {
      routeId: number;
      hotelCode: string;
      bookingCode?: string;
      roomType?: string;
    },
  ): Promise<string> {
    const incomingBookingCode = String(hotel.bookingCode || '').trim();
    if (incomingBookingCode.includes('!TB!')) {
      return incomingBookingCode;
    }

    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: itineraryPlanId },
      select: { itinerary_quote_ID: true },
    });

    const quoteId = String((plan as any)?.itinerary_quote_ID || '').trim();
    if (!quoteId) {
      throw new BadRequestException(
        'Unable to resolve itinerary quote for fresh hotel room validation. Please refresh hotel search and try prebook again.',
      );
    }

    // Force a fresh room search to avoid stale cached booking codes.
    this.hotelDetailsTboService.clearCacheForQuote(quoteId);
    const roomDetails = await this.hotelDetailsTboService.getHotelRoomDetailsFromTbo(
      quoteId,
      Number(hotel.routeId),
    );

    const hotelCode = String(hotel.hotelCode || '').trim();
    const requestedRoomType = String(hotel.roomType || '').trim().toLowerCase();

    const matchingRooms = (roomDetails?.rooms || []).filter(
      (room: any) =>
        Number(room.itineraryRouteId) === Number(hotel.routeId) &&
        String(room.hotelId || '') === hotelCode,
    );

    if (matchingRooms.length === 0) {
      throw new BadRequestException(
        'No fresh room options found for selected hotel. Please run hotel search again and select a room before prebook.',
      );
    }

    const roomTypeMatch = requestedRoomType
      ? matchingRooms.find((room: any) => {
          const roomTypeName = String(room.roomTypeName || '').toLowerCase();
          if (roomTypeName && roomTypeName === requestedRoomType) {
            return true;
          }

          const availableRoomTypes = Array.isArray(room.availableRoomTypes)
            ? room.availableRoomTypes
            : [];
          return availableRoomTypes.some(
            (rt: any) =>
              String(rt.roomTypeTitle || '').toLowerCase() === requestedRoomType,
          );
        })
      : undefined;

    const selectedRoom = roomTypeMatch || matchingRooms[0];
    const selectedBookingCode =
      String(selectedRoom?.bookingCode || '').trim() ||
      String(selectedRoom?.availableRoomTypes?.[0]?.bookingCode || '').trim();

    if (!selectedBookingCode || !selectedBookingCode.includes('!TB!')) {
      throw new BadRequestException(
        'Fresh room booking code not available for selected hotel. Please refresh hotel selection and prebook again.',
      );
    }

    return selectedBookingCode;
  }

  /**
   * After transaction completes, handle hotel bookings for all providers
   * This is done outside transaction to avoid locking issues with external API calls
   */
  async processConfirmationWithTboBookings(
    baseResult: any,
    dto: ConfirmQuotationDto,
    endUserIp: string = '192.168.1.1',
  ) {
    const userId = 1; // TODO: Get from authenticated user

    // If no hotels selected, return base result
    if (!dto.hotel_bookings || dto.hotel_bookings.length === 0) {
      console.log('[Hotel Booking] No hotels to process');
      return baseResult;
    }

    console.log('[Hotel Booking] Processing', dto.hotel_bookings.length, 'hotel(s)');
    console.log('[Hotel Booking] Hotels:', JSON.stringify(dto.hotel_bookings, null, 2));

    // Group hotels by provider
    const tboHotels = dto.hotel_bookings.filter(h => h.provider === 'tbo');
    const resavenueHotels = dto.hotel_bookings.filter(h => h.provider === 'ResAvenue');
    const hobseHotels = dto.hotel_bookings.filter(h => h.provider === 'HOBSE');

    console.log('[Hotel Booking] TBO:', tboHotels.length, 'ResAvenue:', resavenueHotels.length, 'HOBSE:', hobseHotels.length);

    const allBookingResults: any[] = [];

    try {
      // Process TBO hotels if any
      if (tboHotels.length > 0) {
        console.log('[TBO Booking] Processing', tboHotels.length, 'hotel(s)');
        const selections = tboHotels.map((hotel) => ({
        routeId: hotel.routeId,
        selection: {
          hotelCode: hotel.hotelCode,
          bookingCode: hotel.bookingCode,
          roomType: hotel.roomType,
          checkInDate: hotel.checkInDate,
          checkOutDate: hotel.checkOutDate,
          numberOfRooms: hotel.numberOfRooms,
          guestNationality: hotel.guestNationality,
          netAmount: hotel.netAmount,
          searchInitiatedAt: (hotel as any).searchInitiatedAt,
          occupancies: hotel.occupancies?.map((occ) => ({
            adults: occ.adults,
            children: occ.children,
            childrenAges: occ.childrenAges,
          })),
          passengers: hotel.passengers.map((p) => ({
            title: p.title,
            firstName: p.firstName,
            middleName: p.middleName,
            lastName: p.lastName,
            email: p.email,
            paxType: p.paxType,
            leadPassenger: p.leadPassenger,
            age: p.age,
            passportNo: p.passportNo,
            passportIssueDate: p.passportIssueDate,
            passportExpDate: p.passportExpDate,
            phoneNo: p.phoneNo,
            gstNumber: p.gstNumber,
            gstCompanyName: p.gstCompanyName,
            pan: p.pan || p.panNo,
          })),
        },
      }));

        // Call TBO booking service with group_type
        const tboBookingResults = await this.tboHotelBooking.confirmItineraryHotels(
          baseResult.confirmed_itinerary_plan_ID,
          baseResult.itinerary_plan_ID,
          selections,
          endUserIp || dto.endUserIp || '192.168.1.1',
          userId,
          Number(dto.hotel_group_type) || 1, // Pass the group_type
        );
        allBookingResults.push(...tboBookingResults);
      }

      // Process ResAvenue hotels if any
      if (resavenueHotels.length > 0) {
        console.log('[ResAvenue Booking] Processing', resavenueHotels.length, 'hotel(s)');
        
        const resavenueSelections = resavenueHotels.map((hotel) => {
          // Note: invCode and rateCode should ideally be fetched from hotel detail table
          // For now, using fallback values that allow Rate Fetch API to be called
          const invCode = 1;
          const rateCode = 524; // Fallback rate code for Testing
          
          console.log(
            `[ResAvenue] Hotel ${hotel.hotelCode}: Using InvCode=${invCode}, RateCode=${rateCode}`,
          );

          return {
            routeId: hotel.routeId,
            selection: {
              hotelCode: hotel.hotelCode,
              bookingCode: hotel.bookingCode,
              roomType: hotel.roomType,
              checkInDate: hotel.checkInDate,
              checkOutDate: hotel.checkOutDate,
              numberOfRooms: hotel.numberOfRooms,
              guestNationality: hotel.guestNationality,
              netAmount: hotel.netAmount,
              guests: hotel.passengers.map((p) => ({
                firstName: p.firstName,
                lastName: p.lastName,
                email: p.email,
                phone: p.phoneNo,
              })),
            },
            invCode: invCode,
            rateCode: rateCode,
          };
        });

        // Call ResAvenue booking service
        const resavenueBookingResults = await this.resavenueHotelBooking.confirmItineraryHotels(
          baseResult.confirmed_itinerary_plan_ID,
          baseResult.itinerary_plan_ID,
          resavenueSelections,
          userId,
        );
        allBookingResults.push(...resavenueBookingResults);
      }

      // Process HOBSE hotels if any
      if (hobseHotels.length > 0) {
        console.log('[HOBSE Booking] Processing', hobseHotels.length, 'hotel(s)');
        
        // Call HOBSE booking service
        const hobseBookingResults = await this.hobseHotelBooking.confirmItineraryHotels(
          baseResult.itinerary_plan_ID,
          hobseHotels,
          {
            salutation:
              normalizePassengerTitle(
                (dto as any).primary_guest_salutation,
                (dto as any).title,
                dto.hotel_bookings?.[0]?.passengers?.find((p) => p.leadPassenger)?.title,
              ) || '',
            name: (dto as any).contactName || 'Guest',
            email: (dto as any).contactEmail || '',
            phone: (dto as any).contactPhone || '',
          }
        );
        allBookingResults.push(...hobseBookingResults);
      }

      // Add all booking results to response
      return {
        ...baseResult,
        bookingResults: allBookingResults,
      };
    } catch (error) {
      console.error('Error processing hotel bookings:', error);
      // Return base result even if booking fails
      // The quotation is already confirmed
      return {
        ...baseResult,
        bookingResults: {
          status: 'error',
          message: error.message,
        },
      };
    }
  }

  private async copyDraftToConfirmed(tx: any, draftPlanId: number, confirmedPlanId: number, userId: number) {
    // 2. Vehicles
    const vehicles = await tx.dvi_itinerary_plan_vehicle_details.findMany({
      where: { itinerary_plan_id: draftPlanId, deleted: 0 },
    });
    for (const v of vehicles) {
      await tx.dvi_confirmed_itinerary_plan_vehicle_details.create({
        data: {
          vehicle_details_ID: v.vehicle_details_ID,
          itinerary_plan_id: draftPlanId,
          vehicle_type_id: v.vehicle_type_id,
          vehicle_count: v.vehicle_count,
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });
    }

    // 3. Routes
    const routes = await tx.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: draftPlanId, deleted: 0 },
    });
    for (const r of routes) {
      await tx.dvi_confirmed_itinerary_route_details.create({
        data: {
          itinerary_route_ID: r.itinerary_route_ID,
          itinerary_plan_ID: draftPlanId,
          location_id: r.location_id,
          location_name: r.location_name,
          itinerary_route_date: r.itinerary_route_date,
          no_of_days: r.no_of_days,
          no_of_km: r.no_of_km,
          direct_to_next_visiting_place: r.direct_to_next_visiting_place,
          next_visiting_location: r.next_visiting_location,
          route_start_time: r.route_start_time,
          route_end_time: r.route_end_time,
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });
    }

    // 4. Via Routes
    const viaRoutes = await tx.dvi_itinerary_via_route_details.findMany({
      where: { itinerary_plan_ID: draftPlanId, deleted: 0 },
    });
    for (const vr of viaRoutes) {
      await tx.dvi_confirmed_itinerary_via_route_details.create({
        data: {
          itinerary_via_route_ID: vr.itinerary_via_route_ID,
          itinerary_route_ID: vr.itinerary_route_ID,
          itinerary_route_date: vr.itinerary_route_date,
          itinerary_plan_ID: draftPlanId,
          source_location: vr.source_location,
          destination_location: vr.destination_location,
          itinerary_via_location_ID: vr.itinerary_via_location_ID,
          itinerary_via_location_name: vr.itinerary_via_location_name,
          itinerary_session_id: vr.itinerary_session_id,
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });
    }

    // 5. Hotels
    const hotels = await tx.dvi_itinerary_plan_hotel_details.findMany({
      where: { itinerary_plan_id: draftPlanId, deleted: 0 },
    });
    for (const h of hotels) {
      await tx.dvi_confirmed_itinerary_plan_hotel_details.create({
        data: {
          itinerary_plan_hotel_details_ID: h.itinerary_plan_hotel_details_ID,
          group_type: h.group_type,
          itinerary_plan_id: draftPlanId,
          itinerary_route_id: h.itinerary_route_id,
          itinerary_route_date: h.itinerary_route_date,
          itinerary_route_location: h.itinerary_route_location,
          hotel_required: h.hotel_required,
          hotel_category_id: h.hotel_category_id,
          hotel_id: h.hotel_id,
          hotel_margin_percentage: h.hotel_margin_percentage,
          hotel_margin_gst_type: h.hotel_margin_gst_type,
          hotel_margin_gst_percentage: h.hotel_margin_gst_percentage,
          hotel_margin_rate: h.hotel_margin_rate,
          hotel_margin_rate_tax_amt: h.hotel_margin_rate_tax_amt,
          hotel_breakfast_cost: h.hotel_breakfast_cost,
          hotel_breakfast_cost_gst_amount: h.hotel_breakfast_cost_gst_amount,
          hotel_lunch_cost: h.hotel_lunch_cost,
          hotel_lunch_cost_gst_amount: h.hotel_lunch_cost_gst_amount,
          hotel_dinner_cost: h.hotel_dinner_cost,
          hotel_dinner_cost_gst_amount: h.hotel_dinner_cost_gst_amount,
          total_no_of_persons: h.total_no_of_persons,
          total_hotel_meal_plan_cost: h.total_hotel_meal_plan_cost,
          total_hotel_meal_plan_cost_gst_amount: h.total_hotel_meal_plan_cost_gst_amount,
          total_extra_bed_cost: h.total_extra_bed_cost,
          total_extra_bed_cost_gst_amount: h.total_extra_bed_cost_gst_amount,
          total_childwith_bed_cost: h.total_childwith_bed_cost,
          total_childwith_bed_cost_gst_amount: h.total_childwith_bed_cost_gst_amount,
          total_childwithout_bed_cost: h.total_childwithout_bed_cost,
          total_childwithout_bed_cost_gst_amount: h.total_childwithout_bed_cost_gst_amount,
          total_no_of_rooms: h.total_no_of_rooms,
          total_room_cost: h.total_room_cost,
          total_room_gst_amount: h.total_room_gst_amount,
          total_hotel_cost: h.total_hotel_cost,
          total_amenities_cost: h.total_amenities_cost,
          total_amenities_gst_amount: h.total_amenities_gst_amount,
          total_hotel_tax_amount: h.total_hotel_tax_amount,
        },
      });
    }

    // 5a. Hotel Room Details
    const hotelRooms = await tx.dvi_itinerary_plan_hotel_room_details.findMany({
      where: { itinerary_plan_id: draftPlanId, deleted: 0 },
    });
    for (const hr of hotelRooms) {
      await tx.dvi_confirmed_itinerary_plan_hotel_room_details.create({
        data: {
          itinerary_plan_hotel_room_details_ID: hr.itinerary_plan_hotel_room_details_ID,
          itinerary_plan_hotel_details_id: hr.itinerary_plan_hotel_details_id,
          group_type: hr.group_type,
          itinerary_plan_id: draftPlanId,
          itinerary_route_id: hr.itinerary_route_id,
          itinerary_route_date: hr.itinerary_route_date,
          hotel_id: hr.hotel_id,
          room_type_id: hr.room_type_id,
          room_id: hr.room_id,
          room_qty: hr.room_qty,
          room_rate: hr.room_rate,
          gst_type: hr.gst_type,
          gst_percentage: hr.gst_percentage,
          extra_bed_count: hr.extra_bed_count,
          extra_bed_rate: hr.extra_bed_rate,
          child_without_bed_count: hr.child_without_bed_count,
          child_without_bed_charges: hr.child_without_bed_charges,
          child_with_bed_count: hr.child_with_bed_count,
          child_with_bed_charges: hr.child_with_bed_charges,
          breakfast_required: hr.breakfast_required,
          lunch_required: hr.lunch_required,
          dinner_required: hr.dinner_required,
          breakfast_cost_per_person: hr.breakfast_cost_per_person,
          lunch_cost_per_person: hr.lunch_cost_per_person,
          dinner_cost_per_person: hr.dinner_cost_per_person,
          total_breafast_cost: hr.total_breafast_cost,
          total_lunch_cost: hr.total_lunch_cost,
          total_dinner_cost: hr.total_dinner_cost,
          total_room_cost: hr.total_room_cost,
          total_room_gst_amount: hr.total_room_gst_amount,
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });
    }

    // 5b. Hotel Room Amenities
    const hotelAmenities = await tx.dvi_itinerary_plan_hotel_room_amenities.findMany({
      where: { itinerary_plan_id: draftPlanId, deleted: 0 },
    });
    for (const ha of hotelAmenities) {
      await tx.dvi_confirmed_itinerary_plan_hotel_room_amenities.create({
        data: {
          itinerary_plan_hotel_room_amenities_details_ID: ha.itinerary_plan_hotel_room_amenities_details_ID,
          itinerary_plan_hotel_details_id: ha.itinerary_plan_hotel_details_id,
          group_type: ha.group_type,
          itinerary_plan_id: draftPlanId,
          itinerary_route_id: ha.itinerary_route_id,
          itinerary_route_date: ha.itinerary_route_date,
          hotel_id: ha.hotel_id,
          hotel_amenities_id: ha.hotel_amenities_id,
          total_qty: ha.total_qty,
          amenitie_rate: ha.amenitie_rate,
          total_amenitie_cost: ha.total_amenitie_cost,
          total_amenitie_gst_amount: ha.total_amenitie_gst_amount,
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });
    }

    // 6. Hotspots
    const hotspots = await tx.dvi_itinerary_route_hotspot_details.findMany({
      where: { itinerary_plan_ID: draftPlanId, deleted: 0 },
    });
    for (const hs of hotspots) {
      await tx.dvi_confirmed_itinerary_route_hotspot_details.create({
        data: {
          route_hotspot_ID: hs.route_hotspot_ID,
          itinerary_plan_ID: draftPlanId,
          itinerary_route_ID: hs.itinerary_route_ID,
          item_type: hs.item_type,
          hotspot_order: hs.hotspot_order,
          hotspot_ID: hs.hotspot_ID,
          hotspot_adult_entry_cost: hs.hotspot_adult_entry_cost,
          hotspot_child_entry_cost: hs.hotspot_child_entry_cost,
          hotspot_infant_entry_cost: hs.hotspot_infant_entry_cost,
          hotspot_foreign_adult_entry_cost: hs.hotspot_foreign_adult_entry_cost,
          hotspot_foreign_child_entry_cost: hs.hotspot_foreign_child_entry_cost,
          hotspot_foreign_infant_entry_cost: hs.hotspot_foreign_infant_entry_cost,
          hotspot_amout: hs.hotspot_amout,
          hotspot_traveling_time: hs.hotspot_traveling_time,
          itinerary_travel_type_buffer_time: hs.itinerary_travel_type_buffer_time,
          hotspot_travelling_distance: hs.hotspot_travelling_distance,
          hotspot_start_time: hs.hotspot_start_time,
          hotspot_end_time: hs.hotspot_end_time,
          allow_break_hours: hs.allow_break_hours,
          allow_via_route: hs.allow_via_route,
          via_location_name: hs.via_location_name,
          hotspot_plan_own_way: hs.hotspot_plan_own_way,
          createdby: userId,
          status: 1,
        },
      });
    }

    // 7. Activities
    const activities = await tx.dvi_itinerary_route_activity_details.findMany({
      where: { itinerary_plan_ID: draftPlanId, deleted: 0 },
    });
    for (const a of activities) {
      await tx.dvi_confirmed_itinerary_route_activity_details.create({
        data: {
          route_activity_ID: a.route_activity_ID,
          itinerary_plan_ID: draftPlanId,
          itinerary_route_ID: a.itinerary_route_ID,
          route_hotspot_ID: a.route_hotspot_ID,
          hotspot_ID: a.hotspot_ID,
          activity_ID: a.activity_ID,
          activity_order: a.activity_order,
          activity_charges_for_foreign_adult: a.activity_charges_for_foreign_adult,
          activity_charges_for_foreign_children: a.activity_charges_for_foreign_children,
          activity_charges_for_foreign_infant: a.activity_charges_for_foreign_infant,
          activity_charges_for_adult: a.activity_charges_for_adult,
          activity_charges_for_children: a.activity_charges_for_children,
          activity_charges_for_infant: a.activity_charges_for_infant,
          activity_amout: a.activity_amout,
          activity_traveling_time: a.activity_traveling_time,
          activity_start_time: a.activity_start_time,
          activity_end_time: a.activity_end_time,
          createdby: userId,
          status: 1,
        },
      });
    }

    // 8. Guides
    const guides = await tx.dvi_itinerary_route_guide_details.findMany({
      where: { itinerary_plan_ID: draftPlanId, deleted: 0 },
    });
    for (const g of guides) {
      await tx.dvi_confirmed_itinerary_route_guide_details.create({
        data: {
          route_guide_ID: g.route_guide_ID,
          itinerary_plan_ID: draftPlanId,
          itinerary_route_ID: g.itinerary_route_ID,
          guide_id: g.guide_id,
          guide_type: g.guide_type,
          guide_language: g.guide_language,
          guide_slot: g.guide_slot,
          guide_cost: g.guide_cost,
          createdby: userId,
          status: 1,
        },
      });
    }

    // 9. Vendor Eligible List
    const vendorEligible = await tx.dvi_itinerary_plan_vendor_eligible_list.findMany({
      where: { itinerary_plan_id: draftPlanId, deleted: 0 },
    });
    for (const ve of vendorEligible) {
      await tx.dvi_confirmed_itinerary_plan_vendor_eligible_list.create({
        data: {
          itinerary_plan_vendor_eligible_ID: ve.itinerary_plan_vendor_eligible_ID,
          itineary_plan_assigned_status: ve.itineary_plan_assigned_status,
          itinerary_plan_id: draftPlanId,
          vehicle_type_id: ve.vehicle_type_id,
          total_vehicle_qty: ve.total_vehicle_qty,
          vendor_id: ve.vendor_id,
          outstation_allowed_km_per_day: ve.outstation_allowed_km_per_day,
          vendor_vehicle_type_id: ve.vendor_vehicle_type_id,
          vehicle_id: ve.vehicle_id,
          vendor_branch_id: ve.vendor_branch_id,
          vehicle_orign: ve.vehicle_orign,
          vehicle_count: ve.vehicle_count,
          total_kms: ve.total_kms,
          total_outstation_km: ve.total_outstation_km,
          total_time: ve.total_time,
          total_rental_charges: ve.total_rental_charges,
          total_toll_charges: ve.total_toll_charges,
          total_parking_charges: ve.total_parking_charges,
          total_driver_charges: ve.total_driver_charges,
          total_permit_charges: ve.total_permit_charges,
          total_before_6_am_extra_time: ve.total_before_6_am_extra_time,
          total_after_8_pm_extra_time: ve.total_after_8_pm_extra_time,
          total_before_6_am_charges_for_driver: ve.total_before_6_am_charges_for_driver,
          total_before_6_am_charges_for_vehicle: ve.total_before_6_am_charges_for_vehicle,
          total_after_8_pm_charges_for_driver: ve.total_after_8_pm_charges_for_driver,
          total_after_8_pm_charges_for_vehicle: ve.total_after_8_pm_charges_for_vehicle,
          extra_km_rate: ve.extra_km_rate,
          total_allowed_kms: ve.total_allowed_kms,
          total_extra_kms: ve.total_extra_kms,
          total_extra_kms_charge: ve.total_extra_kms_charge,
          total_allowed_local_kms: ve.total_allowed_local_kms,
          total_extra_local_kms: ve.total_extra_local_kms,
          total_extra_local_kms_charge: ve.total_extra_local_kms_charge,
          vehicle_gst_type: ve.vehicle_gst_type,
          vehicle_gst_percentage: ve.vehicle_gst_percentage,
          vehicle_gst_amount: ve.vehicle_gst_amount,
          vehicle_total_amount: ve.vehicle_total_amount,
          vendor_margin_percentage: ve.vendor_margin_percentage,
          vendor_margin_gst_type: ve.vendor_margin_gst_type,
          vendor_margin_gst_percentage: ve.vendor_margin_gst_percentage,
          vendor_margin_amount: ve.vendor_margin_amount,
          vendor_margin_gst_amount: ve.vendor_margin_gst_amount,
          vehicle_grand_total: ve.vehicle_grand_total,
          createdby: userId,
          status: 1,
        },
      });
    }

    // 10. Vendor Vehicle Details
    const vendorVehicleDetails = await tx.dvi_itinerary_plan_vendor_vehicle_details.findMany({
      where: { itinerary_plan_id: draftPlanId, deleted: 0 },
    });
    for (const vvd of vendorVehicleDetails) {
      await tx.dvi_confirmed_itinerary_plan_vendor_vehicle_details.create({
        data: {
          itinerary_plan_vendor_vehicle_details_ID: vvd.itinerary_plan_vendor_vehicle_details_ID,
          itinerary_plan_vendor_eligible_ID: vvd.itinerary_plan_vendor_eligible_ID,
          itinerary_plan_id: draftPlanId,
          itinerary_route_id: vvd.itinerary_route_id,
          itinerary_route_date: vvd.itinerary_route_date,
          vehicle_type_id: vvd.vehicle_type_id,
          vehicle_qty: vvd.vehicle_qty,
          vendor_id: vvd.vendor_id,
          vendor_vehicle_type_id: vvd.vendor_vehicle_type_id,
          vehicle_id: vvd.vehicle_id,
          vendor_branch_id: vvd.vendor_branch_id,
          time_limit_id: vvd.time_limit_id,
          travel_type: vvd.travel_type,
          itinerary_route_location_from: vvd.itinerary_route_location_from,
          itinerary_route_location_to: vvd.itinerary_route_location_to,
          total_running_km: vvd.total_running_km,
          total_running_time: vvd.total_running_time,
          total_siteseeing_km: vvd.total_siteseeing_km,
          total_siteseeing_time: vvd.total_siteseeing_time,
          total_pickup_km: vvd.total_pickup_km,
          total_pickup_duration: vvd.total_pickup_duration,
          total_drop_km: vvd.total_drop_km,
          total_drop_duration: vvd.total_drop_duration,
          total_extra_km: vvd.total_extra_km,
          extra_km_rate: vvd.extra_km_rate,
          total_extra_km_charges: vvd.total_extra_km_charges,
          total_travelled_km: vvd.total_travelled_km,
          total_travelled_time: vvd.total_travelled_time,
          vehicle_rental_charges: vvd.vehicle_rental_charges,
          vehicle_toll_charges: vvd.vehicle_toll_charges,
          vehicle_parking_charges: vvd.vehicle_parking_charges,
          vehicle_driver_charges: vvd.vehicle_driver_charges,
          vehicle_permit_charges: vvd.vehicle_permit_charges,
          before_6_am_extra_time: vvd.before_6_am_extra_time,
          after_8_pm_extra_time: vvd.after_8_pm_extra_time,
          before_6_am_charges_for_driver: vvd.before_6_am_charges_for_driver,
          before_6_am_charges_for_vehicle: vvd.before_6_am_charges_for_vehicle,
          after_8_pm_charges_for_driver: vvd.after_8_pm_charges_for_driver,
          after_8_pm_charges_for_vehicle: vvd.after_8_pm_charges_for_vehicle,
          total_vehicle_amount: vvd.total_vehicle_amount,
          createdby: userId,
          status: 1,
        },
      });
    }

    // 11. Route Permit Charges
    const permitCharges = await tx.dvi_itinerary_plan_route_permit_charge.findMany({
      where: { itinerary_plan_ID: draftPlanId, deleted: 0 },
    });
    for (const pc of permitCharges) {
      await tx.dvi_confirmed_itinerary_plan_route_permit_charge.create({
        data: {
          // cnf_itinerary_route_permit_charge_ID is auto-increment, don't set it manually
          route_permit_charge_ID: pc.route_permit_charge_ID,
          itinerary_plan_ID: draftPlanId,
          itinerary_route_ID: pc.itinerary_route_ID,
          itinerary_route_date: pc.itinerary_route_date,
          vendor_id: pc.vendor_id,
          vendor_branch_id: pc.vendor_branch_id,
          vendor_vehicle_type_id: pc.vendor_vehicle_type_id,
          source_state_id: pc.source_state_id,
          destination_state_id: pc.destination_state_id,
          permit_cost: pc.permit_cost,
          createdby: userId,
          status: 1,
        },
      });
    }
  }

  async cancelItinerary(dto: CancelItineraryDto) {
    const userId = 1; // TODO: Get from authenticated user

    // Validation
    if (!dto.itinerary_plan_ID) {
      throw new BadRequestException('Itinerary Plan ID is required');
    }

    if (!dto.reason) {
      throw new BadRequestException('Cancellation reason is required');
    }

    // Check if itinerary exists
    const confirmedPlan = await this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
      where: { itinerary_plan_ID: dto.itinerary_plan_ID, deleted: 0 },
    });

    if (!confirmedPlan) {
      throw new NotFoundException(`Confirmed itinerary not found for Plan ID: ${dto.itinerary_plan_ID}`);
    }

    // Check if already cancelled
    const existingCancellation = await this.prisma.dvi_cancelled_itineraries.findFirst({
      where: { 
        itinerary_plan_id: dto.itinerary_plan_ID,
        deleted: 0,
      },
    });

    if (existingCancellation) {
      throw new ConflictException(`Itinerary already cancelled. Cancellation ID: ${existingCancellation.cancelled_itinerary_ID}`);
    }

    // Determine cancellation options (backward compatibility)
    const cancellationOptions = dto.cancellation_options || {
      modify_hotspot: dto.cancel_hotspot ?? true,
      modify_hotel: dto.cancel_hotel ?? true,
      modify_vehicle: dto.cancel_vehicle ?? true,
      modify_guide: dto.cancel_guide ?? true,
      modify_activity: dto.cancel_activity ?? true,
    };

    // Calculate amounts
    const totalAmount = confirmedPlan.itinerary_total_net_payable_amount || 0;
    const percentage = Number(dto.cancellation_percentage) || 10;
    const cancellationCharge = Math.round((totalAmount * percentage) / 100);
    const refundAmount = Math.max(0, totalAmount - cancellationCharge);

    // Generate cancellation reference
    const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const cancellationReference = `CANCEL_${timestamp}_${dto.itinerary_plan_ID}`;

    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1. Create cancellation record with selective options
        const cancellation = await tx.dvi_cancelled_itineraries.create({
          data: {
            itinerary_plan_id: Number(dto.itinerary_plan_ID),
            cancellation_reason: dto.reason,
            cancellation_reference: cancellationReference,
            modify_hotspot: cancellationOptions.modify_hotspot ? 1 : 0,
            modify_hotel: cancellationOptions.modify_hotel ? 1 : 0,
            modify_vehicle: cancellationOptions.modify_vehicle ? 1 : 0,
            modify_guide: cancellationOptions.modify_guide ? 1 : 0,
            modify_activity: cancellationOptions.modify_activity ? 1 : 0,
            cancelled_by: userId,
            cancelled_on: new Date(),
            cancellation_status: 'pending',
            total_cancelled_service_amount: totalAmount,
            total_cancellation_charge: cancellationCharge,
            total_refund_amount: Math.round(refundAmount),
            itinerary_cancellation_status: 1,
            createdby: userId,
            createdon: new Date(),
            status: 1,
            deleted: 0,
          },
        });

        const cancellationDetails = {
          hotspots_cancelled: 0,
          hotels_cancelled: 0,
          vehicles_cancelled: 0,
          guides_cancelled: 0,
          activities_cancelled: 0,
        };

        // 2. Process selective cancellations
        // Cancel hotspots
        if (cancellationOptions.modify_hotspot) {
          const hotspotCount = await this.cancelHotspots(tx, dto.itinerary_plan_ID, cancellation.cancelled_itinerary_ID, userId);
          cancellationDetails.hotspots_cancelled = hotspotCount;
        }

        // Cancel hotels
        if (cancellationOptions.modify_hotel) {
          const hotelCount = await this.cancelHotels(tx, dto.itinerary_plan_ID, cancellation.cancelled_itinerary_ID, userId);
          cancellationDetails.hotels_cancelled = hotelCount;
        }

        // Cancel vehicles
        if (cancellationOptions.modify_vehicle) {
          const vehicleCount = await this.cancelVehicles(tx, dto.itinerary_plan_ID, cancellation.cancelled_itinerary_ID, userId);
          cancellationDetails.vehicles_cancelled = vehicleCount;
        }

        // Cancel guides
        if (cancellationOptions.modify_guide) {
          const guideCount = await this.cancelGuides(tx, dto.itinerary_plan_ID, cancellation.cancelled_itinerary_ID, userId);
          cancellationDetails.guides_cancelled = guideCount;
        }

        // Cancel activities
        if (cancellationOptions.modify_activity) {
          const activityCount = await this.cancelActivities(tx, dto.itinerary_plan_ID, cancellation.cancelled_itinerary_ID, userId);
          cancellationDetails.activities_cancelled = activityCount;
        }

        // 3. Refund to wallet
        if (refundAmount > 0) {
          await tx.dvi_cash_wallet.create({
            data: {
              agent_id: confirmedPlan.agent_id,
              transaction_date: new Date(),
              transaction_amount: Math.round(refundAmount),
              transaction_type: 1, // Credit
              remarks: `Refund for Cancelled Itinerary: ${confirmedPlan.itinerary_quote_ID} - ${cancellationReference}`,
              transaction_id: confirmedPlan.itinerary_quote_ID,
              createdby: userId,
              createdon: new Date(),
              status: 1,
              deleted: 0,
            },
          });

          // Log refund processing
          await this.logCancellationAction(
            tx,
            cancellation.cancelled_itinerary_ID,
            dto.itinerary_plan_ID,
            'refund_processed',
            `Refund amount: ${refundAmount}`,
            userId,
          );
        }

        // 4. Update plan statuses
        const isFullCancellation = 
          cancellationOptions.modify_hotspot &&
          cancellationOptions.modify_hotel &&
          cancellationOptions.modify_vehicle;

        if (isFullCancellation) {
          // Full cancellation - update status to cancelled
          await tx.dvi_itinerary_plan_details.update({
            where: { itinerary_plan_ID: dto.itinerary_plan_ID },
            data: {
              quotation_status: 2, // Cancelled
              updatedon: new Date(),
            },
          });

          await tx.dvi_confirmed_itinerary_plan_details.update({
            where: { confirmed_itinerary_plan_ID: confirmedPlan.confirmed_itinerary_plan_ID },
            data: {
              itinerary_cancellation_status: 1,
              updatedon: new Date(),
            },
          });
        } else {
          // Partial cancellation - mark as partially cancelled
          await tx.dvi_confirmed_itinerary_plan_details.update({
            where: { confirmed_itinerary_plan_ID: confirmedPlan.confirmed_itinerary_plan_ID },
            data: {
              itinerary_cancellation_status: 2, // Partially cancelled
              updatedon: new Date(),
            },
          });
        }

        // 5. Update cancellation status to completed
        await tx.dvi_cancelled_itineraries.update({
          where: { cancelled_itinerary_ID: cancellation.cancelled_itinerary_ID },
          data: {
            cancellation_status: 'completed',
            updatedon: new Date(),
          },
        });

        // 6. Log completion
        await this.logCancellationAction(
          tx,
          cancellation.cancelled_itinerary_ID,
          dto.itinerary_plan_ID,
          'cancellation_completed',
          `Full: ${isFullCancellation}, Details: ${JSON.stringify(cancellationDetails)}`,
          userId,
        );

        // 7. Send notifications (async, don't wait)
        this.sendCancellationNotifications(
          confirmedPlan,
          cancellationReference,
          dto.reason,
          refundAmount,
          cancellationOptions,
        ).catch(err => {
          console.error('Error sending cancellation notifications:', err);
        });

        return {
          success: true,
          message: isFullCancellation 
            ? 'Itinerary cancelled successfully' 
            : 'Selected itinerary components cancelled successfully',
          data: {
            cancellation_id: cancellation.cancelled_itinerary_ID,
            itinerary_id: dto.itinerary_plan_ID,
            cancellation_reference: cancellationReference,
            status: 'completed',
            refund_amount: Math.round(refundAmount),
            cancellation_details: cancellationDetails,
            cancelled_on: cancellation.cancelled_on,
          },
        };
      }, {
        maxWait: 15000,
        timeout: 120000,
      });
    } catch (error) {
      if (error instanceof BadRequestException || 
          error instanceof NotFoundException || 
          error instanceof ConflictException) {
        throw error;
      }
      console.error('Cancellation processing error:', error);
      throw new Error(`Cancellation processing failed: ${error.message}`);
    }
  }

  // Helper methods for selective cancellation
  private async cancelHotspots(tx: any, itineraryPlanId: number, cancellationId: number, userId: number): Promise<number> {
    try {
      const hotspots = await tx.dvi_itinerary_route_hotspot_details.findMany({
        where: { 
          itinerary_plan_ID: itineraryPlanId,
          deleted: 0,
        },
      });

      if (hotspots.length > 0) {
        await tx.dvi_itinerary_route_hotspot_details.updateMany({
          where: { 
            itinerary_plan_ID: itineraryPlanId,
            deleted: 0,
          },
          data: {
            status: 0, // Cancelled
            updatedon: new Date(),
          },
        });

        await this.logCancellationAction(
          tx,
          cancellationId,
          itineraryPlanId,
          'hotspot_cancelled',
          `${hotspots.length} hotspot(s) cancelled`,
          userId,
        );
      }

      return hotspots.length;
    } catch (error) {
      await this.logCancellationAction(
        tx,
        cancellationId,
        itineraryPlanId,
        'hotspot_cancelled',
        `Error: ${error.message}`,
        userId,
        'error',
        error.message,
      );
      throw error;
    }
  }

  private async cancelHotels(tx: any, itineraryPlanId: number, cancellationId: number, userId: number): Promise<number> {
    try {
      const hotels = await tx.dvi_itinerary_plan_hotel_details.findMany({
        where: { 
          itinerary_plan_id: itineraryPlanId,
          deleted: 0,
        },
      });

      if (hotels.length > 0) {
        // Cancel TBO bookings via API BEFORE updating database
        try {
          const tboCancellationResults = await this.tboHotelBooking.cancelItineraryHotels(
            itineraryPlanId,
            'Itinerary cancelled by user',
          );

          console.log(`[TBO Cancellation] Results:`, tboCancellationResults);
        } catch (error) {
          console.error(`[TBO Cancellation] Failed but continuing with DB updates:`, error.message);
          // Continue with database updates even if TBO cancellation fails
        }

        // Cancel ResAvenue bookings via API
        try {
          const resavenueCancellationResults = await this.resavenueHotelBooking.cancelItineraryHotels(
            itineraryPlanId,
            'Itinerary cancelled by user',
          );

          console.log(`[ResAvenue Cancellation] Results:`, resavenueCancellationResults);
        } catch (error) {
          console.error(`[ResAvenue Cancellation] Failed but continuing with DB updates:`, error.message);
          // Continue with database updates even if ResAvenue cancellation fails
        }

        // Cancel HOBSE bookings via API
        try {
          await this.hobseHotelBooking.cancelItineraryHotels(itineraryPlanId);
          console.log(`[HOBSE Cancellation] Successfully processed`);
        } catch (error) {
          console.error(`[HOBSE Cancellation] Failed but continuing with DB updates:`, error.message);
          // Continue with database updates even if HOBSE cancellation fails
        }

        // Mark hotels as cancelled
        await tx.dvi_itinerary_plan_hotel_details.updateMany({
          where: { 
            itinerary_plan_id: itineraryPlanId,
            deleted: 0,
          },
          data: {
            hotel_cancellation_status: 1,
            updatedon: new Date(),
          },
        });

        // Copy to cancelled hotel details table if exists
        for (const hotel of hotels) {
          try {
            await tx.dvi_cancelled_itinerary_plan_hotel_details.create({
              data: {
                cancelled_itinerary_ID: cancellationId,
                itinerary_plan_hotel_details_ID: hotel.itinerary_plan_hotel_details_ID,
                itinerary_plan_id: itineraryPlanId,
                hotel_id: hotel.hotel_id || 0,
                itinerary_route_date: hotel.itinerary_route_date,
                createdby: userId,
                createdon: new Date(),
                status: 1,
                deleted: 0,
              },
            });
          } catch (err) {
            console.error('Error creating cancelled hotel record:', err);
          }
        }

        await this.logCancellationAction(
          tx,
          cancellationId,
          itineraryPlanId,
          'hotel_cancelled',
          `${hotels.length} hotel(s) cancelled`,
          userId,
        );
      }

      return hotels.length;
    } catch (error) {
      await this.logCancellationAction(
        tx,
        cancellationId,
        itineraryPlanId,
        'hotel_cancelled',
        `Error: ${error.message}`,
        userId,
        'error',
        error.message,
      );
      throw error;
    }
  }

  private async cancelVehicles(tx: any, itineraryPlanId: number, cancellationId: number, userId: number): Promise<number> {
    try {
      const vehicles = await tx.dvi_itinerary_plan_vehicle_details.findMany({
        where: { 
          itinerary_plan_id: itineraryPlanId,
          deleted: 0,
        },
      });

      if (vehicles.length > 0) {
        await tx.dvi_itinerary_plan_vehicle_details.updateMany({
          where: { 
            itinerary_plan_id: itineraryPlanId,
            deleted: 0,
          },
          data: {
            status: 0, // Cancelled
            updatedon: new Date(),
          },
        });

        await this.logCancellationAction(
          tx,
          cancellationId,
          itineraryPlanId,
          'vehicle_cancelled',
          `${vehicles.length} vehicle(s) cancelled`,
          userId,
        );
      }

      return vehicles.length;
    } catch (error) {
      await this.logCancellationAction(
        tx,
        cancellationId,
        itineraryPlanId,
        'vehicle_cancelled',
        `Error: ${error.message}`,
        userId,
        'error',
        error.message,
      );
      throw error;
    }
  }

  private async cancelGuides(tx: any, itineraryPlanId: number, cancellationId: number, userId: number): Promise<number> {
    try {
      const guides = await tx.dvi_itinerary_route_guide_details.findMany({
        where: { 
          itinerary_plan_ID: itineraryPlanId,
          deleted: 0,
        },
      });

      if (guides.length > 0) {
        await tx.dvi_itinerary_route_guide_details.updateMany({
          where: { 
            itinerary_plan_ID: itineraryPlanId,
            deleted: 0,
          },
          data: {
            status: 0, // Cancelled
            updatedon: new Date(),
          },
        });

        await this.logCancellationAction(
          tx,
          cancellationId,
          itineraryPlanId,
          'guide_cancelled',
          `${guides.length} guide(s) cancelled`,
          userId,
        );
      }

      return guides.length;
    } catch (error) {
      await this.logCancellationAction(
        tx,
        cancellationId,
        itineraryPlanId,
        'guide_cancelled',
        `Error: ${error.message}`,
        userId,
        'error',
        error.message,
      );
      throw error;
    }
  }

  private async cancelActivities(tx: any, itineraryPlanId: number, cancellationId: number, userId: number): Promise<number> {
    try {
      const activities = await tx.dvi_itinerary_route_activity_details.findMany({
        where: { 
          itinerary_plan_ID: itineraryPlanId,
          deleted: 0,
        },
      });

      if (activities.length > 0) {
        await tx.dvi_itinerary_route_activity_details.updateMany({
          where: { 
            itinerary_plan_ID: itineraryPlanId,
            deleted: 0,
          },
          data: {
            status: 0, // Cancelled
            updatedon: new Date(),
          },
        });

        await this.logCancellationAction(
          tx,
          cancellationId,
          itineraryPlanId,
          'activity_cancelled',
          `${activities.length} activit(y/ies) cancelled`,
          userId,
        );
      }

      return activities.length;
    } catch (error) {
      await this.logCancellationAction(
        tx,
        cancellationId,
        itineraryPlanId,
        'activity_cancelled',
        `Error: ${error.message}`,
        userId,
        'error',
        error.message,
      );
      throw error;
    }
  }

  private async logCancellationAction(
    tx: any,
    cancellationId: number,
    itineraryPlanId: number,
    actionType: string,
    actionDetails: string,
    userId: number,
    status: string = 'success',
    errorMessage?: string,
  ): Promise<void> {
    await tx.dvi_cancellation_logs.create({
      data: {
        cancellation_id: cancellationId,
        itinerary_plan_id: itineraryPlanId,
        action_type: actionType,
        action_details: actionDetails,
        status,
        error_message: errorMessage || null,
        created_by: userId,
        created_on: new Date(),
      },
    });
  }

  private async sendCancellationNotifications(
    confirmedPlan: any,
    cancellationReference: string,
    reason: string,
    refundAmount: number,
    cancellationOptions: any,
  ): Promise<void> {
    // TODO: Implement notification logic
    // This could send emails, SMS, push notifications, etc.
    console.log('Sending cancellation notifications:', {
      itineraryId: confirmedPlan.itinerary_plan_ID,
      agentId: confirmedPlan.agent_id,
      cancellationReference,
      reason,
      refundAmount,
      cancellationOptions,
    });
    
    // Example: Send email notification
    // await this.emailService.sendCancellationEmail({
    //   to: confirmedPlan.customer_email,
    //   subject: `Itinerary Cancellation - ${cancellationReference}`,
    //   body: `Your itinerary has been cancelled. Refund amount: ${refundAmount}`,
    // });
  }

  async getAgentsForFilter(req: any) {
    const u: any = (req as any).user ?? {};
    const staffId = Number(u.staffId ?? 0);
    const agentId = Number(u.agentId ?? 0);

    const where: any = { deleted: 0 };

    if (agentId > 0) {
      where.agent_ID = agentId;
    } else if (staffId > 0) {
      where.travel_expert_id = staffId;
    }

    const agents = await this.prisma.dvi_agent.findMany({
      where,
      select: {
        agent_ID: true,
        agent_name: true,
        agent_lastname: true,
      },
      orderBy: {
        agent_name: 'asc',
      },
    });

    return agents.map((a) => ({
      id: a.agent_ID,
      name: a.agent_name || '',
      staff_name: a.agent_lastname || '',
    }));
  }

  async getLocationsForFilter() {
    // Get unique arrival and departure locations from confirmed itineraries
    const plans = await this.prisma.dvi_itinerary_plan_details.findMany({
      where: {
        quotation_status: 1,
        deleted: 0,
      },
      select: {
        arrival_location: true,
        departure_location: true,
      },
    });

    const locationsSet = new Set<string>();
    
    plans.forEach((plan) => {
      if (plan.arrival_location) locationsSet.add(plan.arrival_location);
      if (plan.departure_location) locationsSet.add(plan.departure_location);
    });

    return Array.from(locationsSet)
      .filter(loc => loc && loc.trim().length > 0)
      .sort()
      .map(loc => ({ value: loc, label: loc }));
  }

  /**
   * Get unique locations for latest itineraries filter (from all non-deleted plans)
   */
  async getLocationsForLatestFilter(): Promise<{ value: string; label: string }[]> {
    const plans = await this.prisma.dvi_itinerary_plan_details.findMany({
      where: {
        deleted: 0,
      },
      select: {
        arrival_location: true,
        departure_location: true,
      },
    });

    const locationsSet = new Set<string>();
    
    plans.forEach((plan) => {
      if (plan.arrival_location) locationsSet.add(plan.arrival_location);
      if (plan.departure_location) locationsSet.add(plan.departure_location);
    });

    return Array.from(locationsSet)
      .filter(loc => loc && loc.trim().length > 0)
      .sort()
      .map(loc => ({ value: loc, label: loc }));
  }

  async getConfirmedItineraries(query: LatestItineraryQueryDto, req: any) {
    const {
      start = 0,
      length = 10,
      start_date,
      end_date,
      source_location,
      destination_location,
      agent_id,
      staff_id,
    } = query;

    const u: any = (req as any).user ?? {};
    const logged_user_level = Number(u.roleID ?? u.roleId ?? u.role ?? 0) || 0;
    const input_staff_id = Number(u.staff_id ?? u.staffId ?? 0) || 0;
    const input_agent_id = Number(u.agent_id ?? u.agentId ?? 0) || 0;
    const input_guide_id = Number(u.guide_id ?? u.guideId ?? 0) || 0;

    const where: any = {
      quotation_status: 1,
      deleted: 0,
    };

    if (input_agent_id > 0) {
      where.agent_id = input_agent_id;
    } else if (input_guide_id > 0) {
      // Guide logic: find itineraries where this guide is assigned
      const guideAssignments = await this.prisma.dvi_confirmed_itinerary_route_guide_details.findMany({
        where: { guide_id: input_guide_id, deleted: 0 },
        select: { itinerary_plan_ID: true },
      });
      const assignedPlanIds = [...new Set(guideAssignments.map(a => a.itinerary_plan_ID))];
      where.itinerary_plan_ID = { in: assignedPlanIds };
    } else if (input_staff_id > 0 && logged_user_level !== 6) {
      // Travel Expert logic
      const teAgents = await this.prisma.dvi_agent.findMany({
        where: { travel_expert_id: input_staff_id } as any,
        select: { agent_ID: true },
      });
      const teAgentIds = teAgents.map((a) => Number(a.agent_ID)).filter((n) => n > 0);
      where.OR = [
        { staff_id: input_staff_id },
        ...(teAgentIds.length ? [{ agent_id: { in: teAgentIds } }] : []),
      ];
    } else {
      if (agent_id) where.agent_id = agent_id;
      if (staff_id) where.staff_id = staff_id;
    }

    if (start_date && end_date) {
      where.trip_start_date_and_time = {
        gte: new Date(start_date),
        lte: new Date(end_date),
      };
    }

    if (source_location) {
      where.arrival_location = { contains: source_location };
    }

    if (destination_location) {
      where.departure_location = { contains: destination_location };
    }

    const [total, filtered, data] = await Promise.all([
      this.prisma.dvi_itinerary_plan_details.count({
        where: { quotation_status: 1, deleted: 0 },
      }),
      this.prisma.dvi_itinerary_plan_details.count({ where }),
      this.prisma.dvi_itinerary_plan_details.findMany({
        where,
        skip: Number(start),
        take: Number(length),
        orderBy: { createdon: 'desc' },
      }),
    ]);

    // Fetch agents manually since no relations in Prisma schema
    const agentIds = [...new Set(data.map((p) => p.agent_id))];
    const agents = await this.prisma.dvi_agent.findMany({
      where: { agent_ID: { in: agentIds } },
      select: { agent_ID: true, agent_name: true },
    });
    const agentMap = new Map(agents.map((a) => [a.agent_ID, a.agent_name]));

    return {
      draw: query.draw || 1,
      recordsTotal: total,
      recordsFiltered: filtered,
      data: data.map((p) => ({
        itinerary_plan_ID: p.itinerary_plan_ID,
        booking_quote_id: p.itinerary_quote_ID,
        agent_name: agentMap.get(p.agent_id) || 'N/A',
        primary_customer_name: 'N/A', // Customer info not in this table
        primary_contact_no: 'N/A',
        arrival_location: p.arrival_location,
        departure_location: p.departure_location,
        arrival_date: p.trip_start_date_and_time,
        departure_date: p.trip_end_date_and_time,
        nights: p.no_of_nights,
        days: p.no_of_days,
        created_on: p.createdon,
        created_by: p.createdby,
      })),
    };
  }

  async getCancelledItineraries(query: LatestItineraryQueryDto, req: any) {
    const {
      start = 0,
      length = 10,
      start_date,
      end_date,
      agent_id,
    } = query;

    const u: any = (req as any).user ?? {};
    const logged_user_level = Number(u.roleID ?? u.roleId ?? u.role ?? 0) || 0;
    const input_staff_id = Number(u.staff_id ?? u.staffId ?? 0) || 0;
    const input_agent_id = Number(u.agent_id ?? u.agentId ?? 0) || 0;

    const where: any = {
      deleted: 0,
    };

    if (start_date && end_date) {
      where.createdon = {
        gte: new Date(start_date),
        lte: new Date(end_date),
      };
    }

    if (input_agent_id > 0) {
      const agentPlans = await this.prisma.dvi_itinerary_plan_details.findMany({
        where: { agent_id: input_agent_id },
        select: { itinerary_plan_ID: true },
      });
      where.itinerary_plan_id = { in: agentPlans.map((p) => p.itinerary_plan_ID) };
    } else if (input_staff_id > 0 && logged_user_level !== 6) {
      const teAgents = await this.prisma.dvi_agent.findMany({
        where: { travel_expert_id: input_staff_id } as any,
        select: { agent_ID: true },
      });
      const teAgentIds = teAgents.map((a) => Number(a.agent_ID)).filter((n) => n > 0);
      
      const tePlans = await this.prisma.dvi_itinerary_plan_details.findMany({
        where: {
          OR: [
            { staff_id: input_staff_id },
            ...(teAgentIds.length ? [{ agent_id: { in: teAgentIds } }] : []),
          ],
        },
        select: { itinerary_plan_ID: true },
      });
      where.itinerary_plan_id = { in: tePlans.map((p) => p.itinerary_plan_ID) };
    } else if (agent_id) {
      const agentPlans = await this.prisma.dvi_itinerary_plan_details.findMany({
        where: { agent_id: agent_id },
        select: { itinerary_plan_ID: true },
      });
      where.itinerary_plan_id = { in: agentPlans.map((p) => p.itinerary_plan_ID) };
    }

    const [total, filtered, data] = await Promise.all([
      this.prisma.dvi_cancelled_itineraries.count({
        where: { deleted: 0 },
      }),
      this.prisma.dvi_cancelled_itineraries.count({ where }),
      this.prisma.dvi_cancelled_itineraries.findMany({
        where,
        skip: Number(start),
        take: Number(length),
        orderBy: { createdon: 'desc' },
      }),
    ]);

    // Fetch plan details and agents manually
    const planIds = data.map((p) => p.itinerary_plan_id);
    const plans = await this.prisma.dvi_itinerary_plan_details.findMany({
      where: { itinerary_plan_ID: { in: planIds } },
      select: { itinerary_plan_ID: true, itinerary_quote_ID: true, agent_id: true },
    });
    const planMap = new Map(plans.map((p) => [p.itinerary_plan_ID, p]));

    const agentIds = [...new Set(plans.map((p) => p.agent_id))];
    const agents = await this.prisma.dvi_agent.findMany({
      where: { agent_ID: { in: agentIds } },
      select: { agent_ID: true, agent_name: true },
    });
    const agentMap = new Map(agents.map((a) => [a.agent_ID, a.agent_name]));

    return {
      draw: query.draw || 1,
      recordsTotal: total,
      recordsFiltered: filtered,
      data: data.map((p) => {
        const plan = planMap.get(p.itinerary_plan_id);
        return {
          cancelled_itinerary_ID: p.cancelled_itinerary_ID,
          itinerary_plan_ID: p.itinerary_plan_id,
          booking_quote_id: plan?.itinerary_quote_ID || 'N/A',
          agent_name: agentMap.get(plan?.agent_id || 0) || 'N/A',
          cancelled_date: p.createdon,
          cancelled_reason: 'N/A', // Reason not in this table
          refund_amount: p.total_refund_amount,
          refund_status: p.itinerary_cancellation_status,
        };
      }),
    };
  }

  async getAccountsItineraries(query: LatestItineraryQueryDto, req: any) {
    const {
      start = 0,
      length = 10,
      agent_id,
    } = query;

    const u: any = (req as any).user ?? {};
    const logged_user_level = Number(u.roleID ?? u.roleId ?? u.role ?? 0) || 0;
    const input_staff_id = Number(u.staff_id ?? u.staffId ?? 0) || 0;
    const input_agent_id = Number(u.agent_id ?? u.agentId ?? 0) || 0;

    const where: any = {
      deleted: 0,
    };

    if (input_agent_id > 0) {
      where.agent_id = input_agent_id;
    } else if (input_staff_id > 0 && logged_user_level !== 6) {
      const teAgents = await this.prisma.dvi_agent.findMany({
        where: { travel_expert_id: input_staff_id } as any,
        select: { agent_ID: true },
      });
      const teAgentIds = teAgents.map((a) => Number(a.agent_ID)).filter((n) => n > 0);
      where.OR = [
        { staff_id: input_staff_id },
        ...(teAgentIds.length ? [{ agent_id: { in: teAgentIds } }] : []),
      ];
    } else if (agent_id) {
      where.agent_id = agent_id;
    }

    const [total, filtered, data] = await Promise.all([
      this.prisma.dvi_accounts_itinerary_details.count({
        where: { deleted: 0 },
      }),
      this.prisma.dvi_accounts_itinerary_details.count({ where }),
      this.prisma.dvi_accounts_itinerary_details.findMany({
        where,
        skip: Number(start),
        take: Number(length),
        orderBy: { createdon: 'desc' },
      }),
    ]);

    // Fetch agents manually
    const agentIds = [...new Set(data.map((p) => p.agent_id))];
    const agents = await this.prisma.dvi_agent.findMany({
      where: { agent_ID: { in: agentIds } },
      select: { agent_ID: true, agent_name: true },
    });
    const agentMap = new Map(agents.map((a) => [a.agent_ID, a.agent_name]));

    return {
      draw: query.draw || 1,
      recordsTotal: total,
      recordsFiltered: filtered,
      data: data.map((p) => ({
        accounts_itinerary_details_ID: p.accounts_itinerary_details_ID,
        itinerary_plan_ID: p.itinerary_plan_ID,
        booking_quote_id: p.itinerary_quote_ID,
        agent_name: agentMap.get(p.agent_id) || 'N/A',
        trip_start_date: p.trip_start_date_and_time,
        trip_end_date: p.trip_end_date_and_time,
        total_billed_amount: p.total_billed_amount,
        total_received_amount: p.total_received_amount,
        total_receivable_amount: p.total_receivable_amount,
        total_payable_amount: p.total_payable_amount,
        total_payout_amount: p.total_payout_amount,
        created_on: p.createdon,
      })),
    };
  }

  async getVoucherDetails(itineraryPlanId: number) {
    const plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
      where: { itinerary_plan_ID: itineraryPlanId, deleted: 0 },
    });

    if (!plan) {
      throw new NotFoundException('Confirmed itinerary plan not found');
    }

    const customer = await this.prisma.dvi_confirmed_itinerary_customer_details.findFirst({
      where: { itinerary_plan_ID: itineraryPlanId, primary_customer: 1, deleted: 0 },
    });

    const vehicles = await this.prisma.dvi_confirmed_itinerary_plan_vendor_eligible_list.findMany({
      where: { itinerary_plan_id: itineraryPlanId, deleted: 0, status: 1, itineary_plan_assigned_status: 1 },
    });

    const hotels = await this.prisma.dvi_confirmed_itinerary_plan_hotel_details.findMany({
      where: { itinerary_plan_id: itineraryPlanId, deleted: 0, status: 1 },
      orderBy: { itinerary_route_date: 'asc' },
    });

    // Fetch additional details for vehicles
    const vehicleDetails = await Promise.all(vehicles.map(async (v) => {
      const vendor = await this.prisma.dvi_vendor_details.findUnique({
        where: { vendor_id: v.vendor_id },
        select: { vendor_name: true },
      });
      const vehicleType = await this.prisma.dvi_vehicle_type.findUnique({
        where: { vehicle_type_id: v.vehicle_type_id },
        select: { vehicle_type_title: true },
      });
      const branch = await this.prisma.dvi_vendor_branches.findUnique({
        where: { vendor_branch_id: v.vendor_branch_id },
        select: { vendor_branch_name: true },
      });

      return {
        ...v,
        vendor_name: vendor?.vendor_name || 'N/A',
        vehicle_type_title: vehicleType?.vehicle_type_title || 'N/A',
        branch_label: branch?.vendor_branch_name || 'N/A',
      };
    }));

    // Fetch additional details for hotels
    const hotelDetails = await Promise.all(hotels.map(async (h) => {
      const hotel = await this.prisma.dvi_hotel.findUnique({
        where: { hotel_id: h.hotel_id },
        select: { hotel_name: true },
      });
      
      const rooms = await this.prisma.dvi_confirmed_itinerary_plan_hotel_room_details.findMany({
        where: { confirmed_itinerary_plan_hotel_details_id: h.confirmed_itinerary_plan_hotel_details_ID, deleted: 0 },
      });

      const roomDetails = await Promise.all(rooms.map(async (r) => {
        const roomType = await this.prisma.dvi_hotel_roomtype.findUnique({
          where: { room_type_id: r.room_type_id },
          select: { room_type_title: true },
        });
        return {
          ...r,
          room_type_title: roomType?.room_type_title || 'N/A',
        };
      }));

      return {
        ...h,
        hotel_name: hotel?.hotel_name || 'N/A',
        rooms: roomDetails,
      };
    }));

    return {
      plan,
      customer,
      vehicles: vehicleDetails,
      hotels: hotelDetails,
    };
  }

  async getPluckCardData(itineraryPlanId: number) {
    const plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
      where: { itinerary_plan_ID: itineraryPlanId, deleted: 0 },
    });

    if (!plan) {
      throw new NotFoundException('Confirmed itinerary plan not found');
    }

    const customer = await this.prisma.dvi_confirmed_itinerary_customer_details.findFirst({
      where: { itinerary_plan_ID: itineraryPlanId, primary_customer: 1, deleted: 0 },
    });

    return {
      guestName: customer ? `${customer.customer_salutation || ''} ${customer.customer_name}`.trim() : 'N/A',
      contactNo: customer?.primary_contact_no || 'N/A',
      arrivalLocation: plan.arrival_location,
      arrivalDateTime: plan.trip_start_date_and_time,
      departureLocation: plan.departure_location,
      departureDateTime: plan.trip_end_date_and_time,
      flightDetails: plan.special_instructions,
    };
  }

  async getPluckCardDataByConfirmedId(confirmedPlanId: number) {
    const plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findUnique({
      where: { confirmed_itinerary_plan_ID: confirmedPlanId },
    });

    if (!plan) {
      throw new NotFoundException('Confirmed itinerary plan not found');
    }

    const customer = await this.prisma.dvi_confirmed_itinerary_customer_details.findFirst({
      where: { confirmed_itinerary_plan_ID: confirmedPlanId, primary_customer: 1, deleted: 0 },
    });

    return {
      guestName: customer ? `${customer.customer_salutation || ''} ${customer.customer_name}`.trim() : 'N/A',
      contactNo: customer?.primary_contact_no || 'N/A',
      arrivalLocation: plan.arrival_location,
      arrivalDateTime: plan.trip_start_date_and_time,
      departureLocation: plan.departure_location,
      departureDateTime: plan.trip_end_date_and_time,
      flightDetails: plan.special_instructions,
    };
  }

  async getInvoiceData(itineraryPlanId: number) {
    const plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
      where: { itinerary_plan_ID: itineraryPlanId, deleted: 0 },
    });

    if (!plan) {
      throw new NotFoundException('Confirmed itinerary plan not found');
    }

    const agent = await this.prisma.dvi_agent.findUnique({
      where: { agent_ID: plan.agent_id },
    });

    const customer = await this.prisma.dvi_confirmed_itinerary_customer_details.findFirst({
      where: { itinerary_plan_ID: itineraryPlanId, primary_customer: 1, deleted: 0 },
    });

    const settings = await this.prisma.dvi_global_settings.findFirst({
      where: { status: 1, deleted: 0 },
    });

    const accounts = await this.prisma.dvi_accounts_itinerary_details.findFirst({
      where: { itinerary_plan_ID: itineraryPlanId, deleted: 0 },
    });

    return {
      company: settings,
      agent,
      guest: customer,
      itinerary: plan,
      totalAmount: accounts?.total_billed_amount || 0,
    };
  }

  /**
   * Preview manual hotspot addition.
   */
  async previewManualHotspot(planId: number, routeId: number, hotspotId: number) {
    return this.prisma.$transaction(async (tx) => {
      // Use the timeline builder directly for preview
      const { TimelineBuilder } = await import("./engines/helpers/timeline.builder");
      const builder = new TimelineBuilder();
      const result = await builder.buildTimelineForPlan(tx, planId);

      // Filter for the specific route we are previewing
      const rows = (result.hotspotRows as HotspotDetailRow[]).filter(r => Number(r.itinerary_route_ID) === Number(routeId));
      
      // Fetch hotspot names for display
      const hotspotIds = rows.map(r => r.hotspot_ID).filter((id): id is number => !!id && id > 0);
      const hotspotMasters = await tx.dvi_hotspot_place.findMany({
        where: { hotspot_ID: { in: hotspotIds } }
      });
      const hotspotMap = new Map(hotspotMasters.map(h => [Number(h.hotspot_ID), h.hotspot_name]));

      // Map to frontend segment format
      return rows.map(r => {
        const startTime = this.itineraryDetails.formatTime(r.hotspot_start_time);
        const endTime = this.itineraryDetails.formatTime(r.hotspot_end_time);
        
        let text = '';
        switch(Number(r.item_type)) {
          case 1: text = 'Start / Refreshment'; break;
          case 2: text = 'Travel'; break;
          case 3: text = 'Travel'; break;
          case 4: text = hotspotMap.get(Number(r.hotspot_ID)) || 'Sightseeing'; break;
          case 5: text = 'Travel to Hotel'; break;
          case 6: text = 'Hotel Check-in'; break;
          case 7: text = 'Travel to Departure'; break;
          default: text = 'Activity';
        }

        return {
          type: r.item_type === 4 ? 'hotspot' : 'other',
          timeRange: startTime && endTime ? `${startTime} - ${endTime}` : (startTime || endTime || ''),
          text: text,
          isConflict: r.isConflict === true,
          conflictReason: r.conflictReason || null,
          locationId: r.hotspot_ID
        };
      });
    }, { timeout: 30000 });
  }

  /**
   * Add a manual hotspot to a route and rebuild the timeline.
   */
  async addManualHotspot(planId: number, routeId: number, hotspotId: number, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Insert the manual hotspot record
      // We only need a minimal record; the engine will fill in the rest during rebuild
      await (tx as any).dvi_itinerary_route_hotspot_details.create({
        data: {
          itinerary_plan_ID: Number(planId),
          itinerary_route_ID: Number(routeId),
          hotspot_ID: Number(hotspotId),
          hotspot_plan_own_way: 1,
          item_type: 4, // Hotspot visit
          createdby: Number(userId),
          status: 1,
          deleted: 0,
        },
      });

      // 2. Rebuild the timeline
      await this.hotspotEngine.rebuildRouteHotspots(tx, planId);

      return { success: true };
    }, { timeout: 30000 });
  }

  /**
   * Remove a manual hotspot and rebuild the timeline.
   */
  async removeManualHotspot(planId: number, hotspotId: number) {
    return this.prisma.$transaction(async (tx) => {
      await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
        where: {
          itinerary_plan_ID: Number(planId),
          hotspot_ID: Number(hotspotId),
          hotspot_plan_own_way: 1,
        },
        data: { deleted: 1 }
      });

      await this.hotspotEngine.rebuildRouteHotspots(tx, Number(planId));

      return { success: true };
    }, { timeout: 30000 });
  }

  /**
   * Rebuild a route: Clear excluded hotspots and rebuild fresh
   * This lets user get new auto-selected hotspots to replace deleted ones
   */
  async rebuildRoute(planId: number, routeId: number) {
    const userId = 1;

    return this.prisma.$transaction(async (tx) => {
      // Clear the excluded_hotspot_ids so all hotspots can be auto-selected again
      await (tx as any).dvi_itinerary_route_details.update({
        where: { itinerary_route_ID: routeId },
        data: {
          excluded_hotspot_ids: [],
          updatedon: new Date(),
        },
      });

      // Rebuild the timeline with fresh selection
      await this.hotspotEngine.rebuildRouteHotspots(tx, planId);

      return { 
        success: true,
        message: 'Route rebuilt with fresh hotspot selection',
      };
    }, { timeout: 60000 });
  }

  /**
   * Update route start and end times and rebuild the timeline.
   */
  async updateRouteTimes(planId: number, routeId: number, startTime: string, endTime: string) {
    console.log(`[updateRouteTimes] planId=${planId}, routeId=${routeId}, startTime=${startTime}, endTime=${endTime}`);
    
    return this.prisma.$transaction(async (tx) => {
      // 1. Verify the record exists and belongs to the plan
      const record = await (tx as any).dvi_itinerary_route_details.findFirst({
        where: { 
          itinerary_route_ID: routeId,
          itinerary_plan_ID: planId
        }
      });

      if (!record) {
        console.error(`[updateRouteTimes] Record NOT found for routeId=${routeId} and planId=${planId}`);
        // Check if it exists with a different planId for debugging
        const otherRecord = await (tx as any).dvi_itinerary_route_details.findUnique({
          where: { itinerary_route_ID: routeId }
        });
        if (otherRecord) {
          console.error(`[updateRouteTimes] Record exists but belongs to planId=${otherRecord.itinerary_plan_ID}`);
          throw new BadRequestException(`Route ${routeId} belongs to plan ${otherRecord.itinerary_plan_ID}, not ${planId}`);
        }
        throw new BadRequestException(`Route ${routeId} not found`);
      }

      console.log(`[updateRouteTimes] Found record. Updating...`);

      // 2. Update the route details
      await (tx as any).dvi_itinerary_route_details.update({
        where: { itinerary_route_ID: routeId },
        data: {
          route_start_time: TimeConverter.toDate(startTime),
          route_end_time: TimeConverter.toDate(endTime),
          updatedon: new Date(),
        },
      });

      // 3. Rebuild the timeline for the entire plan
      console.log(`[updateRouteTimes] Rebuilding timeline for planId=${planId}...`);
      await this.hotspotEngine.rebuildRouteHotspots(tx, planId);

      return { success: true };
    }, { timeout: 60000 });
  }

  /**
   * Get confirmed itinerary data with hotels for cancellation page
   */
  async getConfirmedItineraryForCancellation(confirmedPlanId: number) {
    const plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findUnique({
      where: { confirmed_itinerary_plan_ID: confirmedPlanId },
    });

    if (!plan) {
      throw new NotFoundException('Confirmed itinerary not found');
    }

    // Get routes with dates
    const routes = await this.prisma.dvi_confirmed_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: plan.itinerary_plan_ID, deleted: 0 },
      orderBy: { itinerary_route_date: 'asc' },
    });

    // Get hotels for each route
    const hotelsData = await Promise.all(routes.map(async (route) => {
      const hotels = await this.prisma.dvi_confirmed_itinerary_plan_hotel_details.findMany({
        where: {
          itinerary_plan_id: plan.itinerary_plan_ID,
          itinerary_route_id: route.itinerary_route_ID,
          deleted: 0,
        },
      });

      const enrichedHotels = await Promise.all(hotels.map(async (h) => {
        const hotelInfo = await this.prisma.dvi_hotel.findUnique({
          where: { hotel_id: h.hotel_id },
          select: { hotel_name: true },
        });

        const rooms = await this.prisma.dvi_confirmed_itinerary_plan_hotel_room_details.findMany({
          where: {
            confirmed_itinerary_plan_hotel_details_id: h.confirmed_itinerary_plan_hotel_details_ID,
            deleted: 0,
          },
        });

        return {
          hotel_id: h.hotel_id,
          hotel_name: hotelInfo?.hotel_name || 'N/A',
          date: route.itinerary_route_date,
          total_cost: h.total_hotel_cost || 0,
          rooms: rooms.map(r => ({
            room_qty: r.room_qty,
            room_rate: r.room_rate,
            extra_bed_count: r.extra_bed_count,
            extra_bed_rate: r.extra_bed_rate,
            child_with_bed_count: r.child_with_bed_count,
            child_with_bed_charges: r.child_with_bed_charges,
            child_without_bed_count: r.child_without_bed_count,
            child_without_bed_charges: r.child_without_bed_charges,
          })),
        };
      }));

      return { route_id: route.itinerary_route_ID, date: route.itinerary_route_date, hotels: enrichedHotels };
    }));

    return {
      plan: {
        itinerary_plan_ID: plan.itinerary_plan_ID,
        confirmed_itinerary_plan_ID: confirmedPlanId,
        booking_id: plan.itinerary_quote_ID,
      },
      routes_with_hotels: hotelsData,
    };
  }

  /**
   * Get cancellation charges for entire day
   */
  async getEntireDayCancellationCharges(
    confirmedPlanId: number,
    hotelId: number,
    date: string,
    cancellationPercentage: number = 10,
  ) {
    const plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findUnique({
      where: { confirmed_itinerary_plan_ID: confirmedPlanId },
    });

    if (!plan) {
      throw new NotFoundException('Confirmed itinerary not found');
    }

    // Get the hotel details for the specific day
    const hotelDetails = await this.prisma.dvi_confirmed_itinerary_plan_hotel_details.findFirst({
      where: {
        itinerary_plan_id: plan.itinerary_plan_ID,
        hotel_id: hotelId,
        deleted: 0,
      },
    });

    if (!hotelDetails) {
      throw new NotFoundException('Hotel not found for this itinerary');
    }

    const totalCost = hotelDetails.total_hotel_cost || 0;
    const cancellationCharge = Math.round((totalCost * cancellationPercentage) / 100);
    const refundAmount = totalCost - cancellationCharge;

    return {
      total_cost: totalCost,
      cancellation_percentage: cancellationPercentage,
      cancellation_charge: cancellationCharge,
      refund_amount: Math.max(0, refundAmount),
      breakdown: {
        room_cost: hotelDetails.total_room_cost || 0,
        meal_plan_cost: hotelDetails.total_hotel_meal_plan_cost || 0,
        amenities_cost: hotelDetails.total_amenities_cost || 0,
        tax_amount: hotelDetails.total_hotel_tax_amount || 0,
      },
    };
  }

  /**
   * Execute hotel cancellation (entire day or room)
   */
  async cancelHotel(
    confirmedPlanId: number,
    hotelId: number,
    date: string,
    totalCancellationCharge: number,
    totalRefundAmount: number,
    defectType: string = 'dvi',
  ) {
    const userId = 1; // TODO: Get from authenticated user

    const plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findUnique({
      where: { confirmed_itinerary_plan_ID: confirmedPlanId },
    });

    if (!plan) {
      throw new NotFoundException('Confirmed itinerary not found');
    }

    return await this.prisma.$transaction(async (tx) => {
      // 1. Create hotel cancellation record (if table exists)
      // This is for audit trail
      try {
        await (tx as any).dvi_hotel_cancellations.create({
          data: {
            confirmed_itinerary_plan_ID: confirmedPlanId,
            hotel_id: hotelId,
            cancellation_date: new Date(date),
            total_cancellation_charge: totalCancellationCharge,
            total_refund_amount: totalRefundAmount,
            defect_type: defectType,
            createdby: userId,
            createdon: new Date(),
            status: 1,
            deleted: 0,
          },
        });
      } catch (error) {
        console.log('Hotel cancellation table not found, skipping audit record');
      }

      // 2. Soft delete the hotel details
      const hotelDetails = await (tx as any).dvi_confirmed_itinerary_plan_hotel_details.findFirst({
        where: {
          itinerary_plan_id: plan.itinerary_plan_ID,
          hotel_id: hotelId,
          deleted: 0,
        },
      });

      if (hotelDetails) {
        await (tx as any).dvi_confirmed_itinerary_plan_hotel_details.update({
          where: { confirmed_itinerary_plan_hotel_details_ID: hotelDetails.confirmed_itinerary_plan_hotel_details_ID },
          data: {
            deleted: 1,
            updatedon: new Date(),
          },
        });

        // Soft delete related room details
        await (tx as any).dvi_confirmed_itinerary_plan_hotel_room_details.updateMany({
          where: { confirmed_itinerary_plan_hotel_details_id: hotelDetails.confirmed_itinerary_plan_hotel_details_ID },
          data: { deleted: 1 },
        });
      }

      // 3. Update plan total amounts
      if (totalRefundAmount > 0) {
        await (tx as any).dvi_confirmed_itinerary_plan_details.update({
          where: { confirmed_itinerary_plan_ID: confirmedPlanId },
          data: {
            total_hotel_charges: {
              decrement: totalCancellationCharge + totalRefundAmount,
            },
            itinerary_total_net_payable_amount: {
              decrement: totalCancellationCharge,
            },
            updatedon: new Date(),
          },
        });

        // Record refund in accounts
        await (tx as any).dvi_accounts_itinerary_details.updateMany({
          where: { confirmed_itinerary_plan_ID: confirmedPlanId },
          data: {
            total_received_amount: {
              decrement: totalCancellationCharge,
            },
            total_payout_amount: {
              increment: totalRefundAmount,
            },
          },
        });
      }

      return {
        success: true,
        message: 'Hotel cancelled successfully',
        refund_amount: totalRefundAmount,
      };
    });
  }

  /**
   * Get confirmed itinerary details with booked hotels from database
   * Returns ONLY the selected/confirmed hotels, not all options
   */
  async getConfirmedItineraryDetails(confirmedPlanId: number) {
    console.log('🔍 getConfirmedItineraryDetails called with confirmedPlanId:', confirmedPlanId);
    console.log('   this.prisma exists?', !!this.prisma);
    
    if (!this.prisma) {
      throw new Error('PrismaService not initialized in ItinerariesService');
    }

    // Get the confirmed plan
    const plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findUnique({
      where: { confirmed_itinerary_plan_ID: confirmedPlanId },
    });

    if (!plan) {
      throw new NotFoundException('Confirmed itinerary not found');
    }

    // Get the original itinerary plan details separately (no relation in schema)
    const originalPlan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: plan.itinerary_plan_ID },
    });

    if (!originalPlan) {
      throw new NotFoundException('Original itinerary plan not found');
    }

    console.log('   ✅ Found confirmed plan and original plan');

    // Get all routes for this itinerary
    // NOTE: Schema has no itinerary_route_order field, using array index + 1 for day calculation
    const routes = await this.prisma.dvi_itinerary_route_details.findMany({
      where: {
        itinerary_plan_ID: plan.itinerary_plan_ID,
        deleted: 0,
      },
      orderBy: { itinerary_route_ID: 'asc' },
    });

    console.log('   📍 Found', routes.length, 'routes');

    // Save prisma reference for use in callbacks (to avoid context loss)
    const prisma = this.prisma;

    // For each route, get the confirmed hotel booking
    const routesWithHotels = await Promise.all(routes.map(async (route, index) => {
      // Get confirmed hotel for this route (should be 1 hotel = the one that was booked)
      const confirmedHotels = await prisma.dvi_confirmed_itinerary_plan_hotel_details.findMany({
        where: {
          itinerary_plan_id: plan.itinerary_plan_ID,
          itinerary_route_id: route.itinerary_route_ID,
          deleted: 0,
        },
      });

      // For each confirmed hotel, get hotel details and room details separately
      const hotelsWithRooms = await Promise.all(confirmedHotels.map(async (hotel) => {
        // Get hotel details from dvi_hotel table (no relation defined, manual join)
        const hotelDetails = await prisma.dvi_hotel.findUnique({
          where: { hotel_id: hotel.hotel_id },
          select: {
            hotel_id: true,
            hotel_name: true,
            hotel_address: true, // Changed from hotel_location (doesn't exist)
            hotel_city: true,
            hotel_category: true, // Changed from rating (doesn't exist)
          },
        });

        const roomDetails = await prisma.dvi_confirmed_itinerary_plan_hotel_room_details.findMany({
          where: {
            itinerary_plan_id: plan.itinerary_plan_ID,
            itinerary_route_id: route.itinerary_route_ID,
            deleted: 0,
          },
        });

        return {
          hotel_id: hotel.hotel_id,
          hotel_name: hotelDetails?.hotel_name || 'Unknown Hotel',
          destination: route.next_visiting_location || route.location_name, // Changed from non-existent itinerary_route_destination_city
          day: index + 1, // Changed from non-existent itinerary_route_order, calculate from index
          date: route.itinerary_route_date,
          category: this.mapHotelCategoryToName(hotel.hotel_category_id || hotelDetails?.hotel_category || 0),
          roomType: roomDetails[0]?.room_id ? `Room ${roomDetails[0].room_id}` : 'Standard',
          totalHotelCost: hotel.total_hotel_cost,
          hotelTabs: [
            {
              groupType: hotel.group_type || 1,
              name: this.mapHotelGroupTypeToCategory(hotel.group_type || 1),
              hotels: [
                {
                  hotel_id: hotel.hotel_id,
                  hotel_name: hotelDetails?.hotel_name || 'Unknown',
                  rating: this.mapHotelCategoryToStars(hotel.hotel_category_id || hotelDetails?.hotel_category || 0), // Map category to stars
                  location: `${hotelDetails?.hotel_city || ''}, ${hotelDetails?.hotel_address || ''}`.trim(),
                  totalCost: hotel.total_hotel_cost,
                },
              ],
            },
          ],
          roomDetails: roomDetails.map((r) => ({
            room_id: r.room_id,
            room_type_id: r.room_type_id,
            room_rate: r.room_rate,
            extra_bed_count: r.extra_bed_count,
            extra_bed_rate: r.extra_bed_rate,
            child_with_bed_count: r.child_with_bed_count,
            child_with_bed_charges: r.child_with_bed_charges,
            child_without_bed_count: r.child_without_bed_count,
            child_without_bed_charges: r.child_without_bed_charges,
            total_room_cost: r.total_room_cost,
          })),
        };
      }));

      return {
        route_id: route.itinerary_route_ID,
        destination: route.next_visiting_location || route.location_name, // Changed from non-existent itinerary_route_destination_city
        date: route.itinerary_route_date,
        day: index + 1, // Changed from non-existent itinerary_route_order
        hotels: hotelsWithRooms,
      };
    }));

    // Flatten all hotels from all routes for the frontend hotels array
    const allHotels = routesWithHotels.flatMap(route => route.hotels);

    // Calculate start and end dates
    const startDate = originalPlan.trip_start_date_and_time;
    const endDate = originalPlan.trip_end_date_and_time;
    const nightsCount = routesWithHotels.length;

    return {
      id: confirmedPlanId.toString(),
      quoteId: originalPlan.itinerary_quote_ID.toString(),
      agent: '', // TODO: Get from booking data
      primaryCustomer: '', // TODO: Get from customer data
      arrivalLocation: routesWithHotels[0]?.destination || '',
      departureLocation: routesWithHotels[routesWithHotels.length - 1]?.destination || '',
      startDate: startDate,
      endDate: endDate,
      nights: nightsCount,
      days: nightsCount + 1,
      adults: 2, // TODO: Get from itinerary details
      children: 0, // TODO: Get from itinerary details
      infants: 0, // TODO: Get from itinerary details
      guide: false, // TODO: Get from itinerary details
      entryTicket: false, // TODO: Get from itinerary details
      rooms: 1, // TODO: Get from itinerary details
      hotels: allHotels,
      totalCost: 0, // Calculate from confirmed bookings
      createdDate: new Date().toISOString().split('T')[0],
      status: 'confirmed' as const,
      // Also include the detailed structure for reference
      routes_with_hotels: routesWithHotels,
      plan: {
        itinerary_plan_ID: originalPlan.itinerary_plan_ID,
        confirmed_itinerary_plan_ID: confirmedPlanId,
        booking_id: originalPlan.itinerary_quote_ID,
        plan_name: `Itinerary ${originalPlan.itinerary_plan_ID}`,
        start_date: originalPlan.trip_start_date_and_time,
        end_date: originalPlan.trip_end_date_and_time,
        total_cost: 0, // Calculate from confirmed bookings
      },
    };
  }

  /**
   * Map hotel group type to category name
   */
  private mapHotelGroupTypeToCategory(groupType: number): string {
    const categoryMap = {
      1: 'Budget',
      2: 'Mid-Range',
      3: 'Premium',
      4: 'Luxury',
    };
    return categoryMap[groupType] || 'Budget';
  }

  /**
   * Map hotel category (from dvi_hotel.hotel_category) to star rating
   * The hotel_category field is an integer, typically 1-5 or similar
   */
  private mapHotelCategoryToStars(category: number): number {
    // Map category ID to star rating
    // Assuming: 1=1star, 2=2star, 3=3star, 4=4star, 5=5star
    return Math.min(Math.max(category, 1), 5); // Clamp between 1-5
  }

  /**
   * Map hotel category to friendly name
   */
  private mapHotelCategoryToName(category: number): string {
    const categoryNames = {
      1: '1-Star',
      2: '2-Star',
      3: '3-Star',
      4: '4-Star',
      5: '5-Star',
    };
    return categoryNames[category] || 'Standard';
  }

  /**
   * Get hotel room categories for selection modal
   * Fetches room types from TBO API instead of local database
   */
  async getHotelRoomCategories(params: {
    itinerary_plan_hotel_details_ID: number;
    itinerary_plan_id: number;
    itinerary_route_id: number;
    hotel_id: number;
    group_type: number;
  }) {
    // Get itinerary plan details for preferred room count and quote ID
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: params.itinerary_plan_id },
      select: { 
        preferred_room_count: true,
        itinerary_quote_ID: true,
      },
    });

    if (!plan) {
      throw new NotFoundException('Itinerary plan not found');
    }

    // Get route date
    const route = await this.prisma.dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: params.itinerary_route_id },
      select: { itinerary_route_date: true },
    });

    if (!route) {
      throw new NotFoundException('Route not found');
    }

    // Fetch room details from TBO API
    const tboRoomDetails = await this.hotelDetailsTboService.getHotelRoomDetailsFromTbo(
      plan.itinerary_quote_ID,
      params.itinerary_route_id,
    );

    // Find the specific hotel in TBO results
    const hotelRoom = tboRoomDetails.rooms.find(
      (room) => room.hotelId === params.hotel_id && room.groupType === params.group_type
    );

    if (!hotelRoom) {
      throw new NotFoundException('Hotel not found in TBO results');
    }

    // Get available room types from TBO data
    const availableRoomTypes = hotelRoom.availableRoomTypes || [];

    if (availableRoomTypes.length === 0) {
      throw new NotFoundException('No room types available for this hotel from TBO');
    }

    // Get existing room selections from database
    const existingRooms = await this.prisma.dvi_itinerary_plan_hotel_room_details.findMany({
      where: {
        itinerary_plan_id: params.itinerary_plan_id,
        itinerary_route_id: params.itinerary_route_id,
        itinerary_route_date: route.itinerary_route_date,
        hotel_id: params.hotel_id,
        group_type: params.group_type,
        deleted: 0,
      },
      orderBy: {
        itinerary_plan_hotel_room_details_ID: 'asc',
      },
    });

    const rooms = [];

    if (existingRooms.length > 0) {
      // Return existing room selections with TBO room types
      existingRooms.forEach((room, index) => {
        const selectedRoomType = availableRoomTypes.find(
          (rt) => rt.roomTypeId === room.room_type_id
        );
        rooms.push({
          room_number: index + 1,
          itinerary_plan_hotel_room_details_ID: room.itinerary_plan_hotel_room_details_ID,
          room_type_id: room.room_type_id,
          room_type_title: selectedRoomType?.roomTypeTitle || room.room_type_id.toString(),
          room_qty: room.room_qty,
          available_room_types: availableRoomTypes.map((rt) => ({
            room_type_id: rt.roomTypeId,
            room_type_title: rt.roomTypeTitle || '',
          })),
        });
      });
    } else {
      // Create empty slots for preferred room count with TBO room types
      for (let i = 0; i < (plan.preferred_room_count || 1); i++) {
        rooms.push({
          room_number: i + 1,
          room_type_id: null,
          room_type_title: '',
          room_qty: 1,
          available_room_types: availableRoomTypes.map((rt) => ({
            room_type_id: rt.roomTypeId,
            room_type_title: rt.roomTypeTitle || '',
          })),
        });
      }
    }

    return {
      itinerary_plan_hotel_details_ID: params.itinerary_plan_hotel_details_ID,
      hotel_id: params.hotel_id,
      hotel_name: hotelRoom.hotelName || '',
      preferred_room_count: plan.preferred_room_count || 1,
      rooms,
    };
  }

  /**
   * Update room category selection
   * Creates or updates the room selection in dvi_itinerary_plan_hotel_room_details
   * Room type IDs come from TBO API
   */
  async updateRoomCategory(params: {
    itinerary_plan_hotel_room_details_ID?: number;
    itinerary_plan_hotel_details_ID: number;
    itinerary_plan_id: number;
    itinerary_route_id: number;
    hotel_id: number;
    group_type: number;
    room_type_id: number;
    room_qty?: number;
    all_meal_plan?: number;
    breakfast_meal_plan?: number;
    lunch_meal_plan?: number;
    dinner_meal_plan?: number;
  }) {
    // Get route date
    const route = await this.prisma.dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: params.itinerary_route_id },
      select: { itinerary_route_date: true },
    });

    if (!route) {
      throw new NotFoundException('Route not found');
    }

    // Get quote ID to fetch TBO data
    const planDetails = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { 
        itinerary_plan_ID: params.itinerary_plan_id,
        deleted: 0,
      },
      select: {
        itinerary_quote_ID: true,
      },
    });

    if (!planDetails) {
      throw new NotFoundException('Itinerary plan details not found');
    }

    // Fetch room details from TBO to get pricing and room information
    const tboRoomDetails = await this.hotelDetailsTboService.getHotelRoomDetailsFromTbo(
      planDetails.itinerary_quote_ID,
      params.itinerary_route_id,
    );

    // Find the specific hotel and room type in TBO results
    const hotelRoom = tboRoomDetails.rooms.find(
      (room) => room.hotelId === params.hotel_id && room.groupType === params.group_type
    );

    if (!hotelRoom) {
      throw new NotFoundException('Hotel not found in TBO results');
    }

    // Find the selected room type from TBO data
    const selectedRoomType = hotelRoom.availableRoomTypes?.find(
      (rt) => rt.roomTypeId === params.room_type_id
    );

    if (!selectedRoomType) {
      throw new NotFoundException('Selected room type not available from TBO');
    }

    // Use TBO pricing data
    const roomRate = hotelRoom.pricePerNight || 0;
    const now = new Date();

    // Check if record already exists
    if (params.itinerary_plan_hotel_room_details_ID) {
      // Update existing record
      await this.prisma.dvi_itinerary_plan_hotel_room_details.update({
        where: {
          itinerary_plan_hotel_room_details_ID: params.itinerary_plan_hotel_room_details_ID,
        },
        data: {
          room_type_id: params.room_type_id,
          room_id: params.room_type_id, // Use room_type_id as room_id for TBO rooms
          room_qty: params.room_qty || 1,
          room_rate: roomRate,
          breakfast_required: params.breakfast_meal_plan || params.all_meal_plan || 0,
          lunch_required: params.lunch_meal_plan || params.all_meal_plan || 0,
          dinner_required: params.dinner_meal_plan || params.all_meal_plan || 0,
          updatedon: now,
        },
      });
    } else {
      // Create new record
      await this.prisma.dvi_itinerary_plan_hotel_room_details.create({
        data: {
          itinerary_plan_hotel_details_id: params.itinerary_plan_hotel_details_ID,
          group_type: params.group_type,
          itinerary_plan_id: params.itinerary_plan_id,
          itinerary_route_id: params.itinerary_route_id,
          itinerary_route_date: route.itinerary_route_date,
          hotel_id: params.hotel_id,
          room_type_id: params.room_type_id,
          room_id: params.room_type_id, // Use room_type_id as room_id for TBO rooms
          room_qty: params.room_qty || 1,
          room_rate: roomRate,
          gst_type: 0, // TBO handles GST internally
          gst_percentage: 0,
          breakfast_required: params.breakfast_meal_plan || params.all_meal_plan || 0,
          lunch_required: params.lunch_meal_plan || params.all_meal_plan || 0,
          dinner_required: params.dinner_meal_plan || params.all_meal_plan || 0,
          createdon: now,
          updatedon: now,
          status: 1,
          deleted: 0,
        },
      });
    }

    return { 
      success: true, 
      message: 'Room category updated successfully',
      roomTypeName: selectedRoomType.roomTypeTitle,
    };
  }

  /**
   * 🚀 ROUTE OPTIMIZATION: Reorder routes using TSP algorithm
   * - For ≤10 days: Exhaustive search (tests all permutations)
   * - For >10 days: Nearest Neighbor + Simulated Annealing
   * 
   * This finds the optimal or near-optimal route that minimizes total travel distance/time
   */
  private async optimizeRouteOrder(routes: any[]): Promise<any[]> {
    const log = (msg: string) => {
      console.log(msg);
    };

    if (!routes || routes.length <= 2) return routes;

    log(`[RouteOptimization] ============================================`);
    log(`[RouteOptimization] STARTING ROUTE OPTIMIZATION (PHP-EXACT MODE)`);
    log(`[RouteOptimization] ============================================`);

    // PHP LOGIC: Build source_location and next_visiting_location arrays
    const source_location: string[] = routes.map(r => r.location_name);
    const next_visiting_location: string[] = routes.map(r => r.next_visiting_location);

    log(`[RouteOptimization] Total routes: ${routes.length}`);
    log(`[RouteOptimization] Source locations: [${source_location.join(', ')}]`);
    log(`[RouteOptimization] Next visiting: [${next_visiting_location.join(', ')}]`);

    // PHP LOGIC: Anchor start and end
    const start = source_location[0];
    const end = next_visiting_location[next_visiting_location.length - 1];
    const middleLocations = next_visiting_location.slice(0, -1); // Keep duplicates!

    log(`[RouteOptimization] PHP Anchors:`);
    log(`[RouteOptimization]   start = ${start}`);
    log(`[RouteOptimization]   end = ${end}`);
    log(`[RouteOptimization]   middleLocations = [${middleLocations.join(', ')}] (${middleLocations.length} locations with duplicates)`);

    if (middleLocations.length === 0) {
      log(`[RouteOptimization] ⚠️  No middle locations to optimize. Returning as-is.`);
      return routes;
    }

    // PHP LOGIC: Choose algorithm based on route count
    let bestRouteLocations: string[] = [];

    if (middleLocations.length <= 10) {
      log(`[RouteOptimization] ≤10 routes: Using EXHAUSTIVE PERMUTATION search`);
      bestRouteLocations = await this.optimizeWith_ExhaustivePermutation(
        start,
        end,
        middleLocations,
        log
      );
    } else {
      log(`[RouteOptimization] >10 routes: Using NEAREST NEIGHBOR + SIMULATED ANNEALING`);
      bestRouteLocations = await this.optimizeWith_NearestNeighborAndAnnealing(
        start,
        end,
        middleLocations,
        log
      );
    }

    log(`[RouteOptimization] Best route locations: [${bestRouteLocations.join(', ')}]`);

    // PHP LOGIC: Rebuild routes in-place from new bestRouteLocations
    const optimizedRoutes: any[] = [];
    for (let i = 0; i < routes.length; i++) {
      const newRoute = { ...routes[i] }; // Preserve all other fields
      newRoute.location_name = bestRouteLocations[i];
      newRoute.next_visiting_location = bestRouteLocations[i + 1];
      optimizedRoutes.push(newRoute);
      
      log(`[RouteOptimization] Route[${i}]: ${newRoute.location_name} → ${newRoute.next_visiting_location}`);
    }

    // Optionally: shift itinerary_route_date sequentially like PHP does
    const startDate = new Date(routes[0].itinerary_route_date);
    optimizedRoutes.forEach((route, index) => {
      const newDate = new Date(startDate);
      newDate.setDate(newDate.getDate() + index);
      route.itinerary_route_date = newDate.toISOString().split('T')[0]; // Keep YYYY-MM-DD format
      route.no_of_days = index + 1;
    });

    log(`[RouteOptimization] ✅ Route optimization completed`);
    log(`[RouteOptimization] Final chain: ${optimizedRoutes.map(r => `${r.location_name}→${r.next_visiting_location}`).join(' | ')}`);

    return optimizedRoutes;
  }

  /**
   * PHP-EXACT: ≤10 routes - EXHAUSTIVE PERMUTATION
   * Tries all permutations of middleLocations and finds the one with minimum total distance
   */
  private async optimizeWith_ExhaustivePermutation(
    start: string,
    end: string,
    middleLocations: string[],
    log: (msg: string) => void
  ): Promise<string[]> {
    const perms = this.generatePermutations_PHP([...middleLocations]);
    
    let bestPerm: string[] = middleLocations; // Default to original order
    let bestDistance = Infinity;
    let bestChain = '';
    
    log(`[ExhaustivePermutation] Testing ${perms.length} permutations...`);
    
    for (const perm of perms) {
      let current = start;
      let totalDistance = 0;
      const chain: string[] = [current];
      
      // Evaluate cost: start -> perm[0] -> perm[1] -> ... -> perm[n-1] -> end
      for (const loc of perm) {
        const distance = await this.getDistance_PHP(current, loc);
        if (distance === Infinity) {
          totalDistance = Infinity;
          break; // Missing distance = invalid permutation
        }
        totalDistance += distance;
        current = loc;
        chain.push(current);
      }
      
      // Add final segment: last middle location -> end
      if (totalDistance !== Infinity) {
        const finalDist = await this.getDistance_PHP(current, end);
        if (finalDist === Infinity) {
          totalDistance = Infinity;
        } else {
          totalDistance += finalDist;
          chain.push(end);
        }
      }
      
      const chainStr = chain.join(' → ');
      log(`[ExhaustivePermutation] [${perm.join(',')}]: ${totalDistance === Infinity ? 'INVALID (missing distance)' : totalDistance.toFixed(1) + ' km'} (${chainStr})`);
      
      if (totalDistance < bestDistance) {
        bestDistance = totalDistance;
        bestPerm = perm;
        bestChain = chainStr;
      }
    }
    
    log(`[ExhaustivePermutation] ✅ Best permutation: [${bestPerm.join(',')}] = ${bestDistance.toFixed(1)} km`);
    log(`[ExhaustivePermutation] Best chain: ${bestChain}`);
    
    // Return final route locations: [start, ...bestPerm, end]
    return [start, ...bestPerm, end];
  }

  /**
   * PHP-EXACT: >10 routes - NEAREST NEIGHBOR + SIMULATED ANNEALING
   */
  private async optimizeWith_NearestNeighborAndAnnealing(
    start: string,
    end: string,
    middleLocations: string[],
    log: (msg: string) => void
  ): Promise<string[]> {
    // Build remainingLocationsCounts (like PHP's array_count_values for duplicates)
    const remainingLocationsCounts = this.buildLocationCounts_PHP(middleLocations);
    log(`[NearestNeighbor] Location counts: ${JSON.stringify(remainingLocationsCounts)}`);
    
    // Greedy nearest neighbor
    const greedyRoute = await this.nearestNeighbor_PHP(start, remainingLocationsCounts, log);
    log(`[NearestNeighbor] Greedy route: [${greedyRoute.join(', ')}]`);
    
    // Build initial route: [start, ...greedy, end]
    let initialRoute = [start, ...greedyRoute, end];
    let initialDistance = await this.calculateChainDistance_PHP(initialRoute, log);
    log(`[SimulatedAnnealing] Initial route distance: ${initialDistance.toFixed(1)} km`);
    
    // Simulated annealing
    const finalRoute = await this.simulatedAnnealing_PHP(
      initialRoute,
      1000,      // initialTemp
      0.003,     // coolingRate
      log
    );
    
    let finalDistance = await this.calculateChainDistance_PHP(finalRoute, log);
    log(`[SimulatedAnnealing] Final route distance: ${finalDistance.toFixed(1)} km`);
    
    return finalRoute;
  }

  /**
   * PHP-EXACT: Build location counts like array_count_values
   */
  private buildLocationCounts_PHP(locations: string[]): { [location: string]: number } {
    const counts: { [location: string]: number } = {};
    for (const loc of locations) {
      counts[loc] = (counts[loc] || 0) + 1;
    }
    return counts;
  }

  /**
   * PHP-EXACT: Nearest neighbor greedy algorithm
   * Returns ordered list of middle locations (not including start/end)
   */
  private async nearestNeighbor_PHP(
    start: string,
    remainingLocationsCounts: { [location: string]: number },
    log: (msg: string) => void
  ): Promise<string[]> {
    const route: string[] = [];
    let current = start;
    
    // Total locations to visit
    const totalLocations = Object.values(remainingLocationsCounts).reduce((a, b) => a + b, 0);
    
    log(`[NearestNeighbor] Total middle locations to visit: ${totalLocations}`);
    
    for (let step = 0; step < totalLocations; step++) {
      let nearestLocation: string | null = null;
      let minDistance = Infinity;
      
      // Find nearest unvisited location
      for (const [location, count] of Object.entries(remainingLocationsCounts)) {
        if (count > 0) {
          const distance = await this.getDistance_PHP(current, location);
          if (distance < minDistance) {
            minDistance = distance;
            nearestLocation = location;
          }
        }
      }
      
      if (nearestLocation === null) break;
      
      route.push(nearestLocation);
      remainingLocationsCounts[nearestLocation]--;
      current = nearestLocation;
      
      log(`[NearestNeighbor] Step ${step + 1}: Selected ${nearestLocation} (distance: ${minDistance.toFixed(1)} km)`);
    }
    
    return route;
  }

  /**
   * PHP-EXACT: Simulated annealing optimization
   */
  private async simulatedAnnealing_PHP(
    initialRoute: string[],
    initialTemp: number,
    coolingRate: number,
    log: (msg: string) => void
  ): Promise<string[]> {
    let currentRoute = [...initialRoute];
    let currentDistance = await this.calculateChainDistance_PHP(currentRoute, log);
    let bestRoute = [...currentRoute];
    let bestDistance = currentDistance;
    
    let temperature = initialTemp;
    const minTemp = 0.001;
    let iteration = 0;
    
    log(`[SimulatedAnnealing] Starting with temp=${temperature.toFixed(2)}, coolingRate=${coolingRate}`);
    
    while (temperature > minTemp) {
      iteration++;
      
      // Random swap of two middle indices (NOT first or last)
      const middleStart = 1;
      const middleEnd = currentRoute.length - 2; // Exclude end
      
      if (middleEnd <= middleStart) break; // Not enough locations to swap
      
      const i = middleStart + Math.floor(Math.random() * (middleEnd - middleStart + 1));
      const j = middleStart + Math.floor(Math.random() * (middleEnd - middleStart + 1));
      
      if (i === j) {
        temperature *= (1 - coolingRate);
        continue;
      }
      
      // Create neighbor solution
      const newRoute = [...currentRoute];
      [newRoute[i], newRoute[j]] = [newRoute[j], newRoute[i]];
      
      const newDistance = await this.calculateChainDistance_PHP(newRoute, log);
      const delta = newDistance - currentDistance;
      
      // Acceptance rule: accept if better OR accept with probability based on temperature
      if (delta < 0 || Math.random() < Math.exp(-delta / temperature)) {
        currentRoute = newRoute;
        currentDistance = newDistance;
        
        if (currentDistance < bestDistance) {
          bestRoute = [...currentRoute];
          bestDistance = currentDistance;
          log(`[SimulatedAnnealing] Iteration ${iteration}: New best distance = ${bestDistance.toFixed(1)} km (temp=${temperature.toFixed(4)})`);
        }
      }
      
      temperature *= (1 - coolingRate);
      
      if (iteration % 100 === 0) {
        log(`[SimulatedAnnealing] Iteration ${iteration}: current=${currentDistance.toFixed(1)} km, best=${bestDistance.toFixed(1)} km, temp=${temperature.toFixed(4)}`);
      }
    }
    
    log(`[SimulatedAnnealing] Completed ${iteration} iterations`);
    return bestRoute;
  }

  /**
   * PHP-EXACT: Calculate total distance for a route chain
   */
  private async calculateChainDistance_PHP(chain: string[], log?: (msg: string) => void): Promise<number> {
    let totalDistance = 0;
    for (let i = 0; i < chain.length - 1; i++) {
      const distance = await this.getDistance_PHP(chain[i], chain[i + 1]);
      if (distance === Infinity) return Infinity;
      totalDistance += distance;
    }
    return totalDistance;
  }

  /**
   * Calculate distance matrix between locations
   * In a real scenario, this would call Google Maps or similar API
   * For now, using a simplified distance calculation or mock data
   */




  /**
   * PHP-EXACT: Get distance between two locations from database
   * Returns Infinity if distance not found (matching PHP's PHP_INT_MAX behavior)
   * NO reverse fallback, NO default 100, ONLY exact match
   */
  private async getDistance_PHP(sourceLocation: string, destinationLocation: string): Promise<number> {
    if (sourceLocation === destinationLocation) return 0;
    
    try {
      const record = await this.prisma.dvi_stored_locations.findFirst({
        where: {
          source_location: sourceLocation,
          destination_location: destinationLocation,
        },
        select: {
          distance: true,
        },
      });

      if (record && record.distance) {
        const dist = typeof record.distance === 'string' 
          ? parseFloat(record.distance) 
          : record.distance;
        return isNaN(dist) ? Infinity : dist;
      }
      return Infinity; // Missing distance = Infinity (marks permutation as invalid)
    } catch (error) {
      return Infinity; // Error = Infinity (marks permutation as invalid)
    }
  }

  /**
   * PHP-EXACT: Generate all permutations of a location array (preserves duplicates)
   * Used for exhaustive search on ≤10 routes
   */
  private generatePermutations_PHP(arr: string[]): string[][] {
    if (arr.length <= 1) return [arr];
    
    const result: string[][] = [];
    for (let i = 0; i < arr.length; i++) {
      const current = arr[i];
      const remaining = arr.slice(0, i).concat(arr.slice(i + 1));
      const perms = this.generatePermutations_PHP(remaining);
      
      for (const perm of perms) {
        result.push([current, ...perm]);
      }
    }
    
    return result;
  }

  /**
   * Helper: Convert TIME to minutes since midnight
   */
  private timeToMinutes(time: Date | null): number {
    if (!time) return 0;
    const d = new Date(time);
    // TIME columns are stored/handled as UTC values in this codebase.
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }

  /**
   * Helper: Format time for display
   */
  private formatTime(time: Date | null): string {
    if (!time) return 'N/A';
    const d = new Date(time);
    const hours = d.getUTCHours().toString().padStart(2, '0');
    const minutes = d.getUTCMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  /**
   * Helper: Add minutes to a time
   */
  private addMinutesToTime(time: Date, minutes: number): Date {
    const result = new Date(time);
    result.setUTCMinutes(result.getUTCMinutes() + minutes);
    return result;
  }

  /**
   * Check if proposed activity insertion timing conflicts with activity time slots.
   */
  private checkActivityTimingConflicts(
    activity: any,
    timeSlots: any[],
    proposedStartTime: Date,
    proposedEndTime: Date
  ): Array<{ reason: string; severity: string }> {
    const conflicts: Array<{ reason: string; severity: string }> = [];

    if (timeSlots.length === 0) {
      // No time restrictions
      return conflicts;
    }

    const proposedStart = this.timeToMinutes(proposedStartTime);
    const proposedEnd = this.timeToMinutes(proposedEndTime);

    // Check if proposed slot fits in any available slot.
    const fitsAnySlot = timeSlots.some((slot: any) => {
      const slotStart = this.timeToMinutes(slot.start_time);
      const slotEnd = this.timeToMinutes(slot.end_time);
      return proposedStart >= slotStart && proposedEnd <= slotEnd;
    });

    if (!fitsAnySlot) {
      const slotRanges = timeSlots
        .map((slot: any) => `${this.formatTime(slot.start_time)} - ${this.formatTime(slot.end_time)}`)
        .join(', ');

      conflicts.push({
        reason:
          `Activity "${activity.activity_title}" is available only at ${slotRanges}, ` +
          `but it would be inserted at ${this.formatTime(proposedStartTime)} - ${this.formatTime(proposedEndTime)}`,
        severity: 'warning',
      });
    }

    return conflicts;
  }


}