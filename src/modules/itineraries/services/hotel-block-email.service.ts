import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { renderHotelBlockEmailHtml, type HotelBlockEmailTemplateInput } from '../templates/hotel-block-email.template';

type HoldRequest = {
  hotelName?: string | null;
  provider?: string | null;
  checkIn?: Date | string | null;
  checkOut?: Date | string | null;
  roomType?: string | null;
  mealPlan?: string | null;
  roomCount?: number | null;
  status?: string | null;
  responseUrl?: string | null;
  emailKind?: 'REQUEST' | 'EXTENSION' | 'CANCELLATION' | 'REMINDER';
  previousCutoffAt?: Date | string | null;
  cutoffAt?: Date | string | null;
  stayDetails?: HotelBlockEmailTemplateInput['stayDetails'];
};

@Injectable()
export class HotelBlockEmailService {
  private readonly logger = new Logger(HotelBlockEmailService.name);
  private transporter: Transporter | null = null;

  private enabled() {
    return ['1', 'true', 'yes'].includes(String(process.env.HOTEL_BLOCK_EMAIL_ENABLED || '').trim().toLowerCase());
  }

  private demoMode() {
    return ['1', 'true', 'yes'].includes(String(process.env.DEMO_HOTEL_EMAIL || '').trim().toLowerCase());
  }

  deliveryRecipient(originalRecipient: string) {
    if (!this.demoMode()) return originalRecipient;
    return String(process.env.DEMO_HOTEL_EMAIL_RECIPIENT || 'dvilabs.ai@gmail.com').trim();
  }

  private formatDate(value: unknown) {
    const date = value ? new Date(String(value)) : null;
    return date && !Number.isNaN(date.getTime())
      ? date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
      : '--';
  }

  private formatDateTime(value: unknown) {
    const date = value ? new Date(String(value)) : null;
    return date && !Number.isNaN(date.getTime())
      ? date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
      : '--';
  }

