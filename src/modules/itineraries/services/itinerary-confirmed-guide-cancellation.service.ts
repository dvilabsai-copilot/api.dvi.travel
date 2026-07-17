import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { ItineraryConfirmedGuideAssignmentService } from './itinerary-confirmed-guide-assignment.service';

/** Owns confirmed guide-slot cancellation persistence and financial state transitions. */
@Injectable()
export class ItineraryConfirmedGuideCancellationService {
  private logCancellationActionCallback: (...args: any[]) => Promise<any> = async () => {
    throw new Error('Confirmed guide cancellation logging callback is not configured');
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly confirmedGuideAssignmentService: ItineraryConfirmedGuideAssignmentService,
  ) {}

  setLogCancellationActionCallback(callback: (...args: any[]) => Promise<any>): void {
    this.logCancellationActionCallback = callback;
  }

  private getGuideCancellationDefectTypeId(defectType?: string): number {
    return String(defectType || 'dvi').trim().toLowerCase() === 'guest' ? 2 : 1;
  }

  private logCancellationAction(...args: any[]) {
    return this.logCancellationActionCallback(...args);
  }
  async cancelConfirmedGuideSlot(
    confirmedPlanId: number,
    payload: {
      routeGuideId: number;
      guideSlotCostDetailsId: number;
      itineraryRouteId?: number;
      cancellationPercentage?: number;
      defectType?: string;
      reason?: string;
    },
    userId: number,
  ) {
    if (!(confirmedPlanId > 0)) {
      throw new BadRequestException('confirmedPlanId is required');
    }
    if (!(Number(payload.routeGuideId || 0) > 0)) {
      throw new BadRequestException('routeGuideId is required');
    }
    if (!(Number(payload.guideSlotCostDetailsId || 0) > 0)) {
      throw new BadRequestException('guideSlotCostDetailsId is required');
    }

    const confirmedPlan = await this.prisma.dvi_confirmed_itinerary_plan_details.findUnique({
      where: { confirmed_itinerary_plan_ID: confirmedPlanId },
      select: {
        confirmed_itinerary_plan_ID: true,
        itinerary_plan_ID: true,
        itinerary_quote_ID: true,
        itinerary_total_net_payable_amount: true,
      },
    });

    if (!confirmedPlan?.itinerary_plan_ID) {
      throw new NotFoundException('Confirmed itinerary not found');
    }

    const itineraryPlanId = Number(confirmedPlan.itinerary_plan_ID);
    const cancellationPercentage = Math.max(0, Math.min(100, Number(payload.cancellationPercentage ?? 10) || 10));
    const defectTypeId = this.getGuideCancellationDefectTypeId(payload.defectType);
    const cancellationReason = String(payload.reason || 'Guide slot cancelled').trim();

    return this.prisma.$transaction(async (tx) => {
      await this.confirmedGuideAssignmentService.ensureConfirmedGuideSlotCostRows(tx, itineraryPlanId, userId);

      const confirmedGuide = await tx.dvi_confirmed_itinerary_route_guide_details.findFirst({
        where: {
          itinerary_plan_ID: itineraryPlanId,
          route_guide_ID: Number(payload.routeGuideId),
          deleted: 0,
        },
      });

      if (!confirmedGuide) {
        throw new NotFoundException('Confirmed guide not found');
      }

      const confirmedSlot = await tx.dvi_confirmed_itinerary_route_guide_slot_cost_details.findFirst({
        where: {
          itinerary_plan_id: itineraryPlanId,
          route_guide_id: Number(payload.routeGuideId),
          guide_slot_cost_details_id: Number(payload.guideSlotCostDetailsId),
          deleted: 0,
        },
      });

      if (!confirmedSlot) {
        throw new NotFoundException('Confirmed guide slot not found');
      }

      if (Number(confirmedSlot.cancellation_status || 0) === 1) {
        throw new ConflictException('Guide slot already cancelled');
      }

      let cancellation = await tx.dvi_cancelled_itineraries.findFirst({
        where: { itinerary_plan_id: itineraryPlanId, deleted: 0 },
      });

      if (!cancellation) {
        const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
        cancellation = await tx.dvi_cancelled_itineraries.create({
          data: {
            itinerary_plan_id: itineraryPlanId,
            cancellation_reason: cancellationReason,
            cancellation_reference: `CANCEL_${timestamp}_${itineraryPlanId}`,
            cancellation_status: 'completed',
            cancelled_by: userId,
            cancelled_on: new Date(),
            modify_hotspot: 0,
            modify_hotel: 0,
            modify_vehicle: 0,
            modify_guide: 1,
            modify_activity: 0,
            itinerary_cancellation_status: 2,
            total_cancelled_service_amount: 0,
            total_cancellation_charge: 0,
            total_refund_amount: 0,
            createdby: userId,
            createdon: new Date(),
            updatedon: new Date(),
            status: 1,
            deleted: 0,
          },
        });
      }

      let cancelledGuide = await tx.dvi_cancelled_itinerary_route_guide_details.findFirst({
        where: {
          itinerary_plan_ID: itineraryPlanId,
          route_guide_ID: Number(payload.routeGuideId),
          deleted: 0,
        },
      });

      if (!cancelledGuide) {
        cancelledGuide = await tx.dvi_cancelled_itinerary_route_guide_details.create({
          data: {
            cancelled_itinerary_ID: Number(cancellation.cancelled_itinerary_ID),
            confirmed_route_guide_ID: Number(confirmedGuide.confirmed_route_guide_ID || 0),
            route_guide_ID: Number(confirmedGuide.route_guide_ID || 0),
            itinerary_plan_ID: itineraryPlanId,
            itinerary_route_ID: Number(confirmedGuide.itinerary_route_ID || 0),
            guide_id: Number(confirmedGuide.guide_id || 0),
            guide_status: Number(confirmedGuide.guide_status || 0),
            guide_not_visited_description: confirmedGuide.guide_not_visited_description,
            driver_guide_status: Number(confirmedGuide.driver_guide_status || 0),
            driver_not_visited_description: confirmedGuide.driver_not_visited_description,
            guide_type: Number(confirmedGuide.guide_type || 0),
            guide_language: confirmedGuide.guide_language,
            guide_slot: confirmedGuide.guide_slot,
            guide_cost: Number(confirmedGuide.guide_cost || 0),
            createdby: userId,
            createdon: new Date(),
            updatedon: new Date(),
            status: 1,
            deleted: 0,
          },
        });
      }

      let cancelledSlot = await tx.dvi_cancelled_itinerary_route_guide_slot_cost_details.findFirst({
        where: {
          itinerary_plan_id: itineraryPlanId,
          route_guide_id: Number(payload.routeGuideId),
          guide_slot_cost_details_id: Number(payload.guideSlotCostDetailsId),
          deleted: 0,
        },
      });

      if (!cancelledSlot) {
        cancelledSlot = await tx.dvi_cancelled_itinerary_route_guide_slot_cost_details.create({
          data: {
            cancelled_itinerary_ID: Number(cancellation.cancelled_itinerary_ID),
            cnf_itinerary_guide_slot_cost_details_ID: Number(confirmedSlot.cnf_itinerary_guide_slot_cost_details_ID || 0),
            guide_slot_cost_details_id: Number(confirmedSlot.guide_slot_cost_details_id || 0),
            route_guide_id: Number(confirmedSlot.route_guide_id || 0),
            itinerary_plan_id: itineraryPlanId,
            itinerary_route_id: Number(confirmedSlot.itinerary_route_id || 0),
            itinerary_route_date: confirmedSlot.itinerary_route_date,
            guide_id: Number(confirmedSlot.guide_id || 0),
            guide_type: Number(confirmedSlot.guide_type || 0),
            guide_slot: Number(confirmedSlot.guide_slot || 0),
            guide_slot_cost: Number(confirmedSlot.guide_slot_cost || 0),
            createdby: userId,
            createdon: new Date(),
            updatedon: new Date(),
            status: 1,
            deleted: 0,
          },
        });
      }

      const slotCost = Number(confirmedSlot.guide_slot_cost || 0);
      const cancellationCharge = Number(((slotCost * cancellationPercentage) / 100).toFixed(2));
      const refundAmount = Number((slotCost - cancellationCharge).toFixed(2));
      const cancelledOn = new Date();

      await tx.dvi_cancelled_itinerary_route_guide_slot_cost_details.update({
        where: {
          cancelled_itinerary_guide_slot_cost_details_ID: Number(cancelledSlot.cancelled_itinerary_guide_slot_cost_details_ID),
        },
        data: {
          cancelled_itinerary_ID: Number(cancellation.cancelled_itinerary_ID),
          slot_cancellation_status: 1,
          cancelled_on: cancelledOn,
          defect_type: defectTypeId,
          slot_cancellation_percentage: cancellationPercentage,
          total_slot_cancelled_service_amount: slotCost,
          total_slot_cancellation_charge: cancellationCharge,
          total_slot_refund_amount: refundAmount,
          updatedon: new Date(),
        },
      });

      await tx.dvi_confirmed_itinerary_route_guide_slot_cost_details.update({
        where: {
          cnf_itinerary_guide_slot_cost_details_ID: Number(confirmedSlot.cnf_itinerary_guide_slot_cost_details_ID),
        },
        data: {
          cancellation_status: 1,
          cancellation_defect_type: defectTypeId,
          updatedon: new Date(),
        },
      });

      await tx.dvi_cancelled_itinerary_details.create({
        data: {
          cancelled_itinerary_id: Number(cancellation.cancelled_itinerary_ID),
          itinerary_plan_id: itineraryPlanId,
          itinerary_guide_cancellation_status: 1,
          cancellation_date: cancelledOn,
          cancelled_by: userId,
          total_cancelled_service_amount: slotCost,
          total_cancellation_charge: cancellationCharge,
          total_refund_amount: Math.round(refundAmount),
          createdby: userId,
          createdon: new Date(),
          updatedon: new Date(),
          status: 1,
          deleted: 0,
        },
      });

      const routeCancelledSlots = await tx.dvi_cancelled_itinerary_route_guide_slot_cost_details.aggregate({
        where: {
          itinerary_plan_id: itineraryPlanId,
          route_guide_id: Number(payload.routeGuideId),
          slot_cancellation_status: 1,
          deleted: 0,
        },
        _sum: {
          total_slot_cancelled_service_amount: true,
          total_slot_cancellation_charge: true,
          total_slot_refund_amount: true,
        },
        _count: {
          cancelled_itinerary_guide_slot_cost_details_ID: true,
        },
      });

      const totalRouteSlots = await tx.dvi_confirmed_itinerary_route_guide_slot_cost_details.count({
        where: {
          itinerary_plan_id: itineraryPlanId,
          route_guide_id: Number(payload.routeGuideId),
          deleted: 0,
        },
      });

      const cancelledRouteSlotCount = Number(routeCancelledSlots._count?.cancelled_itinerary_guide_slot_cost_details_ID || 0);
      const routeFullyCancelled = totalRouteSlots > 0 && cancelledRouteSlotCount >= totalRouteSlots;

      await tx.dvi_cancelled_itinerary_route_guide_details.update({
        where: {
          cancelled_route_guide_ID: Number(cancelledGuide.cancelled_route_guide_ID),
        },
        data: {
          cancelled_itinerary_ID: Number(cancellation.cancelled_itinerary_ID),
          route_cancellation_status: routeFullyCancelled ? 1 : 0,
          cancelled_on: routeFullyCancelled ? cancelledOn : cancelledGuide.cancelled_on,
          total_route_cancelled_service_amount: Number(routeCancelledSlots._sum?.total_slot_cancelled_service_amount || 0),
          total_route_cancellation_charge: Number(routeCancelledSlots._sum?.total_slot_cancellation_charge || 0),
          total_route_refund_amount: Number(routeCancelledSlots._sum?.total_slot_refund_amount || 0),
          updatedon: new Date(),
        },
      });

      if (routeFullyCancelled) {
        await tx.dvi_confirmed_itinerary_route_guide_details.update({
          where: {
            confirmed_route_guide_ID: Number(confirmedGuide.confirmed_route_guide_ID),
          },
          data: {
            cancellation_status: 1,
            updatedon: new Date(),
          },
        });
      }

      const itineraryCancelledGuideCount = await tx.dvi_confirmed_itinerary_route_guide_details.count({
        where: {
          itinerary_plan_ID: itineraryPlanId,
          cancellation_status: 1,
          deleted: 0,
        },
      });
      const itineraryGuideCount = await tx.dvi_confirmed_itinerary_route_guide_details.count({
        where: {
          itinerary_plan_ID: itineraryPlanId,
          deleted: 0,
        },
      });
      const allGuidesCancelled = itineraryGuideCount > 0 && itineraryCancelledGuideCount >= itineraryGuideCount;

      const aggregatedCancellation = await tx.dvi_cancelled_itinerary_route_guide_slot_cost_details.aggregate({
        where: {
          itinerary_plan_id: itineraryPlanId,
          slot_cancellation_status: 1,
          deleted: 0,
        },
        _sum: {
          total_slot_cancelled_service_amount: true,
          total_slot_cancellation_charge: true,
          total_slot_refund_amount: true,
        },
      });

      await tx.dvi_cancelled_itineraries.update({
        where: { cancelled_itinerary_ID: Number(cancellation.cancelled_itinerary_ID) },
        data: {
          cancellation_reason: cancellationReason,
          cancelled_by: userId,
          cancelled_on: cancelledOn,
          modify_guide: 1,
          total_cancelled_service_amount: Number(aggregatedCancellation._sum?.total_slot_cancelled_service_amount || 0),
          total_cancellation_charge: Number(aggregatedCancellation._sum?.total_slot_cancellation_charge || 0),
          total_refund_amount: Math.round(Number(aggregatedCancellation._sum?.total_slot_refund_amount || 0)),
          itinerary_cancellation_status: allGuidesCancelled ? 1 : 2,
          cancellation_status: 'completed',
          updatedon: new Date(),
        },
      });

      await tx.dvi_confirmed_itinerary_plan_details.update({
        where: { confirmed_itinerary_plan_ID: confirmedPlanId },
        data: {
          itinerary_cancellation_status: allGuidesCancelled ? 1 : 2,
          updatedon: new Date(),
        },
      });

      await this.logCancellationAction(
        tx,
        Number(cancellation.cancelled_itinerary_ID),
        itineraryPlanId,
        'guide_slot_cancelled',
        `routeGuideId=${payload.routeGuideId}, slotCostId=${payload.guideSlotCostDetailsId}, refund=${refundAmount}`,
        userId,
      );

      return {
        success: true,
        message: 'Guide slot cancelled successfully',
        data: {
          routeGuideId: Number(payload.routeGuideId),
          guideSlotCostDetailsId: Number(payload.guideSlotCostDetailsId),
          slotCost,
          cancellationPercentage,
          cancellationCharge,
          refundAmount,
          routeFullyCancelled,
          itineraryGuideCancellationStatus: allGuidesCancelled ? 1 : 2,
          cancelledOn,
        },
      };
    });
  }

}

