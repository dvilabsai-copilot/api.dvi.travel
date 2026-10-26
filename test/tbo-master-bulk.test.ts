import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import {
  normalizeTboMasterImportHeader,
  parseTboMasterListCell,
  TboMasterHotelService,
} from '../src/modules/hotels/services/tbo-master-hotel.service';

test('normalizes bulk import headers and list cells', () => {
  assert.equal(normalizeTboMasterImportHeader('Hotel category'), 'hotelcategory');
  assert.deepEqual(parseTboMasterListCell('Pool, Wi-Fi\nParking'), ['Pool', 'Wi-Fi', 'Parking']);
  assert.deepEqual(parseTboMasterListCell('["Pool","Wi-Fi"]'), ['Pool', 'Wi-Fi']);
});
test('exports editable fields first and identifies rows by hotel_id', async () => {
  let exportArgs: any;
  const prisma = {
    tbo_hotel_master: {
      findMany: async (args: any) => { exportArgs = args; return [{
        id: 42,
        hotel_name: 'Example Hotel',
        hotel_category_id: 7,
        hotel_email: 'hotel@example.test',
        hotel_mobile: '+911234567890',
        facilities: ['Pool'],
        tbo_hotel_code: '5000258',
        tbo_city_code: 'COK',
        hotel_address: 'Address',
        city_name: 'Cochin',
        star_rating: 4,
        hotel_image_url: null,
        description: null,
        check_in_time: null,
        check_out_time: null,
        created_at: null,
        updated_at: null,
        status: 1,
        hotel_latitude: '',
        hotel_longitude: '',
        is_priority: 0,
        amenities: ['Wi-Fi'],
        reviews: [],
      }]; },
    },
    dvi_hotel_category: {
      findMany: async () => [{ hotel_category_id: 7, hotel_category_title: 'Premium', hotel_category_code: 'PREMIUM' }],
    },
  };
  const service = new TboMasterHotelService(prisma as any, null as any, null as any);
  const result = await service.exportBulk({ search: 'Example', priority: '1' });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(result.buffer as any);
  const row = workbook.worksheets[0].getRow(1).values as unknown[];
  assert.deepEqual(row.slice(1, 7), ['Hotel name', 'Hotel category', 'Hotel email', 'Hotel phone', 'Facilities', 'Amenities']);
  assert.equal(row.includes('Description'), false);
  assert.equal(row.includes('Created at'), false);
  assert.equal(row.includes('Updated at'), false);
  assert.deepEqual(exportArgs.where, {
    status: 1,
    is_priority: 1,
    AND: [{
      OR: [
        { hotel_name: { contains: 'Example' } },
        { tbo_hotel_code: { contains: 'Example' } },
        { city_name: { contains: 'Example' } },
      ],
    }],
  });
  assert.equal(workbook.worksheets[0].getRow(2).getCell(7).value, 42);
  assert.equal(workbook.worksheets[0].getRow(2).getCell(2).value, 'Premium');
  assert.match(result.fileName, /^vsr-master-hotels-priority-only-search-example-\d{4}-\d{2}-\d{2}\.xlsx$/);
});

test('applies the South India region to the bulk export', async () => {
  let exportArgs: any;
  let stateArgs: any;
  const prisma = {
    tbo_hotel_master: { findMany: async (args: any) => { exportArgs = args; return []; } },
    dvi_hotel_category: { findMany: async () => [] },
    dvi_states: { findMany: async (args: any) => { stateArgs = args; return [{ id: 10 }] } },
    dvi_cities: { findMany: async () => [{ name: 'Munnar', tbo_city_code: 'MUN' }] },
  };
  const service = new TboMasterHotelService(prisma as any, null as any, null as any);
  await service.exportBulk({ region: 'south-india' });
  assert.deepEqual(exportArgs.where, {
    status: 1,
    AND: [{ OR: [{ tbo_city_code: { in: ['MUN'] } }, { city_name: { in: ['Munnar'] } }] }],
  });
  await service.exportBulk({ region: 'kerala' });
  assert.deepEqual(stateArgs.where.name, { in: ['Kerala'] });
});

test('imports only the six editable fields by hotel_id', async () => {
  const updates: Array<{ id: number; data: Record<string, unknown> }> = [];
  const prisma = {
    tbo_hotel_master: {
      findMany: async (args: any) => args?.where?.id ? [{ id: 42 }] : [],
      update: async ({ where, data }: any) => { updates.push({ id: where.id, data }); return { id: where.id }; },
    },
    dvi_hotel_category: {
      findMany: async () => [{ hotel_category_id: 7, hotel_category_title: 'Premium', hotel_category_code: 'PREMIUM' }],
    },
    $transaction: async (queries: Promise<unknown>[]) => Promise.all(queries),
  };
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Hotels');
  sheet.addRow(['hotel_id', 'Hotel name', 'Hotel category', 'Hotel email', 'Hotel phone', 'Facilities', 'Amenities', 'Hotel address']);
  sheet.addRow([42, 'Updated Hotel', 'Premium', 'updated@example.test', '+919999999999', 'Pool, Parking', 'Wi-Fi', 'This must be ignored']);
  const service = new TboMasterHotelService(prisma as any, null as any, null as any);
  const result = await service.importBulk(Buffer.from(await workbook.xlsx.writeBuffer() as any));
  assert.deepEqual(result, { success: true, updated: 1 });
  assert.deepEqual(updates, [{
    id: 42,
    data: {
      hotel_name: 'Updated Hotel',
      hotel_category_id: 7,
      hotel_email: 'updated@example.test',
      hotel_mobile: '+919999999999',
      facilities: ['Pool', 'Parking'],
      amenities: ['Wi-Fi'],
    },
  }]);
});
