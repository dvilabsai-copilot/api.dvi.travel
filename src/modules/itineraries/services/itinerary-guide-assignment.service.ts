import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';

type GuideAssignmentRow = {
  routeGuideId: number;
  planId: number;
  routeId: number | null;
  routeDate: string | null;
  guideType: number;
  guideId: number;
  guideName: string;
  guideLanguage: string;
  guideLanguageIds: number[];
  guideLanguageLabels: string[];
  guideSlot: string;
  guideSlotIds: number[];
  guideSlotLabels: string[];
  guideCost: number;
};

type GuideCostResult = {
  guideId: number | null;
  totalGuideCost: number;
  datewiseCost: Record<string, number>;
};

type GuideSlotOption = { id: number; label: string };

const GUIDE_SLOT_OPTIONS: GuideSlotOption[] = [
  { id: 1, label: '8 AM to 1 PM' },
  { id: 2, label: '1 PM to 6 PM' },
  { id: 3, label: '8 AM to 6 PM' },
  { id: 4, label: '6 PM to 9 PM' },
];

/** Owns guide availability, assignment projections and guide-cost resolution. */
@Injectable()
export class ItineraryGuideAssignmentService {
  constructor(private readonly prisma: PrismaService) {}

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

  getGuideSlotLabel(slotId: number): string {
    return GUIDE_SLOT_OPTIONS.find((slot) => slot.id === Number(slotId))?.label || `Slot ${slotId}`;
  }

  getGuidePaxBucket(totalPax: number): number {
    if (totalPax <= 5) return 1;
    if (totalPax <= 14) return 2;
    return 3;
  }

  guideHasLanguage(value: unknown, languageId: number): boolean {
    if (!languageId) return false;
    return this.parseCsvNumberList(value).includes(languageId);
  }

  guideHasAllSlots(value: unknown, slotIds: number[]): boolean {
    const available = new Set(this.parseCsvNumberList(value));
    return slotIds.every((slotId) => available.has(slotId));
  }

  async guideDateHasAnyAvailablePrice(params: {
    routeDate: string;
    totalPaxCount: number;
  }): Promise<boolean> {
    const routeDate = String(params.routeDate || '').slice(0, 10);
    const date = new Date(routeDate);
    if (!Number.isFinite(date.getTime())) return false;

    const paxBucket = this.getGuidePaxBucket(Number(params.totalPaxCount || 0));
    const year = String(date.getUTCFullYear());
    const month = date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
    const dayKey = `day_${date.getUTCDate()}`;
    const guideSlotIds = GUIDE_SLOT_OPTIONS.map((slot) => Number(slot.id));
    const guideCandidates = await this.prisma.dvi_guide_details.findMany({
      where: { deleted: 0, status: 1, guide_preffered_for: 3 } as any,
      select: { guide_id: true, guide_available_slot: true },
    });
    if (!guideCandidates.length) return false;

    const guideSlotMap = new Map<number, Set<number>>();
    const guideIds: number[] = [];
    for (const guide of guideCandidates as any[]) {
      const guideId = Number(guide.guide_id || 0);
      if (!(guideId > 0)) continue;
      const availableSlots = new Set(
        this.parseCsvNumberList(guide.guide_available_slot)
          .filter((slotId) => guideSlotIds.includes(Number(slotId))),
      );
      if (availableSlots.size === 0) continue;
      guideIds.push(guideId);
      guideSlotMap.set(guideId, availableSlots);
    }
    if (!guideIds.length) return false;

    const pricebookRows = await this.prisma.dvi_guide_pricebook.findMany({
      where: {
        deleted: 0,
        guide_id: { in: guideIds },
        pax_count: paxBucket,
        slot_type: { in: guideSlotIds },
        year,
        month,
      } as any,
    });
    return pricebookRows.some((row: any) => {
      const guideId = Number(row.guide_id || 0);
      const slotType = Number(row.slot_type || 0);
      const slotAllowedForGuide = guideSlotMap.get(guideId)?.has(slotType) === true;
      const price = Number(row?.[dayKey] ?? 0);
      return slotAllowedForGuide && Number.isFinite(price) && price > 0;
    });
  }

