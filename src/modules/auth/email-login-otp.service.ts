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

  private escapeHtml(value: unknown) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  async sendPartnerActivationMail(
    email: string,
    activationUrl: string,
    companyName?: string | null,
    validForHours = 24,
  ) {
    const host =
      process.env.SMTP_HOST ||
      process.env.MAIL_HOST;

    const port = Number(
      process.env.SMTP_PORT ||
        process.env.MAIL_PORT ||
        587,
    );

    const secure =
      String(
        process.env.SMTP_SECURE ||
          'false',
      ) === 'true';

    const user =
      process.env.SMTP_USER ||
      process.env.MAIL_USER;

    const pass =
      process.env.SMTP_PASS ||
      process.env.MAIL_PASS;

    const fromAddress =
      process.env.SMTP_FROM ||
      process.env.MAIL_FROM ||
      user ||
      'no-reply@dviholidays.com';

    const fromName =
      process.env.SMTP_FROM_NAME ||
      process.env.MAIL_FROM_NAME ||
      '';

    const from = fromName.trim()
      ? {
          name: fromName.trim(),
          address: fromAddress,
        }
      : fromAddress;

    if (!host) {
      if (
        process.env.NODE_ENV !==
        'production'
      ) {
        this.logger.warn(
          `SMTP is not configured. DEV activation link for ${email}: ${activationUrl}`,
        );
        return;
      }

      throw new BadRequestException(
        'Email service is not configured.',
      );
    }

    const transporter =
      nodemailer.createTransport({
        host,
        port,
        secure,
        auth:
          user && pass
            ? {
                user,
                pass,
              }
            : undefined,
      });

  

    const safeActivationUrl =
      this.escapeHtml(
        activationUrl,
      );

    await transporter.sendMail({
  from,
  to: email,
  subject:
    'Welcome to DVI B2B Travel Network - Activate Your Account',
  text: [
    'Dear Travel Partner,',
    '',
    'Greetings from Doview Holidays India Pvt. Ltd.',
    '',
    'Thank you for registering with us. We are delighted to welcome you to the DVI B2B travel network.',
    '',
    'DVI has been serving the travel trade with a strong focus on Hotels, Transportation, Holiday Packages, Activities and Ground Handling Services, supported by extensive operational experience across South India and other key destinations in India.',
    '',
    'By registering with DVI, you can benefit from:',
    '',
    '• Live hotel availability wherever available; properties marked Offline will be handled by our team',
    '• Competitive B2B hotel and package rates',
    '• Reliable transportation and ground-handling support',
    '• Faster itinerary and quotation creation',
    '• Smart route planning and practical sightseeing schedules',
    '• Access to holiday packages, activities and destination services',
    '• Dedicated Sales and Operations support',
    '• A single platform to simplify your travel requirements',
    '',
    'To start using your account, please activate your registration using the activation link below. Once activated, you can log in and begin exploring the available services and features.',
    '',
    activationUrl,
    '',
    `This activation link is valid for ${validForHours} hours and can be used only once.`,
    '',
    'Our objective is to help our travel partners respond faster, sell better and operate more efficiently.',
    '',
    'We sincerely value your association and look forward to building a long-term business relationship with you.',
    '',
    'Welcome to DVI.',
    '',
    'Warm regards,',
    'Team DVI',
    'Doview Holidays India Pvt. Ltd.',
    'dvi.travel',
  ].join('\n'),
  html: `
    <table
      role="presentation"
      width="100%"
      cellspacing="0"
      cellpadding="0"
      border="0"
      style="
        width: 100%;
        margin: 0;
        padding: 0;
        background-color: #f5f3ff;
        font-family: Arial, Helvetica, sans-serif;
      "
    >
      <tr>
        <td
          align="center"
          style="padding: 32px 16px;"
        >
          <table
            role="presentation"
            width="100%"
            cellspacing="0"
            cellpadding="0"
            border="0"
            style="
              width: 100%;
              max-width: 680px;
              background-color: #ffffff;
              border: 1px solid #ebe8ff;
              border-radius: 16px;
              overflow: hidden;
            "
          >
            <tr>
              <td
                align="center"
                bgcolor="#4424ff"
                style="
                  padding: 32px 24px;
                  background-color: #4424ff;
                "
              >
                <div
                  style="
                    font-size: 13px;
                    line-height: 20px;
                    font-weight: 700;
                    letter-spacing: 2px;
                    color: #ddd8ff;
                    text-transform: uppercase;
                  "
                >
                  DVI HOLIDAYS
                </div>

                <div
                  style="
                    margin-top: 8px;
                    font-size: 28px;
                    line-height: 36px;
                    font-weight: 800;
                    color: #ffffff;
                  "
                >
                  Welcome to the DVI B2B Network
                </div>

                <div
                  style="
                    margin-top: 10px;
                    font-size: 14px;
                    line-height: 22px;
                    color: #e9e6ff;
                  "
                >
                  Your trusted travel partner for seamless B2B travel services
                </div>
              </td>
            </tr>

            <tr>
              <td
                style="
                  padding: 34px 36px 20px;
                  color: #20213d;
                  font-size: 15px;
                  line-height: 24px;
                "
              >
                <p style="margin: 0 0 20px;">
                  Dear Travel Partner,
                </p>

                <p style="margin: 0 0 20px;">
                  Greetings from
                  <strong>Doview Holidays India Pvt. Ltd.</strong>
                </p>

                <p style="margin: 0 0 20px;">
                  Thank you for registering with us. We are delighted to welcome you to the
                  <strong>DVI B2B travel network</strong>.
                </p>

                <p style="margin: 0 0 24px;">
                  DVI has been serving the travel trade with a strong focus on
                  <strong>
                    Hotels, Transportation, Holiday Packages, Activities and Ground Handling Services
                  </strong>,
                  supported by extensive operational experience across South India and other key destinations in India.
                </p>

                <div
                  style="
                    margin: 0 0 14px;
                    font-size: 17px;
                    line-height: 24px;
                    font-weight: 700;
                    color: #11143f;
                  "
                >
                  Why partner with DVI?
                </div>

                <table
                  role="presentation"
                  width="100%"
                  cellspacing="0"
                  cellpadding="0"
                  border="0"
                  style="width: 100%;"
                >
                  <tr>
                    <td
                      valign="top"
                      width="28"
                      style="
                        width: 28px;
                        padding: 5px 0;
                        color: #4424ff;
                        font-weight: 700;
                      "
                    >
                      ✓
                    </td>
                    <td style="padding: 5px 0;">
                      <strong>Live hotel availability</strong> wherever available; properties marked
                      <strong>Offline</strong> will be handled by our team
                    </td>
                  </tr>

                  <tr>
                    <td
                      valign="top"
                      width="28"
                      style="padding: 5px 0; color: #4424ff; font-weight: 700;"
                    >
                      ✓
                    </td>
                    <td style="padding: 5px 0;">
                      Competitive B2B hotel and package rates
                    </td>
                  </tr>

                  <tr>
                    <td
                      valign="top"
                      width="28"
                      style="padding: 5px 0; color: #4424ff; font-weight: 700;"
                    >
                      ✓
                    </td>
                    <td style="padding: 5px 0;">
                      Reliable transportation and ground-handling support
                    </td>
                  </tr>

                  <tr>
                    <td
                      valign="top"
                      width="28"
                      style="padding: 5px 0; color: #4424ff; font-weight: 700;"
                    >
                      ✓
                    </td>
                    <td style="padding: 5px 0;">
                      Faster itinerary and quotation creation
                    </td>
                  </tr>

                  <tr>
                    <td
                      valign="top"
                      width="28"
                      style="padding: 5px 0; color: #4424ff; font-weight: 700;"
                    >
                      ✓
                    </td>
                    <td style="padding: 5px 0;">
                      Smart route planning and practical sightseeing schedules
                    </td>
                  </tr>

                  <tr>
                    <td
                      valign="top"
                      width="28"
                      style="padding: 5px 0; color: #4424ff; font-weight: 700;"
                    >
                      ✓
                    </td>
                    <td style="padding: 5px 0;">
                      Access to holiday packages, activities and destination services
                    </td>
                  </tr>

                  <tr>
                    <td
                      valign="top"
                      width="28"
                      style="padding: 5px 0; color: #4424ff; font-weight: 700;"
                    >
                      ✓
                    </td>
                    <td style="padding: 5px 0;">
                      Dedicated Sales and Operations support
                    </td>
                  </tr>

                  <tr>
                    <td
                      valign="top"
                      width="28"
                      style="padding: 5px 0; color: #4424ff; font-weight: 700;"
                    >
                      ✓
                    </td>
                    <td style="padding: 5px 0;">
                      A single platform to simplify your travel requirements
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding: 10px 36px 30px;">
                <table
                  role="presentation"
                  width="100%"
                  cellspacing="0"
                  cellpadding="0"
                  border="0"
                  style="
                    width: 100%;
                    background-color: #f7f5ff;
                    border: 1px solid #ded9ff;
                    border-radius: 12px;
                  "
                >
                  <tr>
                    <td
                      align="center"
                      style="padding: 28px 24px;"
                    >
                      <div
                        style="
                          font-size: 20px;
                          line-height: 28px;
                          font-weight: 800;
                          color: #11143f;
                        "
                      >
                        Activate Your DVI Account
                      </div>

                      <div
                        style="
                          margin-top: 10px;
                          font-size: 14px;
                          line-height: 22px;
                          color: #5f617f;
                        "
                      >
                        To start using your account, please activate your registration.
                        Once activated, you can begin exploring the available services and features.
                      </div>

                      <table
                        role="presentation"
                        cellspacing="0"
                        cellpadding="0"
                        border="0"
                        align="center"
                        style="margin: 24px auto 16px;"
                      >
                        <tr>
                          <td
                            align="center"
                            bgcolor="#4424ff"
                            style="
                              background-color: #4424ff;
                              border-radius: 8px;
                            "
                          >
                            <a
                              href="${safeActivationUrl}"
                              style="
                                display: inline-block;
                                padding: 14px 30px;
                                color: #ffffff;
                                font-size: 16px;
                                line-height: 20px;
                                font-weight: 700;
                                text-decoration: none;
                              "
                            >
                              Activate Account
                            </a>
                          </td>
                        </tr>
                      </table>

                      <div
                        style="
                          font-size: 12px;
                          line-height: 19px;
                          color: #777995;
                        "
                      >
                        Secure one-time activation link &bull; Valid for ${validForHours} hours
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td
                style="
                  padding: 0 36px 32px;
                  color: #20213d;
                  font-size: 15px;
                  line-height: 24px;
                "
              >
                <p style="margin: 0 0 10px;">
                  If the button above does not work, copy and paste this link into your browser:
                </p>

                <p
                  style="
                    margin: 0 0 26px;
                    padding: 12px 14px;
                    background-color: #f8f8fb;
                    border: 1px solid #ececf3;
                    border-radius: 8px;
                    font-size: 12px;
                    line-height: 19px;
                    word-break: break-all;
                  "
                >
                  <a
                    href="${safeActivationUrl}"
                    style="
                      color: #4424ff;
                      text-decoration: underline;
                    "
                  >
                    ${safeActivationUrl}
                  </a>
                </p>

                <p style="margin: 0 0 20px;">
                  Our objective is to help our travel partners
                  <strong>
                    respond faster, sell better and operate more efficiently
                  </strong>.
                </p>

                <p style="margin: 0 0 20px;">
                  We sincerely value your association and look forward to building a long-term business relationship with you.
                </p>

                <p style="margin: 0 0 24px;">
                  Welcome to DVI.
                </p>

                <p style="margin: 0;">
                  Warm regards,<br />
                  <strong>Team DVI</strong><br />
                  Doview Holidays India Pvt. Ltd.<br />
                  <strong>dvi.travel</strong>
                </p>
              </td>
            </tr>

            <tr>
              <td
                align="center"
                style="
                  padding: 20px 24px;
                  border-top: 1px solid #eceaf7;
                  background-color: #faf9ff;
                  color: #85869c;
                  font-size: 11px;
                  line-height: 18px;
                "
              >
                Doview Holidays India Pvt. Ltd.<br />
                DVI B2B Travel Network
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `,
});
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
