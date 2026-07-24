// FILE: src/modules/agent-subscription-plan/agent-subscription-plan.service.ts

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import {
  AgentSubscriptionPlanPayloadDto,
  SubscriptionTypeEnum,
} from './dto/agent-subscription-plan.dto';

@Injectable()
export class AgentSubscriptionPlanService {
  constructor(private readonly prisma: PrismaService) {}

 /** Helpers to map Free/Paid <-> legacy numeric subscription_type */
  private subscriptionTypeToInt(type: SubscriptionTypeEnum): number {
 // Adjust mapping if your legacy uses different codes.
 // Here: 0 = Free, 1 = Paid.
    return type === SubscriptionTypeEnum.Paid ? 1 : 0;
  }

  private intToSubscriptionType(v: number | null): SubscriptionTypeEnum {
    if (v === 1) return SubscriptionTypeEnum.Paid;
    return SubscriptionTypeEnum.Free;
  }

  private mapEntityToListItem(plan: any) {
    return {
      id: String(plan.agent_subscription_plan_ID),
      planTitle: plan.agent_subscription_plan_title ?? '',
      itineraryCount: plan.itinerary_allowed ?? 0,
      cost: plan.subscription_amount ?? 0,
      joiningBonus: plan.joining_bonus ?? 0,
      itineraryCost: plan.per_itinerary_cost ?? 0,
      validityDays: plan.validity_in_days ? Number(plan.validity_in_days) || 0 : 0,
      recommended: plan.recommended_status === 1,
      status: plan.status === 1 && plan.deleted === 0,
    };
  }

  private mapEntityToDetails(plan: any) {
    return {
      ...this.mapEntityToListItem(plan),
      type: this.intToSubscriptionType(plan.subscription_type ?? 0),
      adminCount: plan.admin_count ?? 0,
      staffCount: plan.staff_count ?? 0,
      additionalChargePerStaff: plan.additional_charge_for_per_staff ?? 0,
      notes: plan.subscription_notes ?? '',
    };
  }

  async findAll() {
    const rows = await this.prisma.dvi_agent_subscription_plan.findMany({
      where: { deleted: 0 },
      orderBy: { agent_subscription_plan_ID: 'desc' },
    });

    return rows.map((p) => this.mapEntityToListItem(p));
  }

  async findOne(id: number) {
    const plan = await this.prisma.dvi_agent_subscription_plan.findFirst({
      where: { agent_subscription_plan_ID: id, deleted: 0 },
    });

    if (!plan) {
      throw new NotFoundException('Agent subscription plan not found');
    }

    return this.mapEntityToDetails(plan);
  }

  async create(payload: AgentSubscriptionPlanPayloadDto, userId?: number) {
    const now = new Date();

    const created = await this.prisma.dvi_agent_subscription_plan.create({
      data: {
        agent_subscription_plan_title: payload.planTitle,
        subscription_type: this.subscriptionTypeToInt(payload.type),
        subscription_amount: payload.cost,
        itinerary_allowed: payload.itineraryCount,
        per_itinerary_cost: payload.itineraryCost,
        joining_bonus: payload.joiningBonus,
        validity_in_days: String(payload.validityDays),
        admin_count: payload.adminCount,
        staff_count: payload.staffCount,
        additional_charge_for_per_staff: payload.additionalChargePerStaff,
        subscription_notes: payload.notes ?? '',
        recommended_status: 0,
        createdby: userId ?? 0,
        createdon: now,
        updatedon: now,
        status: 1,
        deleted: 0,
      },
    });

    return { id: String(created.agent_subscription_plan_ID) };
  }

  async update(id: number, payload: AgentSubscriptionPlanPayloadDto, userId?: number) {
    const now = new Date();

    const existing = await this.prisma.dvi_agent_subscription_plan.findFirst({
      where: { agent_subscription_plan_ID: id, deleted: 0 },
    });

    if (!existing) {
      throw new NotFoundException('Agent subscription plan not found');
    }

    await this.prisma.dvi_agent_subscription_plan.update({
      where: { agent_subscription_plan_ID: id },
      data: {
        agent_subscription_plan_title: payload.planTitle,
        subscription_type: this.subscriptionTypeToInt(payload.type),
        subscription_amount: payload.cost,
        itinerary_allowed: payload.itineraryCount,
        per_itinerary_cost: payload.itineraryCost,
        joining_bonus: payload.joiningBonus,
        validity_in_days: String(payload.validityDays),
        admin_count: payload.adminCount,
        staff_count: payload.staffCount,
        additional_charge_for_per_staff: payload.additionalChargePerStaff,
        subscription_notes: payload.notes ?? '',
        updatedon: now,
 // keep createdby/createdon as-is
      },
    });

    return { ok: true as const };
  }

  async remove(id: number, userId?: number) {
    const now = new Date();

    const existing = await this.prisma.dvi_agent_subscription_plan.findFirst({
      where: { agent_subscription_plan_ID: id, deleted: 0 },
    });

    if (!existing) {
      throw new NotFoundException('Agent subscription plan not found');
    }

 // Soft delete to mirror legacy: deleted = 1, status = 0
    await this.prisma.dvi_agent_subscription_plan.update({
      where: { agent_subscription_plan_ID: id },
      data: {
        deleted: 1,
        status: 0,
        updatedon: now,
      },
    });

    return { ok: true as const };
  }

  async updateStatus(id: number, status: boolean, userId?: number) {
    const now = new Date();

    const existing = await this.prisma.dvi_agent_subscription_plan.findFirst({
      where: { agent_subscription_plan_ID: id, deleted: 0 },
    });

    if (!existing) {
      throw new NotFoundException('Agent subscription plan not found');
    }

    await this.prisma.dvi_agent_subscription_plan.update({
      where: { agent_subscription_plan_ID: id },
      data: {
        status: status ? 1 : 0,
        updatedon: now,
      },
    });

    return { ok: true as const };
  }

  async updateRecommended(id: number, recommended: boolean, userId?: number) {
    const now = new Date();

    const existing = await this.prisma.dvi_agent_subscription_plan.findFirst({
      where: { agent_subscription_plan_ID: id, deleted: 0 },
    });

    if (!existing) {
      throw new NotFoundException('Agent subscription plan not found');
    }

 // Simple toggle: do NOT reset other plans here (matches flexible PHP behaviour).
    await this.prisma.dvi_agent_subscription_plan.update({
      where: { agent_subscription_plan_ID: id },
      data: {
        recommended_status: recommended ? 1 : 0,
        updatedon: now,
      },
    });

    return { ok: true as const };
  }
}
