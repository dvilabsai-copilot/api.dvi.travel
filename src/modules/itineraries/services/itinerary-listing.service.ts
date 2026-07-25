// FILE: src/modules/itineraries/services/itinerary-listing.service.ts

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';
import { LatestItineraryQueryDto } from '../dto/latest-itinerary-query.dto';

function parseFilterDate(value?: string): Date | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;

  const match = raw.match(/^(\d{2})[\/-](\d{2})[\/-](\d{4})$/);
  const date = match
    ? new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]))
    : new Date(raw);

  return Number.isNaN(date.getTime()) ? undefined : date;
}

function nextDay(date: Date): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + 1);
  return result;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

@Injectable()
export class ItineraryListingService {
  constructor(private readonly prisma: PrismaService) {}

  async getAgentsForFilter(req: any) {
    const u: any = (req as any).user ?? {};
    const staffId = Number(u.staffId ?? 0);
    const agentId = Number(u.agentId ?? 0);

    const where: any = { deleted: 0 };

    if (agentId > 0) {
      where.agent_ID = agentId;
    } else if (staffId > 0) {
      where.travel_expert_id = staffId;
    }

    const agents = await this.prisma.dvi_agent.findMany({
      where,
      select: {
        agent_ID: true,
        agent_name: true,
        agent_lastname: true,
      },
      orderBy: {
        agent_name: 'asc',
      },
    });

    return agents.map((a) => ({
      id: a.agent_ID,
      name: a.agent_name || '',
      staff_name: a.agent_lastname || '',
    }));
  }

  async getLocationsForFilter() {
 // Get unique arrival and departure locations from confirmed itineraries
    const plans = await this.prisma.dvi_itinerary_plan_details.findMany({
      where: {
        quotation_status: 1,
        deleted: 0,
      },
      select: {
        arrival_location: true,
        departure_location: true,
      },
    });

    const locationsSet = new Set<string>();

    plans.forEach((plan) => {
      if (plan.arrival_location) locationsSet.add(plan.arrival_location);
      if (plan.departure_location) locationsSet.add(plan.departure_location);
    });

    return Array.from(locationsSet)
      .filter(loc => loc && loc.trim().length > 0)
      .sort()
      .map(loc => ({ value: loc, label: loc }));
  }

 /**
   * Get unique locations for latest itineraries filter (from all non-deleted plans)
 */
  async getLocationsForLatestFilter(): Promise<{ value: string; label: string }[]> {
    const plans = await this.prisma.dvi_itinerary_plan_details.findMany({
      where: {
        deleted: 0,
      },
      select: {
        arrival_location: true,
        departure_location: true,
      },
    });

    const locationsSet = new Set<string>();

    plans.forEach((plan) => {
      if (plan.arrival_location) locationsSet.add(plan.arrival_location);
      if (plan.departure_location) locationsSet.add(plan.departure_location);
    });

    return Array.from(locationsSet)
      .filter(loc => loc && loc.trim().length > 0)
      .sort()
      .map(loc => ({ value: loc, label: loc }));
  }

