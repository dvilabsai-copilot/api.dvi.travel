import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { HotspotEngineService } from '../engines/hotspot-engine.service';

type ActivityCallbacks = {
  simulateActivityImpactBeforeAdd: (data: any) => Promise<any>;
  calculateActivityPlanPricing: (...args: any[]) => Promise<any>;
  timeToMinutes: (time: any) => number;
  addMinutesToTime: (time: any, minutes: number) => Date;
  checkActivityTimingConflicts: (...args: any[]) => any[];
};

@Injectable()
export class ItineraryActivityWorkflowService {
  private callbacks: ActivityCallbacks | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly hotspotEngine: HotspotEngineService,
  ) {}

  setCallbacks(callbacks: ActivityCallbacks): void {
    this.callbacks = callbacks;
  }

  private get policy(): ActivityCallbacks {
    if (!this.callbacks) throw new Error('Activity workflow callbacks are not configured');
    return this.callbacks;
  }

  private simulateActivityImpactBeforeAdd(data: any): Promise<any> {
    return this.policy.simulateActivityImpactBeforeAdd(data);
  }

  private calculateActivityPlanPricing(...args: any[]): Promise<any> {
    return this.policy.calculateActivityPlanPricing(...args);
  }

  private timeToMinutes(time: any): number {
    return this.policy.timeToMinutes(time);
  }

  private addMinutesToTime(time: any, minutes: number): Date {
    return this.policy.addMinutesToTime(time, minutes);
  }

  private checkActivityTimingConflicts(...args: any[]): any[] {
    return this.policy.checkActivityTimingConflicts(...args);
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

const activityPricing = await this.calculateActivityPlanPricing(
  {
    planId: data.planId,
    routeId: data.routeId,
    hotspotId: routeHotspot.hotspot_ID || data.hotspotId,
    activityId: data.activityId,
  },
  tx,
);

const computedActivityAmount =
  activityPricing.totalAmount > 0
    ? activityPricing.totalAmount
    : Number(data.amount || 0);

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
activity_amout: computedActivityAmount,
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
pricing: {
  pricingUnitType: activityPricing.pricingUnitType,
  adultRate: activityPricing.adultRate,
  childRate: activityPricing.childRate,
  unitRate: activityPricing.unitRate,
  adults: activityPricing.adults,
  children: activityPricing.children,
  totalAmount: computedActivityAmount,
  nationalityType: activityPricing.nationalityType,
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
}
