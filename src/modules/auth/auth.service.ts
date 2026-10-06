import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { QuickOnboardAgentDto } from './dto/quick-onboard-agent.dto';
import { SystemRole } from './constants/system-role.constants';
import {
  generateUniqueAgentCode,
  withAgentCodeGenerationLock,
} from '../../common/utils/agent-code.util';
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

  async getPasswordStatus(
  userId: string | number,
) {
  let resolvedUserId: bigint;

  try {
    resolvedUserId =
      BigInt(userId);
  } catch {
    throw new BadRequestException(
      'Invalid user account',
    );
  }

  const sessionUser =
    await this.prisma.dvi_users.findFirst({
      where: {
        userID: resolvedUserId,
        deleted: 0,
      },
    });

  if (!sessionUser) {
  throw new BadRequestException(
    'User account not found',
  );
}

this.assertLoginAllowed(
  sessionUser,
);

if (
  Number(sessionUser.roleID || 0) !==
  SystemRole.AGENT
) {
    throw new ForbiddenException(
      'Only agents can manage their password here',
    );
  }

 const user =
  await this.resolveCanonicalAgentUser(
    sessionUser,
  );

this.assertLoginAllowed(
  user,
);

const hasPassword =
    String(
      user?.password ?? '',
    ).trim().length > 0;

  return {
    hasPassword,
    mode:
      hasPassword
        ? 'change'
        : 'set',
  };
}

  /**
 * Resolves the user row that should actually be used for authentication.
 *
 * Rules:
 * 1. One active row -> use it.
 * 2. Multiple rows for the SAME Agent -> use the newest row because
 *    Agent management also treats the newest dvi_users row as current.
 * 3. Multiple rows belonging to different accounts -> do NOT guess.
 */
private async findAuthenticationUserByEmail(
  email: string,
) {
  const normalizedEmail =
    this.normalizeEmail(email);

  const rows =
    await this.prisma.$queryRaw<
      Array<{
  userID: bigint;
  roleID: number | null;
  agent_id: number | null;
  userapproved: number | null;
  userbanned: number | null;
  status: number | null;
}>
    >`
     SELECT
  userID,
  roleID,
  agent_id,
  userapproved,
  userbanned,
  status
FROM dvi_users
      WHERE LOWER(TRIM(useremail)) = ${normalizedEmail}
        AND deleted = 0
      ORDER BY userID ASC
    `;

  if (!rows.length) {
    return null;
  }

  if (rows.length === 1) {
    return this.prisma.dvi_users.findUnique({
      where: {
        userID: rows[0].userID,
      },
    });
  }

  const firstAgentId =
    Number(
      rows[0].agent_id || 0,
    );

  const sameAgentDuplicates =
  firstAgentId > 0 &&
  rows.every(
    (row) =>
      Number(row.roleID || 0) ===
        SystemRole.AGENT &&
      Number(row.agent_id || 0) ===
        firstAgentId,
  );

if (sameAgentDuplicates) {
  const usableRows =
    rows.filter(
      (row) =>
        Number(
          row.status ?? 1,
        ) !== 0 &&
        Number(
          row.userbanned ?? 0,
        ) !== 1 &&
        Number(
          row.userapproved ?? 0,
        ) === 1,
    );

  const selectedRow =
    usableRows.length > 0
      ? usableRows[
          usableRows.length - 1
        ]
      : rows[
          rows.length - 1
        ];

  this.logger.warn(
    `Duplicate active dvi_users rows found for Agent email ${normalizedEmail}. ` +
      `Using userID ${String(
        selectedRow.userID,
      )}.`,
  );

  return this.prisma.dvi_users.findUnique({
    where: {
      userID:
        selectedRow.userID,
    },
  });
}

/*
 * IMPORTANT:
 * Preserve the existing authentication behaviour
 * for non-Agent or mixed-role duplicate records.
 *
 * Before this fix, authentication used:
 * ORDER BY userID ASC LIMIT 1.
 *
 * Do not change that behaviour as part of an
 * Agent-password fix.
 */
const legacyUser =
  rows[0];

this.logger.warn(
  `Multiple active dvi_users rows found for ${normalizedEmail}, ` +
    `but they are not duplicate rows for the same Agent. ` +
    `Preserving legacy authentication with userID ${String(
      legacyUser.userID,
    )}.`,
);

return this.prisma.dvi_users.findUnique({
  where: {
    userID:
      legacyUser.userID,
  },
});
}