  async getConfirmedItineraries(query: LatestItineraryQueryDto, req: any) {
    const {
      start = 0,
      length = 10,
      search: requestedSearch,
      search_value,
      start_date,
      end_date,
      source_location,
      destination_location,
      agent_id,
      staff_id,
      guide_id,
      vendor_id,
      include_cancelled,
    } = query;

    const search = String(requestedSearch ?? search_value ?? '').trim();

    const u: any = (req as any).user ?? {};
    const logged_user_level = Number(u.roleID ?? u.roleId ?? u.role ?? 0) || 0;
    const input_staff_id = Number(u.staff_id ?? u.staffId ?? 0) || 0;
    const input_agent_id = Number(u.agent_id ?? u.agentId ?? 0) || 0;
    const input_guide_id = Number(u.guide_id ?? u.guideId ?? 0) || 0;

    const where: any = {
      quotation_status: 1,
      deleted: 0,
    };

    if (input_agent_id > 0) {
      where.agent_id = input_agent_id;
    } else if (input_guide_id > 0) {
 // Guide logic: find itineraries where this guide is assigned
      const guideAssignments = await this.prisma.dvi_confirmed_itinerary_route_guide_details.findMany({
        where: { guide_id: input_guide_id, deleted: 0 },
        select: { itinerary_plan_ID: true },
      });
      const assignedPlanIds = [...new Set(guideAssignments.map(a => a.itinerary_plan_ID))];
      where.itinerary_plan_ID = { in: assignedPlanIds };
    } else if (input_staff_id > 0 && logged_user_level !== 6) {
 // Travel Expert logic
      const teAgents = await this.prisma.dvi_agent.findMany({
        where: { travel_expert_id: input_staff_id } as any,
        select: { agent_ID: true },
      });
      const teAgentIds = teAgents.map((a) => Number(a.agent_ID)).filter((n) => n > 0);
      where.OR = [
        { staff_id: input_staff_id },
        ...(teAgentIds.length ? [{ agent_id: { in: teAgentIds } }] : []),
      ];
    } else {
      if (agent_id) where.agent_id = agent_id;
      if (staff_id) where.staff_id = staff_id;
    }

    if (source_location) {
      where.arrival_location = { contains: source_location };
    }

    if (destination_location) {
      where.departure_location = { contains: destination_location };
    }

    const startDate = parseFilterDate(start_date);
    if (startDate) {
      where.trip_start_date_and_time = {
        gte: startDate,
        lt: nextDay(startDate),
      };
    }

    const endDate = parseFilterDate(end_date);
    if (endDate) {
      where.trip_end_date_and_time = {
        gte: endDate,
        lt: nextDay(endDate),
      };
    }

    const constrainToPlanIds = (planIds: number[]) => {
      const existingIds = Array.isArray(where.itinerary_plan_ID?.in)
        ? where.itinerary_plan_ID.in.map((id: number) => Number(id))
        : null;
      const allowedIds = existingIds
        ? planIds.filter((id) => existingIds.includes(Number(id)))
        : planIds;

      where.itinerary_plan_ID = {
        in: allowedIds.length ? allowedIds : [-1],
      };
    };

    if (guide_id && guide_id > 0) {
      const guideRows = await this.prisma.dvi_confirmed_itinerary_route_guide_details.findMany({
        where: {
          guide_id,
          status: 1,
          deleted: 0,
        },
        select: { itinerary_plan_ID: true },
      });
      constrainToPlanIds([...new Set(guideRows.map((row) => Number(row.itinerary_plan_ID))) ]);
    }

    if (vendor_id && vendor_id > 0) {
      const vendorRows = await this.prisma.dvi_confirmed_itinerary_plan_vendor_eligible_list.findMany({
        where: {
          vendor_id,
          itineary_plan_assigned_status: 1,
        },
        select: { itinerary_plan_id: true },
      });
      constrainToPlanIds([...new Set(vendorRows.map((row) => Number(row.itinerary_plan_id))) ]);
    }

    if (include_cancelled) {
      const cancelledRows = await this.prisma.dvi_cancelled_itineraries.findMany({
        where: {
          status: 1,
          deleted: 0,
        },
        select: { itinerary_plan_id: true },
      });
      constrainToPlanIds([...new Set(cancelledRows.map((row) => Number(row.itinerary_plan_id))) ]);
    }

 // Keep the total count on the same access and regular filters, but before
 // applying the global search. This makes pagination accurate.
    const unsearchedWhere = { ...where };

    if (search) {
      const searchPattern = `%${escapeLikePattern(search)}%`;
      const matchingRows = await this.prisma.$queryRaw<Array<{ itinerary_plan_ID: number }>>(
        Prisma.sql`
          SELECT DISTINCT ip.itinerary_plan_ID
          FROM dvi_itinerary_plan_details ip
          LEFT JOIN dvi_confirmed_itinerary_plan_details cip
            ON cip.itinerary_plan_ID = ip.itinerary_plan_ID
          LEFT JOIN dvi_users du
            ON du.userID = ip.createdby
          LEFT JOIN dvi_staff_details s
            ON s.staff_id = du.staff_id
          LEFT JOIN dvi_agent a
            ON a.agent_ID = du.agent_id
          WHERE ip.quotation_status = 1
            AND ip.deleted = 0
            AND (
              ip.arrival_location LIKE ${searchPattern}
              OR ip.departure_location LIKE ${searchPattern}
              OR cip.arrival_location LIKE ${searchPattern}
              OR cip.departure_location LIKE ${searchPattern}
              OR s.staff_name LIKE ${searchPattern}
              OR a.agent_name LIKE ${searchPattern}
              OR ip.itinerary_quote_ID LIKE ${searchPattern}
              OR cip.itinerary_quote_ID LIKE ${searchPattern}
              OR du.username LIKE ${searchPattern}
            )
        `,
      );

      constrainToPlanIds(
        matchingRows
          .map((row) => Number(row.itinerary_plan_ID))
          .filter((id) => id > 0),
      );
    }

    const [total, filtered, data] = await Promise.all([
      this.prisma.dvi_itinerary_plan_details.count({
        where: unsearchedWhere,
      }),
      this.prisma.dvi_itinerary_plan_details.count({ where }),
      this.prisma.dvi_itinerary_plan_details.findMany({
        where,
        skip: Number(start),
        take: Number(length),
        orderBy: { createdon: 'desc' },
      }),
    ]);

    const confirmedPlanRows = data.length
      ? await this.prisma.dvi_confirmed_itinerary_plan_details.findMany({
          where: { itinerary_plan_ID: { in: data.map((p) => p.itinerary_plan_ID) } },
          select: {
            confirmed_itinerary_plan_ID: true,
            itinerary_plan_ID: true,
          },
        })
      : [];

    const confirmedPlanIdByPlanId = new Map<number, number>();
    for (const row of confirmedPlanRows as any[]) {
      const planId = Number(row?.itinerary_plan_ID || 0);
      const confirmedId = Number(row?.confirmed_itinerary_plan_ID || 0);
      if (planId > 0 && confirmedId > 0 && !confirmedPlanIdByPlanId.has(planId)) {
        confirmedPlanIdByPlanId.set(planId, confirmedId);
      }
    }

 // Fetch primary customer details for confirmed itineraries
    const itineraryPlanIds = data
      .map((p) => Number(p.itinerary_plan_ID || 0))
      .filter((id) => id > 0);

    const confirmedPlanIds = Array.from(confirmedPlanIdByPlanId.values()).filter(
      (id) => id > 0,
    );

    const customerRows = itineraryPlanIds.length
      ? await this.prisma.dvi_confirmed_itinerary_customer_details.findMany({
          where: {
            deleted: 0,
            OR: [
              { itinerary_plan_ID: { in: itineraryPlanIds } },
              ...(confirmedPlanIds.length
                ? [{ confirmed_itinerary_plan_ID: { in: confirmedPlanIds } }]
                : []),
            ],
          },
          select: {
            confirmed_itinerary_customer_ID: true,
            confirmed_itinerary_plan_ID: true,
            itinerary_plan_ID: true,
            primary_customer: true,
            customer_salutation: true,
            customer_name: true,
            primary_contact_no: true,
          },
          orderBy: {
            confirmed_itinerary_customer_ID: 'asc',
          },
        })
      : [];

    const customerByPlanId = new Map<number, any>();
    const customerByConfirmedPlanId = new Map<number, any>();

    const shouldUseCustomerRow = (existing: any, incoming: any) => {
      if (!existing) return true;

      const existingIsPrimary = Number(existing?.primary_customer || 0) === 1;
      const incomingIsPrimary = Number(incoming?.primary_customer || 0) === 1;

      return !existingIsPrimary && incomingIsPrimary;
    };

    for (const customer of customerRows as any[]) {
      const planId = Number(customer?.itinerary_plan_ID || 0);
      const confirmedPlanId = Number(customer?.confirmed_itinerary_plan_ID || 0);

      if (
        planId > 0 &&
        shouldUseCustomerRow(customerByPlanId.get(planId), customer)
      ) {
        customerByPlanId.set(planId, customer);
      }

      if (
        confirmedPlanId > 0 &&
        shouldUseCustomerRow(customerByConfirmedPlanId.get(confirmedPlanId), customer)
      ) {
        customerByConfirmedPlanId.set(confirmedPlanId, customer);
      }
    }

    const formatCustomerName = (customer: any) => {
      const name = `${customer?.customer_salutation || ''} ${
        customer?.customer_name || ''
      }`.trim();

      return name || 'N/A';
    };

 // Fetch agents manually since no relations in Prisma schema
    const agentIds = [...new Set(data.map((p) => p.agent_id))];
    const agents = await this.prisma.dvi_agent.findMany({
      where: { agent_ID: { in: agentIds } },
      select: { agent_ID: true, agent_name: true },
    });
    const agentMap = new Map(agents.map((a) => [a.agent_ID, a.agent_name]));

    return {
      draw: query.draw || 1,
      recordsTotal: total,
      recordsFiltered: filtered,
      data: data.map((p) => {
        const itineraryPlanId = Number(p.itinerary_plan_ID || 0);

        const confirmedPlanId =
          confirmedPlanIdByPlanId.get(itineraryPlanId) ?? null;

        const customer =
          customerByPlanId.get(itineraryPlanId) ||
          (confirmedPlanId
            ? customerByConfirmedPlanId.get(Number(confirmedPlanId))
            : null);

        return {
          itinerary_plan_ID: p.itinerary_plan_ID,
          confirmed_itinerary_plan_ID: confirmedPlanId,
          booking_quote_id: p.itinerary_quote_ID,
          agent_name: agentMap.get(p.agent_id) || 'N/A',
          primary_customer_name: formatCustomerName(customer),
          primary_contact_no: customer?.primary_contact_no || 'N/A',
          arrival_location: p.arrival_location,
          departure_location: p.departure_location,
          arrival_date: p.trip_start_date_and_time,
          departure_date: p.trip_end_date_and_time,
          nights: p.no_of_nights,
          days: p.no_of_days,
          created_on: p.createdon,
          created_by: p.createdby,
        };
      }),
    };
  }

