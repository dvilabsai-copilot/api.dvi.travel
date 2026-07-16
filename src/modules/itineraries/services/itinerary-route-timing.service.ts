// FILE: src/modules/itineraries/services/itinerary-route-timing.service.ts

import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { HotspotEngineService } from '../engines/hotspot-engine.service';
import { TimeConverter } from '../engines/helpers/time-converter';

type RouteTimingCallbacks = Record<string, (...args: any[]) => any>;

@Injectable()
export class ItineraryRouteTimingService {
  private callbacks: RouteTimingCallbacks = {};

  constructor(
    private readonly prisma: PrismaService,
    private readonly hotspotEngine: HotspotEngineService,
  ) {}

  setCallbacks(callbacks: RouteTimingCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public async updateRouteTimes(
    planId: number,
    routeId: number,
    startTime: string,
    endTime: string,
    previousDayBillingDecisionProvided?: boolean,
    previousDayBillingConfirmed?: boolean,
    userId: number = 1,
  ) {
    console.log(`[updateRouteTimes] planId=${planId}, routeId=${routeId}, startTime=${startTime}, endTime=${endTime}`);

    const normalizedPlanId = Number(planId || 0);
    const normalizedRouteId = Number(routeId || 0);
    const normalizedStartTime = String(startTime || '').trim();
    const normalizedEndTime = String(endTime || '').trim();
    const normalizedDecisionProvided = Boolean(previousDayBillingDecisionProvided);
    const normalizedDecisionConfirmed = Boolean(previousDayBillingConfirmed);
    const hhmmss = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

    if (!normalizedPlanId || !normalizedRouteId) {
      throw new BadRequestException('planId and routeId are required');
    }

    if (!hhmmss.test(normalizedStartTime) || !hhmmss.test(normalizedEndTime)) {
      throw new BadRequestException('startTime and endTime must be in HH:MM:SS format');
    }

    const toTimeString = (value: unknown): string => {
      if (typeof value === 'string' && value.trim()) {
        return TimeConverter.toTimeString(value.trim());
      }
      return TimeConverter.toTimeString(value as any);
    };

    const combineDateAndTimeUtc = (routeDateValue: unknown, hhmmssTime: string): Date => {
      const routeDate = routeDateValue instanceof Date ? routeDateValue : new Date(routeDateValue as any);
      if (!Number.isFinite(routeDate.getTime())) {
        throw new BadRequestException('Invalid itinerary_route_date while computing itinerary boundary');
      }
      const [h, m, s] = hhmmssTime.split(':').map((v) => Number(v || 0));
      return new Date(
        Date.UTC(
          routeDate.getUTCFullYear(),
          routeDate.getUTCMonth(),
          routeDate.getUTCDate(),
          h,
          m,
          s,
        ),
      );
    };

    const subtractOneUtcDay = (value: Date): Date => {
      const d = new Date(value);
      d.setUTCDate(d.getUTCDate() - 1);
      return d;
    };

    const startTimeSeconds = (() => {
      const [h, m, s] = normalizedStartTime.split(':').map((v) => Number(v || 0));
      return (h * 3600) + (m * 60) + s;
    })();
    const isEarlyArrivalWindow = startTimeSeconds >= 3600 && startTimeSeconds < 28800; // 01:00:00–07:59:59

    const transactionResult = await this.prisma.$transaction(async (tx) => {
      // 1) Verify target route belongs to this plan
      const targetRoute = await (tx as any).dvi_itinerary_route_details.findFirst({
        where: {
          itinerary_route_ID: normalizedRouteId,
          itinerary_plan_ID: normalizedPlanId,
          deleted: 0,
        },
        select: {
          itinerary_route_ID: true,
          itinerary_route_date: true,
          no_of_days: true,
          next_visiting_location: true,
          location_name: true,
        },
      });

      if (!targetRoute) {
        const otherRecord = await (tx as any).dvi_itinerary_route_details.findUnique({
          where: { itinerary_route_ID: normalizedRouteId },
          select: { itinerary_plan_ID: true, deleted: true },
        });
        if (otherRecord) {
          throw new BadRequestException(
            `Route ${normalizedRouteId} belongs to plan ${otherRecord.itinerary_plan_ID}, not ${normalizedPlanId}`,
          );
        }
        throw new BadRequestException(`Route ${normalizedRouteId} not found`);
      }

      // 2) Persist requested route start/end times
      await (tx as any).dvi_itinerary_route_details.update({
        where: { itinerary_route_ID: normalizedRouteId },
        data: {
          route_start_time: TimeConverter.toDate(normalizedStartTime),
          route_end_time: TimeConverter.toDate(normalizedEndTime),
          updatedon: new Date(),
        },
      });

      // 3) Recompute itinerary-level trip boundaries from route rows.
      //    If Day-1 route time changed, itinerary start/pickup must follow route day-1 start.
      const commonRouteWhere = {
        itinerary_plan_ID: normalizedPlanId,
        deleted: 0,
        status: 1,
      };

      const routeBoundarySelect = {
        itinerary_route_ID: true,
        itinerary_route_date: true,
        no_of_days: true,
        next_visiting_location: true,
        location_name: true,
        route_start_time: true,
        route_end_time: true,
      };

      const [firstRoute, lastRoute] = await Promise.all([
        (tx as any).dvi_itinerary_route_details.findFirst({
          where: commonRouteWhere,
          orderBy: [
            { no_of_days: 'asc' },
            { itinerary_route_date: 'asc' },
            { itinerary_route_ID: 'asc' },
          ],
          select: routeBoundarySelect,
        }),
        (tx as any).dvi_itinerary_route_details.findFirst({
          where: commonRouteWhere,
          orderBy: [
            { no_of_days: 'desc' },
            { itinerary_route_date: 'desc' },
            { itinerary_route_ID: 'desc' },
          ],
          select: routeBoundarySelect,
        }),
      ]);

      if (!firstRoute || !lastRoute) {
        throw new BadRequestException(`No active routes found for plan ${normalizedPlanId}`);
      }

      const firstRouteStartTime = toTimeString(firstRoute.route_start_time);
      const lastRouteStartTime = toTimeString(lastRoute.route_start_time);
      const lastRouteEndTime = toTimeString(lastRoute.route_end_time);

      const itineraryStartDateTime = combineDateAndTimeUtc(
        firstRoute.itinerary_route_date,
        firstRouteStartTime,
      );

      const lastRouteStartDateTime = combineDateAndTimeUtc(
        lastRoute.itinerary_route_date,
        lastRouteStartTime,
      );
      const itineraryEndDateTime = combineDateAndTimeUtc(
        lastRoute.itinerary_route_date,
        lastRouteEndTime,
      );
      if (itineraryEndDateTime.getTime() < lastRouteStartDateTime.getTime()) {
        itineraryEndDateTime.setUTCDate(itineraryEndDateTime.getUTCDate() + 1);
      }

      const isDay1RouteUpdated = Number(firstRoute.itinerary_route_ID) === normalizedRouteId;

      // Persist previous-day billing decision as marker rows for hotel-details rendering.
      if (isDay1RouteUpdated) {
        const existingMarkerRows = await (tx as any).dvi_itinerary_plan_hotel_details.findMany({
          where: {
            itinerary_plan_id: normalizedPlanId,
            itinerary_route_id: normalizedRouteId,
            hotel_required: 2,
            hotel_id: 0,
            deleted: 0,
          },
          select: {
            group_type: true,
            itinerary_route_date: true,
            itinerary_route_location: true,
          },
        });

        if (
          normalizedDecisionProvided &&
          normalizedDecisionConfirmed &&
          isEarlyArrivalWindow
        ) {
          const firstRouteDate = new Date(firstRoute.itinerary_route_date as any);
          if (!Number.isNaN(firstRouteDate.getTime())) {
            const previousDayDate = subtractOneUtcDay(
              new Date(Date.UTC(
                firstRouteDate.getUTCFullYear(),
                firstRouteDate.getUTCMonth(),
                firstRouteDate.getUTCDate(),
                0,
                0,
                0,
              )),
            );
            const routeLocation = String(
              (firstRoute as any).next_visiting_location ||
              (firstRoute as any).location_name ||
              '',
            ).trim();

            const expectedDateIso = previousDayDate.toISOString().slice(0, 10);
            const expectedGroups = new Set([1, 2, 3, 4]);

            const markersAlreadyUpToDate =
              existingMarkerRows.length === 4 &&
              existingMarkerRows.every((row: any) => {
                const rowDateIso = new Date(row.itinerary_route_date as any).toISOString().slice(0, 10);
                const rowGroup = Number(row.group_type || 0);
                const rowLocation = String(row.itinerary_route_location || '').trim();
                return (
                  expectedGroups.has(rowGroup) &&
                  rowDateIso === expectedDateIso &&
                  rowLocation === (routeLocation || '')
                );
              });

            if (!markersAlreadyUpToDate) {
              if (existingMarkerRows.length > 0) {
                await (tx as any).dvi_itinerary_plan_hotel_details.deleteMany({
                  where: {
                    itinerary_plan_id: normalizedPlanId,
                    itinerary_route_id: normalizedRouteId,
                    hotel_required: 2,
                    hotel_id: 0,
                    deleted: 0,
                  },
                });
              }

              const markerRows = [1, 2, 3, 4].map((groupType) => ({
                group_type: groupType,
                itinerary_plan_id: normalizedPlanId,
                itinerary_route_id: normalizedRouteId,
                itinerary_route_date: previousDayDate,
                itinerary_route_location: routeLocation || null,
                hotel_required: 2,
                hotel_id: 0,
                total_no_of_rooms: 0,
                total_hotel_cost: 0,
                total_hotel_tax_amount: 0,
                createdby: 1,
                createdon: new Date(),
                status: 1,
                deleted: 0,
              }));

              await (tx as any).dvi_itinerary_plan_hotel_details.createMany({
                data: markerRows,
              });
            }
          }
        } else if (existingMarkerRows.length > 0) {
          await (tx as any).dvi_itinerary_plan_hotel_details.deleteMany({
            where: {
              itinerary_plan_id: normalizedPlanId,
              itinerary_route_id: normalizedRouteId,
              hotel_required: 2,
              hotel_id: 0,
              deleted: 0,
            },
          });
        }
      }

      const planUpdateData: any = {
        trip_end_date_and_time: itineraryEndDateTime,
        updatedon: new Date(),
      };

      if (isDay1RouteUpdated) {
        planUpdateData.trip_start_date_and_time = itineraryStartDateTime;
        planUpdateData.pick_up_date_and_time = itineraryStartDateTime;
      }

      await (tx as any).dvi_itinerary_plan_details.updateMany({
        where: {
          itinerary_plan_ID: normalizedPlanId,
          deleted: 0,
        },
        data: planUpdateData,
      });

      // 4) Rebuild itinerary timeline rows (same core build as createPlan hotspot stage)
      const rebuildResult = await this.hotspotEngine.rebuildRouteHotspots(tx, normalizedPlanId);

      return {
        success: true,
        planId: normalizedPlanId,
        routeId: normalizedRouteId,
        routeTimes: {
          startTime: normalizedStartTime,
          endTime: normalizedEndTime,
        },
        itineraryBoundaries: {
          tripStartDateTime: isDay1RouteUpdated ? itineraryStartDateTime.toISOString() : null,
          tripEndDateTime: itineraryEndDateTime.toISOString(),
          day1RouteUpdated: isDay1RouteUpdated,
        },
        rebuildSummary: rebuildResult.rebuildSummary,
        warnings: rebuildResult.warnings,
        previousDayBillingDecision: {
          decisionProvided: normalizedDecisionProvided,
          confirmed: normalizedDecisionConfirmed,
          markerCreated:
            isDay1RouteUpdated &&
            normalizedDecisionProvided &&
            normalizedDecisionConfirmed &&
            isEarlyArrivalWindow,
        },
      };
    }, { timeout: 180000, maxWait: 20000 });

    // Route time changes can change active hotspot segments, sightseeing KM,
    // travel KM, running time, extra KM, and vehicle pricing.
    // Therefore vehicle pricing must be rebuilt after the timeline rebuild.
    await this.hotspotEngine.rebuildParkingCharges(normalizedPlanId, Number(userId || 1));

    await this.callbacks.forceRebuildVehiclePricingAfterHotspotChange(
      normalizedPlanId,
      normalizedRouteId,
    );

    return {
      ...transactionResult,
      parkingChargesRebuilt: true,
      vehiclePricingRebuilt: true,
      pricePreserved: false,
    };
  }

  /**
   * Get confirmed itinerary data with hotels for cancellation page
   */
}

