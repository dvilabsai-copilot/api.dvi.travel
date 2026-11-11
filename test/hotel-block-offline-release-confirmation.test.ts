import assert from 'node:assert/strict';
import test from 'node:test';
import { HotelBlockingService } from '../src/modules/itineraries/services/hotel-blocking.service';

test('offline hold release confirmed by phone is acknowledged without release follow-up', async () => {
  const request = {
    id: 24,
    status: 'BLOCKED',
    confirmation_channel: 'OFFLINE_HOLD',
    cutoff_at: new Date(Date.now() + 60 * 60 * 1000),
    requested_at: new Date(),
    check_in: new Date(Date.now() + 10 * 86_400_000),
    check_out: new Date(Date.now() + 11 * 86_400_000),
    paid_confirmed_at: null,
    contact_email: 'hotel@example.test',
  };
  const updates: any[] = [];
  const events: any[] = [];
  const prisma: any = {
    dvi_hotel_block_request: { findUnique: async () => request },
    dvi_global_settings: { findFirst: async () => null },
    $transaction: async (callback: (tx: any) => Promise<unknown>) => callback({
      dvi_hotel_block_request: { update: async ({ data }: any) => { updates.push(data); return { ...request, ...data }; } },
      dvi_hotel_block_event: { create: async ({ data }: any) => { events.push(data); } },
    }),
  };
  const service = new HotelBlockingService(prisma, {} as any, {} as any);

  await service.cancel(request.id, { id: 7, type: 'STAFF' }, {
    hotelierContact: { name: 'Hotel Desk', phone: '8888888888' },
  });

  assert.equal(updates[0].status, 'CANCELLED');
  assert.equal(updates[0].release_status, 'ACKNOWLEDGED');
  assert.equal(updates[0].release_email_status, 'SKIPPED');
  assert.match(events[0].notes, /confirmed the offline hold release by phone/i);
  assert.equal(JSON.parse(events[0].metadata).hotelierContact.phone, '8888888888');
});

test('legacy cancelled offline release with hotelier contact is recognized for itinerary display', async () => {
  const prisma: any = {
    dvi_hotel_block_event: {
      findMany: async () => [{
        request_id: 25,
        event_type: 'CANCELLED',
        metadata: JSON.stringify({ hotelierContact: { name: 'Hotel Desk', phone: '8888888888' } }),
      }],
    },
  };
  const service = new HotelBlockingService(prisma, {} as any, {} as any);

  const confirmed = await (service as any).offlineReleaseConfirmedByHotelierIds([{
    id: 25,
    status: 'CANCELLED',
    confirmation_channel: 'OFFLINE_HOLD',
  }]);
  const notCancelled = await (service as any).offlineReleaseConfirmedByHotelierIds([{
    id: 26,
    status: 'BLOCKED',
    confirmation_channel: 'OFFLINE_HOLD',
  }]);

  assert.deepEqual([...confirmed], [25]);
  assert.deepEqual([...notCancelled], []);
});
