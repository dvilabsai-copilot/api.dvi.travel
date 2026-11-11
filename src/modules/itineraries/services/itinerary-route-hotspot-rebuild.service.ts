import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { HotspotEngineService } from '../engines/hotspot-engine.service';
import { RouteVehicleRestrictionService } from '../../route-vehicle-restrictions/route-vehicle-restriction.service';

type RebuildCallbacks = {
  applySameCityCrossDayOptimizerAfterSave: (...args: any[]) => Promise<any>;
  forceRebuildVehiclePricingAfterHotspotChange: (...args: any[]) => Promise<any>;
};

@Injectable()
export class ItineraryRouteHotspotRebuildService {
  private callbacks: RebuildCallbacks = {
    applySameCityCrossDayOptimizerAfterSave: async () => undefined,
    forceRebuildVehiclePricingAfterHotspotChange: async () => undefined,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly hotspotEngine: HotspotEngineService,
    private readonly routeVehicleRestrictions: RouteVehicleRestrictionService,
  ) {}

  setCallbacks(callbacks: Partial<RebuildCallbacks>) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

async rebuildRouteHotspotsForDay(planId: number, routeId: number, userId: number) {
    const normalizedPlanId = Number(planId);
    const normalizedRouteId = Number(routeId);
    let planQuoteId = '';
    let sameCityPolicyEnabled = false;
    let siblingHotspotSnapshot = '';
    let siblingSnapshotCaptured = false;

    let rebuildResult;
    try {
      await this.routeVehicleRestrictions.assertPersistedPlan(normalizedPlanId);
      rebuildResult = await this.prisma.$transaction(async (tx: any) => {
        const route = await tx.dvi_itinerary_route_details.findFirst({
          where: {
            itinerary_route_ID: normalizedRouteId,
            itinerary_plan_ID: normalizedPlanId,
            deleted: 0,
            status: 1,
          },
          select: { itinerary_route_ID: true, excluded_hotspot_ids: true },
        });

        if (!route) {
          throw new BadRequestException(
            `Route ${normalizedRouteId} does not belong to plan ${normalizedPlanId} or is no longer active`,
          );
        }

        const oldRoutes = await tx.dvi_itinerary_route_details.findMany({
          where: { itinerary_plan_ID: normalizedPlanId, deleted: 0, status: 1 },
          select: { itinerary_route_ID: true, itinerary_route_date: true },
        });
        const oldRouteDateMap = new Map(
          oldRoutes.map((row: any) => [Number(row.itinerary_route_ID || 0), row.itinerary_route_date]),
        );
    const oldHotspots = await tx.dvi_itinerary_route_hotspot_details.findMany({
  where: {
    itinerary_plan_ID: normalizedPlanId,
    item_type: 4,
    deleted: 0,
    status: 1,
            // This endpoint is the explicit route reset flow. Manual
            // hotspots are removed below and must not be passed to the
            // engine, which preserves manual hotspots for insertion flows.
            hotspot_plan_own_way: { not: 1 },
  },
});

        const sameCitySettings = await tx.dvi_global_settings?.findFirst({
          where: { status: 1, deleted: 0 },
          select: { same_city_hotspot_rank_enabled: true },
        });
        sameCityPolicyEnabled = Number(sameCitySettings?.same_city_hotspot_rank_enabled || 0) === 1;

        if (sameCityPolicyEnabled) {
          siblingSnapshotCaptured = true;
          const siblingRows = await tx.dvi_itinerary_route_hotspot_details.findMany({
            where: {
              itinerary_plan_ID: normalizedPlanId,
              itinerary_route_ID: { not: normalizedRouteId },
              deleted: 0,
              status: 1,
            },
            select: {
              itinerary_route_ID: true,
              item_type: true,
              hotspot_ID: true,
              hotspot_order: true,
              hotspot_plan_own_way: true,
              hotspot_traveling_time: true,
              itinerary_travel_type_buffer_time: true,
              hotspot_start_time: true,
              hotspot_end_time: true,
              allow_break_hours: true,
              allow_via_route: true,
              via_location_name: true,
              hotspot_travelling_distance: true,
            },
          });
          siblingHotspotSnapshot = this.serializeSiblingHotspotSnapshot(siblingRows);
        }
// Explicit "Rebuild Route" is a fresh automatic selection. Do not pass the
// target route's previous automatic rows back to the scoped builder: those
// rows are used by the builder as the route's allowed/preserved set and would
// prevent a deleted hotspot from becoming eligible again. Keep sibling-route
// rows so plan-wide duplicate and same-city protections still apply.
const existingHotspotsWithDates = oldHotspots
  .filter((row: any) => Number(row.itinerary_route_ID || 0) !== normalizedRouteId)
  .map((row: any) => ({
    ...row,
    route_date: oldRouteDateMap.get(
      Number(row.itinerary_route_ID || 0),
    ),
  }));

const planRow = await tx.dvi_itinerary_plan_details.findFirst({
          where: { itinerary_plan_ID: normalizedPlanId, deleted: 0 },
          select: { itinerary_quote_ID: true },
        });
        planQuoteId = String(planRow?.itinerary_quote_ID || '');

        const manualHotspotRows = await tx.dvi_itinerary_route_hotspot_details.findMany({
          where: {
            itinerary_plan_ID: normalizedPlanId,
            itinerary_route_ID: normalizedRouteId,
            hotspot_plan_own_way: 1,
            item_type: 4,
            deleted: 0,
          },
          select: { route_hotspot_ID: true },
        });

        const existingExcludedHotspotIds = Array.isArray(route?.excluded_hotspot_ids)
          ? route.excluded_hotspot_ids.map((id: any) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0)
          : [];

        const manualRouteHotspotIds = manualHotspotRows
          .map((row: any) => Number(row.route_hotspot_ID || 0))
          .filter((id: number) => Number.isFinite(id) && id > 0);

        if (manualRouteHotspotIds.length > 0) {
          await tx.dvi_itinerary_route_activity_details.updateMany({
            where: {
              itinerary_plan_ID: normalizedPlanId,
              itinerary_route_ID: normalizedRouteId,
              route_hotspot_ID: { in: manualRouteHotspotIds },
              deleted: 0,
            },
            data: { deleted: 1, status: 0, updatedon: new Date() },
          });
        }

        await tx.dvi_itinerary_route_hotspot_details.updateMany({
          where: {
            itinerary_plan_ID: normalizedPlanId,
            itinerary_route_ID: normalizedRouteId,
            hotspot_plan_own_way: 1,
            item_type: 4,
            deleted: 0,
          },
          data: { deleted: 1, status: 0, updatedon: new Date() },
        });

        await tx.dvi_itinerary_route_details.update({
          where: { itinerary_route_ID: normalizedRouteId },
          data: { excluded_hotspot_ids: [], updatedon: new Date() },
        });
        const preRouteVisitCount = await tx.dvi_itinerary_route_hotspot_details.count({
          where: {
            itinerary_plan_ID: normalizedPlanId,
            itinerary_route_ID: normalizedRouteId,
            item_type: 4,
            deleted: 0,
          },
        });
 console.log('[RouteRebuild][TRACE] before hotspot-engine rebuild', {
          planId: normalizedPlanId,
          routeId: normalizedRouteId,
          preRouteVisitCount,
        });
const engineResult = await this.hotspotEngine.rebuildRouteHotspots(
  tx,
  normalizedPlanId,
  existingHotspotsWithDates,
  {
    scopeToRouteId: normalizedRouteId,
    // Explicit Rebuild Route is a fresh automatic rebuild. The DELETE flow
    // supplies protection separately because it must preserve other current
    // hotspots while recalculating the affected route.
    preserveExistingHotspots: false,
  },
);
        await this.routeVehicleRestrictions.assertPersistedPlan(
          normalizedPlanId,
          `hotspot-rebuild:${normalizedPlanId}:${normalizedRouteId}`,
          tx,
        );
        const postRouteVisitCount = await tx.dvi_itinerary_route_hotspot_details.count({
          where: {
            itinerary_plan_ID: normalizedPlanId,
            itinerary_route_ID: normalizedRouteId,
            item_type: 4,
            deleted: 0,
          },
        });
 console.log('[RouteRebuild][TRACE] after hotspot-engine rebuild', {
          planId: normalizedPlanId,
          routeId: normalizedRouteId,
          postRouteVisitCount,
          rebuildSummaryScheduledCount: Number(engineResult?.rebuildSummary?.totalHotspotsScheduled || 0),
        });

        // Validate inside the transaction so an engine-side sibling mutation
        // is rolled back instead of merely reported after commit.
        if (siblingSnapshotCaptured) {
          const siblingRowsAfterEngine = await tx.dvi_itinerary_route_hotspot_details.findMany({
            where: {
              itinerary_plan_ID: normalizedPlanId,
              itinerary_route_ID: { not: normalizedRouteId },
              deleted: 0,
              status: 1,
            },
            select: {
              itinerary_route_ID: true,
              item_type: true,
              hotspot_ID: true,
              hotspot_order: true,
              hotspot_plan_own_way: true,
              hotspot_traveling_time: true,
              itinerary_travel_type_buffer_time: true,
              hotspot_start_time: true,
              hotspot_end_time: true,
              allow_break_hours: true,
              allow_via_route: true,
              via_location_name: true,
              hotspot_travelling_distance: true,
            },
          });
          const afterEngineSnapshot = this.serializeSiblingHotspotSnapshot(siblingRowsAfterEngine);
          if (afterEngineSnapshot !== siblingHotspotSnapshot) {
            throw new BadRequestException(
              'Same-city scoped rebuild changed a sibling route hotspot, order, or timing; the rebuild was rolled back.',
            );
          }
        }

        return {
          success: true,
          planId: normalizedPlanId,
          routeId: normalizedRouteId,
          message: 'Day hotspots rebuilt successfully',
          rebuildSummary: engineResult.rebuildSummary,
          warnings: engineResult.warnings,
          routeRejectionSummaryByRoute: engineResult.routeRejectionSummaryByRoute,
        };
      }, { timeout: 180000, maxWait: 30000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || '');
      console.error('[RouteRebuild][ERROR]', {
        planId: normalizedPlanId,
        routeId: normalizedRouteId,
        message,
        stack: err instanceof Error ? err.stack : undefined,
      });
      const detail = /connection|timeout|ECONN|ETIMEDOUT/i.test(message)
        ? 'Rebuild timed out or lost its database connection while processing this day. Please try again.'
        : `Rebuild failed for this day. ${message}`;
      throw new BadRequestException(detail);
    }

    const postProcessErrors: { stage: string; message: string }[] = [];

    const runPostRebuildStep = async (stage: string, step: () => Promise<any>) => {
      try {
        await step();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err || '');
        console.error(`[RouteRebuild][POST-PROCESS][${stage}]`, {
          planId: normalizedPlanId,
          routeId: normalizedRouteId,
          message,
          stack: err instanceof Error ? err.stack : undefined,
        });
        postProcessErrors.push({ stage, message });
      }
    };

    if (!rebuildResult?.skipped) {
      await runPostRebuildStep('sameCityCrossDayOptimizer', () =>
        this.callbacks.applySameCityCrossDayOptimizerAfterSave(normalizedPlanId, planQuoteId, {
          scopeToRouteId: normalizedRouteId,
        }));
      await runPostRebuildStep('parkingCharges', () =>
        this.hotspotEngine.rebuildParkingCharges(normalizedPlanId, Number(userId || 1)));
      await runPostRebuildStep('vehiclePricing', () =>
        this.callbacks.forceRebuildVehiclePricingAfterHotspotChange(normalizedPlanId, normalizedRouteId));
    }

    if (siblingSnapshotCaptured) {
      const siblingRowsAfter = await (this.prisma as any).dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_plan_ID: normalizedPlanId,
          itinerary_route_ID: { not: normalizedRouteId },
          deleted: 0,
          status: 1,
        },
        select: {
          itinerary_route_ID: true,
          item_type: true,
          hotspot_ID: true,
          hotspot_order: true,
          hotspot_plan_own_way: true,
          hotspot_traveling_time: true,
          itinerary_travel_type_buffer_time: true,
          hotspot_start_time: true,
          hotspot_end_time: true,
          allow_break_hours: true,
          allow_via_route: true,
          via_location_name: true,
          hotspot_travelling_distance: true,
        },
      });
      const afterSnapshot = this.serializeSiblingHotspotSnapshot(siblingRowsAfter);
      if (afterSnapshot !== siblingHotspotSnapshot) {
        throw new BadRequestException(
          'Same-city scoped rebuild changed a sibling route hotspot, order, or timing; the rebuild was rejected as a regression.',
        );
      }
    }

    const failedStages = new Set(postProcessErrors.map((e) => e.stage));

    return {
      ...rebuildResult,
      parkingChargesRebuilt: !rebuildResult?.skipped && !failedStages.has('parkingCharges'),
      vehiclePricingRebuilt: !rebuildResult?.skipped && !failedStages.has('vehiclePricing'),
      postProcessErrors: postProcessErrors.length > 0 ? postProcessErrors : undefined,
    };
  }

  private serializeSiblingHotspotSnapshot(rows: any[]): string {
    return (rows || [])
      .map((row: any) => [
        Number(row?.itinerary_route_ID || 0),
        Number(row?.item_type || 0),
        Number(row?.hotspot_ID || 0),
        Number(row?.hotspot_order || 0),
        Number(row?.hotspot_plan_own_way || 0),
        this.serializeSnapshotTime(row?.hotspot_traveling_time),
        this.serializeSnapshotTime(row?.itinerary_travel_type_buffer_time),
        this.serializeSnapshotTime(row?.hotspot_start_time),
        this.serializeSnapshotTime(row?.hotspot_end_time),
        Number(row?.allow_break_hours || 0),
        Number(row?.allow_via_route || 0),
        String(row?.via_location_name || ''),
        String(row?.hotspot_travelling_distance || ''),
      ].join(':'))
      .sort()
      .join('|');
  }

  private serializeSnapshotTime(value: unknown): string {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toISOString().slice(11, 19);
    }
    return String(value ?? '').trim();
  }
}
