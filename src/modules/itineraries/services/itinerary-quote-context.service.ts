// FILE: src/modules/itineraries/services/itinerary-quote-context.service.ts

import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';

@Injectable()
export class ItineraryQuoteContextService {
  constructor(private readonly prisma: PrismaService) {}

  async getPlanForEdit(planId: number) {
 // Fetch the plan
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: planId },
    });

    if (!plan) {
      throw new BadRequestException(`Plan ${planId} not found`);
    }

    const nationalityId = Number((plan as any).nationality || 0);
    if (nationalityId > 0) {
      const country = await this.prisma.dvi_countries.findFirst({
        where: { id: nationalityId, deleted: 0, status: 1 },
        select: { shortname: true },
      });
      const iso2 = String(country?.shortname || '').trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(iso2)) {
        (plan as any).nationality_iso2 = iso2;
      }
    }

 // Fetch routes
    const routes = await this.prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: planId, deleted: 0 },
      orderBy: { no_of_days: 'asc' },
    });

 // Fetch via routes for each route
    const routesWithVia = await Promise.all(
      routes.map(async (route) => {
        const viaRoutes = await this.prisma.dvi_itinerary_via_route_details.findMany({
          where: {
            itinerary_plan_ID: planId,
            itinerary_route_ID: route.itinerary_route_ID,
            deleted: 0,
          },
          orderBy: { itinerary_via_route_ID: 'asc' },
        });

        return {
          ...route,
          via_routes: viaRoutes.map(v => ({
            itinerary_via_location_ID: v.itinerary_via_location_ID,
            itinerary_via_location_name: v.itinerary_via_location_name,
          })),
        };
      })
    );

 // Fetch vehicles - note: this table uses lowercase itinerary_plan_id
    const vehicles = await this.prisma.dvi_itinerary_plan_vehicle_details.findMany({
      where: { itinerary_plan_id: planId, deleted: 0 },
      orderBy: { vehicle_details_ID: 'asc' },
    });

 // Fetch travellers so room-wise pax and child ages can be prefilled on edit.
    const travellers = await (this.prisma as any).dvi_itinerary_traveller_details.findMany({
      where: { itinerary_plan_ID: planId, deleted: 0 },
      orderBy: { traveller_details_ID: 'asc' },
    });

    return {
      plan,
      routes: routesWithVia,
      vehicles,
      travellers,
    };
  }

  async syncRouteFamilySelection(
    planId: number,
    desiredCount: number,
  ) {
    const normalizedPlanId = Math.trunc(Number(planId || 0));
    const normalizedDesiredCount = Math.trunc(
      Number(desiredCount || 0),
    );

    if (normalizedPlanId <= 0) {
      throw new BadRequestException(
        'A valid itinerary plan ID is required.',
      );
    }

    if (
      normalizedDesiredCount < 1 ||
      normalizedDesiredCount > 5
    ) {
      throw new BadRequestException(
        'Smart Booking supports between 1 and 5 selected routes.',
      );
    }

    const anchorPlan =
      await this.prisma.dvi_itinerary_plan_details.findUnique({
        where: {
          itinerary_plan_ID: normalizedPlanId,
        },
        select: {
          itinerary_plan_ID: true,
          itinerary_quote_ID: true,
        },
      });

    if (!anchorPlan) {
      throw new BadRequestException(
        `Plan ${normalizedPlanId} not found.`,
      );
    }

    const anchorQuoteId = String(
      anchorPlan.itinerary_quote_ID || '',
    ).trim();

    const familyMatch = anchorQuoteId.match(
      /^(.*)-R(\d+)$/i,
    );

    if (!familyMatch?.[1]) {
      throw new BadRequestException(
        'This itinerary is not a Smart Booking route family.',
      );
    }

    const baseQuoteId = String(familyMatch[1]).trim();

    const familyRows =
      await this.prisma.dvi_itinerary_plan_details.findMany({
        where: {
          itinerary_quote_ID: {
            startsWith: `${baseQuoteId}-R`,
          },
        },
        select: {
          itinerary_plan_ID: true,
          itinerary_quote_ID: true,
          deleted: true,
          createdon: true,
        },
        orderBy: [
          { createdon: 'asc' },
          { itinerary_plan_ID: 'asc' },
        ],
      });

    const parsedRows = familyRows
      .map((row) => {
        const quoteId = String(
          row.itinerary_quote_ID || '',
        ).trim();

        const match = quoteId.match(/-R(\d+)$/i);

        return {
          planId: Number(row.itinerary_plan_ID || 0),
          quoteId,
          routeIndex: match
            ? Number.parseInt(match[1], 10)
            : 0,
          deleted: Number(row.deleted || 0),
        };
      })
      .filter(
        (row) =>
          row.planId > 0 &&
          row.routeIndex > 0,
      );

    const slotRows =
      new Map<number, (typeof parsedRows)[number]>();

    parsedRows.forEach((row) => {
      if (!slotRows.has(row.routeIndex)) {
        slotRows.set(row.routeIndex, row);
      }
    });

    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      for (const row of parsedRows) {
        const canonical = slotRows.get(row.routeIndex);

        const shouldBeActive =
          canonical?.planId === row.planId &&
          row.routeIndex <= normalizedDesiredCount;

        const nextDeleted = shouldBeActive ? 0 : 1;

        if (row.deleted === nextDeleted) {
          continue;
        }

        await tx.dvi_itinerary_plan_details.update({
          where: {
            itinerary_plan_ID: row.planId,
          },
          data: {
            deleted: nextDeleted,
            updatedon: now,
          },
        });
      }
    });

    const options = Array.from(slotRows.values())
      .filter(
        (row) =>
          row.routeIndex <= normalizedDesiredCount,
      )
      .sort(
        (a, b) =>
          a.routeIndex - b.routeIndex,
      )
      .map((row) => ({
        planId: row.planId,
        quoteId: row.quoteId,
        routeIndex: row.routeIndex,
        label: `Route ${row.routeIndex}`,
      }));

    const missingRouteIndexes = Array.from(
      { length: normalizedDesiredCount },
      (_, index) => index + 1,
    ).filter(
      (routeIndex) =>
        !slotRows.has(routeIndex),
    );

    return {
      baseQuoteId,
      desiredCount: normalizedDesiredCount,
      options,
      missingRouteIndexes,
    };
  }

  async getCustomerInfoForm(planId: number) {
 // Get plan details
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: planId },
      select: {
        itinerary_quote_ID: true,
        agent_id: true,
      },
    });

    if (!plan) {
      throw new BadRequestException('Itinerary plan not found');
    }

 // Get agent details plus company/city labels used by the dropdown.
    const [agent, agentConfig] = await Promise.all([
      this.prisma.dvi_agent.findUnique({
        where: { agent_ID: plan.agent_id },
        select: {
          agent_name: true,
          agent_lastname: true,
          agent_city: true,
          total_cash_wallet: true,
        },
      }),
      this.prisma.dvi_agent_configuration.findFirst({
        where: {
          agent_id: plan.agent_id,
          deleted: 0,
          status: 1,
        },
        select: {
          company_name: true,
        },
      }),
    ]);

    if (!agent) {
      throw new BadRequestException('Agent not found');
    }

    const city = agent.agent_city
      ? await this.prisma.dvi_cities.findUnique({
          where: { id: agent.agent_city },
          select: { name: true },
        })
      : null;

    const companyName = String(agentConfig?.company_name || '')
      .replace(/\s+/g, ' ')
      .trim();
    const rawAgentName = `${String(agent.agent_name || '').trim()} ${String(agent.agent_lastname || '').trim()}`.trim()
      || String(agent.agent_name || '').trim()
      || 'Agent';
    const cityName = String(city?.name || '')
      .replace(/\s+/g, ' ')
      .trim();
    const displayNameBase = companyName || rawAgentName;
    const agentDisplayName = cityName ? `${displayNameBase} - ${cityName}` : displayNameBase;

    const walletInfo = await this.getAgentWalletBalance(plan.agent_id);
    const walletBalance = Number(walletInfo.balance || 0);
    const formattedBalance = walletBalance.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

    return {
      quotation_no: plan.itinerary_quote_ID || '',
      agent_name: rawAgentName,
      agent_display_name: agentDisplayName,
      agent_id: plan.agent_id,
      wallet_balance: formattedBalance,
      balance_sufficient: walletBalance > 0,
    };
  }

  async checkWalletBalance(agentId: number) {
    const agent = await this.prisma.dvi_agent.findUnique({
      where: { agent_ID: agentId },
      select: { agent_ID: true },
    });

    if (!agent) {
      throw new BadRequestException('Agent not found');
    }

    const walletInfo = await this.getAgentWalletBalance(agentId);
    const balance = Number(walletInfo.balance || 0);
    const formattedBalance = `₹ ${balance.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

    return {
      balance,
      formatted_balance: formattedBalance,
      is_sufficient: balance > 0,
    };
  }

  async getAgentWalletBalance(agentId: number) {
    const agent = await this.prisma.dvi_agent.findUnique({
      where: { agent_ID: agentId },
      select: {
        agent_ID: true,
        total_cash_wallet: true,
      },
    });

    if (!agent) {
      return { balance: 0 };
    }

    const storedBalance = Number(agent.total_cash_wallet ?? 0);
    if (storedBalance > 0) {
      return { balance: storedBalance };
    }

    const cashRows = await this.prisma.dvi_cash_wallet.findMany({
      where: {
        agent_id: agentId,
        deleted: 0,
      },
      select: {
        transaction_amount: true,
        transaction_type: true,
      },
    });

    const balance = cashRows.reduce((sum, row) => {
      const amount = Number(row.transaction_amount || 0);
      const rawType = String(row.transaction_type ?? '').trim().toLowerCase();
      const numericType = Number(row.transaction_type ?? 0);
      const isDebit = rawType === 'debit' || numericType === 2;
      const isCredit = rawType === 'credit' || numericType === 1 || numericType === 0;

      if (isDebit) {
        return sum - Math.abs(amount);
      }

      if (isCredit) {
        return sum + Math.abs(amount);
      }

      return sum + amount;
    }, 0);

    return { balance };
  }

}

