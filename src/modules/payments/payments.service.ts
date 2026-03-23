import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import Razorpay from 'razorpay';
import * as crypto from 'crypto';
import { CreateOrderDto } from './dto/create-order.dto';
import { VerifyPaymentDto } from './dto/verify-payment.dto';
import { CreateSubscriptionOrderDto } from './dto/create-subscription-order.dto';

@Injectable()
export class PaymentsService {
  private razorpay: any;

  constructor(private readonly prisma: PrismaService) {
    this.razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }

  async createOrder(dto: CreateOrderDto, userId: number) {
    const options = {
      amount: dto.amount * 100, // amount in the smallest currency unit (paise)
      currency: 'INR',
      receipt: `receipt_wallet_${userId}_${Date.now()}`,
      notes: {
        userId,
        type: 'wallet_topup',
      },
    };

    try {
      const order = await this.razorpay.orders.create(options);
      return {
        ...order,
        key: process.env.RAZORPAY_KEY_ID,
      };
    } catch (error) {
      throw new BadRequestException('Failed to create Razorpay order');
    }
  }

  async createSubscriptionOrder(dto: CreateSubscriptionOrderDto, userId: number, reqUser: any) {
    const agentId = Number(reqUser.agentId || 0);
    if (agentId === 0) {
      throw new BadRequestException('User is not an agent');
    }

    const plan = await this.prisma.dvi_agent_subscription_plan.findUnique({
      where: { agent_subscription_plan_ID: dto.planId },
    });

    if (!plan) {
      throw new BadRequestException('Subscription plan not found');
    }

    let totalAmount = plan.subscription_amount || 0;

    if (dto.agentSubscribedPlanId) {
      const subscribedPlan = await this.prisma.dvi_agent_subscribed_plans.findUnique({
        where: { agent_subscribed_plan_ID: dto.agentSubscribedPlanId },
      });
      if (subscribedPlan) {
        totalAmount += subscribedPlan.additional_staff_charge || 0;
      }
    }

    const options = {
      amount: Math.round(totalAmount * 100),
      currency: 'INR',
      receipt: `receipt_sub_${agentId}_${Date.now()}`,
      notes: {
        agentId,
        planId: dto.planId,
        agentSubscribedPlanId: dto.agentSubscribedPlanId || 0,
        type: 'subscription_renewal',
      },
    };

    try {
      const order = await this.razorpay.orders.create(options);
      return {
        ...order,
        key: process.env.RAZORPAY_KEY_ID,
      };
    } catch (error) {
      throw new BadRequestException('Failed to create Razorpay order');
    }
  }

  async verifyPayment(dto: VerifyPaymentDto, userId: number, reqUser: any) {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = dto;

    const body = razorpay_order_id + '|' + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
      .update(body.toString())
      .digest('hex');

    const isSignatureValid = expectedSignature === razorpay_signature;

    if (!isSignatureValid) {
      throw new BadRequestException('Invalid payment signature');
    }

    // Get order details from Razorpay to know what this payment was for
    const order = await this.razorpay.orders.fetch(razorpay_order_id);
    const type = order.notes?.type;

    if (type === 'subscription_renewal') {
      return this.handleSubscriptionPayment(order, razorpay_payment_id, userId);
    } else {
      return this.handleWalletPayment(order, razorpay_payment_id, userId, reqUser);
    }
  }

