import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

export type HotelGalleryImage = {
  id: number;
  hotelId: number;
  fileName: string;
  url: string;
  isPrimary: boolean;
  sortOrder: number;
  source: string;
  sourceUrl: string | null;
};

const ALLOWED_MIME_TYPES = new Map<string, string>([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

@Injectable()
export class HotelGalleryService {
  constructor(private readonly prisma: PrismaService) {}

  private uploadRoot(hotelId: number) {
    return path.resolve(process.cwd(), 'public', 'uploads', 'hotel_gallery', String(hotelId));
  }

  private toImage(row: any): HotelGalleryImage {
    return {
      id: Number(row.hotel_gallery_details_id),
      hotelId: Number(row.hotel_id),
      fileName: String(row.hotel_gallery_name || ''),
      url: `/uploads/hotel_gallery/${Number(row.hotel_id)}/${encodeURIComponent(String(row.hotel_gallery_name || ''))}`,
      isPrimary: Number(row.is_primary) === 1,
      sortOrder: Number(row.sort_order || 0),
      source: String(row.source || 'manual'),
      sourceUrl: row.source_url ? String(row.source_url) : null,
    };
  }

  async getHotelImages(hotelId: number): Promise<HotelGalleryImage[]> {
    const grouped = await this.getHotelImagesForHotels([hotelId]);
    return grouped.get(Number(hotelId)) || [];
  }

  async getHotelImagesForHotels(hotelIds: number[]): Promise<Map<number, HotelGalleryImage[]>> {
    const ids = Array.from(new Set(hotelIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
    const result = new Map<number, HotelGalleryImage[]>();
    if (ids.length === 0) return result;

    const rows = await this.prisma.dvi_hotel_gallery_details.findMany({
      where: {
        hotel_id: { in: ids },
        status: 1,
        deleted: 0,
      },
      orderBy: [{ hotel_id: 'asc' }, { sort_order: 'asc' }, { hotel_gallery_details_id: 'asc' }],
    });

    for (const row of rows) {
      const image = this.toImage(row);
      const bucket = result.get(image.hotelId) || [];
      bucket.push(image);
      result.set(image.hotelId, bucket);
    }
    return result;
  }

  private async assertHotelExists(hotelId: number) {
    const hotel = await this.prisma.dvi_hotel.findFirst({
      where: { hotel_id: hotelId, OR: [{ deleted: false }, { deleted: null }] },
      select: { hotel_id: true },
    });
    if (!hotel) throw new NotFoundException('Hotel not found');
  }

  async upload(hotelId: number, files: Express.Multer.File[], createdBy = 0) {
    const id = Number(hotelId);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException('Invalid hotel id');
    if (!files?.length) throw new BadRequestException('At least one image is required');
    if (files.length > 12) throw new BadRequestException('A maximum of 12 images may be uploaded at once');

    await this.assertHotelExists(id);
    for (const file of files) {
      if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
        throw new BadRequestException('Only JPEG, PNG, and WebP images are allowed');
      }
      if (!file.buffer || file.size > 10 * 1024 * 1024) {
        throw new BadRequestException('Each image must be 10 MB or smaller');
      }
    }

    const directory = this.uploadRoot(id);
    await fs.mkdir(directory, { recursive: true });
    const writtenFiles: string[] = [];
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.dvi_hotel_gallery_details.findMany({
          where: { hotel_id: id, status: 1, deleted: 0 },
          select: { is_primary: true, sort_order: true },
          orderBy: { sort_order: 'desc' },
        });
        let nextSort = Number(existing[0]?.sort_order || 0) + 1;
        let hasPrimary = existing.some((row) => Number(row.is_primary) === 1);
        const created: any[] = [];

        for (const file of files) {
          const extension = ALLOWED_MIME_TYPES.get(file.mimetype)!;
          const fileName = `hotel-${id}-${randomUUID()}${extension}`;
          const target = path.join(directory, fileName);
          await fs.writeFile(target, file.buffer);
          writtenFiles.push(target);

          const row = await tx.dvi_hotel_gallery_details.create({
            data: {
              hotel_id: id,
              hotel_gallery_name: fileName,
              is_primary: hasPrimary ? 0 : 1,
              sort_order: nextSort++,
              source: 'manual',
              source_url: null,
              createdby: Number(createdBy) || 0,
              createdon: new Date(),
              status: 1,
              deleted: 0,
            },
          });
          created.push(row);
          hasPrimary = true;
        }
        return created.map((row) => this.toImage(row));
      });
    } catch (error) {
      await Promise.all(writtenFiles.map((file) => fs.unlink(file).catch(() => undefined)));
      throw error;
    }
  }

  async setPrimary(hotelId: number, imageId: number) {
    const id = Number(hotelId);
    const image = await this.prisma.dvi_hotel_gallery_details.findFirst({
      where: { hotel_gallery_details_id: Number(imageId), hotel_id: id, status: 1, deleted: 0 },
    });
    if (!image) throw new NotFoundException('Gallery image not found');

    await this.prisma.$transaction(async (tx) => {
      await tx.dvi_hotel_gallery_details.updateMany({
        where: { hotel_id: id, status: 1, deleted: 0 },
        data: { is_primary: 0 },
      });
      await tx.dvi_hotel_gallery_details.update({
        where: { hotel_gallery_details_id: Number(imageId) },
        data: { is_primary: 1 },
      });
    });
    return this.getHotelImages(id);
  }

  async remove(hotelId: number, imageId: number) {
    const id = Number(hotelId);
    const image = await this.prisma.dvi_hotel_gallery_details.findFirst({
      where: { hotel_gallery_details_id: Number(imageId), hotel_id: id, status: 1, deleted: 0 },
    });
    if (!image) throw new NotFoundException('Gallery image not found');

    const wasPrimary = Number(image.is_primary) === 1;
    await this.prisma.$transaction(async (tx) => {
      await tx.dvi_hotel_gallery_details.update({
        where: { hotel_gallery_details_id: Number(imageId) },
        data: { status: 0, deleted: 1, is_primary: 0 },
      });
      if (wasPrimary) {
        const next = await tx.dvi_hotel_gallery_details.findFirst({
          where: { hotel_id: id, status: 1, deleted: 0 },
          orderBy: [{ sort_order: 'asc' }, { hotel_gallery_details_id: 'asc' }],
        });
        if (next) {
          await tx.dvi_hotel_gallery_details.update({
            where: { hotel_gallery_details_id: next.hotel_gallery_details_id },
            data: { is_primary: 1 },
          });
        }
      }
    });

    await fs.unlink(path.join(this.uploadRoot(id), String(image.hotel_gallery_name || ''))).catch(() => undefined);
    return this.getHotelImages(id);
  }
}
