import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  async getDashboardStats() {
 // Get counts in parallel for better performance
    const [
      totalAgents,
      totalDrivers,
      totalGuides,
      totalItineraries,
      confirmedBookings,
      cancelledBookings,
      totalVehicles,
      totalVendors,
      totalHotels,
      totalHotelRooms,
      totalAmenities,
    ] = await Promise.all([
 // Total Agents
      this.prisma.dvi_agent.count({
        where: { deleted: 0 },
      }),

 // Total Drivers
      this.prisma.dvi_driver_details.count({
        where: { deleted: 0 },
      }),

 // Total Guides
      this.prisma.dvi_guide_details.count({
        where: { deleted: 0 },
      }),

 // Total Itineraries
      this.prisma.dvi_itinerary_plan_details.count({
        where: { deleted: 0 },
      }),

 // Confirmed Bookings
      this.prisma.dvi_itinerary_plan_details.count({
        where: { deleted: 0, quotation_status: 1 },
      }),

 // Cancelled Bookings (assuming there's a cancelled status)
      this.prisma.dvi_itinerary_plan_details.count({
        where: { deleted: 1 },
      }),

 // Total Vehicles
      this.prisma.dvi_vehicle_type.count({
        where: { deleted: 0 },
      }),

 // Total Vendors
      this.prisma.dvi_vendor_details.count({
        where: { deleted: 0 },
      }),

 // Total Hotels
      this.prisma.dvi_hotel.count({
        where: { deleted: false },
      }),

 // Total Hotel Rooms
      this.prisma.dvi_hotel_roomtype.count({
        where: { deleted: 0 },
      }),

 // Total Amenities
      this.prisma.dvi_hotel_amenities.count({
        where: { deleted: 0 },
      }),
    ]);

 // Get vendor branches count
    const vendorBranches: any = await this.prisma.$queryRaw`
      SELECT COUNT(DISTINCT vendor_branch_id) as count
      FROM dvi_vendor_branches
      WHERE deleted = 0
    `;
    const totalVendorBranches = Number(vendorBranches[0]?.count || 0);

 // Get inactive vendors
    const inactiveVendors = await this.prisma.dvi_vendor_details.count({
      where: { deleted: 0, status: 0 },
    });

 // Get driver stats
    const activeDrivers = await this.prisma.dvi_driver_details.count({
      where: { deleted: 0, status: 1 },
    });

    const inactiveDrivers = await this.prisma.dvi_driver_details.count({
      where: { deleted: 0, status: 0 },
    });

 // Get revenue data (this is a placeholder - adjust based on your actual revenue tracking)
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();
    const lastMonth = currentMonth === 1 ? 12 : currentMonth - 1;
    const lastMonthYear = currentMonth === 1 ? currentYear - 1 : currentYear;

 // Calculate total revenue from confirmed itineraries
    const totalRevenueData: any = await this.prisma.$queryRaw`
      SELECT COALESCE(SUM(expecting_budget), 0) as total
      FROM dvi_itinerary_plan_details
      WHERE deleted = 0 AND quotation_status = 1
    `;
    const totalRevenue = Number(totalRevenueData[0]?.total || 0);

 // Get current month profit
    const currentMonthProfit: any = await this.prisma.$queryRaw`
      SELECT COALESCE(SUM(expecting_budget), 0) as total
      FROM dvi_itinerary_plan_details
      WHERE deleted = 0
        AND quotation_status = 1
        AND MONTH(trip_start_date_and_time) = ${currentMonth}
        AND YEAR(trip_start_date_and_time) = ${currentYear}
    `;

 // Get last month profit
    const lastMonthProfit: any = await this.prisma.$queryRaw`
      SELECT COALESCE(SUM(expecting_budget), 0) as total
      FROM dvi_itinerary_plan_details
      WHERE deleted = 0
        AND quotation_status = 1
        AND MONTH(trip_start_date_and_time) = ${lastMonth}
        AND YEAR(trip_start_date_and_time) = ${lastMonthYear}
    `;

    const currentProfit = Number(currentMonthProfit[0]?.total || 0);
    const lastProfit = Number(lastMonthProfit[0]?.total || 0);

 // Calculate percentage change
    let profitChange = 0;
    if (lastProfit > 0) {
      profitChange = ((currentProfit - lastProfit) / lastProfit) * 100;
    }

 // Get daily moment data (today's itineraries)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const dailyMoments = await this.prisma.dvi_itinerary_plan_details.findMany({
      where: {
        deleted: 0,
        trip_start_date_and_time: {
          gte: today,
          lt: tomorrow,
        },
      },
      select: {
        itinerary_quote_ID: true,
        arrival_location: true,
      },
      take: 5,
    });

 // Get top agent (placeholder - adjust based on your rating/performance logic)
    const topAgent = await this.prisma.dvi_agent.findFirst({
      where: { deleted: 0 },
      select: {
        agent_name: true,
        agent_primary_mobile_number: true,
      },
      orderBy: { agent_ID: 'desc' },
    });

    return {
      stats: {
        totalAgents,
        totalDrivers,
        totalGuides,
        totalItineraries,
        totalRevenue,
        confirmedBookings,
        cancelledBookings,
      },
      profit: {
        lastMonth: lastProfit,
        currentMonth: currentProfit,
        percentageChange: Number(profitChange.toFixed(2)),
      },
      vehicles: {
        total: totalVehicles,
 onRoute: 0, // Placeholder - implement based on your vehicle tracking
        available: totalVehicles,
        upcoming: 0,
      },
      vendors: {
        total: totalVendors,
        branches: totalVendorBranches,
        inactive: inactiveVendors,
      },
      drivers: {
        total: totalDrivers,
        active: activeDrivers,
        inactive: inactiveDrivers,
 onRoute: 0, // Placeholder
        available: activeDrivers,
      },
      hotels: {
        total: totalHotels,
        rooms: totalHotelRooms,
        amenities: totalAmenities,
        bookings: confirmedBookings,
      },
      dailyMoment: dailyMoments.map((dm) => ({
        quoteId: dm.itinerary_quote_ID,
        location: dm.arrival_location,
      })),
      starPerformer: topAgent
        ? {
            name: topAgent.agent_name,
            phone: topAgent.agent_primary_mobile_number,
 performance: 60, // Placeholder
          }
        : null,
    };
  }

  async getAgentDashboardStats(agentId: number) {
    const now = new Date();
    const firstDayLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastDayLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

    const [
      totalCustomers,
      paidInvoices,
      subscription,
      lastMonthProfit,
      agentDetails,
    ] = await Promise.all([
 // Total Customers
      this.prisma.dvi_itinerary_plan_details.count({
        where: { agent_id: agentId, deleted: 0 },
      }),

 // Paid Invoices
      this.prisma.dvi_itinerary_plan_details.count({
        where: { agent_id: agentId, quotation_status: 1, deleted: 0 },
      }),

 // Validity Ends
      this.prisma.dvi_agent_subscribed_plans.findFirst({
        where: { agent_ID: agentId, status: 1, deleted: 0 },
        orderBy: { validity_end: 'desc' },
      }),

 // Last Month Profit
      this.prisma.dvi_itinerary_plan_details.aggregate({
        _sum: { agent_margin: true },
        where: {
          agent_id: agentId,
          deleted: 0,
          createdon: {
            gte: firstDayLastMonth,
            lte: lastDayLastMonth,
          },
        },
      }),

 // Agent Details for Wallet
      this.prisma.dvi_agent.findUnique({
        where: { agent_ID: agentId },
        select: { total_cash_wallet: true },
      }),
    ]);

    return {
      totalCustomers,
      paidInvoices,
      validityEnds: subscription?.validity_end || null,
      planId: subscription?.subscription_plan_ID || null,
      staffCount: subscription?.staff_count || 0,
      lastMonthProfit: lastMonthProfit._sum.agent_margin || 0,
      totalCashWallet: agentDetails?.total_cash_wallet || 0,
    };
  }

  async getVehicleAgentDashboardStats(agentId: number) {
    const scope = { agent_id: agentId, itinerary_preference: 2, deleted: 0 };
    const [totalItineraries, confirmedItineraries] = await Promise.all([
      this.prisma.dvi_itinerary_plan_details.count({ where: scope }),
      this.prisma.dvi_itinerary_plan_details.count({
        where: { ...scope, quotation_status: 1 },
      }),
    ]);

    return { totalItineraries, confirmedItineraries };
  }

  async getTravelExpertDashboardStats(staffId: number) {
 // Travel Expert manages a set of agents
    const agents = await this.prisma.dvi_agent.findMany({
      where: { travel_expert_id: staffId, deleted: 0 },
      select: { agent_ID: true },
    });
    const agentIds = agents.map((a) => a.agent_ID);

    const [
      totalAgents,
      totalItineraries,
      confirmedBookings,
    ] = await Promise.all([
      agentIds.length,
      this.prisma.dvi_itinerary_plan_details.count({
        where: {
          OR: [
            { staff_id: staffId },
            ...(agentIds.length ? [{ agent_id: { in: agentIds } }] : []),
          ],
          deleted: 0,
        },
      }),
      this.prisma.dvi_itinerary_plan_details.count({
        where: {
          OR: [
            { staff_id: staffId },
            ...(agentIds.length ? [{ agent_id: { in: agentIds } }] : []),
          ],
          quotation_status: 1,
          deleted: 0,
        },
      }),
    ]);

    return {
      totalAgents,
      totalItineraries,
      confirmedBookings,
    };
  }

  async getGuideDashboardStats(guideId: number) {
    const [
      totalAssignments,
      completedAssignments,
      pendingAssignments,
    ] = await Promise.all([
      this.prisma.dvi_confirmed_itinerary_route_guide_details.count({
        where: { guide_id: guideId, deleted: 0 },
      }),
      this.prisma.dvi_confirmed_itinerary_route_guide_details.count({
        where: { guide_id: guideId, guide_status: 1, deleted: 0 },
      }),
      this.prisma.dvi_confirmed_itinerary_route_guide_details.count({
        where: { guide_id: guideId, guide_status: 0, deleted: 0 },
      }),
    ]);

    return {
      totalAssignments,
      completedAssignments,
      pendingAssignments,
    };
  }

  async getAccountsDashboardStats() {
    const [summary, pendingPayouts] = await Promise.all([
      this.prisma.dvi_accounts_itinerary_details.aggregate({
        _sum: {
          total_payable_amount: true,
          total_received_amount: true,
          total_receivable_amount: true,
        },
        where: { deleted: 0 },
      }),
 // Count pending payouts across components (simplified for dashboard)
      this.prisma.dvi_accounts_itinerary_details.count({
        where: {
          total_receivable_amount: { gt: 0 },
          deleted: 0,
        },
      }),
    ]);

    return {
      totalPayable: summary._sum.total_payable_amount || 0,
      totalPaid: summary._sum.total_received_amount || 0,
      totalBalance: summary._sum.total_receivable_amount || 0,
      pendingPayouts,
    };
  }

    async getVendorDashboardStats(vendorId: number) {
    const [totalAssignments, completedAssignments, pendingAssignments] =
      await Promise.all([
        this.prisma.dvi_confirmed_itinerary_plan_vendor_eligible_list.count({
          where: { vendor_id: vendorId, deleted: 0 },
        }),
        this.prisma.dvi_confirmed_itinerary_plan_vendor_eligible_list.count({
          where: { vendor_id: vendorId, status: 1, deleted: 0 },
        }),
        this.prisma.dvi_confirmed_itinerary_plan_vendor_eligible_list.count({
          where: { vendor_id: vendorId, status: 0, deleted: 0 },
        }),
      ]);

    return {
      totalAssignments,
      completedAssignments,
      pendingAssignments,
    };
  }

  async getMostVisitedHotels(params: { year: number; limit: number }) {
    const year = Number(params.year) || new Date().getFullYear();
    const limit = Math.min(Math.max(Number(params.limit) || 5, 1), 20);

    const totalRows: any[] = await this.prisma.$queryRaw`
      SELECT COUNT(*) AS total
      FROM dvi_confirmed_itinerary_plan_hotel_details cih
      LEFT JOIN dvi_hotel h ON h.hotel_id = cih.hotel_id
      WHERE cih.deleted = 0
        AND cih.hotel_id IS NOT NULL
        AND cih.hotel_id > 0
        AND h.hotel_name IS NOT NULL
        AND TRIM(h.hotel_name) <> ''
        AND YEAR(cih.itinerary_route_date) = ${year}
    `;

    const totalVisits = Number(totalRows?.[0]?.total || 0);

    const rows: any[] = await this.prisma.$queryRaw`
      SELECT
        h.hotel_name AS hotel_name,
        COALESCE(
          NULLIF(TRIM(cih.itinerary_route_location), ''),
          NULLIF(TRIM(h.hotel_city), ''),
          '-'
        ) AS hotel_location,
        COUNT(*) AS visit_count
      FROM dvi_confirmed_itinerary_plan_hotel_details cih
      LEFT JOIN dvi_hotel h ON h.hotel_id = cih.hotel_id
      WHERE cih.deleted = 0
        AND cih.hotel_id IS NOT NULL
        AND cih.hotel_id > 0
        AND h.hotel_name IS NOT NULL
        AND TRIM(h.hotel_name) <> ''
        AND YEAR(cih.itinerary_route_date) = ${year}
      GROUP BY h.hotel_id, h.hotel_name, cih.itinerary_route_location, h.hotel_city
      ORDER BY visit_count DESC, h.hotel_name ASC
      LIMIT ${limit}
    `;

    return rows.map((row) => {
      const visitCount = Number(row.visit_count || 0);

      return {
        hotel_name: row.hotel_name || '-',
        hotel_location: row.hotel_location || '-',
        visit_count: visitCount,
        visit_percentage:
          totalVisits > 0 ? Math.round((visitCount / totalVisits) * 100) : 0,
      };
    });
  }
}
