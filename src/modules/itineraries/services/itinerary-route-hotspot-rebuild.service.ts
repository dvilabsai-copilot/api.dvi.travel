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
          },
        });
        const existingHotspotsWithDates = oldHotspots.map((row: any) => ({
          ...row,
          route_date: oldRouteDateMap.get(Number(row.itinerary_route_ID || 0)),
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

        if (manualHotspotRows.length === 0 && existingExcludedHotspotIds.length === 0) {
          return {
            success: true,
            planId: normalizedPlanId,
            routeId: normalizedRouteId,
            message: 'Day route is already clean; no rebuild was needed',
            rebuildSummary: { totalRoutesProcessed: 0, totalHotspotsScheduled: 0, totalParkingRowsScheduled: 0 },
            warnings: [],
            routeRejectionSummaryByRoute: {},
            skipped: true,
          };
        }

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

        const engineResult = await this.hotspotEngine.rebuildRouteHotspots(tx, normalizedPlanId, existingHotspotsWithDates, {
          scopeToRouteId: normalizedRouteId,
        });
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
        this.callbacks.applySameCityCrossDayOptimizerAfterSave(normalizedPlanId, planQuoteId));
      await runPostRebuildStep('parkingCharges', () =>
        this.hotspotEngine.rebuildParkingCharges(normalizedPlanId, Number(userId || 1)));
      await runPostRebuildStep('vehiclePricing', () =>
        this.callbacks.forceRebuildVehiclePricingAfterHotspotChange(normalizedPlanId, normalizedRouteId));
    }

    const failedStages = new Set(postProcessErrors.map((e) => e.stage));

    return {
      ...rebuildResult,
      parkingChargesRebuilt: !rebuildResult?.skipped && !failedStages.has('parkingCharges'),
      vehiclePricingRebuilt: !rebuildResult?.skipped && !failedStages.has('vehiclePricing'),
      postProcessErrors: postProcessErrors.length > 0 ? postProcessErrors : undefined,
    };
  }
}