private async resolveCanonicalAgentUser(
  user: any,
) {
  if (
    !user ||
    Number(user.roleID || 0) !==
      SystemRole.AGENT ||
    Number(user.agent_id || 0) <= 0 ||
    !user.useremail
  ) {
    return user;
  }

  const agentId =
    Number(user.agent_id);

  const normalizedEmail =
    this.normalizeEmail(
      user.useremail,
    );

  /*
   * IMPORTANT:
   * This resolver is ONLY for Agent password
   * operations.
   *
   * Do not use the general authentication
   * fallback here because an email can exist
   * against another legacy role/account.
   */
  const rows =
    await this.prisma.$queryRaw<
      Array<{
        userID: bigint;
        userapproved: number | null;
        userbanned: number | null;
        status: number | null;
      }>
    >`
      SELECT
        userID,
        userapproved,
        userbanned,
        status
      FROM dvi_users
      WHERE agent_id = ${agentId}
        AND roleID = ${SystemRole.AGENT}
        AND deleted = 0
        AND LOWER(TRIM(useremail)) =
          ${normalizedEmail}
      ORDER BY userID ASC
    `;

  if (!rows.length) {
    return user;
  }

  const usableRows =
    rows.filter(
      (row) =>
        Number(
          row.status ?? 1,
        ) !== 0 &&
        Number(
          row.userbanned ?? 0,
        ) !== 1 &&
        Number(
          row.userapproved ?? 0,
        ) === 1,
    );

  /*
   * Prefer newest usable Agent login.
   *
   * If none are usable, return the newest
   * matching Agent row and allow
   * assertLoginAllowed() to reject it.
   */
  const selectedRow =
    usableRows.length > 0
      ? usableRows[
          usableRows.length - 1
        ]
      : rows[
          rows.length - 1
        ];

  const canonicalUser =
    await this.prisma.dvi_users.findUnique({
      where: {
        userID:
          selectedRow.userID,
      },
    });

  return canonicalUser ?? user;
}
/**
 * Password writes for an Agent are synchronized
 * across active duplicate user rows belonging
 * to the same Agent.
 *
 * We DO NOT delete historical user rows.
 */
