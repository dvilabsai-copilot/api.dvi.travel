import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';

/** Owns activity catalog, slot and plan-pricing response projection. */
@Injectable()
export class ItineraryActivityAvailabilityService {
  private calculateActivityPlanPricingCallback: ((params: any) => Promise<any>) | null = null;

  constructor(private readonly prisma: PrismaService) {}

  setCalculateActivityPlanPricingCallback(callback: (params: any) => Promise<any>): void {
    this.calculateActivityPlanPricingCallback = callback;
  }

  private calculateActivityPlanPricing(params: any) {
    if (!this.calculateActivityPlanPricingCallback) {
      throw new Error('Activity availability pricing callback is not configured');
    }
    return this.calculateActivityPlanPricingCallback(params);
  }

  async getAvailableActivities(hotspotId: number, planId?: number, routeId?: number) {
    const activities = await (this.prisma as any).dvi_activity.findMany({
      where: {
        hotspot_id: hotspotId,
        deleted: 0,
        status: 1,
      },
      select: {
        activity_id: true,
        activity_title: true,
        activity_description: true,
        activity_duration: true,
        max_allowed_person_count: true,
      },
      orderBy: { activity_title: 'asc' },
    });

    const activitiesWithSlots = await Promise.all(
      activities.map(async (a: any) => {
        const [timeSlots, pricing] = await Promise.all([
          (this.prisma as any).dvi_activity_time_slot_details.findMany({
            where: {
              activity_id: a.activity_id,
              deleted: 0,
              status: 1,
            },
            select: {
              activity_time_slot_ID: true,
              time_slot_type: true,
              special_date: true,
              start_time: true,
              end_time: true,
            },
            orderBy: { start_time: 'asc' },
          }),
          this.calculateActivityPlanPricing({
            planId,
            routeId,
            activityId: Number(a.activity_id || 0),
            hotspotId,
          }),
        ]);

        return {
          id: a.activity_id,
          title: a.activity_title || '',
          description: a.activity_description || '',
          duration: a.activity_duration || null,
          maxPersons: a.max_allowed_person_count || 0,

          pricingUnitType: pricing.pricingUnitType,
          priceUnitLabel: pricing.priceUnitLabel,
          nationalityType: pricing.nationalityType,
          adultCount: pricing.adults,
          childCount: pricing.children,
          costAdult: pricing.adultRate,
          costChild: pricing.childRate,
          unitCost: pricing.unitRate,
          totalAmount: pricing.totalAmount,
          totalPrice: pricing.totalAmount,
          priceDate: pricing.priceDate,

          timeSlots: timeSlots.map((ts: any) => ({
            id: ts.activity_time_slot_ID,
            type: ts.time_slot_type,
            specialDate: ts.special_date,
            startTime: ts.start_time,
            endTime: ts.end_time,
          })),
        };
      }),
    );

    return activitiesWithSlots;
  }


}
