import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';

export type ItineraryViewer = {
  role?: unknown;
  roleID?: unknown;
  roleId?: unknown;
  agentId?: unknown;
  agent_id?: unknown;
  staffId?: unknown;
  staff_id?: unknown;
  guideId?: unknown;
  guide_id?: unknown;
};

export type ItineraryAccessDecision = {
  exists: boolean;
  allowed: boolean;
  redirectTo: string | null;
};

const LATEST_ITINERARIES_PATH = '/latest-itinerary';
const CONFIRMED_ITINERARIES_PATH = '/confirmed-itinerary';

@Injectable()
export class ItineraryAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async getPlanAccessDecision(
    planId: number,
    viewer?: ItineraryViewer,
  ): Promise<ItineraryAccessDecision> {
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: planId },
      select: {
        itinerary_plan_ID: true,
        agent_id: true,
        staff_id: true,
        quotation_status: true,
      },
    });

    if (!plan) {
      return { exists: false, allowed: false, redirectTo: null };
    }

    return this.decidePlanAccess(plan, viewer);
  }

  async getQuoteAccessDecision(
    quoteId: string,
    viewer?: ItineraryViewer,
  ): Promise<ItineraryAccessDecision> {
    const plan = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: {
        itinerary_quote_ID: String(quoteId).trim(),
        deleted: 0,
      },
      select: {
        itinerary_plan_ID: true,
        agent_id: true,
        staff_id: true,
        quotation_status: true,
      },
      orderBy: { itinerary_plan_ID: 'desc' },
    });

    if (!plan) {
      return { exists: false, allowed: false, redirectTo: null };
    }

    return this.decidePlanAccess(plan, viewer);
  }

  async getConfirmedPlanAccessDecision(
    confirmedPlanId: number,
    viewer?: ItineraryViewer,
  ): Promise<ItineraryAccessDecision> {
    const confirmedPlan = await this.prisma.dvi_confirmed_itinerary_plan_details.findUnique({
      where: { confirmed_itinerary_plan_ID: confirmedPlanId },
      select: { itinerary_plan_ID: true },
    });

    if (!confirmedPlan) {
      return { exists: false, allowed: false, redirectTo: null };
    }

    return this.getPlanAccessDecision(confirmedPlan.itinerary_plan_ID, viewer);
  }

  private redirectForQuotationStatus(quotationStatus: number): string {
    return Number(quotationStatus) === 1
      ? CONFIRMED_ITINERARIES_PATH
      : LATEST_ITINERARIES_PATH;
  }

  private async decidePlanAccess(
    plan: {
      agent_id: number;
      staff_id: number;
      quotation_status: number;
      itinerary_plan_ID: number;
    },
    viewer?: ItineraryViewer,
  ): Promise<ItineraryAccessDecision> {
    const allowed = await this.canViewPlan(plan, viewer);
    return {
      exists: true,
      allowed,
      redirectTo: allowed ? null : this.redirectForQuotationStatus(plan.quotation_status),
    };
  }

  private async canViewPlan(plan: {
    agent_id: number;
    staff_id: number;
    quotation_status: number;
    itinerary_plan_ID: number;
  }, viewer?: ItineraryViewer): Promise<boolean> {
    const role = Number(viewer?.roleID ?? viewer?.roleId ?? viewer?.role ?? 0) || 0;
    const agentId = Number(viewer?.agentId ?? viewer?.agent_id ?? 0) || 0;
    const staffId = Number(viewer?.staffId ?? viewer?.staff_id ?? 0) || 0;
    const guideId = Number(viewer?.guideId ?? viewer?.guide_id ?? 0) || 0;

    // Admin and Accounts retain their existing cross-Agent itinerary access.
    if (role === 1 || role === 6) {
      return true;
    }

    // Agent and Agent Staff access is always tied to the authenticated Agent.
    if (agentId > 0) {
      return Number(plan.agent_id) === agentId;
    }

    // Travel Expert access follows the same staff/assigned-Agent scope as lists.
    if ((role === 3 || role === 8) && staffId > 0) {
      if (Number(plan.staff_id) === staffId) {
        return true;
      }

      const assignedAgents = await this.prisma.dvi_agent.findMany({
        where: { travel_expert_id: staffId } as any,
        select: { agent_ID: true },
      });

      return assignedAgents.some(
        (agent) => Number(agent.agent_ID) === Number(plan.agent_id),
      );
    }

    // A Guide may view only confirmed plans assigned to that Guide.
    if (role === 5 && guideId > 0 && Number(plan.quotation_status) === 1) {
      const assignment = await this.prisma.dvi_confirmed_itinerary_route_guide_details.findFirst({
        where: {
          itinerary_plan_ID: plan.itinerary_plan_ID,
          guide_id: guideId,
          deleted: 0,
        },
        select: { confirmed_route_guide_ID: true },
      });

      return Boolean(assignment);
    }

    return false;
  }
}
