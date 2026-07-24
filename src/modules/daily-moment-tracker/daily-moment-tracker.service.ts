// FILE: src/modules/daily-moment-tracker/daily-moment-tracker.service.ts

import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import {
  DailyMomentRowDto,
  DailyMomentChargeRowDto,
  DriverRatingRowDto,
  GuideRatingRowDto,
  ListDailyMomentQueryDto,
  UpsertDailyMomentChargeDto,
  DailyMomentHotspotRowDto,
  DayViewPlanDto,
  DayViewDayDto,
  DayViewGuideDto,
  UpdateHotspotStatusDto,
  UpdateGuideStatusDto,
  UpdateWholedayGuideStatusDto,
  UpsertDriverRatingDto,
  UpsertGuideRatingDto,
  SaveOpeningKmDto,
  SaveClosingKmDto,
} from './dto/daily-moment-tracker.dto';

@Injectable()
export class DailyMomentTrackerService {
  private readonly logger = new Logger(DailyMomentTrackerService.name);
  private readonly legacyPhpDbName =
    process.env.LEGACY_PHP_DB_NAME?.trim() || 'dvi_travels';

   constructor(private readonly prisma: PrismaService) {}

 // ========= PUBLIC API METHODS =========

  async getDriverAssignmentShareDetails(driverAssignmentId: number) {
    if (!driverAssignmentId) {
      throw new BadRequestException('driverAssignmentId is required');
    }

    const assignment =
      await this.prisma.dvi_confirmed_itinerary_vendor_driver_assigned.findFirst({
        where: {
          driver_assigned_ID: driverAssignmentId,
          status: 1,
          deleted: 0,
        },
        select: {
          driver_assigned_ID: true,
          itinerary_plan_id: true,
          driver_id: true,
          vehicle_id: true,
          vendor_id: true,
        },
      });

    if (!assignment) {
      throw new BadRequestException('Driver assignment not found');
    }

    return {
      driverAssignmentId: assignment.driver_assigned_ID,
      itineraryPlanId: assignment.itinerary_plan_id,
      driverId: assignment.driver_id,
      vehicleId: assignment.vehicle_id,
      vendorId: assignment.vendor_id,
    };
  }

