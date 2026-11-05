import assert from 'node:assert/strict';
import test from 'node:test';
import { HotelHoldCutoffReminderScheduler } from '../src/modules/itineraries/services/hotel-hold-cutoff-reminder.scheduler';

const createReminderScheduler = (paidConfirmedAt: Date | null = null) => {
  const now = new Date('2026-11-05T12:00:00.000Z');
  const notification: any = {
    id: 1, request_id: 10, notification_type: 'PAYMENT_REMINDER', milestone_key: 'h-1',
    delivery_status: 'QUEUED', attempt_count: 0, recipient: null,
  };
  const request: any = {
    id: 10, itinerary_plan_id: 20, status: 'BLOCKED', paid_confirmed_at: paidConfirmedAt,
    cutoff_at: new Date('2026-11-05T13:00:00.000Z'), check_in: new Date('2026-11-06T00:00:00.000Z'),
    check_out: new Date('2026-11-07T00:00:00.000Z'), hotel_name: 'Test Hotel', provider: 'OFFLINE',
    room_type: 'Deluxe', room_count: 1, request_payload: '{}',
  };
  const events: any[] = [];
  let deliveryCalls = 0;
  const email: any = {
    dispatchReminder: async () => {
      deliveryCalls += 1;
      if (deliveryCalls === 1) throw new Error('Temporary mail failure');
      return { status: 'SENT', recipient: 'expert@example.test', providerMessageId: 'msg-10' };
    },
  };
  const prisma: any = {
    dvi_hotel_hold_notification: {
      updateMany: async ({ where, data }: any) => {
        if (where.id !== notification.id || notification.attempt_count >= where.attempt_count.lt) return { count: 0 };
        notification.delivery_status = data.delivery_status;
        notification.attempt_count += Number(data.attempt_count?.increment || 0);
        notification.updated_at = data.updated_at;
        notification.last_error = data.last_error;
        return { count: 1 };
      },
      update: async ({ data }: any) => Object.assign(notification, data),
    },
    dvi_hotel_block_request: { findUnique: async () => request },
    dvi_itinerary_plan_details: { findUnique: async () => ({ itinerary_quote_ID: 'DVI-TEST-10', agent_id: 7 }) },
    dvi_agent: { findFirst: async () => ({ agent_email_id: 'expert@example.test', travel_expert_id: null }) },
    dvi_hotel_block_event: { create: async ({ data }: any) => { events.push(data); } },
  };
  const scheduler = new HotelHoldCutoffReminderScheduler(
    prisma,
    email,
    {} as any,
  );
  return { scheduler, notification, request, events, getDeliveryCalls: () => deliveryCalls, now };
};

test('payment reminder delivery failure is retried from the durable notification row', async () => {
  const { scheduler, notification, events, getDeliveryCalls, now } = createReminderScheduler();

  assert.equal(await (scheduler as any).sendReminder(notification, now), false);
  assert.equal(notification.delivery_status, 'FAILED');
  assert.equal(notification.last_error, 'Temporary mail failure');

  assert.equal(await (scheduler as any).sendReminder(notification, new Date(now.getTime() + 60_000)), true);
  assert.equal(getDeliveryCalls(), 2);
  assert.equal(notification.delivery_status, 'SENT');
  assert.equal(notification.provider_message_id, 'msg-10');
  assert.equal(events.filter((event) => event.event_type === 'PAYMENT_REMINDER_SENT').length, 1);
});

test('payment reminder is skipped when payment has already been recorded', async () => {
  const { scheduler, notification, getDeliveryCalls, now } = createReminderScheduler(nowPlusMinute());

  assert.equal(await (scheduler as any).sendReminder(notification, now), false);
  assert.equal(notification.delivery_status, 'SKIPPED');
  assert.equal(getDeliveryCalls(), 0);
});

test('reminder milestones are scoped to the current hold version after an extension', async () => {
  const now = new Date('2026-11-05T12:00:00.000Z');
  const notificationRows: any[] = [];
  const request = {
    id: 25,
    itinerary_plan_id: 30,
    version: 5,
    requested_at: new Date('2026-11-05T10:00:00.000Z'),
    status: 'BLOCKED',
    paid_confirmed_at: null,
    cutoff_at: new Date('2026-11-05T13:00:00.000Z'),
    check_in: new Date('2026-11-20T00:00:00.000Z'),
  };
  const prisma: any = {
    dvi_global_settings: {
      findFirst: async () => ({
        hotel_hold_reminders_enabled: 1,
        hotel_hold_reminder_email_enabled: 1,
        hotel_hold_reminder_milestones: JSON.stringify({ '12': [6, 3, 0.25], '48': [36, 24, 12, 1, 0.25], '240': [216, 192, 168, 144, 120, 96, 72, 48, 24, 12, 1, 0.25] }),
        hotel_hold_final_reminder_minutes: 15,
      }),
    },
    dvi_hotel_block_request: { findMany: async () => [request] },
    dvi_hotel_hold_notification: {
      create: async ({ data }: any) => { notificationRows.push(data); },
      findMany: async () => [],
    },
  };
  const email: any = { isDispatchEnabled: () => true };
  const hotelBlocking: any = { getHoldPolicyDecision: async () => ({ allowed: true, durationHours: 48 }) };
  const scheduler = new HotelHoldCutoffReminderScheduler(prisma, email, hotelBlocking);

  await scheduler.runOnce(now);

  assert.equal(notificationRows.some((row) => row.request_version === 5 && row.milestone_key === 'h-1'), true);
  assert.equal(notificationRows.every((row) => row.request_version === 5), true);
});

function nowPlusMinute() {
  return new Date('2026-11-05T12:01:00.000Z');
}
