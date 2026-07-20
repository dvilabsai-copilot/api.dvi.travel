// FILE: src/modules/itineraries/services/itinerary-manual-hotspot-preview.service.ts

import { Injectable, BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../../prisma.service';
import {
  applyManualFitAttemptWithinTransactionImpl,
  assertConfirmedManualHotspotPersistedImpl,
  confirmManualHotspotFitHereImpl,
  extractManualFitPreferredSlotImpl,
  preflightManualFitAttemptConfirmationImpl,
  previewManualHotspotAutoFitHereImpl,
  previewManualHotspotFitHereImpl,
  resolveManualFitHereAnchorImpl,
} from '../helpers/manual-fit-here.helper';
import {
  buildManualFitAttemptLogImpl,
  buildManualFitPreviewEnvelopeImpl,
} from '../helpers/manual-fit-here-preview.helper';

type ManualHotspotPreviewCallbacks = Partial<Record<
  | 'ensureManualFitAttemptStoreTable'
  | 'normalizeManualHotspotIds'
  | 'isRetryableManualPreviewTransactionError'
  | 'runManualHotspotBatchWithinTransaction'
  | 'activateManualHotspotRowWithTimes'
  | 'applyMatrixSafeManualHotspotInsertionInTx'
  | 'buildManualFitTravelReplicaDisplayFields'
  | 'cleanupStaleManualHotspotRows'
  | 'deleteManualFitAttemptEntry'
  | 'getActiveRouteManualFitRemovalEvidence'
  | 'getPreviewRowDurationMinutes'
  | 'getRouteTimelineForScoring'
  | 'loadManualFitAttemptEntry'
  | 'manualFitTimelinePreservesSelectedAnchor'
  | 'buildExactAnchorSequentialTimelineAfterRemoval'
  | 'buildManualFitChangesRequiredDisplay'
  | 'buildManualFitFinalizedPreviewTimeline'
  | 'buildRemovedPrioritySummary'
  | 'enrichManualFitPreviewTimelineWithOperatingHours'
  | 'formatManualDurationMinutes'
  | 'formatTime'
  | 'getManualFitRemovalHotspotId'
  | 'markSelectedManualOperatingHourConflicts'
  | 'minutesToUtcTimeDate'
  | 'normalizeExactAnchorManualInsertionFit'
  | 'parseManualHotspotLatestClosingMinute'
  | 'parsePreviewTimeToMinutes'
  | 'parsePreviewTimeRangeToUtcDates'
  | 'sanitizeUserFacingManualFitRemovals'
  | 'saveManualFitAttemptEntry',
  (...args: any[]) => any
>>;

type ManualFitHereAnchorIntent = 'AFTER_START' | 'AFTER_ATTRACTION';
type ResolvedManualFitHereAnchor = any;
type FitHereAttemptLogItem = any;
type ManualFitAttemptCacheEntry = any;


@Injectable()
export class ItineraryManualHotspotPreviewService {
  private readonly exactAnchorSequentialTimelineCache = new Map<string, any[]>();
  private readonly manualFitAttemptCache = new Map<string, any>();
  private callbacks: ManualHotspotPreviewCallbacks = {};

  constructor(private readonly prisma: PrismaService) {}

  setCallbacks(callbacks: ManualHotspotPreviewCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  private call(name: keyof ManualHotspotPreviewCallbacks, ...args: any[]) {
    const callback = this.callbacks[name];
    if (!callback) {
      throw new Error(`Manual hotspot preview callback is not configured: ${String(name)}`);
    }
    return callback(...args);
  }

  private ensureManualFitAttemptStoreTable(...args: any[]) { return this.call('ensureManualFitAttemptStoreTable', ...args); }
  private normalizeManualHotspotIds(...args: any[]) { return this.call('normalizeManualHotspotIds', ...args); }
  private isRetryableManualPreviewTransactionError(...args: any[]) { return this.call('isRetryableManualPreviewTransactionError', ...args); }
  private runManualHotspotBatchWithinTransaction(...args: any[]) { return this.call('runManualHotspotBatchWithinTransaction', ...args); }
  private activateManualHotspotRowWithTimes(...args: any[]) { return this.call('activateManualHotspotRowWithTimes', ...args); }
  private applyMatrixSafeManualHotspotInsertionInTx(...args: any[]) { return this.call('applyMatrixSafeManualHotspotInsertionInTx', ...args); }
  private buildManualFitTravelReplicaDisplayFields(...args: any[]) { return this.call('buildManualFitTravelReplicaDisplayFields', ...args); }
  private cleanupStaleManualHotspotRows(...args: any[]) { return this.call('cleanupStaleManualHotspotRows', ...args); }
  private deleteManualFitAttemptEntry(...args: any[]) { return this.call('deleteManualFitAttemptEntry', ...args); }
  private getActiveRouteManualFitRemovalEvidence(...args: any[]) { return this.call('getActiveRouteManualFitRemovalEvidence', ...args); }
  private getPreviewRowDurationMinutes(...args: any[]) { return this.call('getPreviewRowDurationMinutes', ...args); }
  private getRouteTimelineForScoring(...args: any[]) { return this.call('getRouteTimelineForScoring', ...args); }
  private loadManualFitAttemptEntry(...args: any[]) { return this.call('loadManualFitAttemptEntry', ...args); }
  private manualFitTimelinePreservesSelectedAnchor(...args: any[]) { return this.call('manualFitTimelinePreservesSelectedAnchor', ...args); }
  private buildExactAnchorSequentialTimelineAfterRemoval(...args: any[]) { return this.call('buildExactAnchorSequentialTimelineAfterRemoval', ...args); }
  private buildManualFitChangesRequiredDisplay(...args: any[]) { return this.call('buildManualFitChangesRequiredDisplay', ...args); }
  private buildManualFitFinalizedPreviewTimeline(...args: any[]) { return this.call('buildManualFitFinalizedPreviewTimeline', ...args); }
  private buildRemovedPrioritySummary(...args: any[]) { return this.call('buildRemovedPrioritySummary', ...args); }
  private enrichManualFitPreviewTimelineWithOperatingHours(...args: any[]) { return this.call('enrichManualFitPreviewTimelineWithOperatingHours', ...args); }
  private formatManualDurationMinutes(...args: any[]) { return this.call('formatManualDurationMinutes', ...args); }
  private formatTime(...args: any[]) { return this.call('formatTime', ...args); }
  private getManualFitRemovalHotspotId(...args: any[]) { return this.call('getManualFitRemovalHotspotId', ...args); }
  private markSelectedManualOperatingHourConflicts(...args: any[]) { return this.call('markSelectedManualOperatingHourConflicts', ...args); }
  private minutesToUtcTimeDate(...args: any[]) { return this.call('minutesToUtcTimeDate', ...args); }
  private normalizeExactAnchorManualInsertionFit(...args: any[]) { return this.call('normalizeExactAnchorManualInsertionFit', ...args); }
  private parseManualHotspotLatestClosingMinute(...args: any[]) { return this.call('parseManualHotspotLatestClosingMinute', ...args); }
  private parsePreviewTimeToMinutes(...args: any[]) { return this.call('parsePreviewTimeToMinutes', ...args); }
  private parsePreviewTimeRangeToUtcDates(...args: any[]) { return this.call('parsePreviewTimeRangeToUtcDates', ...args); }
  private sanitizeUserFacingManualFitRemovals(...args: any[]) { return this.call('sanitizeUserFacingManualFitRemovals', ...args); }
  private saveManualFitAttemptEntry(...args: any[]) { return this.call('saveManualFitAttemptEntry', ...args); }

  async previewManualHotspot(
    planId: number,
    routeId: number,
    hotspotId: number,
    anchor?: {
      anchorType?: 'after_travel' | 'BETWEEN_ROWS';
      anchorIndex?: number;
      allowTopPriorityRemoval?: boolean;
      selectedHotspotIds?: number[];
      debug?: boolean;
    },
  ) {
    const hotspotIds = this.normalizeManualHotspotIds([
      hotspotId,
      ...((anchor?.selectedHotspotIds || []) as number[]),
    ]);

    return this.previewManualHotspotsBatch(planId, routeId, hotspotIds, {
      anchorType: anchor?.anchorType,
      anchorIndex: anchor?.anchorIndex,
      allowTopPriorityRemoval: anchor?.allowTopPriorityRemoval === true,
      debug: anchor?.debug === true,
      focusHotspotId: Number(hotspotId || 0) > 0 ? Number(hotspotId) : undefined,
    });
  }

  async previewManualHotspotsBatch(
    planId: number,
    routeId: number,
    hotspotIds: number[],
    options?: {
      anchorType?: 'after_travel' | 'BETWEEN_ROWS';
      anchorIntent?: ManualFitHereAnchorIntent;
      anchorIndex?: number;
      afterHotspotId?: number;
      beforeHotspotId?: number;
      afterRouteHotspotId?: number;
      beforeRouteHotspotId?: number;
      allowP3Removal?: boolean;
      allowP1P2Removal?: boolean;
      allowTopPriorityRemoval?: boolean;
      debug?: boolean;
      focusHotspotId?: number;
      previewOnly?: boolean;
      exactAnchorMode?: boolean;
      matrixPreferredSlot?: {
        fromHotspotId?: number;
        toHotspotId?: number;
        slotIndex?: number;
        source?: 'BEST_FIT' | 'EXACT_ANCHOR';
      };
    },
  ) {
    const previewStateSnapshot = await this.captureManualPreviewRouteState(Number(planId), Number(routeId));
    const manualHotspotTxTimeoutMs = 180000;
    const previewRollbackError = new Error('__PREVIEW_MANUAL_HOTSPOT_BATCH_ROLLBACK__');
    let previewResult: any;
    let lastError: any = null;
    const maxPreviewAttempts = 3;

    for (let attempt = 1; attempt <= maxPreviewAttempts; attempt += 1) {
      try {
        await this.prisma.$transaction(async (tx) => {
          previewResult = await this.runManualHotspotBatchWithinTransaction(
            tx,
            Number(planId),
            Number(routeId),
            hotspotIds,
            1,
            {
              ...options,
              previewOnly: options?.previewOnly !== false,
            },
          );

          throw previewRollbackError;
        }, { timeout: manualHotspotTxTimeoutMs });
      } catch (error: any) {
        if (error === previewRollbackError) {
          lastError = null;
          break;
        }

        if (!this.isRetryableManualPreviewTransactionError(error) || attempt >= maxPreviewAttempts) {
          throw error;
        }

        lastError = error;
        console.warn('[ManualFit][preview_tx_retry]', {
          planId: Number(planId),
          routeId: Number(routeId),
          hotspotIds: this.normalizeManualHotspotIds(hotspotIds),
          attempt,
          maxPreviewAttempts,
          message: String(error?.message || ''),
        });
        await new Promise((resolve) => setTimeout(resolve, attempt * 100));
      }
    }

    if (lastError) {
      throw lastError;
    }

    const previewIsolationRecovered = await this.restoreManualPreviewRouteState(previewStateSnapshot);
    previewResult = {
      ...(previewResult || {}),
      previewIsolationRecovered,
    };

    return previewResult;
  }

  private async captureManualPreviewRouteState(planId: number, routeId: number): Promise<{
    planId: number;
    routeId: number;
    hotspotRows: any[];
    activityRows: any[];
    routeExcludedHotspotIds: any[];
  }> {
    const hotspotRows = await (this.prisma as any).$queryRawUnsafe(`
      SELECT *
      FROM dvi_itinerary_route_hotspot_details
      WHERE itinerary_plan_ID = ?
        AND itinerary_route_ID = ?
      ORDER BY route_hotspot_ID ASC
    `, Number(planId), Number(routeId));

    const activityRows = await (this.prisma as any).$queryRawUnsafe(`
      SELECT *
      FROM dvi_itinerary_route_activity_details
      WHERE itinerary_plan_ID = ?
        AND itinerary_route_ID = ?
      ORDER BY route_activity_ID ASC
    `, Number(planId), Number(routeId));

    const routeRow = await (this.prisma as any).dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: Number(routeId) },
      select: { excluded_hotspot_ids: true },
    });

    return {
      planId: Number(planId),
      routeId: Number(routeId),
      hotspotRows: Array.isArray(hotspotRows) ? hotspotRows : [],
      activityRows: Array.isArray(activityRows) ? activityRows : [],
      routeExcludedHotspotIds: Array.isArray(routeRow?.excluded_hotspot_ids)
        ? routeRow.excluded_hotspot_ids
        : [],
    };
  }

  private async restoreManualPreviewRouteState(snapshot: {
    planId: number;
    routeId: number;
    hotspotRows: any[];
    activityRows: any[];
    routeExcludedHotspotIds: any[];
  }): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await (tx as any).dvi_itinerary_route_activity_details.deleteMany({
          where: {
            itinerary_plan_ID: Number(snapshot.planId),
            itinerary_route_ID: Number(snapshot.routeId),
          },
        });

        await (tx as any).dvi_itinerary_route_hotspot_details.deleteMany({
          where: {
            itinerary_plan_ID: Number(snapshot.planId),
            itinerary_route_ID: Number(snapshot.routeId),
          },
        });

        await this.bulkInsertSnapshotRows(tx, 'dvi_itinerary_route_hotspot_details', snapshot.hotspotRows || []);
        await this.bulkInsertSnapshotRows(tx, 'dvi_itinerary_route_activity_details', snapshot.activityRows || []);

        await (tx as any).dvi_itinerary_route_details.update({
          where: { itinerary_route_ID: Number(snapshot.routeId) },
          data: {
            excluded_hotspot_ids: Array.isArray(snapshot.routeExcludedHotspotIds)
              ? snapshot.routeExcludedHotspotIds
              : [],
            updatedon: new Date(),
          },
        });
      }, { timeout: 120000 });

      return true;
    } catch (error: any) {
      console.error('[ManualHotspotPreview] failed to restore preview snapshot state', {
        planId: Number(snapshot?.planId || 0),
        routeId: Number(snapshot?.routeId || 0),
        message: String(error?.message || error || 'unknown restore error'),
      });
      return false;
    }
  }

  private async bulkInsertSnapshotRows(tx: any, tableName: string, rows: any[]): Promise<void> {
    const safeRows = Array.isArray(rows) ? rows : [];
    if (safeRows.length === 0) return;

    const columns = Object.keys(safeRows[0] || {});
    if (columns.length === 0) return;

    const columnSql = columns.map((col) => `\`${String(col)}\``).join(', ');
    const valuePlaceholder = `(${columns.map(() => '?').join(', ')})`;
    const valuesSql = safeRows.map(() => valuePlaceholder).join(', ');
    const sql = `INSERT INTO \`${tableName}\` (${columnSql}) VALUES ${valuesSql}`;

    const params: any[] = [];
    for (const row of safeRows) {
      for (const col of columns) {
        const value = row?.[col];
        params.push(value === undefined ? null : value);
      }
    }

    await (tx as any).$executeRawUnsafe(sql, ...params);
  }

  private async purgeExpiredManualFitAttempts() {
    const now = Date.now();
    for (const [attemptId, entry] of this.manualFitAttemptCache.entries()) {
      if (new Date(entry.expiresAt).getTime() <= now) {
        this.manualFitAttemptCache.delete(attemptId);
      }
    }

    await this.ensureManualFitAttemptStoreTable();
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM dvi_manual_fit_preview_attempts WHERE expires_at <= ?`,
      new Date(now),
    );
  }

  private extractManualFitErrorDetails(error: any): { message: string; body: any } {
    const body =
      typeof error?.getResponse === 'function'
        ? error.getResponse()
        : (error?.response ?? null);

    const message = String(
      typeof body === 'string'
        ? body
        : body?.message || error?.message || 'Could not confirm Fit Here insertion.',
    ).trim();

    return {
      message: message || 'Could not confirm Fit Here insertion.',
      body,
    };
  }

  private hashManualFitValue(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
  }

  buildManualFitAnchorLabel(anchor: any): string {
    const from = String(anchor?.anchorFrom || '').trim();
    const to = String(anchor?.anchorTo || '').trim();
    const timeRange = String(anchor?.anchorTimeRange || '').trim();

    if (from && to) {
      return timeRange ? `${from} -> ${to} (${timeRange})` : `${from} -> ${to}`;
    }
    if (to) {
      return timeRange ? `Before ${to} (${timeRange})` : `Before ${to}`;
    }
    if (from) {
      return timeRange ? `After ${from} (${timeRange})` : `After ${from}`;
    }
    return timeRange ? `Selected Fit Here position (${timeRange})` : 'Selected Fit Here position';
  }

  buildManualFitTimelineFingerprint(timeline: any[]): string {
    const normalized = (Array.isArray(timeline) ? timeline : []).map((row: any, index: number) => ({
      index,
      type: String(row?.type || row?.item_type || ''),
      label: String(row?.text || row?.name || row?.title || row?.hotspot_name || ''),
      timeRange: String(row?.timeRange || row?.visitTime || ''),
      hotspotId: Number(row?.locationId || row?.hotspot_ID || row?.hotspotId || row?.hotspot_id || 0) || null,
      isConflict: row?.isConflict === true || Number(row?.is_conflict || 0) === 1,
      isManual: row?.isManual === true || row?.manual === true || Number(row?.hotspot_plan_own_way || 0) === 1,
      removed: row?.removed === true || row?.isRemoved === true,
    }));

    return this.hashManualFitValue(normalized);
  }

  cloneTimelineRowsForPreview(timeline: any[]): any[] {
    return (Array.isArray(timeline) ? timeline : []).map((row: any) => (
      row && typeof row === 'object'
        ? { ...row }
        : row
    ));
  }

  buildExactAnchorSequentialTimelineCacheKey(
    timeline: any[],
    params: {
      removedHotspotIds: number[];
      targetHotspotId: number;
      routeId: number;
      planId: number;
      anchorIntent?: 'AFTER_START' | 'AFTER_ATTRACTION';
      afterHotspotId?: number;
      beforeHotspotId?: number;
    },
  ): string {
    return this.hashManualFitValue({
      routeId: Number(params.routeId || 0),
      planId: Number(params.planId || 0),
      targetHotspotId: Number(params.targetHotspotId || 0),
      anchorIntent: String(params.anchorIntent || ''),
      afterHotspotId: Number(params.afterHotspotId || 0),
      beforeHotspotId: Number(params.beforeHotspotId || 0),
      removedHotspotIds: (params.removedHotspotIds || [])
        .map((id: any) => Number(id || 0))
        .filter((id: number) => Number.isFinite(id) && id > 0)
        .sort((a: number, b: number) => a - b),
      timelineFingerprint: this.buildManualFitTimelineFingerprint(timeline),
    });
  }

  rememberExactAnchorSequentialTimeline(cacheKey: string, timeline: any[]): void {
    const normalizedKey = String(cacheKey || '').trim();
    if (!normalizedKey) return;

    this.exactAnchorSequentialTimelineCache.set(
      normalizedKey,
      this.cloneTimelineRowsForPreview(timeline),
    );

    const maxEntries = 200;
    while (this.exactAnchorSequentialTimelineCache.size > maxEntries) {
      const oldestKey = this.exactAnchorSequentialTimelineCache.keys().next().value;
      if (!oldestKey) break;
      this.exactAnchorSequentialTimelineCache.delete(oldestKey);
    }
  }

  private buildStableManualFitSourceSnapshot(snapshot: {
    hotspotRows?: any[];
    activityRows?: any[];
    routeExcludedHotspotIds?: any[];
  }) {
    const hotspotRows = Array.isArray(snapshot?.hotspotRows) ? snapshot.hotspotRows : [];
    const activityRows = Array.isArray(snapshot?.activityRows) ? snapshot.activityRows : [];
    const hotspotByRouteHotspotId = new Map<number, any>();

    for (const row of hotspotRows) {
      const routeHotspotId = Number(row?.route_hotspot_ID || 0);
      if (routeHotspotId > 0) {
        hotspotByRouteHotspotId.set(routeHotspotId, row);
      }
    }

    const normalizedHotspots = hotspotRows
      .filter((row: any) => Number(row?.item_type || 0) === 4 && Number(row?.deleted || 0) === 0)
      .map((row: any) => ({
        hotspotId: Number(row?.hotspot_ID || 0),
        hotspotOrder: Number(row?.hotspot_order || 0),
        start: row?.hotspot_start_time ? new Date(row.hotspot_start_time).toISOString() : null,
        end: row?.hotspot_end_time ? new Date(row.hotspot_end_time).toISOString() : null,
        manual: Number(row?.hotspot_plan_own_way || 0),
        status: Number(row?.status || 0),
        conflict: Number(row?.is_conflict || 0),
        itemType: Number(row?.item_type || 0),
      }))
      .sort((a, b) =>
        (a.hotspotOrder - b.hotspotOrder)
        || String(a.start || '').localeCompare(String(b.start || ''))
        || String(a.end || '').localeCompare(String(b.end || ''))
        || (a.hotspotId - b.hotspotId)
        || (a.manual - b.manual)
        || (a.status - b.status)
        || (a.conflict - b.conflict)
      );

    const normalizedActivities = activityRows
      .filter((row: any) => Number(row?.deleted || 0) === 0)
      .map((row: any) => {
        const parent = hotspotByRouteHotspotId.get(Number(row?.route_hotspot_ID || 0)) || null;
        return {
          parentHotspotId: Number(parent?.hotspot_ID || 0),
          parentHotspotOrder: Number(parent?.hotspot_order || 0),
          activityId: Number(row?.activity_ID || 0),
          order: Number(row?.activity_order || 0),
          start: row?.activity_start_time ? new Date(row.activity_start_time).toISOString() : null,
          end: row?.activity_end_time ? new Date(row.activity_end_time).toISOString() : null,
          status: Number(row?.status || 0),
        };
      })
      .sort((a, b) =>
        (a.parentHotspotOrder - b.parentHotspotOrder)
        || (a.parentHotspotId - b.parentHotspotId)
        || (a.order - b.order)
        || (a.activityId - b.activityId)
        || String(a.start || '').localeCompare(String(b.start || ''))
        || String(a.end || '').localeCompare(String(b.end || ''))
        || (a.status - b.status)
      );

    return {
      excludedHotspotIds: Array.isArray(snapshot?.routeExcludedHotspotIds)
        ? [...snapshot.routeExcludedHotspotIds].map((id: any) => Number(id || 0)).sort((a, b) => a - b)
        : [],
      hotspotRows: normalizedHotspots,
      activityRows: normalizedActivities,
    };
  }

  private async buildManualFitSourceFingerprint(planId: number, routeId: number): Promise<string> {
    const snapshot = await this.captureManualPreviewRouteState(Number(planId), Number(routeId));
    return this.hashManualFitValue({
      planId: Number(planId),
      routeId: Number(routeId),
      ...this.buildStableManualFitSourceSnapshot(snapshot),
    });
  }

  private async resolveManualFitHereAnchor(
    routeId: number,
    anchor: any,
    selectedHotspotId?: number,
  ): Promise<ResolvedManualFitHereAnchor> {
    return resolveManualFitHereAnchorImpl.call(this, routeId, anchor, selectedHotspotId);
  }

  private buildManualFitAttemptLog(previewResult: any): FitHereAttemptLogItem[] {
    return buildManualFitAttemptLogImpl.call(this, previewResult);
  }

  private async buildManualFitPreviewEnvelope(params: {
    attemptId: string;
    planId: number;
    routeId: number;
    selectedHotspotId: number;
    anchorLabel: string;
    selectedAnchor?: ResolvedManualFitHereAnchor;
    sourceFingerprint: string;
    expiresAt: string;
    previewResult: any;
    activeRemovalEvidence?: {
      activeHotspotIds: Set<number>;
      activeRouteHotspotIds: Set<number>;
    };
  }) {
    return buildManualFitPreviewEnvelopeImpl.call(this, params);
  }

  private extractManualFitPreferredSlot(previewResult: any): {
    fromHotspotId?: number;
    toHotspotId?: number;
    slotIndex?: number;
    source?: 'BEST_FIT' | 'EXACT_ANCHOR';
  } | null {
    return extractManualFitPreferredSlotImpl.call(this, previewResult);
  }

  async previewManualHotspotFitHere(
    planId: number,
    data: {
      routeId: number;
      selectedHotspotId: number;
      anchor: any;
      allowP3Removal?: boolean;
      allowP1P2Removal?: boolean;
    },
  ) {
    return previewManualHotspotFitHereImpl.call(this, planId, data);
  }

  async previewManualHotspotAutoFitHere(
    planId: number,
    data: {
      routeId: number;
      selectedHotspotId: number;
      anchors: any[];
      allowP3Removal?: boolean;
      allowP1P2Removal?: boolean;
    },
  ) {
    return previewManualHotspotAutoFitHereImpl.call(this, planId, data);
  }

  private async applyManualFitAttemptWithinTransaction(
    tx: any,
    params: {
      planId: number;
      entry: ManualFitAttemptCacheEntry;
      userId: number;
      canForceClosedHotspotConflict: boolean;
      forceConflictPreferredTimesByHotspotId: Record<number, { start: Date; end: Date }>;
      trustedPreviewConfirmation?: boolean;
      trustedPreviewTimeline?: any[] | null;
      sourceFingerprintChanged?: boolean;
      enforceTrustedPreviewConfirmation?: boolean;
    },
  ) {
    return applyManualFitAttemptWithinTransactionImpl.call(this, tx, params);
  }

  private async preflightManualFitAttemptConfirmation(
    entry: ManualFitAttemptCacheEntry,
    userId: number,
  ): Promise<{ canConfirm: true; body?: null; message?: null } | { canConfirm: false; message: string; body: any }> {
    return preflightManualFitAttemptConfirmationImpl.call(this, entry, userId);
  }

  async confirmManualHotspotFitHere(planId: number, payload: {
    attemptId: string;
    allowTimingRisk?: boolean;
    allowPriorityRemoval?: boolean;
    allowClosedHotspotConflict?: boolean;
    acknowledgedRemovedHotspotIds?: number[];
  }, userId: number) {
    return confirmManualHotspotFitHereImpl.call(this, planId, payload, userId);
  }

  private async assertConfirmedManualHotspotPersisted(params: {
    planId: number;
    routeId: number;
    hotspotId: number;
  }) {
    return assertConfirmedManualHotspotPersistedImpl.call(this, params);
  }

}
