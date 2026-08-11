import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { SystemRole, getRoleId } from '../../auth/constants/system-role.constants';
import {
  VEHICLE_ONLY_PREFERENCE,
  assertVehicleAgentHotelMutation,
  assertVehicleAgentPlanAccess,
} from '../policies/vehicle-agent.policy';

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
  vendorId?: unknown;
  vendor_id?: unknown;
};

export type ItineraryAccessDecision = {
  exists: boolean;
  allowed: boolean;
  redirectTo: string | null;
};

export type ItineraryPlanAccessSnapshot = {
  itinerary_plan_ID: number;
  agent_id: number;
  staff_id: number;
  quotation_status: number;
  itinerary_preference: number;
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
        itinerary_preference: true,
      },
    });

    if (!plan) return { exists: false, allowed: false, redirectTo: null };
    return this.decidePlanAccess(plan, viewer);
  }

  async getQuoteAccessDecision(
    quoteId: string,
    viewer?: ItineraryViewer,
  ): Promise<ItineraryAccessDecision> {
    const plan = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_quote_ID: String(quoteId).trim(), deleted: 0 },
      select: {
        itinerary_plan_ID: true,
        agent_id: true,
        staff_id: true,
        quotation_status: true,
        itinerary_preference: true,
      },
      orderBy: { itinerary_plan_ID: 'desc' },
    });

    if (!plan) return { exists: false, allowed: false, redirectTo: null };
    return this.decidePlanAccess(plan, viewer);
  }

  async getConfirmedPlanAccessDecision(
    confirmedPlanId: number,
    viewer?: ItineraryViewer,
  ): Promise<ItineraryAccessDecision> {
    const confirmedPlan =
      await this.prisma.dvi_confirmed_itinerary_plan_details.findUnique({
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
    plan: ItineraryPlanAccessSnapshot,
    viewer?: ItineraryViewer,
  ): Promise<ItineraryAccessDecision> {
    const allowed = await this.canViewPlan(plan, viewer);

    return {
      exists: true,
      allowed,
      redirectTo: allowed
        ? null
        : this.redirectForQuotationStatus(plan.quotation_status),
    };
  }

  private async canViewPlan(
    plan: ItineraryPlanAccessSnapshot,
    viewer?: ItineraryViewer,
  ): Promise<boolean> {
    const role = getRoleId(viewer);
const agentId = Number(viewer?.agentId ?? viewer?.agent_id ?? 0) || 0;
const staffId = Number(viewer?.staffId ?? viewer?.staff_id ?? 0) || 0;
const guideId = Number(viewer?.guideId ?? viewer?.guide_id ?? 0) || 0;
const vendorId = Number(viewer?.vendorId ?? viewer?.vendor_id ?? 0) || 0;

// This check must happen before the generic agentId branch.
if (role === SystemRole.VEHICLE_AGENT) {
  return agentId > 0 &&
    Number(plan.agent_id) === agentId &&
    Number(plan.itinerary_preference) === VEHICLE_ONLY_PREFERENCE;
}

if (role === SystemRole.VENDOR) {
  if (
    vendorId <= 0 ||
    Number(plan.quotation_status) !== 1
  ) {
    return false;
  }

  const assignment =
    await this.prisma.dvi_confirmed_itinerary_plan_vendor_eligible_list.findFirst({
      where: {
        itinerary_plan_id: Number(plan.itinerary_plan_ID),
        vendor_id: vendorId,
        itineary_plan_assigned_status: 1,
        status: 1,
        deleted: 0,
      },
      select: {
        itinerary_plan_id: true,
      },
    });

  return Boolean(assignment);
}

if (role === SystemRole.ADMIN || role === SystemRole.ACCOUNTS) return true;
    if (agentId > 0) return Number(plan.agent_id) === agentId;

    if ((role === SystemRole.STAFF || role === SystemRole.TRAVEL_EXPERT) && staffId > 0) {
      if (Number(plan.staff_id) === staffId) return true;

      const assignedAgents = await this.prisma.dvi_agent.findMany({
        where: { travel_expert_id: staffId } as any,
        select: { agent_ID: true },
      });

      return assignedAgents.some(
        (agent) => Number(agent.agent_ID) === Number(plan.agent_id),
      );
    }

    if (role === SystemRole.GUIDE && guideId > 0 && Number(plan.quotation_status) === 1) {
      const assignment =
        await this.prisma.dvi_confirmed_itinerary_route_guide_details.findFirst({
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

  async getPlanSnapshot(planId: number): Promise<ItineraryPlanAccessSnapshot | null> {
    return this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: planId },
      select: {
        itinerary_plan_ID: true,
        agent_id: true,
        staff_id: true,
        quotation_status: true,
        itinerary_preference: true,
      },
    }) as any;
  }

  async assertCanViewPlan(planId: number, viewer?: ItineraryViewer): Promise<void> {
    const decision = await this.getPlanAccessDecision(planId, viewer);
    if (!decision.exists || !decision.allowed) {
      throw new ForbiddenException({
        message: 'You are not allowed to access this itinerary.',
        redirectTo: decision.redirectTo || LATEST_ITINERARIES_PATH,
      });
    }
  }

  async assertCanEditPlan(planId: number, viewer?: ItineraryViewer): Promise<void> {
    await this.assertCanViewPlan(planId, viewer);
    const snapshot = await this.getPlanSnapshot(planId);
    if (!snapshot) throw new ForbiddenException('You are not allowed to edit this itinerary.');
    assertVehicleAgentPlanAccess(viewer, snapshot);
  }

  assertVehicleAgentHotelMutation(viewer?: ItineraryViewer): void {
    assertVehicleAgentHotelMutation(viewer);
  }
}
