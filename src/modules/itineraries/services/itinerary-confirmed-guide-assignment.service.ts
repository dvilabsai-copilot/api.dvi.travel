import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { ItineraryGuideAssignmentService } from './itinerary-guide-assignment.service';

type ConfirmedGuideSlotRow = {
  confirmedGuideSlotCostId: number;
  guideSlotCostDetailsId: number;
  routeGuideId: number;
  itineraryRouteId: number;
  itineraryRouteDate: string | null;
  guideId: number;
  guideType: number;
  guideSlot: number;
  guideSlotLabel: string;
  guideSlotCost: number;
  cancellationStatus: number;
  cancellationDefectType: number;
};

export type ConfirmedGuideAssignmentRow = {
  routeGuideId: number;
  itineraryRouteId: number;
  itineraryRouteDate: string | null;
  guideId: number;
  guideName: string;
  guideType: number;
  guideCost: number;
  guideLanguageIds: number[];
  guideLanguageLabels: string[];
  guideSlotIds: number[];
  guideSlotLabels: string[];
  cancellationStatus: number;
  slots: ConfirmedGuideSlotRow[];
};

/** Owns confirmed guide slot-cost hydration and response projection. */
export class ItineraryConfirmedGuideAssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly guideAssignmentService: ItineraryGuideAssignmentService,
  ) {}

  private parseCsvNumberList(value: unknown): number[] {
    return String(value ?? '')
      .split(',')
      .map((item) => Number(String(item).trim()))
      .filter((item) => Number.isFinite(item) && item > 0);
  }

  private formatDateOnly(value?: Date | string | null): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  }

  async ensureConfirmedGuideSlotCostRows(
    tx: any,
    itineraryPlanId: number,
    userId: number,
  ) {
    const existingCount = await tx.dvi_confirmed_itinerary_route_guide_slot_cost_details.count({
      where: { itinerary_plan_id: itineraryPlanId, deleted: 0 },
    });
    if (existingCount > 0) return;

    const draftSlotRows = await tx.dvi_itinerary_route_guide_slot_cost_details.findMany({
      where: { itinerary_plan_id: itineraryPlanId, deleted: 0 },
      orderBy: [
        { route_guide_id: 'asc' },
        { itinerary_route_date: 'asc' },
      ],
    });
    if (!draftSlotRows.length) return;

    await tx.dvi_confirmed_itinerary_route_guide_slot_cost_details.createMany({
      data: draftSlotRows.map((row: any) => ({
        guide_slot_cost_details_id: Number(row.guide_slot_cost_details_id || 0),
        route_guide_id: Number(row.route_guide_id || 0),
        itinerary_plan_id: itineraryPlanId,
        itinerary_route_id: Number(row.itinerary_route_id || 0),
        itinerary_route_date: row.itinerary_route_date,
        guide_id: Number(row.guide_id || 0),
        guide_type: Number(row.guide_type || 0),
        guide_slot: Number(row.guide_slot || 0),
        guide_slot_cost: Number(row.guide_slot_cost || 0),
        cancellation_status: 0,
        cancellation_defect_type: 0,
        createdby: Number(userId || 1),
        createdon: new Date(),
        updatedon: new Date(),
        status: 1,
        deleted: 0,
      })),
    });
  }

  async listConfirmedGuideAssignments(confirmedPlanId: number): Promise<ConfirmedGuideAssignmentRow[]> {
    const confirmedPlan = await this.prisma.dvi_confirmed_itinerary_plan_details.findUnique({
      where: { confirmed_itinerary_plan_ID: confirmedPlanId },
      select: { itinerary_plan_ID: true },
    });
    if (!confirmedPlan?.itinerary_plan_ID) {
      throw new NotFoundException('Confirmed itinerary not found');
    }

    const itineraryPlanId = Number(confirmedPlan.itinerary_plan_ID);
    const guideRows = await this.prisma.dvi_confirmed_itinerary_route_guide_details.findMany({
      where: { itinerary_plan_ID: itineraryPlanId, deleted: 0 },
      orderBy: [{ guide_type: 'asc' }, { itinerary_route_ID: 'asc' }, { route_guide_ID: 'asc' }],
    });
    const guideIds = Array.from(new Set(
      guideRows.map((row: any) => Number(row.guide_id || 0)).filter((id: number) => id > 0),
    ));
    const languageIds = Array.from(new Set(
      guideRows.flatMap((row: any) => this.parseCsvNumberList(row.guide_language)),
    ));

    const [slotRows, routeRows, guideMasters, languageRows] = await Promise.all([
      this.prisma.dvi_confirmed_itinerary_route_guide_slot_cost_details.findMany({
        where: { itinerary_plan_id: itineraryPlanId, deleted: 0 },
        orderBy: [{ route_guide_id: 'asc' }, { itinerary_route_date: 'asc' }, { guide_slot: 'asc' }],
      }),
      this.prisma.dvi_itinerary_route_details.findMany({
        where: { itinerary_plan_ID: itineraryPlanId, deleted: 0 },
        select: { itinerary_route_ID: true, itinerary_route_date: true },
      }),
      guideIds.length
        ? this.prisma.dvi_guide_details.findMany({
            where: { guide_id: { in: guideIds } },
            select: { guide_id: true, guide_name: true },
          })
        : Promise.resolve([] as any[]),
      languageIds.length
        ? this.prisma.dvi_language.findMany({
            where: { language_id: { in: languageIds }, deleted: 0 } as any,
            select: { language_id: true, language: true },
          })
        : Promise.resolve([] as any[]),
    ]);

    const routeMap = new Map<number, string | null>(routeRows.map((row: any) => [
      Number(row.itinerary_route_ID || 0),
      this.formatDateOnly(row.itinerary_route_date),
    ]));
    const guideMap = new Map<number, string>(guideMasters.map((row: any) => [
      Number(row.guide_id || 0),
      String(row.guide_name || ''),
    ]));
    const languageMap = new Map<number, string>(languageRows.map((row: any) => [
      Number(row.language_id || 0),
      String(row.language || ''),
    ]));
    const slotRowsByRouteGuideId = new Map<number, ConfirmedGuideSlotRow[]>();

    slotRows.forEach((row: any) => {
      const routeGuideId = Number(row.route_guide_id || 0);
      if (!slotRowsByRouteGuideId.has(routeGuideId)) slotRowsByRouteGuideId.set(routeGuideId, []);
      slotRowsByRouteGuideId.get(routeGuideId)?.push({
        confirmedGuideSlotCostId: Number(row.cnf_itinerary_guide_slot_cost_details_ID || 0),
        guideSlotCostDetailsId: Number(row.guide_slot_cost_details_id || 0),
        routeGuideId,
        itineraryRouteId: Number(row.itinerary_route_id || 0),
        itineraryRouteDate: this.formatDateOnly(row.itinerary_route_date),
        guideId: Number(row.guide_id || 0),
        guideType: Number(row.guide_type || 0),
        guideSlot: Number(row.guide_slot || 0),
        guideSlotLabel: this.guideAssignmentService.getGuideSlotLabel(Number(row.guide_slot || 0)),
        guideSlotCost: Number(row.guide_slot_cost || 0),
        cancellationStatus: Number(row.cancellation_status || 0),
        cancellationDefectType: Number(row.cancellation_defect_type || 0),
      });
    });

    return guideRows.map((row: any) => {
      const guideLanguageIds = this.parseCsvNumberList(row.guide_language);
      const guideSlotIds = this.parseCsvNumberList(row.guide_slot);
      const routeGuideId = Number(row.route_guide_ID || 0);
      return {
        routeGuideId,
        itineraryRouteId: Number(row.itinerary_route_ID || 0),
        itineraryRouteDate: routeMap.get(Number(row.itinerary_route_ID || 0))
          || slotRowsByRouteGuideId.get(routeGuideId)?.[0]?.itineraryRouteDate
          || null,
        guideId: Number(row.guide_id || 0),
        guideName: guideMap.get(Number(row.guide_id || 0)) || '',
        guideType: Number(row.guide_type || 0),
        guideCost: Number(row.guide_cost || 0),
        guideLanguageIds,
        guideLanguageLabels: guideLanguageIds.map((id) => languageMap.get(id) || `Language ${id}`),
        guideSlotIds,
        guideSlotLabels: guideSlotIds.map((id) => this.guideAssignmentService.getGuideSlotLabel(id)),
        cancellationStatus: Number(row.cancellation_status || 0),
        slots: slotRowsByRouteGuideId.get(routeGuideId) || [],
      };
    });
  }
}
