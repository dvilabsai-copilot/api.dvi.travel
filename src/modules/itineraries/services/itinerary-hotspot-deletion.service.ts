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

    const deletionResult = await this.prisma.$transaction(async (tx) => {
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

      

      const displacementRows = actualHotspotId > 0
        ? await (tx as any).dvi_itinerary_manual_hotspot_displacement.findMany({
            where: {
              itinerary_plan_ID: normalizedPlanId,
              itinerary_route_ID: normalizedRouteId,
              manual_hotspot_ID: actualHotspotId,
              deleted: 0,
              status: 1,
            },
            select: { displaced_hotspot_ID: true },
          })
        : [];
      const restoredHotspotIds = Array.from(new Set(
        displacementRows
          .map((row: any) => Number(row?.displaced_hotspot_ID || 0))
          .filter((id: number) => Number.isFinite(id) && id > 0),
      ));

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
  await (tx as any).dvi_itinerary_route_activity_details.updateMany({
    where: {
      itinerary_plan_ID: normalizedPlanId,
      itinerary_route_ID: normalizedRouteId,
      route_hotspot_ID: { in: routeHotspotIdsToDelete },
      deleted: 0,
    },
    data: {
      deleted: 1,
      status: 0,
      updatedon: new Date(),
    },
  });
}

const deleted = await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
  where: routeHotspotIdsToDelete.length > 0
    ? {
        itinerary_plan_ID: normalizedPlanId,
        itinerary_route_ID: normalizedRouteId,
        route_hotspot_ID: { in: routeHotspotIdsToDelete },
        deleted: 0,
      }
    : {
        itinerary_plan_ID: normalizedPlanId,
        itinerary_route_ID: normalizedRouteId,
        route_hotspot_ID: normalizedHotspotParam,
        deleted: 0,
      },
  data: {
    deleted: 1,
    status: 0,
    updatedon: new Date(),
  },
});

      if (deleted.count === 0) {
        throw new BadRequestException('Hotspot not found');
      }

      if (actualHotspotId > 0 && restoredHotspotIds.length === 0) {
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

      if (restoredHotspotIds.length > 0) {
        const targetRoute = await (tx as any).dvi_itinerary_route_details.findFirst({
          where: {
            itinerary_plan_ID: normalizedPlanId,
            itinerary_route_ID: normalizedRouteId,
            deleted: 0,
          },
          select: { itinerary_route_ID: true, excluded_hotspot_ids: true },
        });
        if (targetRoute) {
          const remainingDisplacements = await (tx as any).dvi_itinerary_manual_hotspot_displacement.findMany({
            where: {
              itinerary_plan_ID: normalizedPlanId,
              itinerary_route_ID: normalizedRouteId,
              manual_hotspot_ID: { not: actualHotspotId },
              displaced_hotspot_ID: { in: restoredHotspotIds },
              deleted: 0,
              status: 1,
            },
            select: { displaced_hotspot_ID: true },
          });
          const stillDisplaced = new Set(remainingDisplacements.map((row: any) => Number(row.displaced_hotspot_ID || 0)));
          const current = Array.isArray(targetRoute.excluded_hotspot_ids)
            ? targetRoute.excluded_hotspot_ids.map((id: any) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0)
            : [];
          await (tx as any).dvi_itinerary_route_details.update({
            where: { itinerary_route_ID: Number(targetRoute.itinerary_route_ID) },
            data: {
              excluded_hotspot_ids: current.filter((id: number) => !restoredHotspotIds.includes(id) || stillDisplaced.has(id)),
              updatedon: new Date(),
            },
          });
        }
        await (tx as any).dvi_itinerary_manual_hotspot_displacement.updateMany({
          where: {
            itinerary_plan_ID: normalizedPlanId,
            itinerary_route_ID: normalizedRouteId,
            manual_hotspot_ID: actualHotspotId,
            deleted: 0,
          },
          data: { deleted: 1, status: 0, updatedon: new Date() },
        });
      }

 // Trigger a full rebuild of the hotspots for this plan
 // This ensures travel times and hotel arrival are recalculated after deletion
 const existingHotspotsForRebuild: any[] =
  await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
    where: {
      itinerary_plan_ID: normalizedPlanId,
      item_type: 4,
    },
    orderBy: [
      { itinerary_route_ID: 'asc' },
      { hotspot_order: 'asc' },
      { route_hotspot_ID: 'asc' },
    ],
  });

const protectedExistingHotspotIds: number[] = Array.from(
  new Set<number>(
    existingHotspotsForRebuild
      .filter(
        (row: any) =>
          Number(row?.itinerary_route_ID || 0) === normalizedRouteId &&
          Number(row?.item_type || 0) === 4 &&
          Number(row?.deleted || 0) === 0 &&
          Number(row?.status || 0) === 1 &&
          Number(row?.hotspot_ID || 0) > 0,
      )
      .map((row: any) => Number(row.hotspot_ID)),
  ),
);

console.log('[deleteHotspot][REBUILD_CONTEXT]', {
  planId: normalizedPlanId,
  routeId: normalizedRouteId,
  deletedHotspotId: actualHotspotId,
  protectedExistingHotspotIds,
});

const rebuildResult = await this.hotspotEngine.rebuildRouteHotspots(
  tx,
  normalizedPlanId,
  existingHotspotsForRebuild,
  {
    scopeToRouteId: normalizedRouteId,
    protectedHotspotIds: protectedExistingHotspotIds,
  },
);

return {
  rebuildResult,
  restoredHotspotIds,
  deletedHotspotWasFitManual: restoredHotspotIds.length > 0,
};
   }, {
  timeout: 180000,
  maxWait: 30000,
});

 // Rebuild parking charges after deletion
    await this.hotspotEngine.rebuildParkingCharges(normalizedPlanId, userId);

 // Force full vehicle pricing rebuild from current rebuilt hotspot timeline.
    await this.forceRebuildVehiclePricingAfterHotspotChange(normalizedPlanId, normalizedRouteId);

    return {
      success: true,
      message: 'Hotspot deleted and vehicle pricing rebuilt from updated route timeline',
      parkingChargesRebuilt: true,
      vehiclePricingRebuilt: true,
      rebuildSummary: deletionResult.rebuildResult.rebuildSummary,
      warnings: deletionResult.rebuildResult.warnings,
      restoredHotspotIds: deletionResult.restoredHotspotIds,
      deletedHotspotWasFitManual: deletionResult.deletedHotspotWasFitManual,
    };
  }

 /**
   * Get available activities for a hotspot location
 */
}

