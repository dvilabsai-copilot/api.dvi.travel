import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import * as nodemailer from 'nodemailer';

type EmailOtpRecord = {
  otpHash: string;
  expiresAt: number;
  resendAfter: number;
  attempts: number;
};

@Injectable()
export class EmailLoginOtpService {
  private readonly logger = new Logger(EmailLoginOtpService.name);
  private readonly otpStore = new Map<string, EmailOtpRecord>();

  private normalizeEmail(email: string) {
    return String(email || '').trim().toLowerCase();
  }

  private hashOtp(email: string, otp: string) {
    const secret = process.env.JWT_SECRET || 'supersecretjwtkey';

    return crypto
      .createHash('sha256')
      .update(`${this.normalizeEmail(email)}:${otp}:${secret}`)
      .digest('hex');
  }

  async createAndSendOtp(email: string) {
    const normalizedEmail = this.normalizeEmail(email);
    const existing = this.otpStore.get(normalizedEmail);
    const now = Date.now();

    if (existing && existing.resendAfter > now) {
      const waitSeconds = Math.ceil((existing.resendAfter - now) / 1000);
      throw new BadRequestException(
        `Please wait ${waitSeconds} seconds before requesting another OTP.`,
      );
    }

    const otp = crypto.randomInt(100000, 1000000).toString();

    this.otpStore.set(normalizedEmail, {
      otpHash: this.hashOtp(normalizedEmail, otp),
      expiresAt: now + 10 * 60 * 1000,
      resendAfter: now + 60 * 1000,
      attempts: 0,
    });

    await this.sendOtpMail(normalizedEmail, otp);

    return {
      message: 'OTP sent to your registered email.',
    };
  }

  async verifyOtp(email: string, otp: string) {
    const normalizedEmail = this.normalizeEmail(email);
    const record = this.otpStore.get(normalizedEmail);
    const now = Date.now();

    if (!record || record.expiresAt < now) {
      this.otpStore.delete(normalizedEmail);
      throw new UnauthorizedException('OTP expired. Please request a new OTP.');
    }

    if (record.attempts >= 5) {
      this.otpStore.delete(normalizedEmail);
      throw new UnauthorizedException(
        'Too many invalid OTP attempts. Please request a new OTP.',
      );
    }

    const incomingHash = this.hashOtp(normalizedEmail, otp);

    if (incomingHash !== record.otpHash) {
      record.attempts += 1;
      this.otpStore.set(normalizedEmail, record);
      throw new UnauthorizedException('Invalid OTP.');
    }

    this.otpStore.delete(normalizedEmail);
    return true;
  }

  private async sendOtpMail(email: string, otp: string) {
    const host = process.env.SMTP_HOST || process.env.MAIL_HOST;
    const port = Number(process.env.SMTP_PORT || process.env.MAIL_PORT || 587);
    const secure = String(process.env.SMTP_SECURE || 'false') === 'true';
    const user = process.env.SMTP_USER || process.env.MAIL_USER;
    const pass = process.env.SMTP_PASS || process.env.MAIL_PASS;
    const from =
      process.env.SMTP_FROM ||
      process.env.MAIL_FROM ||
      user ||
      'no-reply@dviholidays.com';

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
      subject: 'DVI Holidays Login OTP',
      text: `Your DVI Holidays login OTP is ${otp}. It is valid for 10 minutes.`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #11143f;">
          <h2 style="color: #4424ff;">DVI Holidays Login Verification</h2>
          <p>Your login OTP is:</p>
          <div style="font-size: 28px; font-weight: 800; letter-spacing: 6px; color: #11143f;">
            ${otp}
          </div>
          <p>This OTP is valid for 10 minutes.</p>
          <p>If you did not request this login OTP, please ignore this email.</p>
        </div>
      `,
    });
  }
}