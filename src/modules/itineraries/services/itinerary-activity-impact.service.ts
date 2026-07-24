import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { HotspotEngineService } from '../engines/hotspot-engine.service';

type ActivityImpactCallbacks = {
  timeToMinutes: (...args: any[]) => number;
  addMinutesToTime: (...args: any[]) => Date;
};

@Injectable()
export class ItineraryActivityImpactService {
  private callbacks: ActivityImpactCallbacks = {
    timeToMinutes: () => 0,
    addMinutesToTime: (time: Date, minutes: number) => new Date(time.getTime() + (minutes * 60000)),
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly hotspotEngine: HotspotEngineService,
  ) {}

  setCallbacks(callbacks: Partial<ActivityImpactCallbacks>) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  async simulateActivityImpactBeforeAdd(data: {
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
      ? this.callbacks.timeToMinutes(activity.activity_duration)
      : 30;
    const activityEndTime = this.callbacks.addMinutesToTime(activityStartTime, durationMinutes);

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
          ? this.callbacks.addMinutesToTime(h.hotspot_start_time, extensionMinutes)
          : null,
        projectedEnd: h.hotspot_end_time
          ? this.callbacks.addMinutesToTime(h.hotspot_end_time, extensionMinutes)
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
}
