import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { EmailLoginOtpService } from './email-login-otp.service';
import { PrismaService } from '../../prisma.service';
import { JwtStrategy } from '../../auth/jwt.strategy';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'supersecretjwtkey',
      signOptions: { expiresIn: process.env.JWT_EXPIRES_IN || '7d' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, EmailLoginOtpService, PrismaService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