  async getCancelledItineraries(query: LatestItineraryQueryDto, req: any) {
    const {
      start = 0,
      length = 10,
      start_date,
      end_date,
      agent_id,
    } = query;

    const u: any = (req as any).user ?? {};
    const logged_user_level = Number(u.roleID ?? u.roleId ?? u.role ?? 0) || 0;
    const input_staff_id = Number(u.staff_id ?? u.staffId ?? 0) || 0;
    const input_agent_id = Number(u.agent_id ?? u.agentId ?? 0) || 0;

    const where: any = {
      deleted: 0,
    };

    if (start_date && end_date) {
      where.createdon = {
        gte: new Date(start_date),
        lte: new Date(end_date),
      };
    }

    if (input_agent_id > 0) {
      const agentPlans = await this.prisma.dvi_itinerary_plan_details.findMany({
        where: { agent_id: input_agent_id },
        select: { itinerary_plan_ID: true },
      });
      where.itinerary_plan_id = { in: agentPlans.map((p) => p.itinerary_plan_ID) };
    } else if (input_staff_id > 0 && logged_user_level !== 6) {
      const teAgents = await this.prisma.dvi_agent.findMany({
        where: { travel_expert_id: input_staff_id } as any,
        select: { agent_ID: true },
      });
      const teAgentIds = teAgents.map((a) => Number(a.agent_ID)).filter((n) => n > 0);

      const tePlans = await this.prisma.dvi_itinerary_plan_details.findMany({
        where: {
          OR: [
            { staff_id: input_staff_id },
            ...(teAgentIds.length ? [{ agent_id: { in: teAgentIds } }] : []),
          ],
        },
        select: { itinerary_plan_ID: true },
      });
      where.itinerary_plan_id = { in: tePlans.map((p) => p.itinerary_plan_ID) };
    } else if (agent_id) {
      const agentPlans = await this.prisma.dvi_itinerary_plan_details.findMany({
        where: { agent_id: agent_id },
        select: { itinerary_plan_ID: true },
      });
      where.itinerary_plan_id = { in: agentPlans.map((p) => p.itinerary_plan_ID) };
    }

    const [total, filtered, data] = await Promise.all([
      this.prisma.dvi_cancelled_itineraries.count({
        where: { deleted: 0 },
      }),
      this.prisma.dvi_cancelled_itineraries.count({ where }),
      this.prisma.dvi_cancelled_itineraries.findMany({
        where,
        skip: Number(start),
        take: Number(length),
        orderBy: { createdon: 'desc' },
      }),
    ]);

 // Fetch plan details and agents manually
    const planIds = data.map((p) => p.itinerary_plan_id);
    const plans = await this.prisma.dvi_itinerary_plan_details.findMany({
      where: { itinerary_plan_ID: { in: planIds } },
      select: { itinerary_plan_ID: true, itinerary_quote_ID: true, agent_id: true },
    });
    const planMap = new Map(plans.map((p) => [p.itinerary_plan_ID, p]));

    const agentIds = [...new Set(plans.map((p) => p.agent_id))];
    const agents = await this.prisma.dvi_agent.findMany({
      where: { agent_ID: { in: agentIds } },
      select: { agent_ID: true, agent_name: true },
    });
    const agentMap = new Map(agents.map((a) => [a.agent_ID, a.agent_name]));

    return {
      draw: query.draw || 1,
      recordsTotal: total,
      recordsFiltered: filtered,
      data: data.map((p) => {
        const plan = planMap.get(p.itinerary_plan_id);
        return {
          cancelled_itinerary_ID: p.cancelled_itinerary_ID,
          itinerary_plan_ID: p.itinerary_plan_id,
          booking_quote_id: plan?.itinerary_quote_ID || 'N/A',
          agent_name: agentMap.get(plan?.agent_id || 0) || 'N/A',
          cancelled_date: p.createdon,
 cancelled_reason: 'N/A', // Reason not in this table
          refund_amount: p.total_refund_amount,
          refund_status: p.itinerary_cancellation_status,
        };
      }),
    };
  }

