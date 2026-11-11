import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { PrismaService } from '../../../prisma.service';
import { withGlobalSettingsCc } from '../../../common/utils/default-email-cc.util';
import { renderHotelBlockEmailHtml, type HotelBlockEmailTemplateInput } from '../templates/hotel-block-email.template';
import type { HoldNotificationRecipient } from '../utils/hotel-hold-recipient.util';

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
  emailKind?: 'REQUEST' | 'EXTENSION' | 'CANCELLATION' | 'REMINDER' | 'HOLD_NOTICE' | 'HOLD_CREATED' | 'HOLD_EXTENSION_NOTICE' | 'RELEASE' | 'HOLD_EXPIRED_AGENT';
  previousCutoffAt?: Date | string | null;
  cutoffAt?: Date | string | null;
  stayDetails?: HotelBlockEmailTemplateInput['stayDetails'];
  remainingTime?: string;
  guestName?: string | null;
  originalHoldReference?: string | null;
  releaseReason?: 'EXPIRED' | 'CANCELLED';
  releaseRequestedAt?: Date | string | null;
};

@Injectable()
export class HotelBlockEmailService {
  private readonly logger = new Logger(HotelBlockEmailService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly prisma: PrismaService) {}

  private enabled() {
    return ['1', 'true', 'yes'].includes(String(process.env.HOTEL_BLOCK_EMAIL_ENABLED || '').trim().toLowerCase());
  }

  isDispatchEnabled() {
    return this.enabled();
  }

  private demoMode() {
    return ['1', 'true', 'yes'].includes(String(process.env.DEMO_HOTEL_EMAIL || '').trim().toLowerCase());
  }

