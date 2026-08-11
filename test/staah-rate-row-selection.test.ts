import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryHotelDetailsTboService } from '../src/modules/itineraries/itinerary-hotel-details-tbo.service';

test('selects the latest received STAAH rate for overlapping room/rate-plan rows', () => {
  const service = new ItineraryHotelDetailsTboService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  const rows = [
    {
      id: 1225,
      staah_property_id: 'STAAHTESTHOTELPROD',
      room_id: 'SUITEROOM',
      rateplan_id: 'MAP_PLAN',
      received_at: new Date('2026-07-07T03:32:21.000Z'),
    },
    {
      id: 1611,
      staah_property_id: 'STAAHTESTHOTELPROD',
      room_id: 'SUITEROOM',
      rateplan_id: 'MAP_PLAN',
      received_at: new Date('2026-07-17T08:09:49.000Z'),
    },
    {
      id: 1670,
      staah_property_id: 'STAAHTESTHOTELPROD',
      room_id: 'SUITEROOM',
      rateplan_id: 'MAP_PLAN',
      received_at: new Date('2026-07-29T10:19:38.000Z'),
    },
  ];

  const effective = (service as any).selectEffectiveStaahRateRows(rows);

  assert.deepEqual(effective.map((row: any) => row.id), [1670]);
});
