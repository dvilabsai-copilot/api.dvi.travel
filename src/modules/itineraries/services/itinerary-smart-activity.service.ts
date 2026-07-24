import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';

type SmartActivityCallbacks = {
  timeToMinutes: (time: any) => number;
  addMinutesToTime: (time: any, minutes: number) => Date;
  checkActivityTimingConflicts: (...args: any[]) => any[];
  formatTime: (time: any) => string;
};

@Injectable()
export class ItinerarySmartActivityService {
  private callbacks: SmartActivityCallbacks | null = null;

  constructor(private readonly prisma: PrismaService) {}

  setCallbacks(callbacks: SmartActivityCallbacks): void {
    this.callbacks = callbacks;
  }

  private get policy(): SmartActivityCallbacks {
    if (!this.callbacks) throw new Error('Smart activity callbacks are not configured');
    return this.callbacks;
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

  private formatTime(time: any): string {
    return this.policy.formatTime(time);
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
}