  deliveryRecipient(originalRecipient: string, lifecycleNotification = false) {
    if (lifecycleNotification) return 'dhisoftai@gmail.com';
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
    const lifecycleTestDelivery = request.emailKind === 'RELEASE'
      || (request.emailKind === 'HOLD_NOTICE' && this.demoMode());
    const deliveryRecipient = this.deliveryRecipient(recipient, lifecycleTestDelivery);
    const demoDelivery = this.demoMode() || lifecycleTestDelivery;
    const responseUrl = String(request.responseUrl || '').trim();
    const stayDetails = Array.isArray(request.stayDetails) ? request.stayDetails : [];
    const isExtension = request.emailKind === 'EXTENSION' || request.emailKind === 'HOLD_EXTENSION_NOTICE';
    const isHoldExtensionNotice = request.emailKind === 'HOLD_EXTENSION_NOTICE';
    const isCancellation = request.emailKind === 'CANCELLATION';
    const isRelease = request.emailKind === 'RELEASE';
    const isCancelledRelease = isRelease && (request.releaseReason === 'CANCELLED' || request.status === 'CANCELLED');
    const isHoldNotice = request.emailKind === 'HOLD_NOTICE';
    const subject = `DVi Travel | ${isRelease ? 'Hotel Hold Release Request' : isCancellation ? 'Hotel Hold No Longer Required' : isExtension ? 'Hotel Hold Extended' : isHoldNotice ? 'Hotel Hold Created' : 'Hotel Blocking Request'} | ${quotationReference}`;
    const text = [
      'Dear Hotel Team,',
      '',
      ...(demoDelivery
        ? [
            lifecycleTestDelivery
              ? 'TEST NOTICE: This email is being delivered to dhisoftai@gmail.com instead of the hotelier.'
              : 'DEMO NOTICE: This email is being delivered to the configured demo inbox instead of the hotelier.',
            `Intended hotelier email: ${recipient}`,
            lifecycleTestDelivery
              ? 'The real hotelier has not been contacted.'
              : 'The real hotelier has not been contacted while demo mode is enabled.',
            '',
          ]
        : []),
      ...(isCancellation
        ? [
            `The hotel selection for quotation ${quotationReference} has changed.`,
            'The previous hotel hold is no longer required. Please release or ignore the rooms associated with this request.',
          ]
        : isRelease
        ? [
            isCancelledRelease
              ? `The hotel hold for quotation ${quotationReference} was cancelled at ${this.formatDateTime(request.releaseRequestedAt || request.cutoffAt)}.`
              : `The unpaid hotel hold for quotation ${quotationReference} expired at ${this.formatDateTime(request.cutoffAt)}.`,
            'Please release the held rooms and reply to acknowledge the release.',
          ]
        : isExtension
        ? [
            `The hotel hold for quotation ${quotationReference} has been extended.`,
            `Previous hold until: ${this.formatDateTime(request.previousCutoffAt)}`,
            `New hold until: ${this.formatDateTime(request.cutoffAt)}`,
            'Please retain the blocked rooms until the new hold time.',
          ]
        : isHoldNotice
        ? [
            `A hold has been placed for the requested stay in quotation ${quotationReference}.`,
            'Please retain the requested rooms until the hold expires. No response link is required.',
          ]
        : isHoldExtensionNotice
        ? [
            `The hold period for quotation ${quotationReference} has been extended.`,
            `Previous hold until: ${this.formatDateTime(request.previousCutoffAt)}`,
            `New hold until: ${this.formatDateTime(request.cutoffAt)}`,
            'Please retain the requested rooms until the updated expiry time. No response link is required.',
          ]
        : [`Please confirm availability and block the requested room for quotation ${quotationReference}.`]),
      `Hotel: ${request.hotelName || '--'}`,
      `Check-in: ${this.formatDate(request.checkIn)}`,
      `Check-out: ${this.formatDate(request.checkOut)}`,
      `Rooms: ${request.roomCount || 0}`,
      ...(request.guestName ? [`Lead guest: ${request.guestName}`] : []),
      ...(request.originalHoldReference ? [`Original hold reference: ${request.originalHoldReference}`] : []),
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
      ...(isCancellation || isRelease || isHoldNotice || isHoldExtensionNotice ? [] : [
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
      demoMode: demoDelivery,
      testDelivery: lifecycleTestDelivery,
      intendedRecipient: recipient,
      emailKind: request.emailKind,
      previousCutoffAt: this.formatDateTime(request.previousCutoffAt),
      cutoffAt: this.formatDateTime(request.cutoffAt),
      guestName: String(request.guestName || ''),
      originalHoldReference: String(request.originalHoldReference || ''),
      releaseReason: request.releaseReason || (request.status === 'CANCELLED' ? 'CANCELLED' : 'EXPIRED'),
      stayDetails: stayDetails.map((detail) => ({
        checkIn: this.formatDate(detail.checkIn),
        checkOut: this.formatDate(detail.checkOut),
        roomType: String(detail.roomType || '--'),
        mealPlan: String(detail.mealPlan || '--'),
        roomCount: Number(detail.roomCount || 0),
      })),
    });
    const info = await this.getTransporter().sendMail(await withGlobalSettingsCc(this.prisma, {
      from: String(process.env.SMTP_FROM),
      to: deliveryRecipient,
      subject,
      text,
      html,
    }));
    return { status: 'SENT' as const, providerMessageId: String(info.messageId || '') || null, recipient: deliveryRecipient, testDelivery: lifecycleTestDelivery };
  }

  async dispatchAgentHoldCreated(input: {
    recipients: HoldNotificationRecipient[];
    quotationReference: string;
    itineraryUrl: string;
    request: HoldRequest;
  }) {
    if (!this.enabled()) return { status: 'QUEUED' as const };
    const { recipients, quotationReference, itineraryUrl, request } = input;
    // The pending-payment hold-created email is for the assigned Travel Expert only.
    // Keep Agent delivery available to the separate reminder/expiry workflows.
    const intendedRecipients = recipients.filter((item) => item.role === 'Travel Expert');
    const intendedEmails = [...new Set(intendedRecipients
      .map((item) => String(item.email || '').trim())
      .filter((email) => email.includes('@')))];
    if (!intendedEmails.length) throw new Error('No assigned Travel Expert email is available for this hold notice.');
    const intendedRecipientLabels = [...new Set(intendedRecipients
      .filter((item) => intendedEmails.includes(String(item.email || '').trim()))
      .map((item) => `${item.role}: ${item.name} (${item.email})`))];
    const recipient = intendedEmails.join(', ');
    const lifecycleTestDelivery = this.demoMode();
    const demoDelivery = lifecycleTestDelivery;
    const deliveryRecipient = this.deliveryRecipient(recipient, lifecycleTestDelivery);
    const stayDetails = Array.isArray(request.stayDetails) ? request.stayDetails : [];
    const subject = `DVi Travel | Hotel Hold Pending Payment | ${quotationReference}`;
    const text = [
      'Dear DVi Travel Team,',
      '',
      ...(demoDelivery
        ? [
            lifecycleTestDelivery
              ? 'TEST NOTICE: This email is being delivered to dhisoftai@gmail.com instead of the intended recipients.'
              : 'DEMO NOTICE: This email is being delivered to the configured demo inbox instead of the intended recipients.',
            `Intended recipients: ${intendedRecipientLabels.join('; ')}`,
            'The intended recipients have not been contacted while test delivery is enabled.',
            '',
          ]
        : []),
      `A hotel hold has been created for quotation ${quotationReference}.`,
      'Complete payment and confirmation before the hold expires.',
      '',
      `Hotel: ${request.hotelName || '--'}`,
      `Check-in: ${this.formatDate(request.checkIn)}`,
      `Check-out: ${this.formatDate(request.checkOut)}`,
      `Rooms: ${request.roomCount || 0}`,
      `Hold expires: ${this.formatDateTime(request.cutoffAt)}`,
      '',
      'Review the itinerary:',
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
      demoMode: demoDelivery,
      testDelivery: lifecycleTestDelivery,
      intendedRecipient: recipient,
      intendedRecipients: intendedRecipientLabels,
      emailKind: 'HOLD_CREATED',
      cutoffAt: this.formatDateTime(request.cutoffAt),
      stayDetails: stayDetails.map((detail) => ({
        checkIn: this.formatDate(detail.checkIn),
        checkOut: this.formatDate(detail.checkOut),
        roomType: String(detail.roomType || '--'),
        mealPlan: String(detail.mealPlan || '--'),
        roomCount: Number(detail.roomCount || 0),
      })),
    });
    const info = await this.getTransporter().sendMail(await withGlobalSettingsCc(this.prisma, {
      from: String(process.env.SMTP_FROM),
      to: deliveryRecipient,
      subject,
      text,
      html,
    }));
    return { status: 'SENT' as const, providerMessageId: String(info.messageId || '') || null, recipient: deliveryRecipient, testDelivery: lifecycleTestDelivery };
  }

