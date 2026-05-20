import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import Razorpay from 'razorpay';
import * as crypto from 'crypto';
import { CreateWalletTopupOrderDto } from './dto/create-wallet-topup-order.dto';
import { CreateSubscriptionRenewalOrderDto } from './dto/create-subscription-renewal-order.dto';
import { CreateAgentRegistrationOrderDto } from './dto/create-agent-registration-order.dto';
import { ConfirmRazorpayPaymentDto } from './dto/confirm-razorpay-payment.dto';
import {
  isAuthorizedOrCaptured,
  resolveConfirmOutcome,
  validateGatewayAmountAndCurrency,
  verifyRazorpayPaymentSignature,
} from './payments.validation';
import { NormalizedPaymentResult, PAYMENT_FLOW, PAYMENT_STATUS, PaymentFlow } from './payments.types';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly razorpay: Razorpay;

  constructor(private readonly prisma: PrismaService) {
    this.razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }

  private getPublicKey(): string {
    const key = process.env.RAZORPAY_KEY_ID || '';
    if (!key) {
      throw new InternalServerErrorException('Razorpay key id is not configured');
    }
    return key;
  }

  private getSecretKey(): string {
    const secret = process.env.RAZORPAY_KEY_SECRET || '';
    if (!secret) {
      throw new InternalServerErrorException('Razorpay key secret is not configured');
    }
    return secret;
  }

  private getWebhookSecret(): string {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
    if (!secret) {
      throw new InternalServerErrorException('Razorpay webhook secret is not configured');
    }
    return secret;
  }

  private resolveAgentId(reqUser: any, explicitAgentId?: number): number {
    const agentId = Number(explicitAgentId || reqUser?.agentId || 0);
    if (!agentId) {
      throw new BadRequestException('Agent not found for payment flow');
    }
    return agentId;
  }

  private inrToPaise(value: number): number {
    const rounded = Math.round(Number(value) * 100);
    if (!Number.isFinite(rounded) || rounded <= 0) {
      throw new BadRequestException('Invalid amount provided');
    }
    return rounded;
  }

  private async createGatewayOrder(input: {
    amountPaise: number;
    flow: PaymentFlow;
    entityId: number;
    createdBy: number;
    planId?: number;
    metadata?: Record<string, unknown>;
  }) {
    const receipt = `dvi_${input.flow}_${input.entityId}_${Date.now()}`;

    let order: any;
    try {
      order = await this.razorpay.orders.create({
        amount: input.amountPaise,
        currency: 'INR',
        receipt,
        notes: {
          flow: input.flow,
          entityId: String(input.entityId),
          planId: input.planId ? String(input.planId) : '',
        },
      });
    } catch (error: any) {
      const status = Number(error?.statusCode || 0);
      const message =
        String(error?.error?.description || error?.message || 'Unable to create Razorpay order');

      this.logger.error(
        `Razorpay create order failed flow=${input.flow} status=${status} message=${message}`,
      );

      if (status === 401 || status === 403) {
        throw new BadRequestException('Razorpay authentication failed. Verify test key id/secret.');
      }

      throw new BadRequestException(`Razorpay order creation failed: ${message}`);
    }

    await this.prisma.dvi_payment_transaction.create({
      data: {
        flow_type: input.flow,
        entity_id: input.entityId,
        subscription_plan_id: input.planId ?? 0,
        amount_inr: input.amountPaise / 100,
        amount_paise: input.amountPaise,
        currency: 'INR',
        provider: 'razorpay',
        provider_order_id: order.id,
        receipt,
        status_code: PAYMENT_STATUS.PENDING,
        processed: 0,
        metadata: (input.metadata ?? {}) as any,
        createdby: input.createdBy,
        createdon: new Date(),
        updatedon: new Date(),
      },
    });

    this.logger.log(
      `Payment transition create_order flow=${input.flow} order=${order.id} amountPaise=${input.amountPaise}`,
    );

    return {
      id: order.id,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: this.getPublicKey(),
    };
  }

  async createWalletTopupOrder(dto: CreateWalletTopupOrderDto, userId: number, reqUser: any) {
    const agentId = this.resolveAgentId(reqUser, dto.agentId);
    const amountPaise = this.inrToPaise(dto.amountInInr);

    return this.createGatewayOrder({
      amountPaise,
      flow: PAYMENT_FLOW.WALLET_TOPUP,
      entityId: agentId,
      createdBy: userId,
      metadata: { source: 'wallet_topup' },
    });
  }

  async createSubscriptionRenewalOrder(
    dto: CreateSubscriptionRenewalOrderDto,
    userId: number,
    reqUser: any,
  ) {
    const agentId = this.resolveAgentId(reqUser, dto.agentId);

    const plan = await this.prisma.dvi_agent_subscription_plan.findUnique({
      where: { agent_subscription_plan_ID: dto.subscriptionPlanId },
    });

    if (!plan) {
      throw new BadRequestException('Subscription plan not found');
    }

    let totalAmountInr = Number(plan.subscription_amount || 0);
    if (dto.agentSubscribedPlanId) {
      const subscribedPlan = await this.prisma.dvi_agent_subscribed_plans.findUnique({
        where: { agent_subscribed_plan_ID: dto.agentSubscribedPlanId },
      });
      if (subscribedPlan) {
        totalAmountInr += Number(subscribedPlan.additional_staff_charge || 0);
      }
    }

    const amountPaise = this.inrToPaise(totalAmountInr);
    return this.createGatewayOrder({
      amountPaise,
      flow: PAYMENT_FLOW.SUBSCRIPTION_RENEWAL,
      entityId: agentId,
      planId: plan.agent_subscription_plan_ID,
      createdBy: userId,
      metadata: {
        source: 'subscription_renewal',
        agentSubscribedPlanId: dto.agentSubscribedPlanId ?? 0,
      },
    });
  }

  async createAgentRegistrationOrder(
    dto: CreateAgentRegistrationOrderDto,
    userId: number,
    _reqUser: any,
  ) {
    const plan = await this.prisma.dvi_agent_subscription_plan.findUnique({
      where: { agent_subscription_plan_ID: dto.subscriptionPlanId },
    });

    if (!plan) {
      throw new BadRequestException('Subscription plan not found');
    }

    const agent = await this.prisma.dvi_agent.findUnique({
      where: { agent_ID: dto.agentId },
      select: { agent_ID: true },
    });
    if (!agent) {
      throw new BadRequestException('Agent not found');
    }

    const amountPaise = this.inrToPaise(Number(plan.subscription_amount || 0));
    return this.createGatewayOrder({
      amountPaise,
      flow: PAYMENT_FLOW.AGENT_REGISTRATION_PAID,
      entityId: dto.agentId,
      planId: dto.subscriptionPlanId,
      createdBy: userId,
      metadata: {
        source: 'agent_registration_paid',
        referralAgentId: dto.referralAgentId ?? 0,
      },
    });
  }

  private async getPendingTransaction(orderId: string, flow: PaymentFlow) {
    const txn = await this.prisma.dvi_payment_transaction.findFirst({
      where: {
        provider_order_id: orderId,
        flow_type: flow,
        deleted: 0,
      },
      orderBy: { payment_transaction_ID: 'desc' },
    });

    if (!txn) {
      throw new BadRequestException('No pending transaction found for this order id');
    }
    return txn;
  }

  private async validateGatewayDataForTransaction(txn: any, orderId: string, paymentId: string) {
    const [order, payment] = await Promise.all([
      this.razorpay.orders.fetch(orderId),
      this.razorpay.payments.fetch(paymentId),
    ]);

    const expectedAmountPaise = Number(txn.amount_paise || 0);
    const expectedCurrency = String(txn.currency || 'INR');
    const validationContext = {
      flow: String(txn.flow_type || ''),
      txnId: Number(txn.payment_transaction_ID || 0),
      entityId: Number(txn.entity_id || 0),
      expectedAmountPaise,
      expectedCurrency,
      gatewayOrderAmountPaise: Number(order.amount || 0),
      gatewayOrderCurrency: String(order.currency || ''),
      gatewayOrderReceipt: String(order.receipt || ''),
      txnReceipt: String(txn.receipt || ''),
      gatewayPaymentAmountPaise: Number(payment.amount || 0),
      gatewayPaymentCurrency: String(payment.currency || ''),
      gatewayPaymentStatus: String(payment.status || ''),
      gatewayPaymentOrderId: String(payment.order_id || ''),
      requestedOrderId: String(orderId || ''),
      requestedPaymentId: String(paymentId || ''),
    };

    try {
      validateGatewayAmountAndCurrency({
        expectedAmountPaise,
        expectedCurrency,
        actualAmountPaise: Number(order.amount || 0),
        actualCurrency: String(order.currency || ''),
      });

      const paymentAmountPaise = Number(payment.amount || 0);
      const paymentCurrency = String(payment.currency || '');
      if (paymentCurrency !== expectedCurrency) {
        throw new BadRequestException(
          `Currency mismatch. expected=${expectedCurrency} actual=${paymentCurrency}`,
        );
      }

      if (paymentAmountPaise < expectedAmountPaise) {
        throw new BadRequestException(
          `Payment amount less than expected. expected=${expectedAmountPaise} actual=${paymentAmountPaise}`,
        );
      }

      const gatewayExtraPaise = paymentAmountPaise - expectedAmountPaise;
      if (gatewayExtraPaise > 0) {
        this.logger.warn(
          `Payment transition gateway_extra_amount flow=${validationContext.flow} order=${orderId} payment=${paymentId} extraPaise=${gatewayExtraPaise}`,
        );
      }

      if (String(order.receipt || '') !== String(txn.receipt || '')) {
        throw new BadRequestException('Razorpay order receipt mismatch');
      }

      if (String(payment.order_id || '') !== orderId) {
        throw new BadRequestException('Payment order id mismatch');
      }

      if (!isAuthorizedOrCaptured(payment.status)) {
        throw new BadRequestException(`Payment status is not authorized/captured: ${payment.status}`);
      }

      return { order, payment };
    } catch (error: any) {
      const message = String(error?.message || 'Payment gateway validation failed');
      this.logger.error(
        `Payment transition validation_failed flow=${validationContext.flow} order=${orderId} payment=${paymentId} reason=${message}`,
      );
      this.logger.error(`Payment transition validation_context ${JSON.stringify(validationContext)}`);
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(message);
    }
  }

  private async updateTransactionSuccess(txnId: number, paymentId: string, signature: string) {
    await this.prisma.dvi_payment_transaction.update({
      where: { payment_transaction_ID: txnId },
      data: {
        provider_payment_id: paymentId,
        provider_signature: signature,
        status_code: PAYMENT_STATUS.SUCCESS,
        updatedon: new Date(),
      },
    });
  }

  private async updateTransactionFailed(txnId: number, errorMessage: string) {
    await this.prisma.dvi_payment_transaction.update({
      where: { payment_transaction_ID: txnId },
      data: {
        status_code: PAYMENT_STATUS.FAILED,
        error_message: errorMessage,
        updatedon: new Date(),
      },
    });
  }

  private async applyWalletTopup(tx: any, txn: any, paymentId: string) {
    const duplicateWallet = await tx.dvi_cash_wallet.findFirst({
      where: { transaction_id: paymentId, deleted: 0 },
      select: { cash_wallet_ID: true },
    });
    if (duplicateWallet) {
      return;
    }

    const amountInInr = Number(txn.amount_inr || 0);
    await tx.dvi_cash_wallet.create({
      data: {
        agent_id: txn.entity_id,
        transaction_date: new Date(),
        transaction_amount: amountInInr,
        transaction_type: 1,
        transaction_id: paymentId,
        remarks: 'Self Top Up',
        createdby: txn.createdby || 0,
        createdon: new Date(),
        status: 1,
        deleted: 0,
      },
    });

    await tx.dvi_agent.update({
      where: { agent_ID: txn.entity_id },
      data: {
        total_cash_wallet: {
          increment: amountInInr,
        },
      },
    });
  }

  private async applySubscriptionRenewal(tx: any, txn: any, paymentId: string) {
    const duplicateSub = await tx.dvi_agent_subscribed_plans.findFirst({
      where: { transaction_id: paymentId, deleted: 0 },
      select: { agent_subscribed_plan_ID: true },
    });
    if (duplicateSub) {
      return;
    }

    const plan = await tx.dvi_agent_subscription_plan.findUnique({
      where: { agent_subscription_plan_ID: Number(txn.subscription_plan_id || 0) },
    });

    if (!plan) {
      throw new BadRequestException('Subscription plan not found during confirmation');
    }

    const validityDays = Number(plan.validity_in_days || 0);
    const validityStart = new Date();
    const validityEnd = new Date();
    validityEnd.setDate(validityEnd.getDate() + validityDays);

    await tx.dvi_agent_subscribed_plans.create({
      data: {
        agent_ID: txn.entity_id,
        subscription_plan_ID: plan.agent_subscription_plan_ID,
        subscription_plan_title: plan.agent_subscription_plan_title,
        itinerary_allowed: plan.itinerary_allowed,
        subscription_type: plan.subscription_type,
        subscription_amount: Number(txn.amount_inr || 0),
        joining_bonus: plan.joining_bonus,
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
        createdby: txn.createdby || 0,
        createdon: new Date(),
      },
    });

    await tx.dvi_cash_wallet.create({
      data: {
        agent_id: txn.entity_id,
        transaction_date: new Date(),
        transaction_amount: Number(txn.amount_inr || 0),
        transaction_type: 1,
        transaction_id: paymentId,
        remarks: 'Agent Subscription Renewal',
        createdby: txn.createdby || 0,
        createdon: new Date(),
        status: 1,
        deleted: 0,
      },
    });

    await tx.dvi_agent.update({
      where: { agent_ID: txn.entity_id },
      data: {
        total_cash_wallet: {
          increment: Number(txn.amount_inr || 0),
        },
        subscription_plan_id: plan.agent_subscription_plan_ID,
      },
    });
  }

  private async applyAgentRegistrationPaid(tx: any, txn: any, paymentId: string) {
    const duplicateSub = await tx.dvi_agent_subscribed_plans.findFirst({
      where: { transaction_id: paymentId, deleted: 0 },
      select: { agent_subscribed_plan_ID: true },
    });
    if (duplicateSub) {
      return;
    }

    const plan = await tx.dvi_agent_subscription_plan.findUnique({
      where: { agent_subscription_plan_ID: Number(txn.subscription_plan_id || 0) },
    });

    if (!plan) {
      throw new BadRequestException('Subscription plan not found during registration confirmation');
    }

    const validityDays = Number(plan.validity_in_days || 0);
    const validityStart = new Date();
    const validityEnd = new Date();
    validityEnd.setDate(validityEnd.getDate() + validityDays);

    await tx.dvi_agent_subscribed_plans.create({
      data: {
        agent_ID: txn.entity_id,
        subscription_plan_ID: plan.agent_subscription_plan_ID,
        subscription_plan_title: plan.agent_subscription_plan_title,
        itinerary_allowed: plan.itinerary_allowed,
        subscription_type: plan.subscription_type,
        subscription_amount: Number(txn.amount_inr || 0),
        joining_bonus: plan.joining_bonus,
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
        createdby: txn.createdby || 0,
        createdon: new Date(),
      },
    });

    const joiningBonus = Number(plan.joining_bonus || 0);
    if (joiningBonus > 0) {
      await tx.dvi_coupon_wallet.create({
        data: {
          agent_id: txn.entity_id,
          transaction_date: new Date(),
          transaction_amount: joiningBonus,
          transaction_type: 1,
          remarks: 'Agent Paid Subscription Joining Bonus',
          createdby: txn.createdby || 0,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });
    }

    await tx.dvi_cash_wallet.create({
      data: {
        agent_id: txn.entity_id,
        transaction_date: new Date(),
        transaction_amount: Number(txn.amount_inr || 0),
        transaction_type: 1,
        transaction_id: paymentId,
        remarks: 'Agent Paid Subscription Transaction',
        createdby: txn.createdby || 0,
        createdon: new Date(),
        status: 1,
        deleted: 0,
      },
    });

    await tx.dvi_agent.update({
      where: { agent_ID: txn.entity_id },
      data: {
        total_coupon_wallet: {
          increment: joiningBonus,
        },
        total_cash_wallet: {
          increment: Number(txn.amount_inr || 0),
        },
        subscription_plan_id: plan.agent_subscription_plan_ID,
      },
    });

    const referralAgentId = Number((txn.metadata as any)?.referralAgentId || 0);
    if (referralAgentId > 0) {
      const referralBonusRaw = await this.prisma.dvi_global_settings.findFirst({
        where: { deleted: 0, status: 1 },
        select: { agent_referral_bonus_credit: true },
      });
      const referralBonus = Number(referralBonusRaw?.agent_referral_bonus_credit || 0);

      if (referralBonus > 0) {
        await tx.dvi_coupon_wallet.create({
          data: {
            agent_id: referralAgentId,
            transaction_date: new Date(),
            transaction_amount: referralBonus,
            transaction_type: 1,
            remarks: `Agent Referral Bonus Credit from Agent Id: ${txn.entity_id}`,
            createdby: txn.createdby || 0,
            createdon: new Date(),
            status: 1,
            deleted: 0,
          },
        });
        await tx.dvi_agent.update({
          where: { agent_ID: referralAgentId },
          data: {
            total_coupon_wallet: {
              increment: referralBonus,
            },
          },
        });
      }
    }
  }

  private async applyBusinessUpdates(flow: PaymentFlow, txn: any, paymentId: string) {
    await this.prisma.$transaction(async (tx) => {
      if (flow === PAYMENT_FLOW.WALLET_TOPUP) {
        await this.applyWalletTopup(tx, txn, paymentId);
      } else if (flow === PAYMENT_FLOW.SUBSCRIPTION_RENEWAL) {
        await this.applySubscriptionRenewal(tx, txn, paymentId);
      } else {
        await this.applyAgentRegistrationPaid(tx, txn, paymentId);
      }

      await tx.dvi_payment_transaction.update({
        where: { payment_transaction_ID: txn.payment_transaction_ID },
        data: {
          processed: 1,
          processed_on: new Date(),
          status_code: PAYMENT_STATUS.SUCCESS,
          updatedon: new Date(),
        },
      });
    });
  }

  private async confirmByFlow(
    flow: PaymentFlow,
    dto: ConfirmRazorpayPaymentDto,
    checkSignature: boolean,
  ): Promise<NormalizedPaymentResult> {
    this.logger.log(
      `Payment transition confirm_requested flow=${flow} order=${dto.razorpay_order_id} payment=${dto.razorpay_payment_id}`,
    );
    const txn = await this.getPendingTransaction(dto.razorpay_order_id, flow);

    if (checkSignature) {
      const signatureValid = verifyRazorpayPaymentSignature({
        orderId: dto.razorpay_order_id,
        paymentId: dto.razorpay_payment_id,
        signature: dto.razorpay_signature,
        secret: this.getSecretKey(),
      });

      if (!signatureValid) {
        this.logger.warn(
          `Payment transition signature_invalid flow=${flow} order=${dto.razorpay_order_id} payment=${dto.razorpay_payment_id}`,
        );
        await this.updateTransactionFailed(txn.payment_transaction_ID, 'Invalid signature');
        throw new BadRequestException('Invalid payment signature');
      }
    }

    await this.validateGatewayDataForTransaction(
      txn,
      dto.razorpay_order_id,
      dto.razorpay_payment_id,
    );

    await this.updateTransactionSuccess(
      txn.payment_transaction_ID,
      dto.razorpay_payment_id,
      dto.razorpay_signature,
    );

    const outcome = resolveConfirmOutcome({ alreadyProcessed: txn.processed === 1 });
    if (outcome.shouldApply) {
      await this.applyBusinessUpdates(flow, txn, dto.razorpay_payment_id);
      this.logger.log(
        `Payment transition confirmed flow=${flow} order=${dto.razorpay_order_id} payment=${dto.razorpay_payment_id}`,
      );
      return {
        success: true,
        status: 'processed',
        flow,
        orderId: dto.razorpay_order_id,
        paymentId: dto.razorpay_payment_id,
        message: 'Payment confirmed and business updates applied',
      };
    }

    this.logger.log(
      `Payment transition duplicate_confirm flow=${flow} order=${dto.razorpay_order_id} payment=${dto.razorpay_payment_id}`,
    );
    return {
      success: true,
      status: 'already_processed',
      flow,
      orderId: dto.razorpay_order_id,
      paymentId: dto.razorpay_payment_id,
      message: 'Payment already processed',
    };
  }

  async confirmWalletTopup(dto: ConfirmRazorpayPaymentDto) {
    return this.confirmByFlow(PAYMENT_FLOW.WALLET_TOPUP, dto, true);
  }

  async confirmSubscriptionRenewal(dto: ConfirmRazorpayPaymentDto) {
    return this.confirmByFlow(PAYMENT_FLOW.SUBSCRIPTION_RENEWAL, dto, true);
  }

  async confirmAgentRegistrationPaid(dto: ConfirmRazorpayPaymentDto) {
    return this.confirmByFlow(PAYMENT_FLOW.AGENT_REGISTRATION_PAID, dto, true);
  }

  async confirmByOrderLookup(dto: ConfirmRazorpayPaymentDto) {
    const txn = await this.prisma.dvi_payment_transaction.findFirst({
      where: {
        provider_order_id: dto.razorpay_order_id,
        deleted: 0,
      },
      orderBy: { payment_transaction_ID: 'desc' },
    });

    if (!txn) {
      throw new BadRequestException('Unknown payment order id');
    }

    return this.confirmByFlow(String(txn.flow_type) as PaymentFlow, dto, true);
  }

  async handleRazorpayWebhook(rawBody: string | Buffer, signature: string | undefined) {
    if (!signature) {
      throw new BadRequestException('Missing Razorpay webhook signature header');
    }

    const webhookSecret = this.getWebhookSecret();
    const computed = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    const isValid = computed === signature;
    if (!isValid) {
      throw new BadRequestException('Invalid Razorpay webhook signature');
    }

    const bodyText = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '{}');
    const event = JSON.parse(bodyText);
    const eventName = String(event?.event || '');

    if (eventName !== 'payment.captured' && eventName !== 'payment.failed') {
      return { success: true, ignored: true, event: eventName };
    }

    const entity = event?.payload?.payment?.entity;
    const orderId = String(entity?.order_id || '');
    const paymentId = String(entity?.id || '');
    if (!orderId || !paymentId) {
      throw new BadRequestException('Invalid webhook payload: missing payment/order id');
    }

    const txns = await this.prisma.dvi_payment_transaction.findMany({
      where: { provider_order_id: orderId, deleted: 0 },
      orderBy: { payment_transaction_ID: 'desc' },
      take: 1,
    });
    const txn = txns[0];
    if (!txn) {
      return { success: true, ignored: true, event: eventName, reason: 'unknown_order' };
    }

    if (eventName === 'payment.failed') {
      await this.updateTransactionFailed(txn.payment_transaction_ID, 'Razorpay webhook payment.failed');
      this.logger.warn(`Payment transition webhook_failed flow=${txn.flow_type} order=${orderId}`);
      return { success: true, event: eventName, status: 'marked_failed' };
    }

    const confirmDto: ConfirmRazorpayPaymentDto = {
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: '',
    };

    const flow = String(txn.flow_type) as PaymentFlow;
    const result = await this.confirmByFlow(flow, confirmDto, false);
    return { success: true, event: eventName, result };
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