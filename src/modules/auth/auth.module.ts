import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { EmailLoginOtpService } from './email-login-otp.service';
import { PartnerActivationService } from './partner-activation.service';
import { PrismaService } from '../../prisma.service';
import { JwtStrategy } from '../../auth/jwt.strategy';
import { ImpersonationController } from './impersonation.controller';
import { ImpersonationService } from './impersonation.service';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret:
        process.env.JWT_SECRET ||
        'supersecretjwtkey',
      signOptions: {
        expiresIn:
          process.env.JWT_EXPIRES_IN ||
          '7d',
      },
    }),
  ],
  controllers: [AuthController, ImpersonationController],
  providers: [
    AuthService,
    EmailLoginOtpService,
    PartnerActivationService,
    PrismaService,
    JwtStrategy,
    ImpersonationService,
  ],
  exports: [AuthService, ImpersonationService],
})
export class AuthModule {}
