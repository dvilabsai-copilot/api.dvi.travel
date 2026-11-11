import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { resolveHotelHoldNotificationRecipients } from '../utils/hotel-hold-recipient.util';
import { HotelBlockEmailService } from './hotel-block-email.service';
import { AxisRoomsBookingPushService } from './axisrooms-booking-push.service';
import { TboHotelBookingService } from './tbo-hotel-booking.service';

const INTERVAL_MS = 60_000;
const ACTIVE = ['BLOCKED', 'CONFIRMED'];
const RELEASE_TERMINAL = ['EXPIRED', 'CANCELLED'];
const object = (value: unknown): Record<string, any> => {
  if (value && typeof value === 'object') return value as Record<string, any>;
  if (typeof value !== 'string') return {};
  try { return JSON.parse(value); } catch { return {}; }
};

@Injectable()
export class HotelHoldExpiryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HotelHoldExpiryScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: HotelBlockEmailService,
    private readonly axisRooms: AxisRoomsBookingPushService,
    private readonly tboHotels: TboHotelBookingService,
  ) {}

  onModuleInit() { void this.runOnce(); this.timer = setInterval(() => void this.runOnce(), INTERVAL_MS); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async runOnce(now = new Date()) {
    if (this.running) return { expired: 0, actions: 0 };
    this.running = true;
    let expired = 0;
    try {
      const candidates = await (this.prisma as any).dvi_hotel_block_request.findMany({
        where: { status: { in: ACTIVE }, paid_confirmed_at: null, cutoff_at: { lte: now } },
        orderBy: [{ cutoff_at: 'asc' }, { id: 'asc' }], take: 100,
      });
      for (const row of candidates) {
        const transitioned = await (this.prisma as any).$transaction(async (tx: any) => {
          const result = await tx.dvi_hotel_block_request.updateMany({
            where: { id: row.id, status: row.status, paid_confirmed_at: null, cutoff_at: { lte: now } },
            data: { status: 'EXPIRED', release_status: 'PENDING', release_email_status: 'PENDING', updated_at: now },
          });
          if (Number(result?.count || 0) !== 1) return false;
          await tx.dvi_hotel_block_event.create({ data: {
            request_id: row.id, previous_status: row.status, new_status: 'EXPIRED', event_type: 'HOTEL_HOLD_EXPIRED',
            actor_type: 'SYSTEM', communication_channel: 'SYSTEM',
            notes: 'Unpaid hold expired at its cutoff; external inventory release is tracked separately.',
            metadata: JSON.stringify({ cutoffAt: row.cutoff_at, channel: row.confirmation_channel || null }),
          } });
          return true;
        });
        if (transitioned) expired += 1;
      }

      const rows = await (this.prisma as any).dvi_hotel_block_request.findMany({
        where: {
          status: { in: RELEASE_TERMINAL },
          paid_confirmed_at: null,
          OR: [
            { release_status: { in: ['PENDING', 'FAILED'] } },
            { release_email_status: { in: ['PENDING', 'FAILED'] } },
            {
              release_status: 'REQUESTED',
              confirmation_channel: { in: ['AXISROOMS_HOLD', 'TBO_BOOK_HOLD'] },
              release_requested_at: { lte: new Date(now.getTime() - 5 * 60_000) },
            },
          ],
        },
        orderBy: { id: 'asc' }, take: 200,
      });
      for (const row of rows) {
        await this.releaseSupplierHold(row, now);
        await this.enqueueNotifications(row, now);
      }
      const actions = await this.deliverNotifications(now);
      return { expired, actions };
    } catch (error) {
      this.logger.error(`Hotel hold expiry scan failed: ${error instanceof Error ? error.message : String(error)}`);
      return { expired, actions: 0 };
    } finally { this.running = false; }
  }

  private async releaseSupplierHold(row: Record<string, any>, now: Date) {
    const terminalStatus = RELEASE_TERMINAL.includes(String(row.status)) ? String(row.status) : 'EXPIRED';
    const channel = String(row.confirmation_channel || '').toUpperCase();
    if (!['AXISROOMS_HOLD', 'TBO_BOOK_HOLD'].includes(channel)) {
      if (row.release_status === 'PENDING') {
        const claimed = await (this.prisma as any).dvi_hotel_block_request.updateMany({ where: { id: row.id, status: terminalStatus, release_status: 'PENDING' }, data: { release_status: 'REQUESTED', release_requested_at: now, release_last_error: null } });
        if (Number(claimed?.count || 0) !== 1) return;
        await (this.prisma as any).dvi_hotel_block_event.create({ data: {
          request_id: row.id, previous_status: terminalStatus, new_status: terminalStatus, event_type: 'HOTEL_RELEASE_ACKNOWLEDGEMENT_PENDING',
          actor_type: 'SYSTEM', communication_channel: 'SYSTEM', notes: 'No supplier release API applies. Hotel acknowledgement is pending Travel Expert follow-up.',
        } });
      }
      return;
    }
    const attempts = Number(row.release_attempt_count || 0);
    if (attempts >= 5) return;
    const stale = row.release_status === 'REQUESTED' && row.release_requested_at
      && new Date(row.release_requested_at).getTime() < now.getTime() - 5 * 60_000;
    if (row.release_status === 'FAILED' && row.release_requested_at
      && new Date(row.release_requested_at).getTime() >= now.getTime() - 5 * 60_000) return;
    const claim = await (this.prisma as any).dvi_hotel_block_request.updateMany({
      where: { id: row.id, status: terminalStatus, release_status: stale ? 'REQUESTED' : { in: ['PENDING', 'FAILED'] }, ...(stale ? { release_requested_at: row.release_requested_at } : {}) },
      data: { release_status: 'REQUESTED', release_requested_at: now, release_attempt_count: { increment: 1 }, release_last_error: null },
    });
    if (Number(claim?.count || 0) !== 1) return;
    try {
      let result: any;
      if (channel === 'AXISROOMS_HOLD') {
        const payload = object(row.request_payload);
        const hold = object(payload.providerHold);
        const request = object(hold.request);
        const room = Array.isArray(request.roomStays) ? request.roomStays[0] || {} : {};
        result = await this.axisRooms.cancelHeldBooking({
          confirmationNo: String(request.confirmationNo || row.confirmation_reference || ''),
          bookingCode: String(room.rateId || row.hotel_code || ''),
          hotelCode: String(row.hotel_code || request.hotelId || ''),
        });
        if (!result?.success) throw new Error(String(result?.error || result?.message || 'AxisRooms cancellation was not acknowledged.'));
      } else {
        const payload = object(row.request_payload);
        const hold = object(payload.supplierHold);
        const book = object(hold.bookResponse?.BookResult || hold.bookResponse);
        const bookingId = book.BookingId || hold.bookingId;
        if (!bookingId) throw new Error('TBO BookingId is missing; supplier release requires manual action.');
        const supplierState = await this.tboHotels.getHoldStatus(String(row.confirmation_reference || ''), bookingId);
        if (/cancelled|canceled|expired|void|rejected|failed|unavailable/i.test(String(supplierState?.status || ''))) {
          result = { success: true, alreadyReleased: true, status: supplierState.status };
        } else {
          result = await this.tboHotels.cancelHeldBooking(bookingId);
        }
      }
      await (this.prisma as any).$transaction(async (tx: any) => {
        await tx.dvi_hotel_block_request.update({ where: { id: row.id }, data: { release_status: 'ACKNOWLEDGED', release_acknowledged_at: now, release_last_error: null } });
        await tx.dvi_hotel_block_event.create({ data: {
          request_id: row.id, previous_status: terminalStatus, new_status: terminalStatus, event_type: 'SUPPLIER_HOLD_RELEASE_ACKNOWLEDGED',
          actor_type: 'SYSTEM', communication_channel: 'API', notes: `${channel} acknowledged cancellation.`, metadata: JSON.stringify({ channel, result }),
        } });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await (this.prisma as any).$transaction(async (tx: any) => {
        await tx.dvi_hotel_block_request.update({ where: { id: row.id }, data: { release_status: 'FAILED', release_last_error: message } });
        await tx.dvi_hotel_block_event.create({ data: {
          request_id: row.id, previous_status: terminalStatus, new_status: terminalStatus, event_type: 'SUPPLIER_HOLD_RELEASE_FAILED',
          actor_type: 'SYSTEM', communication_channel: 'API', notes: 'Supplier release failed and will be retried.', metadata: JSON.stringify({ channel, error: message }),
        } });
      });
      this.logger.error(`Supplier release failed for hotel hold ${row.id}: ${message}`);
    }
  }

  private async enqueueNotifications(row: Record<string, any>, now: Date) {
    const plan = await (this.prisma as any).dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: row.itinerary_plan_id },
      select: { itinerary_quote_ID: true, agent_id: true, staff_id: true, createdby: true },
    });
    const releaseMilestone = row.status === 'CANCELLED' ? 'cancelled' : 'expired';
    const agentRecipients = row.status === 'EXPIRED'
      ? await resolveHotelHoldNotificationRecipients(this.prisma, plan)
      : [];
    const items: Array<{ type: string; recipient: string; hasRecipient: boolean; status: string }> = [
      { type: 'HOTEL_RELEASE_EMAIL', recipient: String(row.contact_email || '').trim(), hasRecipient: Boolean(String(row.contact_email || '').trim()), status: String(row.contact_email || '').trim() ? 'QUEUED' : 'MANUAL_REQUIRED' },
    ];
    if (row.status === 'EXPIRED') items.push({
      type: 'AGENT_HOLD_EXPIRED_EMAIL',
      recipient: '',
      hasRecipient: agentRecipients.length > 0,
      status: agentRecipients.length ? 'QUEUED' : 'MANUAL_REQUIRED',
    });
    for (const item of items) {
      const unique = { request_id: row.id, request_version: Number(row.version || 1), notification_type: item.type, milestone_key: releaseMilestone };
      await (this.prisma as any).dvi_hotel_hold_notification.upsert({
        where: { request_id_request_version_notification_type_milestone_key: unique },
        create: { ...unique, due_at: now, recipient: item.recipient || null, delivery_status: item.hasRecipient ? item.status : 'MANUAL_REQUIRED', last_error: item.hasRecipient ? null : item.type === 'HOTEL_RELEASE_EMAIL' ? 'Hotel email is missing; staff action is required.' : 'Assigned Agent and Travel Expert email addresses are missing.' },
        update: {},
      });
    }
    if (!items[0].recipient && row.release_email_status !== 'MANUAL_REQUIRED') {
      await (this.prisma as any).dvi_hotel_block_request.update({ where: { id: row.id }, data: { release_email_status: 'MANUAL_REQUIRED', release_email_last_error: 'Hotel email is missing; staff must request room release.' } });
    }
    if (!items[0].recipient && row.release_email_status !== 'MANUAL_REQUIRED') {
      await (this.prisma as any).dvi_hotel_block_event.create({ data: {
        request_id: row.id, previous_status: 'EXPIRED', new_status: 'EXPIRED', event_type: 'HOTEL_RELEASE_MANUAL_ACTION_REQUIRED',
        actor_type: 'SYSTEM', communication_channel: 'SYSTEM', notes: 'Hotel contact email is missing; staff must contact the property to request release.',
      } });
    }
  }

  private async deliverNotifications(now: Date) {
    if (!this.email.isDispatchEnabled()) return 0;
    const rows = await (this.prisma as any).dvi_hotel_hold_notification.findMany({
      where: {
        notification_type: { in: ['HOTEL_RELEASE_EMAIL', 'AGENT_HOLD_EXPIRED_EMAIL'] },
        attempt_count: { lt: 5 },
        OR: [
          { delivery_status: { in: ['QUEUED', 'FAILED'] } },
          { delivery_status: 'SENDING', updated_at: { lte: new Date(now.getTime() - 15 * 60_000) } },
        ],
      },
      orderBy: { id: 'asc' }, take: 100,
    });
    let sent = 0;
    for (const notice of rows) {
      const claim = await (this.prisma as any).dvi_hotel_hold_notification.updateMany({
        where: {
          id: notice.id,
          attempt_count: { lt: 5 },
          OR: [
            { delivery_status: { in: ['QUEUED', 'FAILED'] } },
            { delivery_status: 'SENDING', updated_at: { lte: new Date(now.getTime() - 15 * 60_000) } },
          ],
        },
        data: { delivery_status: 'SENDING', attempt_count: { increment: 1 }, updated_at: now, last_error: null },
      });
      if (Number(claim?.count || 0) !== 1) continue;
      const request = await (this.prisma as any).dvi_hotel_block_request.findUnique({ where: { id: notice.request_id } });
      const requestIsReleaseEligible = request && RELEASE_TERMINAL.includes(String(request.status))
        && (notice.notification_type !== 'AGENT_HOLD_EXPIRED_EMAIL' || request.status === 'EXPIRED');
      if (!requestIsReleaseEligible) {
        await (this.prisma as any).dvi_hotel_hold_notification.update({ where: { id: notice.id }, data: { delivery_status: 'SKIPPED', last_error: 'Hold is no longer expired.' } });
        continue;
      }
      const plan = await (this.prisma as any).dvi_itinerary_plan_details.findUnique({
        where: { itinerary_plan_ID: request.itinerary_plan_id },
        select: { itinerary_quote_ID: true, agent_id: true, staff_id: true, createdby: true },
      });
      const quote = String(plan?.itinerary_quote_ID || request.itinerary_plan_id);
      const base = String(process.env.PUBLIC_ITINERARY_BASE_URL || 'http://localhost:8080').trim().replace(/\/+$/, '');
      const itineraryUrl = `${base}/itinerary-details/${encodeURIComponent(quote)}?openHotelConfirmation=1`;
      const payload = object(request.request_payload);
      const guest = object(payload.guest || payload.guestDetails);
      try {
        const recipients = notice.notification_type === 'AGENT_HOLD_EXPIRED_EMAIL'
          ? await resolveHotelHoldNotificationRecipients(this.prisma, plan)
          : [];
        if (notice.notification_type === 'AGENT_HOLD_EXPIRED_EMAIL' && !recipients.length) {
          await (this.prisma as any).dvi_hotel_hold_notification.update({ where: { id: notice.id }, data: { delivery_status: 'MANUAL_REQUIRED', last_error: 'Assigned Agent and Travel Expert email addresses are missing.' } });
          continue;
        }
        const delivery = notice.notification_type === 'HOTEL_RELEASE_EMAIL'
          ? await this.email.dispatch({
              recipient: notice.recipient,
              quotationReference: quote,
              request: {
                hotelName: request.hotel_name, provider: request.provider, checkIn: request.check_in, checkOut: request.check_out,
                roomType: request.room_type, mealPlan: request.meal_plan, roomCount: request.room_count,
                cutoffAt: request.status === 'CANCELLED' ? request.release_requested_at : request.cutoff_at,
                releaseRequestedAt: request.release_requested_at,
                releaseReason: request.status === 'CANCELLED' ? 'CANCELLED' : 'EXPIRED',
                status: request.status, emailKind: 'RELEASE', responseUrl: '',
                guestName: guest.name || guest.guestName || payload.guest?.name,
                originalHoldReference: request.confirmation_reference,
              },
            })
          : await this.email.dispatchAgentHoldExpired({
              recipients, quotationReference: quote, itineraryUrl,
              request: { hotelName: request.hotel_name, provider: request.provider, checkIn: request.check_in, checkOut: request.check_out, roomType: request.room_type, roomCount: request.room_count, cutoffAt: request.cutoff_at, status: request.release_status },
            });
        const delivered = delivery.status === 'SENT';
        await (this.prisma as any).dvi_hotel_hold_notification.update({
          where: { id: notice.id },
          data: { delivery_status: delivered ? 'SENT' : 'QUEUED', provider_message_id: delivery.providerMessageId || null, sent_at: delivered ? now : null, recipient: delivery.recipient || notice.recipient },
        });
        if (notice.notification_type === 'HOTEL_RELEASE_EMAIL') {
          const releaseEmailSent = delivered && !delivery.testDelivery;
          await (this.prisma as any).dvi_hotel_block_request.update({ where: { id: request.id }, data: { release_email_status: releaseEmailSent ? 'SENT' : 'PENDING', release_email_requested_at: now, release_email_sent_at: releaseEmailSent ? now : null, release_email_last_error: delivery.testDelivery ? 'Test email delivered to the configured sink; hotelier has not been contacted.' : null } });
          await (this.prisma as any).dvi_hotel_block_event.create({ data: {
            request_id: request.id, previous_status: request.status, new_status: request.status, event_type: delivery.testDelivery ? 'HOTEL_RELEASE_EMAIL_TEST_SENT' : delivered ? 'HOTEL_RELEASE_EMAIL_SENT' : 'HOTEL_RELEASE_EMAIL_QUEUED',
            actor_type: 'SYSTEM', communication_channel: 'EMAIL', notes: delivery.testDelivery ? 'Hotel release email delivered to the configured test inbox; hotelier has not been contacted.' : delivered ? 'Hotel release email sent; hotel acknowledgement remains separately tracked.' : 'Hotel release email is queued for delivery.',
          } });
        }
        if (delivered) sent += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await (this.prisma as any).dvi_hotel_hold_notification.update({ where: { id: notice.id }, data: { delivery_status: 'FAILED', last_error: message } });
        if (notice.notification_type === 'HOTEL_RELEASE_EMAIL') await (this.prisma as any).dvi_hotel_block_request.update({ where: { id: request.id }, data: { release_email_status: 'FAILED', release_email_last_error: message } });
        this.logger.error(`Expiry email failed for request ${request.id}: ${message}`);
      }
    }
    return sent;
  }
}
