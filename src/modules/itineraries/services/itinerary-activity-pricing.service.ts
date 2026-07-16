import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';

export interface ActivityPlanPricingParams {
  planId?: number | null;
  routeId?: number | null;
  activityId: number;
  hotspotId?: number | null;
}

export interface ActivityPlanPricing {
  pricingUnitType: 'PER_ADULT' | 'UNIT';
  priceUnitLabel: string;
  nationalityType: number;
  adults: number;
  children: number;
  adultRate: number;
  childRate: number;
  unitRate: number;
  totalAmount: number;
  priceDate: string | null;
}

@Injectable()
export class ItineraryActivityPricingService {
  constructor(private readonly prisma: PrismaService) {}

  private formatDateOnly(value?: Date | string | null): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  }

  async calculateActivityPlanPricing(
    params: ActivityPlanPricingParams,
    db: any = this.prisma,
  ): Promise<ActivityPlanPricing> {
    const empty: ActivityPlanPricing = {
      pricingUnitType: 'PER_ADULT',
      priceUnitLabel: 'per adult',
      nationalityType: 1,
      adults: 0,
      children: 0,
      adultRate: 0,
      childRate: 0,
      unitRate: 0,
      totalAmount: 0,
      priceDate: null,
    };

    const activityId = Number(params.activityId || 0);
    if (!activityId) return empty;
    const planId = Number(params.planId || 0);
    const routeId = Number(params.routeId || 0);
    const plan = planId
      ? await db.dvi_itinerary_plan_details.findFirst({
          where: { itinerary_plan_ID: planId, deleted: 0 },
          select: { total_adult: true, total_children: true, nationality: true, trip_start_date_and_time: true },
        })
      : null;
    const route = planId && routeId
      ? await db.dvi_itinerary_route_details.findFirst({
          where: { itinerary_plan_ID: planId, itinerary_route_ID: routeId, deleted: 0 },
          select: { itinerary_route_date: true },
        })
      : null;
    const adults = Math.max(Number(plan?.total_adult || 0), 0);
    const children = Math.max(Number(plan?.total_children || 0), 0);
    const priceDate = this.formatDateOnly(route?.itinerary_route_date || plan?.trip_start_date_and_time || new Date());
    const [yearText, monthText, dayText] = String(priceDate || '').split('-');
    const year = Number(yearText || 0);
    const month = Number(monthText || 0);
    const day = Number(dayText || 0);
    let nationalityType = 1;

    const nationalityId = Number(plan?.nationality || 0);
    if (nationalityId > 0) {
      const country = await db.dvi_countries.findFirst({
        where: { id: nationalityId, deleted: 0, status: 1 },
        select: { shortname: true },
      });
      const iso2 = String(country?.shortname || '').trim().toUpperCase();
      if (iso2 && iso2 !== 'IN') nationalityType = 2;
      else if (!iso2 && nationalityId === 2) nationalityType = 2;
    }

    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const monthName = month >= 1 && month <= 12 ? monthNames[month - 1] : '';
    const dayKey = day >= 1 && day <= 31 ? `day_${day}` : 'day_1';
    const priceSelect = { price_type: true, [dayKey]: true } as any;
    let priceRows = year && monthName
      ? await db.dvi_activity_pricebook.findMany({
          where: { activity_id: activityId, nationality: nationalityType, year: String(year), month: monthName, deleted: 0, status: 1 },
          select: priceSelect,
        })
      : [];
    let effectiveDayKey = dayKey;
    if (!priceRows.length) {
      priceRows = await db.dvi_activity_pricebook.findMany({
        where: { activity_id: activityId, nationality: nationalityType, deleted: 0, status: 1 },
        select: { price_type: true, day_1: true },
      });
      effectiveDayKey = 'day_1';
    }

    const getRate = (priceType: number) => {
      const row = priceRows.find((item: any) => Number(item?.price_type || 0) === priceType);
      return Number(row?.[effectiveDayKey] || 0);
    };
    const adultRate = getRate(1);
    const childRate = getRate(2);
    const unitRate = getRate(4);
    const pricingUnitType = unitRate > 0 ? 'UNIT' : 'PER_ADULT';
    const totalAmount = pricingUnitType === 'UNIT' ? unitRate : adultRate * adults + childRate * children;
    return {
      pricingUnitType,
      priceUnitLabel: pricingUnitType === 'UNIT' ? 'per unit' : 'per adult',
      nationalityType,
      adults,
      children,
      adultRate,
      childRate,
      unitRate,
      totalAmount,
      priceDate,
    };
  }
}
