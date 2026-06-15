import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';

type IncidentalInput = {
  itineraryPlanId: number;
  componentType: number;
  componentId: number;
  amount: number;
  reason: string;
  createdBy: number;
};

@Injectable()
export class IncidentalExpensesService {
  constructor(private prisma: PrismaService) {}

  private routeLabel(route: { location_name?: string | null; next_visiting_location?: string | null } | null | undefined): string {
    return String(route?.location_name || route?.next_visiting_location || '').trim();
  }

  private componentTypeLabel(componentType: number): string {
    switch (Number(componentType || 0)) {
      case 1:
        return 'Guide';
      case 2:
        return 'Hotspot';
      case 3:
        return 'Activity';
      case 4:
        return 'Hotel';
      case 5:
        return 'Vendor';
      default:
        return 'Unknown';
    }
  }

  private async resolveHistoryItemName(row: any): Promise<string> {
    const componentType = Number(row?.component_type || 0);

    if (componentType === 1) {
      const guideAssignment = await this.prisma.dvi_confirmed_itinerary_route_guide_details.findUnique({
        where: { confirmed_route_guide_ID: Number(row?.confirmed_route_guide_ID || 0) },
      });
      const [guide, route] = await Promise.all([
        guideAssignment?.guide_id
          ? this.prisma.dvi_guide_details.findUnique({
              where: { guide_id: Number(guideAssignment.guide_id) },
              select: { guide_name: true },
            })
          : Promise.resolve(null),
        guideAssignment?.itinerary_route_ID
          ? this.prisma.dvi_confirmed_itinerary_route_details.findFirst({
              where: {
                itinerary_plan_ID: Number(row?.itinerary_plan_id || 0),
                itinerary_route_ID: Number(guideAssignment.itinerary_route_ID),
              },
              select: { itinerary_route_date: true, location_name: true, next_visiting_location: true },
            })
          : Promise.resolve(null),
      ]);

      const routeDate = route?.itinerary_route_date
        ? new Date(route.itinerary_route_date).toLocaleDateString('en-IN', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
          })
        : '';
      return [guide?.guide_name || 'Guide', this.routeLabel(route), routeDate]
        .filter(Boolean)
        .join(' | ');
    }

