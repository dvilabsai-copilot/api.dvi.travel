import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { CreateGstSettingDto } from './dto/create-gst-setting.dto';
import { UpdateGstSettingDto } from './dto/update-gst-setting.dto';
import { GstSettingDto } from './dto/gst-setting.dto';

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toBoolStatus(v: any): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') return v === '1' || v.toLowerCase() === 'true';
  return false;
}

/** Convert dto.status (boolean/0|1/"true"/"false") into DB 0|1 */
function toDb01(v: any): 0 | 1 | undefined {
  if (v === undefined || v === null) return undefined;

  if (typeof v === 'boolean') return v ? 1 : 0;

  if (typeof v === 'number') return v === 1 ? 1 : 0;

  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === '1' || s === 'true') return 1;
    if (s === '0' || s === 'false') return 0;
 // fallback: try number
    const n = Number(s);
    if (Number.isFinite(n)) return n === 1 ? 1 : 0;
  }

  return undefined;
}

@Injectable()
export class GstSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  private mapRow(row: any): GstSettingDto {
    return {
      id: row.gst_setting_id,
      gstTitle: row.gst_title ?? '',
      gst: num(row.gst_value),
      cgst: num(row.cgst_value),
      sgst: num(row.sgst_value),
      igst: num(row.igst_value),
      status: toBoolStatus(row.status),
    };
  }

  async list(): Promise<{ data: GstSettingDto[] }> {
    const rows = await this.prisma.dvi_gst_setting.findMany({
      where: { deleted: 0 },
      orderBy: { gst_setting_id: 'desc' },
      select: {
        gst_setting_id: true,
        gst_title: true,
        gst_value: true,
        cgst_value: true,
        sgst_value: true,
        igst_value: true,
        status: true,
      },
    });

    return { data: rows.map((r) => this.mapRow(r)) };
  }

  async getOne(id: number): Promise<{ data: GstSettingDto }> {
    const row = await this.prisma.dvi_gst_setting.findFirst({
      where: { gst_setting_id: id, deleted: 0 },
      select: {
        gst_setting_id: true,
        gst_title: true,
        gst_value: true,
        cgst_value: true,
        sgst_value: true,
        igst_value: true,
        status: true,
      },
    });

    if (!row) throw new NotFoundException('GST setting not found');
    return { data: this.mapRow(row) };
  }

 /**
   * PHP parity:
   * - inserts into dvi_gst_setting
   * - stores gst/cgst/sgst/igst as strings
   * - sets status = 1 always
 */
  async create(dto: CreateGstSettingDto, loggedUserId = 0): Promise<{ data: GstSettingDto }> {
    const gstTitle = (dto.gstTitle ?? '').trim();
    if (!gstTitle) throw new BadRequestException('gstTitle required');

    const created = await this.prisma.dvi_gst_setting.create({
      data: {
        gst_title: gstTitle,
        gst_value: String(dto.gst ?? 0),
        cgst_value: String(dto.cgst ?? 0),
        sgst_value: String(dto.sgst ?? 0),
        igst_value: String(dto.igst ?? 0),
        createdby: loggedUserId || 0,
 status: 1, // PHP forces active on create
        deleted: 0,
      },
      select: {
        gst_setting_id: true,
        gst_title: true,
        gst_value: true,
        cgst_value: true,
        sgst_value: true,
        igst_value: true,
        status: true,
      },
    });

    return { data: this.mapRow(created) };
  }

 /**
   * ✅ FIXED UPDATE:
   * - DO NOT force status=1
   * - If dto.status provided, persist it
   * - Otherwise keep existing status unchanged
 */
  async update(
    id: number,
    dto: UpdateGstSettingDto,
    loggedUserId = 0,
  ): Promise<{ data: GstSettingDto }> {
    const existing = await this.prisma.dvi_gst_setting.findFirst({
      where: { gst_setting_id: id, deleted: 0 },
      select: { gst_setting_id: true, status: true },
    });
    if (!existing) throw new NotFoundException('GST setting not found');

    const data: any = {
      createdby: loggedUserId || 0,
 // status is NOT forced anymore
    };

    if (dto.gstTitle !== undefined) data.gst_title = dto.gstTitle.trim();
    if (dto.gst !== undefined) data.gst_value = String(dto.gst);
    if (dto.cgst !== undefined) data.cgst_value = String(dto.cgst);
    if (dto.sgst !== undefined) data.sgst_value = String(dto.sgst);
    if (dto.igst !== undefined) data.igst_value = String(dto.igst);

 // apply status only if provided
    const nextStatus = toDb01((dto as any).status);
    if (nextStatus !== undefined) {
      data.status = nextStatus;
    }

    const updated = await this.prisma.dvi_gst_setting.update({
      where: { gst_setting_id: id },
      data,
      select: {
        gst_setting_id: true,
        gst_title: true,
        gst_value: true,
        cgst_value: true,
        sgst_value: true,
        igst_value: true,
        status: true,
      },
    });

    return { data: this.mapRow(updated) };
  }

 /**
   * PHP parity delete protection:
   * Block delete if any dvi_hotel_rooms row has gst_percentage == "<GST_ID>" and deleted=0
   * Note: gst_percentage is String? in your schema, so compare as String(id).
 */
  private async assertCanDeleteOrThrow(id: number) {
    const usedCount = await this.prisma.dvi_hotel_rooms.count({
      where: { deleted: 0, gst_percentage: String(id) },
    });

    if (usedCount > 0) {
      throw new ConflictException('GST setting already used in hotel rooms');
    }
  }

 /**
   * PHP parity soft delete:
   * deleted=1 and updatedon=NOW()
 */
  async remove(id: number): Promise<void> {
    const existing = await this.prisma.dvi_gst_setting.findFirst({
      where: { gst_setting_id: id, deleted: 0 },
      select: { gst_setting_id: true },
    });
    if (!existing) throw new NotFoundException('GST setting not found');

    await this.assertCanDeleteOrThrow(id);

    await this.prisma.dvi_gst_setting.update({
      where: { gst_setting_id: id },
      data: { deleted: 1, updatedon: new Date() },
    });
  }

 /**
   * Optional helper endpoint (not required by your frontend service):
   * toggle status 0/1
 */
  async toggleStatus(id: number): Promise<{ data: GstSettingDto }> {
    const row = await this.prisma.dvi_gst_setting.findFirst({
      where: { gst_setting_id: id, deleted: 0 },
      select: {
        gst_setting_id: true,
        gst_title: true,
        gst_value: true,
        cgst_value: true,
        sgst_value: true,
        igst_value: true,
        status: true,
      },
    });
    if (!row) throw new NotFoundException('GST setting not found');

    const newStatus = row.status === 1 ? 0 : 1;

    const updated = await this.prisma.dvi_gst_setting.update({
      where: { gst_setting_id: id },
      data: { status: newStatus },
      select: {
        gst_setting_id: true,
        gst_title: true,
        gst_value: true,
        cgst_value: true,
        sgst_value: true,
        igst_value: true,
        status: true,
      },
    });

    return { data: this.mapRow(updated) };
  }
}
