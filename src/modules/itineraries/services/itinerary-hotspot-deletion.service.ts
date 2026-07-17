import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { HotspotEngineService } from '../engines/hotspot-engine.service';

/** Owns route-scoped hotspot deletion and dependent itinerary rebuilds. */
@Injectable()
export class ItineraryHotspotDeletionService {
  private forceRebuildVehiclePricingCallback: ((planId: number, routeId?: number) => Promise<any>) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly hotspotEngine: HotspotEngineService,
  ) {}

  setForceRebuildVehiclePricingCallback(callback: (planId: number, routeId?: number) => Promise<any>): void {
    this.forceRebuildVehiclePricingCallback = callback;
  }

  private forceRebuildVehiclePricingAfterHotspotChange(planId: number, routeId?: number) {
    if (!this.forceRebuildVehiclePricingCallback) {
      throw new Error('Hotspot deletion pricing callback is not configured');
    }
    return this.forceRebuildVehiclePricingCallback(planId, routeId);
  }
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
        console.log(`[deleteHotspot] Excluding hotspotId ${actualHotspotId} only for route ${normalizedRouteId}`);

        const targetRoute = await (tx as any).dvi_itinerary_route_details.findFirst({
          where: {
            itinerary_plan_ID: normalizedPlanId,
            itinerary_route_ID: normalizedRouteId,
            deleted: 0,
          },
          select: {
            itinerary_route_ID: true,
            excluded_hotspot_ids: true,
          },
        });

        if (targetRoute) {
          const current = Array.isArray(targetRoute.excluded_hotspot_ids)
            ? targetRoute.excluded_hotspot_ids
                .map((id: any) => Number(id))
                .filter((id: number) => Number.isFinite(id) && id > 0)
            : [];

          if (!current.includes(actualHotspotId)) {
            await (tx as any).dvi_itinerary_route_details.update({
              where: {
                itinerary_route_ID: Number(targetRoute.itinerary_route_ID),
              },
              data: {
                excluded_hotspot_ids: [...current, actualHotspotId],
                updatedon: new Date(),
              },
            });
          }
        }
      }

      // Trigger a full rebuild of the hotspots for this plan
      // This ensures travel times and hotel arrival are recalculated after deletion
      return await this.hotspotEngine.rebuildRouteHotspots(tx, normalizedPlanId);
    }, { timeout: 60000 });

        // Rebuild parking charges after deletion
    await this.hotspotEngine.rebuildParkingCharges(normalizedPlanId, userId);

    // Force full vehicle pricing rebuild from current rebuilt hotspot timeline.
    await this.forceRebuildVehiclePricingAfterHotspotChange(normalizedPlanId, normalizedRouteId);

    return {
      success: true,
      message: 'Hotspot deleted and vehicle pricing rebuilt from updated route timeline',
      parkingChargesRebuilt: true,
      vehiclePricingRebuilt: true,
      rebuildSummary: rebuildResult.rebuildSummary,
      warnings: rebuildResult.warnings,
    };
  }

  /**
   * Get available activities for a hotspot location
   */
}