  private async handleWalletPayment(order: any, paymentId: string, userId: number, reqUser: any) {
    const agentId = Number(reqUser.agentId || 0);
    if (agentId === 0) {
      throw new BadRequestException('Agent not found');
    }

    const amountInInr = order.amount / 100;

    await this.prisma.$transaction(async (tx) => {
      // 1. Record in cash wallet
      await tx.dvi_cash_wallet.create({
        data: {
          agent_id: agentId,
          transaction_date: new Date(),
          transaction_amount: amountInInr,
          transaction_type: 1, // Credit
          transaction_id: paymentId,
          remarks: `Razorpay Topup: ${paymentId}`,
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });

      // 2. Update agent's total balance
      const agent = await tx.dvi_agent.findUnique({
        where: { agent_ID: agentId },
        select: { total_cash_wallet: true },
      });

      const newBalance = (Number(agent?.total_cash_wallet) || 0) + amountInInr;

      await tx.dvi_agent.update({
        where: { agent_ID: agentId },
        data: { total_cash_wallet: newBalance },
      });
    });

    return { success: true, message: 'Wallet topped up successfully', amount: amountInInr };
  }

  private async handleSubscriptionPayment(order: any, paymentId: string, userId: number) {
    const agentId = parseInt(order.notes.agentId);
    const planId = parseInt(order.notes.planId);
    const amount = order.amount / 100;

    const plan = await this.prisma.dvi_agent_subscription_plan.findUnique({
      where: { agent_subscription_plan_ID: planId },
    });

    if (!plan) throw new BadRequestException('Plan not found');

    const validityDays = parseInt(plan.validity_in_days || '365');
    const validityStart = new Date();
    const validityEnd = new Date();
    validityEnd.setDate(validityEnd.getDate() + validityDays);

    await this.prisma.$transaction(async (tx) => {
      // 1. Create subscribed plan record
      await tx.dvi_agent_subscribed_plans.create({
        data: {
          agent_ID: agentId,
          subscription_plan_ID: planId,
          subscription_plan_title: plan.agent_subscription_plan_title,
          itinerary_allowed: plan.itinerary_allowed,
          subscription_type: plan.subscription_type,
          subscription_amount: amount,
          admin_count: plan.admin_count,
          staff_count: plan.staff_count,
          additional_charge_for_per_staff: plan.additional_charge_for_per_staff,
          per_itinerary_cost: plan.per_itinerary_cost,
          validity_start: validityStart,
          validity_end: validityEnd,
          subscription_notes: plan.subscription_notes,
          subscription_payment_status: 1,
          transaction_id: paymentId,
          subscription_status: 1,
          status: 1,
          deleted: 0,
          createdby: userId,
          createdon: new Date(),
        },
      });

      // 2. Add to wallet history
      await tx.dvi_cash_wallet.create({
        data: {
          agent_id: agentId,
          transaction_date: new Date(),
          transaction_type: 1,
          transaction_amount: amount,
          remarks: 'Agent Subscription Renewal',
          transaction_id: paymentId,
          status: 1,
          createdby: userId,
          createdon: new Date(),
          deleted: 0,
        },
      });

      // 3. Update agent's wallet balance
      const agent = await tx.dvi_agent.findUnique({
        where: { agent_ID: agentId },
        select: { total_cash_wallet: true },
      });

      const newBalance = (Number(agent?.total_cash_wallet) || 0) + amount;

      await tx.dvi_agent.update({
        where: { agent_ID: agentId },
        data: { total_cash_wallet: newBalance },
      });
    });

    return { success: true, message: 'Subscription renewed successfully' };
  }

  async getWalletHistory(reqUser: any) {
    const agentId = Number(reqUser.agentId || 0);
    if (agentId === 0) {
      throw new BadRequestException('Agent not found');
    }

    return this.prisma.dvi_cash_wallet.findMany({
      where: {
        agent_id: agentId,
        deleted: 0,
      },
      orderBy: {
        transaction_date: 'desc',
      },
    });
  }

  async getCouponWalletHistory(reqUser: any) {
    const agentId = Number(reqUser.agentId || 0);
    if (agentId === 0) {
      throw new BadRequestException('Agent not found');
    }

    return this.prisma.dvi_coupon_wallet.findMany({
      where: {
        agent_id: agentId,
        deleted: 0,
      },
      orderBy: {
        transaction_date: 'desc',
      },
      select: {
        coupon_wallet_ID: true,
        agent_id: true,
        transaction_date: true,
        transaction_amount: true,
        transaction_type: true,
        remarks: true,
        createdon: true,
        status: true,
        deleted: true,
      },
    });
  }
}