  private getTransporter() {
    if (this.transporter) return this.transporter;
    const host = String(process.env.SMTP_HOST || '').trim();
    const from = String(process.env.SMTP_FROM || '').trim();
    if (!host || !from) throw new Error('Hotel block SMTP is not configured.');
    this.transporter = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT || 587),
      secure: ['1', 'true', 'yes'].includes(String(process.env.SMTP_SECURE || '').toLowerCase()),
      auth: process.env.SMTP_USER
        ? {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS || '',
          }
        : undefined,
    });
    return this.transporter;
  }

  async dispatch(input: { recipient: string; quotationReference: string; request: HoldRequest }) {
    if (!this.enabled()) return { status: 'QUEUED' as const };
    const { recipient, quotationReference, request } = input;
    const deliveryRecipient = this.deliveryRecipient(recipient);
    const responseUrl = String(request.responseUrl || '').trim();
    const stayDetails = Array.isArray(request.stayDetails) ? request.stayDetails : [];
    const isExtension = request.emailKind === 'EXTENSION';
    const isCancellation = request.emailKind === 'CANCELLATION';
    const subject = `DVi Travel | ${isCancellation ? 'Hotel Hold No Longer Required' : isExtension ? 'Hotel Hold Extended' : 'Hotel Blocking Request'} | ${quotationReference}`;
    const text = [
      'Dear Hotel Team,',
      '',
      ...(this.demoMode()
        ? [
            'DEMO NOTICE: This email is being delivered to the configured demo inbox instead of the hotelier.',
            `Intended hotelier email: ${recipient}`,
            'The real hotelier has not been contacted while demo mode is enabled.',
            '',
          ]
        : []),
      ...(isCancellation
        ? [
            `The hotel selection for quotation ${quotationReference} has changed.`,
            'The previous hotel hold is no longer required. Please release or ignore the rooms associated with this request.',
          ]
        : isExtension
        ? [
            `The hotel hold for quotation ${quotationReference} has been extended.`,
            `Previous hold until: ${this.formatDateTime(request.previousCutoffAt)}`,
            `New hold until: ${this.formatDateTime(request.cutoffAt)}`,
            'Please retain the blocked rooms until the new hold time.',
          ]
        : [`Please confirm availability and block the requested room for quotation ${quotationReference}.`]),
      `Hotel: ${request.hotelName || '--'}`,
      `Check-in: ${this.formatDate(request.checkIn)}`,
      `Check-out: ${this.formatDate(request.checkOut)}`,
      `Rooms: ${request.roomCount || 0}`,
      `Room category: ${request.roomType || '--'}`,
      `Meal plan: ${request.mealPlan || '--'}`,
      ...(stayDetails.length > 1
        ? [
            '',
            'Nightly stay details:',
            ...stayDetails.map((detail) => `- ${this.formatDate(detail.checkIn)}${detail.checkOut && this.formatDate(detail.checkOut) !== this.formatDate(detail.checkIn) ? ` to ${this.formatDate(detail.checkOut)}` : ''} | ${detail.roomType || '--'} | ${detail.mealPlan || '--'} | Rooms: ${Number(detail.roomCount || 0)}`),
          ]
        : []),
      '',
      ...(isCancellation ? [] : [
        'Please use this secure response link to confirm availability, cutoff and booking status:',
        responseUrl,
      ]),
      '',
      'Regards,',
      'DVi Travel Operations',
    ].join('\n');
    const html = renderHotelBlockEmailHtml({
      quotationReference,
      hotelName: String(request.hotelName || '--'),
      provider: String(request.provider || '--'),
      checkIn: this.formatDate(request.checkIn),
      checkOut: this.formatDate(request.checkOut),
      roomType: String(request.roomType || '--'),
      mealPlan: String(request.mealPlan || '--'),
      roomCount: Number(request.roomCount || 0),
      responseUrl,
      demoMode: this.demoMode(),
      intendedRecipient: recipient,
      emailKind: request.emailKind,
      previousCutoffAt: this.formatDateTime(request.previousCutoffAt),
      cutoffAt: this.formatDateTime(request.cutoffAt),
      stayDetails: stayDetails.map((detail) => ({
        checkIn: this.formatDate(detail.checkIn),
        checkOut: this.formatDate(detail.checkOut),
        roomType: String(detail.roomType || '--'),
        mealPlan: String(detail.mealPlan || '--'),
        roomCount: Number(detail.roomCount || 0),
      })),
    });
    const info = await this.getTransporter().sendMail({
      from: String(process.env.SMTP_FROM),
      to: deliveryRecipient,
      subject,
      text,
      html,
    });
    return { status: 'SENT' as const, providerMessageId: String(info.messageId || '') || null, recipient: deliveryRecipient };
  }

  async dispatchReminder(input: {
    recipient: string;
    quotationReference: string;
    itineraryUrl: string;
    request: HoldRequest;
  }) {
    if (!this.enabled()) return { status: 'QUEUED' as const };
    const { recipient, quotationReference, itineraryUrl, request } = input;
    const stayDetails = Array.isArray(request.stayDetails) ? request.stayDetails : [];
    const deliveryRecipient = this.deliveryRecipient(recipient);
    const subject = `DVi Travel | Hotel Hold Expires in 24 Hours | ${quotationReference}`;
    const text = [
      'Dear DVi Travel Team,',
      '',
      ...(this.demoMode()
        ? [
            'DEMO NOTICE: This email is being delivered to the configured demo inbox instead of the intended recipient.',
            `Intended recipient: ${recipient}`,
            'The intended recipient has not been contacted while demo mode is enabled.',
            '',
          ]
        : []),
      `The blocked hotel hold for quotation ${quotationReference} will expire in 24 hours.`,
      'Please review the itinerary and confirm the hotel before the cutoff.',
      '',
      `Hotel: ${request.hotelName || '--'}`,
      `Check-in: ${this.formatDate(request.checkIn)}`,
      `Check-out: ${this.formatDate(request.checkOut)}`,
      `Rooms: ${request.roomCount || 0}`,
      `Hold expires: ${this.formatDateTime(request.cutoffAt)}`,
      '',
      'Open the itinerary and confirm the hotel:',
      itineraryUrl,
      '',
      'Regards,',
      'DVi Travel Operations',
    ].join('\n');
    const html = renderHotelBlockEmailHtml({
      quotationReference,
      hotelName: String(request.hotelName || '--'),
      provider: String(request.provider || '--'),
      checkIn: this.formatDate(request.checkIn),
      checkOut: this.formatDate(request.checkOut),
      roomType: String(request.roomType || '--'),
      mealPlan: String(request.mealPlan || '--'),
      roomCount: Number(request.roomCount || 0),
      responseUrl: '',
      itineraryUrl,
      demoMode: this.demoMode(),
      intendedRecipient: recipient,
      emailKind: 'REMINDER',
      cutoffAt: this.formatDateTime(request.cutoffAt),
      stayDetails: stayDetails.map((detail) => ({
        checkIn: this.formatDate(detail.checkIn),
        checkOut: this.formatDate(detail.checkOut),
        roomType: String(detail.roomType || '--'),
        mealPlan: String(detail.mealPlan || '--'),
        roomCount: Number(detail.roomCount || 0),
      })),
    });
    const info = await this.getTransporter().sendMail({
      from: String(process.env.SMTP_FROM),
      to: deliveryRecipient,
      subject,
      text,
      html,
    });
    return { status: 'SENT' as const, providerMessageId: String(info.messageId || '') || null, recipient: deliveryRecipient };
  }

  logFailure(error: unknown, recipient: string) {
    const message = error instanceof Error ? error.message : String(error || 'Unknown mail error');
    this.logger.error(`Hotel block email failed for ${recipient}: ${message}`);
    return message;
  }
}
