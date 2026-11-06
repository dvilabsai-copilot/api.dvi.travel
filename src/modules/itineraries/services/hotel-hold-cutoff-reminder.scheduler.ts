import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { HotelBlockEmailService } from './hotel-block-email.service';
import { HotelBlockingService } from './hotel-blocking.service';
import { resolveHotelHoldNotificationRecipients } from '../utils/hotel-hold-recipient.util';

const POLL_INTERVAL_MS = 60 * 1000;
const DEFAULT_MILESTONES: Record<string, number[]> = {
  '4': [3, 2, 1, 0.25],
  '12': [6, 3, 0.25],
  '48': [36, 24, 12, 1, 0.25],
  '240': [216, 192, 168, 144, 120, 96, 72, 48, 24, 12, 1, 0.25],
};
const ACTIVE_HOLD_STATUSES = ['BLOCKED', 'CONFIRMED'];

type HoldRequest = Record<string, any> & {
  id: number;
  itinerary_plan_id: number;
  requested_at: Date;
  cutoff_at: Date;
  status: string;
};

const parseMilestones = (value: unknown): Record<string, number[]> => {
  try {
    const parsed = JSON.parse(String(value || '')) as Record<string, unknown>;
    const result: Record<string, number[]> = {};
    for (const band of Object.keys(DEFAULT_MILESTONES)) {
      const values = parsed[band];
      result[band] = Array.isArray(values)
        ? Array.from(new Set(values.map(Number).filter((hours) => Number.isFinite(hours) && hours > 0 && hours < Number(band)))).sort((a, b) => b - a)
        : DEFAULT_MILESTONES[band];
    }
    return result;
  } catch {
    return DEFAULT_MILESTONES;
  }
};

const formatRemaining = (milliseconds: number) => {
  const totalMinutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  return [days ? `${days} day${days === 1 ? '' : 's'}` : '', hours ? `${hours} hour${hours === 1 ? '' : 's'}` : '', minutes ? `${minutes} minute${minutes === 1 ? '' : 's'}` : '']
    .filter(Boolean).join(' ');
};

