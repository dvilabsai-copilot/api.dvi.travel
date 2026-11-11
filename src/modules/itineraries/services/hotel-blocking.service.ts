import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../../prisma.service';
import { HotelBlockEmailService } from './hotel-block-email.service';
import { TboHotelBookingService } from './tbo-hotel-booking.service';
import {
  getTboPrebookHoldCancellationDeadline,
  isTboPrebookRateEligibleForHold,
} from '../utils/tbo-hold-eligibility.util';
import { AxisRoomsBookingPushService } from './axisrooms-booking-push.service';
import { resolveHotelHoldNotificationRecipients } from '../utils/hotel-hold-recipient.util';
import {
  DEFAULT_TBO_CHILD_AGE,
  distributeTboSearchOccupancies,
  resolveSavedTboChildAges,
} from '../../hotels/utils/tbo-occupancy.util';

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

type Actor = {
  id?: number;
  name?: string;
  type?: string;
  roleId?: number;
  permissionRoleId?: number;
  staffId?: number;
};
type BlockRow = Record<string, any>;
type TboHoldBookingInput = {
  hotelDetailsIds?: number[];
  selection?: Record<string, any>;
};
type ProviderHoldInput = {
  channel: 'AXISROOMS_HOLD' | 'OFFLINE_HOLD';
  confirmationReference?: string | null;
  request?: Record<string, any>;
  response?: unknown;
  hotelierContact?: { name: string; phone: string };
};

const ACTIVE_REQUEST_STATUSES = [
  HOTEL_BLOCK_STATUS.CONTACT_REQUIRED,
  HOTEL_BLOCK_STATUS.REQUESTED,
  HOTEL_BLOCK_STATUS.CONFIRMATION_AWAITED,
  HOTEL_BLOCK_STATUS.BLOCKED,
  HOTEL_BLOCK_STATUS.WAITLISTED,
];

const HOTEL_BLOCK_RESEND_WAIT_MS = 60 * 60 * 1000;

const RESPONSE_STATUSES = new Set<string>([
  HOTEL_BLOCK_STATUS.BLOCKED,
  HOTEL_BLOCK_STATUS.CONFIRMED,
  HOTEL_BLOCK_STATUS.WAITLISTED,
  HOTEL_BLOCK_STATUS.UNAVAILABLE,
]);

const normalizeText = (value: unknown) => String(value ?? '').trim();

export const isTboSupplierHoldRequest = (row: BlockRow): boolean => (
  normalizeText(row.confirmation_channel).toUpperCase() === 'TBO_BOOK_HOLD'
  && normalizeText(row.provider).toUpperCase() === 'VSR'
  && Boolean(normalizeText(row.confirmation_reference))
);

const isSupplierExpiredStatus = (value: unknown): boolean => {
  const status = normalizeText(value).toLowerCase();
  return Boolean(status) && [
    'cancelled', 'canceled', 'expired', 'void', 'rejected', 'failed', 'unavailable',
  ].some((term) => status.includes(term));
};

const isFutureDate = (value: unknown, now = new Date()): boolean => {
  const date = dateOnly(value);
  return Boolean(date && date.getTime() > now.getTime());
};

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

export const resolveHotelContact = (hotel?: BlockRow, tboMaster?: BlockRow): BlockRow => {
  const primaryEmail = firstEmail(hotel?.hotel_email);
  const fallbackEmail = firstEmail(tboMaster?.hotel_email);
  const primaryPhone = normalizeText(hotel?.hotel_mobile);
  const fallbackPhone = normalizeText(tboMaster?.hotel_mobile);
  return {
    ...(hotel || {}),
    hotel_name: normalizeText(hotel?.hotel_name) || normalizeText(tboMaster?.hotel_name) || null,
    hotel_email: primaryEmail || fallbackEmail || null,
    hotel_mobile: primaryPhone || fallbackPhone || null,
  };
};

const dateOnly = (value: unknown): Date | null => {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
};

const dateDayNumber = (value: unknown, timezoneOffsetMinutes = 0): number | null => {
  if (typeof value === 'string') {
    const localDate = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (localDate) return Date.UTC(Number(localDate[1]), Number(localDate[2]) - 1, Number(localDate[3])) / 86_400_000;
  }
  const date = dateOnly(value);
  if (!date) return null;
  const hotelLocal = new Date(date.getTime() + timezoneOffsetMinutes * 60_000);
  return Date.UTC(hotelLocal.getUTCFullYear(), hotelLocal.getUTCMonth(), hotelLocal.getUTCDate()) / 86_400_000;
};

