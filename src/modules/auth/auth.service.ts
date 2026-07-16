// FILE: src/modules/auth/auth.service.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Validate user against dvi_users table
   * - email param maps to dvi_users.useremail
   * - password in DB is a bcrypt hash
   */
  async validateUser(email: string, password: string) {
    // Map email → useremail (Prisma model: dvi_users)
    const user = await this.prisma.dvi_users.findFirst({
      where: { useremail: email, deleted: 0 },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // bcrypt-compare plain password vs stored hash
    const ok =
      user.password != null && user.password !== ''
        ? await bcrypt.compare(password, user.password)
        : false;

    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return user;
  }

  /**
   * Login and issue JWT
   */
  async login(email: string, password: string) {
    const user = await this.validateUser(email, password);
    // userID is BigInt in Prisma → convert to string for JWT
    const userId = user.userID.toString();

    const payload = {
      sub: userId,
      email: user.useremail,
      role: user.roleID, // numeric roleID from dvi_users
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
        fullName: user.username ?? '', // map from username field
      },
    };
  }
}