  async listDailyMoments(
    query: ListDailyMomentQueryDto,
  ): Promise<DailyMomentRowDto[]> {
    const from = this.parseDate(query.fromDate);
    const to = this.parseDate(query.toDate);

    if (from > to) {
      throw new BadRequestException('fromDate cannot be after toDate');
    }

 // 1) Base rows: confirmed plan + confirmed route (status=1, deleted=0, date range)
    const routes =
      await this.prisma.dvi_confirmed_itinerary_route_details.findMany({
        where: {
          deleted: 0,
          status: 1,
          itinerary_route_date: {
            gte: from,
            lte: to,
          },
        },
        orderBy: {
          itinerary_route_date: 'asc',
        },
      });

    if (!routes.length) {
      return [];
    }

    const planIds = Array.from(
      new Set(routes.map((r) => r.itinerary_plan_ID)),
    );
    const plans =
      await this.prisma.dvi_confirmed_itinerary_plan_details.findMany({
        where: {
          itinerary_plan_ID: { in: planIds },
          deleted: 0,
          status: 1,
          ...(query.itineraryPlanId
            ? { itinerary_plan_ID: query.itineraryPlanId }
            : {}),
          ...(query.agentId ? { agent_id: query.agentId } : {}),
        },
      });

    if (!plans.length) {
      return [];
    }

    const planByPlanId = new Map<number, (typeof plans)[number]>();
    plans.forEach((p) => planByPlanId.set(p.itinerary_plan_ID, p));

 // Filter routes to ones whose plan passes agent/plan filters
    const filteredRoutes = routes.filter((r) =>
      planByPlanId.has(r.itinerary_plan_ID),
    );
    if (!filteredRoutes.length) {
      return [];
    }

 // 2) Prefetch related tables in batches to avoid N+1

    const effectivePlanIds = Array.from(planByPlanId.keys());
    const routeIds = Array.from(
      new Set(filteredRoutes.map((r) => r.itinerary_route_ID)),
    );

 // 2.1 Primary customer per plan
    const customers =
      await this.prisma.dvi_confirmed_itinerary_customer_details.findMany({
        where: {
          itinerary_plan_ID: { in: effectivePlanIds },
          primary_customer: 1,
          deleted: 0,
          status: 1,
        },
      });
    const primaryCustomerByPlan = new Map<
      number,
      (typeof customers)[number]
    >();
    customers.forEach((c) =>
      primaryCustomerByPlan.set(c.itinerary_plan_ID, c),
    );

 // 2.2 Hotel + meal flags per plan+route from confirmed hotel room details
    const hotelRoomDetails =
      await this.prisma.dvi_confirmed_itinerary_plan_hotel_room_details.findMany(
        {
          where: {
            itinerary_plan_id: { in: effectivePlanIds },
            itinerary_route_id: { in: routeIds },
            deleted: 0,
            status: 1,
          },
        },
      );

 type HotelKey = string; // `${planId}:${routeId}`
    const hotelRoomByPlanRoute = new Map<
      HotelKey,
      (typeof hotelRoomDetails)[number][]
    >();
    const hotelIds = new Set<number>();
    hotelRoomDetails.forEach((hr) => {
      const key = this.mkPlanRouteKey(
        hr.itinerary_plan_id,
        hr.itinerary_route_id,
      );
      const arr = hotelRoomByPlanRoute.get(key) ?? [];
      arr.push(hr);
      hotelRoomByPlanRoute.set(key, arr);
      if (hr.hotel_id) {
        hotelIds.add(hr.hotel_id);
      }
    });

    const hotels = hotelIds.size
      ? await this.prisma.dvi_hotel.findMany({
          where: {
            hotel_id: { in: Array.from(hotelIds) },
            deleted: false,
            status: 1,
          },
          select: {
            hotel_id: true,
            hotel_name: true,
 // IMPORTANT: we do NOT select `updatedon` (or any other datetime)
          },
        })
      : [];
    const hotelById = new Map<number, (typeof hotels)[number]>();
    hotels.forEach((h) => hotelById.set(h.hotel_id, h));

 // 2.3 Vendor + vehicle per plan+route
    const planVendorVehicle =
      await this.prisma.dvi_confirmed_itinerary_plan_vendor_vehicle_details.findMany(
        {
          where: {
            itinerary_plan_id: { in: effectivePlanIds },
            itinerary_route_id: { in: routeIds },
            deleted: 0,
            status: 1,
          },
          select: {
            itinerary_plan_id: true,
            itinerary_route_id: true,
            vehicle_type_id: true,
            vendor_id: true,
            vehicle_id: true,
            vendor_branch_id: true,
 // NOTE: we intentionally do NOT select total_*_time or *_duration
          },
        },
      );

    const vendorIds = new Set<number>();
    const vehicleTypeIds = new Set<number>();
    const vehicleIds = new Set<number>();

 type VendorVehKey = string; // `${planId}:${routeId}`
    const vendorVehByPlanRoute = new Map<
      VendorVehKey,
      (typeof planVendorVehicle)[number]
    >();

    planVendorVehicle.forEach((pv) => {
      const key = this.mkPlanRouteKey(
        pv.itinerary_plan_id,
        pv.itinerary_route_id,
      );
 // If multiple rows exist, we keep the first one (similar to PHP helpers)
      if (!vendorVehByPlanRoute.has(key)) {
        vendorVehByPlanRoute.set(key, pv);
      }
      if (pv.vendor_id) vendorIds.add(pv.vendor_id);
      if (pv.vehicle_type_id) vehicleTypeIds.add(pv.vehicle_type_id);
      if (pv.vehicle_id) vehicleIds.add(pv.vehicle_id);
    });

    const vendors = vendorIds.size
      ? await this.prisma.dvi_vendor_details.findMany({
          where: {
            vendor_id: { in: Array.from(vendorIds) },
            deleted: 0,
            status: 1,
          },
        })
      : [];
    const vendorById = new Map<number, (typeof vendors)[number]>();
    vendors.forEach((v) => vendorById.set(v.vendor_id, v));

    const vehicleTypes = vehicleTypeIds.size
      ? await this.prisma.dvi_vehicle_type.findMany({
          where: {
            vehicle_type_id: { in: Array.from(vehicleTypeIds) },
            deleted: 0,
            status: 1,
          },
        })
      : [];
    const vehicleTypeById = new Map<number, (typeof vehicleTypes)[number]>();
    vehicleTypes.forEach((vt) =>
      vehicleTypeById.set(vt.vehicle_type_id, vt),
    );

    const vehicles = vehicleIds.size
      ? await this.prisma.dvi_vehicle.findMany({
          where: {
            vehicle_id: { in: Array.from(vehicleIds) },
            deleted: 0,
            status: 1,
          },
        })
      : [];
    const vehicleById = new Map<number, (typeof vehicles)[number]>();
    vehicles.forEach((ve) => vehicleById.set(ve.vehicle_id, ve));

 // 2.4 Driver assignment per plan
    const driverAssignments =
      await this.prisma.dvi_confirmed_itinerary_vendor_driver_assigned.findMany(
        {
          where: {
            itinerary_plan_id: { in: effectivePlanIds },
            deleted: 0,
            status: 1,
          },
          orderBy: {
            driver_assigned_on: 'desc',
          },
        },
      );

    const driverIds = new Set<number>();
    const driverAssignmentByPlan = new Map<
      number,
      (typeof driverAssignments)[number]
    >();

    driverAssignments.forEach((da) => {
      if (!driverAssignmentByPlan.has(da.itinerary_plan_id)) {
        driverAssignmentByPlan.set(da.itinerary_plan_id, da);
      }
      if (da.driver_id) driverIds.add(da.driver_id);
    });

    const drivers = driverIds.size
      ? await this.prisma.dvi_driver_details.findMany({
          where: {
            driver_id: { in: Array.from(driverIds) },
            deleted: 0,
            status: 1,
          },
        })
      : [];
    const driverById = new Map<number, (typeof drivers)[number]>();
    drivers.forEach((d) => driverById.set(d.driver_id, d));

 // 2.5 Activities (for special_remarks)
    const routeActivities =
      await this.prisma.dvi_confirmed_itinerary_route_activity_details.findMany(
        {
          where: {
            itinerary_plan_ID: { in: effectivePlanIds },
            itinerary_route_ID: { in: routeIds },
            deleted: 0,
            status: 1,
          },
          orderBy: {
            activity_order: 'asc',
          },
        },
      );

    const activityIds = new Set<number>();
 type ActivityKey = string; // `${planId}:${routeId}`
    const activityByPlanRoute = new Map<
      ActivityKey,
      (typeof routeActivities)[number]
    >();

    routeActivities.forEach((ra) => {
      const key = this.mkPlanRouteKey(
        ra.itinerary_plan_ID,
        ra.itinerary_route_ID,
      );
      if (!activityByPlanRoute.has(key)) {
 activityByPlanRoute.set(key, ra); // first ordered activity only, like PHP helper
      }
      if (ra.activity_ID) activityIds.add(ra.activity_ID);
    });

    const activities = activityIds.size
      ? await this.prisma.dvi_activity.findMany({
          where: {
            activity_id: { in: Array.from(activityIds) },
            deleted: 0,
            status: 1,
          },
        })
      : [];
    const activityById = new Map<number, (typeof activities)[number]>();
    activities.forEach((a) => activityById.set(a.activity_id, a));

 // 2.6 Agent + Travel Expert (for TRAVEL EXPERT column)

    const agentIds = new Set<number>();
    plans.forEach((p) => {
      if (p.agent_id) agentIds.add(p.agent_id);
    });

    const agents = agentIds.size
      ? await this.prisma.dvi_agent.findMany({
          where: {
            agent_ID: { in: Array.from(agentIds) },
            deleted: 0,
            status: 1,
          },
          select: {
            agent_ID: true,
            agent_name: true,
            travel_expert_id: true,
          },
        })
      : [];
    const agentById = new Map<number, (typeof agents)[number]>();
    agents.forEach((a) => agentById.set(a.agent_ID, a));

    const travelExpertIds = new Set<number>();
    agents.forEach((a) => {
      if (a.travel_expert_id) {
        travelExpertIds.add(a.travel_expert_id);
      }
    });

    const travelExperts = travelExpertIds.size
      ? await this.prisma.dvi_staff_details.findMany({
          where: {
            staff_id: { in: Array.from(travelExpertIds) },
            deleted: 0,
            status: 1,
          },
          select: {
            staff_id: true,
            staff_name: true,
            staff_mobile: true,
            staff_email: true,
          },
        })
      : [];
    const travelExpertById = new Map<
      number,
      (typeof travelExperts)[number]
    >();
    travelExperts.forEach((te) =>
      travelExpertById.set(te.staff_id, te),
    );

 // 3) Build final rows like PHP
    let counter = 0;
    const rows: DailyMomentRowDto[] = [];

    for (const route of filteredRoutes) {
      const plan = planByPlanId.get(route.itinerary_plan_ID);
      if (!plan) continue;

      counter++;

      const itinerary_plan_ID = route.itinerary_plan_ID;
      const itinerary_route_ID = route.itinerary_route_ID;
      const itinerary_route_date = route.itinerary_route_date;
      const location_name = route.location_name ?? '';
      const next_visiting_location = route.next_visiting_location ?? '';

 // Guest + flights
      const customer = primaryCustomerByPlan.get(itinerary_plan_ID);
      const guest_name = customer?.customer_name ?? '';

      const guest_mobile =
        (customer?.primary_contact_no ?? '') ||
        (customer?.altenative_contact_no ?? '');
      const guest_email = customer?.email_id ?? '';

      const arrival_flight_details = customer?.arrival_flight_details ?? '';
      const departure_flight_details =
        customer?.departure_flight_details ?? '';

 // Activity label + special instructions
      const actKey = this.mkPlanRouteKey(
        itinerary_plan_ID,
        itinerary_route_ID,
      );
      const ra = activityByPlanRoute.get(actKey);
      let specialRemarksFromActivity = '';

      if (ra && ra.activity_ID && activityById.has(ra.activity_ID)) {
        const act = activityById.get(ra.activity_ID)!;
        specialRemarksFromActivity = (act.activity_title ?? '').trim();
      }

      const special_instructions = (plan.special_instructions ?? '').trim();

      const isRemarksReal =
        specialRemarksFromActivity !== '' &&
        specialRemarksFromActivity !== '--';
      const isInstructionsReal =
        special_instructions !== '' && special_instructions !== '--';

      let special_remarks_final = '';
      if (isRemarksReal && isInstructionsReal) {
        special_remarks_final = `${specialRemarksFromActivity} / ${special_instructions}`;
      } else if (isRemarksReal) {
        special_remarks_final = specialRemarksFromActivity;
      } else if (isInstructionsReal) {
        special_remarks_final = special_instructions;
      }

 // Hotel name + meal plan
      const hotelKey = this.mkPlanRouteKey(
        itinerary_plan_ID,
        itinerary_route_ID,
      );
      const hotelRooms = hotelRoomByPlanRoute.get(hotelKey) ?? [];
      let hotel_name = '';
      let meal_breakfast_plan = '-';
      let meal_lunch_plan = '-';
      let meal_dinner_plan = '-';

      if (hotelRooms.length) {
        const hr0 = hotelRooms[0];
        if (hr0.hotel_id && hotelById.has(hr0.hotel_id)) {
          hotel_name = hotelById.get(hr0.hotel_id)!.hotel_name ?? '';
        }
 // If any room for that route has meal flags, switch from '-' to B/L/D
        if (hotelRooms.some((h) => h.breakfast_required === 1))
          meal_breakfast_plan = 'B';
        if (hotelRooms.some((h) => h.lunch_required === 1))
          meal_lunch_plan = 'L';
        if (hotelRooms.some((h) => h.dinner_required === 1))
          meal_dinner_plan = 'D';
      }

 // Vendor, vehicle type, vehicle no
      const vv = vendorVehByPlanRoute.get(hotelKey);
      let vendor_name = '';
      let vehicle_type_title = '';
      let vehicle_no = '';

      if (vv) {
        if (vv.vendor_id && vendorById.has(vv.vendor_id)) {
          vendor_name = vendorById.get(vv.vendor_id)!.vendor_name ?? '';
        }
        if (vv.vehicle_type_id && vehicleTypeById.has(vv.vehicle_type_id)) {
          vehicle_type_title =
            vehicleTypeById.get(vv.vehicle_type_id)!.vehicle_type_title ??
            '';
        }
        if (vv.vehicle_id && vehicleById.has(vv.vehicle_id)) {
          vehicle_no =
            vehicleById.get(vv.vehicle_id)!.registration_number ?? '';
        }
      }

 // Driver
      const driverAssignment =
        driverAssignmentByPlan.get(itinerary_plan_ID);
      let driver_name = '';
      let driver_mobile = '';

      if (
        driverAssignment &&
        driverAssignment.driver_id &&
        driverById.has(driverAssignment.driver_id)
      ) {
        const drv = driverById.get(driverAssignment.driver_id)!;
        driver_name = drv.driver_name ?? '';
        driver_mobile = drv.driver_primary_mobile_number ?? '';
      }

 // Agent + travel expert
      let agent_name = '';
      let travel_expert_name = '';
      let travel_expert_mobile = '';
      let travel_expert_email = '';

      if (plan.agent_id && agentById.has(plan.agent_id)) {
        const agent = agentById.get(plan.agent_id)!;
        agent_name = agent.agent_name ?? '';

        if (
          agent.travel_expert_id &&
          travelExpertById.has(agent.travel_expert_id)
        ) {
          const te = travelExpertById.get(agent.travel_expert_id)!;
          travel_expert_name = te.staff_name ?? '';
          travel_expert_mobile = te.staff_mobile ?? '';
          travel_expert_email = te.staff_email ?? '';
        }
      }

 // Trip type
      const tripStartDate = plan.trip_start_date_and_time
        ? this.formatDateYYYYMMDD(plan.trip_start_date_and_time)
        : '';
      const tripEndDate = plan.trip_end_date_and_time
        ? this.formatDateYYYYMMDD(plan.trip_end_date_and_time)
        : '';
      const routeDateYMD =
        this.formatDateYYYYMMDD(itinerary_route_date);

      let trip_type: 'Arrival' | 'Departure' | 'Ongoing';
      if (tripStartDate && routeDateYMD === tripStartDate) {
        trip_type = 'Arrival';
      } else if (tripEndDate && routeDateYMD === tripEndDate) {
        trip_type = 'Departure';
      } else {
        trip_type = 'Ongoing';
      }

 // Format route date as dd-mm-YYYY like PHP
      const route_date =
        this.formatDateDDMMYYYY(itinerary_route_date);

      const row: DailyMomentRowDto = {
        count: counter,
        guest_name: this.fieldOrDash(guest_name),
        guest_mobile: this.fieldOrDash(guest_mobile),
        guest_email: this.fieldOrDash(guest_email),
        quote_id: plan.itinerary_quote_ID ?? null,
        itinerary_plan_ID,
        itinerary_route_ID,
        route_date,
        trip_type,
        location_name: this.fieldOrDash(location_name),
        next_visiting_location:
          this.fieldOrDash(next_visiting_location),
        arrival_flight_details:
          this.fieldOrDash(arrival_flight_details),
        departure_flight_details:
          this.fieldOrDash(departure_flight_details),
        hotel_name: this.fieldOrDash(hotel_name),
        vehicle_type_title: this.fieldOrDash(vehicle_type_title),
        vendor_name: this.fieldOrDash(vendor_name),
        meal_plan: `${meal_breakfast_plan} ${meal_lunch_plan} ${meal_dinner_plan}`.trim(),
        vehicle_no: this.fieldOrDash(vehicle_no),
        driver_name: this.fieldOrDash(driver_name),
        driver_mobile: this.fieldOrDash(driver_mobile),
        special_remarks: this.fieldOrDash(special_remarks_final),
        travel_expert_name: this.fieldOrDash(travel_expert_name),
        travel_expert_mobile: this.fieldOrDash(travel_expert_mobile),
        travel_expert_email: this.fieldOrDash(travel_expert_email),
        agent_name: this.fieldOrDash(agent_name),
      };

      rows.push(row);
    }

    return rows;
  }

