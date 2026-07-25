import { Controller, Post, Body, UseGuards, Req, Get, Headers } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { CreateWalletTopupOrderDto } from './dto/create-wallet-topup-order.dto';
import { CreateSubscriptionRenewalOrderDto } from './dto/create-subscription-renewal-order.dto';
import { CreateAgentRegistrationOrderDto } from './dto/create-agent-registration-order.dto';
import { ConfirmRazorpayPaymentDto } from './dto/confirm-razorpay-payment.dto';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';

@ApiTags('Payments')
@ApiBearerAuth()
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @UseGuards(JwtAuthGuard)
  @Get('wallet-history')
  @ApiOperation({ summary: 'Get agent cash wallet transaction history' })
  async getWalletHistory(@Req() req: any) {
    return this.paymentsService.getWalletHistory(req.user);
  }

  @UseGuards(JwtAuthGuard)
  @Get('coupon-wallet-history')
  @ApiOperation({ summary: 'Get agent coupon wallet transaction history' })
  async getCouponWalletHistory(@Req() req: any) {
    return this.paymentsService.getCouponWalletHistory(req.user);
  }

  @UseGuards(JwtAuthGuard)
  @Post('razorpay/wallet-topup/create-order')
  @ApiOperation({ summary: 'Create Razorpay order for wallet top-up' })
  async createWalletTopupOrder(@Body() dto: CreateWalletTopupOrderDto, @Req() req: any) {
    return this.paymentsService.createWalletTopupOrder(dto, Number(req.user.userId), req.user);
  }

  @UseGuards(JwtAuthGuard)
  @Post('razorpay/subscription-renewal/create-order')
  @ApiOperation({ summary: 'Create Razorpay order for subscription renewal' })
  async createSubscriptionRenewalOrder(@Body() dto: CreateSubscriptionRenewalOrderDto, @Req() req: any) {
    return this.paymentsService.createSubscriptionRenewalOrder(dto, Number(req.user.userId), req.user);
  }

  @UseGuards(JwtAuthGuard)
  @Post('razorpay/agent-registration/create-order')
  @ApiOperation({ summary: 'Create Razorpay order for paid agent registration plan' })
  async createAgentRegistrationOrder(@Body() dto: CreateAgentRegistrationOrderDto, @Req() req: any) {
    return this.paymentsService.createAgentRegistrationOrder(dto, Number(req.user.userId), req.user);
  }

  @UseGuards(JwtAuthGuard)
  @Post('razorpay/wallet-topup/confirm')
  @ApiOperation({ summary: 'Confirm Razorpay wallet top-up payment' })
  async confirmWalletTopup(@Body() dto: ConfirmRazorpayPaymentDto) {
    return this.paymentsService.confirmWalletTopup(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('razorpay/subscription-renewal/confirm')
  @ApiOperation({ summary: 'Confirm Razorpay subscription renewal payment' })
  async confirmSubscriptionRenewal(@Body() dto: ConfirmRazorpayPaymentDto) {
    return this.paymentsService.confirmSubscriptionRenewal(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('razorpay/agent-registration/confirm')
  @ApiOperation({ summary: 'Confirm Razorpay paid agent registration payment' })
  async confirmAgentRegistration(@Body() dto: ConfirmRazorpayPaymentDto) {
    return this.paymentsService.confirmAgentRegistrationPaid(dto);
  }

  @Post('razorpay/webhook')
  @ApiOperation({ summary: 'Razorpay webhook for payment.captured/payment.failed reconciliation' })
  async razorpayWebhook(
    @Body() body: any,
    @Headers('x-razorpay-signature') signature?: string,
  ) {
    const rawBody = typeof body === 'string' ? body : JSON.stringify(body || {});
    return this.paymentsService.handleRazorpayWebhook(rawBody, signature);
  }

 // Backward-compatible endpoints currently used by parts of the frontend.
  @UseGuards(JwtAuthGuard)
  @Post('create-order')
  async createOrderCompat(@Body() dto: { amount: number }, @Req() req: any) {
    return this.paymentsService.createWalletTopupOrder(
      { amountInInr: Number(dto.amount || 0) },
      Number(req.user.userId),
      req.user,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('create-subscription-order')
  async createSubscriptionOrderCompat(
    @Body() dto: { planId: number; agentSubscribedPlanId?: number },
    @Req() req: any,
  ) {
    return this.paymentsService.createSubscriptionRenewalOrder(
      {
        subscriptionPlanId: Number(dto.planId || 0),
        agentSubscribedPlanId: dto.agentSubscribedPlanId,
      },
      Number(req.user.userId),
      req.user,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('verify-payment')
  async verifyPaymentCompat(@Body() dto: ConfirmRazorpayPaymentDto) {
    return this.paymentsService.confirmByOrderLookup(dto);
  }
}