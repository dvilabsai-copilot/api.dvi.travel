import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../../prisma.service';
import { HotelBlockEmailService } from './hotel-block-email.service';

export const HOTEL_BLOCK_STATUS = {
  CONTACT_REQUIRED: 'CONTACT_REQUIRED',
  REQUESTED: 'REQUESTED',
  CONFIRMATION_AWAITED: 'CONFIRMATION_AWAITED',
  BLOCKED: 'BLOCKED',
  WAITLISTED: 'WAITLISTED',
  UNAVAILABLE: 'UNAVAILABLE',
  CONFIRMED: 'CONFIRMED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
  SUPERSEDED: 'SUPERSEDED',
} as const;

type Actor = { id?: number; name?: string; type?: string };
type BlockRow = Record<string, any>;

const ACTIVE_REQUEST_STATUSES = [
  HOTEL_BLOCK_STATUS.CONTACT_REQUIRED,
  HOTEL_BLOCK_STATUS.REQUESTED,
  HOTEL_BLOCK_STATUS.CONFIRMATION_AWAITED,
  HOTEL_BLOCK_STATUS.BLOCKED,
  HOTEL_BLOCK_STATUS.WAITLISTED,
];

const RESPONSE_STATUSES = new Set<string>([
  HOTEL_BLOCK_STATUS.BLOCKED,
  HOTEL_BLOCK_STATUS.CONFIRMED,
  HOTEL_BLOCK_STATUS.WAITLISTED,
  HOTEL_BLOCK_STATUS.UNAVAILABLE,
]);

const normalizeText = (value: unknown) => String(value ?? '').trim();

const parseJson = (value: unknown, fallback: unknown = null) => {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const firstEmail = (value: unknown) => {
  const email = normalizeText(value)
    .split(/[;,\s]+/)
    .find((candidate) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidate));
  return email || null;
};

const dateOnly = (value: unknown): Date | null => {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
};