private async savePasswordForUser(
  user: any,
  passwordHash: string,
) {
  const agentId =
    Number(user.agent_id || 0);

  const normalizedEmail =
    this.normalizeEmail(
      user.useremail || '',
    );

  if (
    Number(user.roleID || 0) ===
      SystemRole.AGENT &&
    agentId > 0 &&
    normalizedEmail
  ) {
    const now =
      new Date();

    /*
     * Synchronize only duplicate login rows
     * belonging to the SAME Agent AND the
     * SAME normalized email.
     *
     * Do not change passwords of other users
     * attached to the same Agent/company.
     */
    await this.prisma.$executeRaw`
      UPDATE dvi_users
      SET
        password = ${passwordHash},
        updatedon = ${now}
      WHERE agent_id = ${agentId}
        AND roleID = ${SystemRole.AGENT}
        AND deleted = 0
        AND LOWER(TRIM(useremail)) =
          ${normalizedEmail}
    `;

    return;
  }

  await this.prisma.dvi_users.update({
    where: {
      userID: user.userID,
    },
    data: {
      password: passwordHash,
      updatedon: new Date(),
    },
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
async validateUser(
  email: string,
  password: string,
) {
  const user =
    await this.findAuthenticationUserByEmail(
      email,
    );

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
  const upgradedHash =
    await bcrypt.hash(
      password,
      BCRYPT_ROUNDS,
    );

  await this.savePasswordForUser(
    user,
    upgradedHash,
  );
}

    return user;
  }

async changePassword(
  userId: string | number,
  currentPassword: string | undefined,
  newPassword: string,
  confirmPassword: string,
) {
  if (
    !newPassword ||
    !confirmPassword
  ) {
    throw new BadRequestException(
      'New password and confirm password are required',
    );
  }

  if (newPassword.length < 6) {
    throw new BadRequestException(
      'New password must be at least 6 characters',
    );
  }

  if (
    newPassword !== confirmPassword
  ) {
    throw new BadRequestException(
      'New password and confirm password do not match',
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

  const sessionUser =
    await this.prisma.dvi_users.findFirst({
      where: {
        userID: resolvedUserId,
        deleted: 0,
      },
    });

  if (!sessionUser) {
  throw new BadRequestException(
    'User account not found',
  );
}

this.assertLoginAllowed(
  sessionUser,
);

if (
  Number(sessionUser.roleID || 0) !==
  SystemRole.AGENT
) {
    throw new ForbiddenException(
      'Only agents can manage their password here',
    );
  }

 const user =
  await this.resolveCanonicalAgentUser(
    sessionUser,
  );

this.assertLoginAllowed(
  user,
);

const storedHash =
  String(user.password ?? '');

  const hasExistingPassword =
    storedHash.trim().length > 0;

  /*
   * Existing password:
   * normal Change Password rules apply.
   */
  if (hasExistingPassword) {
    if (!currentPassword) {
      throw new BadRequestException(
        'Current password is required',
      );
    }

    if (
      currentPassword ===
      newPassword
    ) {
      throw new BadRequestException(
        'New password must be different from current password',
      );
    }

    let currentPasswordMatches =
      false;

    if (
      isBcryptPasswordHash(
        storedHash,
      )
    ) {
      try {
        currentPasswordMatches =
          await bcrypt.compare(
            currentPassword,
            storedHash,
          );
      } catch {
        currentPasswordMatches =
          false;
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
  }

  /*
   * No stored password:
   * authenticated Agent may establish
   * the first password without a fake
   * "current password".
   */
  const passwordHash =
    await bcrypt.hash(
      newPassword,
      BCRYPT_ROUNDS,
    );

  await this.savePasswordForUser(
    user,
    passwordHash,
  );

  return {
  message:
    hasExistingPassword
      ? 'Password changed successfully'
      : 'Password set successfully',
};
}

async sendPasswordResetOtp(
  email: string,
) {
  const normalizedEmail =
    this.normalizeEmail(email);

  const user =
    await this.findAuthenticationUserByEmail(
      normalizedEmail,
    );

  /*
   * Forgot Password is deliberately limited
   * to Agent accounts for this task.
   *
   * Do not change Admin / Staff / Vendor
   * password behaviour here.
   */
  if (
    !user ||
    Number(user.roleID || 0) !==
      SystemRole.AGENT
  ) {
    throw new UnauthorizedException(
      'No active Agent account was found for this email.',
    );
  }

  /*
   * Pending/unapproved Agents must still
   * activate their account first.
   */
  this.assertLoginAllowed(user);

  return this.emailLoginOtp
    .createAndSendOtp(
      user.useremail ||
        normalizedEmail,
      'password-reset',
    );
}

async resetPasswordWithOtp(
  email: string,
  otp: string,
  newPassword: string,
  confirmPassword: string,
) {
  if (
    !email ||
    !otp ||
    !newPassword ||
    !confirmPassword
  ) {
    throw new BadRequestException(
      'Email, OTP and password fields are required',
    );
  }

  if (newPassword.length < 6) {
    throw new BadRequestException(
      'New password must be at least 6 characters',
    );
  }

  if (
    newPassword !==
    confirmPassword
  ) {
    throw new BadRequestException(
      'New password and confirm password do not match',
    );
  }

  const normalizedEmail =
    this.normalizeEmail(email);

  const sessionUser =
    await this.findAuthenticationUserByEmail(
      normalizedEmail,
    );

  if (
    !sessionUser ||
    Number(sessionUser.roleID || 0) !==
      SystemRole.AGENT
  ) {
    throw new UnauthorizedException(
      'No active Agent account was found for this email.',
    );
  }

  this.assertLoginAllowed(
    sessionUser,
  );

  const user =
    await this.resolveCanonicalAgentUser(
      sessionUser,
    );

  this.assertLoginAllowed(
    user,
  );

  /*
   * Password-reset OTP has its own purpose
   * and its own table, so Login OTP and
   * Registration OTP cannot be consumed here.
   */
  await this.emailLoginOtp.verifyOtp(
    user.useremail ||
      normalizedEmail,
    otp,
    'password-reset',
  );

  const passwordHash =
    await bcrypt.hash(
      newPassword,
      BCRYPT_ROUNDS,
    );

  /*
   * Uses the same safe duplicate synchronization
   * as Change Password.
   */
  await this.savePasswordForUser(
    user,
    passwordHash,
  );

  return {
    message:
      'Password reset successfully',
  };
}

async login(
  email: string,
  password: string,
) {
    const user =
      await this.validateUser(
        email,
        password,
      );

    return this.buildLoginResponse(user);
  }

async sendEmailLoginOtp(email: string) {
  const user =
    await this.findAuthenticationUserByEmail(
      email,
    );

  if (!user) {
    throw new UnauthorizedException(
      'No active partner account was found for this email.',
    );
  }

  this.assertLoginAllowed(user);

  return this.emailLoginOtp
    .createAndSendOtp(
      user.useremail || email,
      'login',
    );
}

 async verifyEmailLoginOtp(
  email: string,
  otp: string,
) {
  const user =
    await this.findAuthenticationUserByEmail(
      email,
    );

  if (!user) {
    throw new UnauthorizedException(
      'No active partner account was found for this email.',
    );
  }

  this.assertLoginAllowed(user);

  await this.emailLoginOtp.verifyOtp(
    user.useremail || email,
    otp,
    'login',
  );

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

   async quickOnboardPartner(
    input: QuickOnboardAgentDto,
    authenticatedUser: any,
  ) {
const role = Number(
  authenticatedUser?.roleID ??
    authenticatedUser?.role ??
    0,
);

const permissionRoleId =
  Number(
    authenticatedUser
      ?.permissionRoleId ??
      0,
  );

const isLegacyTravelExpertStaff =
  role === SystemRole.STAFF &&
  permissionRoleId ===
    SystemRole.TRAVEL_EXPERT;

if (
  role !== SystemRole.ADMIN &&
  role !==
    SystemRole.TRAVEL_EXPERT &&
  !isLegacyTravelExpertStaff
) {
  throw new ForbiddenException(
    'Only Admin or Travel Expert can quick-onboard an Agent.',
  );
}

  const isTravelExpertContext =
  role ===
    SystemRole.TRAVEL_EXPERT ||
  isLegacyTravelExpertStaff;

const travelExpertId =
  isTravelExpertContext
    ? Number(
        authenticatedUser
          ?.staffId ??
          authenticatedUser
            ?.staff_id ??
          0,
      )
    : 0;
   if (
  isTravelExpertContext &&
  travelExpertId <= 0
) {
  throw new ForbiddenException(
    'This Travel Expert login is not linked to a valid staff record.',
  );
}

    const name =
      String(input.name || '')
        .replace(/\s+/g, ' ')
        .trim();

    const companyName =
      String(
        input.companyName || '',
      )
        .replace(/\s+/g, ' ')
        .trim();

    const normalizedEmail =
      this.normalizeEmail(
        input.email,
      );

    const mobile =
      String(input.mobile || '')
        .replace(/\s+/g, ' ')
        .trim();

    /*
     * Serialize quick-onboarding for the
     * same email at the DATABASE level.
     *
     * This protects retries as well as
     * simultaneous requests from creating
     * duplicate Agent accounts.
     */
    const quickOnboardLock =
      `quick-agent:${createHash(
        'sha256',
      )
        .update(normalizedEmail)
        .digest('hex')
        .slice(0, 40)}`;

    return this.prisma.$transaction(
      async (tx) => {
        const lockRows =
          await tx.$queryRaw<
            Array<{
              acquired:
                | number
                | bigint
                | null;
            }>
          >`
            SELECT GET_LOCK(
              ${quickOnboardLock},
              5
            ) AS acquired
          `;

        if (
          Number(
            lockRows[0]
              ?.acquired ?? 0,
          ) !== 1
        ) {
          throw new ConflictException(
            'This Agent is already being created. Please retry the itinerary save.',
          );
        }

        try {
          /*
           * Recheck inside the database lock.
           * Do not rely on the frontend to
           * provide idempotency.
           */
          const existingUsers =
            await tx.$queryRaw<
              Array<{
                userID: bigint;
                agent_id: number;
                roleID: number;
                userapproved: number;
                userbanned: number;
                status: number;
              }>
            >`
              SELECT
                userID,
                agent_id,
                roleID,
                userapproved,
                userbanned,
                status
              FROM dvi_users
              WHERE
                LOWER(
                  TRIM(useremail)
                ) =
                  ${normalizedEmail}
                AND deleted = 0
              ORDER BY userID ASC
              LIMIT 1
            `;

          const existingAgents =
            await tx.$queryRaw<
              Array<{
                agent_ID: number;
                agent_name:
                  | string
                  | null;
                agent_email_id:
                  | string
                  | null;
                agent_primary_mobile_number:
                  | string
                  | null;
                travel_expert_id:
                  number;
                status: number;
              }>
            >`
              SELECT
                agent_ID,
                agent_name,
                agent_email_id,
                agent_primary_mobile_number,
                travel_expert_id,
                status
              FROM dvi_agent
              WHERE
                LOWER(
                  TRIM(
                    agent_email_id
                  )
                ) =
                  ${normalizedEmail}
                AND deleted = 0
              ORDER BY agent_ID ASC
              LIMIT 1
            `;

          const existingUser =
            existingUsers[0] ??
            null;

          const existingAgent =
            existingAgents[0] ??
            null;

          if (
            existingUser ||
            existingAgent
          ) {
            const existingAgentId =
              Number(
                existingAgent
                  ?.agent_ID ??
                  existingUser
                    ?.agent_id ??
                  0,
              );

            const existingConfig =
              existingAgentId > 0
                ? await tx
                    .dvi_agent_configuration
                    .findFirst({
                      where: {
                        agent_id:
                          existingAgentId,
                        status: 1,
                        deleted: 0,
                      },
                      orderBy: {
                        agent_config_id:
                          'desc',
                      },
                      select: {
                        company_name:
                          true,
                        invoice_pan_no:
                          true,
                      },
                    })
                : null;

            /*
             * A quick-onboard account is a
             * pending AGENT linked through
             * the same agent ID and has no
             * registration PAN.
             *
             * If it matches, this is an
             * idempotent retry: reuse it.
             */
            const reusablePendingAgent =
              Boolean(
                existingUser &&
                  existingAgent &&
                  existingConfig &&
                  Number(
                    existingUser
                      .agent_id,
                  ) ===
                    Number(
                      existingAgent
                        .agent_ID,
                    ) &&
                  Number(
                    existingUser
                      .roleID,
                  ) ===
                    SystemRole.AGENT &&
                  Number(
                    existingUser
                      .userapproved,
                  ) === 0 &&
                  Number(
                    existingUser
                      .userbanned,
                  ) === 0 &&
                  Number(
                    existingUser
                      .status,
                  ) === 1 &&
                  Number(
                    existingAgent
                      .status,
                  ) === 1 &&
                  !String(
                    existingConfig
                      .invoice_pan_no ||
                      '',
                  ).trim() &&
                 (
  !isTravelExpertContext ||
  Number(
    existingAgent
      .travel_expert_id ||
      0,
  ) ===
    travelExpertId
)
              );

            if (
              !reusablePendingAgent
            ) {
              throw new ConflictException(
                'An account or registration already exists for this email.',
              );
            }

            return {
              agentId:
                Number(
                  existingAgent!
                    .agent_ID,
                ),

              name:
                String(
                  existingAgent!
                    .agent_name ||
                    name,
                ).trim(),

              companyName:
                String(
                  existingConfig!
                    .company_name ||
                    companyName,
                ).trim(),

              email:
                normalizedEmail,

              mobile:
                String(
                  existingAgent!
                    .agent_primary_mobile_number ||
                    mobile,
                ).trim(),

              status:
                'pending_activation' as const,
            };
          }

          const now =
            new Date();

          /*
           * All three rows are created in
           * ONE transaction.
           *
           * Failure in any one rolls back
           * the account creation itself.
           */
          const agent =
            await tx.dvi_agent.create({
              data: {
                agent_name:
                  name,

                agent_primary_mobile_number:
                  mobile,

                agent_email_id:
                  normalizedEmail,

                /*
                 * Preserve existing
                 * Travel Expert -> Agent
                 * ownership.
                 */
                travel_expert_id:
                  travelExpertId,

                status: 1,
                deleted: 0,
                createdon: now,
                updatedon: now,
              },
            });

          await tx
            .dvi_agent_configuration
            .create({
              data: {
                agent_id:
                  agent.agent_ID,

                company_name:
                  companyName,

                /*
                 * Do NOT add PAN here.
                 * The schema field is
                 * nullable, and normal
                 * Partner Registration's
                 * PAN rules remain intact.
                 */

                status: 1,
                deleted: 0,
                createdon: now,
                updatedon: now,
              },
            });

          await tx.dvi_users.create({
            data: {
              agent_id:
                agent.agent_ID,

              username:
                name,

              useremail:
                normalizedEmail,

              password:
                null,

              roleID:
                SystemRole.AGENT,

              userapproved:
                0,

              status: 1,
              deleted: 0,

              createdon: now,
              updatedon: now,
            },
          });

          /*
           * IMPORTANT:
           * No PartnerActivationService
           * call here.
           *
           * The Agent is pending only.
           * Activation is triggered by the
           * frontend AFTER itinerary
           * persistence through the existing
           * resend-activation endpoint.
           */
          return {
            agentId:
              agent.agent_ID,

            name,
            companyName,
            email:
              normalizedEmail,
            mobile,

            status:
              'pending_activation' as const,
          };
        } finally {
          /*
           * MySQL named locks are connection
           * scoped rather than transaction
           * scoped, so explicitly release it.
           */
          try {
            await tx.$queryRaw`
              SELECT RELEASE_LOCK(
                ${quickOnboardLock}
              )
            `;
          } catch (releaseError) {
            this.logger.warn(
              `Unable to release quick-onboard lock for ${normalizedEmail}: ${
                releaseError instanceof Error
                  ? releaseError.message
                  : String(
                      releaseError,
                    )
              }`,
            );
          }
        }
      },
    );
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
      const agent = await withAgentCodeGenerationLock(tx as any, async () => {
        const agentCode = await generateUniqueAgentCode(tx as any, companyName);

        return tx.dvi_agent.create({
          data: {
            agent_name: companyName,
            agent_code: agentCode,
            agent_primary_mobile_number: mobile,
            agent_email_id: normalizedEmail,
            status: 1,
            deleted: 0,
            createdon: now,
            updatedon: now,
          },
        });
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
