import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StaahRoomMappingService } from '../src/modules/itineraries/services/staah-room-mapping.service';

test('builds exact, loose and property-to-hotel STAAH room maps', () => {
  const service = new StaahRoomMappingService();
  const result = service.build(
    [
      { hotel_id: 10, room_ref_code: ' Deluxe-1 ', room_title: 'Deluxe' },
      { hotel_id: 10, room_ref_code: 'STANDARD', room_title: 'Standard' },
      { hotel_id: 11, room_ref_code: 'ROOM-2', room_title: 'Room 2' },
    ],
    [{ hotel_id: 10, staah_property_id: 'P10' }, { hotel_id: 11, staah_property_id: 'P11' }],
    (value) => String(value || '').trim().toUpperCase(),
    (value) => String(value || '').replace(/[^A-Z0-9]/gi, '').toUpperCase(),
  );

  assert.deepEqual(Array.from(result.activeRoomCodesByHotelId.get(10) || []), ['DELUXE-1', 'STANDARD']);
  assert.equal(result.activeRoomLooseCodesByHotelId.get(10)?.has('DELUXE1'), true);
  assert.equal(result.activeRoomLooseExactCodesByHotelId.get(10)?.get('DELUXE1')?.has('DELUXE-1'), true);
  assert.equal(result.roomTitleByHotelAndCode.get('10|DELUXE1'), 'Deluxe');
  assert.equal(result.hotelIdByPropertyId.get('P11'), 11);
});

test('ignores rows without a usable hotel and exact room code', () => {
  const result = new StaahRoomMappingService().build(
    [{ hotel_id: 0, room_ref_code: 'ROOM' }, { hotel_id: 1, room_ref_code: '' }],
    [{ hotel_id: 1, staah_property_id: 'P1' }],
    (value) => String(value || '').trim().toUpperCase(),
    (value) => String(value || '').replace(/[^A-Z0-9]/gi, '').toUpperCase(),
  );
  assert.equal(result.activeRoomCodesByHotelId.size, 0);
  assert.equal(result.allowedRoomCodesByPropertyId.get('P1')?.size, 0);
});