    if (componentType === 2) {
      const hotspotAssignment = await this.prisma.dvi_confirmed_itinerary_route_hotspot_details.findUnique({
        where: { confirmed_route_hotspot_ID: Number(row?.confirmed_route_hotspot_ID || 0) },
      });
      const [hotspot, route] = await Promise.all([
        hotspotAssignment?.hotspot_ID
          ? this.prisma.dvi_hotspot_place.findUnique({
              where: { hotspot_ID: Number(hotspotAssignment.hotspot_ID) },
              select: { hotspot_name: true },
            })
          : Promise.resolve(null),
        hotspotAssignment?.itinerary_route_ID
          ? this.prisma.dvi_confirmed_itinerary_route_details.findFirst({
              where: {
                itinerary_plan_ID: Number(row?.itinerary_plan_id || 0),
                itinerary_route_ID: Number(hotspotAssignment.itinerary_route_ID),
              },
              select: { itinerary_route_date: true, location_name: true, next_visiting_location: true },
            })
          : Promise.resolve(null),
      ]);

      const routeDate = route?.itinerary_route_date
        ? new Date(route.itinerary_route_date).toLocaleDateString('en-IN', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
          })
        : '';
      return [hotspot?.hotspot_name || 'Hotspot', this.routeLabel(route), routeDate]
        .filter(Boolean)
        .join(' | ');
    }

    if (componentType === 3) {
      const activityAssignment = await this.prisma.dvi_confirmed_itinerary_route_activity_details.findUnique({
        where: { confirmed_route_activity_ID: Number(row?.confirmed_route_activity_ID || 0) },
      });
      const [activity, route] = await Promise.all([
        activityAssignment?.activity_ID
          ? this.prisma.dvi_activity.findUnique({
              where: { activity_id: Number(activityAssignment.activity_ID) },
              select: { activity_title: true },
            })
          : Promise.resolve(null),
        activityAssignment?.itinerary_route_ID
          ? this.prisma.dvi_confirmed_itinerary_route_details.findFirst({
              where: {
                itinerary_plan_ID: Number(row?.itinerary_plan_id || 0),
                itinerary_route_ID: Number(activityAssignment.itinerary_route_ID),
              },
              select: { itinerary_route_date: true, location_name: true, next_visiting_location: true },
            })
          : Promise.resolve(null),
      ]);

      const routeDate = route?.itinerary_route_date
        ? new Date(route.itinerary_route_date).toLocaleDateString('en-IN', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
          })
        : '';
      return [activity?.activity_title || 'Activity', this.routeLabel(route), routeDate]
        .filter(Boolean)
        .join(' | ');
    }

    if (componentType === 4) {
      const hotelAssignment = await this.prisma.dvi_confirmed_itinerary_plan_hotel_details.findUnique({
        where: { confirmed_itinerary_plan_hotel_details_ID: Number(row?.confirmed_itinerary_plan_hotel_details_ID || 0) },
        select: {
          hotel_id: true,
          itinerary_route_date: true,
          itinerary_route_location: true,
        },
      });
      const hotel = hotelAssignment?.hotel_id
        ? await this.prisma.dvi_hotel.findUnique({
            where: { hotel_id: Number(hotelAssignment.hotel_id) },
            select: { hotel_name: true },
          })
        : null;
      const routeDate = hotelAssignment?.itinerary_route_date
        ? new Date(hotelAssignment.itinerary_route_date).toLocaleDateString('en-IN', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
          })
        : '';
      return [hotel?.hotel_name || 'Hotel', hotelAssignment?.itinerary_route_location || '', routeDate]
        .filter(Boolean)
        .join(' | ');
    }

    if (componentType === 5) {
      const vendorAssignment = await this.prisma.dvi_confirmed_itinerary_plan_vendor_eligible_list.findUnique({
        where: { confirmed_itinerary_plan_vendor_eligible_ID: Number(row?.confirmed_itinerary_plan_vendor_eligible_ID || 0) },
        select: {
          vendor_id: true,
          vehicle_type_id: true,
          vehicle_orign: true,
        },
      });

      const [vendor, vehicleType] = await Promise.all([
        vendorAssignment?.vendor_id
          ? this.prisma.dvi_vendor_details.findUnique({
              where: { vendor_id: Number(vendorAssignment.vendor_id) },
              select: { vendor_name: true },
            })
          : Promise.resolve(null),
        vendorAssignment?.vehicle_type_id
          ? this.prisma.dvi_vehicle_type.findUnique({
              where: { vehicle_type_id: Number(vendorAssignment.vehicle_type_id) },
              select: { vehicle_type_title: true },
            })
          : Promise.resolve(null),
      ]);

      return [
        vendor?.vendor_name || 'Vendor',
        vehicleType?.vehicle_type_title || '',
        String(vendorAssignment?.vehicle_orign || '').trim(),
      ]
        .filter(Boolean)
        .join(' | ');
    }

    return 'Unknown Item';
  }

  async getAvailableComponents(itineraryPlanId: number) {
    const plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
      where: { itinerary_plan_ID: itineraryPlanId, deleted: 0 },
    });

    if (!plan) {
      throw new NotFoundException('Confirmed itinerary plan not found');
    }

    const itineraryPlan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: itineraryPlanId },
      select: { entry_ticket_required: true },
    });

    const itineraryPreference = Number(plan.itinerary_preference || 0);
    const entryTicketRequired = Number(itineraryPlan?.entry_ticket_required || 0);

    const guides = await this.prisma.dvi_confirmed_itinerary_route_guide_details.findMany({
      where: { itinerary_plan_ID: itineraryPlanId, deleted: 0, status: 1, guide_id: { not: 0 } },
    });
    const hotspots = await this.prisma.dvi_confirmed_itinerary_route_hotspot_details.findMany({
      where: { itinerary_plan_ID: itineraryPlanId, deleted: 0, status: 1, hotspot_ID: { not: 0 }, item_type: 4 },
    });
    const activities = await this.prisma.dvi_confirmed_itinerary_route_activity_details.findMany({
      where: { itinerary_plan_ID: itineraryPlanId, deleted: 0, status: 1, activity_ID: { not: 0 } },
    });
    const hotels = await this.prisma.dvi_confirmed_itinerary_plan_hotel_details.findMany({
      where: { itinerary_plan_id: itineraryPlanId, deleted: 0, status: 1, hotel_id: { not: 0 } },
    });
    const vendors = await this.prisma.dvi_confirmed_itinerary_plan_vendor_eligible_list.findMany({
      where: {
        itinerary_plan_id: itineraryPlanId,
        deleted: 0,
        status: 1,
        vendor_id: { not: 0 },
        itineary_plan_assigned_status: 1,
      },
    });

    const availableTypes = [];
    if (guides.length > 0) availableTypes.push({ id: 1, label: 'Guide' });
    if (hotspots.length > 0 && entryTicketRequired === 1) availableTypes.push({ id: 2, label: 'Hotspot' });
    if (activities.length > 0) availableTypes.push({ id: 3, label: 'Activity' });
    if (hotels.length > 0 && (itineraryPreference === 1 || itineraryPreference === 3)) {
      availableTypes.push({ id: 4, label: 'Hotel' });
    }
    if (vendors.length > 0 && (itineraryPreference === 2 || itineraryPreference === 3)) {
      availableTypes.push({ id: 5, label: 'Vendor' });
    }

    return {
      availableTypes,
      guides: await Promise.all(
        guides.map(async (g) => {
          const [guide, route] = await Promise.all([
            this.prisma.dvi_guide_details.findUnique({
              where: { guide_id: g.guide_id },
              select: { guide_name: true },
            }),
            this.prisma.dvi_confirmed_itinerary_route_details.findFirst({
              where: { itinerary_plan_ID: itineraryPlanId, itinerary_route_ID: g.itinerary_route_ID },
              select: { itinerary_route_date: true, location_name: true, next_visiting_location: true },
            }),
          ]);

          return {
            id: g.confirmed_route_guide_ID,
            name: `${guide?.guide_name || 'N/A'}${this.routeLabel(route) ? ` | ${this.routeLabel(route)}` : ''}${route?.itinerary_route_date ? ` | ${new Date(route.itinerary_route_date).toLocaleDateString('en-IN')}` : ''}`,
          };
        }),
      ),
      hotspots: await Promise.all(
        hotspots.map(async (h) => {
          const [hotspot, route] = await Promise.all([
            this.prisma.dvi_hotspot_place.findUnique({
              where: { hotspot_ID: h.hotspot_ID },
              select: { hotspot_name: true },
            }),
            this.prisma.dvi_confirmed_itinerary_route_details.findFirst({
              where: { itinerary_plan_ID: itineraryPlanId, itinerary_route_ID: h.itinerary_route_ID },
              select: { itinerary_route_date: true, location_name: true, next_visiting_location: true },
            }),
          ]);

          return {
            id: h.confirmed_route_hotspot_ID,
            name: `${hotspot?.hotspot_name || 'N/A'}${this.routeLabel(route) ? ` | ${this.routeLabel(route)}` : ''}${route?.itinerary_route_date ? ` | ${new Date(route.itinerary_route_date).toLocaleDateString('en-IN')}` : ''}`,
          };
        }),
      ),
      activities: await Promise.all(
        activities.map(async (a) => {
          const [activity, route] = await Promise.all([
            this.prisma.dvi_activity.findUnique({
              where: { activity_id: a.activity_ID },
              select: { activity_title: true },
            }),
            this.prisma.dvi_confirmed_itinerary_route_details.findFirst({
              where: { itinerary_plan_ID: itineraryPlanId, itinerary_route_ID: a.itinerary_route_ID },
              select: { itinerary_route_date: true, location_name: true, next_visiting_location: true },
            }),
          ]);

          return {
            id: a.confirmed_route_activity_ID,
            name: `${activity?.activity_title || 'N/A'}${this.routeLabel(route) ? ` | ${this.routeLabel(route)}` : ''}${route?.itinerary_route_date ? ` | ${new Date(route.itinerary_route_date).toLocaleDateString('en-IN')}` : ''}`,
          };
        }),
      ),
      hotels: await Promise.all(
        hotels.map(async (h) => {
          const hotel = await this.prisma.dvi_hotel.findUnique({
            where: { hotel_id: h.hotel_id },
            select: { hotel_name: true },
          });

          return {
            id: h.confirmed_itinerary_plan_hotel_details_ID,
            name: `${hotel?.hotel_name || 'N/A'}${h.itinerary_route_location ? ` | ${h.itinerary_route_location}` : ''}${h.itinerary_route_date ? ` | ${new Date(h.itinerary_route_date).toLocaleDateString('en-IN')}` : ''}`,
          };
        }),
      ),
      vendors: await Promise.all(
        vendors.map(async (v) => {
          const [vendor, vehicleType] = await Promise.all([
            this.prisma.dvi_vendor_details.findUnique({
              where: { vendor_id: v.vendor_id },
              select: { vendor_name: true },
            }),
            this.prisma.dvi_vehicle_type.findUnique({
              where: { vehicle_type_id: v.vehicle_type_id },
              select: { vehicle_type_title: true },
            }),
          ]);

          return {
            id: v.confirmed_itinerary_plan_vendor_eligible_ID,
            name: `${vendor?.vendor_name || 'N/A'}${vehicleType?.vehicle_type_title ? ` | ${vehicleType.vehicle_type_title}` : ''}${v.vehicle_orign ? ` | ${String(v.vehicle_orign).trim()}` : ''}`,
          };
        }),
      ),
    };
  }

  async getAvailableMargin(itineraryPlanId: number, componentType: number, componentId?: number) {
    const existingWhere: any = {
      itinerary_plan_id: itineraryPlanId,
      component_type: componentType,
      deleted: 0,
      status: 1,
    };

    if (componentType === 4 || componentType === 5) {
      if (!componentId) {
        return { total_avail_cost: 0, total_amount: 0, total_payed: 0, total_balance: 0 };
      }

      if (componentType === 4) {
        const hotelDetail = await this.prisma.dvi_confirmed_itinerary_plan_hotel_details.findUnique({
          where: { confirmed_itinerary_plan_hotel_details_ID: componentId },
          select: { hotel_id: true },
        });
        existingWhere.component_id = Number(hotelDetail?.hotel_id || 0);
      } else {
        const vendorDetail = await this.prisma.dvi_confirmed_itinerary_plan_vendor_eligible_list.findUnique({
          where: { confirmed_itinerary_plan_vendor_eligible_ID: componentId },
          select: { vendor_id: true },
        });
        existingWhere.component_id = Number(vendorDetail?.vendor_id || 0);
      }
    }

    const existing = await this.prisma.dvi_confirmed_itinerary_incidental_expenses.findFirst({
      where: existingWhere,
    });

    if (existing) {
      return {
        total_avail_cost: Math.round(Number(existing.total_balance || 0)),
        total_amount: Number(existing.total_amount || 0),
        total_payed: Number(existing.total_payed || 0),
        total_balance: Number(existing.total_balance || 0),
      };
    }

    const plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
      where: { itinerary_plan_ID: itineraryPlanId, deleted: 0 },
    });

    if (!plan) throw new NotFoundException('Plan not found');

    const agentMarginCharges = Number(plan.itinerary_agent_margin_charges || 0);

    if (componentType === 1 || componentType === 2 || componentType === 3) {
      const [guideCount, hotspotCount, activityCount] = await Promise.all([
        this.prisma.dvi_confirmed_itinerary_route_guide_details.count({
          where: { itinerary_plan_ID: itineraryPlanId, deleted: 0, status: 1, guide_id: { not: 0 } },
        }),
        this.prisma.dvi_confirmed_itinerary_route_hotspot_details.count({
          where: { itinerary_plan_ID: itineraryPlanId, deleted: 0, status: 1, hotspot_ID: { not: 0 }, item_type: 4 },
        }),
        this.prisma.dvi_confirmed_itinerary_route_activity_details.count({
          where: { itinerary_plan_ID: itineraryPlanId, deleted: 0, status: 1, activity_ID: { not: 0 } },
        }),
      ]);

      let divisor = 0;
      if (guideCount > 0) divisor++;
      if (hotspotCount > 0) divisor++;
      if (activityCount > 0) divisor++;

      const share = divisor > 0 ? Math.round(agentMarginCharges / divisor) : 0;
      return {
        total_avail_cost: share,
        total_amount: share,
        total_payed: 0,
        total_balance: share,
      };
    }

    if (componentType === 4) {
      if (!componentId) {
        return { total_avail_cost: 0, total_amount: 0, total_payed: 0, total_balance: 0 };
      }
      const hotelDetail = await this.prisma.dvi_confirmed_itinerary_plan_hotel_details.findUnique({
        where: { confirmed_itinerary_plan_hotel_details_ID: componentId },
      });
      const value = Number(hotelDetail?.hotel_margin_rate || 0);
      return { total_avail_cost: Math.round(value), total_amount: value, total_payed: 0, total_balance: value };
    }

    if (componentType === 5) {
      if (!componentId) {
        return { total_avail_cost: 0, total_amount: 0, total_payed: 0, total_balance: 0 };
      }
      const vendorDetail = await this.prisma.dvi_confirmed_itinerary_plan_vendor_eligible_list.findUnique({
        where: { confirmed_itinerary_plan_vendor_eligible_ID: componentId },
      });
      const value = Number(vendorDetail?.vendor_margin_amount || 0);
      return { total_avail_cost: Math.round(value), total_amount: value, total_payed: 0, total_balance: value };
    }

    return { total_avail_cost: 0, total_amount: 0, total_payed: 0, total_balance: 0 };
  }

  async addIncidentalExpense(data: IncidentalInput) {
    const { itineraryPlanId, componentType, componentId, amount, reason, createdBy } = data;
    const normalizedAmount = Number(amount || 0);

    if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
      throw new BadRequestException('Amount must be greater than zero');
    }

    let mainComponentId = 0;
    let itineraryRouteId = 0;
    let confirmedRouteGuideId = 0;
    let confirmedRouteHotspotId = 0;
    let confirmedRouteActivityId = 0;
    let confirmedHotelDetailsId = 0;
    let confirmedVendorEligibleId = 0;

    if (componentType === 1) {
      const g = await this.prisma.dvi_confirmed_itinerary_route_guide_details.findUnique({
        where: { confirmed_route_guide_ID: componentId },
      });
      mainComponentId = Number(g?.guide_id || 0);
      itineraryRouteId = Number(g?.itinerary_route_ID || 0);
      confirmedRouteGuideId = componentId;
    } else if (componentType === 2) {
      const h = await this.prisma.dvi_confirmed_itinerary_route_hotspot_details.findUnique({
        where: { confirmed_route_hotspot_ID: componentId },
      });
      mainComponentId = Number(h?.hotspot_ID || 0);
      itineraryRouteId = Number(h?.itinerary_route_ID || 0);
      confirmedRouteHotspotId = componentId;
    } else if (componentType === 3) {
      const a = await this.prisma.dvi_confirmed_itinerary_route_activity_details.findUnique({
        where: { confirmed_route_activity_ID: componentId },
      });
      mainComponentId = Number(a?.activity_ID || 0);
      itineraryRouteId = Number(a?.itinerary_route_ID || 0);
      confirmedRouteActivityId = componentId;
    } else if (componentType === 4) {
      const h = await this.prisma.dvi_confirmed_itinerary_plan_hotel_details.findUnique({
        where: { confirmed_itinerary_plan_hotel_details_ID: componentId },
      });
      mainComponentId = Number(h?.hotel_id || 0);
      itineraryRouteId = Number(h?.itinerary_route_id || 0);
      confirmedHotelDetailsId = componentId;
    } else if (componentType === 5) {
      const v = await this.prisma.dvi_confirmed_itinerary_plan_vendor_eligible_list.findUnique({
        where: { confirmed_itinerary_plan_vendor_eligible_ID: componentId },
      });
      mainComponentId = Number(v?.vendor_id || 0);
      confirmedVendorEligibleId = componentId;
    }

    if (mainComponentId <= 0) {
      throw new BadRequestException('Unable to resolve selected incidental component');
    }

    const marginInfo = await this.getAvailableMargin(itineraryPlanId, componentType, componentId);
    if (normalizedAmount > Number(marginInfo.total_balance || 0)) {
      throw new BadRequestException(
        `Incidental amount cannot exceed available balance of ${Number(marginInfo.total_balance || 0).toFixed(2)}`,
      );
    }

    let mainRecord = await this.prisma.dvi_confirmed_itinerary_incidental_expenses.findFirst({
      where: {
        itinerary_plan_id: itineraryPlanId,
        component_type: componentType,
        component_id: mainComponentId,
        deleted: 0,
      },
    });

    if (!mainRecord) {
      const totalBalance = Number(marginInfo.total_amount || 0) - normalizedAmount;
      mainRecord = await this.prisma.dvi_confirmed_itinerary_incidental_expenses.create({
        data: {
          itinerary_plan_id: itineraryPlanId,
          component_type: componentType,
          component_id: mainComponentId,
          total_amount: Number(marginInfo.total_amount || 0),
          total_payed: normalizedAmount,
          total_balance: totalBalance,
          status: 1,
          deleted: 0,
          createdby: createdBy,
          createdon: new Date(),
          updatedon: new Date(),
        },
      });
    } else {
      const newTotalPayed = Number(mainRecord.total_payed || 0) + normalizedAmount;
      const newTotalBalance = Number(mainRecord.total_balance || 0) - normalizedAmount;
      mainRecord = await this.prisma.dvi_confirmed_itinerary_incidental_expenses.update({
        where: {
          confirmed_itinerary_incidental_expenses_main_ID:
            mainRecord.confirmed_itinerary_incidental_expenses_main_ID,
        },
        data: {
          total_payed: newTotalPayed,
          total_balance: newTotalBalance,
          updatedon: new Date(),
        },
      });
    }

    await this.prisma.dvi_confirmed_itinerary_incidental_expenses_history.create({
      data: {
        confirmed_itinerary_incidental_expenses_main_ID:
          mainRecord.confirmed_itinerary_incidental_expenses_main_ID,
        itinerary_plan_id: itineraryPlanId,
        itinerary_route_id: itineraryRouteId,
        confirmed_route_guide_ID: confirmedRouteGuideId,
        confirmed_route_hotspot_ID: confirmedRouteHotspotId,
        confirmed_route_activity_ID: confirmedRouteActivityId,
        confirmed_itinerary_plan_hotel_details_ID: confirmedHotelDetailsId,
        confirmed_itinerary_plan_vendor_eligible_ID: confirmedVendorEligibleId,
        component_type: componentType,
        component_id: mainComponentId,
        incidental_amount: normalizedAmount,
        reason: reason,
        status: 1,
        deleted: 0,
        createdby: createdBy,
        createdon: new Date(),
        updatedon: new Date(),
      },
    });

    return { success: true };
  }

  async getIncidentalHistory(itineraryPlanId: number) {
    const rows = await this.prisma.dvi_confirmed_itinerary_incidental_expenses_history.findMany({
      where: { itinerary_plan_id: itineraryPlanId, deleted: 0 },
      orderBy: { createdon: 'desc' },
    });

    return Promise.all(
      rows.map(async (row) => {
        const main = await this.prisma.dvi_confirmed_itinerary_incidental_expenses.findUnique({
          where: {
            confirmed_itinerary_incidental_expenses_main_ID:
              row.confirmed_itinerary_incidental_expenses_main_ID,
          },
        });

        return {
          ...row,
          component_type_label: this.componentTypeLabel(Number(row.component_type || 0)),
          item_name: await this.resolveHistoryItemName(row),
          total_amount: Number(main?.total_amount || 0),
          total_payed: Number(main?.total_payed || 0),
          total_balance: Number(main?.total_balance || 0),
        };
      }),
    );
  }

  async deleteIncidentalHistory(historyId: number) {
    const history = await this.prisma.dvi_confirmed_itinerary_incidental_expenses_history.findUnique({
      where: { confirmed_itinerary_incidental_expenses_history_ID: historyId },
    });

    if (!history) {
      throw new NotFoundException('Incidental history record not found');
    }

    const main = await this.prisma.dvi_confirmed_itinerary_incidental_expenses.findUnique({
      where: {
        confirmed_itinerary_incidental_expenses_main_ID:
          history.confirmed_itinerary_incidental_expenses_main_ID,
      },
    });

    if (main) {
      const nextTotalPayed = Math.max(0, Number(main.total_payed || 0) - Number(history.incidental_amount || 0));
      const nextBalance = Number(main.total_amount || 0) - nextTotalPayed;

      await this.prisma.dvi_confirmed_itinerary_incidental_expenses.update({
        where: {
          confirmed_itinerary_incidental_expenses_main_ID:
            main.confirmed_itinerary_incidental_expenses_main_ID,
        },
        data: {
          total_payed: nextTotalPayed,
          total_balance: nextBalance,
          updatedon: new Date(),
        },
      });
    }

    await this.prisma.dvi_confirmed_itinerary_incidental_expenses_history.delete({
      where: { confirmed_itinerary_incidental_expenses_history_ID: historyId },
    });

    return { success: true };
  }
}
