import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';

type AxisroomsEmailPayload = {
  eventType: 'inventoryUpdate' | 'rateUpdate' | 'restrictionUpdate';
  propertyId: string;
  hotelId?: number;
  hotelName?: string;
  roomId?: string;
  rateplanId?: string;
  rowCount?: number;
  details?: string[];
};

@Injectable()
export class AxisroomsEmailNotifierService {
  private readonly logger = new Logger(AxisroomsEmailNotifierService.name);
  private transporter: Transporter | null = null;
  private warnedDisabled = false;

  private isEnabled(): boolean {
    const value = String(process.env.AXISROOMS_MAIL_ENABLED ?? 'true').toLowerCase();
    return value === '1' || value === 'true' || value === 'yes';
  }

  private parseEmails(value?: string): string[] {
    return String(value || '')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => !!v);
  }

  private getTransporter(): Transporter | null {
    if (!this.isEnabled()) {
      if (!this.warnedDisabled) {
        this.logger.warn('AxisRooms email notifier disabled via AXISROOMS_MAIL_ENABLED');
        this.warnedDisabled = true;
      }
      return null;
    }

    if (this.transporter) return this.transporter;

    const host = String(process.env.AXISROOMS_MAIL_HOST || '').trim();
    const port = Number(process.env.AXISROOMS_MAIL_PORT || 2525);
    const secure = String(process.env.AXISROOMS_MAIL_SECURE || 'false').toLowerCase() === 'true';
    const user = String(process.env.AXISROOMS_MAIL_USER || '').trim();
    const pass = String(process.env.AXISROOMS_MAIL_PASS || '').trim();

    if (!host || !user || !pass) {
      this.logger.warn('AxisRooms mail config incomplete (AXISROOMS_MAIL_HOST/USER/PASS)');
      return null;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });

    return this.transporter;
  }

  async sendActionableUpdateEmail(payload: AxisroomsEmailPayload): Promise<void> {
    try {
      const transporter = this.getTransporter();
      if (!transporter) return;

      const to = this.parseEmails(process.env.AXISROOMS_MAIL_TO);
      const cc = this.parseEmails(process.env.AXISROOMS_MAIL_CC);
      const bcc = this.parseEmails(process.env.AXISROOMS_MAIL_BCC);

      if (to.length === 0 && cc.length === 0 && bcc.length === 0) {
        this.logger.warn('AxisRooms mail recipients are empty (AXISROOMS_MAIL_TO/CC/BCC)');
        return;
      }

      const from =
        String(process.env.AXISROOMS_MAIL_FROM || '').trim() ||
        String(process.env.AXISROOMS_MAIL_USER || '').trim();

      const subject = `AxisRooms ${payload.eventType} received for ${payload.propertyId}`;
      const bodyLines = [
        `Event: ${payload.eventType}`,
        `Property ID: ${payload.propertyId}`,
        `Hotel: ${payload.hotelName || '-'}${payload.hotelId ? ` (${payload.hotelId})` : ''}`,
        `Room ID: ${payload.roomId || '-'}`,
        `Rateplan ID: ${payload.rateplanId || '-'}`,
        `Rows/Periods: ${payload.rowCount ?? '-'}`,
        `Received At: ${new Date().toISOString()}`,
      ];

      if (payload.details?.length) {
        bodyLines.push('', 'Updated Values:');
        for (const detail of payload.details) {
          bodyLines.push(`- ${detail}`);
        }
      }

      await transporter.sendMail({
        from,
        to: to.length ? to : undefined,
        cc: cc.length ? cc : undefined,
        bcc: bcc.length ? bcc : undefined,
        subject,
        text: bodyLines.join('\n'),
        html: `<pre style="font-family:Arial,sans-serif">${bodyLines.join('\n')}</pre>`,
      });
    } catch (error: any) {
      this.logger.error(`AxisRooms email send failed: ${error?.message || error}`);
    }
  }
}
