import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';

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

export function extractTboHotelCodes(rows: unknown[]): string[] {
  return Array.from(new Set(
    (Array.isArray(rows) ? rows : [])
      .filter((row: any) => ['tbo', 'vsr'].includes(String(row?.provider || row?.hotel_provider || '').trim().toLowerCase()))
      .map((row: any) => String(
        row?.providerHotelCode || row?.provider_hotel_code || row?.hotelCode || row?.hotel_code || '',
      ).trim())
      .filter(Boolean),
  ));
}

export function extractTboImageUrls(detail: any): string[] {
  return Array.from(new Set([
    detail?.Image,
    ...(Array.isArray(detail?.Images) ? detail.Images : []),
  ].map((value) => String(value || '').trim()).filter(Boolean)));
}

@Injectable()
export class TboMasterGalleryService {
  private readonly logger = new Logger(TboMasterGalleryService.name);
  private readonly queuedBackfillCodes = new Set<string>();
  private readonly backfillBatchSize = 40;
  private readonly maxBackfillCodesPerRequest = 100;

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

  /**
   * Queue one non-blocking gallery backfill for the TBO/VSR hotels in a live
   * search response. The request path only schedules the work; all supplier
   * calls, downloads, and writes happen on a later event-loop turn.
   */
  enqueueMissingFromSearchResults(rows: unknown[]): void {
    const codes = extractTboHotelCodes(rows);
    const scheduled = codes.filter((code) => {
      if (this.queuedBackfillCodes.size >= this.maxBackfillCodesPerRequest) return false;
      if (this.queuedBackfillCodes.has(code)) return false;
      this.queuedBackfillCodes.add(code);
      return true;
    });
    if (!scheduled.length) return;

    setImmediate(() => {
      void this.backfillCodes(scheduled).catch((error) => {
        this.logger.warn(`[TBO_GALLERY_BACKFILL_FAILED] ${String(error?.message || error)}`);
        scheduled.forEach((code) => this.queuedBackfillCodes.delete(code));
      });
    });
  }

  private async backfillCodes(codes: string[]): Promise<void> {
    try {
      for (let index = 0; index < codes.length; index += this.backfillBatchSize) {
        const batch = codes.slice(index, index + this.backfillBatchSize);
        const details = await this.fetchTboHotelDetails(batch);
        for (const code of batch) {
          try {
            await this.createMissingPrimaryImage(code, details.get(code));
          } catch (error) {
            this.logger.warn(`[TBO_GALLERY_BACKFILL_HOTEL_FAILED] code=${code} ${String(error)}`);
          }
        }
      }
    } finally {
      codes.forEach((code) => this.queuedBackfillCodes.delete(code));
    }
  }

  private async fetchTboHotelDetails(codes: string[]): Promise<Map<string, any>> {
    const username = process.env.TBO_GALLERY_USERNAME || process.env.TBO_STATIC_USERNAME || 'IXMD112';
    const password = process.env.TBO_GALLERY_PASSWORD || process.env.TBO_STATIC_PASSWORD || 'api-11#M$new';
    const base = (process.env.TBO_GALLERY_API_URL || 'https://affiliate.travelboutiqueonline.com/HotelAPI').replace(/\/+$/, '');
    const response = await fetch(`${base}/HotelDetails`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ HotelCodes: codes.join(','), Language: 'EN' }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`TBO HotelDetails HTTP ${response.status}`);
    const payload = await response.json() as any;
    if (Number(payload?.Status?.Code || 0) !== 200) {
      throw new Error(`TBO HotelDetails ${payload?.Status?.Description || 'failed'}`);
    }
    return new Map(
      (Array.isArray(payload?.HotelDetails) ? payload.HotelDetails : [])
        .map((detail: any) => [String(detail?.HotelCode || '').trim(), detail])
        .filter(([code]) => Boolean(code)),
    );
  }

  private async createMissingPrimaryImage(code: string, detail: any): Promise<void> {
    const existing = await this.prisma.tbo_hotel_gallery_details.findFirst({
      where: { tbo_hotel_code: code, status: 1, deleted: 0 },
      select: { tbo_hotel_gallery_details_id: true },
    });
    if (existing) return;

    const master = await this.prisma.tbo_hotel_master.findUnique({
      where: { tbo_hotel_code: code },
      select: { tbo_hotel_code: true },
    });
    if (!master) {
      this.logger.warn(`[TBO_GALLERY_BACKFILL_MASTER_MISSING] code=${code}`);
      return;
    }

    const imageUrl = extractTboImageUrls(detail)[0];
    if (!imageUrl) {
      this.logger.debug(`[TBO_GALLERY_BACKFILL_NO_IMAGE] code=${code}`);
      return;
    }

    const image = await this.downloadImage(imageUrl);
    const directory = this.hotelUploadRoot(code);
    await fs.mkdir(directory, { recursive: true });
    const fileName = `auto-${code}-${image.hash}${image.extension}`;
    const target = path.join(directory, fileName);
    const temporary = `${target}.part`;
    try {
      await fs.writeFile(temporary, image.buffer);
      await fs.rename(temporary, target);
      const active = await this.prisma.tbo_hotel_gallery_details.findFirst({
        where: { tbo_hotel_code: code, status: 1, deleted: 0 },
        select: { tbo_hotel_gallery_details_id: true },
      });
      if (active) {
        await fs.rm(target, { force: true });
        return;
      }
      await this.prisma.tbo_hotel_gallery_details.create({
        data: {
          tbo_hotel_code: code,
          tbo_hotel_gallery_name: fileName,
          is_primary: 1,
          sort_order: 1,
          source: 'tbo-hotel-details-auto',
          source_url: imageUrl,
          createdby: 0,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });
      this.logger.log(`[TBO_GALLERY_BACKFILL_CREATED] code=${code} file=${fileName}`);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      await fs.rm(target, { force: true });
      throw error;
    }
  }

  private async downloadImage(url: string): Promise<{ buffer: Buffer; extension: string; hash: string }> {
    const requestUrl = String(url).replace(/([?&]img=)([^&]*)/i, (_match, prefix, value) => `${prefix}${encodeURIComponent(decodeURIComponent(value).replace(/ /g, '+'))}`);
    const isTboImage = /(?:^|\.)tboholidays\.com$/i.test(new URL(requestUrl).hostname);
    const response = await fetch(requestUrl, {
      headers: {
        'user-agent': 'DVI-Travel-HotelGalleryBackfill/1.0',
        ...(isTboImage ? { referer: 'https://www.tboholidays.com/' } : {}),
      },
      signal: AbortSignal.timeout(20_000),
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`Image HTTP ${response.status}`);
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    const extension = contentType === 'image/png'
      ? '.png'
      : contentType === 'image/webp'
        ? '.webp'
        : contentType === 'image/jpeg' || contentType === 'image/jpg'
          ? '.jpg'
          : '';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!extension || buffer.length < 1024 || buffer.length > 10 * 1024 * 1024) {
      throw new Error(`Unsupported or invalid image (${contentType || 'unknown'}, ${buffer.length} bytes)`);
    }
    return { buffer, extension, hash: createHash('sha256').update(buffer).digest('hex').slice(0, 12) };
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
