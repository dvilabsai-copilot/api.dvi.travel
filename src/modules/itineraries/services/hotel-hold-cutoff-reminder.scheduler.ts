import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { HotelBlockEmailService } from './hotel-block-email.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 60 * 1000;

type ReminderRequest = {
  id: number;
  itinerary_plan_id: number;
  hotel_name: string;
  provider: string;
  hotel_code?: string | null;
  check_in?: Date | null;
  check_out?: Date | null;
  room_type?: string | null;
  meal_plan?: string | null;
  room_count: number;
  status: string;
  cutoff_at: Date | null;
  cutoff_reminder_sent_at?: Date | null;
  contact_email?: string | null;
};

@Injectable()
export class HotelHoldCutoffReminderScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HotelHoldCutoffReminderScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly hotelBlockEmail: HotelBlockEmailService,
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
      const requests = await (this.prisma as any).dvi_hotel_block_request.findMany({
        where: {
          status: 'BLOCKED',
          cutoff_at: { gt: now, lte: new Date(now.getTime() + DAY_MS) },
          cutoff_reminder_sent_at: null,
        },
        orderBy: { cutoff_at: 'asc' },
      }) as ReminderRequest[];

      let sent = 0;
      for (const request of requests) {
        if (await this.sendReminder(request, now)) sent += 1;
      }
      return sent;
    } catch (error) {
      this.logger.error(`Hotel hold cutoff reminder scan failed: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async sendReminder(request: ReminderRequest, now: Date) {
    const plan = await (this.prisma as any).dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: request.itinerary_plan_id },
      select: { itinerary_quote_ID: true, agent_id: true, staff_id: true, createdby: true },
    });
    const recipient = await this.resolveRecipient(plan);
    if (!recipient || !request.cutoff_at) {
      this.logger.warn(`Skipping hotel hold reminder for request ${request.id}: no recipient or cutoff.`);
      return false;
    }

    const claimedAt = new Date(now);
    const claimed = await (this.prisma as any).dvi_hotel_block_request.updateMany({
      where: { id: request.id, status: 'BLOCKED', cutoff_reminder_sent_at: null },
      data: { cutoff_reminder_sent_at: claimedAt },
    });
    if (Number(claimed?.count || 0) !== 1) return false;

    const quoteReference = String(plan?.itinerary_quote_ID || request.itinerary_plan_id);
    const baseUrl = String(process.env.PUBLIC_ITINERARY_BASE_URL || 'http://localhost:8080').trim().replace(/\/+$/, '');
    const itineraryUrl = `${baseUrl}/itinerary-details/${encodeURIComponent(quoteReference)}?openHotelConfirmation=1`;
    try {
      const delivery = await this.hotelBlockEmail.dispatchReminder({
        recipient,
        quotationReference: quoteReference,
        itineraryUrl,
        request: {
          ...request,
          status: 'BLOCKED',
          cutoffAt: request.cutoff_at,
        },
      });
      await (this.prisma as any).dvi_hotel_block_event.create({
        data: {
          request_id: request.id,
          previous_status: 'BLOCKED',
          new_status: 'BLOCKED',
          event_type: 'CUTOFF_REMINDER_EMAIL_SENT',
          actor_type: 'SYSTEM',
          communication_channel: 'EMAIL',
          notes: 'Hotel hold expiry reminder sent 24 hours before cutoff.',
          metadata: JSON.stringify({ recipient, itineraryUrl, deliveryStatus: delivery.status }),
        },
      });
      return true;
    } catch (error) {
      await (this.prisma as any).dvi_hotel_block_request.updateMany({
        where: { id: request.id, cutoff_reminder_sent_at: claimedAt },
        data: { cutoff_reminder_sent_at: null },
      });
      this.logger.error(`Hotel hold reminder failed for request ${request.id}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async resolveRecipient(plan: { agent_id?: number | null; staff_id?: number | null; createdby?: number | null } | null) {
    const agentId = Number(plan?.agent_id || 0);
    if (agentId > 0) {
      const agent = await (this.prisma as any).dvi_agent.findFirst({
        where: { agent_ID: agentId, status: 1, deleted: 0 },
        select: { agent_email_id: true, travel_expert_id: true },
      });
      const agentEmail = String(agent?.agent_email_id || '').trim();
      if (agentEmail) return agentEmail;
      const linkedUser = await (this.prisma as any).dvi_users.findFirst({
        where: { agent_id: agentId, status: 1, deleted: 0 },
        select: { useremail: true },
      });
      const linkedEmail = String(linkedUser?.useremail || '').trim();
      if (linkedEmail) return linkedEmail;
      const expertId = Number(agent?.travel_expert_id || plan?.staff_id || 0);
      if (expertId > 0) {
        const expert = await (this.prisma as any).dvi_users.findFirst({
          where: { userID: BigInt(expertId), status: 1, deleted: 0 },
          select: { useremail: true },
        });
        const expertEmail = String(expert?.useremail || '').trim();
        if (expertEmail) return expertEmail;
      }
    }
    const creatorId = Number(plan?.createdby || 0);
    if (creatorId > 0) {
      const creator = await (this.prisma as any).dvi_users.findFirst({
        where: { userID: BigInt(creatorId), status: 1, deleted: 0 },
        select: { useremail: true },
      });
      const creatorEmail = String(creator?.useremail || '').trim();
      if (creatorEmail) return creatorEmail;
    }
    return null;
  }
}
