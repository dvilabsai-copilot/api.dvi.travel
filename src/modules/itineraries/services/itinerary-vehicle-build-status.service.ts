import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { randomUUID } from 'crypto';

export type VehicleBuildState = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';

export type VehicleBuildStatus = {
  planId: number;
  status: VehicleBuildState;
  buildRunId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  error: string | null;
  eligibleCount: number;
  vehicleDetailCount: number;
  requestedVehicleCount: number;
  hasUsableVehicleDetails: boolean;
  isLatestBuildReady: boolean;
  statusSource: 'db' | 'memory' | 'derived';
};

type VehicleBuildStatusMemory = {
  planId: number;
  status: VehicleBuildState;
  buildRunId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  error: string | null;
};

type VehicleBuildCounts = {
  eligibleCount: number;
  vehicleDetailCount: number;
  requestedVehicleCount: number;
  hasUsableVehicleDetails: boolean;
};

@Injectable()
export class ItineraryVehicleBuildStatusService {
  private readonly statusMap = new Map<number, VehicleBuildStatusMemory>();
  private readonly scheduleCount = new Map<number, number>();
  private statusTableEnsured = false;

  constructor(private readonly prisma: PrismaService) {}

  createBuildRunId(planId: number): string {
    return `${planId}-${Date.now()}-${randomUUID()}`;
  }

  incrementScheduleCount(planId: number): number {
    const count = (this.scheduleCount.get(planId) || 0) + 1;
    this.scheduleCount.set(planId, count);
    return count;
  }

  private async ensureStatusTable(): Promise<void> {
    if (this.statusTableEnsured) return;

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS dvi_itinerary_vehicle_build_status (
        id BIGINT NOT NULL AUTO_INCREMENT,
        itinerary_plan_id INT NOT NULL,
        build_run_id VARCHAR(100) NOT NULL,
        status VARCHAR(20) NOT NULL,
        started_at DATETIME NULL,
        finished_at DATETIME NULL,
        error TEXT NULL,
        created_by INT NOT NULL DEFAULT 0,
        created_on DATETIME NOT NULL,
        updated_on DATETIME NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_itinerary_plan_build_run (itinerary_plan_id, build_run_id),
        KEY idx_itinerary_plan_latest (itinerary_plan_id, id),
        KEY idx_vehicle_build_status (status)
      )
    `);

    this.statusTableEnsured = true;
  }

  setStatus(
    planId: number,
    status: VehicleBuildState,
    error?: string | null,
    buildRunId?: string | null,
  ): void {
    const existing = this.statusMap.get(planId);
    const nowIso = new Date().toISOString();
    const startedAt =
      status === 'PROCESSING'
        ? (existing?.startedAt ?? nowIso)
        : (existing?.startedAt ?? null);
    const finishedAt = status === 'READY' || status === 'FAILED' ? nowIso : null;

    this.statusMap.set(planId, {
      planId,
      status,
      buildRunId: buildRunId ?? existing?.buildRunId ?? null,
      startedAt,
      finishedAt,
      updatedAt: nowIso,
      error: error ?? null,
    });
  }

  async startRecord(planId: number, buildRunId: string, userId: number): Promise<void> {
    await this.ensureStatusTable();
    const now = new Date();
    await this.prisma.$executeRaw`
      INSERT INTO dvi_itinerary_vehicle_build_status
        (itinerary_plan_id, build_run_id, status, started_at, finished_at, error, created_by, created_on, updated_on)
      VALUES
        (${planId}, ${buildRunId}, ${'PROCESSING'}, ${now}, ${null}, ${null}, ${userId}, ${now}, ${now})
    `;
    this.setStatus(planId, 'PROCESSING', null, buildRunId);
  }

  async finishRecord(
    planId: number,
    buildRunId: string,
    status: Extract<VehicleBuildState, 'READY' | 'FAILED'>,
    error: string | null,
  ): Promise<void> {
    await this.ensureStatusTable();
    const now = new Date();
    const updated = await this.prisma.$executeRaw`
      UPDATE dvi_itinerary_vehicle_build_status
      SET status = ${status},
          finished_at = ${now},
          error = ${error},
          updated_on = ${now}
      WHERE itinerary_plan_id = ${planId}
        AND build_run_id = ${buildRunId}
    `;

    if (Number(updated || 0) === 0) {
      await this.prisma.$executeRaw`
        INSERT INTO dvi_itinerary_vehicle_build_status
          (itinerary_plan_id, build_run_id, status, started_at, finished_at, error, created_by, created_on, updated_on)
        VALUES
          (${planId}, ${buildRunId}, ${status}, ${now}, ${now}, ${error}, ${0}, ${now}, ${now})
      `;
    }

    this.setStatus(planId, status, error, buildRunId);
  }

  private async getLatestDbRow(planId: number): Promise<any | null> {
    await this.ensureStatusTable();
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT id, itinerary_plan_id, build_run_id, status, started_at, finished_at, error, created_by, created_on, updated_on
      FROM dvi_itinerary_vehicle_build_status
      WHERE itinerary_plan_id = ${planId}
      ORDER BY id DESC
      LIMIT 1
    `;
    return rows?.[0] ?? null;
  }

