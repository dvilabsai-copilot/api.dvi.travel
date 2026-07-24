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