@Injectable()
export class HotelHoldCutoffReminderScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HotelHoldCutoffReminderScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly hotelBlockEmail: HotelBlockEmailService,
    private readonly hotelBlocking: HotelBlockingService,
  ) {}

  onModuleInit() {
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), POLL_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(now = new Date()) {
    if (this.running) return 0;
    this.running = true;
    try {
      const settings = await (this.prisma as any).dvi_global_settings.findFirst({
        where: { deleted: 0, status: 1 },
        orderBy: { global_settings_ID: 'asc' },
        select: {
          hotel_hold_reminders_enabled: true,
          hotel_hold_reminder_email_enabled: true,
          hotel_hold_reminder_milestones: true,
          hotel_hold_final_reminder_minutes: true,
        },
      });
      if (Number(settings?.hotel_hold_reminders_enabled ?? 1) !== 1
        || Number(settings?.hotel_hold_reminder_email_enabled ?? 1) !== 1
        || !this.hotelBlockEmail.isDispatchEnabled()) return 0;

      const requests = await (this.prisma as any).dvi_hotel_block_request.findMany({
        where: {
          status: { in: ACTIVE_HOLD_STATUSES },
          paid_confirmed_at: null,
          cutoff_at: { gt: now },
          release_status: { notIn: ['REQUESTED', 'ACKNOWLEDGED'] },
        },
        orderBy: { cutoff_at: 'asc' },
      }) as HoldRequest[];
      const milestones = parseMilestones(settings?.hotel_hold_reminder_milestones);
      const finalMinutes = Math.max(1, Number(settings?.hotel_hold_final_reminder_minutes || 15));
      let sent = 0;

      for (const request of requests) {
        const decision = await this.hotelBlocking.getHoldPolicyDecision(request.check_in, request.requested_at);
        if (!decision.allowed || !decision.durationHours || !request.requested_at || !request.cutoff_at) continue;
        const band = String(decision.durationHours);
        const configured = milestones[band] || [];
        const targetTimes = [
          ...configured.map((hours) => ({ key: `h-${hours}`, at: new Date(request.cutoff_at.getTime() - hours * 3_600_000) })),
          { key: `final-${finalMinutes}m`, at: new Date(request.cutoff_at.getTime() - finalMinutes * 60_000) },
        ].filter((item, index, all) => item.at.getTime() > new Date(request.requested_at).getTime()
          && all.findIndex((candidate) => candidate.at.getTime() === item.at.getTime()) === index);
        const due = targetTimes.filter((item) => item.at <= now).sort((a, b) => b.at.getTime() - a.at.getTime());
        const latestDue = due[0];
        for (const milestone of due) {
          const deliveryStatus = milestone === latestDue ? 'QUEUED' : 'SKIPPED';
          try {
            await (this.prisma as any).dvi_hotel_hold_notification.create({
              data: {
                request_id: request.id,
                request_version: Number(request.version || 1),
                notification_type: 'PAYMENT_REMINDER',
                milestone_key: milestone.key,
                due_at: milestone.at,
                delivery_status: deliveryStatus,
                last_error: deliveryStatus === 'SKIPPED' ? 'Superseded by a later overdue reminder milestone.' : null,
              },
            });
          } catch (error: any) {
            if (error?.code !== 'P2002') throw error;
          }
        }
      }

      const pending = await (this.prisma as any).dvi_hotel_hold_notification.findMany({
        where: {
          notification_type: 'PAYMENT_REMINDER',
          OR: [
            { delivery_status: { in: ['QUEUED', 'FAILED'] } },
            { delivery_status: 'SENDING', updated_at: { lte: new Date(now.getTime() - 15 * 60_000) } },
          ],
          due_at: { lte: now },
          attempt_count: { lt: 5 },
        },
        orderBy: [{ due_at: 'asc' }, { id: 'asc' }],
        take: 100,
      });
      for (const notification of pending) {
        if (await this.sendReminder(notification, now)) sent += 1;
      }
      return sent;
    } catch (error) {
      this.logger.error(`Hotel hold reminder scan failed: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async sendReminder(notification: Record<string, any>, now: Date) {
    const staleBefore = new Date(now.getTime() - 15 * 60_000);
    const claimed = await (this.prisma as any).dvi_hotel_hold_notification.updateMany({
      where: {
        id: notification.id,
        attempt_count: { lt: 5 },
        OR: [
          { delivery_status: { in: ['QUEUED', 'FAILED'] } },
          { delivery_status: 'SENDING', updated_at: { lte: staleBefore } },
        ],
      },
      data: { delivery_status: 'SENDING', attempt_count: { increment: 1 }, last_error: null, updated_at: now },
    });
    if (Number(claimed?.count || 0) !== 1) return false;

    const request = await (this.prisma as any).dvi_hotel_block_request.findUnique({ where: { id: notification.request_id } });
    if (!request || !ACTIVE_HOLD_STATUSES.includes(String(request.status)) || request.paid_confirmed_at
      || !request.cutoff_at || new Date(request.cutoff_at).getTime() <= now.getTime()) {
      await (this.prisma as any).dvi_hotel_hold_notification.update({ where: { id: notification.id }, data: { delivery_status: 'SKIPPED', last_error: 'Hold is no longer active and unpaid.' } });
      return false;
    }
    if (Number(notification.request_version || 1) !== Number(request.version || 1)) {
      await (this.prisma as any).dvi_hotel_hold_notification.update({ where: { id: notification.id }, data: { delivery_status: 'SKIPPED', last_error: 'Hold version changed after this reminder was queued.' } });
      return false;
    }
    if (['REQUESTED', 'ACKNOWLEDGED'].includes(String(request.release_status || '').toUpperCase())) {
      await (this.prisma as any).dvi_hotel_hold_notification.update({ where: { id: notification.id }, data: { delivery_status: 'SKIPPED', last_error: 'Hotel inventory release has started for this hold.' } });
      return false;
    }
    const plan = await (this.prisma as any).dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: request.itinerary_plan_id },
      select: { itinerary_quote_ID: true, agent_id: true, staff_id: true, createdby: true },
    });
    const recipients = await resolveHotelHoldNotificationRecipients(this.prisma, plan);
    if (!recipients.length) {
      await (this.prisma as any).dvi_hotel_hold_notification.update({ where: { id: notification.id }, data: { delivery_status: 'FAILED', last_error: 'No assigned Agent or Travel Expert email was available.' } });
      return false;
    }
    const quoteReference = String(plan?.itinerary_quote_ID || request.itinerary_plan_id);
    const baseUrl = String(process.env.PUBLIC_ITINERARY_BASE_URL || 'http://localhost:8080').trim().replace(/\/+$/, '');
    const itineraryUrl = `${baseUrl}/itinerary-details/${encodeURIComponent(quoteReference)}?openHotelConfirmation=1`;
    const remainingTime = formatRemaining(new Date(request.cutoff_at).getTime() - now.getTime());
    try {
      const delivery = await this.hotelBlockEmail.dispatchReminder({
        recipients,
        quotationReference: quoteReference,
        itineraryUrl,
        remainingTime,
        request: {
          ...request,
          status: request.status,
          checkIn: request.check_in,
          checkOut: request.check_out,
          hotelName: request.hotel_name,
          roomType: request.room_type,
          roomCount: request.room_count,
          cutoffAt: request.cutoff_at,
          stayDetails: [],
        },
      });
      const delivered = delivery.status === 'SENT';
      await (this.prisma as any).dvi_hotel_hold_notification.update({
        where: { id: notification.id },
        data: {
          delivery_status: delivered ? 'SENT' : 'QUEUED',
          recipient: delivery.recipient || recipients[0].email,
          provider_message_id: delivery.providerMessageId || null,
          sent_at: delivered ? now : null,
          last_error: delivered ? null : 'Email dispatch is disabled; reminder remains queued.',
        },
      });
      if (!delivered) return false;
      await (this.prisma as any).dvi_hotel_block_event.create({
        data: {
          request_id: request.id,
          previous_status: request.status,
          new_status: request.status,
          event_type: 'PAYMENT_REMINDER_SENT',
          actor_type: 'SYSTEM',
          communication_channel: 'EMAIL',
          notes: delivery.testDelivery
            ? `Payment reminder delivered to the test inbox with ${remainingTime} remaining; intended recipients: ${recipients.map((item: any) => `${item.role}: ${item.name}`).join('; ')}.`
            : `Payment reminder sent to the assigned Agent and Travel Expert with ${remainingTime} remaining.`,
          metadata: JSON.stringify({ milestoneKey: notification.milestone_key, deliveryStatus: delivery.status, testDelivery: Boolean(delivery.testDelivery), intendedRecipients: recipients.map((item: any) => `${item.role}: ${item.name}`) }),
        },
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await (this.prisma as any).dvi_hotel_hold_notification.update({ where: { id: notification.id }, data: { delivery_status: 'FAILED', last_error: message } });
      this.logger.error(`Hotel hold reminder failed for request ${request.id}: ${message}`);
      return false;
    }
  }
}
