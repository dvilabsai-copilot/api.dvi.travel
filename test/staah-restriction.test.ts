import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StaahRestrictionService } from '../src/modules/itineraries/services/staah-restriction.service';

const stay = {
  checkIn: new Date('2026-07-20T00:00:00Z'),
  checkOut: new Date('2026-07-22T00:00:00Z'),
};

test('blocks a stay-overlapping stop-sell restriction and reports the next date', () => {
  const result = new StaahRestrictionService().evaluate(
    [{ type: 'stop_sell', value: 'true', start_date: '2026-07-19', end_date: '2026-07-21' }],
    stay.checkIn,
    stay.checkOut,
    2,
  );

  assert.deepEqual(result, {
    blocked: true,
    reason: 'stop sell active during stay 2026-07-20 to 2026-07-21',
    availableAgainFrom: '2026-07-22',
  });
});

test('applies CTA, CTD and length-of-stay restrictions in the existing precedence order', () => {
  const service = new StaahRestrictionService();
  const cta = service.evaluate(
    [{ type: 'cta', value: '1', start_date: '2026-07-20', end_date: '2026-07-20' }],
    stay.checkIn,
    stay.checkOut,
    2,
  );
  assert.equal(cta.reason, 'CTA active on check-in date 2026-07-20');

  const ctd = service.evaluate(
    [{ type: 'ctd', value: 'closed', start_date: '2026-07-22', end_date: '2026-07-22' }],
    stay.checkIn,
    stay.checkOut,
    2,
  );
  assert.equal(ctd.reason, 'CTD active on check-out date 2026-07-22');

  const minStay = service.evaluate(
    [{ type: 'minstay', value: 3, start_date: '2026-07-20', end_date: '2026-07-22' }],
    stay.checkIn,
    stay.checkOut,
    2,
  );
  assert.equal(minStay.reason, 'minimum stay 3 nights required for LOS 2');
});
