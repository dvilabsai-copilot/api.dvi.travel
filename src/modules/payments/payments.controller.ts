import { Controller, Post, Body, UseGuards, Req, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { VerifyPaymentDto } from './dto/verify-payment.dto';
import { CreateSubscriptionOrderDto } from './dto/create-subscription-order.dto';
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
  @Post('create-order')
  @ApiOperation({ summary: 'Create a Razorpay order for wallet topup' })
  async createOrder(@Body() dto: CreateOrderDto, @Req() req: any) {
    return this.paymentsService.createOrder(dto, Number(req.user.userId));
  }

  @UseGuards(JwtAuthGuard)
  @Post('create-subscription-order')
  @ApiOperation({ summary: 'Create a Razorpay order for subscription renewal' })
  async createSubscriptionOrder(@Body() dto: CreateSubscriptionOrderDto, @Req() req: any) {
    return this.paymentsService.createSubscriptionOrder(dto, Number(req.user.userId), req.user);
  }

  @UseGuards(JwtAuthGuard)
  @Post('verify-payment')
  @ApiOperation({ summary: 'Verify a Razorpay payment signature' })
  async verifyPayment(@Body() dto: VerifyPaymentDto, @Req() req: any) {
    return this.paymentsService.verifyPayment(dto, Number(req.user.userId), req.user);
  }
}