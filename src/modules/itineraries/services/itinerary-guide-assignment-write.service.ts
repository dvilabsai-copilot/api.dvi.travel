import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { ItineraryGuideAssignmentService } from './itinerary-guide-assignment.service';

export type SaveGuideAssignmentPayload = {
  routeGuideId?: number;
  routeId?: number;
  routeDate?: string;
  guideType?: number;
  guideLanguage: number;
  guideSlots?: number[];
};

/** Owns draft guide assignment validation, costing and slot-cost persistence. */
export class ItineraryGuideAssignmentWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly guideAssignmentService: ItineraryGuideAssignmentService,
  ) {}

  private formatDateOnly(value?: Date | string | null): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  }

  private resolveEligibleGuideCost(params: {
    planId: number;
    routeId?: number | null;
    routeDate?: string | null;
    guideType: number;
    languageId: number;
    slotIds?: number[];
    totalPaxCount: number;
  }) {
    return this.guideAssignmentService.resolveEligibleGuideCost(params);
  }

  async saveGuideAssignment(
    planId: number,
    payload: SaveGuideAssignmentPayload,
    userId: number,
  ) {
    if (!(planId > 0)) {
      throw new BadRequestException('itinerary_plan_ID_required');
    }

    const guideType = Number(payload.guideType || 2);
    const routeId = Number(payload.routeId || 0);
    const routeGuideId = Number(payload.routeGuideId || 0);
    const guideLanguage = Number(payload.guideLanguage || 0);
    const guideSlots = Array.from(
      new Set(
        (payload.guideSlots ?? [])
          .map((slotId) => Number(slotId))
          .filter((slotId) => Number.isFinite(slotId) && slotId > 0),
      ),
    );

    if (!(guideLanguage > 0)) {
      throw new BadRequestException('guide_language_required');
    }
    if (![1, 2].includes(guideType)) {
      throw new BadRequestException('guide_type_required');
    }
    if (guideType === 2 && !(routeId > 0)) {
      throw new BadRequestException('itinerary_route_ID_required');
    }
    if (guideSlots.length === 0) {
      throw new BadRequestException('guide_slot_required');
    }

    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: planId },
      select: {
        itinerary_plan_ID: true,
        total_adult: true,
        total_children: true,
        total_infants: true,
      },
    });
    if (!plan || Number((plan as any).itinerary_plan_ID || 0) <= 0) {
      throw new NotFoundException('Itinerary plan not found');
    }

    const routeRow = guideType === 2
      ? await this.prisma.dvi_itinerary_route_details.findFirst({
          where: {
            itinerary_plan_ID: planId,
            itinerary_route_ID: routeId,
            deleted: 0,
          } as any,
          select: {
            itinerary_route_ID: true,
            itinerary_route_date: true,
          },
        })
      : null;
    if (guideType === 2 && !routeRow) {
      throw new NotFoundException('Route not found');
    }

    const routeDate = guideType === 2
      ? (payload.routeDate?.slice(0, 10) || this.formatDateOnly(routeRow?.itinerary_route_date))
      : null;
    const totalPaxCount = Number((plan as any).total_adult || 0)
      + Number((plan as any).total_children || 0)
      + Number((plan as any).total_infants || 0);
    const guideResult = await this.resolveEligibleGuideCost({
      planId,
      routeId: routeId || null,
      routeDate,
      guideType,
      languageId: guideLanguage,
      slotIds: guideSlots,
      totalPaxCount,
    });

    if (!(guideResult.totalGuideCost > 0) || !(Number(guideResult.guideId || 0) > 0)) {
      throw new BadRequestException('guide_not_available');
    }

    const guideLanguageCsv = String(guideLanguage);
    const guideSlotCsv = guideSlots.join(',');
    const savedGuide = await this.prisma.$transaction(async (tx) => {
      let routeGuideRecord: any;
      const commonData = {
        itinerary_plan_ID: planId,
        itinerary_route_ID: guideType === 2 ? routeId : 0,
        guide_id: Number(guideResult.guideId),
        guide_type: guideType,
        guide_language: guideLanguageCsv,
        guide_slot: guideSlotCsv,
        guide_cost: Number(guideResult.totalGuideCost.toFixed(2)),
        createdby: Number(userId || 1),
        updatedon: new Date(),
        status: 1 as any,
        deleted: 0 as any,
      };

      if (routeGuideId > 0) {
        routeGuideRecord = await tx.dvi_itinerary_route_guide_details.update({
          where: { route_guide_ID: routeGuideId },
          data: commonData as any,
        });
      } else {
        routeGuideRecord = await tx.dvi_itinerary_route_guide_details.create({
          data: { ...commonData, createdon: new Date() } as any,
        });
      }

      await tx.dvi_itinerary_route_guide_slot_cost_details.deleteMany({
        where: {
          route_guide_id: Number(routeGuideRecord.route_guide_ID),
          itinerary_plan_id: planId,
        } as any,
      });

      if (guideType === 2 && routeDate) {
        const slotRows = [];
        for (const slotId of guideSlots) {
          const slotGuideResult = await this.resolveEligibleGuideCost({
            planId,
            routeId,
            routeDate,
            guideType,
            languageId: guideLanguage,
            slotIds: [slotId],
            totalPaxCount,
          });
          slotRows.push({
            route_guide_id: Number(routeGuideRecord.route_guide_ID),
            itinerary_plan_id: planId,
            itinerary_route_id: routeId,
            itinerary_route_date: new Date(routeDate),
            guide_id: Number(slotGuideResult.guideId || guideResult.guideId || 0),
            guide_type: guideType,
            guide_slot: slotId,
            guide_slot_cost: Number(slotGuideResult.totalGuideCost.toFixed(2)),
            createdby: Number(userId || 1),
            createdon: new Date(),
            updatedon: new Date(),
            status: 1 as any,
            deleted: 0 as any,
          });
        }
        if (slotRows.length > 0) {
          await tx.dvi_itinerary_route_guide_slot_cost_details.createMany({ data: slotRows as any });
        }
      } else if (guideType === 1) {
        const routeDates = await this.guideAssignmentService.getPlanRouteDates(planId);
        const slotCostRows: any[] = [];
        for (const day of routeDates) {
          for (const slotId of guideSlots) {
            const slotGuideResult = await this.resolveEligibleGuideCost({
              planId,
              routeId: null,
              routeDate: day,
              guideType,
              languageId: guideLanguage,
              slotIds: [slotId],
              totalPaxCount,
            });
            slotCostRows.push({
              route_guide_id: Number(routeGuideRecord.route_guide_ID),
              itinerary_plan_id: planId,
              itinerary_route_id: 0,
              itinerary_route_date: new Date(day),
              guide_id: Number(slotGuideResult.guideId || guideResult.guideId || 0),
              guide_type: guideType,
              guide_slot: slotId,
              guide_slot_cost: Number((slotGuideResult.datewiseCost[day] ?? 0).toFixed(2)),
              createdby: Number(userId || 1),
              createdon: new Date(),
              updatedon: new Date(),
              status: 1 as any,
              deleted: 0 as any,
            });
          }
        }
        if (slotCostRows.length > 0) {
          await tx.dvi_itinerary_route_guide_slot_cost_details.createMany({ data: slotCostRows as any });
        }
      }
      return routeGuideRecord;
    });

    return {
      success: true,
      routeGuideId: Number(savedGuide.route_guide_ID),
      guideCost: Number(savedGuide.guide_cost ?? 0),
    };
  }

  async deleteGuideAssignment(planId: number, routeGuideId: number, routeId?: number) {
    if (!(planId > 0)) {
      throw new BadRequestException('planId is required');
    }
    if (!(routeGuideId > 0)) {
      throw new BadRequestException('routeGuideId is required');
    }

    const whereGuide: any = {
      route_guide_ID: routeGuideId,
      itinerary_plan_ID: planId,
    };
    if (routeId && routeId > 0) {
      whereGuide.itinerary_route_ID = routeId;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.dvi_itinerary_route_guide_slot_cost_details.deleteMany({
        where: {
          route_guide_id: routeGuideId,
          itinerary_plan_id: planId,
        } as any,
      });
      await tx.dvi_itinerary_route_guide_details.deleteMany({
        where: whereGuide,
      });
    });

    return { success: true };
  }
}