 /**
   * List extra charges for a given plan+route (car icon popup).
 */
  async listCharges(
    itineraryPlanId: number,
    itineraryRouteId: number,
  ): Promise<DailyMomentChargeRowDto[]> {
    if (!itineraryPlanId) {
      throw new BadRequestException('itineraryPlanId is required');
    }

    const where: any = {
      itinerary_plan_ID: itineraryPlanId,
      deleted: 0,
      status: 1,
    };
    if (itineraryRouteId > 0) {
      where.itinerary_route_ID = itineraryRouteId;
    }

    const charges =
      await this.prisma.dvi_confirmed_itinerary_dailymoment_charge.findMany({
        where,
        orderBy: {
          driver_charge_ID: 'asc',
        },
      });

    return charges.map((c) => ({
      driver_charge_ID: c.driver_charge_ID,
      itinerary_plan_ID: c.itinerary_plan_ID,
      itinerary_route_ID: c.itinerary_route_ID,
      charge_type: c.charge_type ?? '',
      charge_amount: c.charge_amount,
    }));
  }

 /**
   * Create / update an extra charge row (form behind car icon).
 */
  async upsertCharge(
    dto: UpsertDailyMomentChargeDto,
  ): Promise<DailyMomentChargeRowDto> {
    const {
      driverChargeId,
      itineraryPlanId,
      itineraryRouteId,
      chargeType,
      chargeAmount,
    } = dto;

    if (!itineraryPlanId || !itineraryRouteId) {
      throw new BadRequestException(
        'itineraryPlanId and itineraryRouteId are required',
      );
    }

    if (driverChargeId) {
      const updated =
        await this.prisma.dvi_confirmed_itinerary_dailymoment_charge.update(
          {
            where: { driver_charge_ID: driverChargeId },
            data: {
              itinerary_plan_ID: itineraryPlanId,
              itinerary_route_ID: itineraryRouteId,
              charge_type: chargeType,
              charge_amount: chargeAmount,
              updatedon: new Date(),
            },
          },
        );

      return {
        driver_charge_ID: updated.driver_charge_ID,
        itinerary_plan_ID: updated.itinerary_plan_ID,
        itinerary_route_ID: updated.itinerary_route_ID,
        charge_type: updated.charge_type ?? '',
        charge_amount: updated.charge_amount,
      };
    }

    const created =
      await this.prisma.dvi_confirmed_itinerary_dailymoment_charge.create({
        data: {
          itinerary_plan_ID: itineraryPlanId,
          itinerary_route_ID: itineraryRouteId,
          charge_type: chargeType,
          charge_amount: chargeAmount,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });

    return {
      driver_charge_ID: created.driver_charge_ID,
      itinerary_plan_ID: created.itinerary_plan_ID,
      itinerary_route_ID: created.itinerary_route_ID,
      charge_type: created.charge_type ?? '',
      charge_amount: created.charge_amount,
    };
  }

 /**
   * Driver rating list (uses dvi_confirmed_itinerary_driver_feedback)
 */
  async listDriverRatings(
    itineraryPlanId: number,
  ): Promise<DriverRatingRowDto[]> {
    if (!itineraryPlanId) {
      throw new BadRequestException('itineraryPlanId is required');
    }

    const driverFeedback =
      await this.prisma.dvi_confirmed_itinerary_driver_feedback.findMany({
        where: {
          itinerary_plan_ID: itineraryPlanId,
          deleted: 0,
          status: 1,
        },
        orderBy: {
          driver_feedback_ID: 'asc',
        },
      });

    if (!driverFeedback.length) {
      return [];
    }

    const routeIds = Array.from(
      new Set(driverFeedback.map((f) => f.itinerary_route_ID)),
    );
    const routes =
      await this.prisma.dvi_confirmed_itinerary_route_details.findMany({
        where: {
          itinerary_plan_ID: itineraryPlanId,
          itinerary_route_ID: { in: routeIds },
          deleted: 0,
          status: 1,
        },
      });

    const routeById = new Map<number, (typeof routes)[number]>();
    routes.forEach((r) => routeById.set(r.itinerary_route_ID, r));

    const rows: DriverRatingRowDto[] = [];

    for (const fb of driverFeedback) {
      const route = routeById.get(fb.itinerary_route_ID);
      if (!route) continue;

      rows.push({
        driver_feedback_ID: fb.driver_feedback_ID,
        itinerary_plan_ID: fb.itinerary_plan_ID,
        itinerary_route_ID: fb.itinerary_route_ID,
        route_date: this.formatDateDDMMYYYY(route.itinerary_route_date),
        location_name: route.location_name ?? '',
        next_visiting_location: route.next_visiting_location ?? '',
        driver_rating: fb.driver_rating ?? '',
        driver_description: fb.driver_description ?? '',
      });
    }

    return rows;
  }

 /**
   * Guide rating list (route_guide_details + latest guide_review_details)
 */
  async listGuideRatings(
    itineraryPlanId: number,
  ): Promise<GuideRatingRowDto[]> {
    if (!itineraryPlanId) {
      throw new BadRequestException('itineraryPlanId is required');
    }

    const routeGuides =
      await this.prisma.dvi_confirmed_itinerary_route_guide_details.findMany({
        where: {
          itinerary_plan_ID: itineraryPlanId,
          deleted: 0,
          status: 1,
        },
        orderBy: {
          confirmed_route_guide_ID: 'asc',
        },
      });

    if (!routeGuides.length) {
      return [];
    }

    const routeIds = Array.from(
      new Set(routeGuides.map((g) => g.itinerary_route_ID)),
    );
    const guideIds = Array.from(
      new Set(routeGuides.map((g) => g.guide_id)),
    );

    const routes =
      await this.prisma.dvi_confirmed_itinerary_route_details.findMany({
        where: {
          itinerary_plan_ID: itineraryPlanId,
          itinerary_route_ID: { in: routeIds },
          deleted: 0,
          status: 1,
        },
      });
    const routeById = new Map<number, (typeof routes)[number]>();
    routes.forEach((r) => routeById.set(r.itinerary_route_ID, r));

    const guides = await this.prisma.dvi_guide_details.findMany({
      where: {
        guide_id: { in: guideIds },
        deleted: 0,
        status: 1,
      },
    });
    const guideById = new Map<number, (typeof guides)[number]>();
    guides.forEach((g) => guideById.set(g.guide_id, g));

    const guideReviews =
      await this.prisma.dvi_guide_review_details.findMany({
        where: {
          guide_id: { in: guideIds },
          deleted: 0,
          status: 1,
        },
        orderBy: {
          createdon: 'desc',
        },
      });

    const latestReviewByGuide = new Map<
      number,
      (typeof guideReviews)[number]
    >();
    guideReviews.forEach((rev) => {
      if (!latestReviewByGuide.has(rev.guide_id)) {
        latestReviewByGuide.set(rev.guide_id, rev);
      }
    });

    const rows: GuideRatingRowDto[] = [];

    for (const rg of routeGuides) {
      const route = routeById.get(rg.itinerary_route_ID);
      if (!route) continue;

      const guide = guideById.get(rg.guide_id);
      const review = latestReviewByGuide.get(rg.guide_id);

      rows.push({
        guide_review_id: review?.guide_review_id ?? 0,
        itinerary_plan_ID: rg.itinerary_plan_ID,
        itinerary_route_ID: rg.itinerary_route_ID,
        route_date: this.formatDateDDMMYYYY(route.itinerary_route_date),
        location_name: route.location_name ?? '',
        next_visiting_location: route.next_visiting_location ?? '',
        guide_id: rg.guide_id,
        guide_name: guide?.guide_name ?? '',
        guide_rating: review?.guide_rating ?? '',
        guide_description: review?.guide_description ?? '',
      });
    }

    return rows;
  }

 /**
   * Day-wise hotspot cards for a given plan + route.
   * Powers the pink cards with place name, time and Visited / Not-Visited buttons.
   *
   * Tables used:
   * - dvi_confirmed_itinerary_route_hotspot_details  (per-stop details, statuses, times)
   * - dvi_hotspot_place                               (master hotspot name/location)
 */
  async listRouteHotspots(
    itineraryPlanId: number,
    itineraryRouteId: number,
  ): Promise<DailyMomentHotspotRowDto[]> {
    if (!itineraryPlanId || !itineraryRouteId) {
      throw new BadRequestException(
        'itineraryPlanId and itineraryRouteId are required',
      );
    }

 // 1) All hotspots for this plan + route
    const hotspotRows =
      await this.prisma.dvi_confirmed_itinerary_route_hotspot_details.findMany(
        {
          where: {
            itinerary_plan_ID: itineraryPlanId,
            itinerary_route_ID: itineraryRouteId,
            deleted: 0,
            status: 1,
          },
          orderBy: {
            hotspot_order: 'asc',
          },
        },
      );

    if (!hotspotRows.length) {
      return [];
    }

 // 2) Load hotspot master records (name / location)
    const hotspotIds = Array.from(
      new Set(
        hotspotRows
          .map((h) => h.hotspot_ID)
          .filter((id) => typeof id === 'number' && id > 0),
      ),
    );

    const hotspotMasters = hotspotIds.length
      ? await this.prisma.dvi_hotspot_place.findMany({
          where: {
            hotspot_ID: { in: hotspotIds },
            deleted: 0,
            status: 1,
          },
        })
      : [];

    const hotspotMasterById = new Map<
      number,
      (typeof hotspotMasters)[number]
    >();
    hotspotMasters.forEach((h) => hotspotMasterById.set(h.hotspot_ID, h));

 // 3) Build DTO rows
    const rows: DailyMomentHotspotRowDto[] = [];

    hotspotRows.forEach((row, index) => {
      const master = hotspotMasterById.get(row.hotspot_ID);

      const startTime = row.hotspot_start_time ?? null;
      const endTime = row.hotspot_end_time ?? null;
      const { minutes: durationMinutes, label: durationLabel } =
        this.calcDurationLabel(startTime, endTime);

      rows.push({
        serial_no: row.hotspot_order || index + 1,
        confirmed_route_hotspot_ID: row.confirmed_route_hotspot_ID,
        route_hotspot_ID: row.route_hotspot_ID,
        itinerary_plan_ID: row.itinerary_plan_ID,
        itinerary_route_ID: row.itinerary_route_ID,
        hotspot_ID: row.hotspot_ID,

        hotspot_name: (master?.hotspot_name ?? '').trim() || 'N/A',
        hotspot_location: (master?.hotspot_location ?? '').trim() || 'N/A',

        start_time: this.formatTimeHHMM(startTime),
        end_time: this.formatTimeHHMM(endTime),
        duration_minutes: durationMinutes,
        duration_label: durationLabel,

        driver_hotspot_status: row.driver_hotspot_status ?? 0,
        driver_not_visited_description:
          row.driver_not_visited_description ?? null,
        guide_hotspot_status: row.guide_hotspot_status ?? 0,
        guide_not_visited_description:
          row.guide_not_visited_description ?? null,
        item_type: row.item_type ?? 4,
      });
    });

    return rows;
  }

 // ========= HELPER METHODS =========

  private parseDate(input: string): Date {
    const trimmed = input.trim();

 // Support DD-MM-YYYY (from old PHP UI)
    const ddmmyyyy = /^(\d{2})-(\d{2})-(\d{4})$/;
    const m = trimmed.match(ddmmyyyy);
    if (m) {
      const [_, dd, mm, yyyy] = m;
      return new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
    }

 // Fallback: let JS parse ISO-like inputs
    const d = new Date(trimmed);
    if (isNaN(d.getTime())) {
      throw new BadRequestException(`Invalid date: ${input}`);
    }
    return d;
  }

  private mkPlanRouteKey(planId: number, routeId: number): string {
    return `${planId}:${routeId}`;
  }

  private formatTimeHHMM(date?: Date | null): string {
    if (!date) return '--';
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return '--';

    let hours = d.getHours();
    const minutes = d.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    if (hours === 0) hours = 12;

    const hh = String(hours).padStart(2, '0');
    const mm = String(minutes).padStart(2, '0');
    return `${hh}:${mm} ${ampm}`;
  }

  private calcDurationLabel(
    start?: Date | null,
    end?: Date | null,
  ): { minutes: number; label: string } {
    if (!start || !end) {
      return { minutes: 0, label: '0 Min' };
    }
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) {
      return { minutes: 0, label: '0 Min' };
    }

    const minutes = Math.round((e - s) / 60000);
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;

    const parts: string[] = [];
    if (hours > 0) {
      parts.push(`${hours} Hour${hours > 1 ? 's' : ''}`);
    }
    if (mins > 0) {
      parts.push(`${mins} Min`);
    }

    const label = parts.length ? parts.join(' ') : '0 Min';
    return { minutes, label };
  }

