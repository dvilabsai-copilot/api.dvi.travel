import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { RouteEngineService } from '../engines/route-engine.service';
import { VehiclesEngineService } from '../engines/vehicles-engine.service';
import { ItineraryVehiclesEngine } from '../engines/itinerary-vehicles.engine';
import { getVehicleRateAvailability } from '../utils/vehicle-rate-availability.util';
import {
  ItineraryVehicleBuildStatusService,
  VehicleBuildState,
} from './itinerary-vehicle-build-status.service';
import {
  buildVehiclePricingState,
  type VehiclePricingState,
} from '../utils/vehicle-pricing-state.util';

export type VehicleBuildStageTiming = {
  stage: string;
  durationMs: number;
};

export type VehicleBuildExecutionResult = {
  status: VehiclePricingState;
  buildRunId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  timings: VehicleBuildStageTiming[];
};

type VehicleSelection = {
  planId: number;
  vehicleTypeId: number;
  vendorEligibleId: number;
};

@Injectable()
export class ItineraryVehicleBuildService {
  private vehicleVendorSelector: ((data: VehicleSelection) => Promise<any>) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly routeEngine: RouteEngineService,
    private readonly vehiclesEngine: VehiclesEngineService,
    private readonly itineraryVehiclesEngine: ItineraryVehiclesEngine,
    private readonly statusService: ItineraryVehicleBuildStatusService,
  ) {}

  setVehicleVendorSelector(selector: (data: VehicleSelection) => Promise<any>): void {
    this.vehicleVendorSelector = selector;
  }

  createBuildRunId(planId: number): string {
    return this.statusService.createBuildRunId(planId);
  }

  async startRecord(planId: number, buildRunId: string, userId: number): Promise<void> {
    await this.statusService.startRecord(planId, buildRunId, userId);
  }

  private async finishRecord(
    planId: number,
    buildRunId: string,
    status: Extract<VehicleBuildState, 'READY' | 'FAILED' | 'NOT_REQUIRED'>,
    error: string | null,
  ): Promise<void> {
    await this.statusService.finishRecord(planId, buildRunId, status, error);
  }

  private async executeVehicleBuild(
    planId: number,
    vehicles: Array<{ vehicle_type_id: number; vehicle_count: number }>,
    userId: number,
    quoteId?: string,
    options?: { buildRunId?: string },
  ): Promise<VehicleBuildExecutionResult> {
    const debugVehicleTrace =
      process.env.DEBUG_DVI20260594_INSERT === 'true' ||
      process.env.DEBUG_VEHICLE_DUPLICATE_TRACE === 'true';
    const buildRunId = String(options?.buildRunId || this.createBuildRunId(planId));
    if (debugVehicleTrace) {
      const shortStack = (new Error().stack || '').split('\n').slice(1, 5).join(' | ');
 console.log('[SYNC_VEHICLE_BUILD_CALL]', { planId, timestamp: new Date().toISOString(), shortStack });
    }
    if (process.env.DEBUG_LOCAL_KM_FIX === 'true') {
 console.log('[VEHICLE_BUILD_START]', {
        planId,
        vehiclePayload: vehicles,
        routeCount: null,
        quoteId: quoteId ?? null,
        buildRunId,
      });
    }

    let recordFinished = false;
    try {
      const jobStart = Date.now();
      const startedAtIso = new Date(jobStart).toISOString();
      const timings: VehicleBuildStageTiming[] = [];
      if (debugVehicleTrace) {
 console.log('[SYNC_VEHICLE_BUILD_START]', { planId, timestamp: new Date().toISOString() });
      }

      const runStage = async <T>(
        stage: string,
        timeoutMs: number,
        work: () => Promise<T>,
      ): Promise<T> => {
 console.log('[VEHICLE_BUILD_STAGE_START]', { planId, stage, buildRunId });
        const startedAt = Date.now();
        const result = await this.runStageWithTimeout(planId, stage, work, timeoutMs);
        timings.push({ stage, durationMs: Date.now() - startedAt });
        return result;
      };

      await runStage(
        'prepare_plan_vehicle_rows',
        130000,
        () =>
          this.prisma.$transaction(
            async (tx) => {
              await this.vehiclesEngine.rebuildPlanVehicles(planId, vehicles, tx, userId);
            },
            { timeout: 120000, maxWait: 20000 },
          ),
      );

      await runStage(
          'permit_building',
          30000,
          () =>
            this.prisma.$transaction(
              async (tx) => {
                await this.routeEngine.rebuildPermitCharges(tx, planId, userId);
              },
              { timeout: 60000, maxWait: 20000 },
            ),
      );

      await runStage(
        'rebuild_eligible_vendor_list',
        180000,
        () =>
          this.itineraryVehiclesEngine.rebuildEligibleVendorList({
            planId,
            createdBy: userId,
          }),
      );

      if (quoteId) {
        await runStage(
          'auto_select_lowest_vehicle_vendors',
          30000,
          () => this.autoSelectLowestVehicleVendors(planId),
        );
      }

      const requestedVehicleTypeCount = new Set(
        vehicles
          .map((vehicle) => Number(vehicle?.vehicle_type_id || 0))
          .filter((vehicleTypeId) => vehicleTypeId > 0),
      ).size;
      const selectedRows = await this.prisma.dvi_itinerary_plan_vendor_eligible_list.findMany({
        where: {
          itinerary_plan_id: planId,
          status: 1,
          deleted: 0,
          itineary_plan_assigned_status: 1,
        },
        select: { vehicle_type_id: true },
      });
      const usableVehicleDetailCount = await this.prisma.dvi_itinerary_plan_vendor_vehicle_details.count({
        where: {
          itinerary_plan_id: planId,
          status: 1,
          deleted: 0,
          itinerary_plan_vendor_eligible_ID: { gt: 0 },
          vehicle_type_id: { gt: 0 },
          total_vehicle_amount: { gt: 0 },
        },
      });
      const finalStatus = buildVehiclePricingState({
        requiresVehicles: requestedVehicleTypeCount > 0,
        requestedVehicleTypeIds: vehicles.map((vehicle) => Number(vehicle.vehicle_type_id || 0)),
        usableVehicleDetailCount,
        selectedVehicleTypeIds: selectedRows.map((row) => Number(row.vehicle_type_id || 0)),
      });
      if (finalStatus.status !== 'READY' && finalStatus.status !== 'NOT_REQUIRED') {
        const failureMessage = finalStatus.failureReason || 'Vehicle pricing did not produce a complete persisted selection';
        await this.finishRecord(planId, buildRunId, 'FAILED', failureMessage);
        recordFinished = true;
        throw new Error(failureMessage);
      }

      await this.finishRecord(
        planId,
        buildRunId,
        finalStatus.status === 'NOT_REQUIRED' ? 'NOT_REQUIRED' : 'READY',
        null,
      );
      recordFinished = true;
      if (debugVehicleTrace) {
 console.log('[SYNC_VEHICLE_BUILD_DONE]', { planId, durationMs: Date.now() - jobStart });
      }
 console.log('[PERF] syncVehicleBuild total:', Date.now() - jobStart, 'ms', 'planId=', planId);
      return {
        status: finalStatus,
        buildRunId,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - jobStart,
        timings,
      };
    } catch (error: any) {
      const message = String(error?.message || error || 'Vehicle build failed');
      if (!recordFinished) {
        await this.finishRecord(planId, buildRunId, 'FAILED', message);
      }
      if (debugVehicleTrace) {
 console.log('[SYNC_VEHICLE_BUILD_FAILED]', { planId, error: message });
      }
 console.error('[ItinerariesService] Sync vehicle build failed:', {
        planId,
        message,
        buildRunId,
      });
      throw error;
    }
  }

  async buildVehiclesSynchronously(
    planId: number,
    vehicles: Array<{ vehicle_type_id: number; vehicle_count: number }>,
    userId: number,
    quoteId?: string,
    options?: { buildRunId?: string },
  ): Promise<VehicleBuildExecutionResult> {
    const buildRunId = String(options?.buildRunId || this.createBuildRunId(planId));
    // Creation and explicit rebuilds must not queue behind another build and
    // then start a second rebuild after the first one releases the lock.
    // MySQL GET_LOCK(..., 0) gives us a bounded, cross-process fail-fast guard.
    return this.statusService.withPlanBuildLock(planId, async () => {
      await this.startRecord(planId, buildRunId, userId);
      return this.executeVehicleBuild(planId, vehicles, userId, quoteId, {
        ...options,
        buildRunId,
      });
    }, 0);
  }

  private async runStageWithTimeout<T>(
    planId: number,
    stage: string,
    work: () => Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    // This is an observation deadline, not hard cancellation: Prisma/MySQL work
    // already sent to the database cannot be cancelled from this promise. The
    // caller drains the work before releasing the plan advisory lock.
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const workPromise = work();

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Vehicle build stage "${stage}" timed out after ${timeoutMs}ms for plan ${planId}`));
        }, timeoutMs);
      });

      const result = await Promise.race([workPromise, timeoutPromise]);
 console.log('[VEHICLE_BUILD_STAGE_DONE]', {
        planId,
        stage,
        durationMs: Date.now() - startedAt,
      });
      return result as T;
    } catch (error) {
      // Prisma work cannot be cancelled once sent to MySQL. Drain the
      // underlying promise before releasing the per-plan advisory lock so a
      // timed-out stage cannot overlap a subsequent rebuild.
      if (timer) {
        await workPromise.catch(() => undefined);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async selectVehicleVendor(data: VehicleSelection): Promise<any> {
    if (!this.vehicleVendorSelector) {
      throw new Error('Vehicle vendor selector is not configured');
    }
    return this.vehicleVendorSelector(data);
  }

  private async autoSelectLowestVehicleVendors(planId: number): Promise<void> {
    try {
      const eligibleRows = await this.prisma.dvi_itinerary_plan_vendor_eligible_list.findMany({
        where: { itinerary_plan_id: planId, status: 1, deleted: 0 },
        select: {
          itinerary_plan_vendor_eligible_ID: true,
          vehicle_type_id: true,
          vehicle_grand_total: true,
        },
        orderBy: { itinerary_plan_vendor_eligible_ID: 'asc' },
      });

      const eligibleIds = eligibleRows
        .map((row: any) => Number(row?.itinerary_plan_vendor_eligible_ID || 0))
        .filter((id) => id > 0);
      const vehicleDetailRows = eligibleIds.length
        ? await this.prisma.$queryRawUnsafe(`
            SELECT itinerary_plan_vendor_eligible_ID, travel_type, total_pickup_km,
              total_running_km, total_siteseeing_km, total_drop_km, vehicle_rental_charges
            FROM dvi_itinerary_plan_vendor_vehicle_details
            WHERE itinerary_plan_id = ${Number(planId)}
              AND deleted = 0
              AND itinerary_plan_vendor_eligible_ID IN (${eligibleIds.join(',')})
          `) as any[]
        : [];
      const detailsByEligibleId = new Map<number, any[]>();
      for (const detail of vehicleDetailRows) {
        const eligibleId = Number(detail?.itinerary_plan_vendor_eligible_ID || 0);
        const rows = detailsByEligibleId.get(eligibleId) || [];
        rows.push(detail);
        detailsByEligibleId.set(eligibleId, rows);
      }

      const byVehicleType = new Map<number, Array<{
        vendorEligibleId: number;
        totalAmount: number;
        rateAvailable: boolean;
      }>>();
      for (const row of eligibleRows) {
        const vehicleTypeId = Number((row as any)?.vehicle_type_id || 0);
        const vendorEligibleId = Number((row as any)?.itinerary_plan_vendor_eligible_ID || 0);
        const totalAmount = Number((row as any)?.vehicle_grand_total || 0);
        if (!vehicleTypeId || !vendorEligibleId || !Number.isFinite(totalAmount)) continue;
        const rateAvailable = getVehicleRateAvailability(detailsByEligibleId.get(vendorEligibleId) || []).available;
        const list = byVehicleType.get(vehicleTypeId) || [];
        list.push({ vendorEligibleId, totalAmount, rateAvailable });
        byVehicleType.set(vehicleTypeId, list);
      }

      for (const [vehicleTypeId, list] of byVehicleType.entries()) {
        const validRows = list.filter((row) => row.rateAvailable);
        if (!validRows.length) {
          await (this.prisma as any).dvi_itinerary_plan_vendor_eligible_list.updateMany({
            where: { itinerary_plan_id: planId, vehicle_type_id: vehicleTypeId, status: 1, deleted: 0 },
            data: { itineary_plan_assigned_status: 0 },
          });
          continue;
        }

        validRows.sort((a, b) => {
          if (a.totalAmount !== b.totalAmount) return a.totalAmount - b.totalAmount;
          return a.vendorEligibleId - b.vendorEligibleId;
        });

        await this.selectVehicleVendor({
          planId,
          vehicleTypeId,
          vendorEligibleId: validRows[0].vendorEligibleId,
        });
      }
    } catch (autoAssignErr) {
 console.error('[ItinerariesService] Auto-select lowest vendor failed:', autoAssignErr);
      throw autoAssignErr;
    }
  }

  private async getPlanContext(planId: number): Promise<{
    quoteId: string;
    vehicles: Array<{ vehicle_type_id: number; vehicle_count: number }>;
  }> {
    const planRow = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: planId },
      select: { itinerary_quote_ID: true },
    });
    if (!planRow) throw new NotFoundException('Plan not found');

    const planVehicles = await this.prisma.dvi_itinerary_plan_vehicle_details.findMany({
      where: { itinerary_plan_id: planId, status: 1, deleted: 0 },
      select: { vehicle_type_id: true, vehicle_count: true },
    });
    return {
      quoteId: String(planRow.itinerary_quote_ID || ''),
      vehicles: planVehicles
        .map((v) => ({ vehicle_type_id: Number(v.vehicle_type_id || 0), vehicle_count: Number(v.vehicle_count || 0) }))
        .filter((v) => v.vehicle_type_id > 0 && v.vehicle_count > 0),
    };
  }

  async buildVehiclesSync(planId: number, req: any): Promise<{
    planId: number;
    status: VehiclePricingState['status'];
    stage: 'vehicle_building';
    buildRunId: string;
    durationMs: number;
    startedAt: string;
    finishedAt: string;
    timings: VehicleBuildStageTiming[];
  }> {
    const normalizedPlanId = Number(planId || 0);
    if (!normalizedPlanId) throw new BadRequestException('planId is required');
    const userId = Number(((req as any)?.user ?? {}).userId ?? 1);
    const { quoteId, vehicles } = await this.getPlanContext(normalizedPlanId);
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    return this.statusService.withPlanBuildLock(normalizedPlanId, async () => {
      const buildRunId = this.createBuildRunId(normalizedPlanId);
      await this.startRecord(normalizedPlanId, buildRunId, userId);

      let result: VehicleBuildExecutionResult;
      try {
        result = await this.executeVehicleBuild(normalizedPlanId, vehicles, userId, quoteId, {
          buildRunId,
        });
      } catch (error: any) {
        throw new UnprocessableEntityException({
          message: 'Vehicle pricing failed. Retry vehicle pricing explicitly for this itinerary.',
          planId: normalizedPlanId,
          creationStatus: 'PARTIAL',
          vehicleBuild: { status: 'FAILED', buildRunId },
        });
      }

      return {
        planId: normalizedPlanId,
        status: result.status.status,
        stage: 'vehicle_building',
        buildRunId: result.buildRunId,
        durationMs: result.durationMs,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        timings: result.timings,
      };
    }, 0);
  }

}
