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
  const normalizedVendorId = Number(vendorId || 0);

  const emptyDashboard = {
    vendorName: 'Vendor',

    totalItineraries: 0,
    totalBranches: 0,
    totalDrivers: 0,
    totalVehicles: 0,

    totalTrips: 0,
    totalRevenue: 0,
    scheduledTrips: 0,
    completedTrips: 0,

    vehicles: {
      total: 0,
      onRoute: 0,
      upcoming: 0,
      available: 0,
    },

    drivers: {
      active: 0,
      inactive: 0,
      onRoute: 0,
      available: 0,
    },

    liveVehicleStatus: {
      onRoute: [],
      upcoming: [],
      idle: [],
      inService: [],
    },

    dailyMoment: [],
    branches: [],
    fcOverview: [],
  };

  if (normalizedVendorId <= 0) {
    return emptyDashboard;
  }

  const now = new Date();

  const [
    vendor,
    itineraryRows,
    branchRows,
    vehicleRows,
    driverRows,
    vehicleAssignmentRows,
    driverAssignmentRows,
    revenueSummary,
  ] = await Promise.all([
    this.prisma.dvi_vendor_details.findFirst({
      where: {
        vendor_id: normalizedVendorId,
        deleted: 0,
      },
      select: {
        vendor_name: true,
      },
    }),

    this.prisma.dvi_confirmed_itinerary_plan_vendor_eligible_list.findMany({
      where: {
        vendor_id: normalizedVendorId,
        itineary_plan_assigned_status: 1,
        status: 1,
        deleted: 0,
      },
      select: {
        itinerary_plan_id: true,
      },
    }),

    this.prisma.dvi_vendor_branches.findMany({
      where: {
        vendor_id: normalizedVendorId,
        deleted: 0,
      },
      select: {
        vendor_branch_id: true,
        vendor_branch_name: true,
        vendor_branch_location: true,
        vendor_branch_emailid: true,
        vendor_branch_primary_mobile_number: true,
        status: true,
      },
      orderBy: {
        vendor_branch_id: 'asc',
      },
    }),

    this.prisma.dvi_vehicle.findMany({
      where: {
        vendor_id: normalizedVendorId,
        deleted: 0,
      },
      select: {
        vehicle_id: true,
        vendor_branch_id: true,
        vehicle_type_id: true,
        registration_number: true,
        vehicle_fc_expiry_date: true,
        insurance_end_date: true,
        status: true,
      },
      orderBy: {
        vehicle_id: 'desc',
      },
    }),

    this.prisma.dvi_driver_details.findMany({
      where: {
        vendor_id: normalizedVendorId,
        deleted: 0,
      },
      select: {
        driver_id: true,
        driver_name: true,
        driver_primary_mobile_number: true,
        status: true,
      },
      orderBy: {
        driver_id: 'asc',
      },
    }),

    this.prisma.dvi_confirmed_itinerary_vendor_vehicle_assigned.findMany({
      where: {
        vendor_id: normalizedVendorId,
        assigned_vehicle_status: 1,
        status: 1,
        deleted: 0,
      },
      select: {
        vendor_vehicle_assigned_ID: true,
        itinerary_plan_id: true,
        vehicle_id: true,
        vendor_vehicle_type_id: true,
        trip_start_date_and_time: true,
        trip_end_date_and_time: true,
      },
      orderBy: {
        trip_start_date_and_time: 'asc',
      },
    }),

    this.prisma.dvi_confirmed_itinerary_vendor_driver_assigned.findMany({
      where: {
        vendor_id: normalizedVendorId,
        assigned_driver_status: 1,
        status: 1,
        deleted: 0,
      },
      select: {
        driver_assigned_ID: true,
        itinerary_plan_id: true,
        vehicle_id: true,
        driver_id: true,
        trip_start_date_and_time: true,
        trip_end_date_and_time: true,
        driver_assigned_on: true,
      },
      orderBy: {
        driver_assigned_on: 'desc',
      },
    }),

    this.prisma.dvi_accounts_itinerary_vehicle_details.aggregate({
      _sum: {
        total_paid: true,
      },
      where: {
        vendor_id: normalizedVendorId,
        deleted: 0,
      },
    }),
  ]);

  const assignedPlanIds = new Set<number>();

  for (const row of itineraryRows) {
    const planId = Number(
      row.itinerary_plan_id || 0,
    );

    if (planId > 0) {
      assignedPlanIds.add(planId);
    }
  }

  for (const row of vehicleAssignmentRows) {
    const planId = Number(
      row.itinerary_plan_id || 0,
    );

    if (planId > 0) {
      assignedPlanIds.add(planId);
    }
  }

  const planIds = Array.from(
    assignedPlanIds,
  );

  const vehicleTypeIds = Array.from(
    new Set(
      vehicleRows
        .map((row) =>
          Number(row.vehicle_type_id || 0),
        )
        .filter((id) => id > 0),
    ),
  );

  const [
    confirmedPlanRows,
    routeRows,
    vehicleTypeRows,
  ] = await Promise.all([
    planIds.length > 0
      ? this.prisma.dvi_confirmed_itinerary_plan_details.findMany({
          where: {
            itinerary_plan_ID: {
              in: planIds,
            },
            deleted: 0,
          },
        select: {
  itinerary_plan_ID: true,
  itinerary_quote_ID: true,
  arrival_location: true,
  departure_location: true,
},
        })
      : Promise.resolve([]),

    planIds.length > 0
      ? this.prisma.dvi_confirmed_itinerary_route_details.findMany({
          where: {
            itinerary_plan_ID: {
              in: planIds,
            },
            status: 1,
            deleted: 0,
          },
          select: {
            itinerary_plan_ID: true,
            itinerary_route_date: true,
            location_name: true,
            next_visiting_location: true,
          },
          orderBy: {
            itinerary_route_date: 'desc',
          },
        })
      : Promise.resolve([]),

    vehicleTypeIds.length > 0
      ? this.prisma.dvi_vehicle_type.findMany({
          where: {
            vehicle_type_id: {
              in: vehicleTypeIds,
            },
            deleted: 0,
          },
          select: {
            vehicle_type_id: true,
            vehicle_type_title: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const vendorName =
    String(vendor?.vendor_name || '').trim() ||
    'Vendor';

  const branchById = new Map(
    branchRows.map((branch) => [
      Number(branch.vendor_branch_id),
      branch,
    ]),
  );

  const vehicleById = new Map(
    vehicleRows.map((vehicle) => [
      Number(vehicle.vehicle_id),
      vehicle,
    ]),
  );

  const driverById = new Map(
    driverRows.map((driver) => [
      Number(driver.driver_id),
      driver,
    ]),
  );

  const vehicleTypeById = new Map(
    vehicleTypeRows.map((vehicleType) => [
      Number(vehicleType.vehicle_type_id),
      String(
        vehicleType.vehicle_type_title ||
          '',
      ),
    ]),
  );

  const quoteByPlanId = new Map<
  number,
  string
>();

const sourceByPlanId = new Map<
  number,
  string
>();

const destinationByPlanId = new Map<
  number,
  string
>();

for (const plan of confirmedPlanRows) {
  const planId = Number(
    plan.itinerary_plan_ID || 0,
  );

  if (planId <= 0) {
    continue;
  }

  if (!quoteByPlanId.has(planId)) {
    quoteByPlanId.set(
      planId,
      String(
        plan.itinerary_quote_ID || '-',
      ),
    );
  }

  sourceByPlanId.set(
    planId,
    String(
      plan.arrival_location || '-',
    ),
  );

  destinationByPlanId.set(
    planId,
    String(
      plan.departure_location || '-',
    ),
  );
}

  const toDate = (
    value: Date | string | null | undefined,
  ): Date | null => {
    if (!value) return null;

    const date =
      value instanceof Date
        ? value
        : new Date(value);

    return Number.isNaN(date.getTime())
      ? null
      : date;
  };

  const toIso = (
    value: Date | string | null | undefined,
  ): string | null => {
    const date = toDate(value);

    return date
      ? date.toISOString()
      : null;
  };

  const toYmd = (
    value: Date | string | null | undefined,
  ): string => {
    const date = toDate(value);

    if (!date) return '';

    const pad = (num: number) =>
      String(num).padStart(2, '0');

    return (
      `${date.getFullYear()}-` +
      `${pad(date.getMonth() + 1)}-` +
      `${pad(date.getDate())}`
    );
  };

  const isOnRoute = (row: {
    trip_start_date_and_time:
      | Date
      | null;
    trip_end_date_and_time:
      | Date
      | null;
  }) => {
    const start = toDate(
      row.trip_start_date_and_time,
    );

    const end = toDate(
      row.trip_end_date_and_time,
    );

    return Boolean(
      start &&
        end &&
        start <= now &&
        end >= now,
    );
  };

  const isUpcoming = (row: {
    trip_start_date_and_time:
      | Date
      | null;
  }) => {
    const start = toDate(
      row.trip_start_date_and_time,
    );

    return Boolean(
      start && start > now,
    );
  };

  const isCompleted = (row: {
    trip_end_date_and_time:
      | Date
      | null;
  }) => {
    const end = toDate(
      row.trip_end_date_and_time,
    );

    return Boolean(
      end && end < now,
    );
  };

  const uniquePlanCount = (
    rows: Array<{
      itinerary_plan_id: number;
    }>,
  ) =>
    new Set(
      rows
        .map((row) =>
          Number(
            row.itinerary_plan_id || 0,
          ),
        )
        .filter((id) => id > 0),
    ).size;

  const onRouteAssignments =
    vehicleAssignmentRows.filter(
      isOnRoute,
    );

  const upcomingAssignments =
    vehicleAssignmentRows.filter(
      isUpcoming,
    );

  const completedAssignments =
    vehicleAssignmentRows.filter(
      isCompleted,
    );

  const onRouteVehicleIds = new Set(
    onRouteAssignments
      .map((row) =>
        Number(row.vehicle_id || 0),
      )
      .filter((id) => id > 0),
  );

  const upcomingVehicleIds = new Set(
    upcomingAssignments
      .map((row) =>
        Number(row.vehicle_id || 0),
      )
      .filter((id) => id > 0),
  );

  const activeVehicles =
    vehicleRows.filter(
      (vehicle) =>
        Number(vehicle.status || 0) ===
        1,
    );

  const availableVehicles =
    activeVehicles.filter(
      (vehicle) =>
        !onRouteVehicleIds.has(
          Number(
            vehicle.vehicle_id || 0,
          ),
        ),
    );

  const onRouteDriverAssignments =
    driverAssignmentRows.filter(
      isOnRoute,
    );

  const onRouteDriverIds = new Set(
    onRouteDriverAssignments
      .map((row) =>
        Number(row.driver_id || 0),
      )
      .filter((id) => id > 0),
  );

  const activeDrivers =
    driverRows.filter(
      (driver) =>
        Number(driver.status || 0) ===
        1,
    );

  const inactiveDrivers =
    driverRows.filter(
      (driver) =>
        Number(driver.status || 0) ===
        0,
    );

  const availableDrivers =
    activeDrivers.filter(
      (driver) =>
        !onRouteDriverIds.has(
          Number(
            driver.driver_id || 0,
          ),
        ),
    );

  const driverAssignmentByTripVehicle =
    new Map<string, typeof driverAssignmentRows[number]>();

  for (const assignment of driverAssignmentRows) {
    const key =
      `${Number(assignment.itinerary_plan_id || 0)}:` +
      `${Number(assignment.vehicle_id || 0)}`;

    if (
      !driverAssignmentByTripVehicle.has(
        key,
      )
    ) {
      driverAssignmentByTripVehicle.set(
        key,
        assignment,
      );
    }
  }

  const makeLiveRow = (
    assignment: typeof vehicleAssignmentRows[number],
  ) => {
    const planId = Number(
      assignment.itinerary_plan_id || 0,
    );

    const vehicleId = Number(
      assignment.vehicle_id || 0,
    );

    const vehicle =
      vehicleById.get(vehicleId);

    const branch =
      vehicle
        ? branchById.get(
            Number(
              vehicle.vendor_branch_id ||
                0,
            ),
          )
        : undefined;

    const driverAssignment =
      driverAssignmentByTripVehicle.get(
        `${planId}:${vehicleId}`,
      );

    const driver =
      driverAssignment
        ? driverById.get(
            Number(
              driverAssignment.driver_id ||
                0,
            ),
          )
        : undefined;

    const vehicleType =
      vehicle
        ? vehicleTypeById.get(
            Number(
              vehicle.vehicle_type_id ||
                0,
            ),
          )
        : '';

   return {
  bookingId:
    quoteByPlanId.get(planId) ||
    '-',

  startDate: toIso(
    assignment
      .trip_start_date_and_time,
  ),

  endDate: toIso(
    assignment
      .trip_end_date_and_time,
  ),

  vendorName,

  branchName:
    String(
      branch
        ?.vendor_branch_name ||
        '-',
    ),

  vehicleName:
    String(
      vehicle
        ?.registration_number ||
        vehicleType ||
        '-',
    ),

  driverName:
    String(
      driver?.driver_name || '-',
    ),

  driverNo:
    String(
      driver
        ?.driver_primary_mobile_number ||
        '-',
    ),

  source:
    sourceByPlanId.get(planId) ||
    '-',

  destination:
    destinationByPlanId.get(planId) ||
    '-',
};
  };

  const idleVehicles =
    activeVehicles.filter(
      (vehicle) => {
        const vehicleId = Number(
          vehicle.vehicle_id || 0,
        );

        return (
          !onRouteVehicleIds.has(
            vehicleId,
          ) &&
          !upcomingVehicleIds.has(
            vehicleId,
          )
        );
      },
    );

  const makeIdleRow = (
    vehicle: typeof vehicleRows[number],
  ) => {
    const branch =
      branchById.get(
        Number(
          vehicle.vendor_branch_id || 0,
        ),
      );

    const vehicleType =
      vehicleTypeById.get(
        Number(
          vehicle.vehicle_type_id || 0,
        ),
      );

    return {
  bookingId: '-',
  startDate: null,
  endDate: null,
  vendorName,

  branchName:
    String(
      branch
        ?.vendor_branch_name ||
        '-',
    ),

  vehicleName:
    String(
      vehicle.registration_number ||
        vehicleType ||
        '-',
    ),

  driverName: '-',
  driverNo: '-',

  source: '-',
  destination: '-',
};
  };

  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );

  const expiryStatus = (
    value:
      | Date
      | string
      | null
      | undefined,
  ) => {
    const expiry = toDate(value);

    if (!expiry) {
      return 'Not Available';
    }

    expiry.setHours(0, 0, 0, 0);

    return expiry >= today
      ? 'Valid'
      : 'Expired';
  };

  return {
    vendorName,

    totalItineraries:
      assignedPlanIds.size,

    totalBranches:
      branchRows.length,

    totalDrivers:
      driverRows.length,

    totalVehicles:
      vehicleRows.length,

    totalTrips:
      uniquePlanCount(
        vehicleAssignmentRows,
      ),

    totalRevenue:
      Number(
        revenueSummary._sum
          .total_paid || 0,
      ),

    scheduledTrips:
      uniquePlanCount(
        upcomingAssignments,
      ),

    completedTrips:
      uniquePlanCount(
        completedAssignments,
      ),

    vehicles: {
      total:
        vehicleRows.length,

      onRoute:
        onRouteVehicleIds.size,

      upcoming:
        upcomingVehicleIds.size,

      available:
        availableVehicles.length,
    },

    drivers: {
      active:
        activeDrivers.length,

      inactive:
        inactiveDrivers.length,

      onRoute:
        onRouteDriverIds.size,

      available:
        availableDrivers.length,
    },

    liveVehicleStatus: {
      onRoute:
        onRouteAssignments.map(
          makeLiveRow,
        ),

      upcoming:
        upcomingAssignments.map(
          makeLiveRow,
        ),

      idle:
        idleVehicles.map(
          makeIdleRow,
        ),

      inService: [],
    },

    dailyMoment:
      routeRows.map((row) => ({
        date:
          toYmd(
            row.itinerary_route_date,
          ),

        quoteId:
          quoteByPlanId.get(
            Number(
              row.itinerary_plan_ID ||
                0,
            ),
          ) || '-',

        location:
          String(
            row.location_name ||
              '-',
          ),

        nextLocation:
          String(
            row
              .next_visiting_location ||
              '-',
          ),
      })),

    branches:
      branchRows.map((branch) => ({
        id:
          Number(
            branch.vendor_branch_id ||
              0,
          ),

        name:
          String(
            branch
              .vendor_branch_name ||
              '-',
          ),

        location:
          String(
            branch
              .vendor_branch_location ||
              '-',
          ),

        email:
          String(
            branch
              .vendor_branch_emailid ||
              '-',
          ),

        mobile:
          String(
            branch
              .vendor_branch_primary_mobile_number ||
              '-',
          ),

        status:
          Number(
            branch.status || 0,
          ),
      })),

    fcOverview:
      vehicleRows.map((vehicle) => {
        const vehicleType =
          vehicleTypeById.get(
            Number(
              vehicle.vehicle_type_id ||
                0,
            ),
          );

        return {
          vehicleId:
            Number(
              vehicle.vehicle_id || 0,
            ),

          vehicleNumber:
            String(
              vehicle
                .registration_number ||
                '-',
            ),

          vehicleType:
            String(
              vehicleType || '-',
            ),

          fcDate:
            toIso(
              vehicle
                .vehicle_fc_expiry_date,
            ),

          fcStatus:
            expiryStatus(
              vehicle
                .vehicle_fc_expiry_date,
            ),

          insuranceDate:
            toIso(
              vehicle
                .insurance_end_date,
            ),

          insuranceStatus:
            expiryStatus(
              vehicle
                .insurance_end_date,
            ),
        };
      }),
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