  private formatDateYYYYMMDD(date: Date | null): string {
    if (!date) return '';
    const d = new Date(date);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private formatDateDDMMYYYY(date: Date | null): string {
    if (!date) return '';
    const d = new Date(date);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${day}-${m}-${y}`;
  }

  private fieldOrDash(value: string | null | undefined): string {
    if (value === null || value === undefined) return '--';
    const plain = String(value).trim();
    return plain === '' ? '--' : value;
  }

 // ========= DAY VIEW =========

 /**
   * Full multi-day view for a given itinerary plan.
   * Returns plan header + per-day data (routes, hotspots, guide, KM).
 */
  async getDayView(planId: number): Promise<DayViewPlanDto> {
    if (!planId) throw new BadRequestException('planId is required');

    let effectivePlanId = planId;
    let plan =
      await this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
        where: { itinerary_plan_ID: effectivePlanId, deleted: 0, status: 1 },
      });

    if (!plan) {
      const importedPlanId = await this.tryImportLegacyPhpPlan(planId);
      if (importedPlanId) {
        effectivePlanId = importedPlanId;
        plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
          where: { itinerary_plan_ID: effectivePlanId, deleted: 0, status: 1 },
        });
      }
    }

    if (!plan) throw new BadRequestException('Plan not found');

 // Guest (primary customer)
    const guest =
      await this.prisma.dvi_confirmed_itinerary_customer_details.findFirst({
        where: {
          itinerary_plan_ID: effectivePlanId,
          primary_customer: 1,
          deleted: 0,
          status: 1,
        },
      });

 // Travel expert
    let travelExpertName = '';
    let travelExpertMobile = '';
    let travelExpertEmail = '';
    if (plan.staff_id) {
      let staff = await this.prisma.dvi_staff.findFirst({
        where: { staff_id: plan.staff_id, deleted: 0 },
      });
      if (!staff) {
 // Staff not yet in dvi_main try fetching directly from legacy DB
        const legacyDb = this.legacyPhpDbName.replace(/`/g, '');
        const legacyRows = await this.prisma.$queryRawUnsafe<
          Array<{ staff_id: number; staff_name: string; staff_email: string; staff_mobile_number: string }>
        >(
          `SELECT staff_id, staff_name, staff_email, staff_mobile_number FROM \`${legacyDb}\`.dvi_staff WHERE staff_id = ? LIMIT 1`,
          plan.staff_id,
        ).catch(() => [] as any[]);
        if (legacyRows.length) {
          staff = legacyRows[0] as any;
        } else {
 // Try dvi_staff_details (the table used for travel experts in the legacy system)
          const detailRows = await this.prisma.$queryRawUnsafe<
            Array<{ staff_id: number; staff_name: string; staff_mobile: string; staff_email: string }>
          >(
            `SELECT staff_id, staff_name, staff_mobile, staff_email FROM \`${legacyDb}\`.dvi_staff_details WHERE staff_id = ? LIMIT 1`,
            plan.staff_id,
          ).catch(() => [] as any[]);
          if (detailRows.length) {
            const d = detailRows[0];
            staff = { staff_id: d.staff_id, staff_name: d.staff_name, staff_mobile_number: d.staff_mobile, staff_email: d.staff_email, deleted: 0 } as any;
          }
        }
      }
      travelExpertName = staff?.staff_name ?? '';
      travelExpertMobile = staff?.staff_mobile_number ?? '';
      travelExpertEmail = staff?.staff_email ?? '';
    }

 // PHP parity fallback: derive travel expert from agent.travel_expert_id
 // when plan.staff_id is not populated.
    if (!travelExpertName && plan.agent_id) {
      const agent = await this.prisma.dvi_agent.findFirst({
        where: { agent_ID: plan.agent_id, deleted: 0, status: 1 },
        select: { travel_expert_id: true },
      });

      if (agent?.travel_expert_id) {
        const te = await this.prisma.dvi_staff_details.findFirst({
          where: {
            staff_id: agent.travel_expert_id,
            deleted: 0,
            status: 1,
          },
          select: {
            staff_name: true,
            staff_mobile: true,
            staff_email: true,
          },
        });

        travelExpertName = te?.staff_name ?? '';
        travelExpertMobile = te?.staff_mobile ?? '';
        travelExpertEmail = te?.staff_email ?? '';
      }
    }

 // All routes for this plan
    const routes =
      await this.prisma.dvi_confirmed_itinerary_route_details.findMany({
        where: { itinerary_plan_ID: effectivePlanId, deleted: 0, status: 1 },
        orderBy: { no_of_days: 'asc' },
      });

    const routeIds = routes.map((r) => r.confirmed_itinerary_route_ID);

 // KM data per route
    const vehicleRows =
      routeIds.length
        ? await this.prisma.dvi_confirmed_itinerary_plan_vendor_vehicle_details.findMany(
            {
              where: {
                itinerary_plan_id: effectivePlanId,
                itinerary_route_id: { in: routes.map((r) => r.itinerary_route_ID) },
                deleted: 0,
                status: 1,
              },
              orderBy: { confirmed_itinerary_plan_vendor_vehicle_details_ID: 'asc' },
            },
          )
        : [];
 // keyed by itinerary_route_id (first row wins)
    const kmByRouteId = new Map<number, (typeof vehicleRows)[0]>();
    vehicleRows.forEach((v) => {
      if (!kmByRouteId.has(v.itinerary_route_id)) {
        kmByRouteId.set(v.itinerary_route_id, v);
      }
    });

 // Hotspots per route
    const hotspotRows =
      routeIds.length
        ? await this.prisma.dvi_confirmed_itinerary_route_hotspot_details.findMany(
            {
              where: {
                itinerary_plan_ID: effectivePlanId,
                itinerary_route_ID: { in: routes.map((r) => r.itinerary_route_ID) },
                deleted: 0,
                status: 1,
              },
              orderBy: { hotspot_order: 'asc' },
            },
          )
        : [];

    const hotspotMasterIds = [...new Set(hotspotRows.map((h) => h.hotspot_ID).filter(Boolean))];
    const hotspotMasters = hotspotMasterIds.length
      ? await this.prisma.dvi_hotspot_place.findMany({
          where: { hotspot_ID: { in: hotspotMasterIds }, deleted: 0, status: 1 },
        })
      : [];
    const hotspotMasterById = new Map<number, (typeof hotspotMasters)[0]>();
    hotspotMasters.forEach((h) => hotspotMasterById.set(h.hotspot_ID, h));

 // Guides per route
    const guideRows =
      routeIds.length
        ? await this.prisma.dvi_confirmed_itinerary_route_guide_details.findMany(
            {
              where: {
                itinerary_plan_ID: effectivePlanId,
                itinerary_route_ID: { in: routes.map((r) => r.itinerary_route_ID) },
                deleted: 0,
                status: 1,
              },
            },
          )
        : [];

    const guideIds = [...new Set(guideRows.map((g) => g.guide_id).filter(Boolean))];
    const guideDetails = guideIds.length
      ? await this.prisma.dvi_guide_details.findMany({
          where: { guide_id: { in: guideIds }, deleted: 0, status: 1 },
        })
      : [];
    const guideById = new Map<number, (typeof guideDetails)[0]>();
    guideDetails.forEach((g) => guideById.set(g.guide_id, g));

 // Activities per route+hotspot
    const routeActivityRows = routeIds.length
      ? await this.prisma.dvi_confirmed_itinerary_route_activity_details.findMany({
          where: {
            itinerary_plan_ID: effectivePlanId,
            itinerary_route_ID: { in: routes.map((r) => r.itinerary_route_ID) },
            deleted: 0,
            status: 1,
          },
          orderBy: [{ itinerary_route_ID: 'asc' }, { route_hotspot_ID: 'asc' }, { activity_order: 'asc' }],
        })
      : [];

    const activityIds = [...new Set(routeActivityRows.map((a) => a.activity_ID).filter(Boolean))];
    const activityMasterRows = activityIds.length
      ? await this.prisma.dvi_activity.findMany({
          where: { activity_id: { in: activityIds }, deleted: 0, status: 1 },
          select: { activity_id: true, activity_title: true },
        })
      : [];
    const activityMasterById = new Map<number, (typeof activityMasterRows)[0]>();
    activityMasterRows.forEach((a) => activityMasterById.set(a.activity_id, a));

    const activitiesByRouteHotspot = new Map<string, (typeof routeActivityRows)[number][]>();
    const firstActivityByRoute = new Map<number, (typeof routeActivityRows)[number]>();
    routeActivityRows.forEach((a) => {
      const hk = `${a.itinerary_route_ID}:${a.route_hotspot_ID}`;
      const arr = activitiesByRouteHotspot.get(hk) ?? [];
      arr.push(a);
      activitiesByRouteHotspot.set(hk, arr);

      if (!firstActivityByRoute.has(a.itinerary_route_ID)) {
        firstActivityByRoute.set(a.itinerary_route_ID, a);
      }
    });

 // Hotel + meal info
    const hotelRoomRows = routeIds.length
      ? await this.prisma.dvi_confirmed_itinerary_plan_hotel_room_details.findMany({
          where: {
            itinerary_plan_id: effectivePlanId,
            itinerary_route_id: { in: routes.map((r) => r.itinerary_route_ID) },
            deleted: 0,
            status: 1,
          },
        })
      : [];
    const hotelIds = [...new Set(hotelRoomRows.map((h) => h.hotel_id).filter(Boolean))];
    const hotels = hotelIds.length
      ? await this.prisma.dvi_hotel.findMany({
          where: { hotel_id: { in: hotelIds }, deleted: false, status: 1 },
          select: { hotel_id: true, hotel_name: true },
        })
      : [];
    const hotelById = new Map<number, (typeof hotels)[0]>();
    hotels.forEach((h) => hotelById.set(h.hotel_id, h));
    const hotelRoomsByRoute = new Map<number, (typeof hotelRoomRows)[number][]>();
    hotelRoomRows.forEach((h) => {
      const arr = hotelRoomsByRoute.get(h.itinerary_route_id) ?? [];
      arr.push(h);
      hotelRoomsByRoute.set(h.itinerary_route_id, arr);
    });

 // Vendor + vehicle + driver info
    const vendorVehicleRows = routeIds.length
      ? await this.prisma.dvi_confirmed_itinerary_plan_vendor_vehicle_details.findMany({
          where: {
            itinerary_plan_id: effectivePlanId,
            itinerary_route_id: { in: routes.map((r) => r.itinerary_route_ID) },
            deleted: 0,
            status: 1,
          },
          orderBy: { confirmed_itinerary_plan_vendor_vehicle_details_ID: 'asc' },
        })
      : [];
    const vendorVehicleByRoute = new Map<number, (typeof vendorVehicleRows)[0]>();
    vendorVehicleRows.forEach((v) => {
      if (!vendorVehicleByRoute.has(v.itinerary_route_id)) {
        vendorVehicleByRoute.set(v.itinerary_route_id, v);
      }
    });
    const vendorIds = [...new Set(vendorVehicleRows.map((v) => v.vendor_id).filter(Boolean))];
    const vehicleTypeIds = [...new Set(vendorVehicleRows.map((v) => v.vehicle_type_id).filter(Boolean))];
    const vehicleIds = [...new Set(vendorVehicleRows.map((v) => v.vehicle_id).filter(Boolean))];

    const vendors = vendorIds.length
      ? await this.prisma.dvi_vendor_details.findMany({
          where: { vendor_id: { in: vendorIds }, deleted: 0, status: 1 },
          select: { vendor_id: true, vendor_name: true },
        })
      : [];
    const vendorById = new Map<number, (typeof vendors)[0]>();
    vendors.forEach((v) => vendorById.set(v.vendor_id, v));

    const vehicleTypes = vehicleTypeIds.length
      ? await this.prisma.dvi_vehicle_type.findMany({
          where: { vehicle_type_id: { in: vehicleTypeIds }, deleted: 0, status: 1 },
          select: { vehicle_type_id: true, vehicle_type_title: true },
        })
      : [];
    const vehicleTypeById = new Map<number, (typeof vehicleTypes)[0]>();
    vehicleTypes.forEach((v) => vehicleTypeById.set(v.vehicle_type_id, v));

    const vehicles = vehicleIds.length
      ? await this.prisma.dvi_vehicle.findMany({
          where: { vehicle_id: { in: vehicleIds }, deleted: 0, status: 1 },
          select: { vehicle_id: true, registration_number: true },
        })
      : [];
    const vehicleById = new Map<number, (typeof vehicles)[0]>();
    vehicles.forEach((v) => vehicleById.set(v.vehicle_id, v));

    const driverAssignment = await this.prisma.dvi_confirmed_itinerary_vendor_driver_assigned.findFirst({
      where: { itinerary_plan_id: effectivePlanId, deleted: 0, status: 1 },
      orderBy: { driver_assigned_on: 'desc' },
    });
    const driver = driverAssignment?.driver_id
      ? await this.prisma.dvi_driver_details.findFirst({
          where: { driver_id: driverAssignment.driver_id, deleted: 0, status: 1 },
          select: { driver_name: true, driver_primary_mobile_number: true },
        })
      : null;

    const agent = plan.agent_id
      ? await this.prisma.dvi_agent.findFirst({
          where: { agent_ID: plan.agent_id, deleted: 0, status: 1 },
          select: { agent_name: true },
        })
      : null;

 // Assemble days
    const days: DayViewDayDto[] = routes.map((route, idx) => {
      const routeId = route.itinerary_route_ID;
      const km = kmByRouteId.get(routeId);
      const openingKm = km?.driver_opening_km ?? '0';
      const closingKm = km?.driver_closing_km ?? '0';
      const completed = route.driver_trip_completed === 1;
      const runningKm = completed
        ? Math.max(0, Number(closingKm) - Number(openingKm))
        : 0;

      const dayHotspots: DailyMomentHotspotRowDto[] = hotspotRows
        .filter((h) => h.itinerary_route_ID === routeId)
        .map((h, hIdx) => {
          const master = hotspotMasterById.get(h.hotspot_ID);
          const { minutes, label } = this.calcDurationLabel(
            h.hotspot_start_time,
            h.hotspot_end_time,
          );
          const hk = `${routeId}:${h.route_hotspot_ID}`;
          const activities = (activitiesByRouteHotspot.get(hk) ?? []).map((a) => ({
            confirmed_route_activity_ID: a.confirmed_route_activity_ID,
            route_activity_ID: a.route_activity_ID,
            route_hotspot_ID: a.route_hotspot_ID,
            hotspot_ID: a.hotspot_ID,
            activity_ID: a.activity_ID,
            activity_title: activityMasterById.get(a.activity_ID)?.activity_title ?? 'Activity',
            driver_activity_status: a.driver_activity_status ?? 0,
            driver_not_visited_description: a.driver_not_visited_description ?? null,
            guide_activity_status: a.guide_activity_status ?? 0,
            guide_not_visited_description: a.guide_not_visited_description ?? null,
          }));
          return {
            serial_no: h.hotspot_order || hIdx + 1,
            confirmed_route_hotspot_ID: h.confirmed_route_hotspot_ID,
            route_hotspot_ID: h.route_hotspot_ID,
            itinerary_plan_ID: h.itinerary_plan_ID,
            itinerary_route_ID: h.itinerary_route_ID,
            hotspot_ID: h.hotspot_ID,
            item_type: h.item_type,
            hotspot_name: (master?.hotspot_name ?? '').trim() || 'N/A',
            hotspot_location: (master?.hotspot_location ?? '').trim() || '',
            start_time: this.formatTimeHHMM(h.hotspot_start_time),
            end_time: this.formatTimeHHMM(h.hotspot_end_time),
            duration_minutes: minutes,
            duration_label: label,
            driver_hotspot_status: h.driver_hotspot_status ?? 0,
            driver_not_visited_description: h.driver_not_visited_description ?? null,
            guide_hotspot_status: h.guide_hotspot_status ?? 0,
            guide_not_visited_description: h.guide_not_visited_description ?? null,
            activities,
          } as DailyMomentHotspotRowDto;
        });

      const dayGuides: DayViewGuideDto[] = guideRows
        .filter((g) => g.itinerary_route_ID === routeId && g.guide_type === 2)
        .map((g) => ({
          confirmed_route_guide_ID: g.confirmed_route_guide_ID,
          guide_id: g.guide_id,
          guide_name: guideById.get(g.guide_id)?.guide_name ?? '',
          guide_type: g.guide_type,
          driver_guide_status: g.driver_guide_status ?? 0,
          driver_not_visited_description: g.driver_not_visited_description ?? null,
        }));

      const wholedayGuideRow = guideRows.find(
        (g) => g.itinerary_route_ID === routeId && g.guide_type === 1,
      );
      const wholedayGuide: DayViewGuideDto | null = wholedayGuideRow
        ? {
            confirmed_route_guide_ID: wholedayGuideRow.confirmed_route_guide_ID,
            guide_id: wholedayGuideRow.guide_id,
            guide_name: guideById.get(wholedayGuideRow.guide_id)?.guide_name ?? '',
            guide_type: 1,
            driver_guide_status: route.wholeday_guidehotspot_status ?? 0,
            driver_not_visited_description: route.guide_not_visited_description ?? null,
          }
        : null;

      const hotelRooms = hotelRoomsByRoute.get(routeId) ?? [];
      const firstHotelRoom = hotelRooms[0];
      const hotelName = firstHotelRoom?.hotel_id
        ? hotelById.get(firstHotelRoom.hotel_id)?.hotel_name ?? ''
        : '';
      const mealBreakfast = hotelRooms.some((h) => h.breakfast_required === 1) ? 'B' : '-';
      const mealLunch = hotelRooms.some((h) => h.lunch_required === 1) ? 'L' : '-';
      const mealDinner = hotelRooms.some((h) => h.dinner_required === 1) ? 'D' : '-';

      const vv = vendorVehicleByRoute.get(routeId);
      const vendorName = vv?.vendor_id ? vendorById.get(vv.vendor_id)?.vendor_name ?? '' : '';
      const vehicleTypeTitle = vv?.vehicle_type_id
        ? vehicleTypeById.get(vv.vehicle_type_id)?.vehicle_type_title ?? ''
        : '';
      const vehicleNo = vv?.vehicle_id ? vehicleById.get(vv.vehicle_id)?.registration_number ?? '' : '';

      const firstActivity = firstActivityByRoute.get(routeId);
      const specialFromActivity = firstActivity?.activity_ID
        ? (activityMasterById.get(firstActivity.activity_ID)?.activity_title ?? '').trim()
        : '';
      const specialInstructions = (plan.special_instructions ?? '').trim();
      let specialRemarks = '';
      if (specialFromActivity && specialInstructions) specialRemarks = `${specialFromActivity} / ${specialInstructions}`;
      else if (specialFromActivity) specialRemarks = specialFromActivity;
      else if (specialInstructions) specialRemarks = specialInstructions;

      const tripStartDate = plan.trip_start_date_and_time
        ? this.formatDateYYYYMMDD(plan.trip_start_date_and_time)
        : '';
      const tripEndDate = plan.trip_end_date_and_time
        ? this.formatDateYYYYMMDD(plan.trip_end_date_and_time)
        : '';
      const routeDateYMD = this.formatDateYYYYMMDD(route.itinerary_route_date);
      let tripType: 'Arrival' | 'Departure' | 'Ongoing' = 'Ongoing';
      if (tripStartDate && routeDateYMD === tripStartDate) tripType = 'Arrival';
      else if (tripEndDate && routeDateYMD === tripEndDate) tripType = 'Departure';

      return {
        day_number: idx + 1,
        itinerary_route_ID: routeId,
        confirmed_itinerary_route_ID: route.confirmed_itinerary_route_ID,
        route_date: this.formatDateDDMMYYYY(route.itinerary_route_date),
        from_location: route.location_name ?? '',
        to_location: route.next_visiting_location ?? '',
        trip_type: tripType,
        arrival_flight_details: this.fieldOrDash(guest?.arrival_flight_details ?? ''),
        departure_flight_details: this.fieldOrDash(guest?.departure_flight_details ?? ''),
        hotel_name: this.fieldOrDash(hotelName),
        vehicle_type_title: this.fieldOrDash(vehicleTypeTitle),
        vendor_name: this.fieldOrDash(vendorName),
        meal_plan: `${mealBreakfast} ${mealLunch} ${mealDinner}`.trim(),
        vehicle_no: this.fieldOrDash(vehicleNo),
        driver_name: this.fieldOrDash(driver?.driver_name ?? ''),
        driver_mobile: this.fieldOrDash(driver?.driver_primary_mobile_number ?? ''),
        agent_name: this.fieldOrDash(agent?.agent_name ?? ''),
        special_remarks: this.fieldOrDash(specialRemarks),
        km: {
          opening_km: openingKm,
          closing_km: closingKm,
          opening_speedmeter_image: km?.opening_speedmeter_image ?? null,
          closing_speedmeter_image: km?.closing_speedmeter_image ?? null,
          running_km: runningKm,
          completed,
        },
        wholeday_guide: wholedayGuide,
        guides: dayGuides,
        hotspots: dayHotspots,
      } as unknown as DayViewDayDto;
    });

    return {
      itinerary_plan_ID: plan.itinerary_plan_ID,
      quote_id: plan.itinerary_quote_ID ?? '',
      trip_start_date: this.formatDateDDMMYYYY(plan.trip_start_date_and_time),
      trip_end_date: this.formatDateDDMMYYYY(plan.trip_end_date_and_time),
      no_of_days: plan.no_of_days ?? 0,
      no_of_nights: plan.no_of_nights ?? 0,
      arrival_location: plan.arrival_location ?? '',
      departure_location: plan.departure_location ?? '',
      guest_name: guest?.customer_name ?? '',
      guest_mobile: guest?.primary_contact_no ?? '',
      guest_email: guest?.email_id ?? '',
      travel_expert_name: travelExpertName,
      travel_expert_mobile: travelExpertMobile,
      travel_expert_email: travelExpertEmail,
      days,
    } as DayViewPlanDto;
  }

 /**
   * Import a missing itinerary from legacy PHP DB (default db: dvi_travels)
   * into current Nest DB (dvi_main). Returns resolved itinerary_plan_ID.
 */
  private async tryImportLegacyPhpPlan(
    requestedPlanId: number,
  ): Promise<number | null> {
    const legacyDb = this.legacyPhpDbName.replace(/`/g, '');

    try {
      const sourcePlanRows = await this.prisma.$queryRawUnsafe<
        Array<{ itinerary_plan_ID: number }>
      >(
        `
          SELECT itinerary_plan_ID
          FROM \`${legacyDb}\`.dvi_confirmed_itinerary_plan_details
          WHERE deleted = 0
            AND status = 1
            AND (itinerary_plan_ID = ? OR confirmed_itinerary_plan_ID = ?)
          LIMIT 1
        `,
        requestedPlanId,
        requestedPlanId,
      );

      if (!sourcePlanRows.length) return null;

      const sourceItineraryPlanId = Number(sourcePlanRows[0].itinerary_plan_ID);
      if (!sourceItineraryPlanId) return null;

      const alreadyExists =
        await this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
          where: {
            itinerary_plan_ID: sourceItineraryPlanId,
            deleted: 0,
            status: 1,
          },
          select: { confirmed_itinerary_plan_ID: true },
        });

      if (alreadyExists) return sourceItineraryPlanId;

 this.logger.warn(
        `Plan ${requestedPlanId} missing in dvi_main; importing itinerary_plan_ID=${sourceItineraryPlanId} from ${legacyDb}`,
      );

      await this.prisma.$executeRawUnsafe(
        `
          INSERT IGNORE INTO dvi_confirmed_itinerary_plan_details
          SELECT *
          FROM \`${legacyDb}\`.dvi_confirmed_itinerary_plan_details
          WHERE itinerary_plan_ID = ?
        `,
        sourceItineraryPlanId,
      );

      await this.prisma.$executeRawUnsafe(
        `
          INSERT IGNORE INTO dvi_confirmed_itinerary_customer_details
          SELECT *
          FROM \`${legacyDb}\`.dvi_confirmed_itinerary_customer_details
          WHERE itinerary_plan_ID = ?
        `,
        sourceItineraryPlanId,
      );

      await this.prisma.$executeRawUnsafe(
        `
          INSERT IGNORE INTO dvi_confirmed_itinerary_route_details
          SELECT *
          FROM \`${legacyDb}\`.dvi_confirmed_itinerary_route_details
          WHERE itinerary_plan_ID = ?
        `,
        sourceItineraryPlanId,
      );

      await this.prisma.$executeRawUnsafe(
        `
          INSERT IGNORE INTO dvi_confirmed_itinerary_route_hotspot_details
          SELECT *
          FROM \`${legacyDb}\`.dvi_confirmed_itinerary_route_hotspot_details
          WHERE itinerary_plan_ID = ?
        `,
        sourceItineraryPlanId,
      );

      await this.prisma.$executeRawUnsafe(
        `
          INSERT IGNORE INTO dvi_confirmed_itinerary_route_guide_details
          SELECT *
          FROM \`${legacyDb}\`.dvi_confirmed_itinerary_route_guide_details
          WHERE itinerary_plan_ID = ?
        `,
        sourceItineraryPlanId,
      );

      await this.prisma.$executeRawUnsafe(
        `
          INSERT IGNORE INTO dvi_confirmed_itinerary_plan_vendor_vehicle_details
          SELECT *
          FROM \`${legacyDb}\`.dvi_confirmed_itinerary_plan_vendor_vehicle_details
          WHERE itinerary_plan_id = ?
        `,
        sourceItineraryPlanId,
      );

      const safeExec = async (sql: string, label: string) => {
        try {
          await this.prisma.$executeRawUnsafe(sql, sourceItineraryPlanId);
        } catch (e) {
 this.logger.warn(
            `Legacy import: skipped ${label} for plan ${sourceItineraryPlanId} (${e instanceof Error ? e.message : String(e)})`,
          );
        }
      };

      await safeExec(
        `
          INSERT IGNORE INTO dvi_confirmed_itinerary_dailymoment_charge
          SELECT *
          FROM \`${legacyDb}\`.dvi_confirmed_itinerary_dailymoment_charge
          WHERE itinerary_plan_ID = ?
        `,
        'dailymoment_charge',
      );

      await safeExec(
        `
          INSERT IGNORE INTO dvi_confirmed_itinerary_driver_feedback
          SELECT *
          FROM \`${legacyDb}\`.dvi_confirmed_itinerary_driver_feedback
          WHERE itinerary_plan_ID = ?
        `,
        'driver_feedback',
      );

      await safeExec(
        `
          INSERT IGNORE INTO dvi_hotspot_place
            (hotspot_ID, hotspot_type, hotspot_name, hotspot_description, hotspot_address,
             hotspot_landmark, hotspot_location, hotspot_priority, hotspot_adult_entry_cost,
             hotspot_child_entry_cost, hotspot_infant_entry_cost, hotspot_foreign_adult_entry_cost,
             hotspot_foreign_child_entry_cost, hotspot_foreign_infant_entry_cost, hotspot_duration,
             hotspot_rating, hotspot_latitude, hotspot_longitude, hotspot_video_url,
             createdby, createdon, updatedon, status, deleted)
          SELECT
             hp.hotspot_ID, hp.hotspot_type, hp.hotspot_name, hp.hotspot_description, hp.hotspot_address,
             hp.hotspot_landmark, hp.hotspot_location, hp.hotspot_priority, hp.hotspot_adult_entry_cost,
             hp.hotspot_child_entry_cost, hp.hotspot_infant_entry_cost, hp.hotspot_foreign_adult_entry_cost,
             hp.hotspot_foreign_child_entry_cost, hp.hotspot_foreign_infant_entry_cost, hp.hotspot_duration,
             hp.hotspot_rating, hp.hotspot_latitude, hp.hotspot_longitude, hp.hotspot_video_url,
             hp.createdby, hp.createdon, hp.updatedon, hp.status, hp.deleted
          FROM \`${legacyDb}\`.dvi_hotspot_place hp
          INNER JOIN \`${legacyDb}\`.dvi_confirmed_itinerary_route_hotspot_details rh
            ON rh.hotspot_ID = hp.hotspot_ID
          WHERE rh.itinerary_plan_ID = ?
        `,
        'hotspot_place_master',
      );

      await safeExec(
        `
          INSERT IGNORE INTO dvi_guide_details
          SELECT gd.*
          FROM \`${legacyDb}\`.dvi_guide_details gd
          INNER JOIN \`${legacyDb}\`.dvi_confirmed_itinerary_route_guide_details rg
            ON rg.guide_id = gd.guide_id
          WHERE rg.itinerary_plan_ID = ?
        `,
        'guide_details_master',
      );

      await safeExec(
        `
          INSERT IGNORE INTO dvi_staff
          SELECT st.*
          FROM \`${legacyDb}\`.dvi_staff st
          INNER JOIN \`${legacyDb}\`.dvi_confirmed_itinerary_plan_details pd
            ON pd.staff_id = st.staff_id
          WHERE pd.itinerary_plan_ID = ?
        `,
        'staff_master',
      );

      return sourceItineraryPlanId;
    } catch (error) {
 this.logger.error(
        `Legacy PHP import failed for plan ${requestedPlanId}`,
        error instanceof Error ? error.stack : String(error),
      );
      return null;
    }
  }

 // ========= STATUS UPDATES =========

  async updateHotspotStatus(dto: {
    confirmedRouteHotspotId: number;
    status: number;
    description?: string;
    perspective?: 'driver' | 'guide';
  }): Promise<void> {
    const perspective = dto.perspective ?? 'driver';
    const data: Record<string, unknown> = { updatedon: new Date() };

    if (perspective === 'driver') {
      data.driver_hotspot_status = dto.status;
      if (dto.status === 2) data.driver_not_visited_description = dto.description ?? '';
      else data.driver_not_visited_description = null;
    } else {
      data.guide_hotspot_status = dto.status;
      if (dto.status === 2) data.guide_not_visited_description = dto.description ?? '';
      else data.guide_not_visited_description = null;
    }

    await this.prisma.dvi_confirmed_itinerary_route_hotspot_details.update({
      where: { confirmed_route_hotspot_ID: dto.confirmedRouteHotspotId },
      data: data as any,
    });
  }

  async updateGuideStatus(dto: {
    confirmedRouteGuideId: number;
    status: number;
    description?: string;
  }): Promise<void> {
    await this.prisma.dvi_confirmed_itinerary_route_guide_details.update({
      where: { confirmed_route_guide_ID: dto.confirmedRouteGuideId },
      data: {
        driver_guide_status: dto.status,
        driver_not_visited_description: dto.status === 2 ? (dto.description ?? '') : null,
        updatedon: new Date(),
      },
    });
  }

  async updateWholedayGuideStatus(dto: {
    confirmedItineraryRouteId: number;
    status: number;
    description?: string;
  }): Promise<void> {
    await this.prisma.dvi_confirmed_itinerary_route_details.update({
      where: { confirmed_itinerary_route_ID: dto.confirmedItineraryRouteId },
      data: {
        wholeday_guidehotspot_status: dto.status,
        guide_not_visited_description: dto.status === 2 ? (dto.description ?? '') : null,
        updatedon: new Date(),
      },
    });
  }

  async updateActivityStatus(dto: {
    confirmedRouteActivityId: number;
    status: number;
    description?: string;
    perspective?: 'driver' | 'guide';
  }): Promise<void> {
    const perspective = dto.perspective ?? 'driver';
    const data: Record<string, unknown> = { updatedon: new Date() };

    if (perspective === 'driver') {
      data.driver_activity_status = dto.status;
      data.driver_not_visited_description =
        dto.status === 2 ? (dto.description ?? '') : null;
    } else {
      data.guide_activity_status = dto.status;
      data.guide_not_visited_description =
        dto.status === 2 ? (dto.description ?? '') : null;
    }

    await this.prisma.dvi_confirmed_itinerary_route_activity_details.update({
      where: { confirmed_route_activity_ID: dto.confirmedRouteActivityId },
      data: data as any,
    });
  }

 // ========= DELETE CHARGE =========

  async deleteCharge(driverChargeId: number): Promise<void> {
    if (!driverChargeId) throw new BadRequestException('id is required');
    await this.prisma.dvi_confirmed_itinerary_dailymoment_charge.update({
      where: { driver_charge_ID: driverChargeId },
      data: { deleted: 1, updatedon: new Date() },
    });
  }

 // ========= DRIVER RATING CRUD =========

  async upsertDriverRating(dto: UpsertDriverRatingDto): Promise<{ driver_feedback_ID: number }> {
    if (dto.driverFeedbackId) {
      const updated =
        await this.prisma.dvi_confirmed_itinerary_driver_feedback.update({
          where: { driver_feedback_ID: dto.driverFeedbackId },
          data: {
            driver_rating: String(dto.customerRating),
            driver_description: dto.feedbackDescription ?? '',
            updatedon: new Date(),
          },
        });
      return { driver_feedback_ID: updated.driver_feedback_ID };
    }

    const created =
      await this.prisma.dvi_confirmed_itinerary_driver_feedback.create({
        data: {
          itinerary_plan_ID: dto.itineraryPlanId,
          itinerary_route_ID: dto.itineraryRouteId,
          driver_rating: String(dto.customerRating),
          driver_description: dto.feedbackDescription ?? '',
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });
    return { driver_feedback_ID: created.driver_feedback_ID };
  }

  async deleteDriverRating(driverFeedbackId: number): Promise<void> {
    if (!driverFeedbackId) throw new BadRequestException('id is required');
    await this.prisma.dvi_confirmed_itinerary_driver_feedback.update({
      where: { driver_feedback_ID: driverFeedbackId },
      data: { deleted: 1, updatedon: new Date() },
    });
  }

  async upsertGuideRating(dto: UpsertGuideRatingDto): Promise<{ guide_review_id: number }> {
    let guideId = dto.guideId ?? 0;

    if (!guideId) {
      const routeGuide = await this.prisma.dvi_confirmed_itinerary_route_guide_details.findFirst({
        where: {
          itinerary_plan_ID: dto.itineraryPlanId,
          itinerary_route_ID: dto.itineraryRouteId,
          deleted: 0,
          status: 1,
        },
        orderBy: { confirmed_route_guide_ID: 'asc' },
      });
      guideId = routeGuide?.guide_id ?? 0;
    }

    if (!guideId) {
      throw new BadRequestException('guideId not found for itinerary route');
    }

    if (dto.guideReviewId) {
      const updated = await this.prisma.dvi_guide_review_details.update({
        where: { guide_review_id: dto.guideReviewId },
        data: {
          guide_id: guideId,
          guide_rating: String(dto.guideRating),
          guide_description: dto.guideDescription ?? '',
          updatedon: new Date(),
        },
      });
      return { guide_review_id: updated.guide_review_id };
    }

    const created = await this.prisma.dvi_guide_review_details.create({
      data: {
        guide_id: guideId,
        guide_rating: String(dto.guideRating),
        guide_description: dto.guideDescription ?? '',
        createdon: new Date(),
        status: 1,
        deleted: 0,
      },
    });

    await this.prisma.dvi_confirmed_itinerary_route_details.updateMany({
      where: {
        itinerary_plan_ID: dto.itineraryPlanId,
        itinerary_route_ID: dto.itineraryRouteId,
        deleted: 0,
        status: 1,
      },
      data: { guide_trip_completed: 1, updatedon: new Date() },
    });

    return { guide_review_id: created.guide_review_id };
  }

  async deleteGuideRating(guideReviewId: number): Promise<void> {
    if (!guideReviewId) throw new BadRequestException('id is required');
    await this.prisma.dvi_guide_review_details.update({
      where: { guide_review_id: guideReviewId },
      data: { deleted: 1, updatedon: new Date() },
    });
  }

 // ========= KILOMETER =========

  async saveOpeningKm(dto: SaveOpeningKmDto): Promise<void> {
    const { itineraryPlanId, itineraryRouteId, startingKilometer } = dto;
    if (!startingKilometer || startingKilometer.trim() === '') {
      throw new BadRequestException('startingKilometer is required');
    }

 // Update first matching vendor vehicle row for plan+route
    const row =
      await this.prisma.dvi_confirmed_itinerary_plan_vendor_vehicle_details.findFirst(
        {
          where: {
            itinerary_plan_id: itineraryPlanId,
            itinerary_route_id: itineraryRouteId,
            deleted: 0,
            status: 1,
          },
        },
      );

    if (!row) throw new BadRequestException('Vehicle row not found for this route');

    await this.prisma.dvi_confirmed_itinerary_plan_vendor_vehicle_details.update(
      {
        where: {
          confirmed_itinerary_plan_vendor_vehicle_details_ID:
            row.confirmed_itinerary_plan_vendor_vehicle_details_ID,
        },
        data: { driver_opening_km: startingKilometer, updatedon: new Date() },
      },
    );
  }

  async saveClosingKm(dto: SaveClosingKmDto): Promise<void> {
    const { itineraryPlanId, itineraryRouteId, closingKilometer } = dto;
    if (!closingKilometer || closingKilometer.trim() === '') {
      throw new BadRequestException('closingKilometer is required');
    }

    const row =
      await this.prisma.dvi_confirmed_itinerary_plan_vendor_vehicle_details.findFirst(
        {
          where: {
            itinerary_plan_id: itineraryPlanId,
            itinerary_route_id: itineraryRouteId,
            deleted: 0,
            status: 1,
          },
        },
      );

    if (!row) throw new BadRequestException('Vehicle row not found for this route');

    const openingKm = Number(row.driver_opening_km ?? '0');
    const closingKmNum = Number(closingKilometer);

    if (closingKmNum <= openingKm) {
      throw new BadRequestException(
        `Closing KM (${closingKmNum}) must be greater than Opening KM (${openingKm})`,
      );
    }

    await this.prisma.dvi_confirmed_itinerary_plan_vendor_vehicle_details.update(
      {
        where: {
          confirmed_itinerary_plan_vendor_vehicle_details_ID:
            row.confirmed_itinerary_plan_vendor_vehicle_details_ID,
        },
        data: { driver_closing_km: closingKilometer, updatedon: new Date() },
      },
    );

 // Mark route as completed
    const route =
      await this.prisma.dvi_confirmed_itinerary_route_details.findFirst({
        where: {
          itinerary_plan_ID: itineraryPlanId,
          itinerary_route_ID: itineraryRouteId,
          deleted: 0,
          status: 1,
        },
      });
    if (route) {
      await this.prisma.dvi_confirmed_itinerary_route_details.update({
        where: { confirmed_itinerary_route_ID: route.confirmed_itinerary_route_ID },
        data: { driver_trip_completed: 1, updatedon: new Date() },
      });
    }
  }

  async saveDayImages(
    itineraryPlanId: number,
    itineraryRouteId: number,
    files: Express.Multer.File[],
    createdby: number,
  ) {
    if (!files?.length) return { count: 0, files: [] };

    const now = new Date();
    const created = await Promise.all(
      files.map((f) =>
        this.prisma.dvi_confirmed_driver_uploadimage.create({
          data: {
            itinerary_plan_ID: itineraryPlanId,
            itinerary_route_ID: itineraryRouteId,
            driver_upload_image: f.filename,
            createdby,
            createdon: now,
            status: 1,
            deleted: 0,
          } as any,
        }),
      ),
    );

    return {
      count: created.length,
      files: created.map((r) => r.driver_upload_image),
      ids: created.map((r) => r.driver_uploadimage_ID),
    };
  }

  async saveOpeningKmImage(
    itineraryPlanId: number,
    itineraryRouteId: number,
    file?: Express.Multer.File,
  ): Promise<{ file: string }> {
    if (!file) throw new BadRequestException('image file is required');

    const row = await this.prisma.dvi_confirmed_itinerary_plan_vendor_vehicle_details.findFirst({
      where: {
        itinerary_plan_id: itineraryPlanId,
        itinerary_route_id: itineraryRouteId,
        deleted: 0,
        status: 1,
      },
      orderBy: { confirmed_itinerary_plan_vendor_vehicle_details_ID: 'asc' },
    });

    if (!row) throw new BadRequestException('Vehicle row not found for this route');

    await this.prisma.dvi_confirmed_itinerary_plan_vendor_vehicle_details.update({
      where: {
        confirmed_itinerary_plan_vendor_vehicle_details_ID:
          row.confirmed_itinerary_plan_vendor_vehicle_details_ID,
      },
      data: { opening_speedmeter_image: file.filename, updatedon: new Date() },
    });

    return { file: file.filename };
  }

  async saveClosingKmImage(
    itineraryPlanId: number,
    itineraryRouteId: number,
    file?: Express.Multer.File,
  ): Promise<{ file: string }> {
    if (!file) throw new BadRequestException('image file is required');

    const row = await this.prisma.dvi_confirmed_itinerary_plan_vendor_vehicle_details.findFirst({
      where: {
        itinerary_plan_id: itineraryPlanId,
        itinerary_route_id: itineraryRouteId,
        deleted: 0,
        status: 1,
      },
      orderBy: { confirmed_itinerary_plan_vendor_vehicle_details_ID: 'asc' },
    });

    if (!row) throw new BadRequestException('Vehicle row not found for this route');

    await this.prisma.dvi_confirmed_itinerary_plan_vendor_vehicle_details.update({
      where: {
        confirmed_itinerary_plan_vendor_vehicle_details_ID:
          row.confirmed_itinerary_plan_vendor_vehicle_details_ID,
      },
      data: { closing_speedmeter_image: file.filename, updatedon: new Date() },
    });

    return { file: file.filename };
  }
}