  async dispatchReminder(input: {
    recipients: HoldNotificationRecipient[];
    quotationReference: string;
    itineraryUrl: string;
    request: HoldRequest;
    remainingTime: string;
  }) {
    if (!this.enabled()) return { status: 'QUEUED' as const };
    const { recipients, quotationReference, itineraryUrl, request, remainingTime } = input;
    const stayDetails = Array.isArray(request.stayDetails) ? request.stayDetails : [];
    const intendedEmails = [...new Set(recipients.map((item) => String(item.email || '').trim()).filter((email) => email.includes('@')))];
    if (!intendedEmails.length) throw new Error('No Agent or Travel Expert email is available for this payment reminder.');
    const recipient = intendedEmails.join(', ');
    const intendedRecipientLabels = recipients.map((item) => `${item.role}: ${item.name}`);
    const lifecycleTestDelivery = true;
    const demoDelivery = true;
    const deliveryRecipient = this.deliveryRecipient(recipient, lifecycleTestDelivery);
    const subject = `DVi Travel | Hotel Hold Payment Reminder · ${remainingTime} remaining | ${quotationReference}`;
    const text = [
      'Dear DVi Travel Team,',
      '',
      ...(demoDelivery
        ? [
            'TEST NOTICE: This email is being delivered to the hotel hold test inbox instead of the intended recipients.',
            `Intended recipients: ${intendedRecipientLabels.join('; ')}`,
            'The intended recipients have not been contacted while test delivery is enabled.',
            '',
          ]
        : []),
      `The hotel hold for quotation ${quotationReference} expires in ${remainingTime}.`,
      'Please review the itinerary and complete payment before the cutoff.',
      '',
      `Hotel: ${request.hotelName || '--'}`,
      `Check-in: ${this.formatDate(request.checkIn)}`,
      `Check-out: ${this.formatDate(request.checkOut)}`,
      `Rooms: ${request.roomCount || 0}`,
      `Hold expires: ${this.formatDateTime(request.cutoffAt)}`,
      `Time remaining: ${remainingTime}`,
      '',
      'Open the itinerary to pay and confirm the hotel:',
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
      demoMode: demoDelivery,
      testDelivery: lifecycleTestDelivery,
      intendedRecipient: recipient,
      intendedRecipients: intendedRecipientLabels,
      emailKind: 'REMINDER',
      cutoffAt: this.formatDateTime(request.cutoffAt),
      remainingTime,
      stayDetails: stayDetails.map((detail) => ({
        checkIn: this.formatDate(detail.checkIn),
        checkOut: this.formatDate(detail.checkOut),
        roomType: String(detail.roomType || '--'),
        mealPlan: String(detail.mealPlan || '--'),
        roomCount: Number(detail.roomCount || 0),
      })),
    });
    const info = await this.getTransporter().sendMail(await withGlobalSettingsCc(this.prisma, {
      from: String(process.env.SMTP_FROM),
      to: deliveryRecipient,
      subject,
      text,
      html,
    }));
    return { status: 'SENT' as const, providerMessageId: String(info.messageId || '') || null, recipient: deliveryRecipient, testDelivery: demoDelivery };
  }

  async dispatchAgentHoldExpired(input: { recipients: HoldNotificationRecipient[]; quotationReference: string; itineraryUrl: string; request: HoldRequest }) {
    if (!this.enabled()) return { status: 'QUEUED' as const };
    const { recipients, quotationReference, itineraryUrl, request } = input;
    const intendedEmails = [...new Set(recipients.map((item) => String(item.email || '').trim()).filter((email) => email.includes('@')))];
    if (!intendedEmails.length) throw new Error('No Agent or Travel Expert email is available for this expiry notice.');
    const recipient = intendedEmails.join(', ');
    const intendedRecipientLabels = recipients.map((item) => `${item.role}: ${item.name}`);
    const lifecycleTestDelivery = true;
    const demoDelivery = true;
    const deliveryRecipient = this.deliveryRecipient(recipient, lifecycleTestDelivery);
    const text = [
      'Dear Travel Expert,', '',
      ...(demoDelivery ? [
        'TEST NOTICE: This email is being delivered to the hotel hold test inbox instead of the intended recipients.',
        `Intended recipients: ${intendedRecipientLabels.join('; ')}`,
        'The intended recipients have not been contacted while test delivery is enabled.', '',
      ] : []),
      `The unpaid hotel hold for quotation ${quotationReference} has expired.`,
      'Payment against this hold is no longer available. Check the release status and arrange a new selection if needed.',
      '', `Hotel: ${request.hotelName || '--'}`,
      `Hold expired: ${this.formatDateTime(request.cutoffAt)}`,
      `Release status: ${request.status || 'EXPIRED'}`,
      '', 'Review the itinerary:', itineraryUrl, '', 'Regards,', 'DVi Travel Operations',
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
      demoMode: demoDelivery,
      testDelivery: lifecycleTestDelivery,
      intendedRecipient: recipient,
      intendedRecipients: intendedRecipientLabels,
      emailKind: 'HOLD_EXPIRED_AGENT',
      cutoffAt: this.formatDateTime(request.cutoffAt),
    });
    const info = await this.getTransporter().sendMail(await withGlobalSettingsCc(this.prisma, { from: String(process.env.SMTP_FROM), to: deliveryRecipient, subject: `DVi Travel | Hotel Hold Expired | ${quotationReference}`, text, html }));
    return { status: 'SENT' as const, providerMessageId: String(info.messageId || '') || null, recipient: deliveryRecipient, testDelivery: demoDelivery };
  }

  logFailure(error: unknown, recipient: string) {
    const message = error instanceof Error ? error.message : String(error || 'Unknown mail error');
    this.logger.error(`Hotel block email failed for ${recipient}: ${message}`);
    return message;
  }
}
