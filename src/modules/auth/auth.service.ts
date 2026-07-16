import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma.service';
import {
  isBcryptPasswordHash,
  verifyLegacyPhpPassword,
} from '../../common/utils/password-migration.util';
import { EmailLoginOtpService } from './email-login-otp.service';
import { RegisterPartnerDto } from './dto/register-partner.dto';

const BCRYPT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly emailLoginOtp: EmailLoginOtpService,
  ) {}

  private normalizeEmail(email: string) {
    return String(email || '').trim().toLowerCase();
  }

  /** Finds legacy rows as well as new rows with normalized email matching. */
  private async findActiveUserByEmail(email: string) {
    const normalizedEmail = this.normalizeEmail(email);
    const rows = await this.prisma.$queryRaw<Array<{ userID: bigint }>>`
      SELECT userID
      FROM dvi_users
      WHERE LOWER(TRIM(useremail)) = ${normalizedEmail}
        AND deleted = 0
      ORDER BY userID ASC
      LIMIT 1
    `;

    if (!rows[0]) return null;

    return this.prisma.dvi_users.findUnique({
      where: { userID: rows[0].userID },
    });
  }

  private async findActiveAgentByEmail(email: string) {
    const normalizedEmail = this.normalizeEmail(email);
    const rows = await this.prisma.$queryRaw<Array<{ agent_ID: number }>>`
      SELECT agent_ID
      FROM dvi_agent
      WHERE LOWER(TRIM(agent_email_id)) = ${normalizedEmail}
        AND deleted = 0
      ORDER BY agent_ID ASC
      LIMIT 1
    `;

    return rows[0] || null;
  }

  private assertLoginAllowed(user: any) {
    const statusIsInactive =
      user.status !== undefined && user.status !== null && Number(user.status) === 0;

    if (Number(user.userbanned || 0) === 1 || statusIsInactive) {
      throw new UnauthorizedException('This account is inactive. Please contact support.');
    }

    if (Number(user.roleID || 0) === 4 && Number(user.userapproved || 0) !== 1) {
      throw new UnauthorizedException('Your partner account is pending approval.');
    }
  }

  /**
   * Validate an existing user against dvi_users.
   * Supports bcrypt and the legacy PHP PwdHash format during migration.
   */
  async validateUser(email: string, password: string) {
    const user = await this.findActiveUserByEmail(email);

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    this.assertLoginAllowed(user);

    const storedHash = user.password ?? '';
    let ok = false;
    let shouldUpgradeLegacyHash = false;

    if (isBcryptPasswordHash(storedHash)) {
      try {
        ok = await bcrypt.compare(password, storedHash);
      } catch {
        ok = false;
      }
    } else if (verifyLegacyPhpPassword(password, storedHash)) {
      ok = true;
      shouldUpgradeLegacyHash = true;
    }

    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (shouldUpgradeLegacyHash) {
      const upgradedHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

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

  async login(email: string, password: string) {
    const user = await this.validateUser(email, password);
    return this.buildLoginResponse(user);
  }

  async sendEmailLoginOtp(email: string) {
    const user = await this.findActiveUserByEmail(email);

    if (!user) {
      throw new UnauthorizedException('No active partner account was found for this email.');
    }

    this.assertLoginAllowed(user);

    return this.emailLoginOtp.createAndSendOtp(user.useremail || email, 'login');
  }

  async verifyEmailLoginOtp(email: string, otp: string) {
    const user = await this.findActiveUserByEmail(email);

    if (!user) {
      throw new UnauthorizedException('No active partner account was found for this email.');
    }

    this.assertLoginAllowed(user);

    await this.emailLoginOtp.verifyOtp(user.useremail || email, otp, 'login');

    return this.buildLoginResponse(user);
  }

  async sendRegistrationEmailOtp(email: string) {
    const existingUser = await this.findActiveUserByEmail(email);
    const existingAgent = await this.findActiveAgentByEmail(email);

    if (existingUser || existingAgent) {
      throw new ConflictException(
        'An account or registration already exists for this email. Try signing in instead.',
      );
    }

    return this.emailLoginOtp.createAndSendOtp(email, 'registration');
  }

  async verifyRegistrationEmailOtp(email: string, otp: string) {
    const existingUser = await this.findActiveUserByEmail(email);
    const existingAgent = await this.findActiveAgentByEmail(email);

    if (existingUser || existingAgent) {
      throw new ConflictException(
        'An account or registration already exists for this email. Try signing in instead.',
      );
    }

    const normalizedEmail = this.normalizeEmail(email);
    await this.emailLoginOtp.verifyOtp(normalizedEmail, otp, 'registration');

    const verificationToken = await this.jwt.signAsync(
      {
        purpose: 'registration-email-verification',
        email: normalizedEmail,
      },
      { expiresIn: '15m' },
    );

    return { verified: true, verificationToken };
  }

  async registerPartner(input: RegisterPartnerDto) {
    if (!input.declarationAccepted) {
      throw new BadRequestException('You must accept the declaration before creating an account.');
    }

    const normalizedEmail = this.normalizeEmail(input.email);
    let tokenPayload: { purpose?: string; email?: string };

    try {
      tokenPayload = await this.jwt.verifyAsync(input.emailVerificationToken);
    } catch {
      throw new UnauthorizedException('Email verification has expired. Please verify your email again.');
    }

    if (
      tokenPayload.purpose !== 'registration-email-verification' ||
      this.normalizeEmail(tokenPayload.email || '') !== normalizedEmail
    ) {
      throw new UnauthorizedException('Email verification does not match this registration.');
    }

    const existingUser = await this.findActiveUserByEmail(normalizedEmail);
    const existingAgent = await this.findActiveAgentByEmail(normalizedEmail);
    if (existingUser || existingAgent) {
      throw new ConflictException('An account or registration already exists for this email.');
    }

    const now = new Date();
    const companyName = input.companyName.trim();
    const mobile = input.mobile.trim();
    const pan = input.pan.trim().toUpperCase();

    const result = await this.prisma.$transaction(async (tx) => {
      const agent = await tx.dvi_agent.create({
        data: {
          agent_name: companyName,
          agent_primary_mobile_number: mobile,
          agent_email_id: normalizedEmail,
          status: 1,
          deleted: 0,
          createdon: now,
          updatedon: now,
        },
      });

      await tx.dvi_agent_configuration.create({
        data: {
          agent_id: agent.agent_ID,
          company_name: companyName,
          invoice_pan_no: pan,
          status: 1,
          deleted: 0,
          createdon: now,
          updatedon: now,
        },
      });

      const user = await tx.dvi_users.create({
        data: {
          agent_id: agent.agent_ID,
          username: companyName,
          useremail: normalizedEmail,
          password: null,
          roleID: 4,
          userapproved: 0,
          status: 1,
          deleted: 0,
          createdon: now,
          updatedon: now,
        },
      });

      return { agentId: agent.agent_ID, userId: user.userID };
    });

    return {
      ok: true,
      status: 'pending_approval',
      agentId: result.agentId,
      message: 'Your partner registration was submitted and is pending approval.',
    };
  }

  private async buildLoginResponse(user: any) {
    const userId = user.userID.toString();
    const email = this.normalizeEmail(user.useremail || '');

    const payload = {
      sub: userId,
      email,
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
        email,
        role: user.roleID,
        agentId: user.agent_id,
        staffId: user.staff_id,
        guideId: user.guide_id,
        fullName: user.username ?? '',
      },
    };
  }
}
