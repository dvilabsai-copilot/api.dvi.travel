import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { randomUUID } from 'crypto';
import { createConnection } from 'mysql2/promise';

export type VehicleBuildState = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED' | 'NOT_REQUIRED';

/** Audit metadata only. Readiness is computed from persisted vehicle rows, never from this record. */
export type VehicleBuildAuditRecord = {
  planId: number;
  buildRunId: string;
  status: VehicleBuildState;
  error: string | null;
};

@Injectable()
export class ItineraryVehicleBuildStatusService {
  constructor(private readonly prisma: PrismaService) {}

  createBuildRunId(planId: number): string {
    return `${planId}-${Date.now()}-${randomUUID()}`;
  }

  async startRecord(planId: number, buildRunId: string, userId: number): Promise<void> {
    const now = new Date();
    await this.prisma.dvi_itinerary_vehicle_build_status.create({
      data: {
        itinerary_plan_id: planId,
        build_run_id: buildRunId,
        status: 'PROCESSING',
        started_at: now,
        finished_at: null,
        error: null,
        created_by: userId,
        created_on: now,
        updated_on: now,
      },
    });
  }

  async finishRecord(
    planId: number,
    buildRunId: string,
    status: Extract<VehicleBuildState, 'READY' | 'FAILED' | 'NOT_REQUIRED'>,
    error: string | null,
  ): Promise<void> {
    const now = new Date();
    const updated = await this.prisma.dvi_itinerary_vehicle_build_status.updateMany({
      where: { itinerary_plan_id: planId, build_run_id: buildRunId },
      data: { status, finished_at: now, error, updated_on: now },
    });

    // A start record is normally mandatory. Keep this fallback audit-safe for
    // legacy callers/tests without making the table part of build control flow.
    if (Number(updated.count || 0) === 0) {
      await this.prisma.dvi_itinerary_vehicle_build_status.create({
        data: {
          itinerary_plan_id: planId,
          build_run_id: buildRunId,
          status,
          started_at: now,
          finished_at: now,
          error,
          created_by: 0,
          created_on: now,
          updated_on: now,
        },
      });
    }
  }

  /**
   * Coordinates vehicle rebuild ownership across Node processes using a
   * connection-scoped MySQL advisory lock. The lock connection is kept open
   * for the complete build, including all staged Prisma transactions.
   */
  async withPlanBuildLock<T>(
    planId: number,
    work: () => Promise<T>,
    waitSeconds = 10,
  ): Promise<T> {
    const normalizedPlanId = Number(planId || 0);
    if (!normalizedPlanId) throw new BadRequestException('planId is required');

    const databaseUrl = String(process.env.DATABASE_URL || '').trim();
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required for vehicle build coordination');
    }

    const lockName = `itinerary_vehicle_build:${normalizedPlanId}`;
    const connection = await createConnection(databaseUrl);
    let acquired = false;

    try {
      const [lockRows] = await connection.query<any[]>(
        'SELECT GET_LOCK(?, ?) AS acquired',
        [lockName, waitSeconds],
      );
      acquired = Number(lockRows?.[0]?.acquired ?? 0) === 1;
      if (!acquired) {
        throw new ConflictException({
          message: 'Vehicle pricing is already running for this saved itinerary. Retry after it completes.',
          code: 'VEHICLE_BUILD_IN_PROGRESS',
          planId: normalizedPlanId,
        });
      }

      return await work();
    } finally {
      if (acquired) {
        try {
          await connection.query('SELECT RELEASE_LOCK(?) AS released', [lockName]);
        } catch (releaseError) {
          console.error('[VehicleBuildLock] Failed to release MySQL advisory lock', {
            planId: normalizedPlanId,
            message: String((releaseError as any)?.message || releaseError || 'Unknown release error'),
          });
        }
      }

      try {
        await connection.end();
      } catch (closeError) {
        console.error('[VehicleBuildLock] Failed to close MySQL lock connection', {
          planId: normalizedPlanId,
          message: String((closeError as any)?.message || closeError || 'Unknown close error'),
        });
      }
    }
  }
}
