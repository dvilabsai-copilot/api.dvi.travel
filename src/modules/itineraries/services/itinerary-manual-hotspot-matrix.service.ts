// FILE: src/modules/itineraries/services/itinerary-manual-hotspot-matrix.service.ts

import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import {
  buildMissingManualHotspotMatrix as buildMissingManualHotspotMatrixHelper,
  ManualHotspotMatrixBuildResult,
} from '../helpers/manual-hotspot-matrix-builder';

type ManualHotspotMatrixCallbacks = {
  deriveLooseCityKey: (value: string) => string;
  normalizeLocationText: (value: string) => string;
};

@Injectable()
export class ItineraryManualHotspotMatrixService {
  private readonly locks = new Set<string>();
  private callbacks: Partial<ManualHotspotMatrixCallbacks> = {};

  constructor(private readonly prisma: PrismaService) {}

  setCallbacks(callbacks: ManualHotspotMatrixCallbacks) {
    this.callbacks = callbacks;
  }

  private deriveLooseCityKey(value: string) {
    return this.callbacks.deriveLooseCityKey!(value);
  }

  private normalizeLocationText(value: string) {
    return this.callbacks.normalizeLocationText!(value);
  }

  async buildMissingManualHotspotMatrix(params: {
    planId: number;
    routeId: number;
    candidateHotspotId: number;
    userId?: number;
  }): Promise<ManualHotspotMatrixBuildResult> {
    const planId = Number(params?.planId || 0);
    const routeId = Number(params?.routeId || 0);
    const candidateHotspotId = Number(params?.candidateHotspotId || 0);
    const userId = Number(params?.userId || 0);

    if (!Number.isInteger(planId) || planId <= 0) {
      throw new BadRequestException('planId must be a positive integer');
    }
    if (!Number.isInteger(routeId) || routeId <= 0) {
      throw new BadRequestException('routeId must be a positive integer');
    }
    if (!Number.isInteger(candidateHotspotId) || candidateHotspotId <= 0) {
      throw new BadRequestException('candidateHotspotId must be a positive integer');
    }

    const lockKey = `${planId}:${routeId}:${candidateHotspotId}`;
    if (this.locks.has(lockKey)) {
      return {
        success: false,
        code: 'MATRIX_BUILD_ALREADY_RUNNING',
        message: 'Matrix build is already running for this hotspot. Please wait.',
        planId,
        routeId,
        candidateHotspotId,
        candidateName: '',
        slotPairs: 0,
        successCount: 0,
        failedCount: 0,
        rows: [],
        osrmSource: String(process.env.OSRM_BASE_URL || 'https://router.project-osrm.org/route/v1/driving').trim(),
        publicDemoWarning: String(process.env.OSRM_BASE_URL || 'https://router.project-osrm.org/route/v1/driving').includes('router.project-osrm.org'),
        hasAnyMatrixData: false,
        hasFeasibleMatrixSlot: false,
        allSlotsAreOffRouteOrBacktrack: false,
        nextPreviewExpectedState: 'NO_FEASIBLE_ROUTE_SLOT',
      };
    }

    this.locks.add(lockKey);
    try {
      const routeRow = await this.prisma.dvi_itinerary_route_details.findFirst({
        where: {
          itinerary_route_ID: Number(routeId),
          deleted: 0,
        },
        select: {
          location_name: true,
          next_visiting_location: true,
          location_id: true,
        },
      });

      const candidate = await this.prisma.dvi_hotspot_place.findFirst({
        where: {
          hotspot_ID: Number(candidateHotspotId),
          deleted: 0,
        },
        select: {
          hotspot_ID: true,
          hotspot_name: true,
          hotspot_location: true,
        },
      });

      const sourceCityKey = this.deriveLooseCityKey(String(routeRow?.location_name || ''));
      const destinationCityKey = this.deriveLooseCityKey(String(routeRow?.next_visiting_location || ''));
      const candidateText = this.normalizeLocationText(
        `${candidate?.hotspot_name || ''} ${candidate?.hotspot_location || ''}`,
      );

      const candidateIsDestinationSide =
        !!destinationCityKey &&
        destinationCityKey !== sourceCityKey &&
        candidateText.includes(destinationCityKey);

      if (candidateIsDestinationSide) {
        return {
          success: true,
          code: 'DESTINATION_SIDE_MATRIX_NOT_REQUIRED',
          message: 'Destination-side manual hotspot does not require normal hotspot-to-hotspot matrix. Preview/apply should use destination-to-hotel timing logic.',
          planId,
          routeId,
          candidateHotspotId,
          candidateName: String(candidate?.hotspot_name || `Hotspot #${candidateHotspotId}`),
          slotPairs: 0,
          successCount: 0,
          failedCount: 0,
          rows: [],
          osrmSource: String(process.env.OSRM_BASE_URL || 'https://router.project-osrm.org/route/v1/driving').trim(),
          publicDemoWarning: String(process.env.OSRM_BASE_URL || 'https://router.project-osrm.org/route/v1/driving').includes('router.project-osrm.org'),
          hasAnyMatrixData: true,
          hasFeasibleMatrixSlot: true,
          allSlotsAreOffRouteOrBacktrack: false,
          nextPreviewExpectedState: 'FEASIBLE_PREVIEW',
        };
      }

      const result = await buildMissingManualHotspotMatrixHelper({
        prisma: this.prisma,
        input: {
          planId,
          routeId,
          candidateHotspotId,
          userId,
        },
        options: {
          osrmBaseUrl: String(process.env.OSRM_BASE_URL || 'https://router.project-osrm.org/route/v1/driving').trim(),
          osrmDelayMs: Number(process.env.OSRM_DELAY_MS || 800),
          osrmTimeoutMs: Number(process.env.OSRM_TIMEOUT_MS || 20000),
          logger: console,
        },
      });

      const resultCode = String((result as any)?.code || '').toUpperCase();

      return {
        ...result,
        success:
          result.successCount > 0
          || result.hasAnyMatrixData === true
          || resultCode === 'SINGLE_HOTSPOT_CITY_MATRIX_BUILT',
      };
    } catch (error: any) {
      return {
        success: false,
        code: 'MATRIX_BUILD_FAILED',
        message: String(error?.message || 'Matrix build failed.'),
        planId,
        routeId,
        candidateHotspotId,
        candidateName: '',
        slotPairs: 0,
        successCount: 0,
        failedCount: 0,
        rows: [],
        osrmSource: String(process.env.OSRM_BASE_URL || 'https://router.project-osrm.org/route/v1/driving').trim(),
        publicDemoWarning: String(process.env.OSRM_BASE_URL || 'https://router.project-osrm.org/route/v1/driving').includes('router.project-osrm.org'),
        hasAnyMatrixData: false,
        hasFeasibleMatrixSlot: false,
        allSlotsAreOffRouteOrBacktrack: false,
        nextPreviewExpectedState: 'NO_FEASIBLE_ROUTE_SLOT',
      };
    } finally {
      this.locks.delete(lockKey);
    }
  }

  /**
   * Add a manual hotspot to a route and rebuild the timeline.
   */
}
