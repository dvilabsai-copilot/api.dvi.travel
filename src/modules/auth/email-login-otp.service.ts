import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '../../prisma.service';

export type EmailOtpPurpose = 'login' | 'registration';

type EmailOtpRecord = {
  otpHash: string;
  expiresAt: Date;
  resendAfter: Date;
  attempts: number;
};

@Injectable()
export class EmailLoginOtpService {
  private readonly logger = new Logger(EmailLoginOtpService.name);
  private readonly otpTableReady = new Map<EmailOtpPurpose, Promise<void>>();

  constructor(private readonly prisma: PrismaService) {}

  private normalizeEmail(email: string) {
    return String(email || '').trim().toLowerCase();
  }

  private tableName(purpose: EmailOtpPurpose) {
    return purpose === 'registration'
      ? 'dvi_registration_email_otps'
      : 'dvi_email_login_otps';
  }

  private hashOtp(email: string, otp: string, purpose: EmailOtpPurpose) {
    const secret = process.env.JWT_SECRET || 'supersecretjwtkey';

    return crypto
      .createHash('sha256')
      .update(`${purpose}:${this.normalizeEmail(email)}:${otp}:${secret}`)
      .digest('hex');
  }

  private async ensureOtpTable(purpose: EmailOtpPurpose) {
    const ready = this.otpTableReady.get(purpose);
    if (ready) {
      await ready;
      return;
    }

    const tableName = this.tableName(purpose);
    const indexPrefix = purpose === 'registration' ? 'registration' : 'login';
    const createPromise = this.prisma
      .$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          email VARCHAR(320) NOT NULL,
          otp_hash CHAR(64) NOT NULL,
          expires_at DATETIME(3) NOT NULL,
          resend_after DATETIME(3) NOT NULL,
          attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          PRIMARY KEY (id),
          UNIQUE KEY uq_dvi_${indexPrefix}_email_otps_email (email),
          KEY idx_dvi_${indexPrefix}_email_otps_expires_at (expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
      `)
      .then(() => undefined)
      .catch((error) => {
        this.otpTableReady.delete(purpose);
        throw error;
      });

    this.otpTableReady.set(purpose, createPromise);
    await createPromise;
  }

  private table(purpose: EmailOtpPurpose) {
    return Prisma.raw(this.tableName(purpose));
  }

  private async getOtpRecord(
    email: string,
    purpose: EmailOtpPurpose,
  ): Promise<EmailOtpRecord | null> {
    await this.ensureOtpTable(purpose);
    const table = this.table(purpose);
    const rows = await this.prisma.$queryRaw<
      Array<{
        otpHash: string;
        expiresAt: Date;
        resendAfter: Date;
        attempts: number;
      }>
    >(Prisma.sql`
      SELECT
        otp_hash AS otpHash,
        expires_at AS expiresAt,
        resend_after AS resendAfter,
        attempts
      FROM ${table}
      WHERE email = ${email}
      LIMIT 1
    `);

    return rows[0] || null;
  }

  private async deleteOtpRecord(email: string, purpose: EmailOtpPurpose) {
    await this.ensureOtpTable(purpose);
    const table = this.table(purpose);
    await this.prisma.$executeRaw(Prisma.sql`
      DELETE FROM ${table} WHERE email = ${email}
    `);
  }

  private hashesMatch(left: string, right: string) {
    const leftBuffer = Buffer.from(left, 'hex');
    const rightBuffer = Buffer.from(right, 'hex');
    return (
      leftBuffer.length === rightBuffer.length &&
      crypto.timingSafeEqual(leftBuffer, rightBuffer)
    );
  }

  async createAndSendOtp(email: string, purpose: EmailOtpPurpose = 'login') {
    const normalizedEmail = this.normalizeEmail(email);
    const existing = await this.getOtpRecord(normalizedEmail, purpose);
    const now = Date.now();

    if (existing && existing.resendAfter.getTime() > now) {
      const waitSeconds = Math.ceil((existing.resendAfter.getTime() - now) / 1000);
      throw new BadRequestException(
        `Please wait ${waitSeconds} seconds before requesting another OTP.`,
      );
    }

    const otp = crypto.randomInt(100000, 1000000).toString();
    const table = this.table(purpose);

    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO ${table}
        (email, otp_hash, expires_at, resend_after, attempts)
      VALUES
        (${normalizedEmail}, ${this.hashOtp(normalizedEmail, otp, purpose)},
         ${new Date(now + 10 * 60 * 1000)}, ${new Date(now + 60 * 1000)}, 0)
      ON DUPLICATE KEY UPDATE
        otp_hash = VALUES(otp_hash),
        expires_at = VALUES(expires_at),
        resend_after = VALUES(resend_after),
        attempts = 0,
        updated_at = CURRENT_TIMESTAMP(3)
    `);

    try {
      await this.sendOtpMail(normalizedEmail, otp, purpose);
    } catch (error) {
      await this.deleteOtpRecord(normalizedEmail, purpose);
      throw error;
    }

    return {
      message:
        purpose === 'registration'
          ? 'Verification code sent to your email.'
          : 'OTP sent to your registered email.',
    };
  }