  async getGuideAvailability(planId: number) {
    if (!(planId > 0)) throw new BadRequestException('planId is required');
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

    const totalPaxCount = Number((plan as any).total_adult || 0)
      + Number((plan as any).total_children || 0)
      + Number((plan as any).total_infants || 0);
    const routeRows = await this.prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: planId, deleted: 0, status: 1 } as any,
      orderBy: [{ itinerary_route_date: 'asc' }, { itinerary_route_ID: 'asc' }],
      select: { itinerary_route_ID: true, itinerary_route_date: true },
    });

    const days = await Promise.all(routeRows.map(async (route: any) => {
      const routeDate = this.formatDateOnly(route.itinerary_route_date);
      const available = routeDate
        ? await this.guideDateHasAnyAvailablePrice({ routeDate, totalPaxCount })
        : false;
      return { routeId: Number(route.itinerary_route_ID || 0), routeDate, available };
    }));
    return {
      planId,
      wholeItineraryAvailable: days.length > 0 && days.every((day) => day.available),
      hasAnyGuidePrice: days.some((day) => day.available),
      days,
    };
  }

  applyGuideGst(totalCharges: number, guideGst: number, gstType: number): number {
    if (!(totalCharges > 0) || !(guideGst > 0)) return totalCharges;
    if (gstType === 1) {
      const baseAmount = totalCharges / (1 + guideGst / 100);
      return baseAmount + (totalCharges - baseAmount);
    }
    if (gstType === 2) return totalCharges + (totalCharges * guideGst) / 100;
    return totalCharges;
  }

  async getPlanRouteDates(planId: number): Promise<string[]> {
    const rows = await this.prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: planId, deleted: 0, status: 1 } as any,
      orderBy: [{ itinerary_route_date: 'asc' }, { itinerary_route_ID: 'asc' }],
      select: { itinerary_route_date: true },
    });
    return rows
      .map((row: any) => this.formatDateOnly(row.itinerary_route_date))
      .filter((value: string | null): value is string => Boolean(value));
  }

  async resolveEligibleGuideCost(params: {
    planId: number;
    routeId?: number | null;
    routeDate?: string | null;
    guideType: number;
    languageId: number;
    slotIds?: number[];
    totalPaxCount: number;
  }): Promise<GuideCostResult> {
    const guideType = Number(params.guideType || 0);
    const languageId = Number(params.languageId || 0);
    const totalPaxCount = Number(params.totalPaxCount || 0);
    const requestedSlotIds = Array.from(new Set((params.slotIds ?? [])
      .map((slotId) => Number(slotId))
      .filter((slotId) => Number.isFinite(slotId) && slotId > 0)));
    if (![1, 2].includes(guideType) || !(languageId > 0) || (guideType === 2 && requestedSlotIds.length === 0)) {
      return { guideId: null, totalGuideCost: 0, datewiseCost: {} };
    }

    const routeDates = guideType === 1
      ? await this.getPlanRouteDates(params.planId)
      : [String(params.routeDate ?? '').slice(0, 10)].filter(Boolean);
    if (routeDates.length === 0) return { guideId: null, totalGuideCost: 0, datewiseCost: {} };

    const paxBucket = this.getGuidePaxBucket(totalPaxCount);
    const guideCandidates = await this.prisma.dvi_guide_details.findMany({
      where: { deleted: 0, status: 1, guide_preffered_for: 3 } as any,
      orderBy: { guide_id: 'asc' },
      select: {
        guide_id: true,
        guide_gst: true,
        gst_type: true,
        guide_language_proficiency: true,
        guide_available_slot: true,
      },
    });
    const eligibleGuide = guideCandidates.find((guide: any) =>
      this.guideHasLanguage(guide.guide_language_proficiency, languageId)
      && this.guideHasAllSlots(guide.guide_available_slot, requestedSlotIds));
    if (!eligibleGuide) return { guideId: null, totalGuideCost: 0, datewiseCost: {} };

    const pricebookRows = await this.prisma.dvi_guide_pricebook.findMany({
      where: {
        deleted: 0,
        guide_id: eligibleGuide.guide_id,
        pax_count: paxBucket,
        slot_type: { in: requestedSlotIds },
      } as any,
    });
    let totalCharges = 0;
    const datewiseCost: Record<string, number> = {};
    for (const routeDate of routeDates) {
      const date = new Date(routeDate);
      if (!Number.isFinite(date.getTime())) continue;
      const year = String(date.getUTCFullYear());
      const month = date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
      const dayKey = `day_${date.getUTCDate()}`;
      const matchingRows = pricebookRows.filter((row: any) =>
        String(row.year ?? '') === year
        && String(row.month ?? '').toLowerCase() === month.toLowerCase());
      const dailyCharge = matchingRows.reduce((sum: number, row: any) => {
        const rawValue = Number(row?.[dayKey] ?? 0);
        return sum + (Number.isFinite(rawValue) ? rawValue : 0);
      }, 0);
      totalCharges += dailyCharge;
      datewiseCost[routeDate] = dailyCharge;
    }
    return {
      guideId: eligibleGuide.guide_id,
      totalGuideCost: this.applyGuideGst(totalCharges, Number(eligibleGuide.guide_gst ?? 0), Number(eligibleGuide.gst_type ?? 0)),
      datewiseCost,
    };
  }

  async listGuideAssignments(planId: number): Promise<GuideAssignmentRow[]> {
    if (!(planId > 0)) throw new BadRequestException('planId is required');
    const guideRows = await this.prisma.dvi_itinerary_route_guide_details.findMany({
      where: { itinerary_plan_ID: planId, deleted: 0, status: 1 } as any,
      orderBy: [{ guide_type: 'asc' }, { itinerary_route_ID: 'asc' }, { route_guide_ID: 'asc' }],
      select: {
        route_guide_ID: true,
        itinerary_plan_ID: true,
        itinerary_route_ID: true,
        guide_id: true,
        guide_type: true,
        guide_language: true,
        guide_slot: true,
        guide_cost: true,
      },
    });
    const routeIds = Array.from(new Set(guideRows.map((row: any) => Number(row.itinerary_route_ID || 0)).filter((id) => id > 0)));
    const guideIds = Array.from(new Set(guideRows.map((row: any) => Number(row.guide_id || 0)).filter((id) => id > 0)));
    const languageIds = Array.from(new Set(guideRows.flatMap((row: any) => this.parseCsvNumberList(row.guide_language))));
    const [routeRows, guideMasters, languageRows] = await Promise.all([
      routeIds.length
        ? this.prisma.dvi_itinerary_route_details.findMany({ where: { itinerary_route_ID: { in: routeIds }, deleted: 0 } as any, select: { itinerary_route_ID: true, itinerary_route_date: true } })
        : Promise.resolve([] as any[]),
      guideIds.length
        ? this.prisma.dvi_guide_details.findMany({ where: { guide_id: { in: guideIds }, deleted: 0 } as any, select: { guide_id: true, guide_name: true } })
        : Promise.resolve([] as any[]),
      languageIds.length
        ? this.prisma.dvi_language.findMany({ where: { language_id: { in: languageIds }, status: 1 as any } as any, select: { language_id: true, language: true } })
        : Promise.resolve([] as any[]),
    ]);
    const routeMap = new Map(routeRows.map((route: any) => [Number(route.itinerary_route_ID), route]));
    const guideMap = new Map(guideMasters.map((guide: any) => [Number(guide.guide_id), String(guide.guide_name ?? '')]));
    const languageMap = new Map(languageRows.map((language: any) => [Number(language.language_id), String(language.language ?? '')]));
    return guideRows.map((row: any) => {
      const guideLanguageIds = this.parseCsvNumberList(row.guide_language);
      const guideSlotIds = this.parseCsvNumberList(row.guide_slot);
      const route = routeMap.get(Number(row.itinerary_route_ID || 0));
      return {
        routeGuideId: Number(row.route_guide_ID),
        planId: Number(row.itinerary_plan_ID),
        routeId: Number(row.itinerary_route_ID || 0) || null,
        routeDate: this.formatDateOnly(route?.itinerary_route_date),
        guideType: Number(row.guide_type || 0),
        guideId: Number(row.guide_id || 0),
        guideName: guideMap.get(Number(row.guide_id || 0)) || '',
        guideLanguage: String(row.guide_language ?? ''),
        guideLanguageIds,
        guideLanguageLabels: guideLanguageIds.map((id) => languageMap.get(id) || `Language ${id}`),
        guideSlot: String(row.guide_slot ?? ''),
        guideSlotIds,
        guideSlotLabels: guideSlotIds.map((id) => this.getGuideSlotLabel(id)),
        guideCost: Number(row.guide_cost ?? 0),
      };
    });
  }

  async getGuideAssignmentOptions(planId: number, routeGuideId?: number) {
    if (!(planId > 0)) throw new BadRequestException('planId is required');
    const [languages, assignments] = await Promise.all([
      this.prisma.dvi_language.findMany({
        where: { status: 1 as any, deleted: false as any } as any,
        orderBy: { language: 'asc' },
        select: { language_id: true, language: true },
      }),
      routeGuideId ? this.listGuideAssignments(planId) : Promise.resolve([] as GuideAssignmentRow[]),
    ]);
    const assignment = routeGuideId
      ? assignments.find((item) => item.routeGuideId === routeGuideId) ?? null
      : null;
    return {
      languages: languages.map((language: any) => ({ id: Number(language.language_id), label: String(language.language ?? '') })),
      slots: GUIDE_SLOT_OPTIONS,
      assignment,
    };
  }
}