const publicItineraryBaseUrl = () => {
  const baseUrl = String(process.env.PUBLIC_ITINERARY_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('PUBLIC_ITINERARY_BASE_URL is not configured.');
  return baseUrl;
};

@Injectable()
export class HotelBlockingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hotelBlockEmail: HotelBlockEmailService,
  ) {}

  private async getDefaultHotelHoldCutoff(now = new Date()) {
    let durationHours = 1;
    try {
      const settings = await (this.prisma as any).dvi_global_settings.findFirst({
        where: { deleted: 0, status: 1 },
        orderBy: { global_settings_ID: 'asc' },
        select: { hotel_blocked_cutoff_time: true },
      });
      const configuredHours = Number(settings?.hotel_blocked_cutoff_time);
      if (Number.isFinite(configuredHours) && configuredHours >= 0) durationHours = configuredHours;
    } catch {
      // Keep the one-hour compatibility default if an older database has not
      // received the global-settings column yet.
    }
    return new Date(now.getTime() + durationHours * 60 * 60 * 1000);
  }

  private minimumHotelHoldCutoff(request: BlockRow, now = new Date()) {
    const checkIn = dateOnly(request.check_in);
    if (!checkIn || checkIn.getTime() <= now.getTime()) return now;
    return checkIn;
  }

  async holdGroup(input: {
    itineraryPlanId: number;
    groupType: number;
    actor?: Actor;
    guest?: { name?: string; email?: string; phone?: string };
  }) {
    const planId = Number(input.itineraryPlanId);
    const groupType = Number(input.groupType || 0);
    if (!Number.isInteger(planId) || planId <= 0) throw new BadRequestException('A valid itinerary plan is required.');
    if (!Number.isInteger(groupType) || groupType <= 0) throw new BadRequestException('A valid recommendation group is required.');
    if (!normalizeText(input.guest?.name)) throw new BadRequestException('Primary guest name is required before holding hotels.');
    if (!normalizeText(input.guest?.phone)) throw new BadRequestException('Primary guest contact number is required before holding hotels.');
    if (!firstEmail(input.guest?.email)) throw new BadRequestException('Primary guest email is required before holding hotels.');

    const rows = await (this.prisma as any).dvi_itinerary_plan_hotel_details.findMany({
      where: {
        itinerary_plan_id: planId,
        group_type: groupType,
        deleted: 0,
        status: 1,
        hotel_required: { not: 2 },
        NOT: { selection_origin: 'USER_REMOVED' },
      },
      orderBy: [{ itinerary_route_date: 'asc' }, { itinerary_plan_hotel_details_ID: 'asc' }],
    });
    if (!rows.length) throw new BadRequestException('No selected hotel stays were found for this recommendation group.');

    const hotelIds = Array.from(new Set(rows.map((row: BlockRow) => Number(row.hotel_id || 0)).filter((id) => id > 0)));
    const hotels = hotelIds.length
      ? await (this.prisma as any).dvi_hotel.findMany({
          where: { hotel_id: { in: hotelIds } },
          select: { hotel_id: true, hotel_name: true, hotel_email: true, hotel_mobile: true },
        })
      : [];
    const snapshotNames = Array.from(new Set(rows
      .map((row: BlockRow) => normalizeText(parseJson(row.selected_price_snapshot)?.hotelName))
      .filter(Boolean)));
    const namedHotels = snapshotNames.length
      ? await (this.prisma as any).dvi_hotel.findMany({
          where: { hotel_name: { in: snapshotNames } },
          select: { hotel_id: true, hotel_name: true, hotel_email: true, hotel_mobile: true },
        })
      : [];
    const hotelById = new Map(hotels.concat(namedHotels).map((hotel: BlockRow) => [Number(hotel.hotel_id), hotel]));
    const hotelByName = new Map(namedHotels.map((hotel: BlockRow) => [normalizeText(hotel.hotel_name).toLowerCase(), hotel]));
    const roomRows = await (this.prisma as any).dvi_itinerary_plan_hotel_room_details.findMany({
      where: {
        itinerary_plan_id: planId,
        group_type: groupType,
        deleted: 0,
        status: 1,
        itinerary_plan_hotel_details_id: { in: rows.map((row: BlockRow) => Number(row.itinerary_plan_hotel_details_ID)) },
      },
    });
    const roomsBySelection = new Map<number, BlockRow>();
    for (const room of roomRows) {
      const selectionId = Number(room.itinerary_plan_hotel_details_id || 0);
      if (!roomsBySelection.has(selectionId)) roomsBySelection.set(selectionId, room);
    }

    const groups = new Map<string, BlockRow[]>();
    for (const row of rows) {
      const room = roomsBySelection.get(Number(row.itinerary_plan_hotel_details_ID));
      const snapshot = parseJson(row.selected_price_snapshot) || {};
      const hotel = hotelById.get(Number(row.hotel_id || 0)) || hotelByName.get(normalizeText(snapshot.hotelName).toLowerCase());
      const provider = this.normalizeProvider(row.hotel_provider, row.hotel_booking_mode);
      const hotelCode = normalizeText(row.hotel_code) || String(row.hotel_id || '');
      const roomType = normalizeText(row.selected_price_snapshot && parseJson(row.selected_price_snapshot)?.roomType)
        || String(room?.room_type_id || '');
      const mealPlan = this.resolveMealPlan(room);
      const key = [provider, hotelCode, roomType, mealPlan].join('|').toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ ...row, __room: room, __hotel: hotel, __snapshot: snapshot });
    }

    const results: any[] = [];
    for (const groupedRows of groups.values()) {
      const first = groupedRows[0];
      results.push(await this.upsertRequest({
        planId,
        groupType,
        rows: groupedRows,
        hotel: first.__hotel,
        actor: input.actor,
        guest: input.guest,
      }));
    }

    for (const result of results) {
      if (!result.emailQueued || !result.responseUrl || !result.contactEmail) continue;
      try {
        const delivery = await this.hotelBlockEmail.dispatch({
          recipient: result.contactEmail,
          quotationReference: String(planId),
          request: result,
        });
        result.emailDeliveryStatus = delivery.status;
        if (delivery.status === 'SENT') {
          await (this.prisma as any).dvi_hotel_block_message.updateMany({
            where: { request_id: result.id, delivery_status: 'QUEUED' },
            data: {
              delivery_status: 'SENT',
              attempt_count: { increment: 1 },
              provider_message_id: delivery.providerMessageId,
              sent_at: new Date(),
            },
          });
        }
      } catch (error) {
        const lastError = this.hotelBlockEmail.logFailure(error, result.contactEmail);
        result.emailDeliveryStatus = 'FAILED';
        await (this.prisma as any).dvi_hotel_block_message.updateMany({
          where: { request_id: result.id, delivery_status: 'QUEUED' },
          data: { delivery_status: 'FAILED', attempt_count: { increment: 1 }, last_error: lastError },
        });
      }
    }

    return {
      success: true,
      itineraryPlanId: planId,
      groupType,
      requests: results,
      requestsCreated: results.filter((result) => result.created).length,
      emailsQueued: results.filter((result) => result.emailQueued).length,
      contactRequired: results.filter((result) => result.status === HOTEL_BLOCK_STATUS.CONTACT_REQUIRED).length,
      walletDebited: 0,
      supplierBookingCalls: 0,
    };
  }

  async listForItinerary(planId: number, groupType?: number) {
    const rows = await (this.prisma as any).dvi_hotel_block_request.findMany({
      where: {
        itinerary_plan_id: Number(planId),
        ...(Number(groupType || 0) > 0 ? { group_type: Number(groupType) } : {}),
      },
      orderBy: [{ check_in: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row: BlockRow) => this.publicStaffView(row));
  }

  async getById(requestId: number) {
    const row = await (this.prisma as any).dvi_hotel_block_request.findUnique({
      where: { id: Number(requestId) },
    });
    if (!row) throw new NotFoundException('Hotel hold request not found.');
    return this.publicStaffView(row);
  }

  async getGuestDetails(planId: number) {
    const rows = await (this.prisma as any).$queryRawUnsafe(
      'SELECT guest_payload FROM dvi_hotel_block_guest_details WHERE itinerary_plan_id = ? LIMIT 1',
      Number(planId),
    );
    const payload = rows?.[0]?.guest_payload;
    return payload ? parseJson(payload, {}) : null;
  }

  async saveGuestDetails(planId: number, payload: Record<string, unknown>, actor?: Actor) {
    const normalizedPlanId = Number(planId);
    if (!Number.isInteger(normalizedPlanId) || normalizedPlanId <= 0) {
      throw new BadRequestException('A valid itinerary plan is required.');
    }
    const name = normalizeText(payload?.name);
    const phone = normalizeText(payload?.contactNo ?? payload?.phone);
    const email = firstEmail(payload?.emailId ?? payload?.email);
    const age = Number(payload?.age || 0);
    if (!name || !phone || !email || !Number.isFinite(age) || age <= 0) {
      throw new BadRequestException('Lead guest name, age, mobile and email are required.');
    }
    const serialized = JSON.stringify({ ...payload, emailId: email, name, contactNo: phone, age: String(age) });
    await (this.prisma as any).$executeRawUnsafe(
      `INSERT INTO dvi_hotel_block_guest_details
        (itinerary_plan_id, guest_payload, created_by)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE guest_payload = VALUES(guest_payload), created_by = VALUES(created_by)`,
      normalizedPlanId,
      serialized,
      Number(actor?.id || 0) || null,
    );
    return { success: true, itineraryPlanId: normalizedPlanId, guest: payload };
  }

  async getPublic(token: string) {
    const request = await this.findByToken(token);
    return this.publicSupplierView(request);
  }

  async respondPublic(token: string, input: any) {
    const request = await this.findByToken(token);
    return this.recordResponse(request.id, {
      ...input,
      actor: { type: 'HOTEL_LINK', name: input?.respondentName },
      tokenId: request.tokenId,
    });
  }

  async recordManualResponse(requestId: number, input: any, actor: Actor) {
    return this.recordResponse(Number(requestId), { ...input, actor: { ...actor, type: actor.type || 'STAFF' } });
  }

  async cancel(requestId: number, actor: Actor) {
    return this.transition(requestId, HOTEL_BLOCK_STATUS.CANCELLED, {
      actor: { ...actor, type: actor.type || 'STAFF' },
      eventType: 'CANCELLED',
      notes: 'Hotel hold request cancelled by staff.',
    });
  }

  async resendEmail(requestId: number, actor: Actor) {
    const request = await (this.prisma as any).dvi_hotel_block_request.findUnique({
      where: { id: Number(requestId) },
    });
    if (!request) throw new NotFoundException('Hotel hold request not found.');
    if ([HOTEL_BLOCK_STATUS.CANCELLED, HOTEL_BLOCK_STATUS.SUPERSEDED, HOTEL_BLOCK_STATUS.UNAVAILABLE].includes(request.status)) {
      throw new BadRequestException('This hotel hold request is no longer active.');
    }
    const recipient = firstEmail(request.contact_email);
    if (!recipient) throw new BadRequestException('A verified hotel reservation email is required before resending.');
    let requestForEmail = request;
    const shouldMarkBlocked = request.status === HOTEL_BLOCK_STATUS.REQUESTED;
    const shouldSeedDefaultCutoff = [HOTEL_BLOCK_STATUS.REQUESTED, HOTEL_BLOCK_STATUS.BLOCKED].includes(request.status)
      && !request.cutoff_at;
    if (shouldMarkBlocked || shouldSeedDefaultCutoff) {
      const defaultCutoff = request.cutoff_at || await this.getDefaultHotelHoldCutoff();
      requestForEmail = await (this.prisma as any).$transaction(async (tx: any) => {
        const updated = await tx.dvi_hotel_block_request.update({
          where: { id: request.id },
          data: {
            status: HOTEL_BLOCK_STATUS.BLOCKED,
            cutoff_at: defaultCutoff,
          },
        });
        await tx.dvi_hotel_block_event.create({
          data: {
            request_id: request.id,
            previous_status: request.status,
            new_status: HOTEL_BLOCK_STATUS.BLOCKED,
            event_type: shouldMarkBlocked ? 'REQUEST_MARKED_BLOCKED' : 'HOLD_CUTOFF_DEFAULTED',
            actor_type: actor.type || 'STAFF',
            actor_id: Number(actor.id || 0) || null,
            actor_name: actor.name || null,
            notes: shouldMarkBlocked
              ? 'Existing hotel block request marked blocked before email resend.'
              : 'Default one-hour hold cutoff applied before email resend.',
          },
        });
        return updated;
      });
    }
    return this.queueAndSendEmail({
      request: requestForEmail,
      recipient,
      actor,
      eventType: 'REQUEST_EMAIL_RESENT',
      notes: 'Hotel blocking email queued again by staff.',
    });
  }

  async updateCutoff(requestId: number, cutoffAt: string, actor: Actor) {
    const request = await (this.prisma as any).dvi_hotel_block_request.findUnique({ where: { id: Number(requestId) } });
    if (!request) throw new NotFoundException('Hotel hold request not found.');
    if (![HOTEL_BLOCK_STATUS.BLOCKED, HOTEL_BLOCK_STATUS.CONFIRMED].includes(request.status)) {
      throw new BadRequestException('Only an existing held hotel can be extended.');
    }
    const cutoff = new Date(String(cutoffAt || ''));
    if (Number.isNaN(cutoff.getTime())) throw new BadRequestException('A valid cutoff date and time is required.');
    const previousCutoff = dateOnly(request.cutoff_at);
    if (!previousCutoff) throw new BadRequestException('This hotel hold does not have an existing hold-until time.');
    if (cutoff.getTime() <= previousCutoff.getTime()) {
      throw new BadRequestException('The new hold-until time must be later than the current hold-until time.');
    }
    const updated = await (this.prisma as any).$transaction(async (tx: any) => {
      const result = await tx.dvi_hotel_block_request.update({ where: { id: request.id }, data: { cutoff_at: cutoff } });
      await tx.dvi_hotel_block_event.create({
        data: {
          request_id: request.id,
          previous_status: request.status,
          new_status: request.status,
          event_type: 'HOLD_EXTENDED',
          actor_type: actor.type || 'STAFF',
          actor_id: Number(actor.id || 0) || null,
          actor_name: actor.name || null,
          notes: 'Hotel hold extended by staff.',
          metadata: JSON.stringify({ previousCutoffAt: previousCutoff.toISOString(), cutoffAt: cutoff.toISOString() }),
        },
      });
      return result;
    });
    const recipient = firstEmail(updated.contact_email);
    if (!recipient) return { success: true, request: this.publicStaffView(updated), emailDeliveryStatus: 'SKIPPED' };
    return this.queueAndSendEmail({
      request: updated,
      recipient,
      actor,
      eventType: 'HOLD_EXTENSION_EMAIL_QUEUED',
      notes: 'Hotel hold extension email queued by staff.',
      emailKind: 'EXTENSION',
      previousCutoffAt: previousCutoff,
    });
  }

  private async queueAndSendEmail(input: {
    request: BlockRow;
    recipient: string;
    actor: Actor;
    eventType: string;
    notes: string;
    emailKind?: 'REQUEST' | 'EXTENSION';
    previousCutoffAt?: Date | string | null;
  }) {
    const { request, recipient, actor, eventType, notes, emailKind = 'REQUEST', previousCutoffAt = null } = input;
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const now = new Date();
    await (this.prisma as any).$transaction(async (tx: any) => {
      await tx.dvi_hotel_block_token.create({
        data: {
          request_id: request.id,
          token_hash: tokenHash,
          expires_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        },
      });
      await tx.dvi_hotel_block_message.create({
        data: { request_id: request.id, recipient: this.hotelBlockEmail.deliveryRecipient(recipient), delivery_status: 'QUEUED', attempt_count: 0 },
      });
      await tx.dvi_hotel_block_event.create({
        data: {
          request_id: request.id,
          previous_status: request.status,
          new_status: request.status,
          event_type: eventType,
          actor_type: actor.type || 'STAFF',
          actor_id: Number(actor.id || 0) || null,
          actor_name: actor.name || null,
          notes,
          metadata: JSON.stringify({ recipient, emailKind }),
        },
      });
    });

    const responseUrl = `${publicItineraryBaseUrl()}/hotel/block-response/${rawToken}`;
    let deliveryStatus: 'QUEUED' | 'SENT' | 'FAILED' = 'QUEUED';
    let providerMessageId: string | null = null;
    try {
      const delivery = await this.hotelBlockEmail.dispatch({
        recipient,
        quotationReference: String(request.itinerary_plan_id),
        request: {
          ...this.publicStaffView(request),
          responseUrl,
          emailKind,
          previousCutoffAt,
          cutoffAt: request.cutoff_at,
        },
      });
      deliveryStatus = delivery.status;
      providerMessageId = delivery.providerMessageId || null;
      if (delivery.status === 'SENT') {
        await (this.prisma as any).dvi_hotel_block_message.updateMany({
          where: { request_id: request.id, recipient: this.hotelBlockEmail.deliveryRecipient(recipient), delivery_status: 'QUEUED' },
          data: { delivery_status: 'SENT', attempt_count: { increment: 1 }, provider_message_id: providerMessageId, sent_at: new Date() },
        });
      }
    } catch (error) {
      deliveryStatus = 'FAILED';
      const lastError = this.hotelBlockEmail.logFailure(error, recipient);
      await (this.prisma as any).dvi_hotel_block_message.updateMany({
        where: { request_id: request.id, recipient: this.hotelBlockEmail.deliveryRecipient(recipient), delivery_status: 'QUEUED' },
        data: { delivery_status: 'FAILED', attempt_count: { increment: 1 }, last_error: lastError },
      });
    }
    return { success: true, request: this.publicStaffView(request), recipient, deliveryStatus, emailDeliveryStatus: deliveryStatus, providerMessageId };
  }

  async assertPlanReady(planId: number, groupType?: number) {
    const selectedRows = await (this.prisma as any).dvi_itinerary_plan_hotel_details.findMany({
      where: {
        itinerary_plan_id: Number(planId),
        ...(Number(groupType || 0) > 0 ? { group_type: Number(groupType) } : {}),
        deleted: 0,
        status: 1,
        hotel_required: { not: 2 },
        NOT: { selection_origin: 'USER_REMOVED' },
      },
      select: { itinerary_plan_hotel_details_ID: true },
    });
    const expectedSelectionIds = selectedRows
      .map((row: BlockRow) => Number(row.itinerary_plan_hotel_details_ID))
      .filter((id: number) => id > 0)
      .sort((a: number, b: number) => a - b);
    const requests = await (this.prisma as any).dvi_hotel_block_request.findMany({
      where: {
        itinerary_plan_id: Number(planId),
        ...(Number(groupType || 0) > 0 ? { group_type: Number(groupType) } : {}),
        status: { notIn: [HOTEL_BLOCK_STATUS.CANCELLED, HOTEL_BLOCK_STATUS.SUPERSEDED] },
      },
      select: { id: true, hotel_name: true, status: true, selection_ids: true },
    });
    const pending = requests.filter((request: BlockRow) => request.status !== HOTEL_BLOCK_STATUS.CONFIRMED);
    const heldSelectionIds = requests
      .flatMap((request: BlockRow) => (parseJson(request.selection_ids, []) as unknown[]).map(Number))
      .filter((id: number) => id > 0)
      .sort((a: number, b: number) => a - b);
    const selectionChanged = expectedSelectionIds.length !== heldSelectionIds.length
      || expectedSelectionIds.some((id: number, index: number) => id !== heldSelectionIds[index]);
    if (!requests.length || pending.length || selectionChanged) {
      throw new BadRequestException({
        code: 'HOTEL_CONFIRMATION_PENDING',
        message: selectionChanged
          ? 'The selected hotels changed after the hold request. Hold the current selection again before payment.'
          : 'Confirm & Pay is available only after every selected hotel confirms the stay.',
        pendingHotels: pending.map((request: BlockRow) => ({ id: request.id, hotelName: request.hotel_name, status: request.status })),
      });
    }
    return { ready: true, requestCount: requests.length };
  }

  private async upsertRequest(input: {
    planId: number;
    groupType: number;
    rows: BlockRow[];
    hotel?: BlockRow;
    actor?: Actor;
    guest?: { name?: string; email?: string; phone?: string };
  }) {
    const first = input.rows[0];
    const room = first.__room || {};
    const snapshot = first.__snapshot || parseJson(first.selected_price_snapshot) || {};
    const hotel = input.hotel || {};
    const provider = this.normalizeProvider(first.hotel_provider, first.hotel_booking_mode);
    const hotelCode = normalizeText(first.hotel_code) || String(first.hotel_id || '');
    const roomType = normalizeText(snapshot.roomType) || String(room.room_type_id || 'Room');
    const mealPlan = normalizeText(snapshot.mealPlan) || this.resolveMealPlan(room);
    const checkIn = input.rows.map((row) => dateOnly(row.hotel_check_in_date || row.itinerary_route_date || row.__snapshot?.authoritativeCheckInDate)).filter(Boolean) as Date[];
    const checkOut = input.rows.map((row) => dateOnly(row.hotel_check_out_date || row.__snapshot?.authoritativeCheckOutDate)).filter(Boolean) as Date[];
    if (!checkIn.length && snapshot.authoritativeCheckInDate) {
      const parsed = dateOnly(snapshot.authoritativeCheckInDate);
      if (parsed) checkIn.push(parsed);
    }
    if (!checkOut.length && snapshot.authoritativeCheckOutDate) {
      const parsed = dateOnly(snapshot.authoritativeCheckOutDate);
      if (parsed) checkOut.push(parsed);
    }
    const start = checkIn.sort((a, b) => a.getTime() - b.getTime())[0] || null;
    const end = checkOut.sort((a, b) => b.getTime() - a.getTime())[0] || start;
    const reservationKey = [input.planId, input.groupType, provider, hotelCode, roomType, mealPlan, start?.toISOString().slice(0, 10), end?.toISOString().slice(0, 10)].join('|');
    const email = firstEmail(hotel.hotel_email);
    const phone = normalizeText(hotel.hotel_mobile) || null;
    const contactSource = email || phone ? 'HOTEL_MASTER' : null;
    const selectionIds = input.rows
      .map((row) => Number(row.itinerary_plan_hotel_details_ID))
      .sort((a, b) => a - b);
    const payload = {
      quotationPlanId: input.planId,
      groupType: input.groupType,
      hotelName: normalizeText(hotel.hotel_name) || normalizeText(snapshot.hotelName) || normalizeText(first.hotel_name) || 'Hotel',
      provider,
      hotelCode,
      checkIn: start,
      checkOut: end,
      roomType,
      mealPlan,
      roomCount: Math.max(...input.rows.map((row) => Number(row.total_no_of_rooms || room.room_qty || 0)), 0),
      guest: input.guest || null,
      selectionIds,
    };
    // A submitted block request represents a blocked room until the hotelier
    // responds with Confirmed, Waitlisted, or Unavailable.
    const status = email ? HOTEL_BLOCK_STATUS.BLOCKED : HOTEL_BLOCK_STATUS.CONTACT_REQUIRED;
    const defaultCutoff = email ? await this.getDefaultHotelHoldCutoff() : null;
    const candidates = await (this.prisma as any).dvi_hotel_block_request.findMany({
      where: {
        itinerary_plan_id: input.planId,
        group_type: input.groupType,
        status: { notIn: [HOTEL_BLOCK_STATUS.CANCELLED, HOTEL_BLOCK_STATUS.SUPERSEDED] },
      },
      orderBy: { id: 'asc' },
    });
    const matchingSelectionRequest = candidates.find((candidate: BlockRow) => {
      const candidateIds = (parseJson(candidate.selection_ids, []) as unknown[])
        .map(Number)
        .filter((id) => Number.isInteger(id))
        .sort((a, b) => a - b);
      return candidateIds.length === selectionIds.length && candidateIds.every((id, index) => id === selectionIds[index]);
    });
    const existing = matchingSelectionRequest || await (this.prisma as any).dvi_hotel_block_request.findUnique({ where: { reservation_key: reservationKey } });
    if (existing && ACTIVE_REQUEST_STATUSES.includes(existing.status)) {
      const sameSnapshot = existing.hotel_name === payload.hotelName
        && existing.provider === payload.provider
        && existing.hotel_code === payload.hotelCode
        && existing.room_type === payload.roomType
        && existing.meal_plan === payload.mealPlan
        && Number(existing.room_count || 0) === payload.roomCount
        && (existing.contact_email || null) === email
        && (existing.contact_phone || null) === phone;
      if (sameSnapshot) {
        if (email) {
          const delivery = await this.resendEmail(existing.id, input.actor || { type: 'STAFF' });
          return {
            ...this.publicStaffView(existing),
            created: false,
            emailQueued: true,
            emailDeliveryStatus: delivery.deliveryStatus,
            responseUrl: undefined,
          };
        }
        return { ...this.publicStaffView(existing), created: false, emailQueued: false, responseUrl: undefined };
      }

      // An older request can have been created from an incomplete supplier row.
      // Refresh that same request in place so the hold list remains idempotent
      // while its hotel identity/contact snapshot becomes authoritative.
      const refreshed = await (this.prisma as any).dvi_hotel_block_request.update({
        where: { id: existing.id },
        data: {
          provider: payload.provider,
          hotel_code: payload.hotelCode || null,
          hotel_name: payload.hotelName,
          check_in: payload.checkIn,
          check_out: payload.checkOut,
          room_type: payload.roomType,
          meal_plan: payload.mealPlan,
          room_count: payload.roomCount,
          selection_ids: JSON.stringify(payload.selectionIds),
          request_payload: JSON.stringify(payload),
          contact_email: email,
          contact_phone: phone,
          contact_source: contactSource,
        },
      });
      return { ...this.publicStaffView(refreshed), created: false, emailQueued: false, responseUrl: undefined };
    }

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const now = new Date();
    const created = await (this.prisma as any).$transaction(async (tx: any) => {
      const request = existing
        ? await tx.dvi_hotel_block_request.update({
            where: { id: existing.id },
            data: {
              selection_ids: JSON.stringify(payload.selectionIds),
              status,
              contact_email: email,
              contact_phone: phone,
              contact_source: contactSource,
              requested_at: now,
              responded_at: null,
              confirmed_at: null,
              cutoff_at: defaultCutoff,
              confirmation_reference: null,
              confirmation_channel: null,
              respondent_name: null,
              version: Number(existing.version || 1) + 1,
              request_payload: JSON.stringify(payload),
              created_by: Number(input.actor?.id || 0) || null,
            },
          })
        : await tx.dvi_hotel_block_request.create({
            data: {
              itinerary_plan_id: input.planId,
              group_type: input.groupType,
              reservation_key: reservationKey,
              selection_ids: JSON.stringify(payload.selectionIds),
              provider,
              hotel_id: Number(first.hotel_id || 0) || null,
              hotel_code: hotelCode || null,
              hotel_name: payload.hotelName,
              check_in: start,
              check_out: end,
              room_type: roomType,
              meal_plan: mealPlan,
              room_count: payload.roomCount,
              occupancy_snapshot: null,
              request_payload: JSON.stringify(payload),
              status,
              contact_email: email,
              contact_phone: phone,
              contact_source: contactSource,
              requested_at: now,
              cutoff_at: defaultCutoff,
              created_by: Number(input.actor?.id || 0) || null,
            },
          });
      await tx.dvi_hotel_block_event.create({
        data: {
          request_id: request.id,
          previous_status: existing?.status || null,
          new_status: status,
          event_type: existing ? 'REQUEST_RESUBMITTED' : 'REQUEST_CREATED',
          actor_type: input.actor?.type || 'STAFF',
          actor_id: Number(input.actor?.id || 0) || null,
          actor_name: input.actor?.name || null,
          notes: email ? 'Manual hotel hold request queued for email delivery.' : 'Manual hotel hold request created; hotel contact is required.',
          metadata: JSON.stringify({ reservationKey, provider }),
        },
      });
      await tx.dvi_hotel_block_token.create({
        data: { request_id: request.id, token_hash: tokenHash, expires_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) },
      });
      if (email) {
        await tx.dvi_hotel_block_message.create({
          data: { request_id: request.id, recipient: this.hotelBlockEmail.deliveryRecipient(email), delivery_status: 'QUEUED', attempt_count: 0 },
        });
      }
      return request;
    });
    return {
      ...this.publicStaffView(created),
      created: !existing,
      emailQueued: Boolean(email),
      responseUrl: `${publicItineraryBaseUrl()}/hotel/block-response/${rawToken}`,
    };
  }

  private async findByToken(rawToken: string) {
    const tokenHash = createHash('sha256').update(normalizeText(rawToken)).digest('hex');
    const token = await (this.prisma as any).dvi_hotel_block_token.findUnique({ where: { token_hash: tokenHash } });
    if (!token || token.revoked_at || new Date(token.expires_at).getTime() <= Date.now()) throw new NotFoundException('This hotel response link has expired or is invalid.');
    const request = await (this.prisma as any).dvi_hotel_block_request.findUnique({ where: { id: token.request_id } });
    if (!request) throw new NotFoundException('Hotel hold request not found.');
    return { ...request, tokenId: token.id };
  }

  private async recordResponse(requestId: number, input: any) {
    const requestedStatus = normalizeText(input.status).toUpperCase().replace(/\s+/g, '_');
    const status = ({
      HOLD: HOTEL_BLOCK_STATUS.BLOCKED,
      CONFIRM: HOTEL_BLOCK_STATUS.CONFIRMED,
      WAIT_LIST: HOTEL_BLOCK_STATUS.WAITLISTED,
    } as Record<string, string>)[requestedStatus] || requestedStatus;
    if (!RESPONSE_STATUSES.has(status)) throw new BadRequestException('A valid hotel response status is required.');
    const responseCutoff = input.cutoffAt ? new Date(input.cutoffAt) : null;
    if (responseCutoff && Number.isNaN(responseCutoff.getTime())) {
      throw new BadRequestException('A valid cutoff date and time is required.');
    }
    return this.transition(requestId, status, {
      actor: input.actor,
      eventType: 'HOTEL_RESPONSE_RECORDED',
      communicationChannel: normalizeText(input.communicationChannel).toUpperCase() || 'EMAIL',
      notes: normalizeText(input.notes) || null,
      confirmationReference: normalizeText(input.confirmationReference) || null,
      respondentName: normalizeText(input.respondentName) || null,
      cutoffAt: responseCutoff,
      tokenId: input.tokenId,
    });
  }

  private async transition(requestId: number, status: string, input: any) {
    const request = await (this.prisma as any).dvi_hotel_block_request.findUnique({ where: { id: Number(requestId) } });
    if (!request) throw new NotFoundException('Hotel hold request not found.');
    if ([HOTEL_BLOCK_STATUS.CANCELLED, HOTEL_BLOCK_STATUS.SUPERSEDED].includes(request.status)) throw new BadRequestException('This hotel hold request is no longer active.');
    if (request.status === HOTEL_BLOCK_STATUS.CONFIRMED && status !== HOTEL_BLOCK_STATUS.CONFIRMED) throw new BadRequestException('A confirmed hotel hold cannot be downgraded.');
    const now = new Date();
    const checkIn = dateOnly(request.check_in);
    const checkOut = dateOnly(request.check_out);
    if (checkIn && checkOut && checkOut.getTime() <= checkIn.getTime()) {
      throw new BadRequestException('Hotel checkout must be later than check-in.');
    }
    const keepsHoldCutoff = status === HOTEL_BLOCK_STATUS.BLOCKED || status === HOTEL_BLOCK_STATUS.CONFIRMED;
    const minimumCutoff = this.minimumHotelHoldCutoff(request, now);
    if (keepsHoldCutoff && input.cutoffAt && input.cutoffAt.getTime() < minimumCutoff.getTime()) {
      throw new BadRequestException('Hold cutoff cannot be before today or before the hotel check-in date and time.');
    }
    const defaultCutoff = keepsHoldCutoff && !request.cutoff_at ? await this.getDefaultHotelHoldCutoff(now) : null;
    const cutoffAt = input.cutoffAt || (defaultCutoff && defaultCutoff.getTime() < minimumCutoff.getTime() ? minimumCutoff : defaultCutoff);
    const updated = await (this.prisma as any).$transaction(async (tx: any) => {
      const result = await tx.dvi_hotel_block_request.update({
        where: { id: request.id },
        data: {
          status,
          responded_at: now,
          confirmed_at: status === HOTEL_BLOCK_STATUS.CONFIRMED ? now : null,
          // A wait-list or unavailable response ends the hold, so do not
          // leave the previous hold-until time visible in the booking modal.
          cutoff_at: keepsHoldCutoff ? cutoffAt : null,
          confirmation_reference: input.confirmationReference || undefined,
          confirmation_channel: input.communicationChannel || undefined,
          respondent_name: input.respondentName || undefined,
          responded_by: Number(input.actor?.id || 0) || null,
        },
      });
      await tx.dvi_hotel_block_event.create({
        data: {
          request_id: request.id,
          previous_status: request.status,
          new_status: status,
          event_type: input.eventType,
          actor_type: input.actor?.type || 'STAFF',
          actor_id: Number(input.actor?.id || 0) || null,
          actor_name: input.actor?.name || null,
          communication_channel: input.communicationChannel || null,
          notes: input.notes || null,
          metadata: JSON.stringify({ confirmationReference: input.confirmationReference || null }),
        },
      });
      if (input.tokenId) await tx.dvi_hotel_block_token.update({ where: { id: input.tokenId }, data: { used_at: now } });
      return result;
    });
    return { success: true, request: this.publicStaffView(updated) };
  }

  private publicStaffView(row: BlockRow) {
    return {
      id: row.id,
      itineraryPlanId: row.itinerary_plan_id,
      groupType: row.group_type,
      hotelName: row.hotel_name,
      provider: row.provider,
      hotelCode: row.hotel_code,
      checkIn: row.check_in,
      checkOut: row.check_out,
      roomType: row.room_type,
      mealPlan: row.meal_plan,
      roomCount: row.room_count,
      status: row.status,
      contactEmail: row.contact_email,
      contactPhone: row.contact_phone,
      requestedAt: row.requested_at,
      respondedAt: row.responded_at,
      cutoffAt: row.cutoff_at,
      confirmationReference: row.confirmation_reference,
      confirmationChannel: row.confirmation_channel,
      version: row.version,
    };
  }

  private publicSupplierView(row: BlockRow) {
    return {
      bookingReference: row.request_payload ? parseJson(row.request_payload)?.quotationPlanId : row.itinerary_plan_id,
      hotelName: row.hotel_name,
      provider: row.provider,
      checkIn: row.check_in,
      checkOut: row.check_out,
      roomType: row.room_type,
      mealPlan: row.meal_plan,
      roomCount: row.room_count,
      status: row.status,
      cutoffAt: row.cutoff_at,
      respondedAt: row.responded_at,
    };
  }

  private normalizeProvider(provider: unknown, bookingMode: unknown) {
    const normalized = normalizeText(provider).toLowerCase();
    if (normalized === 'tbo') return 'VSR';
    if (normalized) return normalized.toUpperCase();
    if (normalizeText(bookingMode).toUpperCase() === 'MANUAL_APPROVAL') return 'OFFLINE';
    return 'OTHER';
  }

  private resolveMealPlan(room: BlockRow) {
    if (!room) return 'Room Only';
    const plans: string[] = [];
    if (Number(room.breakfast_required) === 1) plans.push('Breakfast');
    if (Number(room.lunch_required) === 1) plans.push('Lunch');
    if (Number(room.dinner_required) === 1) plans.push('Dinner');
    return plans.join(' + ') || 'Room Only';
  }
}
