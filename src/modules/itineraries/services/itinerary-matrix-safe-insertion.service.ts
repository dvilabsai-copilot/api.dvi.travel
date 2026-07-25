// FILE: src/modules/itineraries/services/itinerary-matrix-safe-insertion.service.ts

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { TimeConverter } from '../engines/helpers/time-converter';

type ManualHotspotTimingPolicy = any;
type MatrixSafeInsertionCallbacks = Record<string, (...args: any[]) => any>;

@Injectable()
export class ItineraryMatrixSafeInsertionService {
  private callbacks: MatrixSafeInsertionCallbacks = {};

  constructor(private readonly prisma: PrismaService) {}

  setCallbacks(callbacks: MatrixSafeInsertionCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  private activateManualHotspotRowWithTimes(...args: any[]): any { return this.callbacks.activateManualHotspotRowWithTimes?.(...args); }
  private addRouteHotspotToExcludedList(...args: any[]): any { return this.callbacks.addRouteHotspotToExcludedList?.(...args); }
  private buildManualFitTimelineFingerprint(...args: any[]): any { return this.callbacks.buildManualFitTimelineFingerprint?.(...args); }
  private buildMatrixRescheduledPreviewTimeline(...args: any[]): any { return this.callbacks.buildMatrixRescheduledPreviewTimeline?.(...args); }
  private calculateRouteEndOverflowMinutes(...args: any[]): any { return this.callbacks.calculateRouteEndOverflowMinutes?.(...args); }
  private cloneTimelineRowsForPreview(...args: any[]): any { return this.callbacks.cloneTimelineRowsForPreview?.(...args); }
  private computeRowDurationMinutes(...args: any[]): any { return this.callbacks.computeRowDurationMinutes?.(...args); }
  private enrichManualFitPreviewTimelineWithOperatingHours(...args: any[]): any { return this.callbacks.enrichManualFitPreviewTimelineWithOperatingHours?.(...args); }
  private getCachedRouteMatrixLeg(...args: any[]): any { return this.callbacks.getCachedRouteMatrixLeg?.(...args); }
  private getPreviewRowDurationMinutes(...args: any[]): any { return this.callbacks.getPreviewRowDurationMinutes?.(...args); }
  private getRouteTimelineForScoring(...args: any[]): any { return this.callbacks.getRouteTimelineForScoring?.(...args); }
  private getSelectedManualClosingOverflow(...args: any[]): any { return this.callbacks.getSelectedManualClosingOverflow?.(...args); }
  private hmsToSeconds(...args: any[]): any { return this.callbacks.hmsToSeconds?.(...args); }
  private minutesToUtcTimeDate(...args: any[]): any { return this.callbacks.minutesToUtcTimeDate?.(...args); }
  private parsePreviewTimeRangeToUtcDates(...args: any[]): any { return this.callbacks.parsePreviewTimeRangeToUtcDates?.(...args); }
  private removeRouteHotspotFromExcludedList(...args: any[]): any { return this.callbacks.removeRouteHotspotFromExcludedList?.(...args); }
  private resolveProgressivePriorityRemovalForManualFitInTx(...args: any[]): any { return this.callbacks.resolveProgressivePriorityRemovalForManualFitInTx?.(...args); }
  private resolveSelectedManualPriority(...args: any[]): any { return this.callbacks.resolveSelectedManualPriority?.(...args); }
  private resolveSourceToHotspotLeg(...args: any[]): any { return this.callbacks.resolveSourceToHotspotLeg?.(...args); }
  private validateStrictMatrixTimeline(...args: any[]): any { return this.callbacks.validateStrictMatrixTimeline?.(...args); }
  async applyMatrixSafeManualHotspotInsertionInTx(
    tx: any,
    params: {
      planId: number;
      routeId: number;
      selectedHotspotIds: number[];
      userId: number;
      manualInsertionFit: any;
      manualTimingPolicy?: ManualHotspotTimingPolicy;
      matrixPreferredSlot?: {
        fromHotspotId?: number;
        toHotspotId?: number;
        slotIndex?: number;
        source?: 'BEST_FIT' | 'EXACT_ANCHOR';
      };
      trustedPreviewConfirmation?: boolean;
      trustedPreviewTimeline?: any[] | null;
      trustedPreviewTimelineFingerprint?: string | null;
      enforceTrustedPreviewConfirmation?: boolean;
      allowP3Removal?: boolean;
      allowP1P2Removal?: boolean;
      allowTopPriorityRemoval?: boolean;
      skipPostApplyAssertions?: boolean;
    },
  ): Promise<any> {
    const planId = Number(params?.planId || 0);
    const routeId = Number(params?.routeId || 0);
    const selectedHotspotIds = Array.isArray(params?.selectedHotspotIds)
      ? params.selectedHotspotIds.map((id: any) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0)
      : [];
    const userId = Number(params?.userId || 1);
    const manualInsertionFit = params?.manualInsertionFit || null;
    const manualTimingPolicy = params?.manualTimingPolicy || null;
    const matrixPreferredSlot = params?.matrixPreferredSlot || null;
    const skipPostApplyAssertions = params?.skipPostApplyAssertions === true;
    const fitSelectedId = Number(manualInsertionFit?.selectedHotspotId || manualInsertionFit?.hotspotId || 0);

    let effectiveSelectedHotspotIds = [...selectedHotspotIds];
    if (fitSelectedId > 0) {
      effectiveSelectedHotspotIds = [fitSelectedId];
    }

    effectiveSelectedHotspotIds = Array.from(new Set(
      effectiveSelectedHotspotIds
        .map((id: any) => Number(id || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    ));

    if (effectiveSelectedHotspotIds.length === 0) {
      throw new BadRequestException('At least one hotspot is required');
    }

    const activeRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        itinerary_route_ID: routeId,
        item_type: 4,
        deleted: 0,
        status: 1,
        hotspot_ID: { in: effectiveSelectedHotspotIds },
      },
      select: {
        hotspot_ID: true,
        hotspot_plan_own_way: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
        is_conflict: true,
      },
    });

    const activeIds = new Set<number>(
      (activeRows || [])
        .filter((row: any) => this.computeRowDurationMinutes(row) > 0 && Number(row?.is_conflict || 0) !== 1)
        .map((row: any) => Number(row?.hotspot_ID || 0))
        .filter((id: number) => id > 0),
    );

    const newSelectedHotspotIds = effectiveSelectedHotspotIds
      .filter((id: number) => !activeIds.has(Number(id)));
    if (newSelectedHotspotIds.length === 0) {
      return {
        success: true,
        inserted: false,
        alreadyExists: true,
        code: 'MANUAL_HOTSPOT_ALREADY_EXISTS_IN_ROUTE',
        message: 'This hotspot is already added to this route.',
        planId,
        routeId,
        hotspotIds: effectiveSelectedHotspotIds,
      };
    }

    if (newSelectedHotspotIds.length > 1) {
      throw new BadRequestException('Matrix-safe apply supports one new manual hotspot at a time. Please preview and add one hotspot.');
    }

    const selectedHotspotId = Number(newSelectedHotspotIds[0]);
    const bestSlot = manualInsertionFit?.bestSlot || null;
    const bestRouteFitType = String(bestSlot?.routeFitType || '').toUpperCase();
    const bestSlotContext = String(bestSlot?.slotContext || '').toUpperCase();
    const bestFrom = Number(bestSlot?.fromHotspotId || 0);
    const bestTo = Number(bestSlot?.toHotspotId || 0);
    const exactAnchorSelected =
      String(matrixPreferredSlot?.source || bestSlot?.source || manualInsertionFit?.chosenSlot?.source || '')
        .trim()
        .toUpperCase() === 'EXACT_ANCHOR';
    const isNormalMatrixSlot =
      bestRouteFitType === 'ON_ROUTE' || bestRouteFitType === 'MINOR_DETOUR';
    const isSingleHotspotBeforeSlot =
      bestRouteFitType === 'SINGLE_HOTSPOT_BEFORE';
    const isSingleHotspotAfterSlot =
      bestRouteFitType === 'SINGLE_HOTSPOT_AFTER';
    const isDestinationSideSlot =
      bestRouteFitType === 'DESTINATION_SIDE_INSERTION';
    const isCityEndpointBeforeSlot =
      bestSlotContext === 'CITY_TO_HOTSPOT';
    const isCityEndpointAfterSlot =
      bestSlotContext === 'HOTSPOT_TO_CITY';
    const isCityToCitySlot =
      bestSlotContext === 'CITY_TO_CITY';
    const matrixSlotValid =
      !!bestSlot
      && (
        (
          isNormalMatrixSlot
          && bestFrom > 0
          && bestTo > 0
          && selectedHotspotId !== bestFrom
          && selectedHotspotId !== bestTo
        )
        || (
          isSingleHotspotBeforeSlot
          && bestTo > 0
          && selectedHotspotId !== bestTo
        )
        || (
          isSingleHotspotAfterSlot
          && bestFrom > 0
          && selectedHotspotId !== bestFrom
        )
        || (
          isDestinationSideSlot
          && bestFrom > 0
          && selectedHotspotId !== bestFrom
        )
        || (
          isCityEndpointBeforeSlot
          && bestTo > 0
          && selectedHotspotId !== bestTo
        )
        || (
          isCityEndpointAfterSlot
          && bestFrom > 0
          && selectedHotspotId !== bestFrom
        )
        || (
          isCityToCitySlot
          && selectedHotspotId > 0
        )
        || (
          exactAnchorSelected
          && (
            (
              bestFrom > 0
              && bestTo > 0
              && selectedHotspotId !== bestFrom
              && selectedHotspotId !== bestTo
            )
            || (
              bestFrom > 0
              && bestTo <= 0
              && selectedHotspotId !== bestFrom
            )
            || (
              bestTo > 0
              && bestFrom <= 0
              && selectedHotspotId !== bestTo
            )
          )
        )
      );

    const payloadMatchesBest = !matrixPreferredSlot
      || exactAnchorSelected
      || (
        Number(matrixPreferredSlot?.fromHotspotId || 0) === bestFrom
        && Number(matrixPreferredSlot?.toHotspotId || 0) === bestTo
      );

    if (!matrixSlotValid || !payloadMatchesBest) {
      throw new ConflictException({
        success: false,
        inserted: false,
        code: 'MATRIX_SAFE_SLOT_INVALID',
        message: 'Selected insertion slot is not valid for apply.',
      });
    }

    const route = await (tx as any).dvi_itinerary_route_details.findFirst({
      where: {
        itinerary_route_ID: routeId,
        itinerary_plan_ID: planId,
        deleted: 0,
      },
    });

    if (!route) {
      throw new NotFoundException('Route not found for this itinerary plan');
    }

    const beforeRouteRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        itinerary_route_ID: routeId,
        deleted: 0,
        status: 1,
      },
      orderBy: [
        { hotspot_order: 'asc' },
        { route_hotspot_ID: 'asc' },
      ],
    });

    const beforeAttractions = beforeRouteRows
      .filter((row: any) => Number(row?.item_type || 0) === 4)
      .sort((a: any, b: any) => Number(a?.hotspot_order || 0) - Number(b?.hotspot_order || 0));
    const beforeAttractionIds = beforeAttractions.map((row: any) => Number(row?.hotspot_ID || 0)).filter((id: number) => id > 0);
    const beforeAttractionByHotspotId = new Map<number, any>();
    for (const row of beforeAttractions) {
      const hotspotId = Number(row?.hotspot_ID || 0);
      if (!hotspotId || beforeAttractionByHotspotId.has(hotspotId)) continue;
      beforeAttractionByHotspotId.set(hotspotId, row);
    }

    const beforePlanAttractions = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        item_type: 4,
        deleted: 0,
        status: 1,
      },
      select: {
        itinerary_route_ID: true,
        hotspot_ID: true,
        hotspot_order: true,
        route_hotspot_ID: true,
      },
      orderBy: [
        { itinerary_route_ID: 'asc' },
        { hotspot_order: 'asc' },
        { route_hotspot_ID: 'asc' },
      ],
    });

    const beforeByRoute = new Map<number, number[]>();
    for (const row of beforePlanAttractions || []) {
      const rid = Number(row?.itinerary_route_ID || 0);
      if (!beforeByRoute.has(rid)) beforeByRoute.set(rid, []);
      beforeByRoute.get(rid)!.push(Number(row?.hotspot_ID || 0));
    }

    const selectedAlreadyInRoute = await (tx as any).dvi_itinerary_route_hotspot_details.findFirst({
      where: {
        itinerary_plan_ID: planId,
        itinerary_route_ID: routeId,
        hotspot_ID: selectedHotspotId,
        item_type: 4,
        deleted: 0,
        status: 1,
      },
      select: {
        route_hotspot_ID: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
        is_conflict: true,
      },
    });

    if (selectedAlreadyInRoute
      && this.computeRowDurationMinutes(selectedAlreadyInRoute) > 0
      && Number(selectedAlreadyInRoute?.is_conflict || 0) !== 1) {
      return {
        success: true,
        inserted: false,
        alreadyExists: true,
        code: 'MANUAL_HOTSPOT_ALREADY_EXISTS_IN_ROUTE',
        message: 'This hotspot is already added to the itinerary.',
        planId,
        routeId,
        hotspotId: selectedHotspotId,
        hotspotIds: [selectedHotspotId],
        manualInsertionFit,
      };
    }

    await this.removeRouteHotspotFromExcludedList(tx, routeId, selectedHotspotId, route);

    const routeAttractions = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        itinerary_route_ID: routeId,
        item_type: 4,
        deleted: 0,
        status: 1,
      },
      orderBy: [
        { hotspot_order: 'asc' },
        { route_hotspot_ID: 'asc' },
      ],
      select: {
        route_hotspot_ID: true,
        hotspot_ID: true,
        hotspot_order: true,
      },
    });

    const baseAttractions = routeAttractions.filter((row: any) => Number(row?.hotspot_ID || 0) !== selectedHotspotId);
    const baseIds = baseAttractions.map((row: any) => Number(row?.hotspot_ID || 0));
    let newOrderIds = [...baseIds];

    if (isCityToCitySlot) {
      newOrderIds = [selectedHotspotId];
    } else if (isSingleHotspotBeforeSlot || isCityEndpointBeforeSlot) {
      const anchorIndex = baseIds.findIndex((id: number) => id === bestTo);

      if (anchorIndex < 0) {
        throw new ConflictException({
          success: false,
          inserted: false,
          code: 'SINGLE_HOTSPOT_SLOT_INVALID',
          message: 'Single-hotspot before slot anchor was not found in this route.',
        });
      }

      newOrderIds.splice(anchorIndex, 0, selectedHotspotId);
    } else if (isSingleHotspotAfterSlot || isDestinationSideSlot || isCityEndpointAfterSlot) {
      const anchorIndex = baseIds.findIndex((id: number) => id === bestFrom);

      if (anchorIndex < 0) {
        throw new ConflictException({
          success: false,
          inserted: false,
          code: 'SINGLE_HOTSPOT_SLOT_INVALID',
          message: 'Single-hotspot after slot anchor was not found in this route.',
        });
      }

      newOrderIds.splice(anchorIndex + 1, 0, selectedHotspotId);
    } else {
      const fromIndex = baseIds.findIndex((id: number) => id === bestFrom);
      const toIndex = fromIndex >= 0 ? fromIndex + 1 : -1;

      if (fromIndex < 0 || toIndex >= baseIds.length || baseIds[toIndex] !== bestTo) {
        throw new ConflictException({
          success: false,
          inserted: false,
          code: 'MATRIX_SAFE_SLOT_INVALID',
          message: 'Matrix slot endpoints are not consecutive in this route.',
        });
      }

      newOrderIds.splice(fromIndex + 1, 0, selectedHotspotId);
    }

    const rowByHotspotId = new Map<number, number>();
    for (const row of routeAttractions) {
      const hid = Number(row?.hotspot_ID || 0);
      if (!hid || rowByHotspotId.has(hid)) continue;
      rowByHotspotId.set(hid, Number(row?.route_hotspot_ID || 0));
    }

    for (let i = 0; i < newOrderIds.length; i += 1) {
      const hid = Number(newOrderIds[i]);
      const rowId = Number(rowByHotspotId.get(hid) || 0);
      if (!rowId) continue;
      await (tx as any).dvi_itinerary_route_hotspot_details.update({
        where: { route_hotspot_ID: rowId },
        data: {
          hotspot_order: i + 1,
          hotspot_plan_own_way: hid === selectedHotspotId ? 1 : undefined,
          updatedon: new Date(),
        },
      });
    }

    const selectedMaster = await (tx as any).dvi_hotspot_place.findFirst({
      where: { hotspot_ID: selectedHotspotId, deleted: 0 },
      select: {
        hotspot_ID: true,
        hotspot_name: true,
        hotspot_priority: true,
        hotspot_duration: true,
      },
    });

    const routeEndMinutesApply = manualTimingPolicy?.endTime
      ? Math.floor(this.hmsToSeconds(TimeConverter.toTimeString(manualTimingPolicy.endTime)) / 60)
      : (
          route?.route_end_time
            ? Math.floor(this.hmsToSeconds(TimeConverter.toTimeString(route.route_end_time)) / 60)
            : 23 * 60
        );
    const baselineTimeline = await this.getRouteTimelineForScoring(tx, planId, routeId);
    let adjustedTimeline = params.trustedPreviewConfirmation === true
      && Array.isArray(params.trustedPreviewTimeline)
      && params.trustedPreviewTimeline.length > 0
        ? this.cloneTimelineRowsForPreview(params.trustedPreviewTimeline)
        : null;
    adjustedTimeline = adjustedTimeline
      || await this.buildMatrixRescheduledPreviewTimeline({
          routeId,
          baselineTimeline,
          enginePreviewTimeline: baselineTimeline,
          manualInsertionFit,
          selectedHotspotId,
          hotspotMasters: selectedMaster ? [selectedMaster] : [],
          tx,
          routeEndMinutes: routeEndMinutesApply,
        });

    const appliedRemovedHotspots = new Map<number, {
      id: number;
      name: string;
      priority: number;
      reason: string;
    }>();
    const recordAppliedRemovedHotspots = async (
      removedRows: any[],
      defaultReason: string,
    ) => {
      const normalizedRows = Array.isArray(removedRows) ? removedRows : [];
      const removedIds = Array.from(
        new Set(
          normalizedRows
            .map((row: any) => Number(row?.id || row?.hotspotId || row?.hotspot_ID || 0))
            .filter((id: number) => Number.isFinite(id) && id > 0),
        ),
      );
      if (removedIds.length === 0) return;

      const masters = await (tx as any).dvi_hotspot_place.findMany({
        where: {
          hotspot_ID: { in: removedIds },
          deleted: 0,
        },
        select: {
          hotspot_ID: true,
          hotspot_name: true,
          hotspot_priority: true,
        },
      });
      const masterById = new Map<number, any>();
      for (const master of masters || []) {
        const hotspotId = Number((master as any)?.hotspot_ID || 0);
        if (!hotspotId || masterById.has(hotspotId)) continue;
        masterById.set(hotspotId, master);
      }

      for (const row of normalizedRows) {
        const hotspotId = Number(row?.id || row?.hotspotId || row?.hotspot_ID || 0);
        if (!hotspotId) continue;
        const master = masterById.get(hotspotId);
        const existing = appliedRemovedHotspots.get(hotspotId);
        appliedRemovedHotspots.set(hotspotId, {
          id: hotspotId,
          name:
            String(
              row?.name ||
              row?.title ||
              row?.hotspot_name ||
              master?.hotspot_name ||
              existing?.name ||
              `Hotspot #${hotspotId}`,
            ),
          priority: Number(
            row?.priority ??
            row?.hotspotPriority ??
            row?.hotspot_priority ??
            master?.hotspot_priority ??
            existing?.priority ??
            0,
          ) || 0,
          reason: String(row?.reason || existing?.reason || defaultReason),
        });
      }
    };

    if (params.trustedPreviewConfirmation === true && Array.isArray(adjustedTimeline) && adjustedTimeline.length > 0) {
      const trustedPreviewAttractionIds = new Set<number>(
        adjustedTimeline
          .filter((row: any) => (
            String(row?.type || '').toLowerCase() === 'attraction'
            || Number(row?.item_type || 0) === 4
          ))
          .map((row: any) => Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0))
          .filter((id: number) => Number.isFinite(id) && id > 0),
      );

      const trustedPreviewRemovedIds = beforeAttractions
        .filter((row: any) => {
          const hotspotId = Number(row?.hotspot_ID || 0);
          if (!hotspotId || hotspotId === selectedHotspotId) return false;
          if (Number(row?.hotspot_plan_own_way || 0) === 1) return false;
          return !trustedPreviewAttractionIds.has(hotspotId);
        })
        .map((row: any) => Number(row?.hotspot_ID || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0);

      if (trustedPreviewRemovedIds.length > 0) {
        await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
          where: {
            itinerary_plan_ID: planId,
            itinerary_route_ID: routeId,
            item_type: 4,
            hotspot_ID: { in: trustedPreviewRemovedIds },
            hotspot_plan_own_way: { not: 1 },
            deleted: 0,
            status: 1,
          },
          data: {
            deleted: 1,
            status: 0,
            updatedon: new Date(),
          },
        });

        for (const removedId of trustedPreviewRemovedIds) {
          await this.addRouteHotspotToExcludedList(tx, Number(routeId), Number(removedId));
        }

        await recordAppliedRemovedHotspots(
          trustedPreviewRemovedIds.map((hotspotId: number) => {
            const sourceRow = beforeAttractionByHotspotId.get(hotspotId);
            return {
              id: hotspotId,
              priority: Number(sourceRow?.hotspot_priority || 0) || 0,
              reason: 'Removed to match the confirmed Fit Here preview timeline.',
            };
          }),
          'Removed to match the confirmed Fit Here preview timeline.',
        );
      }
    }

    const selectedManualPriority = this.resolveSelectedManualPriority({
      selectedHotspotId,
      manualInsertionFit,
      options: params,
      selectedMaster,
    });
    const trustedPreviewTimelineFingerprint = String(params?.trustedPreviewTimelineFingerprint || '').trim();
    const canTrustStablePreviewForDayEnd =
      params?.trustedPreviewConfirmation === true
      && params?.enforceTrustedPreviewConfirmation === true
      && Array.isArray(params?.trustedPreviewTimeline)
      && params.trustedPreviewTimeline.length > 0
      && trustedPreviewTimelineFingerprint.length > 0
      && this.buildManualFitTimelineFingerprint(adjustedTimeline || []) === trustedPreviewTimelineFingerprint;
    const overflowMinutes = this.calculateRouteEndOverflowMinutes(
      adjustedTimeline || [],
      route,
      manualTimingPolicy?.endTime,
    );
    if (overflowMinutes > 0) {
      if (canTrustStablePreviewForDayEnd) {
 console.warn('[FitHere][confirm_trusted_preview_day_end_bypass]', {
          planId: Number(planId),
          routeId: Number(routeId),
          selectedHotspotId,
          overflowMinutes,
          trustedPreviewTimelineFingerprint,
        });
      } else {
      const dayEndMinutes = routeEndMinutesApply;
      const preselectedRemovalHotspotIds = Array.isArray(manualInsertionFit?.lowPriorityRemovalPlanPreview?.plannedRemovals)
        ? manualInsertionFit.lowPriorityRemovalPlanPreview.plannedRemovals
            .map((row: any) => Number(row?.id || 0))
            .filter((id: number) => Number.isFinite(id) && id > 0)
        : [];
      const lowPriorityPlan = await this.resolveProgressivePriorityRemovalForManualFitInTx(tx, {
        planId,
        routeId,
        selectedHotspotId,
        selectedManualPriority,
        currentTimeline: adjustedTimeline,
        dayEndMinutes,
        overflowMinutes,
        preselectedRemovalHotspotIds,
        validationMode: 'DAY_END',
        allowP3Removal: true,
        allowP2Removal: params?.allowP1P2Removal === true || params?.allowTopPriorityRemoval === true,
        allowP1Removal: params?.allowP1P2Removal === true || params?.allowTopPriorityRemoval === true,
      });

      if (!lowPriorityPlan.resolved) {
        const noCandidates = !Array.isArray(lowPriorityPlan.candidateHotspots) || lowPriorityPlan.candidateHotspots.length === 0;
        const fallbackMessage = noCandidates
          ? 'No same-route generated hotspots above Manual/P4 are available to remove for this insertion.'
          : `Manual hotspot exceeds day end by ${overflowMinutes} minutes and no same-route lower-priority removals are available.`;
        throw new ConflictException({
          success: false,
          inserted: false,
          code: noCandidates
            ? 'MANUAL_INSERT_NO_LOW_PRIORITY_REMOVAL_AVAILABLE'
            : 'MANUAL_INSERT_EXCEEDS_DAY_END_NO_LOW_PRIORITY_REMOVAL_AVAILABLE',
          message: lowPriorityPlan.message || fallbackMessage,
          overflowMinutes,
          lowPriorityRemovalPlan: {
            resolved: false,
            candidates: noCandidates ? [] : lowPriorityPlan.candidateHotspots,
            finalOverflowMinutes: lowPriorityPlan.finalOverflowMinutes,
            finalArrivalTime: lowPriorityPlan.finalArrivalTime,
            simulationAttempts: noCandidates ? [] : lowPriorityPlan.simulationAttempts,
          },
        });
      }

      await recordAppliedRemovedHotspots(
        lowPriorityPlan.removedHotspots || [],
        'Removed to keep the route within schedule.',
      );
      adjustedTimeline = lowPriorityPlan.finalTimeline || adjustedTimeline;

      const removedIds = (lowPriorityPlan.removedHotspots || [])
        .map((row: any) => Number(row?.id || 0))
        .filter((id: number) => id > 0);

      if (removedIds.length > 0) {
        await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
          where: {
            itinerary_plan_ID: planId,
            itinerary_route_ID: routeId,
            item_type: 4,
            hotspot_ID: { in: removedIds },
            hotspot_plan_own_way: { not: 1 },
            deleted: 0,
            status: 1,
          },
          data: {
            deleted: 1,
            status: 0,
            updatedon: new Date(),
          },
        });

        for (const removedId of removedIds) {
          await this.addRouteHotspotToExcludedList(tx, Number(routeId), Number(removedId));
        }
      }
      }
    }

    adjustedTimeline = await this.enrichManualFitPreviewTimelineWithOperatingHours(
      Number(planId),
      Number(routeId),
      adjustedTimeline,
    );
    const selectedClosingOverflowForApply = this.getSelectedManualClosingOverflow({
      timeline: adjustedTimeline,
      selectedHotspotIds: [selectedHotspotId],
    });

    if (selectedClosingOverflowForApply.hasClosingOverflow) {
      const preselectedOpeningRemovalHotspotIds = Array.isArray(
        manualInsertionFit?.lowPriorityOpeningHoursRemovalPlanPreview?.plannedRemovals,
      )
        ? manualInsertionFit.lowPriorityOpeningHoursRemovalPlanPreview.plannedRemovals
            .map((row: any) => Number(row?.id || row?.hotspotId || row?.hotspot_ID || 0))
            .filter((id: number) => Number.isFinite(id) && id > 0)
        : [];

      const openingHoursApplyPlan = await this.resolveProgressivePriorityRemovalForManualFitInTx(tx, {
        planId,
        routeId,
        selectedHotspotId,
        selectedManualPriority,
        currentTimeline: adjustedTimeline,
        dayEndMinutes: routeEndMinutesApply,
        overflowMinutes: Number(selectedClosingOverflowForApply.overflowMinutes || 0),
        preselectedRemovalHotspotIds: preselectedOpeningRemovalHotspotIds,
        targetHotspotId: selectedHotspotId,
        targetHotspotLatestEndMinutes: Number(selectedClosingOverflowForApply.latestAllowedEndMinutes || 0),
        validationMode: 'SELECTED_HOTSPOT_CLOSING',
        allowP3Removal: params?.allowP3Removal === true || params?.allowTopPriorityRemoval === true,
        allowP2Removal: params?.allowP1P2Removal === true || params?.allowTopPriorityRemoval === true,
        allowP1Removal: params?.allowP1P2Removal === true || params?.allowTopPriorityRemoval === true,
      });

      if (!openingHoursApplyPlan.resolved) {
        throw new ConflictException({
          success: false,
          inserted: false,
          code: 'MANUAL_INSERT_SELECTED_HOTSPOT_CLOSING_NOT_RESOLVED',
          message:
            openingHoursApplyPlan.message ||
            'The selected hotspot still exceeds closing time and the preview removal plan could not be reapplied.',
          selectedClosingOverflow: selectedClosingOverflowForApply,
          openingHoursRemovalPlan: openingHoursApplyPlan,
        });
      }

      adjustedTimeline = openingHoursApplyPlan.finalTimeline || adjustedTimeline;

      const removedIds = (openingHoursApplyPlan.removedHotspots || [])
        .map((row: any) => Number(row?.id || row?.hotspotId || row?.hotspot_ID || 0))
        .filter((id: number) => id > 0);

      if (removedIds.length > 0) {
        await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
          where: {
            itinerary_plan_ID: planId,
            itinerary_route_ID: routeId,
            item_type: 4,
            hotspot_ID: { in: removedIds },
            hotspot_plan_own_way: { not: 1 },
            deleted: 0,
            status: 1,
          },
          data: {
            deleted: 1,
            status: 0,
            updatedon: new Date(),
          },
        });

        for (const removedId of removedIds) {
          await this.addRouteHotspotToExcludedList(tx, Number(routeId), Number(removedId));
        }
      }

      await recordAppliedRemovedHotspots(
        openingHoursApplyPlan.removedHotspots || [],
        'Removed to keep the selected hotspot within operating hours.',
      );
    }

    const appliedRemovedHotspotsList = Array.from(appliedRemovedHotspots.values());

    const strictTimingValidation = this.validateStrictMatrixTimeline(adjustedTimeline);
    if (!strictTimingValidation.passes) {
      throw new ConflictException({
        success: false,
        inserted: false,
        code: 'MANUAL_HOTSPOT_STRICT_TIMING_REQUIRED',
        message: strictTimingValidation.reason,
        strictTimingValidation,
      });
    }

    const attractionTimeByHotspot = new Map<number, { start: Date; end: Date }>();
    for (const row of adjustedTimeline || []) {
      const type = String(row?.type || '').toLowerCase();
      const hid = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0);
      const isAttraction = type === 'attraction' || Number(row?.item_type || 0) === 4;
      if (!isAttraction || !hid || attractionTimeByHotspot.has(hid)) continue;
      const parsed = this.parsePreviewTimeRangeToUtcDates(row?.timeRange);
      if (!parsed.start || !parsed.end) continue;
      attractionTimeByHotspot.set(hid, { start: parsed.start, end: parsed.end });
    }

    const selectedAttractionTimelineRow = (adjustedTimeline || []).find((row: any) => (
      (
        String(row?.type || '').toLowerCase() === 'attraction'
        || Number(row?.item_type || 0) === 4
      )
      && Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0) === Number(selectedHotspotId)
    ));
    const selectedAttractionTimes = this.parsePreviewTimeRangeToUtcDates(selectedAttractionTimelineRow?.timeRange);
    if (!selectedAttractionTimes.start || !selectedAttractionTimes.end) {
      throw new ConflictException({
        success: false,
        inserted: false,
        code: 'MANUAL_HOTSPOT_STRICT_TIMING_REQUIRED',
        message: 'Selected hotspot timeline could not be resolved to a valid non-zero time range.',
      });
    }
    const selectedFinalOrder = (adjustedTimeline || [])
      .filter((row: any) => String(row?.type || '').toLowerCase() === 'attraction')
      .map((row: any) => Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0))
      .findIndex((id: number) => id === Number(selectedHotspotId));

    await this.activateManualHotspotRowWithTimes(tx, {
      planId,
      routeId,
      hotspotId: Number(selectedHotspotId),
      userId,
      start: selectedAttractionTimes.start,
      end: selectedAttractionTimes.end,
      hotspotOrder: selectedFinalOrder >= 0 ? selectedFinalOrder + 1 : undefined,
    });

    const activeAttractionsAfterReorder = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        itinerary_route_ID: routeId,
        item_type: 4,
        deleted: 0,
        status: 1,
      },
      orderBy: [
        { hotspot_order: 'asc' },
        { route_hotspot_ID: 'asc' },
      ],
      select: {
        route_hotspot_ID: true,
        hotspot_ID: true,
        hotspot_order: true,
      },
    });

    const finalAttractionOrder = (adjustedTimeline || [])
      .filter((row: any) => String(row?.type || '').toLowerCase() === 'attraction')
      .map((row: any) => Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0))
      .filter((id: number) => id > 0);

    const activeByHotspot = new Map<number, any>();
    for (const row of activeAttractionsAfterReorder || []) {
      const hid = Number(row?.hotspot_ID || 0);
      if (!hid || activeByHotspot.has(hid)) continue;
      activeByHotspot.set(hid, row);
    }

    for (let idx = 0; idx < finalAttractionOrder.length; idx += 1) {
      const hid = Number(finalAttractionOrder[idx]);
      const row = activeByHotspot.get(hid);
      if (!row) continue;
      await (tx as any).dvi_itinerary_route_hotspot_details.update({
        where: { route_hotspot_ID: Number(row?.route_hotspot_ID || 0) },
        data: {
          hotspot_order: idx + 1,
          updatedon: new Date(),
        },
      });
    }

    for (const row of activeAttractionsAfterReorder) {
      const hid = Number(row?.hotspot_ID || 0);
      const times = attractionTimeByHotspot.get(hid);
      if (!times) continue;
      await (tx as any).dvi_itinerary_route_hotspot_details.update({
        where: { route_hotspot_ID: Number(row?.route_hotspot_ID || 0) },
        data: {
          hotspot_start_time: times.start,
          hotspot_end_time: times.end,
          updatedon: new Date(),
          is_conflict: 0,
          conflict_reason: null,
        },
      });
    }

    const selectedAttractionRow = activeAttractionsAfterReorder.find((row: any) => (
      Number(row?.hotspot_ID || 0) === Number(selectedHotspotId)
    ));
    if (selectedAttractionRow && selectedAttractionTimes.start && selectedAttractionTimes.end) {
      const selectedDurationMinutes = Math.max(1, Math.round((selectedAttractionTimes.end.getTime() - selectedAttractionTimes.start.getTime()) / 60000));
      await (tx as any).dvi_itinerary_route_hotspot_details.update({
        where: { route_hotspot_ID: Number(selectedAttractionRow?.route_hotspot_ID || 0) },
        data: {
          hotspot_start_time: selectedAttractionTimes.start,
          hotspot_end_time: selectedAttractionTimes.end,
          hotspot_traveling_time: this.minutesToUtcTimeDate(selectedDurationMinutes),
          updatedon: new Date(),
          is_conflict: 0,
          conflict_reason: null,
        },
      });
    }

 // Route-local travel persistence in timeline order (without global rebuild).
    const travelRows = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        itinerary_route_ID: routeId,
        item_type: { in: [3, 5] },
        deleted: 0,
        status: 1,
      },
      orderBy: [
        { hotspot_order: 'asc' },
        { route_hotspot_ID: 'asc' },
      ],
    });

    const timelineRows = Array.isArray(adjustedTimeline) ? adjustedTimeline : [];
    const isAttractionRowForApply = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      return type === 'attraction' || Number(row?.item_type || 0) === 4;
    };
    const isHotelRowForApply = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      const text = String(row?.text || row?.name || '').toLowerCase();
      return type === 'hotel' || Number(row?.item_type || 0) === 6 || text.includes('check-in at hotel');
    };
    const getStopLabelForApply = (row: any, fallback: string): string => {
      if (!row) return fallback;
      if (isHotelRowForApply(row)) {
        const hotelText = String(row?.text || row?.name || '').trim();
        const match = hotelText.match(/check-?in\s+at\s+(.+)/i);
        const hotelName = String(match?.[1] || '').trim();
        return hotelName && hotelName.toLowerCase() !== 'hotel' ? hotelName : 'Hotel';
      }
      return String(row?.text || row?.name || fallback).trim();
    };

    adjustedTimeline = timelineRows.map((row: any, idx: number) => {
      if (String(row?.type || '').toLowerCase() !== 'travel') return row;

      const prevStop = [...timelineRows]
        .slice(0, idx)
        .reverse()
        .find((candidate: any) => isAttractionRowForApply(candidate) || isHotelRowForApply(candidate));
      const nextStop = [...timelineRows]
        .slice(idx + 1)
        .find((candidate: any) => isAttractionRowForApply(candidate) || isHotelRowForApply(candidate));
      const fromLabel = getStopLabelForApply(prevStop, 'Hotel / Route Start');
      const toLabel = getStopLabelForApply(nextStop, 'Hotel');
      const isTravelToHotel = isHotelRowForApply(nextStop);

      return {
        ...row,
        item_type: isTravelToHotel ? 5 : Number(row?.item_type || 3),
        text: `Travel to ${toLabel}`,
        name: `Travel to ${toLabel}`,
        fromName: fromLabel,
        toName: toLabel,
        from: fromLabel,
        to: toLabel,
        displayFromName: fromLabel,
        displayToName: toLabel,
        isMatrixReconnectedTravel: true,
      };
    });

    const normalizeTravelLabelForApply = (value: any): string =>
      String(value ?? '')
        .split('|')[0]
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s*\([^)]*\)\s*$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

    const attractionNameToIdMap = new Map<string, number>();
    for (const row of adjustedTimeline || []) {
      const type = String(row?.type || '').toLowerCase();
      const itemType = Number(row?.item_type || 0);
      if (type !== 'attraction' && itemType !== 4) continue;
      const hid = Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0);
      if (hid <= 0) continue;
      const name = normalizeTravelLabelForApply(row?.name || row?.text || row?.title || '');
      if (name && !attractionNameToIdMap.has(name)) {
        attractionNameToIdMap.set(name, hid);
      }
    }

    const inferTravelHotspotId = (label?: string | null): number | null => {
      const normalized = normalizeTravelLabelForApply(label);
      if (!normalized) return null;
      const exact = attractionNameToIdMap.get(normalized);
      if (exact && exact > 0) return exact;
      for (const [name, id] of attractionNameToIdMap.entries()) {
        if (name.includes(normalized) || normalized.includes(name)) {
          return id > 0 ? id : null;
        }
      }
      return null;
    };

    const finalTravelSegments = (adjustedTimeline || [])
      .filter((row: any) => String(row?.type || '').toLowerCase() === 'travel');

    for (let idx = 0; idx < finalTravelSegments.length; idx += 1) {
      const seg = finalTravelSegments[idx];
      const row = travelRows[idx] || null;
      const parsed = this.parsePreviewTimeRangeToUtcDates(seg?.timeRange);
      const duration = Number(seg?.matrixDurationMin || this.getPreviewRowDurationMinutes(seg) || 0);
      const distance = Number(seg?.matrixDistanceKm || seg?.distanceKm || 0);
      const normalizeTravelLabel = (value: any): string =>
        String(value ?? '')
          .split('|')[0]
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
      const fromLabel = String(
        seg?.fromName ||
          seg?.displayFromName ||
          seg?.from ||
          seg?.text ||
          seg?.name ||
          '',
      ).trim();
      const toLabel = String(
        seg?.toName ||
          seg?.displayToName ||
          seg?.to ||
          seg?.text ||
          seg?.name ||
          '',
      ).trim();
      const fromHotspotId = Number(seg?.fromHotspotId || inferTravelHotspotId(fromLabel) || 0);
      const toHotspotId = Number(seg?.toHotspotId || inferTravelHotspotId(toLabel) || 0);

      let resolvedDistanceKm: number | null = null;
      if (toHotspotId > 0 && fromHotspotId <= 0) {
        const sourceLeg = await this.resolveSourceToHotspotLeg(tx, Number(routeId), toHotspotId);
        resolvedDistanceKm = sourceLeg.distanceKm != null ? Number(sourceLeg.distanceKm) : null;
      } else if (fromHotspotId > 0 && toHotspotId > 0 && fromHotspotId !== toHotspotId) {
        const leg = await this.getCachedRouteMatrixLeg(tx, fromHotspotId, toHotspotId);
        resolvedDistanceKm = leg.distanceKm != null ? Number(leg.distanceKm) : null;
      }

      if (!(resolvedDistanceKm != null && Number.isFinite(resolvedDistanceKm) && resolvedDistanceKm > 0)) {
        resolvedDistanceKm = distance > 0 ? distance : null;
      }

      const labelsDiffer = normalizeTravelLabel(fromLabel) !== normalizeTravelLabel(toLabel);
      const normalizedDistance =
        labelsDiffer && Number.isFinite(distance) && distance <= 0.01
          ? resolvedDistanceKm
          : resolvedDistanceKm ?? distance;

      const payload = {
        hotspot_order: idx + 1,
        hotspot_ID: 0,
        hotspot_traveling_time: this.minutesToUtcTimeDate(Math.max(0, duration)),
        hotspot_travelling_distance: Number.isFinite(normalizedDistance as number) && Number(normalizedDistance) > 0
          ? String(Number(normalizedDistance).toFixed(2))
          : null,
        hotspot_start_time: parsed.start || this.minutesToUtcTimeDate(0),
        hotspot_end_time: parsed.end || this.minutesToUtcTimeDate(0),
        updatedon: new Date(),
      };

      if (row) {
        await (tx as any).dvi_itinerary_route_hotspot_details.update({
          where: { route_hotspot_ID: Number(row.route_hotspot_ID) },
          data: payload,
        });
      } else {
        const isTravelToHotel = Number(seg?.item_type || 0) === 5
          || String(seg?.toName || seg?.displayToName || '').trim().toLowerCase() === 'hotel'
          || String(seg?.text || seg?.name || '').toLowerCase().includes('travel to hotel');
        await (tx as any).dvi_itinerary_route_hotspot_details.create({
          data: {
            itinerary_plan_ID: planId,
            itinerary_route_ID: routeId,
            item_type: isTravelToHotel ? 5 : 3,
            hotspot_ID: 0,
            itinerary_travel_type_buffer_time: this.minutesToUtcTimeDate(0),
            createdby: userId,
            createdon: new Date(),
            status: 1,
            deleted: 0,
            ...payload,
          },
        });
      }
    }

    if (travelRows.length > finalTravelSegments.length) {
      const deactivateIds = travelRows
        .slice(finalTravelSegments.length)
        .map((row: any) => Number(row?.route_hotspot_ID || 0))
        .filter((id: number) => id > 0);
      if (deactivateIds.length > 0) {
        await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
          where: {
            route_hotspot_ID: { in: deactivateIds },
          },
          data: {
            deleted: 1,
            status: 0,
            updatedon: new Date(),
          },
        });
      }
    }

    const removedIdsForTravelCleanup = appliedRemovedHotspotsList
      .map((row: any) => Number(row?.id || 0))
      .filter((id: number) => id > 0);
    if (removedIdsForTravelCleanup.length > 0) {
      await (tx as any).dvi_itinerary_route_hotspot_details.updateMany({
        where: {
          itinerary_plan_ID: planId,
          itinerary_route_ID: routeId,
          item_type: { in: [3, 5] },
          hotspot_ID: { in: removedIdsForTravelCleanup },
          deleted: 0,
          status: 1,
        },
        data: {
          deleted: 1,
          status: 0,
          updatedon: new Date(),
        },
      });
    }

    const afterTargetAttractions = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        itinerary_route_ID: routeId,
        item_type: 4,
        deleted: 0,
        status: 1,
      },
      orderBy: [
        { hotspot_order: 'asc' },
        { route_hotspot_ID: 'asc' },
      ],
      select: {
        hotspot_ID: true,
      },
    });

    const afterTargetIds = afterTargetAttractions.map((row: any) => Number(row?.hotspot_ID || 0)).filter((id: number) => id > 0);
    const removedLowPriorityIds = appliedRemovedHotspotsList.map((row: any) => Number(row?.id || 0)).filter((id: number) => id > 0);
    const missingBeforeTargetIds = beforeAttractionIds.filter((id: number) => !afterTargetIds.includes(id) && !removedLowPriorityIds.includes(id));
    const fromPos = afterTargetIds.findIndex((id: number) => id === bestFrom);
    const cPos = afterTargetIds.findIndex((id: number) => id === selectedHotspotId);
    const toPos = afterTargetIds.findIndex((id: number) => id === bestTo);

    const removedHigherOrEqualPriority = appliedRemovedHotspotsList.some((row: any) => Number(row?.priority || 0) <= selectedManualPriority);
    const hotelRows = (adjustedTimeline || []).filter((row: any) => String(row?.type || '').toLowerCase() === 'hotel');
    const hotelIsLast = hotelRows.length === 0
      || (adjustedTimeline || []).findIndex((row: any) => row === hotelRows[0]) >= ((adjustedTimeline || []).length - hotelRows.length);
    const finalOverflow = this.calculateRouteEndOverflowMinutes(
      adjustedTimeline || [],
      route,
      manualTimingPolicy?.endTime,
    );

    const afterPlanAttractions = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        item_type: 4,
        deleted: 0,
        status: 1,
      },
      select: {
        itinerary_route_ID: true,
        hotspot_ID: true,
        hotspot_order: true,
        route_hotspot_ID: true,
      },
      orderBy: [
        { itinerary_route_ID: 'asc' },
        { hotspot_order: 'asc' },
        { route_hotspot_ID: 'asc' },
      ],
    });

    const afterByRoute = new Map<number, number[]>();
    for (const row of afterPlanAttractions || []) {
      const rid = Number(row?.itinerary_route_ID || 0);
      if (!afterByRoute.has(rid)) afterByRoute.set(rid, []);
      afterByRoute.get(rid)!.push(Number(row?.hotspot_ID || 0));
    }

    let otherRoutesChanged = false;
    for (const [rid, beforeIds] of beforeByRoute.entries()) {
      if (rid === routeId) continue;
      const afterIds = afterByRoute.get(rid) || [];
      if (beforeIds.length !== afterIds.length || beforeIds.some((id: number, idx: number) => id !== afterIds[idx])) {
        otherRoutesChanged = true;
        break;
      }
    }
    const assertionFailed =
      missingBeforeTargetIds.length > 0
      || !afterTargetIds.includes(selectedHotspotId)
      || !(fromPos >= 0 && cPos === fromPos + 1 && toPos === cPos + 1)
      || otherRoutesChanged
      || removedHigherOrEqualPriority
      || !hotelIsLast
      || finalOverflow > 0;

    if (assertionFailed && !skipPostApplyAssertions) {
      throw new ConflictException({
        success: false,
        inserted: false,
        code: 'MATRIX_SAFE_APPLY_ASSERTION_FAILED',
        message: 'Apply would corrupt another route or remove existing route hotspots. Rolled back.',
      });
    }

    const scheduledManualHotspots = [
      {
        id: selectedHotspotId,
        name: String(selectedMaster?.hotspot_name || manualInsertionFit?.selectedHotspotName || `Hotspot #${selectedHotspotId}`),
        visitTime: (
          (adjustedTimeline || []).find((row: any) =>
            (
              String(row?.type || '').toLowerCase() === 'attraction'
              || Number(row?.item_type || 0) === 4
            )
            && Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || 0) === selectedHotspotId,
          )?.timeRange || undefined
        ),
      },
    ];

    return {
      success: true,
      inserted: true,
      code: appliedRemovedHotspotsList.length > 0
        ? 'MANUAL_HOTSPOT_INSERTED_WITH_LOW_PRIORITY_REMOVAL'
        : 'MANUAL_HOTSPOT_INSERTED_WITH_MATRIX_SLOT',
      message: appliedRemovedHotspotsList.length > 0
        ? 'Manual hotspot inserted. Lower-priority hotspots were removed to keep the day within schedule.'
        : 'Manual hotspot inserted using matrix best slot.',
      planId,
      routeId,
      hotspotId: selectedHotspotId,
      hotspotIds: selectedHotspotIds,
      manualInsertionFit,
      fullTimeline: adjustedTimeline,
      routeTimeline: adjustedTimeline,
      resolution: {
        manualInsertionFit,
        requiresConfirmation: false,
        removedLowPriorityHotspots: appliedRemovedHotspotsList,
        removedOptionalHotspots: appliedRemovedHotspotsList,
        removedTopPriorityHotspots: [],
        topPriorityAffected: [],
        scheduledManualHotspots,
        unscheduledManualHotspots: [],
        shiftedHotspots: [],
        deferredHotspots: [],
        removedHotspots: appliedRemovedHotspotsList,
        removedCount: appliedRemovedHotspotsList.length,
        stillUnschedulable: false,
        timingAdjusted: true,
        reason: null,
        validation: {
          passesScheduleRules: true,
          readyToApply: true,
          requiresPriorityConfirmation: false,
          stillUnschedulable: false,
          routeEndOverflowMinutes: 0,
          openingHourConflictCount: 0,
          selectedManualConflictCount: 0,
          scheduledSelectedManualCount: 1,
          unscheduledManualCount: 0,
          reason: 'Manual hotspot inserted with matrix-safe route-local apply.',
        },
      },
      validation: {
        passesScheduleRules: true,
        readyToApply: true,
        requiresPriorityConfirmation: false,
        stillUnschedulable: false,
        routeEndOverflowMinutes: 0,
        openingHourConflictCount: 0,
        selectedManualConflictCount: 0,
        scheduledSelectedManualCount: 1,
        unscheduledManualCount: 0,
        reason: appliedRemovedHotspotsList.length > 0
          ? 'Route overflow resolved by removing lower-priority hotspots from the same route.'
          : 'Manual hotspot inserted with matrix-safe route-local apply.',
      },
    };
  }

 /**
   * Apply manualInsertionFit to the preview timeline to adjust row positions and timings.
   * This removes the selected hotspot from its old location and reinserts it in the correct slot,
   * with calculated time range based on available gap between anchor hotspots.
 */
}