  async verifyOtp(
    email: string,
    otp: string,
    purpose: EmailOtpPurpose = 'login',
  ) {
    const normalizedEmail = this.normalizeEmail(email);
    const record = await this.getOtpRecord(normalizedEmail, purpose);
    const now = Date.now();

    if (!record || record.expiresAt.getTime() < now) {
      await this.deleteOtpRecord(normalizedEmail, purpose);
      throw new UnauthorizedException('OTP expired. Please request a new OTP.');
    }

    if (record.attempts >= 5) {
      await this.deleteOtpRecord(normalizedEmail, purpose);
      throw new UnauthorizedException(
        'Too many invalid OTP attempts. Please request a new OTP.',
      );
    }

    const incomingHash = this.hashOtp(normalizedEmail, otp, purpose);

    if (!this.hashesMatch(incomingHash, record.otpHash)) {
      const table = this.table(purpose);
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE ${table}
        SET attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP(3)
        WHERE email = ${normalizedEmail}
      `);
      throw new UnauthorizedException('Invalid OTP.');
    }

    await this.deleteOtpRecord(normalizedEmail, purpose);
    return true;
  }

  private async sendOtpMail(
    email: string,
    otp: string,
    purpose: EmailOtpPurpose,
  ) {
    const host = process.env.SMTP_HOST || process.env.MAIL_HOST;
    const port = Number(process.env.SMTP_PORT || process.env.MAIL_PORT || 587);
    const secure = String(process.env.SMTP_SECURE || 'false') === 'true';
    const user = process.env.SMTP_USER || process.env.MAIL_USER;
    const pass = process.env.SMTP_PASS || process.env.MAIL_PASS;
    const fromAddress =
      process.env.SMTP_FROM ||
      process.env.MAIL_FROM ||
      user ||
      'no-reply@dviholidays.com';
    const fromName =
      process.env.SMTP_FROM_NAME || process.env.MAIL_FROM_NAME || '';
    const from = fromName.trim()
      ? { name: fromName.trim(), address: fromAddress }
      : fromAddress;
    const isRegistration = purpose === 'registration';
    const subject = isRegistration
      ? 'DVI Holidays Email Verification Code'
      : 'DVI Holidays Login OTP';
    const title = isRegistration
      ? 'DVI Holidays Email Verification'
      : 'DVI Holidays Login Verification';
    const intro = isRegistration
      ? 'Your email verification code is:'
      : 'Your login OTP is:';

    if (!host) {
      if (process.env.NODE_ENV !== 'production') {
        this.logger.warn(
          `SMTP is not configured. DEV OTP for ${email}: ${otp}`,
        );
        return;
      }

      throw new BadRequestException('Email service is not configured.');
    }

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user && pass ? { user, pass } : undefined,
    });

    await transporter.sendMail({
      from,
      to: email,
      subject,
      text: `${intro} ${otp}. It is valid for 10 minutes.`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #11143f;">
          <h2 style="color: #4424ff;">${title}</h2>
          <p>${intro}</p>
          <div style="font-size: 28px; font-weight: 800; letter-spacing: 6px; color: #11143f;">
            ${otp}
          </div>
          <p>This code is valid for 10 minutes.</p>
          <p>If you did not request this, please ignore this email.</p>
        </div>
      `,
    });
  }
}
