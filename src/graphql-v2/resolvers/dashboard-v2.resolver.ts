import { Context } from '@nestjs/graphql';
import { Query, Resolver } from '@nestjs/graphql';
import { DashboardService } from '../../modules/dashboard/dashboard.service';
import {
  DashboardDailyMomentV2Type,
  DashboardSummaryV2Type,
} from '../types/dashboard-summary.type';

@Resolver(() => DashboardSummaryV2Type)
export class DashboardV2Resolver {
  constructor(private readonly dashboardService: DashboardService) {}

  @Query(() => DashboardSummaryV2Type, { name: 'dashboardSummaryV2' })
  async dashboardSummaryV2(@Context() context: any): Promise<DashboardSummaryV2Type> {
    const user = context?.req?.user;
    let raw: any;

 // Keep role-based behavior aligned with the existing REST dashboard endpoint.
    if (user?.role === 4) {
      raw = await this.dashboardService.getAgentDashboardStats(Number(user.agentId));
    } else if (user?.role === 6) {
      raw = await this.dashboardService.getAccountsDashboardStats();
    } else if (user?.role === 2 || (user?.vendorId && Number(user.vendorId) > 0)) {
      raw = await this.dashboardService.getVendorDashboardStats(Number(user.vendorId));
    } else if (
      user?.role === 3 ||
      user?.role === 8 ||
      (user?.staffId && Number(user.staffId) > 0)
    ) {
      raw = await this.dashboardService.getTravelExpertDashboardStats(Number(user.staffId));
    } else if (user?.role === 5 || (user?.guideId && Number(user.guideId) > 0)) {
      raw = await this.dashboardService.getGuideDashboardStats(Number(user.guideId));
    } else {
      raw = await this.dashboardService.getDashboardStats();
    }

    const firstDailyMoment = Array.isArray(raw?.dailyMoment)
      ? (raw.dailyMoment[0] as DashboardDailyMomentV2Type | undefined)
      : undefined;

    return {
      stats: {
        totalAgents: Number(raw?.stats?.totalAgents ?? raw?.totalAgents ?? 0),
        totalDrivers: Number(raw?.stats?.totalDrivers ?? 0),
        totalItineraries: Number(raw?.stats?.totalItineraries ?? 0),
        confirmedBookings: Number(raw?.stats?.confirmedBookings ?? raw?.confirmedBookings ?? 0),
        totalRevenue: Number(raw?.stats?.totalRevenue ?? 0),
      },
      profit: {
        currentMonth: Number(raw?.profit?.currentMonth ?? 0),
        lastMonth: Number(raw?.profit?.lastMonth ?? raw?.lastMonthProfit ?? 0),
        percentageChange: Number(raw?.profit?.percentageChange ?? 0),
      },
      vehicles: {
        total: Number(raw?.vehicles?.total ?? 0),
        available: Number(raw?.vehicles?.available ?? 0),
        onRoute: Number(raw?.vehicles?.onRoute ?? 0),
        upcoming: Number(raw?.vehicles?.upcoming ?? 0),
      },
      vendors: {
        total: Number(raw?.vendors?.total ?? 0),
        branches: Number(raw?.vendors?.branches ?? 0),
        inactive: Number(raw?.vendors?.inactive ?? 0),
      },
      drivers: {
        total: Number(raw?.drivers?.total ?? 0),
        active: Number(raw?.drivers?.active ?? 0),
        inactive: Number(raw?.drivers?.inactive ?? 0),
        onRoute: Number(raw?.drivers?.onRoute ?? 0),
        available: Number(raw?.drivers?.available ?? 0),
      },
      hotels: {
        total: Number(raw?.hotels?.total ?? 0),
        rooms: Number(raw?.hotels?.rooms ?? 0),
        amenities: Number(raw?.hotels?.amenities ?? 0),
        bookings: Number(raw?.hotels?.bookings ?? raw?.confirmedBookings ?? 0),
      },
      dailyMoment: firstDailyMoment
        ? {
            quoteId: firstDailyMoment.quoteId,
            location: firstDailyMoment.location,
          }
        : null,
      starPerformer: raw?.starPerformer
        ? {
            name: raw.starPerformer.name ?? null,
            phone: raw.starPerformer.phone ?? null,
            performance:
              raw.starPerformer.performance !== undefined
                ? Number(raw.starPerformer.performance)
                : null,
          }
        : null,
    };
  }
}
