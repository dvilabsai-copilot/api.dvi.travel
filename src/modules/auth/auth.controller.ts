// FILE: src/modules/auth/auth.controller.ts
import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { Public } from '../../auth/public.decorator';
import { LoginDto } from './dto/login.dto';
import { SendEmailLoginOtpDto } from './dto/send-email-login-otp.dto';
import { VerifyEmailLoginOtpDto } from './dto/verify-email-login-otp.dto';
import { SendRegistrationEmailOtpDto } from './dto/send-registration-email-otp.dto';
import { VerifyRegistrationEmailOtpDto } from './dto/verify-registration-email-otp.dto';
import { RegisterPartnerDto } from './dto/register-partner.dto';
import { ActivatePartnerDto } from './dto/activate-partner.dto';
import { RedeemLegacySsoTicketDto } from './dto/legacy-sso.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @ApiOperation({ summary: 'Login and receive JWT' })
  @ApiBody({ type: LoginDto })
  @Public()
  @Post('login')
  login(@Body() body: LoginDto) {
    return this.auth.login(body.email, body.password);
  }

  @ApiOperation({
    summary: 'Create a short-lived ticket for legacy B2B sign-in',
  })
  @Post('legacy-sso/ticket')
  createLegacySsoTicket(@Req() req: any) {
    return this.auth.createLegacySsoTicket(req.user?.userId);
  }

  @ApiOperation({
    summary: 'Redeem a legacy B2B sign-in ticket',
  })
  @ApiBody({ type: RedeemLegacySsoTicketDto })
  @Public()
  @Post('legacy-sso/redeem')
  redeemLegacySsoTicket(
    @Body() body: RedeemLegacySsoTicketDto,
    @Headers('x-legacy-sso-secret') secret?: string,
  ) {
    return this.auth.redeemLegacySsoTicket(
      body.ticket,
      secret,
    );
  }
  @ApiOperation({ summary: 'Send email OTP for login' })
@ApiBody({ type: SendEmailLoginOtpDto })
@Public()
@Post('email-login/send-otp')
sendEmailLoginOtp(@Body() body: SendEmailLoginOtpDto) {
  return this.auth.sendEmailLoginOtp(body.email);
}

@ApiOperation({ summary: 'Verify email OTP and receive JWT' })
@ApiBody({ type: VerifyEmailLoginOtpDto })
@Public()
@Post('email-login/verify-otp')
  verifyEmailLoginOtp(@Body() body: VerifyEmailLoginOtpDto) {
    return this.auth.verifyEmailLoginOtp(body.email, body.otp);
  }

  @ApiOperation({ summary: 'Send email OTP for new partner registration' })
  @ApiBody({ type: SendRegistrationEmailOtpDto })
  @Public()
  @Post('registration/email/send-otp')
  sendRegistrationEmailOtp(@Body() body: SendRegistrationEmailOtpDto) {
    return this.auth.sendRegistrationEmailOtp(body.email);
  }

  @ApiOperation({ summary: 'Verify registration email OTP' })
  @ApiBody({ type: VerifyRegistrationEmailOtpDto })
  @Public()
  @Post('registration/email/verify-otp')
  verifyRegistrationEmailOtp(@Body() body: VerifyRegistrationEmailOtpDto) {
    return this.auth.verifyRegistrationEmailOtp(body.email, body.otp);
  }

  @ApiOperation({
    summary:
      'Submit a verified new travel partner registration',
  })
  @ApiBody({
    type: RegisterPartnerDto,
  })
  @Public()
  @Post('registration')
  registerPartner(
    @Body() body: RegisterPartnerDto,
  ) {
    return this.auth.registerPartner(
      body,
    );
  }

  @ApiOperation({
    summary:
      'Activate a registered partner and receive JWT',
  })
  @ApiBody({
    type: ActivatePartnerDto,
  })
  @Public()
  @Post('registration/activate')
  activatePartner(
    @Body() body: ActivatePartnerDto,
  ) {
    return this.auth.activatePartner(
      body.token,
    );
  }

  @ApiOperation({
    summary:
      'Resend partner account activation email',
  })
  @ApiBody({
    type: SendRegistrationEmailOtpDto,
  })
  @Public()
  @Post(
    'registration/resend-activation',
  )
   resendPartnerActivation(
    @Body()
    body: SendRegistrationEmailOtpDto,
  ) {
    return this.auth
      .resendPartnerActivation(
        body.email,
      );
  }

  @ApiOperation({
    summary:
      'Change password for the authenticated Agent',
  })
  @Post('change-password')
  changePassword(
    @Req() req: any,
    @Body()
    body: {
      currentPassword: string;
      newPassword: string;
      confirmPassword: string;
    },
  ) {
    const role = Number(
      req.user?.roleID ??
        req.user?.role ??
        0,
    );

    if (role !== 4) {
      throw new ForbiddenException(
        'Only agents can change their password here',
      );
    }

    return this.auth.changePassword(
      req.user.userId,
      body.currentPassword,
      body.newPassword,
      body.confirmPassword,
    );
  }
}