  async getAccountsItineraries(query: LatestItineraryQueryDto, req: any) {
    const {
      start = 0,
      length = 10,
      agent_id,
    } = query;

    const u: any = (req as any).user ?? {};
    const logged_user_level = Number(u.roleID ?? u.roleId ?? u.role ?? 0) || 0;
    const input_staff_id = Number(u.staff_id ?? u.staffId ?? 0) || 0;
    const input_agent_id = Number(u.agent_id ?? u.agentId ?? 0) || 0;

    const where: any = {
      deleted: 0,
    };

    if (input_agent_id > 0) {
      where.agent_id = input_agent_id;
    } else if (input_staff_id > 0 && logged_user_level !== 6) {
      const teAgents = await this.prisma.dvi_agent.findMany({
        where: { travel_expert_id: input_staff_id } as any,
        select: { agent_ID: true },
      });
      const teAgentIds = teAgents.map((a) => Number(a.agent_ID)).filter((n) => n > 0);
      where.OR = [
        { staff_id: input_staff_id },
        ...(teAgentIds.length ? [{ agent_id: { in: teAgentIds } }] : []),
      ];
    } else if (agent_id) {
      where.agent_id = agent_id;
    }

    const [total, filtered, data] = await Promise.all([
      this.prisma.dvi_accounts_itinerary_details.count({
        where: { deleted: 0 },
      }),
      this.prisma.dvi_accounts_itinerary_details.count({ where }),
      this.prisma.dvi_accounts_itinerary_details.findMany({
        where,
        skip: Number(start),
        take: Number(length),
        orderBy: { createdon: 'desc' },
      }),
    ]);

 // Fetch agents manually
    const agentIds = [...new Set(data.map((p) => p.agent_id))];
    const agents = await this.prisma.dvi_agent.findMany({
      where: { agent_ID: { in: agentIds } },
      select: { agent_ID: true, agent_name: true },
    });
    const agentMap = new Map(agents.map((a) => [a.agent_ID, a.agent_name]));

    return {
      draw: query.draw || 1,
      recordsTotal: total,
      recordsFiltered: filtered,
      data: data.map((p) => ({
        accounts_itinerary_details_ID: p.accounts_itinerary_details_ID,
        itinerary_plan_ID: p.itinerary_plan_ID,
        booking_quote_id: p.itinerary_quote_ID,
        agent_name: agentMap.get(p.agent_id) || 'N/A',
        trip_start_date: p.trip_start_date_and_time,
        trip_end_date: p.trip_end_date_and_time,
        total_billed_amount: p.total_billed_amount,
        total_received_amount: p.total_received_amount,
        total_receivable_amount: p.total_receivable_amount,
        total_payable_amount: p.total_payable_amount,
        total_payout_amount: p.total_payout_amount,
        created_on: p.createdon,
      })),
    };
  }

}
