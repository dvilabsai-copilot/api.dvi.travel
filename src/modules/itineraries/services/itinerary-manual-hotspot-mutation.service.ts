// FILE: src/modules/itineraries/services/itinerary-manual-hotspot-mutation.service.ts

import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { HotspotEngineService } from '../engines/hotspot-engine.service';

type ManualHotspotMutationCallbacks = Partial<Record<
  'timeToMinutes'
  | 'runManualHotspotBatchWithinTransaction'
  | 'cleanupStaleManualHotspotRows'
  | 'forceRebuildVehiclePricingAfterHotspotChange'
  | 'estimateDurationFromDistance'
  | 'computeRowDurationMinutes'
  | 'parsePreviewTimeRangeToUtcDates'
  | 'minutesToUtcTimeDate'
  | 'normalizeManualHotspotIds'
  | 'isRetryableManualPreviewTransactionError',
  (...args: any[]) => any
>>;

type ManualHotspotTimingPolicy = any;


@Injectable()
export class ItineraryManualHotspotMutationService {
  private callbacks: ManualHotspotMutationCallbacks = {};

  constructor(
    private readonly prisma: PrismaService,
    private readonly hotspotEngine: HotspotEngineService,
  ) {}

  setCallbacks(callbacks: ManualHotspotMutationCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  private call(name: keyof ManualHotspotMutationCallbacks, ...args: any[]) {
    const callback = this.callbacks[name];
    if (!callback) {
      throw new Error(`Manual hotspot mutation callback is not configured: ${String(name)}`);
    }
    return callback(...args);
  }

  private timeToMinutes(...args: any[]) { return this.call('timeToMinutes', ...args); }
  private runManualHotspotBatchWithinTransaction(...args: any[]) { return this.call('runManualHotspotBatchWithinTransaction', ...args); }
  private cleanupStaleManualHotspotRows(...args: any[]) { return this.call('cleanupStaleManualHotspotRows', ...args); }
  private forceRebuildVehiclePricingAfterHotspotChange(...args: any[]) { return this.call('forceRebuildVehiclePricingAfterHotspotChange', ...args); }
  private estimateDurationFromDistance(...args: any[]) { return this.call('estimateDurationFromDistance', ...args); }
  private computeRowDurationMinutes(...args: any[]) { return this.call('computeRowDurationMinutes', ...args); }
  private parsePreviewTimeRangeToUtcDates(...args: any[]) { return this.call('parsePreviewTimeRangeToUtcDates', ...args); }
  private minutesToUtcTimeDate(...args: any[]) { return this.call('minutesToUtcTimeDate', ...args); }
  private normalizeManualHotspotIds(...args: any[]) { return this.call('normalizeManualHotspotIds', ...args); }
  private isRetryableManualPreviewTransactionError(...args: any[]) { return this.call('isRetryableManualPreviewTransactionError', ...args); }

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
    const existing = await this.prisma.dvi_itinerary_route_hotspot_details.findFirst({
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

    const batchResult = await this.applyManualHotspotsBatch(planId, routeId, [hotspotId], userId, {
      anchorType: anchor?.anchorType,
      anchorIndex: anchor?.anchorIndex,
      allowTopPriorityRemoval: anchor?.allowTopPriorityRemoval === true,
    });

    const insertedHotspot = Array.isArray(batchResult?.resolution?.scheduledManualHotspots)
      ? batchResult.resolution.scheduledManualHotspots.find((row: any) => Number(row?.id) === Number(hotspotId)) || null
      : null;

    return {
      ...batchResult,
      hotspotId: Number(hotspotId),
      hotspotName: insertedHotspot?.name || batchResult?.newHotspot?.text || null,
      alreadyExisted: Number(existing?.hotspot_plan_own_way || 0) === 1,
      insertedHotspot: insertedHotspot
        ? {
            hotspotId: Number(insertedHotspot.id),
            name: insertedHotspot.name,
            visitTime: insertedHotspot.visitTime || null,
            startTime: insertedHotspot.visitTime ? String(insertedHotspot.visitTime).split('-')[0]?.trim() || null : null,
            endTime: insertedHotspot.visitTime ? String(insertedHotspot.visitTime).split('-')[1]?.trim() || null : null,
            isConflict: false,
          }
        : null,
      routeTimeline: batchResult?.fullTimeline,
    };
  }

  async applyManualHotspotsBatch(
    planId: number,
    routeId: number,
    hotspotIds: number[],
    userId: number,
    options?: {
      anchorType?: 'after_travel' | 'BETWEEN_ROWS';
      anchorIndex?: number;
      allowTopPriorityRemoval?: boolean;
      forceConflictInsertion?: boolean;
      manualTimingPolicy?: ManualHotspotTimingPolicy;
      matrixPreferredSlot?: {
        fromHotspotId?: number;
        toHotspotId?: number;
        slotIndex?: number;
        source?: 'BEST_FIT' | 'EXACT_ANCHOR';
      };
    },
  ) {
    const normalizedApplyHotspotIds = this.normalizeManualHotspotIds(hotspotIds);
    await this.cleanupStaleManualHotspotRows(Number(planId), Number(routeId), normalizedApplyHotspotIds);

    const manualHotspotTxTimeoutMs = 180000;
    const applyRollbackError = new Error('__APPLY_MANUAL_HOTSPOT_BATCH_ROLLBACK__');
    let applyResult: any;
    const maxApplyAttempts = 3;

    for (let attempt = 1; attempt <= maxApplyAttempts; attempt += 1) {
      try {
        await this.prisma.$transaction(async (tx) => {
          applyResult = await this.runManualHotspotBatchWithinTransaction(
            tx,
            Number(planId),
            Number(routeId),
            hotspotIds,
            Number(userId || 1),
            {
              ...options,
              previewOnly: false,
            },
          );

          // Non-success apply responses should not persist any intermediate rebuild/removal state.
          if (applyResult?.success !== true || applyResult?.inserted !== true) {
            throw applyRollbackError;
          }
        }, { timeout: manualHotspotTxTimeoutMs });
        break;
      } catch (error: any) {
        if (error === applyRollbackError) {
          break;
        }

        if (!this.isRetryableManualPreviewTransactionError(error) || attempt >= maxApplyAttempts) {
          await this.cleanupStaleManualHotspotRows(Number(planId), Number(routeId), normalizedApplyHotspotIds);
          throw error;
        }

        console.warn('[ManualFit][apply_tx_retry]', {
          planId: Number(planId),
          routeId: Number(routeId),
          hotspotIds: normalizedApplyHotspotIds,
          attempt,
          maxApplyAttempts,
          message: String(error?.message || ''),
        });
        await new Promise((resolve) => setTimeout(resolve, attempt * 100));
      }
    }

    if (applyResult) {
      const persistedTimeline = Array.isArray(applyResult?.routeTimeline)
        ? applyResult.routeTimeline
        : (Array.isArray(applyResult?.fullTimeline) ? applyResult.fullTimeline : []);

      for (const hotspotId of normalizedApplyHotspotIds) {
        const timelineRow = persistedTimeline.find((row: any) => (
          (
            String(row?.type || '').toLowerCase() === 'attraction'
            || Number(row?.item_type || 0) === 4
          )
          && Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0) === Number(hotspotId)
        ));
        let parsedRange = this.parsePreviewTimeRangeToUtcDates(timelineRow?.timeRange);
        const parsedDurationMinutes = (parsedRange.start && parsedRange.end)
          ? Math.round((parsedRange.end.getTime() - parsedRange.start.getTime()) / 60000)
          : 0;
        const selectedMaster = await this.prisma.dvi_hotspot_place.findFirst({
          where: {
            hotspot_ID: Number(hotspotId),
            deleted: 0,
          },
          select: {
            hotspot_duration: true,
          },
        });
        const selectedDurationMin = selectedMaster?.hotspot_duration
          ? Math.max(1, Number(this.timeToMinutes(selectedMaster.hotspot_duration as any)) || 0)
          : 60;

        if (!parsedRange.start || !parsedRange.end || parsedDurationMinutes <= 0) {
          const fit = applyResult?.manualInsertionFit?.bestSlot || applyResult?.manualInsertionFit?.chosenSlot || null;
          const fromHotspotId = Number(fit?.fromHotspotId || 0);
          if (fromHotspotId > 0) {
            const fromAttraction = await this.prisma.dvi_itinerary_route_hotspot_details.findFirst({
              where: {
                itinerary_plan_ID: Number(planId),
                itinerary_route_ID: Number(routeId),
                hotspot_ID: fromHotspotId,
                item_type: 4,
                deleted: 0,
                status: 1,
              },
              select: {
                hotspot_end_time: true,
              },
            });

            const fromEndDate = fromAttraction?.hotspot_end_time ? new Date(fromAttraction.hotspot_end_time as any) : null;
            const acDurationMin = this.estimateDurationFromDistance(Number(fit?.acOsrmDistanceKm || null)) || 10;

            if (fromEndDate && Number.isFinite(fromEndDate.getTime())) {
              const start = new Date(fromEndDate.getTime() + (Math.max(0, acDurationMin) * 60000));
              const end = new Date(start.getTime() + (Math.max(1, selectedDurationMin) * 60000));
              parsedRange = { start, end };
            }
          }

          const unresolvedDurationMinutes = (parsedRange.start && parsedRange.end)
            ? Math.round((parsedRange.end.getTime() - parsedRange.start.getTime()) / 60000)
            : 0;

          if (!parsedRange.start || !parsedRange.end || unresolvedDurationMinutes <= 0) {
            const selectedPersistedRow = await this.prisma.dvi_itinerary_route_hotspot_details.findFirst({
              where: {
                itinerary_plan_ID: Number(planId),
                itinerary_route_ID: Number(routeId),
                hotspot_ID: Number(hotspotId),
                item_type: 4,
                deleted: 0,
                status: 1,
              },
              orderBy: { route_hotspot_ID: 'desc' },
              select: {
                hotspot_order: true,
              },
            });

            const selectedOrder = Number(selectedPersistedRow?.hotspot_order || 0);
            let fallbackStart: Date | null = null;

            if (selectedOrder > 0) {
              const previousAttraction = await this.prisma.dvi_itinerary_route_hotspot_details.findFirst({
                where: {
                  itinerary_plan_ID: Number(planId),
                  itinerary_route_ID: Number(routeId),
                  item_type: 4,
                  deleted: 0,
                  status: 1,
                  hotspot_order: { lt: selectedOrder },
                },
                orderBy: [
                  { hotspot_order: 'desc' },
                  { route_hotspot_ID: 'desc' },
                ],
                select: {
                  hotspot_end_time: true,
                },
              });

              if (previousAttraction?.hotspot_end_time) {
                const prevEnd = new Date(previousAttraction.hotspot_end_time as any);
                if (Number.isFinite(prevEnd.getTime())) {
                  fallbackStart = prevEnd;
                }
              }
            }

            if (!fallbackStart) {
              const routeWindow = await this.prisma.dvi_itinerary_route_details.findUnique({
                where: { itinerary_route_ID: Number(routeId) },
                select: { route_start_time: true },
              });
              if (routeWindow?.route_start_time) {
                const routeStart = new Date(routeWindow.route_start_time as any);
                if (Number.isFinite(routeStart.getTime())) {
                  fallbackStart = routeStart;
                }
              }
            }

            if (fallbackStart) {
              const end = new Date(fallbackStart.getTime() + (Math.max(1, selectedDurationMin) * 60000));
              parsedRange = { start: fallbackStart, end };
            }
          }
        }

        if (!parsedRange.start || !parsedRange.end) continue;
        const finalDurationMinutes = Math.round((parsedRange.end.getTime() - parsedRange.start.getTime()) / 60000);
        if (finalDurationMinutes <= 0) continue;

        const persistedRow = await this.prisma.dvi_itinerary_route_hotspot_details.findFirst({
          where: {
            itinerary_plan_ID: Number(planId),
            itinerary_route_ID: Number(routeId),
            hotspot_ID: Number(hotspotId),
            item_type: 4,
            deleted: 0,
            status: 1,
          },
          select: { route_hotspot_ID: true },
        });

        if (!persistedRow?.route_hotspot_ID) continue;

        await this.prisma.dvi_itinerary_route_hotspot_details.update({
          where: { route_hotspot_ID: Number(persistedRow.route_hotspot_ID) },
          data: {
            hotspot_start_time: parsedRange.start,
            hotspot_end_time: parsedRange.end,
            hotspot_traveling_time: this.minutesToUtcTimeDate(Math.max(1, finalDurationMinutes)),
            updatedon: new Date(),
            is_conflict: 0,
            conflict_reason: null,
          },
        });
      }

      if (applyResult?.success === true && applyResult?.inserted === true) {
        for (const hotspotId of normalizedApplyHotspotIds) {
          const persistedRow = await this.prisma.dvi_itinerary_route_hotspot_details.findFirst({
            where: {
              itinerary_plan_ID: Number(planId),
              itinerary_route_ID: Number(routeId),
              hotspot_ID: Number(hotspotId),
              item_type: 4,
              hotspot_plan_own_way: 1,
              deleted: 0,
              status: 1,
            },
            orderBy: { route_hotspot_ID: 'desc' },
            select: {
              route_hotspot_ID: true,
              hotspot_start_time: true,
              hotspot_end_time: true,
            },
          });

          const durationMinutes = this.computeRowDurationMinutes({
            hotspot_start_time: persistedRow?.hotspot_start_time,
            hotspot_end_time: persistedRow?.hotspot_end_time,
          });

          if (!persistedRow?.route_hotspot_ID || durationMinutes <= 0) {
            throw new InternalServerErrorException({
              code: 'MANUAL_HOTSPOT_PERSISTENCE_DURATION_INVALID',
              message: 'Manual hotspot apply persisted an invalid zero-duration row.',
              diagnostics: {
                planId: Number(planId),
                routeId: Number(routeId),
                hotspotId: Number(hotspotId),
                routeHotspotId: Number(persistedRow?.route_hotspot_ID || 0) || null,
                hotspotStartTime: persistedRow?.hotspot_start_time || null,
                hotspotEndTime: persistedRow?.hotspot_end_time || null,
                durationMinutes,
                applyCode: String(applyResult?.code || ''),
              },
            });
          }
        }
      }
    }

    if (applyResult?.success === true && applyResult?.inserted === true) {
      await this.hotspotEngine.rebuildParkingCharges(Number(planId), Number(userId || 1));

      await this.forceRebuildVehiclePricingAfterHotspotChange(
        Number(planId),
        Number(routeId),
      );

      return {
        ...applyResult,
        parkingChargesRebuilt: true,
        vehiclePricingRebuilt: true,
      };
    }

    return applyResult;
  }

}
