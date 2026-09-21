import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma.service';
import {
  isBcryptPasswordHash,
  verifyLegacyPhpPassword,
} from '../../common/utils/password-migration.util';
import { EmailLoginOtpService } from './email-login-otp.service';
import { PartnerActivationService } from './partner-activation.service';
import { RegisterPartnerDto } from './dto/register-partner.dto';
import { SystemRole } from './constants/system-role.constants';
const BCRYPT_ROUNDS = 10;
const LEGACY_SSO_AUDIENCE = 'legacy';
const LEGACY_SSO_TTL_MS = 60_000;

@Injectable()
export class AuthService {
  private readonly logger =
    new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly emailLoginOtp: EmailLoginOtpService,
    private readonly partnerActivation: PartnerActivationService,
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

    const isStaffLogin = Number(user.staff_id || 0) > 0;

    if (
      !isStaffLogin &&
      (Number(user.roleID || 0) === SystemRole.AGENT ||
        Number(user.roleID || 0) === SystemRole.VEHICLE_AGENT) &&
      Number(user.userapproved || 0) !== 1
    ) {
      throw new UnauthorizedException('Your partner account is pending approval.');
    }
  }

  private assertLegacySsoSecret(providedSecret?: string) {
    const expectedSecret = String(
      process.env.LEGACY_SSO_SHARED_SECRET || '',
    ).trim();
    const candidateSecret = String(providedSecret || '').trim();

    if (!expectedSecret || !candidateSecret) {
      throw new UnauthorizedException(
        'Legacy SSO is not configured.',
      );
    }

    const expected = Buffer.from(expectedSecret, 'utf8');
    const candidate = Buffer.from(candidateSecret, 'utf8');

    if (
      expected.length !== candidate.length ||
      !timingSafeEqual(expected, candidate)
    ) {
      throw new UnauthorizedException(
        'Invalid legacy SSO credentials.',
      );
    }
  }

  async createLegacySsoTicket(userId: string | number) {
    let resolvedUserId: bigint;

    try {
      resolvedUserId = BigInt(userId);
    } catch {
      throw new UnauthorizedException(
        'Invalid authenticated user.',
      );
    }

    const user = await this.prisma.dvi_users.findUnique({
      where: { userID: resolvedUserId },
    });

    if (!user) {
      throw new UnauthorizedException(
        'Authenticated user account was not found.',
      );
    }

    this.assertLoginAllowed(user);

    const email = this.normalizeEmail(user.useremail || '');

    if (!email) {
      throw new UnauthorizedException(
        'A verified email is required for legacy sign-in.',
      );
    }

    const ticket = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256')
      .update(ticket)
      .digest('hex');
    const expiresAt = new Date(
      Date.now() + LEGACY_SSO_TTL_MS,
    );

    await this.prisma.dvi_legacy_sso_tickets.create({
      data: {
        token_hash: tokenHash,
        user_id: user.userID,
        audience: LEGACY_SSO_AUDIENCE,
        expires_at: expiresAt,
      },
    });

    return {
      ticket,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async redeemLegacySsoTicket(
    ticket: string,
    providedSecret?: string,
  ) {
    this.assertLegacySsoSecret(providedSecret);

    const normalizedTicket = String(ticket || '').trim();

    if (!/^[a-f0-9]{64}$/i.test(normalizedTicket)) {
      throw new UnauthorizedException(
        'Invalid or expired legacy sign-in ticket.',
      );
    }

    const tokenHash = createHash('sha256')
      .update(normalizedTicket)
      .digest('hex');
    const consumedAt = new Date();

    const consumed =
      await this.prisma.dvi_legacy_sso_tickets.updateMany({
        where: {
          token_hash: tokenHash,
          audience: LEGACY_SSO_AUDIENCE,
          consumed_at: null,
          expires_at: { gt: consumedAt },
        },
        data: { consumed_at: consumedAt },
      });

    if (consumed.count !== 1) {
      throw new UnauthorizedException(
        'Invalid or expired legacy sign-in ticket.',
      );
    }

    const ticketRow =
      await this.prisma.dvi_legacy_sso_tickets.findUnique({
        where: { token_hash: tokenHash },
      });

    const user = ticketRow
      ? await this.prisma.dvi_users.findUnique({
          where: { userID: ticketRow.user_id },
        })
      : null;

    if (!user) {
      throw new UnauthorizedException(
        'Legacy user account was not found.',
      );
    }

    this.assertLoginAllowed(user);

    const email = this.normalizeEmail(user.useremail || '');

    if (!email) {
      throw new UnauthorizedException(
        'Legacy user account has no email address.',
      );
    }

    return {
      email,
      userID: user.userID.toString(),
      agentId: Number(user.agent_id || 0),
      vendorId: Number(user.vendor_id || 0),
      staffId: Number(user.staff_id || 0),
      guideId: Number(user.guide_id || 0),
      roleID: Number(user.roleID || 0),
    };
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

   async changePassword(
    userId: string | number,
    currentPassword: string,
    newPassword: string,
    confirmPassword: string,
  ) {
    if (
      !currentPassword ||
      !newPassword ||
      !confirmPassword
    ) {
      throw new BadRequestException(
        'All password fields are required',
      );
    }

    if (newPassword.length < 6) {
      throw new BadRequestException(
        'New password must be at least 6 characters',
      );
    }

    if (newPassword !== confirmPassword) {
      throw new BadRequestException(
        'New password and confirm password do not match',
      );
    }

    if (currentPassword === newPassword) {
      throw new BadRequestException(
        'New password must be different from current password',
      );
    }

    let resolvedUserId: bigint;

    try {
      resolvedUserId =
        BigInt(userId);
    } catch {
      throw new BadRequestException(
        'Invalid user account',
      );
    }

    const user =
      await this.prisma.dvi_users.findFirst({
        where: {
          userID: resolvedUserId,
          deleted: 0,
        },
      });

    if (!user) {
      throw new BadRequestException(
        'User account not found',
      );
    }

    const storedHash =
      user.password ?? '';

    let currentPasswordMatches = false;

    if (
      isBcryptPasswordHash(storedHash)
    ) {
      try {
        currentPasswordMatches =
          await bcrypt.compare(
            currentPassword,
            storedHash,
          );
      } catch {
        currentPasswordMatches = false;
      }
    } else {
      currentPasswordMatches =
        verifyLegacyPhpPassword(
          currentPassword,
          storedHash,
        );
    }

    if (!currentPasswordMatches) {
      throw new BadRequestException(
        'Current password is incorrect',
      );
    }

    const passwordHash =
      await bcrypt.hash(
        newPassword,
        BCRYPT_ROUNDS,
      );

    await this.prisma.dvi_users.update({
      where: {
        userID: resolvedUserId,
      },
      data: {
        password: passwordHash,
        updatedon: new Date(),
      },
    });

    return {
      message:
        'Password changed successfully',
    };
  }

  async login(email: string, password: string) {
    const user =
      await this.validateUser(
        email,
        password,
      );

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

           return {
        agentId: agent.agent_ID,
        userId: user.userID,
      };
    });

    let activationEmailSent = false;

    try {
      await this.partnerActivation
        .createAndSendActivationLink({
          userId: result.userId,
          agentId: result.agentId,
          email: normalizedEmail,
          companyName,
        });

      activationEmailSent = true;
    } catch (error: any) {
      this.logger.error(
        `Partner activation email could not be sent for agent ${result.agentId}: ${
          error?.message || error
        }`,
      );
    }

    return {
      ok: true,
      status: 'pending_activation',
      agentId: result.agentId,
      activationEmailSent,
      message: activationEmailSent
        ? 'Registration successful. An activation link has been sent to your registered email address.'
        : 'Registration was created, but the activation email could not be sent. Please request a new activation email.',
    };
  }

  async resendPartnerActivation(
    email: string,
  ) {
    const normalizedEmail =
      this.normalizeEmail(email);

    const user =
      await this.findActiveUserByEmail(
        normalizedEmail,
      );

    if (
      !user ||
      Number(user.roleID || 0) !==
        SystemRole.AGENT ||
      Number(user.agent_id || 0) <= 0
    ) {
      throw new UnauthorizedException(
        'No pending partner registration was found for this email.',
      );
    }

    if (
      Number(user.status || 0) === 0 ||
      Number(
        user.userbanned || 0,
      ) === 1
    ) {
      throw new UnauthorizedException(
        'This account is inactive. Please contact support.',
      );
    }

    if (
      Number(
        user.userapproved || 0,
      ) === 1
    ) {
      throw new ConflictException(
        'This partner account is already active. Please sign in instead.',
      );
    }

    const agentId =
      Number(user.agent_id);

    const agent =
      await this.prisma
        .dvi_agent
        .findFirst({
          where: {
            agent_ID: agentId,
            status: 1,
            deleted: 0,
          },
          select: {
            agent_name: true,
            agent_email_id: true,
          },
        });

    if (
      !agent ||
      this.normalizeEmail(
        agent.agent_email_id ||
          '',
      ) !== normalizedEmail
    ) {
      throw new UnauthorizedException(
        'No pending partner registration was found for this email.',
      );
    }

    await this.partnerActivation
      .createAndSendActivationLink({
        userId: user.userID,
        agentId,
        email: normalizedEmail,
        companyName:
          agent.agent_name ||
          user.username ||
          null,
      });

    return {
      message:
        'A new activation link has been sent to your registered email address.',
    };
  }

  async activatePartner(
    token: string,
  ) {
    const userId =
      await this.partnerActivation
        .activatePartnerToken(
          token,
        );

    const user =
      await this.prisma
        .dvi_users
        .findUnique({
          where: {
            userID: userId,
          },
        });

    if (!user) {
      throw new UnauthorizedException(
        'This partner account is no longer available.',
      );
    }

    this.assertLoginAllowed(user);

    return this.buildLoginResponse(
      user,
    );
  }

  private normalizeAccessKey(value: unknown) {
    return String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
  }

  private async resolveStaffLoginContext(
    user: any,
  ) {
    const linkedStaffId = Number(
      user.staff_id || 0,
    );

    const email = this.normalizeEmail(
      user.useremail || '',
    );

    const staff =
      await this.prisma.dvi_staff_details.findFirst({
        where:
          linkedStaffId > 0
            ? {
                staff_id: linkedStaffId,
                status: 1,
                deleted: 0,
              }
            : {
                staff_email: email,
                status: 1,
                deleted: 0,
              },
        select: {
          staff_id: true,
          staff_name: true,
          roleID: true,
        },
      });

    if (!staff) {
      throw new UnauthorizedException(
        'This Staff login is not linked to an active staff record.',
      );
    }

    const permissionRoleId = Number(
      staff.roleID || 0,
    );

    if (permissionRoleId <= 0) {
      return {
        staffId: Number(staff.staff_id),
        staffName:
          staff.staff_name ||
          user.username ||
          'Staff',
        permissionRoleId: 0,
        allowedAccessKeys: [] as string[],
        configuredAccessKeys: [] as string[],
      };
    }

    const roleAccessRows =
      await this.prisma.dvi_role_access.findMany({
        where: {
          role_ID: permissionRoleId,
          status: 1,
          deleted: 0,
        },
        select: {
          page_menu_id: true,
          read_access: true,
          write_access: true,
          modify_access: true,
          full_access: true,
        },
      });

    const pageMenuIds = Array.from(
      new Set(
        roleAccessRows.map((row) =>
          Number(row.page_menu_id),
        ),
      ),
    ).filter((id) => id > 0);

    const pageRows = pageMenuIds.length
      ? await this.prisma.dvi_pagemenu.findMany({
          where: {
            page_menu_id: {
              in: pageMenuIds,
            },
            status: 1,
            deleted: 0,
          },
          select: {
            page_menu_id: true,
            page_name: true,
            page_title: true,
          },
        })
      : [];

    const pageById = new Map(
      pageRows.map((page) => [
        Number(page.page_menu_id),
        page,
      ]),
    );

    const configuredKeys = new Set<string>();
    const allowedKeys = new Set<string>();

    for (const access of roleAccessRows) {
      const page = pageById.get(
        Number(access.page_menu_id),
      );

      if (!page) continue;

      const pageKeys = [
        page.page_name,
        page.page_title,
      ]
        .map((value) =>
          this.normalizeAccessKey(value),
        )
        .filter(Boolean);

      for (const key of pageKeys) {
        configuredKeys.add(key);
      }

      const hasAccess =
        Number(access.read_access || 0) === 1 ||
        Number(access.write_access || 0) === 1 ||
        Number(access.modify_access || 0) === 1 ||
        Number(access.full_access || 0) === 1;

      if (hasAccess) {
        for (const key of pageKeys) {
          allowedKeys.add(key);
        }
      }
    }

        return {
      staffId: Number(staff.staff_id),
      staffName:
        staff.staff_name ||
        user.username ||
        'Staff',
      permissionRoleId,
      allowedAccessKeys:
        Array.from(allowedKeys),
      configuredAccessKeys:
        Array.from(configuredKeys),
    };
  }

  private async resolveAgentLoginContext(agentId: number) {
    if (!Number.isFinite(agentId) || agentId <= 0) {
      return null;
    }

const rows = await this.prisma.$queryRaw<
  Array<{
    agent_name: string | null;
    agent_lastname: string | null;
    agent_primary_mobile_number: string | null;
    company_name: string | null;
    site_logo: string | null;
  }>
>`
  SELECT
    A.agent_name,
    A.agent_lastname,
    A.agent_primary_mobile_number,
    C.company_name,
    C.site_logo
  FROM dvi_agent AS A
  LEFT JOIN dvi_agent_configuration AS C
    ON C.agent_id = A.agent_ID
    AND C.status = 1
    AND C.deleted = 0
  WHERE A.agent_ID = ${agentId}
    AND A.status = 1
    AND A.deleted = 0
  ORDER BY C.agent_config_id DESC
  LIMIT 1
`;
    const agent = rows[0];

    if (!agent) {
      return null;
    }

    const agentName = [
      agent.agent_name,
      agent.agent_lastname,
    ]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
      .join(" ");

return {
  agentName,
  companyName: String(
    agent.company_name ?? "",
  ).trim(),
  siteLogo: String(
    agent.site_logo ?? "",
  ).trim(),
  agentMobile: String(
    agent.agent_primary_mobile_number ?? "",
  ).trim(),
};
  }

private async buildLoginResponse(user: any) {
  const userId = user.userID.toString();

  const email = this.normalizeEmail(
    user.useremail || '',
  );

  const roleID = Number(user.roleID || 0);

  const staffContext =
    roleID === SystemRole.STAFF
      ? await this.resolveStaffLoginContext(user)
      : null;

  const agentId = Number(user.agent_id || 0);
  const vendorId = Number(user.vendor_id || 0);

  const agentContext =
    roleID === SystemRole.AGENT && agentId > 0
      ? await this.resolveAgentLoginContext(agentId)
      : null;

  const staffId =
    staffContext?.staffId ??
    Number(user.staff_id || 0);

  const guideId = Number(user.guide_id || 0);

  const fullName =
    staffContext?.staffName ||
    agentContext?.agentName ||
    user.username ||
    '';

  const payload = {
    sub: userId,
    email,
    role: roleID,
    roleID,
    agentId,
    vendorId,
    staffId,
    guideId,
    name: fullName,

...(agentContext
  ? {
      agentName: agentContext.agentName,
      companyName: agentContext.companyName,
      siteLogo: agentContext.siteLogo,
      agentMobile: agentContext.agentMobile,
    }
  : {}),

    ...(staffContext
      ? {
          permissionRoleId:
            staffContext.permissionRoleId,
          allowedAccessKeys:
            staffContext.allowedAccessKeys,
          configuredAccessKeys:
            staffContext.configuredAccessKeys,
        }
      : {}),
  };

  const accessToken =
    await this.jwt.signAsync(payload);

  return {
    accessToken,
    roleID,
    staffId,
    vendorId,
    user: {
      id: userId,
      email,
      role: roleID,
      roleID,
      agentId,
      vendorId,
      staffId,
      guideId,
      fullName,

      agentName:
  agentContext?.agentName ?? null,

companyName:
  agentContext?.companyName ?? null,

siteLogo:
  agentContext?.siteLogo ?? null,

agentMobile:
  agentContext?.agentMobile ?? null,

      permissionRoleId:
        staffContext?.permissionRoleId ?? null,

      allowedAccessKeys:
        staffContext?.allowedAccessKeys ?? [],

      configuredAccessKeys:
        staffContext?.configuredAccessKeys ?? [],
    },
  };
}
}
