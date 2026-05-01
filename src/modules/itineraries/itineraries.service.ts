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
import { TboHotelBookingService } from "./services/tbo-hotel-booking.service";
import { ResAvenueHotelBookingService } from "./services/resavenue-hotel-booking.service";
import { HobseHotelBookingService } from "./services/hobse-hotel-booking.service";
import { ItineraryHotelDetailsTboService } from "./itinerary-hotel-details-tbo.service";
import { normalizePassengerTitle } from "../../common/utils/passenger-title.util";
import { SupplementNormalizerService } from "../../modules/hotels/services/supplement-normalizer.service";
import { normalizeCityName } from "./utils/city-normalization.util";

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

  private normalizeToUniqueStrings(items: any[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];

    for (const item of items) {
      let text = '';

      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        text = String(item).trim();
      } else if (item && typeof item === 'object') {
        text = String(item?.name || item?.text || item?.description || item?.label || '').trim();
        if (!text) {
          try {
            text = JSON.stringify(item);
          } catch {
            text = '';
          }
        }
      }

      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }

    return out;
  }

  private inferMealPlanFromInclusions(items: string[]): string | null {
    const haystack = items.join(' ').toLowerCase();
    if (!haystack) return null;

    if (haystack.includes('full board')) return 'Full Board';
    if (haystack.includes('half board')) return 'Half Board';
    if (haystack.includes('room only') || haystack.includes('no meals')) return 'Room Only';
    if (haystack.includes('breakfast')) return 'Breakfast Included';

    return null;
  }

  async createPlan(dto: CreateItineraryDto, req: any, shouldOptimizeRoute: boolean = false) {
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

    // Step 10: Persist a reusable template snapshot for this itinerary shape.
    try {
      await this.saveReusableTemplateFromPlan(result.planId, userId);
    } catch (templateError) {
      console.error('[ItinerariesService] Failed to persist reusable template:', templateError);
    }

    console.log('[PERF] TOTAL createPlan:', Date.now() - perfStart, 'ms');

    return result;
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
  ) {
    const source = String(sourceLocation || '').trim();
    const destination = String(destinationLocation || '').trim();
    const days = Number(dayCount || 0);

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
      template: this.parseJsonSafely(row.template_payload),
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

  /**
   * Delete a hotspot from an itinerary route
   * Hard deletes the hotspot from timeline and adds to excluded_hotspot_ids
   */
  async deleteHotspot(planId: number, routeId: number, hotspotId: number) {
    const userId = 1;
    const normalizedPlanId = Number(planId || 0);
    const normalizedRouteId = Number(routeId || 0);
    const normalizedHotspotParam = Number(hotspotId || 0);

    const rebuildResult = await this.prisma.$transaction(async (tx) => {
      // Accept either route_hotspot_ID or hotspot_ID from caller and resolve to master hotspot_ID.
      let hotspotRecord = await (tx as any).dvi_itinerary_route_hotspot_details.findFirst({
        where: {
          itinerary_plan_ID: normalizedPlanId,
          itinerary_route_ID: normalizedRouteId,
          route_hotspot_ID: normalizedHotspotParam,
          deleted: 0,
        },
      });

      if (!hotspotRecord) {
        hotspotRecord = await (tx as any).dvi_itinerary_route_hotspot_details.findFirst({
          where: {
            itinerary_plan_ID: normalizedPlanId,
            itinerary_route_ID: normalizedRouteId,
            hotspot_ID: normalizedHotspotParam,
            item_type: 4,
            deleted: 0,
          },
          orderBy: [{ hotspot_order: 'asc' }, { route_hotspot_ID: 'asc' }],
        });
      }

      if (!hotspotRecord) {
        throw new BadRequestException('Hotspot not found');
      }

      const actualHotspotId = Number(hotspotRecord.hotspot_ID || 0);

      // Delete all timeline rows tied to this hotspot in the route so it cannot survive via pair rows.
      const routeRowsForHotspot = actualHotspotId > 0
        ? await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
            where: {
              itinerary_plan_ID: normalizedPlanId,
              itinerary_route_ID: normalizedRouteId,
              hotspot_ID: actualHotspotId,
              deleted: 0,
            },
            select: { route_hotspot_ID: true },
          })
        : [];

      const routeHotspotIdsToDelete = routeRowsForHotspot
        .map((r: any) => Number(r.route_hotspot_ID || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0);

      if (routeHotspotIdsToDelete.length > 0) {
        await (tx as any).dvi_itinerary_route_activity_details.deleteMany({
          where: {
            itinerary_plan_ID: normalizedPlanId,
            itinerary_route_ID: normalizedRouteId,
            route_hotspot_ID: { in: routeHotspotIdsToDelete },
          },
        });
      }

      const deleted = await (tx as any).dvi_itinerary_route_hotspot_details.deleteMany({
        where: routeHotspotIdsToDelete.length > 0
          ? {
              itinerary_plan_ID: normalizedPlanId,
              itinerary_route_ID: normalizedRouteId,
              route_hotspot_ID: { in: routeHotspotIdsToDelete },
            }
          : {
              itinerary_plan_ID: normalizedPlanId,
              itinerary_route_ID: normalizedRouteId,
              route_hotspot_ID: normalizedHotspotParam,
            },
      });

      if (deleted.count === 0) {
        throw new BadRequestException('Hotspot not found');
      }

      if (actualHotspotId > 0) {
        await this.addRouteHotspotToExcludedList(tx, normalizedRouteId, actualHotspotId);
      }

      // Trigger a full rebuild of the hotspots for this plan
      // This ensures travel times and hotel arrival are recalculated after deletion
      return await this.hotspotEngine.rebuildRouteHotspots(tx, normalizedPlanId);
    }, { timeout: 60000 });

    // Rebuild parking charges after deletion
    await this.hotspotEngine.rebuildParkingCharges(planId, userId);

    return {
      success: true,
      message: 'Hotspot deleted and timeline recalculated successfully',
      rebuildSummary: rebuildResult.rebuildSummary,
      warnings: rebuildResult.warnings,
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
    const activityImpact = await this.simulateActivityImpactBeforeAdd(data);

    if (!activityImpact.canAdd) {
      throw new BadRequestException({
        message: 'activity cannot be added without conflict',
        warnings: activityImpact.warnings,
      });
    }

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
          hotspot_ID: true,
          hotspot_start_time: true,
          hotspot_end_time: true,
          hotspot_order: true,
        },
      });

      if (!routeHotspot) {
        throw new NotFoundException('Route hotspot not found');
      }

      // Enforce uniqueness per specific hotspot window (route_hotspot_ID),
      // not globally by hotspot_ID across all windows.
      const duplicate = await (tx as any).dvi_itinerary_route_activity_details.findFirst({
        where: {
          itinerary_plan_ID: data.planId,
          itinerary_route_ID: data.routeId,
          route_hotspot_ID: data.routeHotspotId,
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
          hotspot_ID: routeHotspot.hotspot_ID,
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

      // If activity extends beyond hotspot end time, shift downstream timeline
      // segments to keep persisted schedule consistent.
      if (activityEndTime > routeHotspot.hotspot_end_time) {
        const extensionMinutes = Math.round(
          (activityEndTime.getTime() - routeHotspot.hotspot_end_time.getTime()) / 60000,
        );

        await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
          where: { route_hotspot_ID: data.routeHotspotId },
          data: {
            hotspot_end_time: activityEndTime,
            updatedon: new Date(),
          },
        });

        if (extensionMinutes > 0) {
          const subsequentRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
            where: {
              itinerary_plan_ID: data.planId,
              itinerary_route_ID: data.routeId,
              hotspot_order: { gt: routeHotspot.hotspot_order },
              deleted: 0,
            },
            select: {
              route_hotspot_ID: true,
              hotspot_start_time: true,
              hotspot_end_time: true,
            },
            orderBy: { hotspot_order: 'asc' },
          });

          const updatedOn = new Date();

          await Promise.all(
            subsequentRows.map((row) => {
              const newStart = row.hotspot_start_time
                ? this.addMinutesToTime(row.hotspot_start_time, extensionMinutes)
                : null;
              const newEnd = row.hotspot_end_time
                ? this.addMinutesToTime(row.hotspot_end_time, extensionMinutes)
                : null;

              return (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
                where: {
                  route_hotspot_ID: row.route_hotspot_ID,
                  deleted: 0,
                },
                data: {
                  hotspot_start_time: newStart,
                  hotspot_end_time: newEnd,
                  updatedon: updatedOn,
                },
              });
            }),
          );
        }
      }

      // Step 6: When simulation indicates optional hotspots must be removed,
      // prune them from the current route to preserve priority feasibility.
      if (activityImpact.optionalHotspotRouteIdsToRemove.length > 0) {
        await (tx as any).dvi_itinerary_route_activity_details.deleteMany({
          where: {
            itinerary_plan_ID: data.planId,
            itinerary_route_ID: data.routeId,
            route_hotspot_ID: {
              in: activityImpact.optionalHotspotRouteIdsToRemove,
            },
            deleted: 0,
          },
        });

        await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
          where: {
            itinerary_plan_ID: data.planId,
            itinerary_route_ID: data.routeId,
            route_hotspot_ID: {
              in: activityImpact.optionalHotspotRouteIdsToRemove,
            },
            deleted: 0,
          },
          data: {
            deleted: 1,
            updatedon: new Date(),
          },
        });
      }

      return {
        success: true,
        message: 'Activity added successfully',
        activityId: result.route_activity_ID,
        timing: {
          startTime: activityStartTime,
          endTime: activityEndTime,
        },
        warnings: activityImpact.warnings,
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

    await this.prisma.$transaction(async (tx) => {
      const deleted = await (tx as any).dvi_itinerary_route_activity_details.deleteMany({
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
      await (tx as any).dvi_itinerary_route_details.updateMany({
        where: {
          itinerary_plan_ID: planId,
          itinerary_route_ID: routeId,
        },
        data: {
          updatedon: new Date(),
          createdby: userId,
        },
      });

      // Recalculate timeline after activity deletion to keep route/day schedule consistent.
      await this.hotspotEngine.rebuildRouteHotspots(tx, planId);
    }, { timeout: 60000 });

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

    const route = await (this.prisma as any).dvi_itinerary_route_details.findFirst({
      where: {
        itinerary_plan_ID: data.planId,
        itinerary_route_ID: data.routeId,
        deleted: 0,
      },
      select: {
        itinerary_route_ID: true,
        route_start_time: true,
        route_end_time: true,
      },
    });

    if (!route) {
      throw new NotFoundException('Route not found');
    }

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
        hotspot_order: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
      },
      orderBy: { hotspot_order: 'asc' },
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
              hotspot_priority: true,
            },
          })
        : [];

      const hotspotMetaMap = new Map<number, { name: string; priority: number }>(
        hotspotMasters.map((h: any) => [
          Number(h.hotspot_ID),
          {
            name: String(h.hotspot_name || ''),
            priority: Number(h.hotspot_priority || 0),
          },
        ])
      );

    const routeHotspotIds = routeHotspots.map((h: any) => Number(h.route_hotspot_ID));

    const routeActivities = routeHotspotIds.length > 0
      ? await (this.prisma as any).dvi_itinerary_route_activity_details.findMany({
          where: {
            itinerary_plan_ID: data.planId,
            itinerary_route_ID: data.routeId,
            route_hotspot_ID: { in: routeHotspotIds },
            deleted: 0,
          },
          select: {
            route_hotspot_ID: true,
            activity_ID: true,
            activity_order: true,
            activity_end_time: true,
            status: true,
          },
        })
      : [];

    const activitiesByHotspot = new Map<number, any[]>();
    for (const ra of routeActivities) {
      const key = Number(ra.route_hotspot_ID || 0);
      if (!activitiesByHotspot.has(key)) {
        activitiesByHotspot.set(key, []);
      }
      activitiesByHotspot.get(key)!.push(ra);
    }

    const hotspotsPreview = routeHotspots.map((hotspot: any) => {
      const hotspotActivities = activitiesByHotspot.get(Number(hotspot.route_hotspot_ID || 0)) || [];
      const duplicate = hotspotActivities.some(
        (ra: any) => Number(ra.activity_ID) === data.activityId && Number(ra.status) === 1,
      );

      const hotspotMeta = hotspotMetaMap.get(Number(hotspot.hotspot_ID || 0)) || {
        name: `Hotspot ${Number(hotspot.hotspot_ID || 0)}`,
        priority: 0,
      };

      return {
        routeHotspotId: Number(hotspot.route_hotspot_ID || 0),
        hotspotId: Number(hotspot.hotspot_ID || 0),
        hotspotName: hotspotMeta.name,
        windowStart: hotspot.hotspot_start_time,
        windowEnd: hotspot.hotspot_end_time,
        hotspotTiming: {
          startTime: hotspot.hotspot_start_time,
          endTime: hotspot.hotspot_end_time,
        },
        isAlreadyAdded: duplicate,
      };
    });

    const gaps = routeHotspots
      .map((hotspot: any, index: number) => ({ hotspot, index }))
      .filter((entry: any) => entry.index < routeHotspots.length - 1)
      .map((entry: any) => {
        const afterHotspot = routeHotspots[entry.index];
        const beforeHotspot = routeHotspots[entry.index + 1];
        const afterName = hotspotMetaMap.get(Number(afterHotspot.hotspot_ID || 0))?.name || 'Hotspot';
        const beforeName = hotspotMetaMap.get(Number(beforeHotspot.hotspot_ID || 0))?.name || 'Hotspot';

        return {
          gapIndex: entry.index + 1,
          afterRouteHotspotId: Number(afterHotspot.route_hotspot_ID || 0),
          beforeRouteHotspotId: Number(beforeHotspot.route_hotspot_ID || 0),
          afterHotspotId: Number(afterHotspot.hotspot_ID || 0),
          beforeHotspotId: Number(beforeHotspot.hotspot_ID || 0),
          label: `Insert between ${afterName} and ${beforeName}`,
        };
      });

    return {
      activity: {
        id: activity.activity_id,
        title: activity.activity_title,
        duration: activity.activity_duration,
      },
      hotspots: hotspotsPreview,
      gaps,
      route: {
        routeId: Number(route.itinerary_route_ID || 0),
        startTime: route.route_start_time,
        endTime: route.route_end_time,
      },
    };
  }

  async smartPreviewActivity(
    planId: number,
    data: {
      routeId: number;
      activityId: number;
      hotspotId?: number;
      routeHotspotId?: number;
      gapIndex?: number;
      mode?: 'preview' | 'applyPreview';
    },
  ) {
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

    const route = await (this.prisma as any).dvi_itinerary_route_details.findFirst({
      where: {
        itinerary_plan_ID: planId,
        itinerary_route_ID: data.routeId,
        deleted: 0,
      },
      select: {
        itinerary_route_ID: true,
        route_start_time: true,
        route_end_time: true,
      },
    });

    if (!route) {
      throw new NotFoundException('Route not found');
    }

    const routeHotspots = await (this.prisma as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        itinerary_route_ID: data.routeId,
        item_type: 4,
        deleted: 0,
        status: 1,
      },
      select: {
        route_hotspot_ID: true,
        hotspot_ID: true,
        hotspot_order: true,
      },
      orderBy: { hotspot_order: 'asc' },
    });

    if (!routeHotspots.length) {
      throw new NotFoundException('No active hotspots found on this route');
    }

    const hotspotIds = routeHotspots
      .map((h: any) => Number(h.hotspot_ID || 0))
      .filter((id: number) => id > 0);

    const hotspotMasters = hotspotIds.length > 0
      ? await (this.prisma as any).dvi_hotspot_place.findMany({
          where: { hotspot_ID: { in: hotspotIds } },
          select: {
            hotspot_ID: true,
            hotspot_name: true,
            hotspot_priority: true,
          },
        })
      : [];

    const hotspotMetaMap = new Map<number, { name: string; priority: number }>(
      hotspotMasters.map((h: any) => [
        Number(h.hotspot_ID),
        {
          name: String(h.hotspot_name || ''),
          priority: Number(h.hotspot_priority || 0),
        },
      ]),
    );

    const gaps = routeHotspots
      .map((hotspot: any, index: number) => ({ hotspot, index }))
      .filter((entry: any) => entry.index < routeHotspots.length - 1)
      .map((entry: any) => {
        const afterHotspot = routeHotspots[entry.index];
        const beforeHotspot = routeHotspots[entry.index + 1];
        const afterName = hotspotMetaMap.get(Number(afterHotspot.hotspot_ID || 0))?.name || 'Hotspot';
        const beforeName = hotspotMetaMap.get(Number(beforeHotspot.hotspot_ID || 0))?.name || 'Hotspot';

        return {
          gapIndex: entry.index + 1,
          afterRouteHotspotId: Number(afterHotspot.route_hotspot_ID || 0),
          beforeRouteHotspotId: Number(beforeHotspot.route_hotspot_ID || 0),
          afterHotspotId: Number(afterHotspot.hotspot_ID || 0),
          beforeHotspotId: Number(beforeHotspot.hotspot_ID || 0),
          label: `Insert between ${afterName} and ${beforeName}`,
        };
      });

    const selectedGapIndex = Number(data.gapIndex);
    const responseBase: any = {
      mode: data.mode || 'preview',
      gaps,
    };

    if (data.mode !== 'applyPreview') {
      return responseBase;
    }

    if (!Number.isInteger(selectedGapIndex)) {
      throw new BadRequestException('gapIndex is required for applyPreview');
    }

    if (!Number.isInteger(Number(data.routeHotspotId || 0)) && !Number.isInteger(Number(data.hotspotId || 0))) {
      throw new BadRequestException('routeHotspotId or hotspotId is required for applyPreview');
    }

    const previewRollbackError = new Error('__SMART_ACTIVITY_PREVIEW_ROLLBACK__');
    let previewResult: any = null;

    const timeSlots = await (this.prisma as any).dvi_activity_time_slot_details.findMany({
      where: {
        activity_id: data.activityId,
        deleted: 0,
        status: 1,
      },
    });

    try {
      await this.prisma.$transaction(async (tx) => {
        const originalHotspots = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
          where: {
            itinerary_plan_ID: planId,
            itinerary_route_ID: data.routeId,
            item_type: 4,
            deleted: 0,
            status: 1,
          },
          select: {
            route_hotspot_ID: true,
            hotspot_ID: true,
            hotspot_order: true,
          },
          orderBy: { hotspot_order: 'asc' },
        });

        if (!originalHotspots.length) {
          throw new NotFoundException('No active hotspots found on this route');
        }

        const moving =
          originalHotspots.find((h: any) => Number(h.route_hotspot_ID) === Number(data.routeHotspotId || 0)) ||
          originalHotspots.find((h: any) => Number(h.hotspot_ID) === Number(data.hotspotId || 0));

        if (!moving) {
          throw new NotFoundException('Selected hotspot to move was not found on this route');
        }

        const maxGapIndex = Math.max(0, originalHotspots.length - 1);
        if (selectedGapIndex < 0 || selectedGapIndex > maxGapIndex) {
          throw new BadRequestException(`Invalid gapIndex. Expected 0 to ${maxGapIndex}`);
        }

        const beforeSnapshot = originalHotspots.map((h: any) => ({
          routeHotspotId: Number(h.route_hotspot_ID || 0),
          hotspotId: Number(h.hotspot_ID || 0),
        }));
        const beforeHotspotIds = new Set(beforeSnapshot.map((h: any) => Number(h.hotspotId || 0)));

        await this.moveHotspotToGapInTx(
          tx,
          planId,
          data.routeId,
          Number(moving.route_hotspot_ID),
          selectedGapIndex,
        );

        const localized = await this.applyAnchoredLocalRebuildInTx(
          tx,
          planId,
          data.routeId,
          Number(moving.route_hotspot_ID),
        );

        const movedRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
          where: {
            itinerary_plan_ID: planId,
            itinerary_route_ID: data.routeId,
            hotspot_ID: Number(moving.hotspot_ID),
            item_type: 4,
            deleted: 0,
            status: 1,
          },
          select: {
            route_hotspot_ID: true,
            hotspot_ID: true,
            hotspot_start_time: true,
            hotspot_order: true,
          },
          orderBy: { hotspot_order: 'asc' },
        });

        const expectedOrder = Number(selectedGapIndex) + 1;
        const movedRow = movedRows.length > 0
          ? [...movedRows].sort((a: any, b: any) => {
              const da = Math.abs(Number(a.hotspot_order || 0) - expectedOrder);
              const db = Math.abs(Number(b.hotspot_order || 0) - expectedOrder);
              return da - db;
            })[0]
          : null;

        if (!movedRow) {
          previewResult = {
            ...responseBase,
            success: false,
            code: 'MOVED_HOTSPOT_CANNOT_BE_FORCED',
            message: 'The selected hotspot could not be kept at this position even after removing other movable hotspots.',
            conflicts: {
              hasConflict: true,
              message: 'The selected hotspot could not be forced into this gap.',
              priorityHotspotsAffected: [],
              otherHotspotsAffected: [],
            },
            rebuiltTimelinePreview: { days: [] },
            requiresConfirmation: false,
          };
          throw previewRollbackError;
        }

        const durationMinutes = activity.activity_duration
          ? this.timeToMinutes(activity.activity_duration)
          : 30;
        const activityStart = movedRow.hotspot_start_time || route.route_start_time;
        const activityEnd = this.addMinutesToTime(activityStart, durationMinutes);
        const timingConflicts = this.checkActivityTimingConflicts(
          activity,
          timeSlots,
          activityStart,
          activityEnd,
        );

        const existingActivity = await (tx as any).dvi_itinerary_route_activity_details.findFirst({
          where: {
            itinerary_plan_ID: planId,
            itinerary_route_ID: data.routeId,
            route_hotspot_ID: Number(movedRow.route_hotspot_ID),
            hotspot_ID: Number(movedRow.hotspot_ID),
            activity_ID: Number(data.activityId),
            deleted: 0,
            status: 1,
          },
          select: { route_activity_ID: true },
        });

        if (!existingActivity) {
          const maxOrder = await (tx as any).dvi_itinerary_route_activity_details.findFirst({
            where: {
              itinerary_plan_ID: planId,
              itinerary_route_ID: data.routeId,
              route_hotspot_ID: Number(movedRow.route_hotspot_ID),
              deleted: 0,
            },
            select: { activity_order: true },
            orderBy: { activity_order: 'desc' },
          });

          await (tx as any).dvi_itinerary_route_activity_details.create({
            data: {
              itinerary_plan_ID: planId,
              itinerary_route_ID: data.routeId,
              route_hotspot_ID: Number(movedRow.route_hotspot_ID),
              hotspot_ID: Number(movedRow.hotspot_ID),
              activity_ID: Number(data.activityId),
              activity_order: Number(maxOrder?.activity_order || 0) + 1,
              activity_amout: 0,
              activity_traveling_time: activity.activity_duration,
              activity_start_time: activityStart,
              activity_end_time: activityEnd,
              createdby: 1,
              createdon: new Date(),
              status: 1,
              deleted: 0,
            },
          });
        }

        const rebuiltHotspots = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
          where: {
            itinerary_plan_ID: planId,
            itinerary_route_ID: data.routeId,
            item_type: 4,
            deleted: 0,
            status: 1,
          },
          select: {
            route_hotspot_ID: true,
            hotspot_ID: true,
          },
        });

        const rebuiltHotspotIds = new Set(
          rebuiltHotspots.map((h: any) => Number(h.hotspot_ID || 0)),
        );

        const removedHotspots = beforeSnapshot
          .filter((h: any) => beforeHotspotIds.has(Number(h.hotspotId || 0)) && !rebuiltHotspotIds.has(Number(h.hotspotId || 0)))
          .map((h: any) => {
            const meta = hotspotMetaMap.get(Number(h.hotspotId || 0)) || {
              name: `Hotspot ${Number(h.hotspotId || 0)}`,
              priority: 0,
            };
            return {
              id: Number(h.hotspotId || 0),
              routeHotspotId: Number(h.routeHotspotId || 0),
              name: meta.name,
              priority: Number(meta.priority || 0),
            };
          });

        const priorityHotspotsAffected = removedHotspots.filter((h: any) => {
          const p = Number(h.priority || 0);
          return p >= 1 && p <= 3;
        });

        for (const p of localized.topPriorityAffected || []) {
          if (!priorityHotspotsAffected.some((x: any) => Number(x.id) === Number(p.id))) {
            priorityHotspotsAffected.push(p);
          }
        }

        const rebuiltTimelinePreview = await this.buildRoutePreviewLikeDetailsFromTx(
          tx,
          planId,
          data.routeId,
        );

        const selectedGap = gaps.find((g: any) => Number(g.gapIndex) === selectedGapIndex) || null;
        const selectedGapLabel = selectedGap?.label || `Insert at gap ${selectedGapIndex}`;
        const movedHotspotName =
          hotspotMetaMap.get(Number(movedRow.hotspot_ID || 0))?.name ||
          `Hotspot ${Number(movedRow.hotspot_ID || 0)}`;

        previewResult = {
          ...responseBase,
          success: true,
          gapIndex: selectedGapIndex,
          selectedGapLabel,
          selectedOption: {
            gapIndex: selectedGapIndex,
            fits: timingConflicts.length === 0,
            reason: timingConflicts.length > 0 ? timingConflicts[0].reason : null,
            startTime: activityStart,
            endTime: activityEnd,
            conflicts: timingConflicts,
            removedHotspots,
          },
          insertedPreview: {
            hotspotName: movedHotspotName,
            activityName: String(activity.activity_title || ''),
            activityTimeWindow: `${this.formatTime(activityStart)} - ${this.formatTime(activityEnd)}`,
            placementLabel: selectedGapLabel,
            badge: 'NEW',
          },
          conflicts: {
            hasConflict: priorityHotspotsAffected.length > 0 || timingConflicts.length > 0,
            message:
              priorityHotspotsAffected.length > 0
                ? 'This will remove Priority hotspot'
                : timingConflicts.length > 0
                  ? timingConflicts[0].reason
                  : '',
            priorityHotspotsAffected,
            otherHotspotsAffected: removedHotspots.filter((h: any) => {
              const p = Number(h.priority || 0);
              return !(p >= 1 && p <= 3);
            }),
          },
          rebuiltTimelinePreview,
          requiresConfirmation: priorityHotspotsAffected.length > 0,
          topPriorityAffected: priorityHotspotsAffected,
          requiresRemoval: removedHotspots.length > 0,
        };

        throw previewRollbackError;
      }, { timeout: 60000 });
    } catch (error: any) {
      if (error !== previewRollbackError) {
        throw error;
      }
    }

    return previewResult;
  }

  private async moveHotspotToGapInTx(
    tx: any,
    planId: number,
    routeId: number,
    movingRouteHotspotId: number,
    gapIndex: number,
  ) {
    const hotspots = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        item_type: 4,
        deleted: 0,
        status: 1,
      },
      select: {
        route_hotspot_ID: true,
        hotspot_order: true,
      },
      orderBy: { hotspot_order: 'asc' },
    });

    const movingIndex = hotspots.findIndex(
      (h: any) => Number(h.route_hotspot_ID) === Number(movingRouteHotspotId),
    );
    if (movingIndex < 0) {
      throw new NotFoundException('Hotspot to move not found on route');
    }

    const ordered = [...hotspots];
    const [moving] = ordered.splice(movingIndex, 1);

    let insertionIndex = Math.max(0, Math.min(Number(gapIndex), ordered.length));
    if (movingIndex < insertionIndex) {
      insertionIndex -= 1;
    }

    ordered.splice(insertionIndex, 0, moving);

    for (let i = 0; i < ordered.length; i += 1) {
      await (tx as any).dvi_itinerary_route_hotspot_details.update({
        where: { route_hotspot_ID: Number(ordered[i].route_hotspot_ID) },
        data: {
          hotspot_order: i + 1,
          updatedon: new Date(),
        },
      });
    }
  }

  private async applyAnchoredLocalRebuildInTx(
    tx: any,
    planId: number,
    routeId: number,
    movingRouteHotspotId: number,
  ) {
    const route = await (tx as any).dvi_itinerary_route_details.findFirst({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        deleted: 0,
      },
      select: {
        route_start_time: true,
        route_end_time: true,
      },
    });

    if (!route) {
      throw new NotFoundException('Route not found');
    }

    let hotspots = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        item_type: 4,
        deleted: 0,
        status: 1,
      },
      select: {
        route_hotspot_ID: true,
        hotspot_ID: true,
        hotspot_order: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
      },
      orderBy: { hotspot_order: 'asc' },
    });

    const moved = hotspots.find((h: any) => Number(h.route_hotspot_ID) === Number(movingRouteHotspotId));
    if (!moved) {
      throw new NotFoundException('Moved hotspot not found after reorder');
    }

    const duplicateMoved = hotspots.filter(
      (h: any) =>
        Number(h.hotspot_ID || 0) === Number(moved.hotspot_ID || 0) &&
        Number(h.route_hotspot_ID || 0) !== Number(moved.route_hotspot_ID || 0),
    );

    if (duplicateMoved.length > 0) {
      const dupIds = duplicateMoved.map((d: any) => Number(d.route_hotspot_ID || 0)).filter((id: number) => id > 0);
      await (tx as any).dvi_itinerary_route_activity_details.deleteMany({
        where: {
          itinerary_plan_ID: Number(planId),
          itinerary_route_ID: Number(routeId),
          route_hotspot_ID: { in: dupIds },
          deleted: 0,
        },
      });
      await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
        where: {
          itinerary_plan_ID: Number(planId),
          itinerary_route_ID: Number(routeId),
          route_hotspot_ID: { in: dupIds },
          deleted: 0,
        },
        data: {
          deleted: 1,
          updatedon: new Date(),
        },
      });

      hotspots = hotspots.filter((h: any) => !dupIds.includes(Number(h.route_hotspot_ID || 0)));
    }

    const hotspotIds = hotspots.map((h: any) => Number(h.hotspot_ID || 0)).filter((id: number) => id > 0);
    const hotspotMasters = hotspotIds.length
      ? await (tx as any).dvi_hotspot_place.findMany({
          where: { hotspot_ID: { in: hotspotIds } },
          select: {
            hotspot_ID: true,
            hotspot_duration: true,
            hotspot_priority: true,
            hotspot_name: true,
          },
        })
      : [];
    const hotspotMasterMap = new Map<number, any>(
      hotspotMasters.map((h: any) => [Number(h.hotspot_ID || 0), h]),
    );

    const movedIndex = hotspots.findIndex((h: any) => Number(h.route_hotspot_ID) === Number(movingRouteHotspotId));
    const prev = movedIndex > 0 ? hotspots[movedIndex - 1] : null;
    const anchorStart = prev?.hotspot_end_time || route.route_start_time;
    if (!anchorStart) {
      throw new BadRequestException('Unable to compute anchor start for moved hotspot');
    }

    const movedDuration = this.getHotspotDurationMinutes(hotspotMasterMap.get(Number(moved.hotspot_ID || 0)), moved);
    let cursor = new Date(anchorStart);
    let movedStart = new Date(cursor);
    let movedEnd = this.addMinutesToTime(movedStart, movedDuration);

    await (tx as any).dvi_itinerary_route_hotspot_details.update({
      where: { route_hotspot_ID: Number(moved.route_hotspot_ID) },
      data: {
        hotspot_start_time: movedStart,
        hotspot_end_time: movedEnd,
        updatedon: new Date(),
      },
    });

    cursor = new Date(movedEnd);

    const downstream = hotspots.slice(movedIndex + 1);
    for (const row of downstream) {
      const duration = this.getHotspotDurationMinutes(hotspotMasterMap.get(Number(row.hotspot_ID || 0)), row);
      const nextStart = new Date(cursor);
      const nextEnd = this.addMinutesToTime(nextStart, duration);

      await (tx as any).dvi_itinerary_route_hotspot_details.update({
        where: { route_hotspot_ID: Number(row.route_hotspot_ID) },
        data: {
          hotspot_start_time: nextStart,
          hotspot_end_time: nextEnd,
          updatedon: new Date(),
        },
      });

      cursor = new Date(nextEnd);
    }

    const topPriorityAffected: any[] = [];
    if (route.route_end_time && cursor > route.route_end_time) {
      const reloaded = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_plan_ID: Number(planId),
          itinerary_route_ID: Number(routeId),
          item_type: 4,
          deleted: 0,
          status: 1,
        },
        select: {
          route_hotspot_ID: true,
          hotspot_ID: true,
          hotspot_start_time: true,
          hotspot_end_time: true,
        },
        orderBy: { hotspot_order: 'asc' },
      });

      let endCursor = reloaded.length > 0 ? reloaded[reloaded.length - 1].hotspot_end_time : null;
      while (endCursor && route.route_end_time && endCursor > route.route_end_time) {
        const candidates = reloaded
          .filter((r: any) => Number(r.route_hotspot_ID) !== Number(movingRouteHotspotId))
          .slice()
          .reverse();

        const nonPriority = candidates.find((r: any) => {
          const p = Number(hotspotMasterMap.get(Number(r.hotspot_ID || 0))?.hotspot_priority || 0);
          return !(p >= 1 && p <= 3);
        });

        if (nonPriority) {
          await (tx as any).dvi_itinerary_route_activity_details.deleteMany({
            where: {
              itinerary_plan_ID: Number(planId),
              itinerary_route_ID: Number(routeId),
              route_hotspot_ID: Number(nonPriority.route_hotspot_ID),
              deleted: 0,
            },
          });
          await (tx as any).dvi_itinerary_route_hotspot_details.update({
            where: { route_hotspot_ID: Number(nonPriority.route_hotspot_ID) },
            data: { deleted: 1, updatedon: new Date() },
          });
        } else {
          for (const c of candidates) {
            const p = Number(hotspotMasterMap.get(Number(c.hotspot_ID || 0))?.hotspot_priority || 0);
            if (p >= 1 && p <= 3) {
              topPriorityAffected.push({
                id: Number(c.hotspot_ID || 0),
                routeHotspotId: Number(c.route_hotspot_ID || 0),
                name: String(hotspotMasterMap.get(Number(c.hotspot_ID || 0))?.hotspot_name || 'Hotspot'),
                priority: p,
              });
            }
          }
          break;
        }

        const refreshed = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
          where: {
            itinerary_plan_ID: Number(planId),
            itinerary_route_ID: Number(routeId),
            item_type: 4,
            deleted: 0,
            status: 1,
          },
          select: { hotspot_end_time: true },
          orderBy: { hotspot_order: 'asc' },
        });
        endCursor = refreshed.length > 0 ? refreshed[refreshed.length - 1].hotspot_end_time : null;
      }
    }

    return {
      movedRouteHotspotId: Number(movingRouteHotspotId),
      movedHotspotId: Number(moved.hotspot_ID || 0),
      movedStart,
      movedEnd,
      topPriorityAffected,
    };
  }

  private getHotspotDurationMinutes(master: any, row: any): number {
    const start = row?.hotspot_start_time ? new Date(row.hotspot_start_time) : null;
    const end = row?.hotspot_end_time ? new Date(row.hotspot_end_time) : null;
    if (start && end && end > start) {
      const mins = Math.round((end.getTime() - start.getTime()) / 60000);
      if (mins > 0) return mins;
    }

    const masterDuration = master?.hotspot_duration ? this.timeToMinutes(master.hotspot_duration) : 0;
    if (masterDuration > 0) return masterDuration;

    return 30;
  }

  private async buildRoutePreviewLikeDetailsFromTx(
    tx: any,
    planId: number,
    routeId: number,
  ) {
    const route = await (tx as any).dvi_itinerary_route_details.findFirst({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        deleted: 0,
      },
      select: {
        itinerary_route_ID: true,
        itinerary_route_date: true,
        route_start_time: true,
        route_end_time: true,
        no_of_days: true,
        location_id: true,
        location_name: true,
        next_visiting_location: true,
      },
    });

    if (!route) {
      return { days: [] };
    }

    const location = route.location_id
      ? await (tx as any).dvi_stored_locations.findFirst({
          where: {
            location_ID: Number(route.location_id),
            deleted: 0,
          },
          select: {
            source_location: true,
            destination_location: true,
          },
        })
      : null;

    // Rebuild preview from attraction nodes only; persisted travel rows can be stale after reorder.
    const rows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        item_type: 4,
        deleted: 0,
        status: 1,
      },
      orderBy: { hotspot_order: 'asc' },
    });

    const hotspotIds = Array.from(
      new Set(
        rows
          .map((r: any) => Number(r.hotspot_ID || 0))
          .filter((id: number) => id > 0),
      ),
    );

    const hotspotMasters = hotspotIds.length
      ? await (tx as any).dvi_hotspot_place.findMany({
          where: {
            hotspot_ID: { in: hotspotIds },
            deleted: 0,
          },
          select: {
            hotspot_ID: true,
            hotspot_name: true,
            hotspot_description: true,
            hotspot_duration: true,
            hotspot_video_url: true,
            hotspot_priority: true,
          },
        })
      : [];
    const hotspotMap = new Map<number, any>(hotspotMasters.map((h: any) => [Number(h.hotspot_ID), h]));

    const routeHotspotIds = rows
      .map((r: any) => Number(r.route_hotspot_ID || 0))
      .filter((id: number) => id > 0);

    const activityRows = routeHotspotIds.length
      ? await (tx as any).dvi_itinerary_route_activity_details.findMany({
          where: {
            itinerary_plan_ID: Number(planId),
            itinerary_route_ID: Number(routeId),
            route_hotspot_ID: { in: routeHotspotIds },
            deleted: 0,
            status: 1,
          },
          orderBy: { activity_order: 'asc' },
        })
      : [];

    const activityIds = Array.from(
      new Set(activityRows.map((a: any) => Number(a.activity_ID || 0)).filter((id: number) => id > 0)),
    );
    const activityMasters = activityIds.length
      ? await (tx as any).dvi_activity.findMany({
          where: {
            activity_id: { in: activityIds },
            deleted: 0,
          },
          select: {
            activity_id: true,
            activity_title: true,
            activity_description: true,
          },
        })
      : [];
    const activityMasterMap = new Map<number, any>(activityMasters.map((a: any) => [Number(a.activity_id), a]));

    const activitiesByRouteHotspot = new Map<number, any[]>();
    for (const act of activityRows) {
      const key = Number(act.route_hotspot_ID || 0);
      if (!activitiesByRouteHotspot.has(key)) {
        activitiesByRouteHotspot.set(key, []);
      }
      activitiesByRouteHotspot.get(key)!.push(act);
    }

    const segments: any[] = [];
    const durationLabel = (value: any): string | null => {
      if (!value) return null;
      const str = String(value);
      const match = str.match(/(\d{2}):(\d{2})/);
      if (!match) return str;
      const hh = Number(match[1] || 0);
      const mm = Number(match[2] || 0);
      const parts: string[] = [];
      if (hh > 0) parts.push(`${hh}h`);
      if (mm > 0) parts.push(`${mm}m`);
      return parts.length > 0 ? parts.join(' ') : '0m';
    };
    let previousStopName =
      location?.source_location ||
      route.location_name ||
      '';
    let cursorTime: Date | null = route.route_start_time ? new Date(route.route_start_time) : null;

    const pushTravelSegment = (fromNameRaw: any, toNameRaw: any, start: Date | null, end: Date | null) => {
      const fromName = String(fromNameRaw || '').trim();
      const toName = String(toNameRaw || '').trim();

      // Guard: never emit self-travel or empty endpoints.
      if (!fromName || !toName || fromName.toLowerCase() === toName.toLowerCase()) {
        return;
      }

      let timeRange: string | null = null;
      if (start && end && end.getTime() >= start.getTime()) {
        timeRange = `${this.formatTime(start as any)} - ${this.formatTime(end as any)}`;
      }

      segments.push({
        type: 'travel',
        from: fromName,
        to: toName,
        timeRange,
        distance: null,
        duration: null,
        note: 'This may vary due to traffic conditions',
        isConflict: false,
        conflictReason: null,
      });
    };

    for (const rh of rows) {
      const itemType = Number(rh.item_type || 0);
      const rawStart = rh.hotspot_start_time ? new Date(rh.hotspot_start_time) : null;
      const rawEnd = rh.hotspot_end_time ? new Date(rh.hotspot_end_time) : null;
      const master: any = Number(rh.hotspot_ID || 0) > 0 ? (hotspotMap.get(Number(rh.hotspot_ID || 0)) as any) : null;

      if (itemType === 4 && master) {
        const attractionStart =
          rawStart && cursorTime && rawStart.getTime() < cursorTime.getTime()
            ? new Date(cursorTime)
            : rawStart;
        const attractionEnd =
          rawEnd && attractionStart && rawEnd.getTime() < attractionStart.getTime()
            ? new Date(attractionStart)
            : rawEnd;

        pushTravelSegment(previousStopName, master.hotspot_name, cursorTime, attractionStart);

        const activityList = (activitiesByRouteHotspot.get(Number(rh.route_hotspot_ID || 0)) || []).map(
          (actDetail: any) => {
            const actMaster: any = activityMasterMap.get(Number(actDetail.activity_ID || 0)) as any;
            return {
              id: Number(actDetail.route_activity_ID || 0),
              activityId: Number(actDetail.activity_ID || 0),
              title: actMaster?.activity_title || '',
              description: actMaster?.activity_description || '',
              amount: Number(actDetail.activity_amout || 0),
              startTime: this.formatTime(actDetail.activity_start_time as any),
              endTime: this.formatTime(actDetail.activity_end_time as any),
              duration: durationLabel(actDetail.activity_traveling_time as any),
              image: null,
            };
          },
        );

        segments.push({
          type: 'attraction',
          name: master.hotspot_name,
          description: master.hotspot_description || '',
          visitTime:
            attractionStart && attractionEnd
              ? `${this.formatTime(attractionStart as any)} - ${this.formatTime(attractionEnd as any)}`
              : null,
          duration: durationLabel(master.hotspot_duration as any),
          amount: Number(rh.hotspot_amout || 0) > 0 ? Number(rh.hotspot_amout || 0) : null,
          timings: '',
          image: null,
          videoUrl: master.hotspot_video_url || null,
          planOwnWay: Number(rh.hotspot_plan_own_way || 0) === 1,
          activities: activityList,
          hotspotId: Number(rh.hotspot_ID || 0),
          routeHotspotId: Number(rh.route_hotspot_ID || 0),
          locationId: route.location_id ? Number(route.location_id) : null,
          priority: Number(master.hotspot_priority || 0) || 9999,
          isConflict: Number(rh.is_conflict || 0) === 1,
          conflictReason: rh.conflict_reason || null,
          isManual: Number(rh.hotspot_plan_own_way || 0) === 1,
          isDeleted: Number(rh.deleted || 0) === 1,
        });

        previousStopName = master.hotspot_name || previousStopName;
        cursorTime = attractionEnd || attractionStart || cursorTime;
      }
    }

    pushTravelSegment(
      previousStopName,
      location?.destination_location || route.next_visiting_location || '',
      cursorTime,
      null,
    );

    return {
      days: [
        {
          id: Number(route.itinerary_route_ID || 0),
          dayNumber: Number(route.no_of_days || 1),
          date: route.itinerary_route_date,
          departure:
            location?.source_location ||
            route.location_name ||
            '',
          arrival:
            location?.destination_location ||
            route.next_visiting_location ||
            '',
          startTime: this.formatTime(route.route_start_time as any),
          endTime: this.formatTime(route.route_end_time as any),
          segments,
        },
      ],
    };
  }

  private buildSmartActivityFitPreview(params: {
    route: any;
    routeHotspots: any[];
    gapIndex: number;
    hotspotMetaMap: Map<number, { name: string; priority: number }>;
    activity: any;
    timeSlots: any[];
  }) {
    const { route, routeHotspots, gapIndex, hotspotMetaMap, activity, timeSlots } = params;

    const durationMinutes = activity.activity_duration
      ? this.timeToMinutes(activity.activity_duration)
      : 30;

    const normalizedGapIndex = Math.max(0, Math.min(Number(gapIndex || 0), Math.max(0, routeHotspots.length - 1)));
    const previousHotspot = normalizedGapIndex > 0 ? routeHotspots[normalizedGapIndex - 1] : null;
    const nextHotspot = normalizedGapIndex < routeHotspots.length ? routeHotspots[normalizedGapIndex] : null;

    const startAnchor = previousHotspot?.hotspot_end_time || route.route_start_time || nextHotspot?.hotspot_start_time;
    if (!startAnchor) {
      throw new BadRequestException('Unable to determine insertion start time for selected gap');
    }

    const startTime = new Date(startAnchor);
    const endTime = this.addMinutesToTime(startTime, durationMinutes);
    const conflicts = this.checkActivityTimingConflicts(activity, timeSlots, startTime, endTime);

    let extensionMinutes = 0;
    if (nextHotspot?.hotspot_start_time) {
      extensionMinutes = Math.max(
        0,
        Math.round((endTime.getTime() - new Date(nextHotspot.hotspot_start_time).getTime()) / 60000),
      );
    }

    const downstream = routeHotspots.slice(normalizedGapIndex).map((h: any) => {
      const meta = hotspotMetaMap.get(Number(h.hotspot_ID || 0)) || {
        name: `Hotspot ${Number(h.hotspot_ID || 0)}`,
        priority: 0,
      };
      return {
        routeHotspotId: Number(h.route_hotspot_ID || 0),
        hotspotId: Number(h.hotspot_ID || 0),
        name: meta.name,
        priority: Number(meta.priority || 0),
        shiftedStart:
          extensionMinutes > 0 && h.hotspot_start_time
            ? this.addMinutesToTime(h.hotspot_start_time, extensionMinutes)
            : h.hotspot_start_time,
        shiftedEnd:
          extensionMinutes > 0 && h.hotspot_end_time
            ? this.addMinutesToTime(h.hotspot_end_time, extensionMinutes)
            : h.hotspot_end_time,
      };
    });

    const getProjectedEnd = (rows: any[]) => {
      let maxEnd = endTime;
      for (const row of rows) {
        if (row.shiftedEnd && row.shiftedEnd > maxEnd) {
          maxEnd = row.shiftedEnd;
        }
      }
      return maxEnd;
    };

    const removedHotspots: Array<{ id: number; routeHotspotId: number; name: string; priority: number }> = [];
    let topPriorityAffected: Array<{ id: number; name: string; priority: number; routeHotspotId: number }> = [];

    const remaining = [...downstream];
    while (route.route_end_time && getProjectedEnd(remaining) > route.route_end_time) {
      const idxToRemove = remaining
        .map((r, idx) => ({ idx, priority: Number(r.priority || 0) }))
        .reverse()
        .find((entry) => !(entry.priority >= 1 && entry.priority <= 3));

      if (!idxToRemove) break;

      const removeAt = remaining.length - 1 - idxToRemove.idx;
      const removed = remaining.splice(removeAt, 1)[0];
      removedHotspots.push({
        id: removed.hotspotId,
        routeHotspotId: removed.routeHotspotId,
        name: removed.name,
        priority: removed.priority,
      });
    }

    if (route.route_end_time && getProjectedEnd(remaining) > route.route_end_time) {
      topPriorityAffected = remaining
        .filter((r) => Number(r.priority || 0) >= 1 && Number(r.priority || 0) <= 3)
        .map((r) => ({
          id: r.hotspotId,
          routeHotspotId: r.routeHotspotId,
          name: r.name,
          priority: r.priority,
        }));
    }

    const fullDayPreview = routeHotspots.map((h: any, idx: number) => {
      const meta = hotspotMetaMap.get(Number(h.hotspot_ID || 0)) || {
        name: `Hotspot ${Number(h.hotspot_ID || 0)}`,
        priority: 0,
      };
      const removed = removedHotspots.some((r) => Number(r.routeHotspotId) === Number(h.route_hotspot_ID));
      const shifted = !removed && extensionMinutes > 0 && idx >= normalizedGapIndex;
      return {
        type: 'hotspot',
        hotspotId: Number(h.hotspot_ID || 0),
        routeHotspotId: Number(h.route_hotspot_ID || 0),
        name: meta.name,
        priority: Number(meta.priority || 0),
        startTime: shifted && h.hotspot_start_time ? this.addMinutesToTime(h.hotspot_start_time, extensionMinutes) : h.hotspot_start_time,
        endTime: shifted && h.hotspot_end_time ? this.addMinutesToTime(h.hotspot_end_time, extensionMinutes) : h.hotspot_end_time,
        removed,
        shifted,
      };
    });

    const fits = conflicts.length === 0;

    return {
      gapIndex: normalizedGapIndex,
      fits,
      valid: fits,
      reason: fits ? undefined : conflicts?.[0]?.reason,
      reasonIfInvalid: fits ? null : conflicts?.[0]?.reason || null,
      startTime,
      endTime,
      conflicts,
      removedHotspots,
      topPriorityAffected,
      requiresRemoval: removedHotspots.length > 0 || topPriorityAffected.length > 0,
      fullDayPreview,
    };
  }

  async smartInsertActivity(
    planId: number,
    data: {
      routeId: number;
      activityId: number;
      hotspotId?: number;
      routeHotspotId?: number;
      gapIndex?: number;
      allowTopPriorityRemoval?: boolean;
    },
  ) {
    if (!Number.isInteger(Number(data.gapIndex))) {
      throw new BadRequestException('gapIndex is required for smart insert');
    }

    if (!Number.isInteger(Number(data.routeHotspotId || 0)) && !Number.isInteger(Number(data.hotspotId || 0))) {
      throw new BadRequestException('routeHotspotId or hotspotId is required for smart insert');
    }

    const preview = await this.smartPreviewActivity(planId, {
      routeId: data.routeId,
      activityId: data.activityId,
      routeHotspotId: data.routeHotspotId,
      hotspotId: data.hotspotId,
      gapIndex: Number(data.gapIndex),
      mode: 'applyPreview',
    });

    const topPriorityAffected = Array.isArray(preview?.topPriorityAffected)
      ? preview.topPriorityAffected
      : [];

    if (topPriorityAffected.length > 0 && !data.allowTopPriorityRemoval) {
      throw new BadRequestException({
        message: 'Top priority hotspots would be removed. Confirmation required.',
        topPriorityAffected,
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const userId = 1;
      const activity = await (tx as any).dvi_activity.findUnique({
        where: { activity_id: data.activityId },
        select: {
          activity_duration: true,
        },
      });

      if (!activity) {
        throw new NotFoundException('Activity not found');
      }

      const originalHotspots = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_plan_ID: planId,
          itinerary_route_ID: data.routeId,
          item_type: 4,
          deleted: 0,
          status: 1,
        },
        select: {
          route_hotspot_ID: true,
          hotspot_ID: true,
          hotspot_order: true,
        },
        orderBy: { hotspot_order: 'asc' },
      });

      const moving =
        originalHotspots.find((h: any) => Number(h.route_hotspot_ID) === Number(data.routeHotspotId || 0)) ||
        originalHotspots.find((h: any) => Number(h.hotspot_ID) === Number(data.hotspotId || 0));

      if (!moving) {
        throw new NotFoundException('Selected hotspot to move was not found on this route');
      }

      const beforeHotspotIds = new Set(originalHotspots.map((h: any) => Number(h.hotspot_ID || 0)));

      await this.moveHotspotToGapInTx(
        tx,
        planId,
        data.routeId,
        Number(moving.route_hotspot_ID),
        Number(data.gapIndex),
      );

      const localized = await this.applyAnchoredLocalRebuildInTx(
        tx,
        planId,
        data.routeId,
        Number(moving.route_hotspot_ID),
      );

      const movedRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_plan_ID: planId,
          itinerary_route_ID: data.routeId,
          hotspot_ID: Number(moving.hotspot_ID),
          item_type: 4,
          deleted: 0,
          status: 1,
        },
        select: {
          route_hotspot_ID: true,
          hotspot_ID: true,
          hotspot_start_time: true,
          hotspot_order: true,
        },
        orderBy: { hotspot_order: 'asc' },
      });

      const expectedOrder = Number(data.gapIndex) + 1;
      const movedRow = movedRows.length > 0
        ? [...movedRows].sort((a: any, b: any) => {
            const da = Math.abs(Number(a.hotspot_order || 0) - expectedOrder);
            const db = Math.abs(Number(b.hotspot_order || 0) - expectedOrder);
            return da - db;
          })[0]
        : null;

      if (!movedRow) {
        throw new BadRequestException({
          success: false,
          code: 'MOVED_HOTSPOT_CANNOT_BE_FORCED',
          message: 'The selected hotspot could not be kept at this position even after removing other movable hotspots.',
          conflicts: {
            priorityHotspotsAffected: localized.topPriorityAffected || topPriorityAffected,
            otherHotspotsAffected: [],
          },
        });
      }

      const durationMinutes = activity.activity_duration
        ? this.timeToMinutes(activity.activity_duration)
        : 30;
      const activityStart = movedRow.hotspot_start_time;
      const activityEnd = this.addMinutesToTime(activityStart, durationMinutes);

      const maxOrder = await (tx as any).dvi_itinerary_route_activity_details.findFirst({
        where: {
          itinerary_plan_ID: planId,
          itinerary_route_ID: data.routeId,
          route_hotspot_ID: Number(movedRow.route_hotspot_ID),
          deleted: 0,
        },
        select: { activity_order: true },
        orderBy: { activity_order: 'desc' },
      });

      const existingActivity = await (tx as any).dvi_itinerary_route_activity_details.findFirst({
        where: {
          itinerary_plan_ID: planId,
          itinerary_route_ID: data.routeId,
          route_hotspot_ID: Number(movedRow.route_hotspot_ID),
          hotspot_ID: Number(movedRow.hotspot_ID),
          activity_ID: Number(data.activityId),
          deleted: 0,
          status: 1,
        },
        select: { route_activity_ID: true },
      });

      if (!existingActivity) {
        await (tx as any).dvi_itinerary_route_activity_details.create({
          data: {
            itinerary_plan_ID: planId,
            itinerary_route_ID: data.routeId,
            route_hotspot_ID: Number(movedRow.route_hotspot_ID),
            hotspot_ID: Number(movedRow.hotspot_ID),
            activity_ID: Number(data.activityId),
            activity_order: Number(maxOrder?.activity_order || 0) + 1,
            activity_amout: 0,
            activity_traveling_time: activity.activity_duration,
            activity_start_time: activityStart,
            activity_end_time: activityEnd,
            createdby: userId,
            createdon: new Date(),
            status: 1,
            deleted: 0,
          },
        });
      }

      const rebuiltHotspots = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_plan_ID: planId,
          itinerary_route_ID: data.routeId,
          item_type: 4,
          deleted: 0,
          status: 1,
        },
        select: {
          route_hotspot_ID: true,
          hotspot_ID: true,
        },
      });

      const afterHotspotIds = new Set(rebuiltHotspots.map((h: any) => Number(h.hotspot_ID || 0)));
      const removedHotspotIds = [...beforeHotspotIds].filter((id: number) => !afterHotspotIds.has(id));

      return {
        success: true,
        insertedActivity: {
          activityId: Number(data.activityId),
          routeHotspotId: Number(movedRow.route_hotspot_ID),
          hotspotId: Number(movedRow.hotspot_ID),
          gapIndex: Number(data.gapIndex),
          startTime: activityStart,
          endTime: activityEnd,
        },
        removedHotspots: removedHotspotIds,
        topPriorityRemoved: topPriorityAffected,
      };
    }, { timeout: 180000 });
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
  * - already added hotspots => exclude from addable list for this route/day
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
      if (alreadyAddedIds.has(id)) return; // Do not offer duplicate add for same day/route
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
      visitAgain: false,
    }));
  }

  // Backward-compatible wrapper: anchor payload is accepted for older callers.
  async getAvailableHotspotsForAnchor(data: {
    planId: number;
    routeId: number;
    anchorType: 'after_travel';
    anchorIndex: number;
  }) {
    return this.getAvailableHotspots(Number(data.routeId));
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
      rebuildSummary: result.rebuildSummary,
      warnings: result.warnings,
    };
  }

  /**
   * Preview adding a hotspot to an itinerary route
   */
  async previewAddHotspot(data: { planId: number; routeId: number; hotspotId: number }) {
    return this.previewManualHotspot(data.planId, data.routeId, data.hotspotId);
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

  // Backward-compatible wrapper for legacy select-slab endpoint.
  async selectVehicleSlab(data: {
    planId: number;
    vehicleTypeId: number;
    vendorEligibleId?: number;
    timeLimitId?: number;
  }) {
    if (!data?.vendorEligibleId) {
      throw new BadRequestException(
        'vendorEligibleId is required. Current service supports vendor selection flow only.',
      );
    }

    return this.selectVehicleVendor({
      planId: Number(data.planId),
      vehicleTypeId: Number(data.vehicleTypeId),
      vendorEligibleId: Number(data.vendorEligibleId),
    });
  }

  // Backward-compatible wrapper for legacy auto-select endpoint.
  async autoSelectVehicleSlabs(data: {
    planId: number;
    vehicleTypeId?: number;
  }) {
    return {
      success: false,
      message:
        'Auto slab selection is not implemented in current service. Use vehicles/select-vendor for manual selection.',
      planId: Number(data?.planId || 0),
      vehicleTypeId: Number(data?.vehicleTypeId || 0) || undefined,
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

      const hotelLevelResults = this.normalizeToArray(prebookResponse?.HotelResult);

      const roomPromotions = this.normalizeToUniqueStrings([
        ...rawRoomDetails.flatMap((room: any) => this.normalizeToArray(room?.RoomPromotion ?? room?.RoomPromotions)),
        ...hotelLevelResults.flatMap((hotelResult: any) =>
          this.normalizeToArray(hotelResult?.RoomPromotion ?? hotelResult?.RoomPromotions),
        ),
      ]);
      const rateConditions = this.normalizeToUniqueStrings([
        ...rawRoomDetails.flatMap((room: any) =>
          this.normalizeToArray(room?.RateConditions ?? room?.rateConditions ?? room?.RateCondition),
        ),
        ...hotelLevelResults.flatMap((hotelResult: any) =>
          this.normalizeToArray(
            hotelResult?.RateConditions ??
              hotelResult?.rateConditions ??
              hotelResult?.RateCondition ??
              hotelResult?.rateCondition,
          ),
        ),
      ]);
      const cancellationPolicies = this.normalizeToUniqueStrings([
        ...rawRoomDetails.flatMap((room: any) =>
          this.normalizeToArray(room?.CancelPolicies ?? room?.CancellationPolicy),
        ),
        ...hotelLevelResults.flatMap((hotelResult: any) =>
          this.normalizeToArray(hotelResult?.CancelPolicies ?? hotelResult?.CancellationPolicy),
        ),
      ]);
      const inclusions = this.normalizeToUniqueStrings([
        ...rawRoomDetails.flatMap((room: any) =>
          this.normalizeToArray(room?.Inclusion ?? room?.Inclusions ?? room?.inclusion ?? room?.inclusions),
        ),
        ...hotelLevelResults.flatMap((hotelResult: any) =>
          this.normalizeToArray(
            hotelResult?.Inclusion ??
              hotelResult?.Inclusions ??
              hotelResult?.inclusion ??
              hotelResult?.inclusions,
          ),
        ),
      ]);
      const amenities = this.normalizeToUniqueStrings([
        ...rawRoomDetails.flatMap((room: any) =>
          this.normalizeToArray(room?.Amenities ?? room?.amenities ?? room?.Amenity),
        ),
        ...hotelLevelResults.flatMap((hotelResult: any) =>
          this.normalizeToArray(
            hotelResult?.Amenities ?? hotelResult?.amenities ?? hotelResult?.Amenity ?? hotelResult?.facilities,
          ),
        ),
      ]);

      const mealTypeCandidates = this.normalizeToUniqueStrings([
        ...rawRoomDetails.flatMap((room: any) =>
          this.normalizeToArray(
            room?.MealTypeName ??
              room?.MealType ??
              room?.mealTypeName ??
              room?.mealType ??
              room?.BoardBasis ??
              room?.boardBasis,
          ),
        ),
        ...hotelLevelResults.flatMap((hotelResult: any) =>
          this.normalizeToArray(
            hotelResult?.MealTypeName ??
              hotelResult?.MealType ??
              hotelResult?.mealTypeName ??
              hotelResult?.mealType ??
              hotelResult?.BoardBasis ??
              hotelResult?.boardBasis,
          ),
        ),
      ]);
      const mealType = mealTypeCandidates[0] || this.inferMealPlanFromInclusions(inclusions) || null;

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
        amenities,
        mealType,
        mealPlan: mealType,
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
    const amenitiesAll = prebookResults.flatMap((item) => item.amenities || []);
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
      inclusions: this.normalizeToUniqueStrings(inclusionsAll),
      amenities: this.normalizeToUniqueStrings(amenitiesAll),
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
  async previewManualHotspot(
    planId: number,
    routeId: number,
    hotspotId: number,
    anchor?: {
      anchorType?: 'after_travel';
      anchorIndex?: number;
      allowTopPriorityRemoval?: boolean;
      selectedHotspotIds?: number[];
    },
  ) {
    const previewRollbackError = new Error('__PREVIEW_MANUAL_HOTSPOT_ROLLBACK__');
    let previewResult: any;

    try {
      await this.prisma.$transaction(async (tx) => {
        const normalizedPlanId = Number(planId);
        const normalizedRouteId = Number(routeId);
        const normalizedHotspotId = Number(hotspotId);

        const route = await (tx as any).dvi_itinerary_route_details.findFirst({
          where: {
            itinerary_route_ID: normalizedRouteId,
            itinerary_plan_ID: normalizedPlanId,
            deleted: 0,
          },
        });

        if (!route) {
          throw new NotFoundException('Route not found for this itinerary plan');
        }

        const hotspotMaster = await (tx as any).dvi_hotspot_place.findFirst({
          where: {
            hotspot_ID: normalizedHotspotId,
            deleted: 0,
          },
          select: {
            hotspot_ID: true,
            hotspot_name: true,
          },
        });

        if (!hotspotMaster) {
          throw new BadRequestException('Hotspot not found or inactive');
        }

        const selectedHotspotIds = Array.from(
          new Set(
            [normalizedHotspotId, ...((anchor?.selectedHotspotIds || []) as number[])]
              .map((id: any) => Number(id))
              .filter((id: number) => Number.isFinite(id) && id > 0),
          ),
        );

        for (const selectedId of selectedHotspotIds) {
          await this.removeRouteHotspotFromExcludedList(tx, normalizedRouteId, selectedId, route);
          await this.ensureManualHotspotRow(tx, normalizedPlanId, normalizedRouteId, selectedId, 1);
        }

        const adaptive = await this.runAdaptiveManualHotspotInsertion(
          tx,
          normalizedPlanId,
          normalizedRouteId,
          normalizedHotspotId,
          anchor,
          {
            allowTopPriorityRemoval: anchor?.allowTopPriorityRemoval === true,
          },
        );

        console.log('[ManualHotspot][previewManualHotspot] adaptive result', {
          planId: normalizedPlanId,
          routeId: normalizedRouteId,
          hotspotId: normalizedHotspotId,
          adaptiveScheduled: adaptive.scheduled,
          removedHotspotsCount: adaptive.removedHotspots.length,
        });

        console.log('[ManualHotspot][previewManualHotspot] calling previewManualHotspotAdd', {
          branch: adaptive.scheduled ? 'success' : 'fallback',
          stillUnschedulable: !adaptive.scheduled,
        });

        const enginePreview = await this.hotspotEngine.previewManualHotspotAdd(
          tx,
          normalizedPlanId,
          normalizedRouteId,
          normalizedHotspotId,
          {
            droppedItems: adaptive.removedHotspots.map((h) => ({
              itineraryRouteId: normalizedRouteId,
              hotspotId: h.id,
              routeHotspotId: 0,
              name: h.name,
              hotspotOrder: 0,
              priority: h.priority,
              reason: 'Removed lower-priority hotspot to fit fixed manual hotspot',
            })),
            resolution: {
              removedHotspots: adaptive.removedHotspots,
              removedCount: adaptive.removedHotspots.length,
              stillUnschedulable: !adaptive.scheduled,
            },
            requestedAnchor:
              anchor?.anchorType === 'after_travel' && Number.isInteger(Number(anchor?.anchorIndex))
                ? {
                    anchorType: 'after_travel' as const,
                    anchorIndex: Number(anchor?.anchorIndex),
                  }
                : undefined,
          },
        );

        previewResult = {
          ...enginePreview,
          success: true,
          planId: normalizedPlanId,
          routeId: normalizedRouteId,
          hotspotId: normalizedHotspotId,
          selectedIncluded: adaptive.scheduled,
          resolution: {
            removedHotspots: adaptive.removedHotspots,
            removedCount: adaptive.removedHotspots.length,
            stillUnschedulable: !adaptive.scheduled,
            requiresConfirmation: adaptive.requiresConfirmation,
            topPriorityAffected: adaptive.topPriorityAffected,
            reason: adaptive.scheduled
              ? (adaptive.removedHotspots.length > 0
                  ? 'Removed lower-priority hotspots due to timing constraints'
                  : null)
              : (adaptive.requiresConfirmation
                  ? 'Top-priority hotspots would need to be replaced. Confirmation required.'
                  : 'Even after removing lower-priority hotspots, this cannot fit in the day.'),
          },
        };

        // Always rollback preview transaction so temporary inserts never persist.
        throw previewRollbackError;
      }, { timeout: 60000 });
    } catch (error: any) {
      if (error !== previewRollbackError) {
        throw error;
      }
    }

    return previewResult;
  }

  /**
   * Add a manual hotspot to a route and rebuild the timeline.
   */
  async addManualHotspot(
    planId: number,
    routeId: number,
    hotspotId: number,
    userId: number,
    anchor?: {
      anchorType?: 'after_travel';
      anchorIndex?: number;
      allowTopPriorityRemoval?: boolean;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const normalizedPlanId = Number(planId);
      const normalizedRouteId = Number(routeId);
      const normalizedHotspotId = Number(hotspotId);

      // Validate target route belongs to this plan.
      const route = await (tx as any).dvi_itinerary_route_details.findFirst({
        where: {
          itinerary_route_ID: normalizedRouteId,
          itinerary_plan_ID: normalizedPlanId,
          deleted: 0,
        },
      });

      if (!route) {
        throw new NotFoundException('Route not found for this itinerary plan');
      }

      const hotspotMaster = await (tx as any).dvi_hotspot_place.findFirst({
        where: {
          hotspot_ID: normalizedHotspotId,
          deleted: 0,
        },
        select: {
          hotspot_ID: true,
          hotspot_name: true,
        },
      });

      if (!hotspotMaster) {
        throw new BadRequestException('Hotspot not found or inactive');
      }

      await this.removeRouteHotspotFromExcludedList(tx, normalizedRouteId, normalizedHotspotId, route);

      const prepared = await this.ensureManualHotspotRow(
        tx,
        normalizedPlanId,
        normalizedRouteId,
        normalizedHotspotId,
        Number(userId || 1),
      );

      const adaptive = await this.runAdaptiveManualHotspotInsertion(
        tx,
        normalizedPlanId,
        normalizedRouteId,
        normalizedHotspotId,
        anchor,
        {
          allowTopPriorityRemoval: anchor?.allowTopPriorityRemoval === true,
        },
      );

      console.log('[ManualHotspot][addManualHotspot] adaptive result', {
        planId: normalizedPlanId,
        routeId: normalizedRouteId,
        hotspotId: normalizedHotspotId,
        adaptiveScheduled: adaptive.scheduled,
        removedHotspotsCount: adaptive.removedHotspots.length,
      });

      if (!adaptive.scheduled) {
        return {
          success: false,
          inserted: false,
          code: adaptive.requiresConfirmation
            ? 'MANUAL_HOTSPOT_CONFIRM_PRIORITY_REPLACEMENT'
            : 'MANUAL_HOTSPOT_CANNOT_FIT',
          message: adaptive.requiresConfirmation
            ? 'Top priority hotspots would need to be replaced. Confirmation required.'
            : 'Hotspot cannot be scheduled within valid operating hours for this day after removing eligible lower-priority hotspots (priority > 3). Priorities 1-3 are preserved.',
          resolution: {
            removedHotspots: adaptive.removedHotspots,
            removedCount: adaptive.removedHotspots.length,
            stillUnschedulable: true,
            requiresConfirmation: adaptive.requiresConfirmation,
            topPriorityAffected: adaptive.topPriorityAffected,
            reason: adaptive.requiresConfirmation
              ? 'top_priority_replacement_required'
              : 'outside_operating_hours_or_no_more_removable_priority_gt_3',
          },
        };
      }

      let insertedHotspot: any = null;
      let routeTimeline: any[] | undefined = undefined;

      if (adaptive.scheduled) {
        console.log('[ManualHotspot][addManualHotspot] resolved success branch hit', {
          planId: normalizedPlanId,
          routeId: normalizedRouteId,
          hotspotId: normalizedHotspotId,
        });

        const resolvedSnapshot = await this.hotspotEngine.previewManualHotspotAdd(
          tx,
          normalizedPlanId,
          normalizedRouteId,
          normalizedHotspotId,
          {
            droppedItems: adaptive.removedHotspots.map((h) => ({
              itineraryRouteId: normalizedRouteId,
              hotspotId: h.id,
              routeHotspotId: 0,
              name: h.name,
              hotspotOrder: 0,
              priority: h.priority,
              reason: 'Removed lower-priority hotspot to fit fixed manual hotspot',
            })),
            resolution: {
              removedHotspots: adaptive.removedHotspots,
              removedCount: adaptive.removedHotspots.length,
              stillUnschedulable: false,
            },
            requestedAnchor:
              anchor?.anchorType === 'after_travel' && Number.isInteger(Number(anchor?.anchorIndex))
                ? {
                    anchorType: 'after_travel' as const,
                    anchorIndex: Number(anchor?.anchorIndex),
                  }
                : undefined,
          },
        );

        const snapped = resolvedSnapshot?.newHotspot || null;

        // Enforce proper extraction: if adaptive succeeded but snapped is missing, fail fast
        if (adaptive.scheduled && !snapped) {
          throw new Error(
            `Adaptive insertion succeeded (adaptive.scheduled=true) but newHotspot is missing from resolved snapshot. ` +
            `Indicates a bug in the rebuild process.`
          );
        }

        routeTimeline = Array.isArray(resolvedSnapshot?.fullTimeline)
          ? resolvedSnapshot.fullTimeline
          : undefined;

        console.log('[ManualHotspot][addManualHotspot] resolved snapshot', {
          planId: normalizedPlanId,
          routeId: normalizedRouteId,
          hotspotId: normalizedHotspotId,
          selectedHotspotFound: !!snapped,
          routeTimelineCount: Array.isArray(routeTimeline) ? routeTimeline.length : 0,
        });

        if (!snapped) {
          console.error('[ManualHotspot][addManualHotspot] resolved branch failed: selected hotspot missing from rebuilt snapshot', {
            planId: normalizedPlanId,
            routeId: normalizedRouteId,
            hotspotId: normalizedHotspotId,
          });
          throw new Error('Adaptive insertion succeeded but rebuilt resolved snapshot does not contain selected hotspot');
        }

        if (snapped) {
          const startRaw = (snapped as any).hotspot_start_time
            ? new Date((snapped as any).hotspot_start_time)
            : null;
          const endRaw = (snapped as any).hotspot_end_time
            ? new Date((snapped as any).hotspot_end_time)
            : null;

          insertedHotspot = {
            hotspotId: normalizedHotspotId,
            name: String((snapped as any).text || hotspotMaster.hotspot_name || ''),
            visitTime:
              String((snapped as any).timeRange || '').trim() ||
              (startRaw && endRaw
                ? `${this.formatTime(startRaw)} - ${this.formatTime(endRaw)}`
                : null),
            startTime: startRaw ? this.formatTime(startRaw) : null,
            endTime: endRaw ? this.formatTime(endRaw) : null,
            isConflict: Boolean((snapped as any).isConflict),
          };
        }
      }

      if (!insertedHotspot) {
        console.log('[ManualHotspot][addManualHotspot] fallback insertedHotspot hydration from persisted row', {
          planId: normalizedPlanId,
          routeId: normalizedRouteId,
          hotspotId: normalizedHotspotId,
          adaptiveScheduled: adaptive.scheduled,
        });

        const persisted = await (tx as any).dvi_itinerary_route_hotspot_details.findFirst({
          where: {
            itinerary_plan_ID: normalizedPlanId,
            itinerary_route_ID: normalizedRouteId,
            hotspot_ID: normalizedHotspotId,
            item_type: 4,
            deleted: 0,
          },
          orderBy: [
            { hotspot_order: 'asc' },
            { route_hotspot_ID: 'desc' },
          ],
          select: {
            hotspot_start_time: true,
            hotspot_end_time: true,
            is_conflict: true,
          },
        });

        const startRaw = persisted?.hotspot_start_time ? new Date(persisted.hotspot_start_time) : null;
        const endRaw = persisted?.hotspot_end_time ? new Date(persisted.hotspot_end_time) : null;

        insertedHotspot = {
          hotspotId: normalizedHotspotId,
          name: hotspotMaster.hotspot_name,
          visitTime:
            startRaw && endRaw
              ? `${this.formatTime(startRaw)} - ${this.formatTime(endRaw)}`
              : null,
          startTime: startRaw ? this.formatTime(startRaw) : null,
          endTime: endRaw ? this.formatTime(endRaw) : null,
          isConflict: Number(persisted?.is_conflict || 0) === 1,
        };
      }

      return {
        success: true,
        inserted: true,
        hotspotId: normalizedHotspotId,
        routeId: normalizedRouteId,
        planId: normalizedPlanId,
        message: 'Hotspot added successfully',
        resolution: {
          timingAdjusted: adaptive.removedHotspots.length > 0,
          removedHotspots: adaptive.removedHotspots,
          removedCount: adaptive.removedHotspots.length,
          reason: adaptive.removedHotspots.length > 0
            ? 'Removed lower-priority hotspots due to timing constraints'
            : null,
        },
        hotspotName: hotspotMaster.hotspot_name,
        alreadyExisted: prepared.alreadyExisted,
        insertedHotspot,
        routeTimeline,
      };
    }, { timeout: 30000 });
  }

  private normalizeHotspotPriority(value: any): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return 9999;
    return n;
  }

  private async removeRouteHotspotFromExcludedList(
    tx: any,
    routeId: number,
    hotspotId: number,
    routeRow?: any,
  ) {
    const route = routeRow || await (tx as any).dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: Number(routeId) },
    });

    const rawExcluded = Array.isArray(route?.excluded_hotspot_ids) ? route.excluded_hotspot_ids : [];
    const filteredExcluded = rawExcluded
      .map((id: any) => Number(id))
      .filter((id: number) => Number.isFinite(id) && id > 0 && id !== Number(hotspotId));

    if (filteredExcluded.length !== rawExcluded.length) {
      await (tx as any).dvi_itinerary_route_details.update({
        where: { itinerary_route_ID: Number(routeId) },
        data: {
          excluded_hotspot_ids: filteredExcluded,
          updatedon: new Date(),
        },
      });
    }
  }

  private async addRouteHotspotToExcludedList(tx: any, routeId: number, hotspotId: number) {
    const route = await (tx as any).dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: Number(routeId) },
    });

    const current = Array.isArray(route?.excluded_hotspot_ids)
      ? route.excluded_hotspot_ids.map((id: any) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0)
      : [];

    if (!current.includes(Number(hotspotId))) {
      current.push(Number(hotspotId));
      await (tx as any).dvi_itinerary_route_details.update({
        where: { itinerary_route_ID: Number(routeId) },
        data: {
          excluded_hotspot_ids: current,
          updatedon: new Date(),
        },
      });
    }
  }

  private async ensureManualHotspotRow(
    tx: any,
    planId: number,
    routeId: number,
    hotspotId: number,
    userId: number,
  ): Promise<{ alreadyExisted: boolean }> {
    const existingActive = await (tx as any).dvi_itinerary_route_hotspot_details.findFirst({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        hotspot_ID: Number(hotspotId),
        item_type: 4,
        deleted: 0,
      },
      select: {
        route_hotspot_ID: true,
        hotspot_plan_own_way: true,
      },
    });

    if (existingActive) {
      if (Number(existingActive.hotspot_plan_own_way || 0) !== 1) {
        await (tx as any).dvi_itinerary_route_hotspot_details.update({
          where: { route_hotspot_ID: Number(existingActive.route_hotspot_ID) },
          data: {
            hotspot_plan_own_way: 1,
            updatedon: new Date(),
          },
        });
      }
      return { alreadyExisted: true };
    }

    const placeholderTime = new Date('1970-01-01T00:00:00Z');
    await (tx as any).dvi_itinerary_route_hotspot_details.create({
      data: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        hotspot_ID: Number(hotspotId),
        hotspot_plan_own_way: 1,
        item_type: 4,
        hotspot_order: 999,
        hotspot_start_time: placeholderTime,
        hotspot_end_time: placeholderTime,
        createdby: Number(userId || 1),
        createdon: new Date(),
        status: 1,
        deleted: 0,
      },
    });

    return { alreadyExisted: false };
  }

  private async isManualHotspotScheduled(
    tx: any,
    planId: number,
    routeId: number,
    hotspotId: number,
  ): Promise<boolean> {
    const rows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        hotspot_ID: Number(hotspotId),
        item_type: 4,
        hotspot_plan_own_way: 1,
        deleted: 0,
      },
      select: {
        route_hotspot_ID: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
        is_conflict: true,
      },
    });

    if (!Array.isArray(rows) || rows.length === 0) {
      return false;
    }

    const route = await (tx as any).dvi_itinerary_route_details.findFirst({
      where: {
        itinerary_route_ID: Number(routeId),
        itinerary_plan_ID: Number(planId),
        deleted: 0,
      },
      select: { itinerary_route_date: true },
    });

    // If route date is unavailable, keep legacy behavior to avoid false negatives.
    if (!route?.itinerary_route_date) {
      return true;
    }

    const timingDay = (new Date(route.itinerary_route_date).getDay() + 6) % 7; // Mon=0..Sun=6
    const timings = await (tx as any).dvi_hotspot_timing.findMany({
      where: {
        hotspot_ID: Number(hotspotId),
        hotspot_timing_day: Number(timingDay),
        deleted: 0,
        status: 1,
      },
      select: {
        hotspot_open_all_time: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
      },
    });

    // No timing definition: preserve previous permissive behavior.
    if (!Array.isArray(timings) || timings.length === 0) {
      return true;
    }

    if (timings.some((t: any) => Number(t?.hotspot_open_all_time || 0) === 1)) {
      const nonConflictRows = rows.filter((row: any) => Number(row?.is_conflict || 0) !== 1);
      return this.hasAnyNonOverlappingManualRow(tx, Number(planId), Number(routeId), nonConflictRows);
    }

    let hasValidRow = false;
    for (const row of rows) {
      // Conflict rows are never considered scheduled.
      if (Number(row?.is_conflict || 0) === 1) continue;

      const startSec = this.hmsToSeconds(TimeConverter.toTimeString(row?.hotspot_start_time));
      const endSec = this.hmsToSeconds(TimeConverter.toTimeString(row?.hotspot_end_time));

      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec < startSec) {
        continue;
      }

      const fitsOperatingHours = timings.some((t: any) => {
        if (!t?.hotspot_start_time || !t?.hotspot_end_time) return false;

        const opStart = this.hmsToSeconds(TimeConverter.toTimeString(t.hotspot_start_time));
        const opEnd = this.hmsToSeconds(TimeConverter.toTimeString(t.hotspot_end_time));

        // Overnight window support (e.g., 18:00 -> 02:00)
        if (opEnd < opStart) {
          const inToday = startSec >= opStart && endSec >= startSec;
          const inOvernight = startSec <= opEnd && endSec <= opEnd;
          return inToday || inOvernight;
        }

        return startSec >= opStart && endSec <= opEnd;
      });

      if (!fitsOperatingHours) {
        continue;
      }

      if (await this.manualRowHasNoOverlap(tx, Number(planId), Number(routeId), row)) {
        hasValidRow = true;
        break;
      }
    }

    return hasValidRow;
  }

  private hmsToSeconds(value: string): number {
    const [h, m, s] = String(value || '00:00:00').split(':').map((p) => Number(p || 0));
    const hh = Number.isFinite(h) ? h : 0;
    const mm = Number.isFinite(m) ? m : 0;
    const ss = Number.isFinite(s) ? s : 0;
    return (hh * 3600) + (mm * 60) + ss;
  }

  private async hasAnyNonOverlappingManualRow(
    tx: any,
    planId: number,
    routeId: number,
    rows: any[],
  ): Promise<boolean> {
    for (const row of rows) {
      const ok = await this.manualRowHasNoOverlap(tx, planId, routeId, row);
      if (ok) return true;
    }
    return false;
  }

  private async manualRowHasNoOverlap(
    tx: any,
    planId: number,
    routeId: number,
    row: any,
  ): Promise<boolean> {
    const startSec = this.hmsToSeconds(TimeConverter.toTimeString(row?.hotspot_start_time));
    const endSec = this.hmsToSeconds(TimeConverter.toTimeString(row?.hotspot_end_time));

    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
      return false;
    }

    const otherRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        item_type: 4,
        deleted: 0,
        route_hotspot_ID: { not: Number(row?.route_hotspot_ID || 0) },
      },
      select: {
        hotspot_start_time: true,
        hotspot_end_time: true,
        is_conflict: true,
      },
    });

    return !(otherRows || []).some((other: any) => {
      if (Number(other?.is_conflict || 0) === 1) return false;

      const otherStart = this.hmsToSeconds(TimeConverter.toTimeString(other?.hotspot_start_time));
      const otherEnd = this.hmsToSeconds(TimeConverter.toTimeString(other?.hotspot_end_time));

      if (!Number.isFinite(otherStart) || !Number.isFinite(otherEnd) || otherEnd <= otherStart) {
        return false;
      }

      return startSec < otherEnd && endSec > otherStart;
    });
  }

  private async runAdaptiveManualHotspotInsertion(
    tx: any,
    planId: number,
    routeId: number,
    hotspotId: number,
    anchor?: {
      anchorType?: 'after_travel';
      anchorIndex?: number;
    },
    options?: {
      allowTopPriorityRemoval?: boolean;
    },
  ): Promise<{
    scheduled: boolean;
    removedHotspots: Array<{ id: number; name: string; priority: number }>;
    requiresConfirmation: boolean;
    topPriorityAffected: Array<{ id: number; name: string; priority: number }>;
  }> {
    const removedHotspots: Array<{ id: number; name: string; priority: number }> = [];
    const topPriorityAffected: Array<{ id: number; name: string; priority: number }> = [];
    const allowTopPriorityRemoval = options?.allowTopPriorityRemoval === true;

    const preferredOrder =
      anchor?.anchorType === 'after_travel' && Number.isInteger(Number(anchor?.anchorIndex))
        ? Number(anchor?.anchorIndex) + 1
        : null;

    await this.hotspotEngine.rebuildRouteHotspots(tx, Number(planId), undefined, {
      protectedHotspotIds: [Number(hotspotId)],
      anchorOrderByRoute: preferredOrder !== null
        ? { [Number(routeId)]: Number(preferredOrder) }
        : undefined,
    });
    let scheduled = await this.isManualHotspotScheduled(tx, Number(planId), Number(routeId), Number(hotspotId));
    if (scheduled) {
      return { scheduled, removedHotspots, requiresConfirmation: false, topPriorityAffected };
    }

    const routeRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        item_type: 4,
        deleted: 0,
      },
      select: {
        route_hotspot_ID: true,
        hotspot_ID: true,
        hotspot_plan_own_way: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
        hotspot_order: true,
      },
    });

    const hotspotIds = routeRows
      .map((row: any) => Number(row.hotspot_ID || 0))
      .filter((id: number) => Number.isFinite(id) && id > 0);

    const hotspotMasters = hotspotIds.length > 0
      ? await (tx as any).dvi_hotspot_place.findMany({
          where: { hotspot_ID: { in: hotspotIds } },
          select: {
            hotspot_ID: true,
            hotspot_name: true,
            hotspot_priority: true,
          },
        })
      : [];

    const masterMap = new Map<number, any>(
      hotspotMasters.map((h: any) => [Number(h.hotspot_ID), h]),
    );

    const removable = routeRows
      .map((row: any) => {
        const hId = Number(row.hotspot_ID || 0);
        const master = masterMap.get(hId);
        const rawPriority = Number(master?.hotspot_priority ?? 0);
        const normalizedPriority = this.normalizeHotspotPriority(rawPriority);
        const isProtectedPriority = normalizedPriority >= 1 && normalizedPriority <= 3;

        return {
          routeHotspotId: Number(row.route_hotspot_ID || 0),
          hotspotId: hId,
          name: String(master?.hotspot_name || `Hotspot #${hId}`),
          rawPriority: Number.isFinite(rawPriority) ? rawPriority : 0,
          priorityForSort: normalizedPriority,
          isProtectedPriority,
          isManual: Number(row.hotspot_plan_own_way || 0) === 1,
          hotspotOrder: Number(row.hotspot_order || 0),
          hotspotStartTime: row.hotspot_start_time || null,
          hotspotEndTime: row.hotspot_end_time || null,
          startTs: row.hotspot_start_time ? new Date(row.hotspot_start_time).getTime() : 0,
        };
      })
      .filter((row: any) => row.routeHotspotId > 0)
      .filter((row: any) => row.hotspotId !== Number(hotspotId))
      .filter((row: any) => !row.isManual)
      .sort((a: any, b: any) => {
        if (a.isProtectedPriority !== b.isProtectedPriority) {
          return a.isProtectedPriority ? 1 : -1;
        }
        if (a.startTs !== b.startTs) {
          return b.startTs - a.startTs;
        }
        if (a.priorityForSort !== b.priorityForSort) {
          return b.priorityForSort - a.priorityForSort;
        }
        return b.routeHotspotId - a.routeHotspotId;
      });

    for (const candidate of removable) {
      if (candidate.isProtectedPriority && !allowTopPriorityRemoval) {
        if (!topPriorityAffected.some((row) => Number(row.id) === Number(candidate.hotspotId))) {
          topPriorityAffected.push({
            id: Number(candidate.hotspotId),
            name: candidate.name,
            priority: Number(candidate.rawPriority || 0),
          });
        }
        continue;
      }

      await (tx as any).dvi_itinerary_route_hotspot_details.deleteMany({
        where: {
          route_hotspot_ID: Number(candidate.routeHotspotId),
          itinerary_plan_ID: Number(planId),
          itinerary_route_ID: Number(routeId),
          deleted: 0,
        },
      });

      await this.addRouteHotspotToExcludedList(tx, Number(routeId), Number(candidate.hotspotId));

      removedHotspots.push({
        id: Number(candidate.hotspotId),
        name: candidate.name,
        priority: Number(candidate.rawPriority || 0),
      });

      await this.hotspotEngine.rebuildRouteHotspots(tx, Number(planId), undefined, {
        protectedHotspotIds: [Number(hotspotId)],
        anchorOrderByRoute: preferredOrder !== null
          ? { [Number(routeId)]: Number(preferredOrder) }
          : undefined,
        preferredManualPlacementByRoute: {
          [Number(routeId)]: {
            hotspotOrder: Number(candidate.hotspotOrder || 0),
            hotspotStartTime: candidate.hotspotStartTime || null,
            hotspotEndTime: candidate.hotspotEndTime || null,
            replacedHotspotId: Number(candidate.hotspotId || 0),
          },
        },
      });
      scheduled = await this.isManualHotspotScheduled(tx, Number(planId), Number(routeId), Number(hotspotId));

      if (scheduled) {
        break;
      }
    }

    return {
      scheduled,
      removedHotspots,
      requiresConfirmation: !scheduled && topPriorityAffected.length > 0 && !allowTopPriorityRemoval,
      topPriorityAffected,
    };
  }

  private async forceInsertManualHotspotConflictRow(
    tx: any,
    planId: number,
    routeId: number,
    hotspotId: number,
    userId: number,
  ): Promise<boolean> {
    const existing = await (tx as any).dvi_itinerary_route_hotspot_details.findFirst({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        hotspot_ID: Number(hotspotId),
        item_type: 4,
        deleted: 0,
      },
      select: { route_hotspot_ID: true },
    });

    if (existing) {
      await (tx as any).dvi_itinerary_route_hotspot_details.update({
        where: { route_hotspot_ID: Number(existing.route_hotspot_ID) },
        data: {
          hotspot_plan_own_way: 1,
          is_conflict: 1,
          conflict_reason: 'Forced manual insertion after user confirmation.',
          updatedon: new Date(),
        },
      });
      return true;
    }

    const route = await (tx as any).dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: Number(routeId) },
      select: {
        route_start_time: true,
        route_end_time: true,
      },
    });

    const fallbackTime = route?.route_end_time || route?.route_start_time || new Date('1970-01-01T00:00:00Z');

    const currentMaxOrderRow = await (tx as any).dvi_itinerary_route_hotspot_details.findFirst({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        deleted: 0,
      },
      orderBy: { hotspot_order: 'desc' },
      select: { hotspot_order: true },
    });
    const nextOrder = Number(currentMaxOrderRow?.hotspot_order || 0) + 1;

    await (tx as any).dvi_itinerary_route_hotspot_details.create({
      data: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        hotspot_ID: Number(hotspotId),
        hotspot_plan_own_way: 1,
        item_type: 4,
        hotspot_order: Number.isFinite(nextOrder) && nextOrder > 0 ? nextOrder : 999,
        hotspot_start_time: fallbackTime,
        hotspot_end_time: fallbackTime,
        is_conflict: 1,
        conflict_reason: 'Forced manual insertion after user confirmation.',
        createdby: Number(userId || 1),
        createdon: new Date(),
        status: 1,
        deleted: 0,
      },
    });

    return true;
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

      const rebuildResult = await this.hotspotEngine.rebuildRouteHotspots(tx, Number(planId));

      return {
        success: true,
        rebuildSummary: rebuildResult.rebuildSummary,
        warnings: rebuildResult.warnings,
      };
    }, { timeout: 30000 });
  }

  /**
   * Rebuild a route: Clear excluded hotspots and rebuild fresh
   * This lets user get new auto-selected hotspots to replace deleted ones
   */
  async rebuildRoute(planId: number, routeId: number) {
    return this.rebuildRouteHotspotsForDay(planId, routeId, 1);
  }

  /**
   * Reset one route/day hotspot state (manual adds + exclusions) and rebuild timeline.
   */
  async rebuildRouteHotspotsForDay(planId: number, routeId: number, userId: number) {
    const normalizedPlanId = Number(planId);
    const normalizedRouteId = Number(routeId);

    return this.prisma.$transaction(async (tx) => {
      const route = await (tx as any).dvi_itinerary_route_details.findFirst({
        where: {
          itinerary_route_ID: normalizedRouteId,
          itinerary_plan_ID: normalizedPlanId,
          deleted: 0,
        },
        select: {
          itinerary_route_ID: true,
        },
      });

      if (!route) {
        throw new NotFoundException('Route not found for this itinerary plan');
      }

      const manualHotspotRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_plan_ID: normalizedPlanId,
          itinerary_route_ID: normalizedRouteId,
          hotspot_plan_own_way: 1,
          item_type: 4,
          deleted: 0,
        },
        select: {
          route_hotspot_ID: true,
        },
      });

      const manualRouteHotspotIds = manualHotspotRows
        .map((row: any) => Number(row.route_hotspot_ID || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0);

      if (manualRouteHotspotIds.length > 0) {
        await (tx as any).dvi_itinerary_route_activity_details.deleteMany({
          where: {
            itinerary_plan_ID: normalizedPlanId,
            itinerary_route_ID: normalizedRouteId,
            route_hotspot_ID: { in: manualRouteHotspotIds },
          },
        });
      }

      await (tx as any).dvi_itinerary_route_hotspot_details.deleteMany({
        where: {
          itinerary_plan_ID: normalizedPlanId,
          itinerary_route_ID: normalizedRouteId,
          hotspot_plan_own_way: 1,
          item_type: 4,
          deleted: 0,
        },
      });

      await (tx as any).dvi_itinerary_route_details.update({
        where: { itinerary_route_ID: normalizedRouteId },
        data: {
          excluded_hotspot_ids: [],
          updatedon: new Date(),
        },
      });

      const rebuildResult = await this.hotspotEngine.rebuildRouteHotspots(tx, normalizedPlanId);

      return {
        success: true,
        planId: normalizedPlanId,
        routeId: normalizedRouteId,
        message: 'Day hotspots rebuilt successfully',
        rebuildSummary: rebuildResult.rebuildSummary,
        warnings: rebuildResult.warnings,
      };
    }, { timeout: 60000 });
  }

  /**
   * Update route start and end times and rebuild the timeline.
   */
  async updateRouteTimes(
    planId: number,
    routeId: number,
    startTime: string,
    endTime: string,
    previousDayBillingDecisionProvided?: boolean,
    previousDayBillingConfirmed?: boolean,
  ) {
    console.log(`[updateRouteTimes] planId=${planId}, routeId=${routeId}, startTime=${startTime}, endTime=${endTime}`);

    const normalizedPlanId = Number(planId || 0);
    const normalizedRouteId = Number(routeId || 0);
    const normalizedStartTime = String(startTime || '').trim();
    const normalizedEndTime = String(endTime || '').trim();
    const normalizedDecisionProvided = Boolean(previousDayBillingDecisionProvided);
    const normalizedDecisionConfirmed = Boolean(previousDayBillingConfirmed);
    const hhmmss = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

    if (!normalizedPlanId || !normalizedRouteId) {
      throw new BadRequestException('planId and routeId are required');
    }

    if (!hhmmss.test(normalizedStartTime) || !hhmmss.test(normalizedEndTime)) {
      throw new BadRequestException('startTime and endTime must be in HH:MM:SS format');
    }

    const toTimeString = (value: unknown): string => {
      if (typeof value === 'string' && value.trim()) {
        return TimeConverter.toTimeString(value.trim());
      }
      return TimeConverter.toTimeString(value as any);
    };

    const combineDateAndTimeUtc = (routeDateValue: unknown, hhmmssTime: string): Date => {
      const routeDate = routeDateValue instanceof Date ? routeDateValue : new Date(routeDateValue as any);
      if (!Number.isFinite(routeDate.getTime())) {
        throw new BadRequestException('Invalid itinerary_route_date while computing itinerary boundary');
      }
      const [h, m, s] = hhmmssTime.split(':').map((v) => Number(v || 0));
      return new Date(
        Date.UTC(
          routeDate.getUTCFullYear(),
          routeDate.getUTCMonth(),
          routeDate.getUTCDate(),
          h,
          m,
          s,
        ),
      );
    };

    const subtractOneUtcDay = (value: Date): Date => {
      const d = new Date(value);
      d.setUTCDate(d.getUTCDate() - 1);
      return d;
    };

    const startTimeSeconds = (() => {
      const [h, m, s] = normalizedStartTime.split(':').map((v) => Number(v || 0));
      return (h * 3600) + (m * 60) + s;
    })();
    const isEarlyArrivalWindow = startTimeSeconds >= 3600 && startTimeSeconds < 28800; // 01:00:00–07:59:59

    const transactionResult = await this.prisma.$transaction(async (tx) => {
      // 1) Verify target route belongs to this plan
      const targetRoute = await (tx as any).dvi_itinerary_route_details.findFirst({
        where: {
          itinerary_route_ID: normalizedRouteId,
          itinerary_plan_ID: normalizedPlanId,
          deleted: 0,
        },
        select: {
          itinerary_route_ID: true,
          itinerary_route_date: true,
          no_of_days: true,
          next_visiting_location: true,
          location_name: true,
        },
      });

      if (!targetRoute) {
        const otherRecord = await (tx as any).dvi_itinerary_route_details.findUnique({
          where: { itinerary_route_ID: normalizedRouteId },
          select: { itinerary_plan_ID: true, deleted: true },
        });
        if (otherRecord) {
          throw new BadRequestException(
            `Route ${normalizedRouteId} belongs to plan ${otherRecord.itinerary_plan_ID}, not ${normalizedPlanId}`,
          );
        }
        throw new BadRequestException(`Route ${normalizedRouteId} not found`);
      }

      // 2) Persist requested route start/end times
      await (tx as any).dvi_itinerary_route_details.update({
        where: { itinerary_route_ID: normalizedRouteId },
        data: {
          route_start_time: TimeConverter.toDate(normalizedStartTime),
          route_end_time: TimeConverter.toDate(normalizedEndTime),
          updatedon: new Date(),
        },
      });

      // 3) Recompute itinerary-level trip boundaries from route rows.
      //    If Day-1 route time changed, itinerary start/pickup must follow route day-1 start.
      const commonRouteWhere = {
        itinerary_plan_ID: normalizedPlanId,
        deleted: 0,
        status: 1,
      };

      const routeBoundarySelect = {
        itinerary_route_ID: true,
        itinerary_route_date: true,
        no_of_days: true,
        next_visiting_location: true,
        location_name: true,
        route_start_time: true,
        route_end_time: true,
      };

      const [firstRoute, lastRoute] = await Promise.all([
        (tx as any).dvi_itinerary_route_details.findFirst({
          where: commonRouteWhere,
          orderBy: [
            { no_of_days: 'asc' },
            { itinerary_route_date: 'asc' },
            { itinerary_route_ID: 'asc' },
          ],
          select: routeBoundarySelect,
        }),
        (tx as any).dvi_itinerary_route_details.findFirst({
          where: commonRouteWhere,
          orderBy: [
            { no_of_days: 'desc' },
            { itinerary_route_date: 'desc' },
            { itinerary_route_ID: 'desc' },
          ],
          select: routeBoundarySelect,
        }),
      ]);

      if (!firstRoute || !lastRoute) {
        throw new BadRequestException(`No active routes found for plan ${normalizedPlanId}`);
      }

      const firstRouteStartTime = toTimeString(firstRoute.route_start_time);
      const lastRouteStartTime = toTimeString(lastRoute.route_start_time);
      const lastRouteEndTime = toTimeString(lastRoute.route_end_time);

      const itineraryStartDateTime = combineDateAndTimeUtc(
        firstRoute.itinerary_route_date,
        firstRouteStartTime,
      );

      const lastRouteStartDateTime = combineDateAndTimeUtc(
        lastRoute.itinerary_route_date,
        lastRouteStartTime,
      );
      const itineraryEndDateTime = combineDateAndTimeUtc(
        lastRoute.itinerary_route_date,
        lastRouteEndTime,
      );
      if (itineraryEndDateTime.getTime() < lastRouteStartDateTime.getTime()) {
        itineraryEndDateTime.setUTCDate(itineraryEndDateTime.getUTCDate() + 1);
      }

      const isDay1RouteUpdated = Number(firstRoute.itinerary_route_ID) === normalizedRouteId;

      // Persist previous-day billing decision as marker rows for hotel-details rendering.
      if (isDay1RouteUpdated) {
        const existingMarkerRows = await (tx as any).dvi_itinerary_plan_hotel_details.findMany({
          where: {
            itinerary_plan_id: normalizedPlanId,
            itinerary_route_id: normalizedRouteId,
            hotel_required: 2,
            hotel_id: 0,
            deleted: 0,
          },
          select: {
            group_type: true,
            itinerary_route_date: true,
            itinerary_route_location: true,
          },
        });

        if (
          normalizedDecisionProvided &&
          normalizedDecisionConfirmed &&
          isEarlyArrivalWindow
        ) {
          const firstRouteDate = new Date(firstRoute.itinerary_route_date as any);
          if (!Number.isNaN(firstRouteDate.getTime())) {
            const previousDayDate = subtractOneUtcDay(
              new Date(Date.UTC(
                firstRouteDate.getUTCFullYear(),
                firstRouteDate.getUTCMonth(),
                firstRouteDate.getUTCDate(),
                0,
                0,
                0,
              )),
            );
            const routeLocation = String(
              (firstRoute as any).next_visiting_location ||
              (firstRoute as any).location_name ||
              '',
            ).trim();

            const expectedDateIso = previousDayDate.toISOString().slice(0, 10);
            const expectedGroups = new Set([1, 2, 3, 4]);

            const markersAlreadyUpToDate =
              existingMarkerRows.length === 4 &&
              existingMarkerRows.every((row: any) => {
                const rowDateIso = new Date(row.itinerary_route_date as any).toISOString().slice(0, 10);
                const rowGroup = Number(row.group_type || 0);
                const rowLocation = String(row.itinerary_route_location || '').trim();
                return (
                  expectedGroups.has(rowGroup) &&
                  rowDateIso === expectedDateIso &&
                  rowLocation === (routeLocation || '')
                );
              });

            if (!markersAlreadyUpToDate) {
              if (existingMarkerRows.length > 0) {
                await (tx as any).dvi_itinerary_plan_hotel_details.deleteMany({
                  where: {
                    itinerary_plan_id: normalizedPlanId,
                    itinerary_route_id: normalizedRouteId,
                    hotel_required: 2,
                    hotel_id: 0,
                    deleted: 0,
                  },
                });
              }

              const markerRows = [1, 2, 3, 4].map((groupType) => ({
                group_type: groupType,
                itinerary_plan_id: normalizedPlanId,
                itinerary_route_id: normalizedRouteId,
                itinerary_route_date: previousDayDate,
                itinerary_route_location: routeLocation || null,
                hotel_required: 2,
                hotel_id: 0,
                total_no_of_rooms: 0,
                total_hotel_cost: 0,
                total_hotel_tax_amount: 0,
                createdby: 1,
                createdon: new Date(),
                status: 1,
                deleted: 0,
              }));

              await (tx as any).dvi_itinerary_plan_hotel_details.createMany({
                data: markerRows,
              });
            }
          }
        } else if (existingMarkerRows.length > 0) {
          await (tx as any).dvi_itinerary_plan_hotel_details.deleteMany({
            where: {
              itinerary_plan_id: normalizedPlanId,
              itinerary_route_id: normalizedRouteId,
              hotel_required: 2,
              hotel_id: 0,
              deleted: 0,
            },
          });
        }
      }

      const planUpdateData: any = {
        trip_end_date_and_time: itineraryEndDateTime,
        updatedon: new Date(),
      };

      if (isDay1RouteUpdated) {
        planUpdateData.trip_start_date_and_time = itineraryStartDateTime;
        planUpdateData.pick_up_date_and_time = itineraryStartDateTime;
      }

      await (tx as any).dvi_itinerary_plan_details.updateMany({
        where: {
          itinerary_plan_ID: normalizedPlanId,
          deleted: 0,
        },
        data: planUpdateData,
      });

      // 4) Rebuild itinerary timeline rows (same core build as createPlan hotspot stage)
      const rebuildResult = await this.hotspotEngine.rebuildRouteHotspots(tx, normalizedPlanId);

      return {
        success: true,
        planId: normalizedPlanId,
        routeId: normalizedRouteId,
        routeTimes: {
          startTime: normalizedStartTime,
          endTime: normalizedEndTime,
        },
        itineraryBoundaries: {
          tripStartDateTime: isDay1RouteUpdated ? itineraryStartDateTime.toISOString() : null,
          tripEndDateTime: itineraryEndDateTime.toISOString(),
          day1RouteUpdated: isDay1RouteUpdated,
        },
        rebuildSummary: rebuildResult.rebuildSummary,
        warnings: rebuildResult.warnings,
        previousDayBillingDecision: {
          decisionProvided: normalizedDecisionProvided,
          confirmed: normalizedDecisionConfirmed,
          markerCreated:
            isDay1RouteUpdated &&
            normalizedDecisionProvided &&
            normalizedDecisionConfirmed &&
            isEarlyArrivalWindow,
        },
      };
    }, { timeout: 180000, maxWait: 20000 });

    // 5) Post-commit parity with create flow: recompute parking charges from persisted rebuilt rows
    await this.hotspotEngine.rebuildParkingCharges(normalizedPlanId, 1);

    return {
      ...transactionResult,
      parkingChargesRebuilt: true,
    };
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
    * - For small candidate sets (<=8 movable stops): Exhaustive search
    * - For larger sets: Nearest Neighbor + Simulated Annealing
   * 
   * This finds the optimal or near-optimal route that minimizes total travel distance/time
   */
  private async optimizeRouteOrder(routes: any[]): Promise<any[]> {
    if (!routes || routes.length <= 2) return routes;

    const debugOptimization = process.env.DEBUG_ROUTE_OPTIMIZER === 'true';
    const exhaustiveSafeLimit = 8;
    const log = (msg: string) => console.log(msg);
    const logDebug = (msg: string) => {
      if (debugOptimization) {
        log(msg);
      }
    };

    // Logging every permutation is unsafe in production because factorial growth quickly floods logs.
    log(`[RouteOptimization] Start optimization. routeCount=${routes.length}`);

    // Broken chains indicate route reconstruction corruption; optimizing them can amplify bad data.
    if (this.hasBrokenChain(routes)) {
      log('[RouteOptimization] ⚠️ Broken route chain detected. Skipping optimization and returning original routes.');
      return routes;
    }

    const context = this.extractRouteOptimizationContext(routes);
    this.logOptimizationSummary(context, log, debugOptimization);

    const inputValidation = this.validateOptimizationInputs(context);
    if (!inputValidation.isValid) {
      log(`[RouteOptimization] ⚠️ Invalid optimization inputs (${inputValidation.reason}). Returning original route order.`);
      return routes;
    }

    // When 0/1 movable stops remain after normalization, exhaustive search adds no value.
    if (context.movableStops.length <= 1) {
      log(`[RouteOptimization] Skipping optimization. movableStopCount=${context.movableStops.length}`);
      const anchorSafeLocations = this.removeConsecutiveDuplicateLocations([
        context.start,
        ...context.movableStops.map((s) => s.name),
        context.end,
      ]);
      return this.buildOptimizedRouteDtos(routes, anchorSafeLocations, log);
    }

    let bestRouteLocations: string[] = [];
    const middleLocations = context.movableStops.map((s) => s.name);

    // Hard cap prevents factorial explosion in production even after normalization.
    if (middleLocations.length <= exhaustiveSafeLimit) {
      log(`[RouteOptimization] Using exhaustive permutation. candidateCount=${middleLocations.length}`);
      bestRouteLocations = await this.optimizeWith_ExhaustivePermutation(
        context.start,
        context.end,
        middleLocations,
        log,
        logDebug,
      );
    } else {
      log(`[RouteOptimization] Using nearest-neighbor + annealing. candidateCount=${middleLocations.length}`);
      bestRouteLocations = await this.optimizeWith_NearestNeighborAndAnnealing(
        context.start,
        context.end,
        middleLocations,
        logDebug,
      );
    }

    if (!bestRouteLocations.length) {
      log(`[RouteOptimization] ⚠️ No optimized route generated. Returning original route order.`);
      return routes;
    }

    const optimizedRoutes = this.buildOptimizedRouteDtos(routes, bestRouteLocations, log);
    const finalChain = optimizedRoutes.map(r => `${r.location_name}→${r.next_visiting_location}`).join(' | ');
    log(`[RouteOptimization] ✅ Completed. optimizedRouteCount=${optimizedRoutes.length}. chain=${finalChain}`);
    return optimizedRoutes;
  }

  private normalizeLocationName(value: string): string {
    const raw = String(value || '').trim();
    if (!raw) return '';

    const normalized = normalizeCityName(raw);
    if (normalized) return normalized;

    return raw
      .toLowerCase()
      .replace(/[.,()\-_\/]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private isTerminalAnchorLocation(locationName: string): boolean {
    const text = String(locationName || '').toLowerCase();
    return /(airport|air\s*port|railway|station|stn|junction|terminal|bus\s*stand|terminus)/i.test(text);
  }

  private extractRouteOptimizationContext(routes: any[]): {
    start: string;
    end: string;
    sourceLocations: string[];
    nextVisitingLocations: string[];
    rawFullPath: string[];
    cleanedFullPath: string[];
    rawMiddleLocations: string[];
    movableStops: Array<{ name: string; normalizedName: string }>;
    removedDuplicates: Array<{ name: string; normalizedName: string }>;
    removedInvalidTerminalNodes: Array<{ name: string; reason: string }>;
  } {
    const sourceLocations = routes.map((r) => String(r?.location_name || '').trim());
    const nextVisitingLocations = routes.map((r) => String(r?.next_visiting_location || '').trim());

    // Build a full path first so we normalize chain artifacts before choosing permutation nodes.
    const rawFullPath = sourceLocations.length > 0
      ? [sourceLocations[0], ...nextVisitingLocations]
      : [];
    const cleanedFullPath = this.buildCleanOptimizationPath(rawFullPath);

    const start = cleanedFullPath[0] || '';
    const end = cleanedFullPath[cleanedFullPath.length - 1] || '';
    const rawMiddleLocations = cleanedFullPath.slice(1, -1);

    const rawStops = this.buildMovableStops(rawMiddleLocations, start, end);
    const dedupeResult = this.dedupeStops(rawStops);

    return {
      start,
      end,
      sourceLocations,
      nextVisitingLocations,
      rawFullPath,
      cleanedFullPath,
      rawMiddleLocations,
      movableStops: dedupeResult.stops,
      removedDuplicates: dedupeResult.removedDuplicates,
      removedInvalidTerminalNodes: rawStops.removedInvalidTerminalNodes,
    };
  }

  private buildMovableStops(
    rawMiddleLocations: string[],
    start: string,
    end: string,
  ): {
    stops: Array<{ name: string; normalizedName: string }>;
    removedInvalidTerminalNodes: Array<{ name: string; reason: string }>;
  } {
    const stops: Array<{ name: string; normalizedName: string }> = [];
    const removedInvalidTerminalNodes: Array<{ name: string; reason: string }> = [];

    const startNormalized = this.normalizeLocationName(start);
    const endNormalized = this.normalizeLocationName(end);

    for (let idx = 0; idx < rawMiddleLocations.length; idx++) {
      const rawName = rawMiddleLocations[idx];
      const name = String(rawName || '').trim();
      const normalizedName = this.normalizeLocationName(name);

      if (!name || !normalizedName) {
        removedInvalidTerminalNodes.push({ name, reason: 'empty-name' });
        continue;
      }

      // Anchor nodes must remain fixed; allowing them in permutation creates invalid loops.
      if (normalizedName === startNormalized || normalizedName === endNormalized) {
        const preserveFirstTerminalToCityHop =
          idx === 0 &&
          normalizedName === startNormalized &&
          this.isTerminalAnchorLocation(start) &&
          !this.isTerminalAnchorLocation(name) &&
          start.trim().toLowerCase() !== name.trim().toLowerCase();

        if (preserveFirstTerminalToCityHop) {
          stops.push({ name, normalizedName });
          continue;
        }

        removedInvalidTerminalNodes.push({ name, reason: 'matches-anchor' });
        continue;
      }

      stops.push({ name, normalizedName });
    }

    return { stops, removedInvalidTerminalNodes };
  }

  private buildCleanOptimizationPath(rawFullPath: string[]): string[] {
    const cleaned: string[] = [];
    const seen = new Set<string>();

    // Duplicate chain artifacts are dangerous because they create fake loops and huge permutation inputs.
    for (let i = 0; i < rawFullPath.length; i++) {
      const name = String(rawFullPath[i] || '').trim();
      const normalizedName = this.normalizeLocationName(name);
      if (!name || !normalizedName) continue;

      let shouldPreserveTerminalToCityHop = false;

      if (cleaned.length > 0) {
        const prevNormalized = this.normalizeLocationName(cleaned[cleaned.length - 1]);
        if (normalizedName === prevNormalized) {
          const prevName = cleaned[cleaned.length - 1];
          const isFirstHop = cleaned.length === 1;
          shouldPreserveTerminalToCityHop =
            isFirstHop &&
            this.isTerminalAnchorLocation(prevName) &&
            !this.isTerminalAnchorLocation(name) &&
            this.normalizeLocationName(prevName) === this.normalizeLocationName(name) &&
            prevName.trim().toLowerCase() !== name.trim().toLowerCase();

          if (!shouldPreserveTerminalToCityHop) {
            continue;
          }
        }
      }

      const isLastNode = i === rawFullPath.length - 1;
      if (seen.has(normalizedName) && !isLastNode && !shouldPreserveTerminalToCityHop) {
        continue;
      }

      cleaned.push(name);
      seen.add(normalizedName);
    }

    if (cleaned.length >= 2) {
      return cleaned;
    }

    // Fallback to non-empty endpoints when cleaned path collapses too far.
    const first = rawFullPath.find((p) => this.normalizeLocationName(p));
    const last = [...rawFullPath].reverse().find((p) => this.normalizeLocationName(p));
    const fallback: string[] = [];
    if (first) fallback.push(String(first).trim());
    if (last && this.normalizeLocationName(last) !== this.normalizeLocationName(first || '')) {
      fallback.push(String(last).trim());
    }
    return fallback;
  }

  private hasBrokenChain(routes: any[]): boolean {
    if (!routes || routes.length <= 1) return false;

    for (let i = 0; i < routes.length - 1; i++) {
      const currentNext = this.normalizeLocationName(String(routes[i]?.next_visiting_location || ''));
      const nextSource = this.normalizeLocationName(String(routes[i + 1]?.location_name || ''));
      if (!currentNext || !nextSource || currentNext !== nextSource) {
        return true;
      }
    }

    return false;
  }

  private dedupeStops(stopsInput: {
    stops: Array<{ name: string; normalizedName: string }>;
    removedInvalidTerminalNodes: Array<{ name: string; reason: string }>;
  }): {
    stops: Array<{ name: string; normalizedName: string }>;
    removedDuplicates: Array<{ name: string; normalizedName: string }>;
  } {
    const seen = new Set<string>();
    const stops: Array<{ name: string; normalizedName: string }> = [];
    const removedDuplicates: Array<{ name: string; normalizedName: string }> = [];

    // Duplicate place names are dangerous in exhaustive search: they produce repeated equivalent permutations.
    for (const stop of stopsInput.stops) {
      if (seen.has(stop.normalizedName)) {
        removedDuplicates.push(stop);
        continue;
      }

      seen.add(stop.normalizedName);
      stops.push(stop);
    }

    return { stops, removedDuplicates };
  }

  private validateOptimizationInputs(context: {
    start: string;
    end: string;
    movableStops: Array<{ name: string; normalizedName: string }>;
  }): { isValid: boolean; reason?: string } {
    const startNormalized = this.normalizeLocationName(context.start);
    const endNormalized = this.normalizeLocationName(context.end);

    if (!startNormalized || !endNormalized) {
      return { isValid: false, reason: 'missing-start-or-end' };
    }

    const seen = new Set<string>();
    for (const stop of context.movableStops) {
      if (!stop.name || !stop.normalizedName) {
        return { isValid: false, reason: 'empty-movable-stop' };
      }

      if (stop.normalizedName === startNormalized || stop.normalizedName === endNormalized) {
        return { isValid: false, reason: 'anchor-found-in-movable-stops' };
      }

      if (seen.has(stop.normalizedName)) {
        return { isValid: false, reason: 'duplicate-movable-stop' };
      }
      seen.add(stop.normalizedName);
    }

    return { isValid: true };
  }

  private logOptimizationSummary(
    context: {
      start: string;
      end: string;
      sourceLocations: string[];
      nextVisitingLocations: string[];
      rawFullPath: string[];
      cleanedFullPath: string[];
      rawMiddleLocations: string[];
      movableStops: Array<{ name: string; normalizedName: string }>;
      removedDuplicates: Array<{ name: string; normalizedName: string }>;
      removedInvalidTerminalNodes: Array<{ name: string; reason: string }>;
    },
    log: (msg: string) => void,
    debug: boolean,
  ): void {
    log(`[RouteOptimization] Raw route chain: ${context.sourceLocations.map((s, i) => `${s}→${context.nextVisitingLocations[i] || ''}`).join(' | ')}`);
    log(`[RouteOptimization] Full path raw=[${context.rawFullPath.join(', ')}], cleaned=[${context.cleanedFullPath.join(', ')}]`);
    log(`[RouteOptimization] Extracted anchors and movable: start=${context.start}, end=${context.end}, movable=[${context.movableStops.map((s) => s.name).join(', ')}]`);

    if (context.removedDuplicates.length > 0) {
      log(`[RouteOptimization] Removed duplicate movable stops: [${context.removedDuplicates.map((d) => d.name).join(', ')}]`);
    }

    if (context.removedInvalidTerminalNodes.length > 0) {
      log(`[RouteOptimization] Removed invalid terminal or anchor-like nodes: ${context.removedInvalidTerminalNodes.map((n) => `${n.name}(${n.reason})`).join(', ')}`);
    }

    log(`[RouteOptimization] Candidate movable stop count: ${context.movableStops.length}`);

    if (debug) {
      log(`[RouteOptimization][DEBUG] Raw middle locations: [${context.rawMiddleLocations.join(', ')}]`);
    }
  }

  private buildOptimizedRouteDtos(routes: any[], routeLocations: string[], log: (msg: string) => void): any[] {
    const cleanedLocations = this.removeConsecutiveDuplicateLocations(routeLocations);

    if (cleanedLocations.length < 2) {
      log('[RouteOptimization] ⚠️ Optimized route locations are invalid after cleanup. Returning original route order.');
      return routes;
    }

    const optimizedRoutes: any[] = [];
    const routeCount = cleanedLocations.length - 1;

    for (let i = 0; i < routeCount; i++) {
      const templateRoute = routes[Math.min(i, routes.length - 1)];
      const newRoute = { ...templateRoute };
      newRoute.location_name = cleanedLocations[i];
      newRoute.next_visiting_location = cleanedLocations[i + 1];
      optimizedRoutes.push(newRoute);
    }

    const startDate = new Date(routes[0].itinerary_route_date);
    optimizedRoutes.forEach((route, index) => {
      const newDate = new Date(startDate);
      newDate.setDate(newDate.getDate() + index);
      route.itinerary_route_date = newDate.toISOString().split('T')[0];
      route.no_of_days = index + 1;
    });

    return optimizedRoutes;
  }

  private removeConsecutiveDuplicateLocations(locations: string[]): string[] {
    const cleaned: string[] = [];
    for (const location of locations) {
      const name = String(location || '').trim();
      if (!name) continue;
      if (cleaned.length === 0) {
        cleaned.push(name);
        continue;
      }

      const prev = cleaned[cleaned.length - 1];
      if (this.normalizeLocationName(prev) === this.normalizeLocationName(name)) {
        continue;
      }
      cleaned.push(name);
    }
    return cleaned;
  }

  /**
    * PHP-EXACT: small candidate sets only - EXHAUSTIVE PERMUTATION
   * Tries all permutations of middleLocations and finds the one with minimum total distance
   */
  private async optimizeWith_ExhaustivePermutation(
    start: string,
    end: string,
    middleLocations: string[],
    log: (msg: string) => void,
    logDebug: (msg: string) => void
  ): Promise<string[]> {
    const perms = this.generatePermutations_PHP([...middleLocations]);
    
    let bestPerm: string[] = middleLocations; // Default to original order
    let bestDistance = Infinity;
    let bestChain = '';
    
    log(`[ExhaustivePermutation] Testing ${perms.length} permutations...`);

    let tested = 0;
    for (const perm of perms) {
      tested++;
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

      if (totalDistance < bestDistance) {
        bestDistance = totalDistance;
        bestPerm = perm;
        bestChain = chainStr;
        log(`[ExhaustivePermutation] best-so-far=${bestDistance === Infinity ? 'INVALID' : bestDistance.toFixed(1) + ' km'} route=[${bestPerm.join(', ')}]`);
      } else if (tested % 250 === 0) {
        logDebug(`[ExhaustivePermutation][DEBUG] progress=${tested}/${perms.length} best=${bestDistance === Infinity ? 'INVALID' : bestDistance.toFixed(1) + ' km'}`);
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

  private async simulateActivityImpactBeforeAdd(data: {
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
  }): Promise<{
    canAdd: boolean;
    warnings: Array<{ type: string; message: string; details?: any }>;
    optionalHotspotRouteIdsToRemove: number[];
  }> {
    const activity = await (this.prisma as any).dvi_activity.findUnique({
      where: { activity_id: data.activityId },
      select: { activity_duration: true },
    });

    if (!activity) {
      throw new NotFoundException('Activity not found');
    }

    const routeHotspot = await (this.prisma as any).dvi_itinerary_route_hotspot_details.findFirst({
      where: {
        route_hotspot_ID: data.routeHotspotId,
        itinerary_plan_ID: data.planId,
        itinerary_route_ID: data.routeId,
        deleted: 0,
      },
      select: {
        route_hotspot_ID: true,
        hotspot_order: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
      },
    });

    if (!routeHotspot) {
      throw new NotFoundException('Route hotspot not found');
    }

    const route = await (this.prisma as any).dvi_itinerary_route_details.findFirst({
      where: {
        itinerary_plan_ID: data.planId,
        itinerary_route_ID: data.routeId,
        deleted: 0,
      },
      select: {
        route_end_time: true,
      },
    });

    const routeEndTime = route?.route_end_time;
    if (!routeEndTime) {
      return {
        canAdd: true,
        warnings: [],
        optionalHotspotRouteIdsToRemove: [],
      };
    }

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

    const activityStartTime =
      existingActivities.length > 0 && existingActivities[0].activity_end_time
        ? existingActivities[0].activity_end_time
        : routeHotspot.hotspot_start_time;

    const durationMinutes = activity.activity_duration
      ? this.timeToMinutes(activity.activity_duration)
      : 30;
    const activityEndTime = this.addMinutesToTime(activityStartTime, durationMinutes);

    const extensionMinutes = Math.max(
      0,
      Math.round(
        (activityEndTime.getTime() - routeHotspot.hotspot_end_time.getTime()) / 60000,
      ),
    );

    if (extensionMinutes <= 0) {
      return {
        canAdd: true,
        warnings: [],
        optionalHotspotRouteIdsToRemove: [],
      };
    }

    const downstreamHotspots = await (this.prisma as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: data.planId,
        itinerary_route_ID: data.routeId,
        item_type: 4,
        hotspot_order: { gt: routeHotspot.hotspot_order },
        deleted: 0,
      },
      select: {
        route_hotspot_ID: true,
        hotspot_ID: true,
        hotspot_order: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
      },
      orderBy: { hotspot_order: 'asc' },
    });

    if (downstreamHotspots.length === 0) {
      return {
        canAdd: activityEndTime <= routeEndTime,
        warnings: activityEndTime <= routeEndTime
          ? []
          : [
              {
                type: 'activity cannot be added without conflict',
                message: 'activity cannot be added without conflict',
              },
            ],
        optionalHotspotRouteIdsToRemove: [],
      };
    }

    const downstreamHotspotIds = downstreamHotspots
      .map((h: any) => Number(h.hotspot_ID || 0))
      .filter((id: number) => id > 0);

    const hotspotMasters = downstreamHotspotIds.length > 0
      ? await (this.prisma as any).dvi_hotspot_place.findMany({
          where: { hotspot_ID: { in: downstreamHotspotIds } },
          select: {
            hotspot_ID: true,
            hotspot_priority: true,
          },
        })
      : [];

    const priorityByHotspotId = new Map<number, number>(
      hotspotMasters.map((h: any) => [
        Number(h.hotspot_ID),
        Number(h.hotspot_priority ?? 0),
      ]),
    );

    const projected = downstreamHotspots.map((h: any) => {
      const priority = priorityByHotspotId.get(Number(h.hotspot_ID)) ?? 0;
      return {
        routeHotspotId: Number(h.route_hotspot_ID),
        hotspotId: Number(h.hotspot_ID),
        hotspotOrder: Number(h.hotspot_order),
        priority,
        projectedStart: h.hotspot_start_time
          ? this.addMinutesToTime(h.hotspot_start_time, extensionMinutes)
          : null,
        projectedEnd: h.hotspot_end_time
          ? this.addMinutesToTime(h.hotspot_end_time, extensionMinutes)
          : null,
      };
    });

    const warnings: Array<{ type: string; message: string; details?: any }> = [];

    const shiftedPriorityHotspots = projected
      .filter((h) => h.priority >= 1 && h.priority <= 3)
      .map((h) => h.hotspotId);

    if (shiftedPriorityHotspots.length > 0) {
      warnings.push({
        type: 'priority hotspot shifted',
        message: 'priority hotspot shifted',
        details: {
          hotspotIds: shiftedPriorityHotspots,
          extensionMinutes,
        },
      });
    }

    const remaining = [...projected];
    const removedOptionalRouteIds: number[] = [];

    const getProjectedRouteEnd = () => {
      let end = activityEndTime;
      for (const row of remaining) {
        if (row.projectedEnd && row.projectedEnd > end) {
          end = row.projectedEnd;
        }
      }
      return end;
    };

    while (getProjectedRouteEnd() > routeEndTime) {
      let removeIndex = -1;
      for (let i = remaining.length - 1; i >= 0; i--) {
        const row = remaining[i];
        if (!(row.priority >= 1 && row.priority <= 3)) {
          removeIndex = i;
          break;
        }
      }

      if (removeIndex === -1) {
        break;
      }

      const removed = remaining.splice(removeIndex, 1)[0];
      removedOptionalRouteIds.push(removed.routeHotspotId);
    }

    if (removedOptionalRouteIds.length > 0) {
      warnings.push({
        type: 'optional hotspots removed',
        message: 'optional hotspots removed',
        details: {
          routeHotspotIds: removedOptionalRouteIds,
        },
      });
    }

    if (getProjectedRouteEnd() > routeEndTime) {
      await this.attemptActivityRerouteSimulation(data.planId);

      warnings.push({
        type: 'activity cannot be added without conflict',
        message: 'activity cannot be added without conflict',
      });

      return {
        canAdd: false,
        warnings,
        optionalHotspotRouteIdsToRemove: [],
      };
    }

    return {
      canAdd: true,
      warnings,
      optionalHotspotRouteIdsToRemove: removedOptionalRouteIds,
    };
  }

  private async attemptActivityRerouteSimulation(planId: number): Promise<void> {
    const rollbackMarker = new Error('__ACTIVITY_REROUTE_SIMULATION_ROLLBACK__');

    try {
      await this.prisma.$transaction(async (tx) => {
        await this.hotspotEngine.rebuildRouteHotspots(tx, planId);
        throw rollbackMarker;
      }, { timeout: 60000 });
    } catch (error: any) {
      if (error === rollbackMarker) {
        return;
      }
      throw error;
    }
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