const isoTimezoneOffsetMinutes = (value: unknown): number => {
  if (typeof value !== 'string') return 0;
  const match = value.trim().match(/([+-])(\d{2}):?(\d{2})$/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '+' ? minutes : -minutes;
};

export type HotelHoldPolicy = {
  noBlockBeforeHours: number;
  minimumLeadDays: number;
  shortLeadDays: number;
  mediumLeadDays: number;
  longLeadDays: number;
  shortDurationHours: number;
  mediumDurationHours: number;
  longDurationHours: number;
  extendedDurationHours: number;
  tboHoldLcdBufferDays: number;
};

export const DEFAULT_HOTEL_HOLD_POLICY: HotelHoldPolicy = {
  noBlockBeforeHours: 48,
  minimumLeadDays: 1,
  shortLeadDays: 15,
  mediumLeadDays: 30,
  longLeadDays: 60,
  shortDurationHours: 48,
  mediumDurationHours: 12,
  longDurationHours: 48,
  extendedDurationHours: 240,
  tboHoldLcdBufferDays: 1,
};

const finiteNumber = (value: unknown, fallback: number, minimum = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(parsed, minimum) : fallback;
};

const integerNumber = (value: unknown, fallback: number, minimum = 0) => Math.trunc(finiteNumber(value, fallback, minimum));

export const hotelHoldDecision = (
  checkIn: unknown,
  requestedAt: unknown = new Date(),
  policy: HotelHoldPolicy = DEFAULT_HOTEL_HOLD_POLICY,
) => {
  const arrival = dateOnly(checkIn);
  const requested = dateOnly(requestedAt);
  if (!arrival || !requested) {
    return { allowed: false, durationHours: null, leadDays: null, leadHours: null, band: null, reason: 'invalid check-in or request date' };
  }

  const leadHours = (arrival.getTime() - requested.getTime()) / (60 * 60 * 1000);
  const hotelTimezoneOffset = isoTimezoneOffsetMinutes(checkIn);
  // Keep the original check-in representation when counting its calendar day.
  // Converting an offset timestamp to Date first changes the UTC day and can
  // incorrectly move a hotel-local Day-3 check-in into the no-hold band.
  const checkInDay = dateDayNumber(checkIn);
  const requestedDay = dateDayNumber(requested, hotelTimezoneOffset);
  const leadDays = checkInDay === null || requestedDay === null ? null : checkInDay - requestedDay;
  const validPolicy = Number.isFinite(policy.noBlockBeforeHours)
    && policy.noBlockBeforeHours >= 0
    && Number.isInteger(policy.minimumLeadDays)
    && policy.minimumLeadDays >= 1
    && Number.isInteger(policy.shortLeadDays)
    && policy.shortLeadDays >= policy.minimumLeadDays
    && Number.isInteger(policy.mediumLeadDays)
    && policy.mediumLeadDays > policy.shortLeadDays
    && Number.isInteger(policy.longLeadDays)
    && policy.longLeadDays > policy.mediumLeadDays
    && [policy.shortDurationHours, policy.mediumDurationHours, policy.longDurationHours, policy.extendedDurationHours]
      .every((hours) => Number.isFinite(hours) && hours > 0);
  if (!validPolicy) {
    return { allowed: false, durationHours: null, leadDays, leadHours, band: null, reason: 'hotel hold policy is invalid' };
  }
  if (leadDays === null) {
    return { allowed: false, durationHours: null, leadDays: null, leadHours, band: null, reason: 'invalid check-in or request date' };
  }
  if (leadDays < 0) {
    return { allowed: false, durationHours: null, leadDays, leadHours, band: null, reason: 'check-in has passed' };
  }
  if (leadDays < policy.minimumLeadDays) {
    return {
      allowed: false,
      durationHours: null,
      leadDays,
      leadHours,
      band: null,
      reason: `check-in is less than the configured minimum lead time of ${policy.minimumLeadDays} days`,
    };
  }
  if (leadHours <= policy.noBlockBeforeHours) {
    return {
      allowed: false,
      durationHours: null,
      leadDays,
      leadHours,
      band: null,
      reason: `check-in is within the configured ${policy.noBlockBeforeHours}-hour no-block window`,
    };
  }
  if (leadDays <= policy.shortLeadDays) {
    return { allowed: true, durationHours: policy.shortDurationHours, leadDays, leadHours, band: `${policy.minimumLeadDays}-${policy.shortLeadDays}` };
  }
  if (leadDays <= policy.mediumLeadDays) {
    return { allowed: true, durationHours: policy.mediumDurationHours, leadDays, leadHours, band: `${policy.shortLeadDays + 1}-${policy.mediumLeadDays}` };
  }
  if (leadDays <= policy.longLeadDays) {
    return { allowed: true, durationHours: policy.longDurationHours, leadDays, leadHours, band: `${policy.mediumLeadDays + 1}-${policy.longLeadDays}` };
  }
  return { allowed: true, durationHours: policy.extendedDurationHours, leadDays, leadHours, band: `${policy.longLeadDays + 1}+` };
};

/**
 * Hotel hold duration is based on the calendar-day lead time at the moment
 * the hold request is created. Hold eligibility is evaluated separately by
 * hotelHoldDecision so callers can show a policy-specific alert.
 */
export const hotelHoldDurationHours = (
  checkIn: unknown,
  requestedAt: unknown = new Date(),
  policy: HotelHoldPolicy = DEFAULT_HOTEL_HOLD_POLICY,
): number => {
  return hotelHoldDecision(checkIn, requestedAt, policy).durationHours ?? 0;
};

export const hotelHoldCutoffAt = (
  checkIn: unknown,
  requestedAt: unknown = new Date(),
  policy: HotelHoldPolicy = DEFAULT_HOTEL_HOLD_POLICY,
): Date => {
  const anchor = dateOnly(requestedAt);
  const decision = hotelHoldDecision(checkIn, anchor, policy);
  if (!anchor || !decision.allowed || !decision.durationHours) {
    throw new BadRequestException(`Hotel hold is not allowed: ${decision.reason || 'invalid hold dates'}.`);
  }
  return new Date(anchor.getTime() + decision.durationHours * 60 * 60 * 1000);
};

const rowSnapshot = (row: BlockRow) => row.__snapshot || parseJson(row.selected_price_snapshot) || {};

const rowCheckIn = (row: BlockRow): Date | null => dateOnly(
  row.hotel_check_in_date || row.itinerary_route_date || rowSnapshot(row).authoritativeCheckInDate,
);

const rowCheckOut = (row: BlockRow): Date | null => dateOnly(
  row.hotel_check_out_date || rowSnapshot(row).authoritativeCheckOutDate || row.hotel_check_in_date || row.itinerary_route_date || rowSnapshot(row).authoritativeCheckInDate,
);

const hotelIdentity = (value: BlockRow) => ({
  provider: normalizeText(value.hotel_provider || value.provider).toLowerCase(),
  hotelId: Number(value.hotel_id || value.hotelId || 0),
  hotelCode: normalizeText(value.hotel_code || value.hotelCode).toLowerCase(),
  hotelName: normalizeText(value.hotel_name || value.hotelName || rowSnapshot(value).hotelName).toLowerCase(),
});

const isSameHotel = (request: BlockRow, row: BlockRow) => {
  const previous = hotelIdentity(request);
  const current = hotelIdentity(row);
  if (previous.hotelCode && current.hotelCode) {
    return previous.provider === current.provider && previous.hotelCode === current.hotelCode;
  }
  if (previous.hotelId > 0 && current.hotelId > 0) return previous.hotelId === current.hotelId;
  return Boolean(previous.hotelName && current.hotelName && previous.hotelName === current.hotelName);
};

/** Groups rows for one hotel into continuous date runs without merging gaps. */
export const groupContinuousHotelRows = <T>(
  rows: readonly T[],
  getGroupKey: (row: T) => string,
  getCheckIn: (row: T) => unknown,
  getCheckOut: (row: T) => unknown,
): T[][] => {
  const sorted = rows
    .map((row, index) => ({ row, index, day: dateDayNumber(getCheckIn(row)) }))
    .sort((left, right) => (left.day ?? Number.MAX_SAFE_INTEGER) - (right.day ?? Number.MAX_SAFE_INTEGER) || left.index - right.index);
  const latestByKey = new Map<string, { rows: T[]; endDay: number | null }>();
  const output: T[][] = [];

  for (const item of sorted) {
    const key = getGroupKey(item.row);
    const startDay = item.day;
    const endDay = dateDayNumber(getCheckOut(item.row)) ?? startDay;
    const previous = latestByKey.get(key);
    const isContinuous = Boolean(
      previous
      && startDay !== null
      && previous.endDay !== null
      && startDay - previous.endDay <= 1,
    );
    if (!isContinuous) {
      const next = { rows: [item.row], endDay: endDay === null ? null : Math.max(startDay ?? endDay, endDay) };
      latestByKey.set(key, next);
      output.push(next.rows);
      continue;
    }
    previous.rows.push(item.row);
    if (endDay !== null) previous.endDay = Math.max(previous.endDay ?? endDay, endDay);
  }
  return output;
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
    private readonly tboHotelBooking: TboHotelBookingService,
    @Optional() private readonly axisRoomsBookingPushService?: AxisRoomsBookingPushService,
  ) {}

  private async getHotelHoldPolicy(): Promise<HotelHoldPolicy> {
    let settings: BlockRow | null = null;
    try {
      settings = await (this.prisma as any).dvi_global_settings.findFirst({
        where: { deleted: 0, status: 1 },
        orderBy: { global_settings_ID: 'asc' },
        select: {
          hotel_hold_no_block_before_hours: true,
          hotel_hold_min_lead_days: true,
          hotel_hold_short_lead_days: true,
          hotel_hold_medium_lead_days: true,
          hotel_hold_long_lead_days: true,
          hotel_hold_short_duration_hours: true,
          hotel_hold_medium_duration_hours: true,
          hotel_hold_long_duration_hours: true,
          hotel_hold_extended_duration_hours: true,
          tbo_hold_lcd_buffer_days: true,
        },
      });
    } catch {
      // Older databases may not have the additive policy columns yet. The
      // migration applies the same defaults, so this remains safe during rollout.
    }

    const policy: HotelHoldPolicy = {
      noBlockBeforeHours: finiteNumber(settings?.hotel_hold_no_block_before_hours, DEFAULT_HOTEL_HOLD_POLICY.noBlockBeforeHours),
      minimumLeadDays: integerNumber(settings?.hotel_hold_min_lead_days, DEFAULT_HOTEL_HOLD_POLICY.minimumLeadDays),
      shortLeadDays: integerNumber(settings?.hotel_hold_short_lead_days, DEFAULT_HOTEL_HOLD_POLICY.shortLeadDays),
      mediumLeadDays: integerNumber(settings?.hotel_hold_medium_lead_days, DEFAULT_HOTEL_HOLD_POLICY.mediumLeadDays),
      longLeadDays: integerNumber(settings?.hotel_hold_long_lead_days, DEFAULT_HOTEL_HOLD_POLICY.longLeadDays),
      shortDurationHours: finiteNumber(settings?.hotel_hold_short_duration_hours, DEFAULT_HOTEL_HOLD_POLICY.shortDurationHours),
      mediumDurationHours: finiteNumber(settings?.hotel_hold_medium_duration_hours, DEFAULT_HOTEL_HOLD_POLICY.mediumDurationHours),
      longDurationHours: finiteNumber(settings?.hotel_hold_long_duration_hours, DEFAULT_HOTEL_HOLD_POLICY.longDurationHours),
      extendedDurationHours: finiteNumber(settings?.hotel_hold_extended_duration_hours, DEFAULT_HOTEL_HOLD_POLICY.extendedDurationHours),
      tboHoldLcdBufferDays: integerNumber(settings?.tbo_hold_lcd_buffer_days, DEFAULT_HOTEL_HOLD_POLICY.tboHoldLcdBufferDays),
    };
    const policyCheck = hotelHoldDecision(new Date(Date.now() + 100 * 86_400_000), new Date(), policy);
    if (!policyCheck.allowed) throw new BadRequestException('Hotel hold policy configuration is invalid. Update Global Settings before creating holds.');
    return policy;
  }

  async getHoldPolicyDecision(checkIn: unknown, requestedAt: unknown = new Date()) {
    const policy = await this.getHotelHoldPolicy();
    const decision = hotelHoldDecision(checkIn, requestedAt, policy);
    const cutoffAt = decision.allowed && decision.durationHours
      ? hotelHoldCutoffAt(checkIn, requestedAt, policy)
      : null;
    return {
      ...decision,
      cutoffAt: cutoffAt?.toISOString() || null,
      // Keep the response shape stable while reporting the shared policy
      // cutoff for AxisRooms rather than an additional provider-specific cap.
      supplierCutoffs: {
        axisRooms: cutoffAt?.toISOString() || null,
        tboLcdBufferDays: policy.tboHoldLcdBufferDays,
      },
    };
  }

  private getDefaultHotelHoldCutoff(checkIn: unknown, requestedAt = new Date(), policy = DEFAULT_HOTEL_HOLD_POLICY) {
    return hotelHoldCutoffAt(checkIn, requestedAt, policy);
  }

  private maxHotelHoldCutoff(request: BlockRow, now = new Date(), policy = DEFAULT_HOTEL_HOLD_POLICY) {
    const requestedAt = dateOnly(request.requested_at) || now;
    const isTboHold = request.confirmation_channel === 'TBO_BOOK_HOLD';
    const policyCutoff = this.getDefaultHotelHoldCutoff(request.check_in, requestedAt, policy);
    if (isTboHold) {
      const supplierDeadline = new Date(parseJson(request.request_payload, {})?.supplierHold?.lcdDeadlineAt || '');
      if (!Number.isNaN(supplierDeadline.getTime()) && supplierDeadline.getTime() < policyCutoff.getTime()) {
        return supplierDeadline;
      }
    }
    // Preserve an already stored legacy cutoff as a valid ceiling. New
    // requests are always created within the lead-time policy above.
    const existingCutoff = dateOnly(request.cutoff_at);
    return existingCutoff && existingCutoff.getTime() > policyCutoff.getTime()
      ? existingCutoff
      : policyCutoff;
  }

  private minimumHotelHoldCutoff(request: BlockRow, now = new Date()) {
    const existingCutoff = dateOnly(request.cutoff_at);
    if (existingCutoff && existingCutoff.getTime() > now.getTime()) return existingCutoff;
    return now;
  }

  async holdGroup(input: {
    itineraryPlanId: number;
    groupType: number;
    actor?: Actor;
    guest?: { name?: string; email?: string; phone?: string };
    hotelierContact?: { name?: string; phone?: string };
    hotelDetailsIds?: number[];
    tboHoldBookings?: TboHoldBookingInput[];
  }) {
    const planId = Number(input.itineraryPlanId);
    const groupType = Number(input.groupType || 0);
    if (!Number.isInteger(planId) || planId <= 0) throw new BadRequestException('A valid itinerary plan is required.');
    if (!Number.isInteger(groupType) || groupType <= 0) throw new BadRequestException('A valid recommendation group is required.');
    if (!normalizeText(input.guest?.name)) throw new BadRequestException('Primary guest name is required before holding hotels.');
    if (!normalizeText(input.guest?.phone)) throw new BadRequestException('Primary guest contact number is required before holding hotels.');
    if (!firstEmail(input.guest?.email)) throw new BadRequestException('Primary guest email is required before holding hotels.');
    const scopedHotelDetailsIds = Array.isArray(input.hotelDetailsIds)
      ? Array.from(new Set(input.hotelDetailsIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)))
      : null;
    if (scopedHotelDetailsIds && scopedHotelDetailsIds.length === 0) {
      throw new BadRequestException('A valid selected hotel stay is required.');
    }
    const tboHoldBookings = Array.isArray(input.tboHoldBookings) ? input.tboHoldBookings : [];
    const requestedAt = new Date();
    const policy = await this.getHotelHoldPolicy();
    const planModel = (this.prisma as any).dvi_itinerary_plan_details;
    const itineraryPlan = planModel?.findUnique
      ? await planModel.findUnique({
          where: { itinerary_plan_ID: planId },
          select: {
            itinerary_quote_ID: true,
            total_adult: true,
            total_children: true,
            preferred_room_count: true,
            nationality: true,
            agent_id: true,
            staff_id: true,
            createdby: true,
          },
        })
      : null;

    const rows = await (this.prisma as any).dvi_itinerary_plan_hotel_details.findMany({
      where: {
        itinerary_plan_id: planId,
        group_type: groupType,
        deleted: 0,
        status: 1,
        hotel_required: { not: 2 },
        NOT: { selection_origin: 'USER_REMOVED' },
        ...(scopedHotelDetailsIds
          ? { itinerary_plan_hotel_details_ID: { in: scopedHotelDetailsIds } }
          : {}),
      },
      orderBy: [{ itinerary_route_date: 'asc' }, { itinerary_plan_hotel_details_ID: 'asc' }],
    });
    if (!rows.length) throw new BadRequestException(
      scopedHotelDetailsIds
        ? 'The selected hotel stay is no longer available. Refresh the itinerary and try again.'
        : 'No selected hotel stays were found for this recommendation group.',
    );

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
    const tboHotelCodes = Array.from(new Set(rows.flatMap((row: BlockRow) => {
      const snapshot = parseJson(row.selected_price_snapshot) || {};
      return [row.hotel_code, snapshot.hotelCode, row.provider_hotel_code]
        .map(normalizeText)
        .filter(Boolean);
    })));
    const tboMasterModel = (this.prisma as any).tbo_hotel_master;
    const tboMasters = tboHotelCodes.length && tboMasterModel?.findMany
      ? await tboMasterModel.findMany({
          where: { tbo_hotel_code: { in: tboHotelCodes } },
          select: { tbo_hotel_code: true, hotel_name: true, hotel_email: true, hotel_mobile: true },
        })
      : [];
    const tboMasterByCode = new Map(
      tboMasters.map((hotel: BlockRow) => [normalizeText(hotel.tbo_hotel_code), hotel]),
    );
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

    const tboHoldBookingBySelectionId = new Map<number, TboHoldBookingInput>();
    for (const booking of tboHoldBookings) {
      for (const selectionId of Array.isArray(booking?.hotelDetailsIds)
        ? booking.hotelDetailsIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)
        : []) {
        tboHoldBookingBySelectionId.set(selectionId, booking);
      }
    }

    // Reopening the modal or retrying the same action must not issue another
    // supplier hold for the same selected hotel/rate while the existing hold
    // is still active.
    const existingSupplierHolds = await (this.prisma as any).dvi_hotel_block_request.findMany({
      where: {
        itinerary_plan_id: planId,
        group_type: groupType,
        status: { in: ACTIVE_REQUEST_STATUSES },
        confirmation_channel: { in: ['TBO_BOOK_HOLD', 'AXISROOMS_HOLD'] },
      },
      orderBy: { id: 'asc' },
    });

    const preparedRows: BlockRow[] = [];
    for (const row of rows) {
      const room = roomsBySelection.get(Number(row.itinerary_plan_hotel_details_ID));
      const snapshot = parseJson(row.selected_price_snapshot) || {};
      const hotel = (
        hotelById.get(Number(row.hotel_id || 0))
        || hotelByName.get(normalizeText(snapshot.hotelName).toLowerCase())
      ) as BlockRow | undefined;
      const provider = this.normalizeProvider(row.hotel_provider, row.hotel_booking_mode);
      const hotelCode = normalizeText(row.hotel_code) || normalizeText(snapshot.hotelCode) || String(row.hotel_id || '');
      const tboMaster = provider === 'VSR'
        ? tboMasterByCode.get(hotelCode) as BlockRow | undefined
        : undefined;
      const hotelRecord = hotel || tboMaster
        ? resolveHotelContact(hotel, tboMaster)
        : undefined;
      const hotelIdentity = hotelCode || `name:${normalizeText(hotelRecord?.hotel_name || snapshot.hotelName || row.hotel_name).toLowerCase()}`;
      preparedRows.push({
        ...row,
        hotel_code: normalizeText(row.hotel_code) || hotelCode || null,
        __room: room,
        __hotel: hotelRecord,
        __snapshot: snapshot,
        __hotelGroupKey: `${provider}|${hotelIdentity.toLowerCase()}`,
      });
    }

    const results: any[] = [];
    const outcomes: any[] = [];
    const groups = groupContinuousHotelRows(
      preparedRows,
      (row) => String(row.__hotelGroupKey || ''),
      rowCheckIn,
      rowCheckOut,
    );
    for (const groupedRows of groups) {
      const first = groupedRows[0];
      const provider = this.normalizeProvider(first.hotel_provider, first.hotel_booking_mode);
      const selectionIds = groupedRows
        .map((row: BlockRow) => Number(row.itinerary_plan_hotel_details_ID || 0))
        .filter((id) => Number.isInteger(id) && id > 0);
      const snapshot = rowSnapshot(first);
      const hotelName = normalizeText(first.__hotel?.hotel_name)
        || normalizeText(snapshot.hotelName)
        || normalizeText(first.hotel_name)
        || 'Hotel';
      const decision = hotelHoldDecision(rowCheckIn(first), requestedAt, policy);
      const outcomeBase = { provider, hotelName, selectionIds };
      if (!decision.allowed) {
        outcomes.push({
          ...outcomeBase,
          success: false,
          status: 'NOT_ELIGIBLE',
          errorCode: 'HOTEL_HOLD_NOT_ALLOWED',
          message: `Hotel blocking is not allowed for this stay: ${decision.reason || 'immediate payment is required.'}`,
        });
        continue;
      }
      if (provider === 'OFFLINE') {
        const actor = input.actor || {};
        const isTravelExpert = Number(actor.roleId || 0) === 8
          || (Number(actor.roleId || 0) === 3
            && Number(actor.permissionRoleId || 0) === 3
            && Number(actor.staffId || 0) > 0);
        if (!isTravelExpert) {
          outcomes.push({ ...outcomeBase, success: false, status: 'ACTION_REQUIRED', errorCode: 'OFFLINE_TRAVEL_EXPERT_REQUIRED', message: 'Only a Travel Expert can keep an offline hotel hold.' });
          continue;
        }
        if (!normalizeText(input.hotelierContact?.name) || !normalizeText(input.hotelierContact?.phone)) {
          outcomes.push({ ...outcomeBase, success: false, status: 'CONTACT_REQUIRED', errorCode: 'OFFLINE_CONTACT_REQUIRED', message: 'Hotelier contact name and phone are required to keep an offline hotel hold. Use the row Hold action.' });
          continue;
        }
      }
      try {
      if (provider === 'VSR') {
        const tboHoldBooking = selectionIds
          .map((id) => tboHoldBookingBySelectionId.get(id))
          .find((booking) => Boolean(booking?.selection));
        const snapshot = rowSnapshot(first);
        const refundable = snapshot.isRefundable ?? snapshot.IsRefundable ?? first.is_refundable ?? first.IsRefundable;
        if (!(refundable === true || Number(refundable) === 1 || String(refundable).toLowerCase() === 'true')) {
          throw new BadRequestException(
            `HOTEL_HOLD_PAYMENT_REQUIRED: VSR hotel ${normalizeText(snapshot.hotelName) || normalizeText(first.hotel_name) || 'rate'} is not refundable and cannot be held.`,
          );
        }
        if (!tboHoldBooking?.selection) {
          throw new BadRequestException(
            'A fresh VSR booking selection is required before holding this hotel. Refresh the rate and try again.',
          );
        }

        const selection = tboHoldBooking.selection as any;
        const reusable = (existingSupplierHolds as BlockRow[]).find((candidate) => (
          this.isReusableSupplierHold(candidate, groupedRows, selection, requestedAt)
        ));
        if (reusable) {
          const result = {
            ...this.publicStaffView(reusable, policy, undefined, 'HOLD'),
            created: false,
            emailQueued: false,
            supplierBookingReference: reusable.confirmation_reference,
            responseUrl: undefined,
          };
          results.push(result);
          outcomes.push({ ...outcomeBase, success: true, status: 'ALREADY_HELD', requestId: result.id, holdStatus: result.status, cutoffAt: result.cutoffAt });
          continue;
        }
        const travellerModel = (this.prisma as any).dvi_itinerary_traveller_details;
        const savedChildren = travellerModel?.findMany
          ? await travellerModel.findMany({
              where: { itinerary_plan_ID: planId, traveller_type: 2, deleted: 0 },
              orderBy: { traveller_details_ID: 'asc' },
              select: { traveller_age: true },
            })
          : [];
        const childCount = Math.max(Number(itineraryPlan?.total_children || 0), 0);
        const childAges = resolveSavedTboChildAges(savedChildren || [], childCount);
        const roomCount = Math.max(
          Number(itineraryPlan?.preferred_room_count || selection.numberOfRooms || 1),
          1,
        );
        const adultCount = Math.max(Number(itineraryPlan?.total_adult || 0), 1);
        const occupancies = distributeTboSearchOccupancies(roomCount, adultCount, childCount, childAges);
        const childPassengerAges = occupancies.flatMap((occupancy) => occupancy.childrenAges || []);
        const childPassengers = (Array.isArray(selection.passengers) ? selection.passengers : [])
          .filter((passenger: BlockRow) => Number(passenger?.paxType) === 2);
        if (childPassengers.length !== childCount) {
          throw new BadRequestException(
            'Saved child guest count changed. Refresh the itinerary confirmation details before holding this hotel.',
          );
        }
        let childPassengerIndex = 0;
        const passengers = (Array.isArray(selection.passengers) ? selection.passengers : []).map((passenger: BlockRow) => {
          if (Number(passenger?.paxType) !== 2) return passenger;
          const age = childPassengerAges[childPassengerIndex] ?? DEFAULT_TBO_CHILD_AGE;
          childPassengerIndex += 1;
          return { ...passenger, age };
        });
        const selectionWithHoldMode = {
          ...selection,
          numberOfRooms: roomCount,
          occupancies,
          passengers,
          isVoucherBooking: false,
        };
        const preBookResponse = await this.tboHotelBooking.preBookHotelForHold(selectionWithHoldMode);
        if (!isTboPrebookRateEligibleForHold(preBookResponse as any, policy.tboHoldLcdBufferDays)) {
          throw new BadRequestException(
            `HOTEL_HOLD_NOT_ELIGIBLE: The latest VSR rate must be refundable and have a cancellation deadline at least ${policy.tboHoldLcdBufferDays} day(s) away to be held. Refresh the rate and try again.`,
          );
        }
        const lcdDeadline = getTboPrebookHoldCancellationDeadline(preBookResponse as any);
        if (!lcdDeadline) {
          throw new BadRequestException(
            'HOTEL_HOLD_NOT_ELIGIBLE: The fresh VSR rate did not include a valid cancellation deadline. Refresh the rate and try again.',
          );
        }
        const prebookNetAmount = Number(
          preBookResponse?.NetAmount
            ?? preBookResponse?.TotalFare
            ?? preBookResponse?.HotelResult?.[0]?.Rooms?.[0]?.NetAmount
            ?? selection.netAmount,
        );
        const bookResponse = await this.tboHotelBooking.holdHotel(
          preBookResponse,
          { ...selectionWithHoldMode, netAmount: prebookNetAmount },
        );
        const bookingReference = String(
          bookResponse?.BookResult?.BookingRefNo
            || bookResponse?.BookResult?.ConfirmationNo
            || bookResponse?.BookResult?.BookingId
            || '',
        ).trim();
        const bookingId = Number(bookResponse?.BookResult?.BookingId || 0) || undefined;
        const result = await this.upsertRequest({
          planId,
          groupType,
          rows: groupedRows,
          hotel: first.__hotel,
          actor: input.actor,
          guest: input.guest,
          policy,
          requestedAt,
          scopedSelection: Boolean(scopedHotelDetailsIds),
          supplierHold: {
            bookingReference,
            bookingId,
            bookResponse,
            selection: selectionWithHoldMode,
            lcdDeadlineAt: lcdDeadline.toISOString(),
          },
        });
        results.push(result);
        outcomes.push({ ...outcomeBase, success: true, status: 'HELD', requestId: result.id, holdStatus: result.status, cutoffAt: result.cutoffAt });
        continue;
      }

      if (provider === 'AXISROOMS') {
        selectionIds.sort((a, b) => a - b);
        const reusable = (existingSupplierHolds as BlockRow[]).find((candidate) => {
          if (candidate.confirmation_channel !== 'AXISROOMS_HOLD' || !isFutureDate(candidate.cutoff_at, requestedAt)) return false;
          const candidateIds = (parseJson(candidate.selection_ids, []) as unknown[])
            .map(Number)
            .filter((id) => Number.isInteger(id) && id > 0)
            .sort((a, b) => a - b);
          return candidateIds.length === selectionIds.length
            && candidateIds.every((id, index) => id === selectionIds[index]);
        });
        if (reusable) {
          const result = {
            ...this.publicStaffView(reusable, policy),
            created: false,
            emailQueued: false,
            supplierBookingReference: reusable.confirmation_reference,
            responseUrl: undefined,
          };
          results.push(result);
          outcomes.push({ ...outcomeBase, success: true, status: 'ALREADY_HELD', requestId: result.id, holdStatus: result.status, cutoffAt: result.cutoffAt });
          continue;
        }
        if (!this.axisRoomsBookingPushService) {
          throw new BadRequestException('AxisRooms booking notification service is not configured.');
        }
        const snapshot = rowSnapshot(first);
        const checkIn = rowCheckIn(first);
        const routeIds = groupedRows
          .map((row: BlockRow) => Number(row.itinerary_route_id || 0))
          .filter((id) => Number.isInteger(id) && id > 0);
        const routeId = routeIds[0] || 0;
        const checkInDate = checkIn?.toISOString().slice(0, 10) || '';
        const checkOutDate = rowCheckOut(groupedRows[groupedRows.length - 1])?.toISOString().slice(0, 10) || checkInDate;
        const roomCount = Math.max(...groupedRows.map((row: BlockRow) => Number(row.total_no_of_rooms || row.__room?.room_qty || 0)), 1);
        const totalAdults = Math.max(Number(itineraryPlan?.total_adult || 0), 0);
        const totalChildren = Math.max(Number(itineraryPlan?.total_children || 0), 0);
        const leadName = normalizeText(input.guest?.name);
        const booking = {
          routeId,
          routeIds,
          hotelCode: normalizeText(first.hotel_code) || String(first.hotel_id || ''),
          hotelName: normalizeText(first.__hotel?.hotel_name) || normalizeText(snapshot.hotelName) || 'Hotel',
          bookingCode: normalizeText(snapshot.bookingCode) || normalizeText(first.selected_rate_option_id),
          roomId: normalizeText(snapshot.roomId) || normalizeText(first.__room?.room_type_id),
          rateId: normalizeText(snapshot.rateId) || normalizeText(first.selected_rate_option_id),
          roomType: normalizeText(snapshot.roomType) || normalizeText(first.__room?.room_type_name) || 'Room',
          checkInDate,
          checkOutDate,
          numberOfRooms: roomCount,
          guestNationality: normalizeText(snapshot.guestNationality) || String(itineraryPlan?.nationality || ''),
          netAmount: groupedRows.reduce((sum: number, row: BlockRow) => sum + Number(row.total_room_cost || row.total_hotel_cost || 0), 0),
          occupancies: [{ adults: totalAdults, children: totalChildren }],
          passengers: [{
            firstName: leadName,
            email: normalizeText(input.guest?.email),
            phoneNo: normalizeText(input.guest?.phone),
            paxType: 1,
            leadPassenger: true,
          }],
          multiNightBooking: groupedRows.length > 1,
          nights: groupedRows.length,
        };
        const confirmationNo = `DVI-HOLD-${planId}-${routeId}-${booking.hotelCode || 'NA'}`;
        const pushResult = await this.axisRoomsBookingPushService.pushForHotelSelection({
          bookingStatus: 'confirmed',
          confirmedItineraryPlanId: planId,
          itineraryPlanId: planId,
          hotel: booking,
          confirmationNo,
          persistConfirmation: false,
          fallbackBookedBy: leadName,
          fallbackEmail: normalizeText(input.guest?.email),
          fallbackPhone: normalizeText(input.guest?.phone),
        });
        if (!pushResult.success) {
          throw new BadRequestException(`AXISROOMS_HOLD_FAILED: ${pushResult.error || pushResult.message}`);
        }
        const result = await this.upsertRequest({
          planId,
          groupType,
          rows: groupedRows,
          hotel: first.__hotel,
          actor: input.actor,
          guest: input.guest,
          policy,
          requestedAt,
          scopedSelection: Boolean(scopedHotelDetailsIds),
          providerHold: {
            channel: 'AXISROOMS_HOLD',
            confirmationReference: confirmationNo,
            request: pushResult.payload,
            response: pushResult.response,
          },
        });
        results.push(result);
        outcomes.push({ ...outcomeBase, success: true, status: 'HELD', requestId: result.id, holdStatus: result.status, cutoffAt: result.cutoffAt });
        continue;
      }

      if (provider === 'OFFLINE') {
        const result = await this.upsertRequest({
          planId,
          groupType,
          rows: groupedRows,
          hotel: first.__hotel,
          actor: input.actor,
          guest: input.guest,
          policy,
          requestedAt,
          scopedSelection: Boolean(scopedHotelDetailsIds),
          providerHold: {
            channel: 'OFFLINE_HOLD',
            hotelierContact: {
              name: normalizeText(input.hotelierContact?.name),
              phone: normalizeText(input.hotelierContact?.phone),
            },
          },
        });
        results.push(result);
        outcomes.push({ ...outcomeBase, success: true, status: 'HELD', requestId: result.id, holdStatus: result.status, cutoffAt: result.cutoffAt });
        continue;
      }

      const result = await this.upsertRequest({
        planId,
        groupType,
        rows: groupedRows,
        hotel: first.__hotel,
        actor: input.actor,
        guest: input.guest,
        policy,
        requestedAt,
        scopedSelection: Boolean(scopedHotelDetailsIds),
      });
      results.push(result);
      outcomes.push({ ...outcomeBase, success: true, status: 'HELD', requestId: result.id, holdStatus: result.status, cutoffAt: result.cutoffAt });
      } catch (error) {
        const response = (error as any)?.getResponse?.();
        const responseMessage = typeof response === 'string'
          ? response
          : Array.isArray(response?.message)
            ? response.message.join('; ')
            : normalizeText(response?.message);
        const message = responseMessage || (error instanceof Error ? error.message : String(error));
        const code = message.match(/\b(HOTEL_HOLD_[A-Z_]+|AXISROOMS_HOLD_FAILED)\b/i)?.[1]?.toUpperCase() || 'HOTEL_HOLD_FAILED';
        outcomes.push({
          ...outcomeBase,
          success: false,
          status: 'FAILED',
          errorCode: code,
          message: message.replace(/^\w+:\s*/, '').trim() || 'The hotel hold could not be completed.',
        });
        // Do not let a provider rejection stop independent hotel stays from being processed.
      }
    }

    for (const result of results) {
      if (!result.emailQueued || !result.contactEmail || (!result.responseUrl && result.emailKind !== 'HOLD_NOTICE')) continue;
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

    const newlyCreatedHolds = results.filter((result) => result.created && (
      result.emailKind === 'HOLD_NOTICE' || Boolean(result.supplierBookingReference)
    ));
    if (newlyCreatedHolds.length && itineraryPlan) {
      try {
        const recipients = await resolveHotelHoldNotificationRecipients(this.prisma, itineraryPlan);
        if (recipients.length) {
          const baseUrl = String(process.env.PUBLIC_ITINERARY_BASE_URL || '').trim().replace(/\/+$/, '');
          const quoteReference = String(itineraryPlan.itinerary_quote_ID || planId);
          for (const request of newlyCreatedHolds) {
            await this.hotelBlockEmail.dispatchAgentHoldCreated({
              recipients,
              quotationReference: quoteReference,
              itineraryUrl: `${baseUrl}/itinerary-details/${encodeURIComponent(quoteReference)}`,
              request,
            });
          }
        }
      } catch (error) {
        this.hotelBlockEmail.logFailure(error, 'itinerary agent');
      }
    }

    return {
      // The request itself completed; individual provider outcomes carry the
      // per-stay result so clients can report partial success accurately.
      success: true,
      allSucceeded: outcomes.every((outcome) => outcome.success),
      partialSuccess: outcomes.some((outcome) => outcome.success) && outcomes.some((outcome) => !outcome.success),
      itineraryPlanId: planId,
      groupType,
      requests: results,
      outcomes,
      succeededCount: outcomes.filter((outcome) => outcome.success).length,
      failedCount: outcomes.filter((outcome) => !outcome.success).length,
      requestsCreated: results.filter((result) => result.created).length,
      emailsQueued: results.filter((result) => result.emailQueued).length,
      contactRequired: results.filter((result) => result.status === HOTEL_BLOCK_STATUS.CONTACT_REQUIRED).length,
      walletDebited: 0,
      supplierBookingCalls: results.filter((result) => result.supplierBookingReference).length,
    };
  }

  async listForItinerary(planId: number, groupType?: number) {
    const policy = await this.getHotelHoldPolicy();
    const rows = await (this.prisma as any).dvi_hotel_block_request.findMany({
      where: {
        itinerary_plan_id: Number(planId),
        ...(Number(groupType || 0) > 0 ? { group_type: Number(groupType) } : {}),
      },
      orderBy: [{ check_in: 'asc' }, { id: 'asc' }],
    });
    const latestMessages = await this.latestMessagesByRequest(rows.map((row: BlockRow) => Number(row.id)));
    const releaseConfirmedByHotelierIds = await this.offlineReleaseConfirmedByHotelierIds(rows as BlockRow[]);
    const refreshed = await Promise.all(rows.map((row: BlockRow) => this.refreshSupplierHold(row)));
    return refreshed.map(({ row, statusOverride, cutoffAt }) => {
      const view = this.publicStaffView(
        cutoffAt ? { ...row, cutoff_at: cutoffAt } : row,
        policy,
        latestMessages.get(Number(row.id)),
        statusOverride,
      );
      return {
        ...view,
        releaseConfirmedByHotelier: releaseConfirmedByHotelierIds.has(Number(row.id))
          || view.releaseStatus === 'ACKNOWLEDGED',
      };
    });
  }

  async getById(requestId: number) {
    const policy = await this.getHotelHoldPolicy();
    const row = await (this.prisma as any).dvi_hotel_block_request.findUnique({
      where: { id: Number(requestId) },
    });
    if (!row) throw new NotFoundException('Hotel hold request not found.');
    const latestMessages = await this.latestMessagesByRequest([Number(row.id)]);
    const releaseConfirmedByHotelierIds = await this.offlineReleaseConfirmedByHotelierIds([row]);
    const refreshed = await this.refreshSupplierHold(row);
    const view = this.publicStaffView(
      refreshed.cutoffAt ? { ...row, cutoff_at: refreshed.cutoffAt } : row,
      policy,
      latestMessages.get(Number(row.id)),
      refreshed.statusOverride,
    );
    return {
      ...view,
      releaseConfirmedByHotelier: releaseConfirmedByHotelierIds.has(Number(row.id))
        || view.releaseStatus === 'ACKNOWLEDGED',
    };
  }

  private async offlineReleaseConfirmedByHotelierIds(rows: BlockRow[]): Promise<Set<number>> {
    const requestIds = rows
      .filter((row) => row.status === HOTEL_BLOCK_STATUS.CANCELLED
        && normalizeText(row.confirmation_channel).toUpperCase() === 'OFFLINE_HOLD'
        && Number(row.id) > 0)
      .map((row) => Number(row.id));
    const eventModel = (this.prisma as any).dvi_hotel_block_event;
    if (!requestIds.length || typeof eventModel?.findMany !== 'function') return new Set<number>();

    const events = await eventModel.findMany({
      where: { request_id: { in: requestIds }, event_type: 'CANCELLED' },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });
    return new Set<number>((events as BlockRow[])
      .filter((event) => {
        const metadata = parseJson(event.metadata, {}) as BlockRow;
        const contact = metadata?.hotelierContact as BlockRow | undefined;
        return Boolean(normalizeText(contact?.name) && normalizeText(contact?.phone));
      })
      .map((event) => Number(event.request_id))
      .filter((id) => requestIds.includes(id)));
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
    const policy = await this.getHotelHoldPolicy();
    return this.publicSupplierView(request, policy);
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

  async cancel(requestId: number, actor: Actor, input: { hotelierContact?: { name?: unknown; phone?: unknown } } = {}) {
    const request = await (this.prisma as any).dvi_hotel_block_request.findUnique({
      where: { id: Number(requestId) },
    });
    if (!request) throw new NotFoundException('Hotel hold request not found.');
    const skipVsrSupplierRelease = normalizeText(request.provider).toUpperCase() === 'VSR'
      && normalizeText(request.confirmation_channel).toUpperCase() === 'TBO_BOOK_HOLD';
    const isAxisRoomsHold = normalizeText(request.confirmation_channel).toUpperCase() === 'AXISROOMS_HOLD';
    if (isAxisRoomsHold) {
      const result = await this.cancelAxisRoomsHoldRequest(request);
      if (!result.success) {
        throw new BadRequestException(`AxisRooms could not confirm cancellation; the hold remains active. ${result.error || ''}`.trim());
      }
    }
    const hotelierContact = input.hotelierContact
      ? {
        name: normalizeText(input.hotelierContact.name),
        phone: normalizeText(input.hotelierContact.phone),
      }
      : null;
    const offlineReleaseConfirmedByPhone = normalizeText(request.confirmation_channel).toUpperCase() === 'OFFLINE_HOLD'
      && Boolean(hotelierContact?.name && hotelierContact?.phone);
    return this.transition(requestId, HOTEL_BLOCK_STATUS.CANCELLED, {
      actor: { ...actor, type: actor.type || 'STAFF' },
      eventType: 'CANCELLED',
      notes: offlineReleaseConfirmedByPhone
        ? 'Hotelier confirmed the offline hold release by phone; no further release follow-up is required.'
        : skipVsrSupplierRelease
        ? 'VSR hotel hold removed from the itinerary; no supplier cancellation API was requested.'
        : isAxisRoomsHold
          ? 'AxisRooms confirmed cancellation of the hotel hold through its API.'
        : 'Hotel hold request cancelled by staff.',
      skipSupplierRelease: skipVsrSupplierRelease || isAxisRoomsHold || offlineReleaseConfirmedByPhone,
      hotelierContact,
    });
  }

  private async cancelAxisRoomsHoldRequest(request: BlockRow): Promise<{ success: boolean; error?: string }> {
    const savedPayload = parseJson(request.request_payload, {}) as BlockRow;
    const axisRequest = savedPayload.providerHold?.request || {};
    const firstRoomStay = Array.isArray(axisRequest.roomStays) ? axisRequest.roomStays[0] || {} : {};
    if (!this.axisRoomsBookingPushService) {
      return { success: false, error: 'AxisRooms cancellation service is not configured.' };
    }
    return this.axisRoomsBookingPushService.cancelHeldBooking({
      confirmationNo: normalizeText(request.confirmation_reference),
      bookingCode: normalizeText(firstRoomStay.rateId || request.hotel_code),
      hotelCode: normalizeText(axisRequest.hotelId || request.hotel_code),
    });
  }

  async recordReleaseAcknowledgement(requestId: number, actor: Actor) {
    const request = await (this.prisma as any).dvi_hotel_block_request.findUnique({ where: { id: Number(requestId) } });
    if (!request) throw new NotFoundException('Hotel hold request not found.');
    if (![HOTEL_BLOCK_STATUS.EXPIRED, HOTEL_BLOCK_STATUS.CANCELLED].includes(request.status)) {
      throw new BadRequestException('Only an expired or cancelled hold can be marked as released.');
    }
    if (normalizeText(request.confirmation_channel).toUpperCase() !== 'OFFLINE_HOLD') {
      throw new BadRequestException('Manual release acknowledgement is only available for offline hotel holds.');
    }
    if (request.release_status === 'ACKNOWLEDGED') return { success: true, request: this.publicStaffView(request), alreadyAcknowledged: true };
    const now = new Date();
    const updated = await (this.prisma as any).$transaction(async (tx: any) => {
      const changed = await tx.dvi_hotel_block_request.updateMany({
        where: { id: request.id, status: request.status, release_status: { not: 'ACKNOWLEDGED' } },
        data: { release_status: 'ACKNOWLEDGED', release_acknowledged_at: now, release_last_error: null },
      });
      if (Number(changed?.count || 0) !== 1) {
        return tx.dvi_hotel_block_request.findUnique({ where: { id: request.id } });
      }
      const row = await tx.dvi_hotel_block_request.findUnique({ where: { id: request.id } });
      await tx.dvi_hotel_block_event.create({
        data: {
          request_id: request.id,
          previous_status: request.status,
          new_status: request.status,
          event_type: 'HOTEL_RELEASE_ACKNOWLEDGED_MANUALLY',
          actor_type: actor.type || 'STAFF',
          actor_id: Number(actor.id || 0) || null,
          actor_name: actor.name || null,
          communication_channel: 'MANUAL',
          notes: 'Authorized DVi user recorded that the hotel released the held rooms.',
        },
      });
      return row;
    });
    return { success: true, request: this.publicStaffView(updated) };
  }

  /**
   * A hotel selection replaces the itinerary row but does not go through the
   * hold endpoints. Reconcile active requests after the selection is saved so
   * the previous hotelier is told that their hold is no longer required.
   */
  async cancelHoldsAfterHotelChange(input: {
    itineraryPlanId: number;
    groupType: number;
    routeIds: number[];
    actor?: Actor;
  }) {
    const planId = Number(input.itineraryPlanId);
    const groupType = Number(input.groupType || 0);
    const routeIds = Array.from(new Set((input.routeIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0)));
    if (!Number.isInteger(planId) || planId <= 0 || !routeIds.length) {
      return { cancelled: 0, emailsQueued: 0, requests: [] };
    }

    const requests = await (this.prisma as any).dvi_hotel_block_request.findMany({
      where: {
        itinerary_plan_id: planId,
        ...(groupType > 0 ? { group_type: groupType } : {}),
        status: { in: ACTIVE_REQUEST_STATUSES },
      },
    });
    const selectionIds = Array.from(new Set((requests as BlockRow[])
      .flatMap((request) => parseJson(request.selection_ids, []) as unknown[])
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0)));
    const [currentRows, previousRows] = await Promise.all([
      (this.prisma as any).dvi_itinerary_plan_hotel_details.findMany({
        where: {
          itinerary_plan_id: planId,
          ...(groupType > 0 ? { group_type: groupType } : {}),
          itinerary_route_id: { in: routeIds },
          hotel_required: 1,
          status: 1,
          deleted: 0,
        },
      }),
      selectionIds.length
        ? (this.prisma as any).dvi_itinerary_plan_hotel_details.findMany({
            where: {
              itinerary_plan_id: planId,
              ...(groupType > 0 ? { group_type: groupType } : {}),
              itinerary_plan_hotel_details_ID: { in: selectionIds },
            },
          })
        : [],
    ]);

    const currentByRoute = new Map<number, BlockRow>();
    for (const row of currentRows as BlockRow[]) {
      const routeId = Number(row.itinerary_route_id || 0);
      if (routeId > 0) currentByRoute.set(routeId, row);
    }
    const previousById = new Map<number, BlockRow>(
      (previousRows as BlockRow[]).map((row) => [Number(row.itinerary_plan_hotel_details_ID || 0), row]),
    );
    const cancelled: any[] = [];
    for (const request of requests as BlockRow[]) {
      const requestSelectionIds = (parseJson(request.selection_ids, []) as unknown[])
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0);
      const affectedSelections = requestSelectionIds
        .map((id) => previousById.get(id))
        .filter((row): row is BlockRow => Boolean(row))
        .filter((row) => routeIds.includes(Number(row.itinerary_route_id || 0)))
        .map((previousRow) => ({
          previousRow,
          currentRow: currentByRoute.get(Number(previousRow.itinerary_route_id || 0)),
        }));
      if (!affectedSelections.length || affectedSelections.every(({ currentRow }) => currentRow && isSameHotel(request, currentRow))) continue;
      cancelled.push(await this.cancelAfterHotelChange(request, input.actor || { type: 'STAFF' }));
    }

    return {
      cancelled: cancelled.length,
      emailsQueued: cancelled.filter((item) => item.emailQueued).length,
      requests: cancelled,
    };
  }

  private async cancelAfterHotelChange(request: BlockRow, actor: Actor) {
    const supplierHold = isTboSupplierHoldRequest(request);
    const confirmationChannel = normalizeText(request.confirmation_channel).toUpperCase();
    const axisRoomsHold = confirmationChannel === 'AXISROOMS_HOLD';
    let axisRoomsCancellation: { success: boolean; error?: string } | null = null;

    if (axisRoomsHold) {
      axisRoomsCancellation = await this.cancelAxisRoomsHoldRequest(request);
    }

    // TBO/VSR releases the old supplier hold when the selected itinerary
    // hotel changes. Retire our local row, but never send the manual hotelier
    // cancellation email for this provider.
    const recipient = supplierHold || axisRoomsHold ? null : firstEmail(request.contact_email);
    const updated = await (this.prisma as any).$transaction(async (tx: any) => {
      const result = await tx.dvi_hotel_block_request.update({
        where: { id: request.id },
        data: {
          status: HOTEL_BLOCK_STATUS.CANCELLED,
          cutoff_at: null,
          ...(axisRoomsHold ? {
            release_status: axisRoomsCancellation?.success ? 'ACKNOWLEDGED' : 'FAILED',
            release_last_error: axisRoomsCancellation?.success ? null : axisRoomsCancellation?.error || 'AxisRooms cancellation failed.',
            release_email_status: 'SKIPPED',
            release_email_last_error: null,
          } : supplierHold ? {
            release_status: 'ACKNOWLEDGED',
            release_acknowledged_at: new Date(),
            release_last_error: null,
            release_email_status: 'SKIPPED',
            release_email_last_error: null,
          } : {}),
        },
      });
      await tx.dvi_hotel_block_event.create({
        data: {
          request_id: request.id,
          previous_status: request.status,
          new_status: HOTEL_BLOCK_STATUS.CANCELLED,
          event_type: 'HOTEL_CHANGE_HOLD_CANCELLED',
          actor_type: actor.type || 'STAFF',
          actor_id: Number(actor.id || 0) || null,
          actor_name: actor.name || null,
          notes: supplierHold
            ? 'Previous VSR supplier hold retired because the itinerary hotel changed; TBO auto-cancels it.'
            : axisRoomsHold
              ? axisRoomsCancellation?.success
                ? 'Previous AxisRooms hold cancelled through the supplier API because the itinerary hotel changed.'
                : `Previous AxisRooms hold cancellation API failed after the itinerary hotel changed: ${axisRoomsCancellation?.error || 'unknown error'}`
            : 'Previous hotel hold cancelled because the itinerary hotel was changed.',
          metadata: axisRoomsHold ? JSON.stringify({
            cancellationRequested: true,
            cancellationSucceeded: Boolean(axisRoomsCancellation?.success),
            error: axisRoomsCancellation?.error || null,
          }) : undefined,
        },
      });
      const message = recipient
        ? await tx.dvi_hotel_block_message.create({
            data: {
              request_id: request.id,
              recipient: this.hotelBlockEmail.deliveryRecipient(recipient),
              delivery_status: 'QUEUED',
              attempt_count: 0,
            },
          })
        : null;
      return { result, message };
    });

    if (!recipient || !updated.message) {
      return {
        id: request.id,
        status: HOTEL_BLOCK_STATUS.CANCELLED,
        emailQueued: false,
        emailDeliveryStatus: 'SKIPPED',
        ...(axisRoomsHold ? { supplierCancellationSucceeded: Boolean(axisRoomsCancellation?.success), supplierCancellationError: axisRoomsCancellation?.error } : {}),
      };
    }

    let deliveryStatus: 'QUEUED' | 'SENT' | 'FAILED' = 'QUEUED';
    let providerMessageId: string | null = null;
    try {
      const delivery = await this.hotelBlockEmail.dispatch({
        recipient,
        quotationReference: String(request.itinerary_plan_id),
        request: {
          ...this.publicStaffView(updated.result),
          responseUrl: '',
          emailKind: 'CANCELLATION',
        },
      });
      deliveryStatus = delivery.status;
      providerMessageId = delivery.providerMessageId || null;
      if (delivery.status === 'SENT') {
        await (this.prisma as any).dvi_hotel_block_message.update({
          where: { id: updated.message.id },
          data: { delivery_status: 'SENT', attempt_count: { increment: 1 }, provider_message_id: providerMessageId, sent_at: new Date() },
        });
      }
    } catch (error) {
      deliveryStatus = 'FAILED';
      const lastError = this.hotelBlockEmail.logFailure(error, recipient);
      await (this.prisma as any).dvi_hotel_block_message.update({
        where: { id: updated.message.id },
        data: { delivery_status: 'FAILED', attempt_count: { increment: 1 }, last_error: lastError },
      });
    }
    return {
      id: request.id,
      status: HOTEL_BLOCK_STATUS.CANCELLED,
      emailQueued: true,
      emailDeliveryStatus: deliveryStatus,
      providerMessageId,
      ...(axisRoomsHold ? { supplierCancellationSucceeded: Boolean(axisRoomsCancellation?.success), supplierCancellationError: axisRoomsCancellation?.error } : {}),
    };
  }

  async resendEmail(requestId: number, actor: Actor) {
    const request = await (this.prisma as any).dvi_hotel_block_request.findUnique({
      where: { id: Number(requestId) },
    });
    if (!request) throw new NotFoundException('Hotel hold request not found.');
    if ([HOTEL_BLOCK_STATUS.CANCELLED, HOTEL_BLOCK_STATUS.SUPERSEDED, HOTEL_BLOCK_STATUS.UNAVAILABLE].includes(request.status)) {
      throw new BadRequestException('This hotel hold request is no longer active.');
    }
    if (![HOTEL_BLOCK_STATUS.REQUESTED, HOTEL_BLOCK_STATUS.CONFIRMATION_AWAITED].includes(request.status) || request.responded_at) {
      throw new BadRequestException('Resend is available only while the hotelier is still awaiting response.');
    }
    const latestMessage = (await this.latestMessagesByRequest([Number(request.id)])).get(Number(request.id));
    const lastEmailAt = dateOnly(latestMessage?.sent_at || latestMessage?.created_at || request.requested_at);
    const resendAvailableAt = lastEmailAt ? new Date(lastEmailAt.getTime() + HOTEL_BLOCK_RESEND_WAIT_MS) : null;
    if (resendAvailableAt && resendAvailableAt.getTime() > Date.now()) {
      throw new BadRequestException({
        code: 'HOTEL_RESEND_NOT_READY',
        message: `Resend is available after ${resendAvailableAt.toISOString()}.`,
        resendAvailableAt: resendAvailableAt.toISOString(),
      });
    }
    const recipient = firstEmail(request.contact_email);
    if (!recipient) throw new BadRequestException('A verified hotel reservation email is required before resending.');
    const policy = await this.getHotelHoldPolicy();
    let requestForEmail = request;
    const shouldMarkAwaiting = !request.responded_at && request.status === HOTEL_BLOCK_STATUS.REQUESTED;
    const shouldSeedDefaultCutoff = [
      HOTEL_BLOCK_STATUS.REQUESTED,
      HOTEL_BLOCK_STATUS.CONFIRMATION_AWAITED,
      HOTEL_BLOCK_STATUS.BLOCKED,
    ].includes(request.status)
      && !request.cutoff_at;
    if (shouldMarkAwaiting || shouldSeedDefaultCutoff) {
      const defaultCutoff = request.cutoff_at || this.getDefaultHotelHoldCutoff(request.check_in, request.requested_at, policy);
      requestForEmail = await (this.prisma as any).$transaction(async (tx: any) => {
        const nextStatus = shouldMarkAwaiting
          ? HOTEL_BLOCK_STATUS.CONFIRMATION_AWAITED
          : request.status;
        const updated = await tx.dvi_hotel_block_request.update({
          where: { id: request.id },
          data: {
            status: nextStatus,
            cutoff_at: defaultCutoff,
          },
        });
        await tx.dvi_hotel_block_event.create({
          data: {
            request_id: request.id,
            previous_status: request.status,
            new_status: nextStatus,
            event_type: shouldMarkAwaiting ? 'REQUEST_MARKED_CONFIRMATION_AWAITED' : 'HOLD_CUTOFF_DEFAULTED',
            actor_type: actor.type || 'STAFF',
            actor_id: Number(actor.id || 0) || null,
            actor_name: actor.name || null,
            notes: shouldMarkAwaiting
              ? 'Unanswered hotel block request moved to awaiting confirmation before email resend.'
              : 'Lead-time hotel hold cutoff applied before email resend.',
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
      policy,
    });
  }

  async updateCutoff(requestId: number, cutoffAt: string, actor: Actor) {
    const request = await (this.prisma as any).dvi_hotel_block_request.findUnique({ where: { id: Number(requestId) } });
    if (!request) throw new NotFoundException('Hotel hold request not found.');
    if (![HOTEL_BLOCK_STATUS.BLOCKED, HOTEL_BLOCK_STATUS.CONFIRMED].includes(request.status)) {
      throw new BadRequestException('Only an existing held hotel can be extended.');
    }
    if (request.paid_confirmed_at) {
      throw new BadRequestException('A paid hotel hold cannot be extended.');
    }
    const cutoff = new Date(String(cutoffAt || ''));
    if (Number.isNaN(cutoff.getTime())) throw new BadRequestException('A valid cutoff date and time is required.');
    const previousCutoff = dateOnly(request.cutoff_at);
    if (!previousCutoff) throw new BadRequestException('This hotel hold does not have an existing hold-until time.');
    if (cutoff.getTime() <= previousCutoff.getTime()) {
      throw new BadRequestException('The new hold-until time must be later than the current hold-until time.');
    }
    const policy = await this.getHotelHoldPolicy();
    const maximumCutoff = this.maxHotelHoldCutoff(request, new Date(), policy);
    if (cutoff.getTime() > maximumCutoff.getTime()) {
      throw new BadRequestException(`The hold cutoff cannot be later than ${maximumCutoff.toISOString()}.`);
    }
    const updated = await (this.prisma as any).$transaction(async (tx: any) => {
      const claim = await tx.dvi_hotel_block_request.updateMany({
        where: {
          id: request.id,
          status: { in: [HOTEL_BLOCK_STATUS.BLOCKED, HOTEL_BLOCK_STATUS.CONFIRMED] },
          paid_confirmed_at: null,
          cutoff_at: request.cutoff_at,
        },
        data: { cutoff_at: cutoff, version: { increment: 1 } },
      });
      if (Number(claim?.count || 0) !== 1) {
        throw new BadRequestException('This hotel hold changed or expired before it could be extended. Refresh and try again.');
      }
      const result = await tx.dvi_hotel_block_request.findUnique({ where: { id: request.id } });
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
    if (!recipient) return { success: true, request: this.publicStaffView(updated, policy), emailDeliveryStatus: 'SKIPPED' };
    return this.queueAndSendEmail({
      request: updated,
      recipient,
      actor,
      eventType: 'HOLD_EXTENSION_EMAIL_QUEUED',
      notes: 'Hotel hold extension email queued by staff.',
      policy,
      emailKind: ['AXISROOMS_HOLD', 'OFFLINE_HOLD'].includes(String(updated.confirmation_channel || ''))
        ? 'HOLD_EXTENSION_NOTICE'
        : 'EXTENSION',
      previousCutoffAt: previousCutoff,
      requiresResponseLink: !['AXISROOMS_HOLD', 'OFFLINE_HOLD'].includes(String(updated.confirmation_channel || '')),
    });
  }

  private async queueAndSendEmail(input: {
    request: BlockRow;
    recipient: string;
    actor: Actor;
    eventType: string;
    notes: string;
    policy?: HotelHoldPolicy;
    emailKind?: 'REQUEST' | 'EXTENSION' | 'HOLD_EXTENSION_NOTICE';
    previousCutoffAt?: Date | string | null;
    requiresResponseLink?: boolean;
  }) {
    const { request, recipient, actor, eventType, notes, policy = DEFAULT_HOTEL_HOLD_POLICY, emailKind = 'REQUEST', previousCutoffAt = null, requiresResponseLink = true } = input;
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const now = new Date();
    await (this.prisma as any).$transaction(async (tx: any) => {
      if (requiresResponseLink) {
        await tx.dvi_hotel_block_token.create({
          data: {
            request_id: request.id,
            token_hash: tokenHash,
            expires_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
          },
        });
      }
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

    const responseUrl = requiresResponseLink
      ? `${publicItineraryBaseUrl()}/hotel/block-response/${rawToken}`
      : '';
    let deliveryStatus: 'QUEUED' | 'SENT' | 'FAILED' = 'QUEUED';
    let providerMessageId: string | null = null;
    try {
      const delivery = await this.hotelBlockEmail.dispatch({
        recipient,
        quotationReference: String(request.itinerary_plan_id),
        request: {
          ...this.publicStaffView(request, policy),
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
    return { success: true, request: this.publicStaffView(request, policy), recipient, deliveryStatus, emailDeliveryStatus: deliveryStatus, providerMessageId };
  }

  async assertPlanReady(planId: number, groupType?: number) {
    const plan = await (this.prisma as any).dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: Number(planId) },
      select: { itinerary_preference: true },
    });
    const isVehicleOnlyPlan = Number(plan?.itinerary_preference || 0) === 2;
    if (isVehicleOnlyPlan) {
      return { ready: true, requestCount: 0 };
    }

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
      select: {
        id: true,
        hotel_name: true,
        provider: true,
        status: true,
        selection_ids: true,
        confirmation_channel: true,
        confirmation_reference: true,
        cutoff_at: true,
        paid_confirmed_at: true,
        request_payload: true,
      },
    });
    const now = new Date();
    const readiness = await Promise.all(requests.map(async (request: BlockRow) => {
      if (request.paid_confirmed_at) return true;
      const hasFutureCutoff = isFutureDate(request.cutoff_at, now);
      const provider = normalizeText(request.provider).toUpperCase();
      if (provider === 'OFFLINE' && request.confirmation_channel === 'OFFLINE_HOLD') {
        return ['BLOCKED', 'CONFIRMED'].includes(request.status) && hasFutureCutoff;
      }
      if (provider === 'AXISROOMS' && request.confirmation_channel === 'AXISROOMS_HOLD') {
        return ['BLOCKED', 'CONFIRMED'].includes(request.status)
          && hasFutureCutoff
          && Boolean(normalizeText(request.confirmation_reference));
      }
      if (provider === 'VSR' && request.confirmation_channel === 'TBO_BOOK_HOLD') {
        const supplierHold = parseJson(request.request_payload, {})?.supplierHold || {};
        return ['BLOCKED', 'CONFIRMED'].includes(request.status)
          && hasFutureCutoff
          && Boolean(supplierHold.bookingId)
          && Boolean(supplierHold.bookingReference || request.confirmation_reference)
          && Boolean(supplierHold.bookingCode);
      }
      return request.status === HOTEL_BLOCK_STATUS.CONFIRMED && hasFutureCutoff;
    }));
    const pending = requests.filter((_request: BlockRow, index: number) => !readiness[index]);
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

  /** Require a Travel Expert's explicit offline payment acknowledgement before wallet debit. */
  async assertOfflinePaymentAcknowledgements(
    planId: number,
    groupType: number,
    confirmations: Array<{ requestId: number; confirmed: boolean; hotelierName?: string; hotelierPhone?: string }> = [],
    actor: Actor = {},
  ) {
    const offlineHolds = await (this.prisma as any).dvi_hotel_block_request.findMany({
      where: {
        itinerary_plan_id: Number(planId),
        ...(Number(groupType || 0) > 0 ? { group_type: Number(groupType) } : {}),
        confirmation_channel: 'OFFLINE_HOLD',
        status: { in: [HOTEL_BLOCK_STATUS.BLOCKED, HOTEL_BLOCK_STATUS.CONFIRMED] },
        paid_confirmed_at: null,
        cutoff_at: { gt: new Date() },
      },
      select: { id: true, hotel_name: true },
    });
    if (!offlineHolds.length) return { required: 0 };

    const isTravelExpert = Number(actor.roleId || 0) === 8
      || (Number(actor.roleId || 0) === 3
        && Number(actor.permissionRoleId || 0) === 3
        && Number(actor.staffId || 0) > 0);
    if (!isTravelExpert) throw new ForbiddenException('Only a Travel Expert can confirm offline hotel payment.');

    const confirmationById = new Map(confirmations
      .filter((item) => item?.confirmed === true)
      .map((item) => [Number(item.requestId), item]));
    const missing = offlineHolds.filter((hold: BlockRow) => {
      const item = confirmationById.get(Number(hold.id));
      return !item || !normalizeText(item.hotelierName) || !normalizeText(item.hotelierPhone);
    });
    if (missing.length) {
      throw new BadRequestException({
        code: 'OFFLINE_HOTEL_PAYMENT_ACKNOWLEDGEMENT_REQUIRED',
        message: 'Confirm that the Travel Expert contacted the hotelier and paid each offline hotel before Confirm & Pay.',
        hotels: missing.map((hold: BlockRow) => hold.hotel_name),
      });
    }
    return { required: offlineHolds.length };
  }

  /** Finalize paid provider holds locally, then generate VSR vouchers independently. */
  async finalizePaidProviderHolds(
    planId: number,
    groupType: number,
    confirmedPlanId: number,
    offlinePaymentConfirmations: Array<{ requestId: number; confirmed: boolean; hotelierName?: string; hotelierPhone?: string }> = [],
    actor: Actor = {},
  ) {
    const now = new Date();
    const finalized = await (this.prisma as any).$transaction(async (tx: any) => {
      const requests = await tx.dvi_hotel_block_request.findMany({
        where: {
          itinerary_plan_id: Number(planId),
          ...(Number(groupType || 0) > 0 ? { group_type: Number(groupType) } : {}),
          confirmation_channel: { in: ['AXISROOMS_HOLD', 'OFFLINE_HOLD', 'TBO_BOOK_HOLD'] },
          status: { in: [HOTEL_BLOCK_STATUS.BLOCKED, HOTEL_BLOCK_STATUS.CONFIRMED] },
        },
        orderBy: { id: 'asc' },
      });
      const selectionIds = Array.from(new Set(requests.flatMap((request: BlockRow) =>
        (parseJson(request.selection_ids, []) as unknown[]).map(Number).filter((id) => Number.isInteger(id) && id > 0),
      )));
      const selectedRows = selectionIds.length
        ? await tx.dvi_itinerary_plan_hotel_details.findMany({
            where: { itinerary_plan_hotel_details_ID: { in: selectionIds }, itinerary_plan_id: Number(planId) },
            select: { itinerary_plan_hotel_details_ID: true, itinerary_route_id: true },
          })
        : [];
      const routeBySelectionId = new Map(selectedRows.map((row: BlockRow) => [
        Number(row.itinerary_plan_hotel_details_ID), Number(row.itinerary_route_id || 0),
      ]));
      const paymentConfirmationIds = new Set(offlinePaymentConfirmations
        .filter((item) => item?.confirmed === true)
        .map((item) => Number(item.requestId)));
      const paymentConfirmationById = new Map(offlinePaymentConfirmations
        .filter((item) => item?.confirmed === true)
        .map((item) => [Number(item.requestId), item]));

      for (const request of requests as BlockRow[]) {
        if (request.confirmation_channel === 'AXISROOMS_HOLD') {
          const payload = parseJson(request.request_payload, {}) as BlockRow;
          const hold = payload.providerHold || {};
          const axisRequest = hold.request || {};
          const response = hold.response || null;
          const routes = (parseJson(request.selection_ids, []) as unknown[])
            .map(Number)
            .map((id) => Number(routeBySelectionId.get(id) || 0))
            .filter((id) => Number.isInteger(id) && id > 0);
          const roomStay = Array.isArray(axisRequest.roomStays) ? axisRequest.roomStays[0] || {} : {};
          const guestDetails = roomStay.guestDetails || {};
          for (const routeId of Array.from(new Set(routes))) {
            const where = {
              itinerary_plan_ID: Number(planId),
              itinerary_route_ID: routeId,
              axisrooms_booking_reference: String(axisRequest.confirmationNo || request.confirmation_reference || ''),
              status: 1,
              deleted: 0,
            };
            const existing = await tx.axisrooms_hotel_booking_confirmation.findFirst({ where });
            if (existing) continue;
            await tx.axisrooms_hotel_booking_confirmation.create({
              data: {
                confirmed_itinerary_plan_ID: Number(confirmedPlanId || 0),
                itinerary_plan_ID: Number(planId),
                itinerary_route_ID: routeId,
                axisrooms_hotel_code: String(request.hotel_code || axisRequest.hotelId || ''),
                axisrooms_booking_reference: String(axisRequest.confirmationNo || request.confirmation_reference || ''),
                booking_code: String(roomStay.rateId || request.hotel_code || ''),
                check_in_date: axisRequest.checkInDate ? new Date(axisRequest.checkInDate) : request.check_in,
                check_out_date: axisRequest.checkOutDate ? new Date(axisRequest.checkOutDate) : request.check_out,
                number_of_rooms: Number(roomStay.noOfUnits || request.room_count || 1),
                net_amount: Number(axisRequest.totalAmount || request.total_amount || 0),
                guest_nationality: String(axisRequest.guestNationality || ''),
                total_guests: Number(guestDetails.adults || 0) + Number(guestDetails.children || 0),
                api_response: {
                  hold: { request: axisRequest, response, confirmationNo: axisRequest.confirmationNo || null },
                  paymentConfirmedAt: now.toISOString(),
                },
                createdby: Number(request.created_by || 0),
                createdon: now,
                status: 1,
                deleted: 0,
              },
            });
          }
        }

        const isTboHold = request.confirmation_channel === 'TBO_BOOK_HOLD';
        if (request.status !== HOTEL_BLOCK_STATUS.CONFIRMED || !request.paid_confirmed_at || (isTboHold && request.voucher_status !== 'VOUCHERED')) {
          await tx.dvi_hotel_block_request.update({
            where: { id: request.id },
            data: {
              status: HOTEL_BLOCK_STATUS.CONFIRMED,
              ...(request.confirmed_at ? {} : { confirmed_at: now }),
              paid_confirmed_at: request.paid_confirmed_at || now,
              ...(request.responded_at ? {} : { responded_at: now }),
              ...(isTboHold && request.voucher_status !== 'VOUCHERED' ? {
                voucher_status: 'PENDING',
                voucher_next_attempt_at: now,
              } : {}),
            },
          });
          if (request.status !== HOTEL_BLOCK_STATUS.CONFIRMED) {
            const offlinePaymentConfirmed = request.confirmation_channel === 'OFFLINE_HOLD'
              && paymentConfirmationIds.has(Number(request.id));
            await tx.dvi_hotel_block_event.create({
              data: {
                request_id: request.id,
                previous_status: request.status,
                new_status: HOTEL_BLOCK_STATUS.CONFIRMED,
                event_type: offlinePaymentConfirmed ? 'OFFLINE_HOTEL_PAYMENT_CONFIRMED' : 'PAYMENT_CONFIRMED',
                actor_type: offlinePaymentConfirmed ? actor.type || 'STAFF' : 'SYSTEM',
                actor_id: offlinePaymentConfirmed ? Number(actor.id || 0) || null : null,
                actor_name: offlinePaymentConfirmed ? actor.name || null : null,
                communication_channel: 'WALLET',
                notes: offlinePaymentConfirmed
                  ? 'Travel Expert confirmed direct payment to the offline hotelier; no supplier API was called.'
                  : 'Hotel hold confirmed after itinerary wallet payment succeeded.',
                metadata: JSON.stringify({
                  confirmedPlanId: Number(confirmedPlanId || 0),
                  channel: request.confirmation_channel,
                  ...(offlinePaymentConfirmed ? {
                    hotelierContact: parseJson(request.request_payload, {})?.providerHold?.hotelierContact || null,
                    paymentContact: paymentConfirmationById.get(Number(request.id)) || null,
                  } : {}),
                }),
              },
            });
          }
        }
      }
      return {
        finalized: requests.length,
        tboRequestIds: requests
          .filter((request: BlockRow) => request.confirmation_channel === 'TBO_BOOK_HOLD' && request.voucher_status !== 'VOUCHERED')
          .map((request: BlockRow) => Number(request.id)),
      };
    });
    const voucherResults: any[] = [];
    for (const requestId of finalized.tboRequestIds) {
      voucherResults.push(await this.generateVoucherForPaidTboHold(requestId, now));
    }
    return { finalized: finalized.finalized, voucherResults };
  }

  async retryDueTboVouchers(now = new Date()) {
    const staleProcessingBefore = new Date(now.getTime() - 10 * 60_000);
    const stale = await (this.prisma as any).dvi_hotel_block_request.updateMany({
      where: {
        confirmation_channel: 'TBO_BOOK_HOLD',
        status: HOTEL_BLOCK_STATUS.CONFIRMED,
        paid_confirmed_at: { not: null },
        voucher_status: 'PROCESSING',
        updated_at: { lte: staleProcessingBefore },
      },
      data: { voucher_status: 'PENDING', voucher_next_attempt_at: now },
    });
    const requests = await (this.prisma as any).dvi_hotel_block_request.findMany({
      where: {
        confirmation_channel: 'TBO_BOOK_HOLD',
        status: HOTEL_BLOCK_STATUS.CONFIRMED,
        paid_confirmed_at: { not: null },
        voucher_status: 'PENDING',
        OR: [{ voucher_next_attempt_at: null }, { voucher_next_attempt_at: { lte: now } }],
      },
      orderBy: [{ voucher_next_attempt_at: 'asc' }, { id: 'asc' }],
      take: 100,
    });
    let processed = 0;
    for (const request of requests) {
      const supplierHold = parseJson(request.request_payload, {})?.supplierHold || {};
      const lcd = new Date(supplierHold.lcdDeadlineAt || '');
      if (Number.isFinite(lcd.getTime()) && lcd.getTime() <= now.getTime()) {
        await (this.prisma as any).dvi_hotel_block_request.updateMany({
          where: { id: request.id, voucher_status: 'PENDING' },
          data: {
            voucher_status: 'LCD_PASSED',
            voucher_next_attempt_at: null,
            voucher_last_error: 'TBO last cancellation deadline passed before voucher generation.',
          },
        });
        continue;
      }
      await this.generateVoucherForPaidTboHold(Number(request.id), now);
      processed += 1;
    }
    return { processed, recoveredClaims: Number(stale?.count || 0) };
  }

  private async generateVoucherForPaidTboHold(requestId: number, now = new Date()) {
    const claim = await (this.prisma as any).dvi_hotel_block_request.updateMany({
      where: {
        id: Number(requestId),
        confirmation_channel: 'TBO_BOOK_HOLD',
        status: HOTEL_BLOCK_STATUS.CONFIRMED,
        paid_confirmed_at: { not: null },
        voucher_status: 'PENDING',
        OR: [{ voucher_next_attempt_at: null }, { voucher_next_attempt_at: { lte: now } }],
      },
      data: {
        voucher_status: 'PROCESSING',
        voucher_attempt_count: { increment: 1 },
        voucher_last_error: null,
        updated_at: now,
      },
    });
    if (Number(claim?.count || 0) !== 1) return { requestId, status: 'UNCHANGED' };

    const request = await (this.prisma as any).dvi_hotel_block_request.findUnique({ where: { id: Number(requestId) } });
    const supplierHold = parseJson(request?.request_payload, {})?.supplierHold || {};
    const bookingId = Number(supplierHold.bookingId || 0);
    try {
      if (!bookingId) throw new Error('TBO BookingId is missing for the held VSR booking.');
      const supplierState = await this.tboHotelBooking.getHoldStatus(
        String(request.confirmation_reference || supplierHold.bookingReference || ''),
        bookingId,
      );
      const alreadyVouchered = supplierState?.voucherStatus === true;
      const result: any = alreadyVouchered
        ? { voucherStatus: true, bookingStatus: supplierState.status, bookingId, alreadyVouchered: true }
        : await this.tboHotelBooking.generateVoucher(bookingId);
      await (this.prisma as any).$transaction(async (tx: any) => {
        const payload = parseJson(request.request_payload, {}) as BlockRow;
        payload.supplierHold = { ...(payload.supplierHold || {}), voucherGeneration: result };
        await tx.dvi_hotel_block_request.update({
          where: { id: request.id },
          data: {
            voucher_status: 'VOUCHERED',
            voucher_generated_at: now,
            voucher_next_attempt_at: null,
            voucher_last_error: null,
            request_payload: JSON.stringify(payload),
          },
        });
        await tx.dvi_hotel_block_event.create({
          data: {
            request_id: request.id,
            previous_status: HOTEL_BLOCK_STATUS.CONFIRMED,
            new_status: HOTEL_BLOCK_STATUS.CONFIRMED,
            event_type: result.alreadyVouchered ? 'TBO_VOUCHER_ALREADY_GENERATED' : 'TBO_VOUCHER_GENERATED',
            actor_type: 'SYSTEM',
            communication_channel: 'API',
            notes: `VSR voucher generated; supplier booking status: ${result.bookingStatus || 'Pending'}.`,
            metadata: JSON.stringify({ bookingId, bookingStatus: result.bookingStatus || null }),
          },
        });
      });
      return { requestId, status: 'VOUCHERED', bookingStatus: result.bookingStatus || null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempt = Number(request.voucher_attempt_count || 0) + 1;
      const retryMinutes = Math.min(60, 5 * (2 ** Math.min(attempt - 1, 4)));
      const nextAttempt = new Date(now.getTime() + retryMinutes * 60_000);
      await (this.prisma as any).$transaction(async (tx: any) => {
        await tx.dvi_hotel_block_request.update({
          where: { id: request.id },
          data: { voucher_status: 'PENDING', voucher_next_attempt_at: nextAttempt, voucher_last_error: message },
        });
        await tx.dvi_hotel_block_event.create({
          data: {
            request_id: request.id,
            previous_status: HOTEL_BLOCK_STATUS.CONFIRMED,
            new_status: HOTEL_BLOCK_STATUS.CONFIRMED,
            event_type: 'TBO_VOUCHER_PENDING',
            actor_type: 'SYSTEM',
            communication_channel: 'API',
            notes: 'VSR voucher generation is pending and will retry before the supplier cancellation deadline.',
            metadata: JSON.stringify({ bookingId, attempt, nextAttempt, error: message }),
          },
        });
      });
      return { requestId, status: 'PENDING', nextAttemptAt: nextAttempt.toISOString(), message };
    }
  }

  private async upsertRequest(input: {
    planId: number;
    groupType: number;
    rows: BlockRow[];
    hotel?: BlockRow;
    actor?: Actor;
    guest?: { name?: string; email?: string; phone?: string };
    policy?: HotelHoldPolicy;
    requestedAt?: Date;
    scopedSelection?: boolean;
    supplierHold?: {
      bookingReference?: string;
      bookingId?: string | number;
      bookResponse?: unknown;
      selection?: Record<string, any>;
      lcdDeadlineAt?: string;
    };
    providerHold?: ProviderHoldInput;
  }) {
    const first = input.rows[0];
    const room = first.__room || {};
    const snapshot = rowSnapshot(first);
    const hotel = input.hotel || {};
    const provider = this.normalizeProvider(first.hotel_provider, first.hotel_booking_mode);
    const hotelCode = normalizeText(first.hotel_code) || String(first.hotel_id || '');
    const stayDetails = input.rows.map((row) => {
      const rowRoom = row.__room || {};
      const rowData = rowSnapshot(row);
      const checkIn = rowCheckIn(row);
      const checkOut = rowCheckOut(row) || checkIn;
      return {
        checkIn,
        checkOut,
        roomType: normalizeText(rowData.roomType) || String(rowRoom.room_type_name || rowRoom.room_type_id || 'Room'),
        mealPlan: normalizeText(rowData.mealPlan) || this.resolveMealPlan(rowRoom),
        roomCount: Math.max(Number(row.total_no_of_rooms || rowRoom.room_qty || 0), 0),
      };
    });
    const checkIn = stayDetails.map((detail) => detail.checkIn).filter(Boolean) as Date[];
    const checkOut = stayDetails.map((detail) => detail.checkOut).filter(Boolean) as Date[];
    const start = checkIn.sort((a, b) => a.getTime() - b.getTime())[0] || null;
    const end = checkOut.sort((a, b) => b.getTime() - a.getTime())[0] || start;
    const uniqueRoomTypes = Array.from(new Set(stayDetails.map((detail) => detail.roomType).filter(Boolean)));
    const uniqueMealPlans = Array.from(new Set(stayDetails.map((detail) => detail.mealPlan).filter(Boolean)));
    const roomType = uniqueRoomTypes.length === 1 ? uniqueRoomTypes[0] : 'Multiple room categories';
    const mealPlan = uniqueMealPlans.length === 1 ? uniqueMealPlans[0] : 'Multiple meal plans';
    const selectionIds = input.rows
      .map((row) => Number(row.itinerary_plan_hotel_details_ID))
      .sort((a, b) => a - b);
    const reservationKeyBase = [
      input.planId,
      input.groupType,
      provider,
      hotelCode || normalizeText(hotel.hotel_name).toLowerCase(),
      start?.toISOString().slice(0, 10),
      end?.toISOString().slice(0, 10),
      ...(input.scopedSelection ? [`selection:${selectionIds.join(',')}`] : []),
    ].join('|');
    const email = firstEmail(hotel.hotel_email);
    const phone = normalizeText(hotel.hotel_mobile) || null;
    const contactSource = email || phone ? 'HOTEL_MASTER' : null;
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
      stayDetails,
      supplierHold: input.supplierHold
        ? {
            bookingReference: input.supplierHold.bookingReference || null,
            bookingId: input.supplierHold.bookingId || null,
            bookingCode: input.supplierHold.selection?.bookingCode || null,
            lcdDeadlineAt: input.supplierHold.lcdDeadlineAt || null,
          }
        : null,
      providerHold: input.providerHold
        ? {
            channel: input.providerHold.channel,
            confirmationReference: input.providerHold.confirmationReference || null,
            request: input.providerHold.request || null,
            response: input.providerHold.response || null,
            hotelierContact: input.providerHold.hotelierContact || null,
          }
        : null,
    };
    // A submitted request is awaiting the hotelier's response. The hotelier
    // response link is the authoritative transition to Blocked, Waitlisted,
    // Confirmed, or Unavailable.
    const status = input.supplierHold || input.providerHold
      ? HOTEL_BLOCK_STATUS.BLOCKED
      : (email ? HOTEL_BLOCK_STATUS.CONFIRMATION_AWAITED : HOTEL_BLOCK_STATUS.CONTACT_REQUIRED);
    const requestedAt = input.requestedAt || new Date();
    const policy = input.policy || DEFAULT_HOTEL_HOLD_POLICY;
    const configuredCutoff = input.providerHold || email || input.supplierHold
      ? this.getDefaultHotelHoldCutoff(start, requestedAt, policy)
      : null;
    const supplierDeadline = input.supplierHold?.lcdDeadlineAt
      ? new Date(input.supplierHold.lcdDeadlineAt)
      : null;
    const defaultCutoff = configuredCutoff && supplierDeadline && !Number.isNaN(supplierDeadline.getTime())
      && supplierDeadline.getTime() < configuredCutoff.getTime()
      ? supplierDeadline
      : configuredCutoff;
    const confirmationReference = input.supplierHold?.bookingReference || input.providerHold?.confirmationReference || null;
    const candidates = await (this.prisma as any).dvi_hotel_block_request.findMany({
      where: {
        itinerary_plan_id: input.planId,
        group_type: input.groupType,
      },
      orderBy: { id: 'desc' },
    });
    const matchingSelectionRequest = candidates.find((candidate: BlockRow) => {
      if ([HOTEL_BLOCK_STATUS.CANCELLED, HOTEL_BLOCK_STATUS.SUPERSEDED].includes(candidate.status)) return false;
      const candidateIds = (parseJson(candidate.selection_ids, []) as unknown[])
        .map(Number)
        .filter((id) => Number.isInteger(id))
        .sort((a, b) => a - b);
      return candidateIds.length === selectionIds.length && candidateIds.every((id, index) => id === selectionIds[index]);
    });
    // reservation_key is unique and deliberately stable for one selected stay.
    // Keep cancelled/superseded requests as history, but create the next
    // lifecycle under a deterministic generation key instead of colliding
    // with the terminal row when the same hotel is held again.
    const reservationKeyHistory = candidates.filter((candidate: BlockRow) => (
      candidate.reservation_key === reservationKeyBase
      || String(candidate.reservation_key || '').startsWith(`${reservationKeyBase}|retry:`)
    ));
    const latestReservationKey = reservationKeyHistory[0];
    const reservationKey = latestReservationKey
      && [HOTEL_BLOCK_STATUS.CANCELLED, HOTEL_BLOCK_STATUS.SUPERSEDED].includes(latestReservationKey.status)
      ? `${reservationKeyBase}|retry:${Number(latestReservationKey.id)}`
      : reservationKeyBase;
    // An individual row hold is scoped by its exact selection ID. Do not fall
    // back to a reservation-key match here: an older request for the same
    // hotel/date can otherwise be treated as a resend even when this visible
    // row is still Not Started.
    const existing = matchingSelectionRequest || (input.scopedSelection
      ? null
      : await (this.prisma as any).dvi_hotel_block_request.findUnique({ where: { reservation_key: reservationKey } }));
    const existingSupplierHoldExpired = isTboSupplierHoldRequest(existing || {})
      && !isFutureDate(existing?.cutoff_at, requestedAt);
    if (existing && ACTIVE_REQUEST_STATUSES.includes(existing.status) && !existingSupplierHoldExpired) {
      const sameSnapshot = existing.hotel_name === payload.hotelName
        && existing.provider === payload.provider
        && existing.hotel_code === payload.hotelCode
        && existing.room_type === payload.roomType
        && existing.meal_plan === payload.mealPlan
        && Number(existing.room_count || 0) === payload.roomCount
        && (existing.contact_email || null) === email
        && (existing.contact_phone || null) === phone
        && (!input.supplierHold || existing.confirmation_channel === 'TBO_BOOK_HOLD')
        && (!input.providerHold || existing.confirmation_channel === input.providerHold.channel)
        && (!input.supplierHold
          || !input.supplierHold.selection?.bookingCode
          || String(parseJson(existing.request_payload, {})?.supplierHold?.bookingCode || '') === String(input.supplierHold.selection.bookingCode));
      if (sameSnapshot) {
        if (input.supplierHold) {
          return {
            ...this.publicStaffView(existing, policy),
            created: false,
            emailQueued: false,
            supplierBookingReference: existing.confirmation_reference || confirmationReference,
            responseUrl: undefined,
          };
        }
        if (input.providerHold) {
          return {
            ...this.publicStaffView(existing, policy),
            created: false,
            emailQueued: false,
            supplierBookingReference: existing.confirmation_reference || confirmationReference,
            responseUrl: undefined,
            emailKind: 'HOLD_NOTICE',
          };
        }
        if (email) {
          const delivery = await this.resendEmail(existing.id, input.actor || { type: 'STAFF' });
          return {
            ...(delivery.request || this.publicStaffView(existing, policy)),
            created: false,
            emailQueued: true,
            emailDeliveryStatus: delivery.deliveryStatus,
            responseUrl: undefined,
          };
        }
        return { ...this.publicStaffView(existing, policy), created: false, emailQueued: false, responseUrl: undefined };
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
          ...(input.supplierHold ? {
            status,
            cutoff_at: defaultCutoff,
            confirmation_reference: confirmationReference,
            confirmation_channel: 'TBO_BOOK_HOLD',
            voucher_status: 'UNVOUCHERED',
            voucher_attempt_count: 0,
            voucher_generated_at: null,
            voucher_next_attempt_at: null,
            voucher_last_error: null,
          } : {}),
          ...(input.providerHold ? {
            status,
            cutoff_at: defaultCutoff,
            confirmation_reference: confirmationReference,
            confirmation_channel: input.providerHold.channel,
          } : {}),
        },
      });
      return {
        ...this.publicStaffView(refreshed, policy),
        created: false,
        emailQueued: false,
        supplierBookingReference: refreshed.confirmation_reference || undefined,
        responseUrl: undefined,
      };
    }

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
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
              requested_at: requestedAt,
              responded_at: null,
              confirmed_at: null,
              cutoff_at: defaultCutoff,
              confirmation_reference: null,
              confirmation_channel: null,
              respondent_name: null,
              version: Number(existing.version || 1) + 1,
              request_payload: JSON.stringify(payload),
              created_by: Number(input.actor?.id || 0) || null,
              ...(input.supplierHold ? {
                confirmation_reference: confirmationReference,
                confirmation_channel: 'TBO_BOOK_HOLD',
                voucher_status: 'UNVOUCHERED',
                voucher_attempt_count: 0,
                voucher_generated_at: null,
                voucher_next_attempt_at: null,
                voucher_last_error: null,
              } : {}),
              ...(input.providerHold ? {
                confirmation_reference: confirmationReference,
                confirmation_channel: input.providerHold.channel,
              } : {}),
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
              requested_at: requestedAt,
              cutoff_at: defaultCutoff,
              confirmation_reference: confirmationReference,
              confirmation_channel: input.supplierHold ? 'TBO_BOOK_HOLD' : input.providerHold?.channel || null,
              ...(input.supplierHold ? { voucher_status: 'UNVOUCHERED' } : {}),
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
          notes: input.supplierHold
            ? 'VSR supplier hold created through TBO Book with IsVoucherBooking=false.'
            : input.providerHold?.channel === 'AXISROOMS_HOLD'
              ? 'AxisRooms booking notification was accepted with payment pending.'
              : input.providerHold?.channel === 'OFFLINE_HOLD'
                ? 'Offline hotel hold recorded locally; no supplier API was called.'
                : (email ? 'Manual hotel hold request queued for email delivery.' : 'Manual hotel hold request created; hotel contact is required.'),
          metadata: JSON.stringify({ reservationKey, provider }),
        },
      });
      if (!input.supplierHold && !input.providerHold) {
        await tx.dvi_hotel_block_token.create({
          data: { request_id: request.id, token_hash: tokenHash, expires_at: new Date(requestedAt.getTime() + 7 * 24 * 60 * 60 * 1000) },
        });
      }
      if (email && !input.supplierHold) {
        await tx.dvi_hotel_block_message.create({
          data: { request_id: request.id, recipient: this.hotelBlockEmail.deliveryRecipient(email), delivery_status: 'QUEUED', attempt_count: 0 },
        });
      }
      return request;
    });
    return {
      ...this.publicStaffView(created, policy),
      created: !existing,
      supplierBookingReference: confirmationReference || undefined,
      emailQueued: Boolean(email && !input.supplierHold),
      emailKind: input.providerHold ? 'HOLD_NOTICE' : undefined,
      responseUrl: input.supplierHold || input.providerHold
        ? undefined
        : `${publicItineraryBaseUrl()}/hotel/block-response/${rawToken}`,
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
    if (request.status === HOTEL_BLOCK_STATUS.CONFIRMED
      && status !== HOTEL_BLOCK_STATUS.CONFIRMED
      && (request.paid_confirmed_at || !request.cutoff_at)) {
      throw new BadRequestException('A paid or non-expiring confirmed hotel hold cannot be downgraded.');
    }
    const now = new Date();
    const checkIn = dateOnly(request.check_in);
    const checkOut = dateOnly(request.check_out);
    if (checkIn && checkOut && checkOut.getTime() <= checkIn.getTime()) {
      throw new BadRequestException('Hotel checkout must be later than check-in.');
    }
    const policy = await this.getHotelHoldPolicy();
    const keepsHoldCutoff = status === HOTEL_BLOCK_STATUS.BLOCKED || status === HOTEL_BLOCK_STATUS.CONFIRMED;
    const confirmationChannel = normalizeText(request.confirmation_channel).toUpperCase();
    const queuesRelease = status === HOTEL_BLOCK_STATUS.CANCELLED
      && !input.skipSupplierRelease
      && !request.paid_confirmed_at
      && (Boolean(request.cutoff_at) || ['OFFLINE_HOLD', 'AXISROOMS_HOLD'].includes(confirmationChannel));
    // A hotelier response may shorten the default hold, but it cannot set a
    // cutoff in the past. Staff extensions retain the existing hold as their
    // lower bound and therefore can only move the cutoff later.
    const isHotelLinkResponse = input.actor?.type === 'HOTEL_LINK';
    const minimumCutoff = isHotelLinkResponse ? now : this.minimumHotelHoldCutoff(request, now);
    if (keepsHoldCutoff && input.cutoffAt && input.cutoffAt.getTime() < minimumCutoff.getTime()) {
      throw new BadRequestException(isHotelLinkResponse
        ? 'Hold cutoff cannot be in the past.'
        : 'Hold cutoff cannot be before the current hold cutoff or the current time.');
    }
    const defaultCutoff = keepsHoldCutoff && !request.cutoff_at
      ? this.getDefaultHotelHoldCutoff(request.check_in, request.requested_at || now, policy)
      : null;
    const cutoffAt = input.cutoffAt
      || request.cutoff_at
      || (defaultCutoff && defaultCutoff.getTime() < minimumCutoff.getTime() ? minimumCutoff : defaultCutoff);
    const maximumCutoff = this.maxHotelHoldCutoff(request, now, policy);
    if (keepsHoldCutoff && cutoffAt && cutoffAt.getTime() > maximumCutoff.getTime()) {
      throw new BadRequestException(`The hold cutoff cannot be later than ${maximumCutoff.toISOString()}.`);
    }
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
          ...(queuesRelease ? {
            release_status: 'PENDING',
            release_email_status: firstEmail(request.contact_email) ? 'PENDING' : 'MANUAL_REQUIRED',
            release_email_last_error: firstEmail(request.contact_email) ? null : 'Hotel email is missing; staff must request room release.',
          } : {}),
          ...(input.skipSupplierRelease ? {
            release_status: 'ACKNOWLEDGED',
            release_acknowledged_at: now,
            release_last_error: null,
            release_email_status: 'SKIPPED',
            release_email_last_error: null,
          } : {}),
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
          metadata: JSON.stringify({
            confirmationReference: input.confirmationReference || null,
            supplierReleaseSkipped: Boolean(input.skipSupplierRelease),
            hotelierContact: input.hotelierContact || null,
          }),
        },
      });
      if (input.tokenId) await tx.dvi_hotel_block_token.update({ where: { id: input.tokenId }, data: { used_at: now } });
      return result;
    });
    return { success: true, request: this.publicStaffView(updated, policy) };
  }

  private async latestMessagesByRequest(requestIds: number[]) {
    const ids = Array.from(new Set(requestIds.map(Number).filter((id) => id > 0)));
    const messagesByRequest = new Map<number, BlockRow>();
    const messagesModel = (this.prisma as any).dvi_hotel_block_message;
    if (!ids.length || !messagesModel?.findMany) return messagesByRequest;
    try {
      const messages = await messagesModel.findMany({
        where: { request_id: { in: ids } },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      });
      for (const message of messages || []) {
        const requestId = Number(message.request_id || 0);
        if (requestId > 0 && !messagesByRequest.has(requestId)) messagesByRequest.set(requestId, message);
      }
    } catch {
      // Keep the request list available while older deployments are missing
      // the message query surface during rollout.
    }
    return messagesByRequest;
  }

  private isReusableSupplierHold(
    request: BlockRow,
    rows: BlockRow[],
    selection: Record<string, any>,
    now: Date,
  ) {
    if (!isTboSupplierHoldRequest(request) || !isFutureDate(request.cutoff_at, now)) return false;
    const requestIds = (parseJson(request.selection_ids, []) as unknown[])
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0)
      .sort((a, b) => a - b);
    const rowIds = rows
      .map((row) => Number(row.itinerary_plan_hotel_details_ID || 0))
      .filter((id) => Number.isInteger(id) && id > 0)
      .sort((a, b) => a - b);
    if (requestIds.length !== rowIds.length || requestIds.some((id, index) => id !== rowIds[index])) return false;

    const payload = parseJson(request.request_payload, {}) as BlockRow;
    const existingBookingCode = normalizeText(payload?.supplierHold?.bookingCode);
    const bookingCode = normalizeText(selection.bookingCode || selection.BookingCode);
    if (existingBookingCode && bookingCode && existingBookingCode !== bookingCode) return false;
    if (normalizeText(request.hotel_code) !== normalizeText(selection.hotelCode)) return false;
    if (normalizeText(request.room_type) !== normalizeText(selection.roomType)) return false;
    return Number(request.room_count || 0) === Number(selection.numberOfRooms || 0);
  }

  private async refreshSupplierHold(row: BlockRow) {
    if (!isTboSupplierHoldRequest(row)) return { row, statusOverride: undefined as string | undefined, cutoffAt: undefined as Date | undefined };
    // Supplier refresh is only authoritative for a locally active hold. A
    // cancelled or superseded request must stay terminal even if the supplier
    // still reports its booking as confirmed (or the lookup fails).
    if ([HOTEL_BLOCK_STATUS.CANCELLED, HOTEL_BLOCK_STATUS.SUPERSEDED]
      .includes(normalizeText(row.status).toUpperCase() as typeof HOTEL_BLOCK_STATUS.CANCELLED | typeof HOTEL_BLOCK_STATUS.SUPERSEDED)) {
      return { row, statusOverride: undefined as string | undefined, cutoffAt: undefined as Date | undefined };
    }
    const localCutoff = dateOnly(row.cutoff_at);
    try {
      const payload = parseJson(row.request_payload, {}) as BlockRow;
      const supplierHold = (payload?.supplierHold || {}) as BlockRow;
      const bookingId = supplierHold.bookingId || supplierHold.BookingId;
      const detail = await this.tboHotelBooking.getHoldStatus(String(row.confirmation_reference), bookingId);
      const supplierCutoff = dateOnly(detail.bookingDeadline);
      // The TBO deadline is the latest supplier-allowed date, not an extension
      // to the application's configured hold window. A supplier LCD may
      // shorten the persisted policy cutoff, but must never lengthen it.
      const cutoffAt = supplierCutoff && localCutoff
        ? new Date(Math.min(supplierCutoff.getTime(), localCutoff.getTime()))
        : supplierCutoff || localCutoff || undefined;
      const expired = isSupplierExpiredStatus(detail.status)
        || Boolean(cutoffAt && cutoffAt.getTime() <= Date.now());
      return {
        row,
        cutoffAt,
        statusOverride: expired ? 'HOLD_EXPIRED' : 'HOLD',
      };
    } catch {
      // A supplier status outage must not turn a locally active hold into an
      // expired hold. Keep the last known local cutoff and active HOLD label.
      return { row, cutoffAt: localCutoff || undefined, statusOverride: 'HOLD' };
    }
  }

  private publicStaffView(
    row: BlockRow,
    policy = DEFAULT_HOTEL_HOLD_POLICY,
    latestMessage?: BlockRow,
    statusOverride?: string,
  ) {
    const payload = parseJson(row.request_payload, {}) as BlockRow;
    const lastEmailAt = dateOnly(latestMessage?.sent_at || latestMessage?.created_at || row.requested_at);
    const resendAvailableAt = lastEmailAt && !row.responded_at
      && [HOTEL_BLOCK_STATUS.REQUESTED, HOTEL_BLOCK_STATUS.CONFIRMATION_AWAITED].includes(row.status)
      ? new Date(lastEmailAt.getTime() + HOTEL_BLOCK_RESEND_WAIT_MS)
      : null;
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
      status: statusOverride || (isTboSupplierHoldRequest(row) && row.status === HOTEL_BLOCK_STATUS.BLOCKED ? 'HOLD' : row.status),
      contactEmail: row.contact_email,
      contactPhone: row.contact_phone,
      requestedAt: row.requested_at,
      respondedAt: row.responded_at,
      paidConfirmedAt: row.paid_confirmed_at || null,
      voucherStatus: row.voucher_status || 'NOT_APPLICABLE',
      voucherGeneratedAt: row.voucher_generated_at || null,
      voucherNextAttemptAt: row.voucher_next_attempt_at || null,
      voucherLastError: row.voucher_last_error || null,
      cutoffAt: row.cutoff_at,
      maxCutoffAt: this.maxHotelHoldCutoff(row, new Date(), policy),
      holdDurationHours: hotelHoldDurationHours(row.check_in, row.requested_at, policy),
      confirmationReference: row.confirmation_reference,
      confirmationChannel: row.confirmation_channel,
      releaseStatus: row.release_status || 'NOT_REQUIRED',
      releaseEmailStatus: row.release_email_status || 'NOT_REQUIRED',
      releaseLastError: row.release_last_error || null,
      releaseEmailLastError: row.release_email_last_error || null,
      hotelierContact: payload.providerHold?.hotelierContact || null,
      version: row.version,
      selectionIds: (Array.isArray(parseJson(row.selection_ids, [])) ? parseJson(row.selection_ids, []) : [])
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0),
      lastEmailAt,
      resendAvailableAt,
      canResendEmail: Boolean(resendAvailableAt && resendAvailableAt.getTime() <= Date.now()),
      stayDetails: Array.isArray(payload.stayDetails) ? payload.stayDetails : [],
    };
  }

  private publicSupplierView(row: BlockRow, policy = DEFAULT_HOTEL_HOLD_POLICY) {
    const payload = parseJson(row.request_payload, {}) as BlockRow;
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
      requestedAt: row.requested_at,
      cutoffAt: row.cutoff_at,
      maxCutoffAt: this.maxHotelHoldCutoff(row, new Date(), policy),
      holdDurationHours: hotelHoldDurationHours(row.check_in, row.requested_at, policy),
      respondedAt: row.responded_at,
      stayDetails: Array.isArray(payload.stayDetails) ? payload.stayDetails : [],
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
