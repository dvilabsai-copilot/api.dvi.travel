import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HotelGalleryService } from '../src/modules/hotels/services/hotel-gallery.service';

function fakePrisma() {
  let nextId = 1;
  const rows: any[] = [];
  const active = (row: any) => row.hotel_id === 901 && row.status === 1 && row.deleted === 0;
  const gallery = {
    findMany: async (args: any = {}) => rows
      .filter((row) => (args.where?.hotel_id?.in ? args.where.hotel_id.in.includes(row.hotel_id) : active(row)))
      .filter((row) => args.where?.status === undefined || row.status === args.where.status)
      .filter((row) => args.where?.deleted === undefined || row.deleted === args.where.deleted)
      .filter((row) => args.where?.hotel_gallery_details_id === undefined || row.hotel_gallery_details_id === args.where.hotel_gallery_details_id)
      .sort((a, b) => a.sort_order - b.sort_order || a.hotel_gallery_details_id - b.hotel_gallery_details_id),
    findFirst: async (args: any = {}) => (await gallery.findMany(args))[0] || null,
    create: async (args: any) => {
      const row = { hotel_gallery_details_id: nextId++, updatedon: new Date(), ...args.data };
      rows.push(row);
      return row;
    },
    updateMany: async (args: any) => {
      for (const row of rows) if (active(row) && (!args.where?.is_primary || row.is_primary === args.where.is_primary)) Object.assign(row, args.data);
      return { count: rows.length };
    },
    update: async (args: any) => {
      const row = rows.find((candidate) => candidate.hotel_gallery_details_id === args.where.hotel_gallery_details_id);
      Object.assign(row, args.data);
      return row;
    },
  };
  return {
    dvi_hotel: { findFirst: async () => ({ hotel_id: 901 }) },
    dvi_hotel_gallery_details: gallery,
    $transaction: async (callback: any) => callback({ dvi_hotel_gallery_details: gallery }),
  } as any;
}

test('hotel gallery keeps one primary and promotes the next image on delete', async () => {
  const prisma = fakePrisma();
  const service = new HotelGalleryService(prisma);
  const root = path.resolve(process.cwd(), 'public', 'uploads', 'hotel_gallery', '901');
  await fs.rm(root, { recursive: true, force: true });

  const uploaded = await service.upload(901, [
    { mimetype: 'image/jpeg', size: 3, buffer: Buffer.from('one') } as any,
    { mimetype: 'image/png', size: 3, buffer: Buffer.from('two') } as any,
  ]);
  assert.equal(uploaded.length, 2);
  assert.equal(uploaded.filter((image) => image.isPrimary).length, 1);

  const promoted = await service.setPrimary(901, uploaded[1].id);
  assert.equal(promoted.find((image) => image.id === uploaded[1].id)?.isPrimary, true);
  assert.equal(promoted.filter((image) => image.isPrimary).length, 1);

  const afterDelete = await service.remove(901, uploaded[1].id);
  assert.equal(afterDelete.length, 1);
  assert.equal(afterDelete[0].isPrimary, true);
  await fs.rm(root, { recursive: true, force: true });
});
