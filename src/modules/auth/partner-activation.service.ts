import {
  BadRequestException,
  GoneException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma.service';
import { EmailLoginOtpService } from './email-login-otp.service';
import { SystemRole } from './constants/system-role.constants';

type PartnerActivationRecord = {
  id: bigint;
  userId: bigint;
  agentId: number;
  email: string;
  expiresAt: Date;
  consumedAt: Date | null;
};

const ACTIVATION_TTL_HOURS = 24;
const ACTIVATION_RESEND_SECONDS = 60;

@Injectable()
export class PartnerActivationService {
  private activationTableReady?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailLoginOtp: EmailLoginOtpService,
  ) {}

  private normalizeEmail(email: string) {
    return String(email || '').trim().toLowerCase();
  }

  private hashToken(token: string) {
    return crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');
  }

  private async ensureActivationTable() {
    if (this.activationTableReady) {
      await this.activationTableReady;
      return;
    }

    const createPromise = this.prisma
      .$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS dvi_partner_activation_links (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          user_id BIGINT UNSIGNED NOT NULL,
          agent_id INT NOT NULL,
          email VARCHAR(320) NOT NULL,
          token_hash CHAR(64) NOT NULL,
          expires_at DATETIME(3) NOT NULL,
          resend_after DATETIME(3) NOT NULL,
          consumed_at DATETIME(3) NULL,
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          PRIMARY KEY (id),
          UNIQUE KEY uq_dvi_partner_activation_token_hash (token_hash),
          KEY idx_dvi_partner_activation_user_id (user_id),
          KEY idx_dvi_partner_activation_email (email),
          KEY idx_dvi_partner_activation_expires_at (expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
      `)
      .then(() => undefined)
      .catch((error) => {
        this.activationTableReady = undefined;
        throw error;
      });

    this.activationTableReady = createPromise;
    await createPromise;
  }

  private getFrontendBaseUrl() {
    const configured = String(
      process.env.FRONTEND_URL ||
        process.env.DVI_FRONTEND_URL ||
        process.env.PUBLIC_ITINERARY_BASE_URL ||
        process.env.BASE_URL ||
        '',
    ).trim();

    const normalized = configured
      .replace(/\/+$/, '')
      .replace(/\/api\/v1$/i, '');

    if (normalized) {
      return normalized;
    }

    return process.env.NODE_ENV === 'production'
      ? 'https://dvi.travel'
      : 'http://localhost:8080';
  }

  private buildActivationUrl(rawToken: string) {
    return `${this.getFrontendBaseUrl()}/partner-activation/${rawToken}`;
  }

  private async getLatestActivationForUser(
    userId: bigint,
  ) {
    await this.ensureActivationTable();

    const rows = await this.prisma.$queryRaw<
      Array<{
        resendAfter: Date;
        consumedAt: Date | null;
      }>
    >`
      SELECT
        resend_after AS resendAfter,
        consumed_at AS consumedAt
      FROM dvi_partner_activation_links
      WHERE user_id = ${userId}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `;

    return rows[0] || null;
  }

  async createAndSendActivationLink(input: {
    userId: bigint;
    agentId: number;
    email: string;
    companyName?: string | null;
  }) {
    await this.ensureActivationTable();

    const normalizedEmail =
      this.normalizeEmail(input.email);

    const now = Date.now();

    const latest =
      await this.getLatestActivationForUser(
        input.userId,
      );

    if (
      latest &&
      !latest.consumedAt &&
      latest.resendAfter.getTime() > now
    ) {
      const waitSeconds = Math.ceil(
        (latest.resendAfter.getTime() - now) /
          1000,
      );

      throw new BadRequestException(
        `Please wait ${waitSeconds} seconds before requesting another activation email.`,
      );
    }

    const rawToken =
      crypto
        .randomBytes(32)
        .toString('base64url');

    const tokenHash =
      this.hashToken(rawToken);

    const expiresAt = new Date(
      now +
        ACTIVATION_TTL_HOURS *
          60 *
          60 *
          1000,
    );

    const resendAfter = new Date(
      now +
        ACTIVATION_RESEND_SECONDS *
          1000,
    );

    await this.prisma.$executeRaw`
      INSERT INTO dvi_partner_activation_links
        (
          user_id,
          agent_id,
          email,
          token_hash,
          expires_at,
          resend_after
        )
      VALUES
        (
          ${input.userId},
          ${input.agentId},
          ${normalizedEmail},
          ${tokenHash},
          ${expiresAt},
          ${resendAfter}
        )
    `;

    const activationUrl =
      this.buildActivationUrl(rawToken);

    try {
      await this.emailLoginOtp
        .sendPartnerActivationMail(
          normalizedEmail,
          activationUrl,
          input.companyName,
          ACTIVATION_TTL_HOURS,
        );
    } catch (error) {
      await this.prisma.$executeRaw`
        DELETE FROM dvi_partner_activation_links
        WHERE user_id = ${input.userId}
          AND token_hash = ${tokenHash}
      `;

      throw error;
    }

    await this.prisma.$executeRaw`
      DELETE FROM dvi_partner_activation_links
      WHERE user_id = ${input.userId}
        AND token_hash <> ${tokenHash}
        AND consumed_at IS NULL
    `;

    return {
      message:
        'Activation link sent to your registered email.',
      expiresAt,
    };
  }

  async activatePartnerToken(
    token: string,
  ) {
    await this.ensureActivationTable();

    const normalizedToken =
      String(token || '').trim();

    if (
      normalizedToken.length < 32 ||
      normalizedToken.length > 200 ||
      !/^[A-Za-z0-9_-]+$/.test(
        normalizedToken,
      )
    ) {
      throw new BadRequestException(
        'This activation link is invalid.',
      );
    }

    const tokenHash =
      this.hashToken(normalizedToken);

    const rows =
      await this.prisma.$queryRaw<
        PartnerActivationRecord[]
      >`
        SELECT
          id,
          user_id AS userId,
          agent_id AS agentId,
          email,
          expires_at AS expiresAt,
          consumed_at AS consumedAt
        FROM dvi_partner_activation_links
        WHERE token_hash = ${tokenHash}
        LIMIT 1
      `;

    const record = rows[0];

    if (!record) {
      throw new BadRequestException(
        'This activation link is invalid.',
      );
    }

    if (record.consumedAt) {
      throw new GoneException(
        'This activation link has already been used. Please sign in instead.',
      );
    }

    const now = new Date();

    if (
      record.expiresAt.getTime() <=
      now.getTime()
    ) {
      throw new GoneException(
        'This activation link has expired. Please request a new activation email.',
      );
    }

    await this.prisma.$transaction(
      async (tx) => {
        const user =
          await tx.dvi_users.findUnique({
            where: {
              userID: record.userId,
            },
          });

        if (
          !user ||
          Number(user.deleted || 0) !== 0 ||
          Number(user.roleID || 0) !==
            SystemRole.AGENT ||
          Number(user.agent_id || 0) !==
            Number(record.agentId) ||
          this.normalizeEmail(
            user.useremail || '',
          ) !==
            this.normalizeEmail(
              record.email,
            )
        ) {
          throw new UnauthorizedException(
            'This partner activation link is no longer valid.',
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

        const agent =
          await tx.dvi_agent.findFirst({
            where: {
              agent_ID:
                Number(record.agentId),
              status: 1,
              deleted: 0,
            },
            select: {
              agent_ID: true,
              agent_email_id: true,
            },
          });

        if (
          !agent ||
          this.normalizeEmail(
            agent.agent_email_id || '',
          ) !==
            this.normalizeEmail(
              record.email,
            )
        ) {
          throw new UnauthorizedException(
            'This partner activation link is no longer valid.',
          );
        }

        const approvedRows =
          await tx.$executeRaw`
            UPDATE dvi_users
            SET
              userapproved = 1,
              userbanned = 0,
              status = 1,
              updatedon = ${now}
            WHERE userID = ${record.userId}
              AND deleted = 0
              AND status = 1
              AND COALESCE(userbanned, 0) = 0
              AND roleID = ${SystemRole.AGENT}
              AND agent_id = ${record.agentId}
          `;

        if (
          Number(approvedRows) !== 1
        ) {
          throw new UnauthorizedException(
            'This account cannot be activated. Please contact support.',
          );
        }

        const consumedRows =
          await tx.$executeRaw`
            UPDATE dvi_partner_activation_links
            SET
              consumed_at = ${now},
              updated_at =
                CURRENT_TIMESTAMP(3)
            WHERE id = ${record.id}
              AND token_hash = ${tokenHash}
              AND consumed_at IS NULL
              AND expires_at > ${now}
          `;

        if (
          Number(consumedRows) !== 1
        ) {
          throw new GoneException(
            'This activation link has already been used or has expired.',
          );
        }

        await tx.$executeRaw`
          UPDATE dvi_partner_activation_links
          SET
            consumed_at =
              COALESCE(
                consumed_at,
                ${now}
              ),
            updated_at =
              CURRENT_TIMESTAMP(3)
          WHERE user_id = ${record.userId}
            AND consumed_at IS NULL
        `;
      },
    );

    return record.userId;
  }
}