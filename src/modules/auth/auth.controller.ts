// FILE: src/modules/auth/auth.controller.ts
import { Body, Controller, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { Public } from '../../auth/public.decorator';
import { LoginDto } from './dto/login.dto';
import { SendEmailLoginOtpDto } from './dto/send-email-login-otp.dto';
import { VerifyEmailLoginOtpDto } from './dto/verify-email-login-otp.dto';

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
}
