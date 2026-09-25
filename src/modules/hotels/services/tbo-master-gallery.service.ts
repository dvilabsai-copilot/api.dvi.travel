import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

export type TboMasterGalleryImage = {
  id: number;
  hotelCode: string;
  fileName: string;
  url: string;
  isPrimary: boolean;
  sortOrder: number;
  source: string;
  sourceUrl: string | null;
};

export type TboMasterRoomGalleryImage = {
  id: number;
  hotelCode: string;
  roomRefCode: string;
  roomTitle: string;
  fileName: string;
  url: string;
};

const ALLOWED_MIME_TYPES = new Map<string, string>([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

@Injectable()
export class TboMasterGalleryService {
  constructor(private readonly prisma: PrismaService) {}

  private normalizeCode(code: string) {
    const value = String(code || '').trim();
    if (!value) throw new BadRequestException('TBO hotel code is required');
    return value;
  }

  private hotelUploadRoot(code: string) {
    return path.resolve(process.cwd(), 'public', 'uploads', 'tbo_hotel_gallery', code);
  }

  private roomUploadRoot(code: string) {
    return path.resolve(process.cwd(), 'public', 'uploads', 'tbo_room_gallery', code);
  }

  private toImage(row: any): TboMasterGalleryImage {
    const code = String(row.tbo_hotel_code || '');
    const fileName = String(row.tbo_hotel_gallery_name || '');
    return {
      id: Number(row.tbo_hotel_gallery_details_id),
      hotelCode: code,
      fileName,
      url: `/uploads/tbo_hotel_gallery/${encodeURIComponent(code)}/${encodeURIComponent(fileName)}`,
      isPrimary: Number(row.is_primary) === 1,
      sortOrder: Number(row.sort_order || 0),
      source: String(row.source || 'manual'),
      sourceUrl: row.source_url ? String(row.source_url) : null,
    };
  }

  private toRoomImage(row: any): TboMasterRoomGalleryImage {
    const code = String(row.tbo_hotel_code || '');
    const fileName = String(row.room_gallery_name || '');
    return {
      id: Number(row.tbo_hotel_room_gallery_details_id),
      hotelCode: code,
      roomRefCode: String(row.room_ref_code || ''),
      roomTitle: String(row.room_title || row.room_ref_code || ''),
      fileName,
      url: `/uploads/tbo_room_gallery/${encodeURIComponent(code)}/${encodeURIComponent(fileName)}`,
    };
  }

  async getHotelImages(code: string) {
    const normalized = this.normalizeCode(code);
    const rows = await this.prisma.tbo_hotel_gallery_details.findMany({
      where: { tbo_hotel_code: normalized, status: 1, deleted: 0 },
      orderBy: [{ sort_order: 'asc' }, { tbo_hotel_gallery_details_id: 'asc' }],
    });
    return rows.map((row) => this.toImage(row));
  }

  async getHotelImagesForCodes(codes: string[]) {
    const normalized = Array.from(new Set(codes.map((code) => String(code || '').trim()).filter(Boolean)));
    const result = new Map<string, TboMasterGalleryImage[]>();
    if (!normalized.length) return result;
    const rows = await this.prisma.tbo_hotel_gallery_details.findMany({
      where: { tbo_hotel_code: { in: normalized }, status: 1, deleted: 0 },
      orderBy: [{ tbo_hotel_code: 'asc' }, { sort_order: 'asc' }, { tbo_hotel_gallery_details_id: 'asc' }],
    });
    for (const row of rows) {
      const image = this.toImage(row);
      const bucket = result.get(image.hotelCode) || [];
      bucket.push(image);
      result.set(image.hotelCode, bucket);
    }
    return result;
  }

  async getRoomImages(code: string) {
    const normalized = this.normalizeCode(code);
    const rows = await this.prisma.tbo_hotel_room_gallery_details.findMany({
      where: { tbo_hotel_code: normalized, status: 1, deleted: 0 },
      orderBy: [{ room_ref_code: 'asc' }, { tbo_hotel_room_gallery_details_id: 'asc' }],
    });
    return rows.map((row) => this.toRoomImage(row));
  }

  private async assertMasterExists(code: string) {
    const hotel = await this.prisma.tbo_hotel_master.findUnique({ where: { tbo_hotel_code: code }, select: { tbo_hotel_code: true } });
    if (!hotel) throw new NotFoundException('TBO master hotel not found');
  }

  private validateFiles(files: Express.Multer.File[]) {
    if (!files?.length) throw new BadRequestException('At least one image is required');
    if (files.length > 12) throw new BadRequestException('A maximum of 12 images may be uploaded at once');
    for (const file of files) {
      if (!ALLOWED_MIME_TYPES.has(file.mimetype)) throw new BadRequestException('Only JPEG, PNG, and WebP images are allowed');
      if (!file.buffer || file.size > 10 * 1024 * 1024) throw new BadRequestException('Each image must be 10 MB or smaller');
    }
  }

  async upload(code: string, files: Express.Multer.File[], createdBy = 0) {
    const normalized = this.normalizeCode(code);
    await this.assertMasterExists(normalized);
    this.validateFiles(files);
    const directory = this.hotelUploadRoot(normalized);
    await fs.mkdir(directory, { recursive: true });
    const writtenFiles: string[] = [];
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.tbo_hotel_gallery_details.findMany({
          where: { tbo_hotel_code: normalized, status: 1, deleted: 0 },
          select: { is_primary: true, sort_order: true },
          orderBy: { sort_order: 'desc' },
        });
        let nextSort = Number(existing[0]?.sort_order || 0) + 1;
        let hasPrimary = existing.some((row) => Number(row.is_primary) === 1);
        const created: any[] = [];
        for (const file of files) {
          const extension = ALLOWED_MIME_TYPES.get(file.mimetype)!;
          const fileName = `tbo-${normalized}-${randomUUID()}${extension}`;
          const target = path.join(directory, fileName);
          await fs.writeFile(target, file.buffer);
          writtenFiles.push(target);
          const row = await tx.tbo_hotel_gallery_details.create({
            data: {
              tbo_hotel_code: normalized,
              tbo_hotel_gallery_name: fileName,
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

  async setPrimary(code: string, imageId: number) {
    const normalized = this.normalizeCode(code);
    const image = await this.prisma.tbo_hotel_gallery_details.findFirst({
      where: { tbo_hotel_gallery_details_id: Number(imageId), tbo_hotel_code: normalized, status: 1, deleted: 0 },
    });
    if (!image) throw new NotFoundException('TBO gallery image not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.tbo_hotel_gallery_details.updateMany({ where: { tbo_hotel_code: normalized, status: 1, deleted: 0 }, data: { is_primary: 0 } });
      await tx.tbo_hotel_gallery_details.update({ where: { tbo_hotel_gallery_details_id: Number(imageId) }, data: { is_primary: 1 } });
    });
    return this.getHotelImages(normalized);
  }

  async remove(code: string, imageId: number) {
    const normalized = this.normalizeCode(code);
    const image = await this.prisma.tbo_hotel_gallery_details.findFirst({
      where: { tbo_hotel_gallery_details_id: Number(imageId), tbo_hotel_code: normalized, status: 1, deleted: 0 },
    });
    if (!image) throw new NotFoundException('TBO gallery image not found');
    const wasPrimary = Number(image.is_primary) === 1;
    await this.prisma.$transaction(async (tx) => {
      await tx.tbo_hotel_gallery_details.update({ where: { tbo_hotel_gallery_details_id: Number(imageId) }, data: { status: 0, deleted: 1, is_primary: 0 } });
      if (wasPrimary) {
        const next = await tx.tbo_hotel_gallery_details.findFirst({ where: { tbo_hotel_code: normalized, status: 1, deleted: 0 }, orderBy: [{ sort_order: 'asc' }, { tbo_hotel_gallery_details_id: 'asc' }] });
        if (next) await tx.tbo_hotel_gallery_details.update({ where: { tbo_hotel_gallery_details_id: next.tbo_hotel_gallery_details_id }, data: { is_primary: 1 } });
      }
    });
    await fs.unlink(path.join(this.hotelUploadRoot(normalized), String(image.tbo_hotel_gallery_name || ''))).catch(() => undefined);
    return this.getHotelImages(normalized);
  }

  async uploadRoomImages(code: string, roomRefCode: string, roomTitle: string, files: Express.Multer.File[], createdBy = 0) {
    const normalized = this.normalizeCode(code);
    const roomRef = String(roomRefCode || '').trim();
    if (!roomRef) throw new BadRequestException('Room reference is required');
    await this.assertMasterExists(normalized);
    this.validateFiles(files);
    const directory = this.roomUploadRoot(normalized);
    await fs.mkdir(directory, { recursive: true });
    const writtenFiles: string[] = [];
    try {
      await this.prisma.$transaction(async (tx) => {
        for (const [index, file] of files.entries()) {
          const extension = ALLOWED_MIME_TYPES.get(file.mimetype)!;
          const fileName = `room-${roomRef.replace(/[^A-Za-z0-9_-]/g, '')}-${Date.now()}-${index}-${randomUUID()}${extension}`;
          const target = path.join(directory, fileName);
          await fs.writeFile(target, file.buffer);
          writtenFiles.push(target);
          await tx.tbo_hotel_room_gallery_details.create({
            data: {
              tbo_hotel_code: normalized,
              room_ref_code: roomRef,
              room_title: String(roomTitle || roomRef).trim() || roomRef,
              room_gallery_name: fileName,
              createdby: Number(createdBy) || 0,
              createdon: new Date(),
              status: 1,
              deleted: 0,
            },
          });
        }
      });
      return this.getRoomImages(normalized);
    } catch (error) {
      await Promise.all(writtenFiles.map((file) => fs.unlink(file).catch(() => undefined)));
      throw error;
    }
  }
}
