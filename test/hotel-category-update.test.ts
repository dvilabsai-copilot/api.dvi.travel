import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { HotelsService } from '../src/modules/hotels/hotels.service';

function makeIncompleteHotel() {
  return {
    hotel_name: 'Incomplete hotel',
    hotel_code: '',
    resavenue_hotel_code: null,
    hotel_place: 'Chennai',
    hotel_mobile: '9000000000',
    hotel_email: '',
    hotel_address: 'Test address',
    hotel_category: 38,
    status: 1,
    hotel_power_backup: 0,
    hotel_hotspot_status: 0,
    hotel_country: 'India',
    hotel_state: 'Tamil Nadu',
    hotel_city: 'Chennai',
    hotel_pincode: '600001',
    hotel_margin: 0,
    hotel_margin_gst_type: 0,
    hotel_margin_gst_percentage: 0,
  };
}

function makeService() {
  const calls: { findUnique: any[]; update: any[] } = { findUnique: [], update: [] };
  const prisma = {
    dvi_hotel: {
      findUnique: async (args: any) => {
        calls.findUnique.push(args);
        return makeIncompleteHotel();
      },
      update: async (args: any) => {
        calls.update.push(args);
        return { ...makeIncompleteHotel(), ...args.data };
      },
    },
  };
  return { service: new HotelsService(prisma as any), calls };
}

test('category-only hotel update does not require code or email', async () => {
  const { service, calls } = makeService();

  const result = await service.update(42, { hotel_category: 3 } as any);

  assert.equal(result.hotel_category, 3);
  assert.equal(calls.findUnique.length, 0);
  assert.deepEqual(calls.update[0].data, { hotel_category: 3 });
});

test('full basic hotel update keeps required-field validation', async () => {
  const { service, calls } = makeService();

  await assert.rejects(
    () => service.update(42, { hotel_category: 3, hotel_name: 'Renamed hotel' } as any),
    (error: any) => {
      assert.ok(error instanceof BadRequestException);
      assert.equal(error.getResponse().errors.hotel_code_required, true);
      assert.equal(error.getResponse().errors.hotel_email_id_required, true);
      return true;
    },
  );

  assert.equal(calls.findUnique.length, 1);
  assert.equal(calls.update.length, 0);
});

test('category-only hotel update rejects an invalid category id', async () => {
  const { service, calls } = makeService();

  await assert.rejects(
    () => service.update(42, { hotel_category: 0 } as any),
    (error: any) => {
      assert.ok(error instanceof BadRequestException);
      assert.equal(error.getResponse().errors.hotel_category_required, true);
      return true;
    },
  );

  assert.equal(calls.findUnique.length, 0);
  assert.equal(calls.update.length, 0);
});

test('status-only hotel update keeps existing full-form validation', async () => {
  const { service, calls } = makeService();

  await assert.rejects(
    () => service.update(42, { status: 0 } as any),
    (error: any) => {
      assert.ok(error instanceof BadRequestException);
      assert.equal(error.getResponse().errors.hotel_code_required, true);
      assert.equal(error.getResponse().errors.hotel_email_id_required, true);
      return true;
    },
  );

  assert.equal(calls.findUnique.length, 1);
  assert.equal(calls.update.length, 0);
});
