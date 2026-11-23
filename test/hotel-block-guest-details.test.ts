import assert from 'node:assert/strict';
import test from 'node:test';
import { HotelBlockingService } from '../src/modules/itineraries/services/hotel-blocking.service';

test('guest details specify the update timestamp for both insert and repeat save', async () => {
  const writes: Array<{ sql: string; planId: number; payload: string; actor: number }> = [];
  const service = new HotelBlockingService({
    $executeRawUnsafe: async (sql: string, planId: number, payload: string, actor: number) => {
      writes.push({ sql, planId, payload, actor });
    },
  } as never, {} as never);
  const guest = {
    name: 'Synthetic Guest', age: '33', contactNo: '0000000000', emailId: 'guest@example.invalid',
    arrivalDateTime: '06-12-2026 5:30 PM', departureDateTime: '10-12-2026 5:30 PM',
  };

  await service.saveGuestDetails(42, guest, { id: 1 });
  await service.saveGuestDetails(42, { ...guest, name: 'Updated Guest' }, { id: 2 });
  for (const write of writes) {
    assert.match(write.sql, /\(itinerary_plan_id, guest_payload, created_by, updated_at\)/);
    assert.match(write.sql, /VALUES \(\?, \?, \?, CURRENT_TIMESTAMP\)/);
    assert.match(write.sql, /ON DUPLICATE KEY UPDATE[\s\S]*updated_at = CURRENT_TIMESTAMP/);
    assert.equal(write.planId, 42);
  }
  assert.deepEqual(writes.map(({ payload, actor }) => [JSON.parse(payload), actor]), [
    [guest, 1],
    [{ ...guest, name: 'Updated Guest' }, 2],
  ]);
  await assert.rejects(service.saveGuestDetails(42, { ...guest, emailId: '' }), /Lead guest name/);
  assert.equal(writes.length, 2);
});