  private async getCounts(planId: number): Promise<VehicleBuildCounts> {
    const [eligibleCount, vehicleDetailCount, requestedVehicleCount, usableRows] = await Promise.all([
      this.prisma.dvi_itinerary_plan_vendor_eligible_list.count({
        where: { itinerary_plan_id: planId, status: 1, deleted: 0 },
      }),
      this.prisma.dvi_itinerary_plan_vendor_vehicle_details.count({
        where: { itinerary_plan_id: planId, status: 1, deleted: 0 },
      }),
      this.prisma.dvi_itinerary_plan_vehicle_details.count({
        where: { itinerary_plan_id: planId, status: 1, deleted: 0 },
      }),
      this.prisma.dvi_itinerary_plan_vendor_vehicle_details.findFirst({
        where: {
          itinerary_plan_id: planId,
          status: 1,
          deleted: 0,
          itinerary_plan_vendor_eligible_ID: { gt: 0 },
          vehicle_type_id: { gt: 0 },
          total_vehicle_amount: { gt: 0 },
        },
        select: { itinerary_plan_vendor_vehicle_details_ID: true },
      }),
    ]);

    return {
      eligibleCount,
      vehicleDetailCount,
      requestedVehicleCount,
      hasUsableVehicleDetails: Boolean(usableRows),
    };
  }

  private async mapStatus(
    planId: number,
    sourceStatus: {
      status: VehicleBuildState;
      buildRunId?: string | null;
      startedAt?: string | null;
      finishedAt?: string | null;
      updatedAt?: string | null;
      error?: string | null;
    },
    statusSource: VehicleBuildStatus['statusSource'],
  ): Promise<VehicleBuildStatus> {
    const counts = await this.getCounts(planId);
    return {
      planId,
      status: sourceStatus.status,
      buildRunId: sourceStatus.buildRunId ?? null,
      startedAt: sourceStatus.startedAt ?? null,
      finishedAt: sourceStatus.finishedAt ?? null,
      updatedAt: sourceStatus.updatedAt ?? new Date().toISOString(),
      error: sourceStatus.error ?? null,
      eligibleCount: counts.eligibleCount,
      vehicleDetailCount: counts.vehicleDetailCount,
      requestedVehicleCount: counts.requestedVehicleCount,
      hasUsableVehicleDetails: counts.hasUsableVehicleDetails,
      isLatestBuildReady: sourceStatus.status === 'READY' && counts.hasUsableVehicleDetails,
      statusSource,
    };
  }

  private async deriveStatus(planId: number): Promise<VehicleBuildStatus | null> {
    const [routeCount, distinctPairRow] = await Promise.all([
      this.prisma.dvi_itinerary_route_details.count({
        where: { itinerary_plan_ID: planId, deleted: 0 },
      }),
      this.prisma.$queryRaw<Array<{ distinctPairCount: bigint | number }>>`
        SELECT COUNT(DISTINCT itinerary_plan_vendor_eligible_ID, itinerary_route_id) AS distinctPairCount
        FROM dvi_itinerary_plan_vendor_vehicle_details
        WHERE itinerary_plan_id = ${planId}
          AND status = 1
          AND deleted = 0
      `,
    ]);

    const counts = await this.getCounts(planId);
    const distinctPairCount = Number((distinctPairRow?.[0] as any)?.distinctPairCount || 0);
    const expectedDetailCount = Number(routeCount || 0) * Number(counts.eligibleCount || 0);

    if (
      routeCount > 0 &&
      counts.eligibleCount > 0 &&
      counts.vehicleDetailCount === expectedDetailCount &&
      distinctPairCount === counts.vehicleDetailCount
    ) {
      const nowIso = new Date().toISOString();
      return {
        planId,
        status: 'READY',
        buildRunId: null,
        startedAt: null,
        finishedAt: nowIso,
        updatedAt: nowIso,
        error: null,
        eligibleCount: counts.eligibleCount,
        vehicleDetailCount: counts.vehicleDetailCount,
        requestedVehicleCount: counts.requestedVehicleCount,
        hasUsableVehicleDetails: counts.hasUsableVehicleDetails,
        isLatestBuildReady: counts.hasUsableVehicleDetails,
        statusSource: 'derived',
      };
    }

    return null;
  }

  async getStatus(planId: number): Promise<VehicleBuildStatus> {
    const normalizedPlanId = Number(planId || 0);
    if (!normalizedPlanId) {
      throw new BadRequestException('planId is required');
    }

    const latestDbRow = await this.getLatestDbRow(normalizedPlanId);
    if (latestDbRow) {
      return this.mapStatus(
        normalizedPlanId,
        {
          status: String(latestDbRow.status || 'PENDING') as VehicleBuildState,
          buildRunId: String(latestDbRow.build_run_id || '') || null,
          startedAt: latestDbRow.started_at ? new Date(latestDbRow.started_at).toISOString() : null,
          finishedAt: latestDbRow.finished_at ? new Date(latestDbRow.finished_at).toISOString() : null,
          updatedAt: latestDbRow.updated_on ? new Date(latestDbRow.updated_on).toISOString() : new Date().toISOString(),
          error: latestDbRow.error ? String(latestDbRow.error) : null,
        },
        'db',
      );
    }

    const fromMemory = this.statusMap.get(normalizedPlanId);
    if (fromMemory) {
      return this.mapStatus(normalizedPlanId, fromMemory, 'memory');
    }

    const derived = await this.deriveStatus(normalizedPlanId);
    if (derived) return derived;

    const nowIso = new Date().toISOString();
    return {
      planId: normalizedPlanId,
      status: 'PENDING',
      startedAt: null,
      finishedAt: null,
      updatedAt: nowIso,
      error: null,
      buildRunId: null,
      eligibleCount: 0,
      vehicleDetailCount: 0,
      requestedVehicleCount: 0,
      hasUsableVehicleDetails: false,
      isLatestBuildReady: false,
      statusSource: 'derived',
    };
  }
}
