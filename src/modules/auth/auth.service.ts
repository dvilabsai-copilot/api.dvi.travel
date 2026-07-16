// FILE: src/modules/auth/auth.service.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { EmailLoginOtpService } from './email-login-otp.service';
import {
  isBcryptPasswordHash,
  verifyLegacyPhpPassword,
} from '../../common/utils/password-migration.util';

const BCRYPT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
  private readonly prisma: PrismaService,
  private readonly jwt: JwtService,
  private readonly emailLoginOtp: EmailLoginOtpService,
) {}

  /**
   * Validate user against dvi_users table
   * - email param maps to dvi_users.useremail
   * - supports bcrypt and the legacy PHP PwdHash format during migration
   */
  async validateUser(email: string, password: string) {
    // Map email → useremail (Prisma model: dvi_users)
    const user = await this.prisma.dvi_users.findFirst({
      where: { useremail: email, deleted: 0 },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const storedHash = user.password ?? '';
    let ok = false;
    let shouldUpgradeLegacyHash = false;

    if (isBcryptPasswordHash(storedHash)) {
      // Compare the submitted password with the current bcrypt hash.
      try {
        ok = await bcrypt.compare(password, storedHash);
      } catch {
        ok = false;
      }
    } else if (verifyLegacyPhpPassword(password, storedHash)) {
      // PHP hashes cannot be decrypted. A successful legacy verification is
      // immediately upgraded using the submitted password.
      ok = true;
      shouldUpgradeLegacyHash = true;
    }

    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (shouldUpgradeLegacyHash) {
      const upgradedHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      // Only replace the hash if it is still the legacy value. This avoids
      // overwriting a password reset that happened concurrently.
      await this.prisma.dvi_users.updateMany({
        where: {
          userID: user.userID,
          password: storedHash,
        },
        data: { password: upgradedHash },
      });
    }

    return user;
  }

  /**
   * Login and issue JWT
   */
  async login(email: string, password: string) {
  const user = await this.validateUser(email, password);
  return this.buildLoginResponse(user);
}

async sendEmailLoginOtp(email: string) {
  const user = await this.prisma.dvi_users.findFirst({
    where: {
      useremail: String(email || '').trim(),
      deleted: 0,
    },
  });

  if (!user) {
    throw new UnauthorizedException('Invalid email address.');
  }

  return this.emailLoginOtp.createAndSendOtp(user.useremail);
}

async verifyEmailLoginOtp(email: string, otp: string) {
  const user = await this.prisma.dvi_users.findFirst({
    where: {
      useremail: String(email || '').trim(),
      deleted: 0,
    },
  });

  if (!user) {
    throw new UnauthorizedException('Invalid email address.');
  }

  await this.emailLoginOtp.verifyOtp(user.useremail, otp);

  return this.buildLoginResponse(user);
}

private async buildLoginResponse(user: any) {
  const userId = user.userID.toString();

  const payload = {
    sub: userId,
    email: user.useremail,
    role: user.roleID,
    agentId: user.agent_id,
    staffId: user.staff_id,
    guideId: user.guide_id,
  };

  const accessToken = await this.jwt.signAsync(payload);

  return {
    accessToken,
    user: {
      id: userId,
      email: user.useremail,
      role: user.roleID,
      agentId: user.agent_id,
      staffId: user.staff_id,
      guideId: user.guide_id,
      fullName: user.username ?? '',
    },
  };
}
}
