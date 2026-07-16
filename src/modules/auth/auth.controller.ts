// FILE: src/modules/auth/auth.controller.ts
import { Body, Controller, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { Public } from '../../auth/public.decorator';
import { LoginDto } from './dto/login.dto';
import { SendEmailLoginOtpDto } from './dto/send-email-login-otp.dto';
import { VerifyEmailLoginOtpDto } from './dto/verify-email-login-otp.dto';
import { SendRegistrationEmailOtpDto } from './dto/send-registration-email-otp.dto';
import { VerifyRegistrationEmailOtpDto } from './dto/verify-registration-email-otp.dto';
import { RegisterPartnerDto } from './dto/register-partner.dto';

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

  @ApiOperation({ summary: 'Submit a verified new travel partner registration' })
  @ApiBody({ type: RegisterPartnerDto })
  @Public()
  @Post('registration')
  registerPartner(@Body() body: RegisterPartnerDto) {
    return this.auth.registerPartner(body);
  }
}
