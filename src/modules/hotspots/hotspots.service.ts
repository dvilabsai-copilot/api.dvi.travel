// FILE: src/modules/hotspots/hotspots.service.ts

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, dvi_hotspot_place } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { HotspotListQueryDto } from './dto/hotspot-list.query.dto';
import { HotspotListResponseDto, HotspotListRow } from './dto/hotspot-list.response.dto';

import { HotspotCreateDto } from './dto/hotspot-create.dto';
import { HotspotUpdateDto } from './dto/hotspot-update.dto';

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as crypto from 'crypto';

const DEFAULT_PAGE = 1;
const DEFAULT_SIZE = 5000;

// ----------------------------- helpers --------------------------------
function currencySymbol(): string {
  return process.env.CURRENCY_SYMBOL || '₹';
}
function baseUrl(): string | undefined {
  return process.env.BASE_URL || undefined;
}
function resolveBackendRoot(): string {
  const candidate = path.resolve(__dirname, '..', '..', '..', '..');
  return fs.existsSync(path.join(candidate, 'package.json')) ? candidate : process.cwd();
}
function hotspotImageExists(name?: string | null): boolean {
  const fileName = String(name || '').trim();
  if (!fileName) return false;
  const apiPath = path.join(resolveBackendRoot(), 'public', 'uploads', 'hotspot_gallery', fileName);
  // Keep a legacy fallback to avoid breaking previews if older files were stored under workspace root.
  const legacyPath = path.join(process.cwd(), 'public', 'uploads', 'hotspot_gallery', fileName);
  return fs.existsSync(apiPath) || fs.existsSync(legacyPath);
}
function buildImageUrl(name?: string | null): string {
  if (!name || !hotspotImageExists(name)) return '';
  const relative = `/uploads/hotspot_gallery/${name}`;
  const base = baseUrl();
  return base ? `${base.replace(/\/$/, '')}${relative}` : relative;
}
function htmlImg(url: string, alt?: string | null): string {
  if (!url) return '';
  const safeAlt = (alt ?? '').toString();
  return `<img src="${url}" alt="${safeAlt}" style="height:60px;width:auto;border-radius:6px;object-fit:cover;" />`;
}
function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
}
function toBig(v: unknown): bigint {
  try {
    return BigInt((v as any) ?? 0);
  } catch {
    return BigInt(0);
  }
}
function fmtMoney(n?: number | null): string {
  if (n == null) return '0';
  const num = toNumber(n);
  return num.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
function locationsHtml(loc?: string | null): string {
  if (!loc) return '';
  return String(loc)
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('<br>');
}
function membersHtml(
  _prefix: string,
  adult?: number | null,
  child?: number | null,
  infant?: number | null,
): string {
  const sym = currencySymbol();
  const lines: string[] = [];
  lines.push(`Adult-${sym}${fmtMoney(adult)}`);
  lines.push(`Children-${sym}${fmtMoney(child)}`);
  lines.push(`Infants-${sym}${fmtMoney(infant)}`);
  return lines.join('<br>');
}
function normalizeLocationArrayToPipe(arr?: string[] | null): string {
  if (!arr || !Array.isArray(arr)) return '';
  return arr.map((s) => String(s ?? '').trim()).filter(Boolean).join('|');
}
function splitPipeToArray(pipe?: string | null): string[] {
  if (!pipe) return [];
  return String(pipe)
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}
function trimStr(v: any) {
  return (v ?? '').toString().trim();
}

// ---------- Time & weekday helpers (DB: 0=Mon … 6=Sun) ----------
const DAY_NAME_TO_INT: Record<string, number> = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};
const INT_TO_DAY_NAME: Record<number, string> = {
  0: 'monday',
  1: 'tuesday',
  2: 'wednesday',
  3: 'thursday',
  4: 'friday',
  5: 'saturday',
  6: 'sunday',
};

function pad2(n: number) {
  return n.toString().padStart(2, '0');
}
// Prisma returns @db.Time as Date normalized to UTC. Use UTC getters to avoid TZ shift.
function timeToHHmmUTC(d?: Date | null): string {
  if (!d || !(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
// When saving, create a UTC date so DB gets the exact time with no offset bleed.
function hhmmToUTCDate(hhmm?: string | null): Date | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return new Date(Date.UTC(1970, 0, 1, h, mi, 0, 0));
}

// Weekday ordering (Mon..Sun)
const WEEKDAY_ORDER = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];
function getDayStringLoose(row: any): string {
  return (
    row?.day_key ??
    row?.day_of_week ??
    row?.day ??
    row?.dayname ??
    row?.weekday ??
    row?.day_name ??
    ''
  )
    .toString()
    .toLowerCase();
}

// ---------------- CSV helpers (robust quoted parsing) ----------------
function csvUnquote(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1).replace(/""/g, '"');
  }
  return s.trim();
}
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === ',') {
        out.push(cur);
        cur = '';
      } else if (ch === '"') {
        inQ = true;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out;
}

// ----------------------------- local shapes ----------------------------
export type HotspotOperatingSlotDto = { id?: number | bigint; start: string; end: string };
export type HotspotOperatingDayDto = { open24hrs?: boolean; closed24hrs?: boolean; slots: HotspotOperatingSlotDto[] };
export type HotspotParkingChargeDto = { id?: number | bigint; vehicleTypeId: number; charge: number };
export type HotspotGalleryItemDto = { id?: number | bigint; name: string; delete?: boolean };

// accept either create or update payload
export type HotspotFormSaveDto = HotspotCreateDto | HotspotUpdateDto;

// ------------------------------- service --------------------------------
@Injectable()
export class HotspotsService {
  constructor(private readonly prisma: PrismaService) {}

  // --------------------------- List ------------------------------
  async list(q: HotspotListQueryDto): Promise<HotspotListResponseDto> {
    const page = q.page ?? DEFAULT_PAGE;
    const size = q.size ?? DEFAULT_SIZE;
    const skip = (page - 1) * size;
    const take = size;

    const where: Prisma.dvi_hotspot_placeWhereInput = {
      deleted: 0,
      status: 1,
    };

    if (q.q && q.q.trim()) {
      const text = q.q.trim();
      where.OR = [
        { hotspot_name: { contains: text } as any },
        { hotspot_address: { contains: text } as any },
        { hotspot_landmark: { contains: text } as any },
        { hotspot_location: { contains: text } as any },
      ];
    }

    const rows = await this.prisma.dvi_hotspot_place.findMany({
      where,
      orderBy: [{ hotspot_priority: 'asc' }, { hotspot_name: 'asc' }],
      skip,
      take,
      select: {
        hotspot_ID: true,
        hotspot_name: true,
        hotspot_priority: true,
        hotspot_location: true,
        hotspot_adult_entry_cost: true,
        hotspot_child_entry_cost: true,
        hotspot_infant_entry_cost: true,
        hotspot_foreign_adult_entry_cost: true,
        hotspot_foreign_child_entry_cost: true,
        hotspot_foreign_infant_entry_cost: true,
      },
    });

    const ids = rows.map((r) => r.hotspot_ID);
    const galleries = ids.length
      ? await this.prisma.dvi_hotspot_gallery_details.findMany({
          where: { hotspot_ID: { in: ids } as any, deleted: 0 as any, status: 1 as any },
          orderBy: [{ hotspot_gallery_details_id: 'asc' }],
          select: {
            hotspot_gallery_details_id: true,
            hotspot_gallery_name: true,
            hotspot_ID: true,
          },
        })
      : [];

    const firstImageByHotspot = new Map<number, string>();
    for (const g of galleries) {
      const hotspotId = g.hotspot_ID as unknown as number;
      const fileName = (g.hotspot_gallery_name ?? '').toString();
      if (!firstImageByHotspot.has(hotspotId) && hotspotImageExists(fileName)) {
        firstImageByHotspot.set(hotspotId, fileName);
      }
    }

    const data: HotspotListRow[] = rows.map((r, idx) => {
      const imgName = firstImageByHotspot.get(r.hotspot_ID as unknown as number) || '';
      const url = buildImageUrl(imgName);
      const name = r.hotspot_name ?? '';
      return {
        counter: skip + idx + 1,
        modify: r.hotspot_ID,
        hotspot_photo_url: htmlImg(url, name),
        hotspot_name: name,
        hotspot_priority: r.hotspot_priority ?? 0,
        hotspot_locations: locationsHtml(r.hotspot_location ?? ''),
        local_members: membersHtml(
          'Local',
          toNumber(r.hotspot_adult_entry_cost),
          toNumber(r.hotspot_child_entry_cost),
          toNumber(r.hotspot_infant_entry_cost),
        ),
        foreign_members: membersHtml(
          'Foreign',
          toNumber(r.hotspot_foreign_adult_entry_cost),
          toNumber(r.hotspot_foreign_child_entry_cost),
          toNumber(r.hotspot_foreign_infant_entry_cost),
        ),
      };
    });

    return { data };
  }

  // --------------------- Dynamic dropdowns / options ------------------------
  async formOptions() {
    const [typesRaw, locationsRaw, vehicleTypesRaw] = await Promise.all([
      this.prisma.dvi_hotspot_place.findMany({
        where: { deleted: 0 },
        select: { hotspot_type: true },
        distinct: ['hotspot_type'],
        orderBy: { hotspot_type: 'asc' },
      }),
      this.prisma.dvi_hotspot_place.findMany({
        where: { deleted: 0, hotspot_location: { not: null } },
        select: { hotspot_location: true },
      }),
      this.prisma.dvi_vehicle_type.findMany({
        where: { deleted: 0, status: 1 },
        orderBy: { vehicle_type_id: 'asc' },
        select: { vehicle_type_id: true, vehicle_type_title: true },
      }),
    ]);

    const hotspotTypes = Array.from(
      new Set(
        typesRaw
          .map((r) => (r.hotspot_type ?? '').toString().trim())
          .filter(Boolean),
      ),
    ).sort((a, b) => a.localeCompare(b));

    const locSet = new Set<string>();
    for (const r of locationsRaw) {
      splitPipeToArray(r.hotspot_location).forEach((x) => {
        const s = (x ?? '').toString().trim();
        if (s) locSet.add(s);
      });
    }
    const locations = Array.from(locSet).sort((a, b) => a.localeCompare(b));

    const vehicleTypes = vehicleTypesRaw.map((v) => ({
      id: Number(v.vehicle_type_id),
      name: v.vehicle_type_title ?? '',
    }));

    return {
  hotspotTypes,
  locations,
  toLocations: locations,
  vehicleTypes,
};
  }

  // --------------------------- Form: Get (edit) -----------------------------
  async getForm(id: number) {
    const hotspot = await this.prisma.dvi_hotspot_place.findUnique({
      where: { hotspot_ID: id },
    });
    if (!hotspot || hotspot.deleted === 1) {
      throw new NotFoundException('Hotspot not found');
    }

    const [gallery, timingsRaw, parking, options] = await Promise.all([
      this.prisma.dvi_hotspot_gallery_details.findMany({
        where: { hotspot_ID: id as any, status: 1 as any, deleted: 0 as any },
        orderBy: { hotspot_gallery_details_id: 'asc' },
      }),
      this.prisma.dvi_hotspot_timing.findMany({
        where: {
          AND: [
            { hotspot_ID: id as any },
            { status: 1 as any },
            { deleted: 0 as any },
          ] as any,
        },
        orderBy: [
          { hotspot_timing_day: 'asc' },
          { hotspot_start_time: 'asc' },
          { hotspot_timing_ID: 'asc' },
        ],
      }),
      this.prisma.dvi_hotspot_vehicle_parking_charges.findMany({
        where: {
          AND: [
            { hotspot_id: id as any },
            { status: 1 as any },
            { deleted: 0 as any },
          ] as any,
        },
        orderBy: { vehicle_parking_charge_ID: 'asc' },
      }),
      this.formOptions(),
    ]);

    // Build operatingHours map: day-name keys with slots (UTC-safe times)
    const operatingHours: Record<string, HotspotOperatingDayDto> = {};
    for (const t of timingsRaw as any[]) {
      const dayInt: number = Number(t.hotspot_timing_day ?? -1);
      const dayKey = INT_TO_DAY_NAME[dayInt] ?? '';
      if (!dayKey) continue;

      if (!operatingHours[dayKey]) {
        operatingHours[dayKey] = {
          open24hrs: Number(t.hotspot_open_all_time ?? 0) === 1,
          closed24hrs: Number(t.hotspot_closed ?? 0) === 1,
          slots: [],
        };
      }

      const start = timeToHHmmUTC(t.hotspot_start_time);
      const end = timeToHHmmUTC(t.hotspot_end_time);
      if (start && end) {
        operatingHours[dayKey].slots.push({
          id: t.hotspot_timing_ID,
          start,
          end,
        });
      }

      operatingHours[dayKey].open24hrs =
        operatingHours[dayKey].open24hrs || Number(t.hotspot_open_all_time ?? 0) === 1;
      operatingHours[dayKey].closed24hrs =
        operatingHours[dayKey].closed24hrs || Number(t.hotspot_closed ?? 0) === 1;
    }

    const payload = {
      id: hotspot.hotspot_ID,
      hotspot_name: hotspot.hotspot_name ?? '',
      hotspot_type: (hotspot as any).hotspot_type ?? null,
      hotspot_rating: (hotspot as any).hotspot_rating ?? null,
      hotspot_priority: hotspot.hotspot_priority ?? null,
      hotspot_latitude: (hotspot as any).hotspot_latitude ?? null,
      hotspot_longitude: (hotspot as any).hotspot_longitude ?? null,
      hotspot_address: (hotspot as any).hotspot_address ?? null,
      hotspot_landmark: (hotspot as any).hotspot_landmark ?? null,
      hotspot_description: (hotspot as any).hotspot_description ?? null,
      hotspot_video_url: (hotspot as any).hotspot_video_url ?? null,
      hotspot_duration: timeToHHmmUTC((hotspot as any).hotspot_duration) || null,
      status: hotspot.status ?? 1,
      deleted: hotspot.deleted ?? 0,

      hotspot_adult_entry_cost: (hotspot as any).hotspot_adult_entry_cost ?? null,
      hotspot_child_entry_cost: (hotspot as any).hotspot_child_entry_cost ?? null,
      hotspot_infant_entry_cost: (hotspot as any).hotspot_infant_entry_cost ?? null,
      hotspot_foreign_adult_entry_cost: (hotspot as any).hotspot_foreign_adult_entry_cost ?? null,
      hotspot_foreign_child_entry_cost: (hotspot as any).hotspot_foreign_child_entry_cost ?? null,
      hotspot_foreign_infant_entry_cost: (hotspot as any).hotspot_foreign_infant_entry_cost ?? null,

      hotspot_location_list: splitPipeToArray(hotspot.hotspot_location),

      parkingCharges: (parking as any[]).map((p) => ({
        id: p.vehicle_parking_charge_ID,
        vehicleTypeId: p.vehicle_type_id ?? p.vehicleTypeId ?? p.vehicle_type_ID,
        charge: Number(p.parking_charge ?? p.charge ?? 0),
      })),

      operatingHours,

      gallery: (gallery as any[])
        .filter((g) => hotspotImageExists(g.hotspot_gallery_name))
        .map((g) => ({
          id: g.hotspot_gallery_details_id,
          name: g.hotspot_gallery_name,
        })),
    };

    return { payload, options };
  }

  // -------------------------- Form: Save (add/update) -----------------------
  async saveForm(input: HotspotFormSaveDto) {
    if (!input.hotspot_name?.trim()) {
      throw new BadRequestException('hotspot_name is required');
    }

    const masterData: Prisma.dvi_hotspot_placeUncheckedCreateInput = {
      hotspot_name: input.hotspot_name.trim(),
      hotspot_type: input.hotspot_type ?? null,
      hotspot_rating: toNumber((input as any).hotspot_rating),
      hotspot_priority: toNumber((input as any).hotspot_priority),
      hotspot_latitude: (input as any).hotspot_latitude ?? null,
      hotspot_longitude: (input as any).hotspot_longitude ?? null,
      hotspot_address: (input as any).hotspot_address ?? null,
      hotspot_landmark: (input as any).hotspot_landmark ?? null,
      hotspot_description: (input as any).hotspot_description ?? null,
      hotspot_video_url: (input as any).hotspot_video_url ?? null,
      hotspot_duration: hhmmToUTCDate((input as any).hotspot_duration) as any,

      hotspot_location: normalizeLocationArrayToPipe((input as any).hotspot_location_list),

      hotspot_adult_entry_cost: toNumber((input as any).hotspot_adult_entry_cost),
      hotspot_child_entry_cost: toNumber((input as any).hotspot_child_entry_cost),
      hotspot_infant_entry_cost: toNumber((input as any).hotspot_infant_entry_cost),
      hotspot_foreign_adult_entry_cost: (input as any).hotspot_foreign_adult_entry_cost ?? 0,
      hotspot_foreign_child_entry_cost: (input as any).hotspot_foreign_child_entry_cost ?? 0,
      hotspot_foreign_infant_entry_cost: (input as any).hotspot_foreign_infant_entry_cost ?? 0,

      status: (input as any).status ?? 1,
      deleted: (input as any).deleted ?? 0,
    } as any;

    const createdOrUpdated = await this.prisma.$transaction(async (tx) => {
      let hotspot: dvi_hotspot_place;

      if ((input as any).id && (input as any).id > 0) {
        hotspot = await tx.dvi_hotspot_place.update({
          where: { hotspot_ID: (input as any).id },
          data: masterData as any,
        });
      } else {
        hotspot = await tx.dvi_hotspot_place.create({
          data: masterData as any,
        });
      }

      const hotspotIdNumber = hotspot.hotspot_ID as unknown as number;
      const hotspotIdBig = toBig(hotspotIdNumber);

      // --------------------- Parking Charges upsert ----------------------
      const incomingParking = ((input as any).parkingCharges ?? []) as HotspotParkingChargeDto[];
      const keptParkingIds = new Set<bigint>();

      for (const row of incomingParking) {
        const vehicleTypeId = Number(row.vehicleTypeId);
        const charge = toNumber(row.charge);
        if (!vehicleTypeId || charge < 0) continue;

        if (row.id != null) {
          await tx.dvi_hotspot_vehicle_parking_charges.update({
            where: { vehicle_parking_charge_ID: toBig(row.id) },
            data: {
              hotspot_id: hotspotIdBig as any,
              vehicle_type_id: vehicleTypeId as any,
              parking_charge: charge as any,
            } as any,
          });
          keptParkingIds.add(toBig(row.id));
        } else {
          const created = await tx.dvi_hotspot_vehicle_parking_charges.create({
            data: {
              hotspot_id: hotspotIdBig as any,
              vehicle_type_id: vehicleTypeId as any,
              parking_charge: charge as any,
              status: 1 as any,
              deleted: 0 as any,
            } as any,
          });
          keptParkingIds.add(created.vehicle_parking_charge_ID as unknown as bigint);
        }
      }

      const allExistingParking = await tx.dvi_hotspot_vehicle_parking_charges.findMany({
        where: { hotspot_id: hotspotIdBig as any },
        select: { vehicle_parking_charge_ID: true },
      });
      for (const p of allExistingParking) {
        const pid = p.vehicle_parking_charge_ID as unknown as bigint;
        if (!keptParkingIds.has(pid)) {
          await tx.dvi_hotspot_vehicle_parking_charges.delete({
            where: { vehicle_parking_charge_ID: pid },
          });
        }
      }

      // --------------------- Operating Hours upsert ----------------------
      const incomingOH = ((input as any).operatingHours ?? {}) as Record<string, HotspotOperatingDayDto>;
      const keepTimingIds = new Set<number | bigint>();

      for (const [dayKeyRaw, def] of Object.entries(incomingOH)) {
        const dayKey = dayKeyRaw.toLowerCase().trim();
        const dayInt = DAY_NAME_TO_INT[dayKey] ?? -1;
        if (dayInt < 0) continue;

        const open24 = !!def.open24hrs;
        const closed = !!def.closed24hrs;
        const rawSlots = Array.isArray(def.slots) ? def.slots : [];
        // Persist a day row even when there are no explicit slots for open-24/closed-24.
        const slots =
          (open24 || closed) && rawSlots.length === 0
            ? [{ start: '00:00', end: '23:59' }]
            : rawSlots;

        for (const s of slots) {
          const start = hhmmToUTCDate(s.start);
          const end = hhmmToUTCDate(s.end);
          if (!start || !end) continue;

          if (s.id != null) {
            await tx.dvi_hotspot_timing.update({
              where: { hotspot_timing_ID: s.id as any },
              data: {
                hotspot_ID: hotspotIdNumber as any,
                hotspot_timing_day: dayInt as any,
                hotspot_start_time: start as any,
                hotspot_end_time: end as any,
                hotspot_open_all_time: (open24 ? 1 : 0) as any,
                hotspot_closed: (closed ? 1 : 0) as any,
              } as any,
            });
            keepTimingIds.add(s.id as any);
          } else {
            const created = await tx.dvi_hotspot_timing.create({
              data: {
                hotspot_ID: hotspotIdNumber as any,
                hotspot_timing_day: dayInt as any,
                hotspot_start_time: start as any,
                hotspot_end_time: end as any,
                hotspot_open_all_time: (open24 ? 1 : 0) as any,
                hotspot_closed: (closed ? 1 : 0) as any,
                status: 1 as any,
                deleted: 0 as any,
              } as any,
            });
            keepTimingIds.add((created as any).hotspot_timing_ID);
          }
        }
      }

      const existingTimings = await tx.dvi_hotspot_timing.findMany({
        where: { hotspot_ID: hotspotIdNumber as any },
        select: { hotspot_timing_ID: true },
      });
      for (const t of existingTimings) {
        const tid = (t as any).hotspot_timing_ID as number | bigint;
        if (!keepTimingIds.has(tid)) {
          await tx.dvi_hotspot_timing.delete({
            where: { hotspot_timing_ID: tid as any },
          });
        }
      }

      // --------------------- Gallery upsert (by filenames) ---------------
      const incomingGallery = ((input as any).gallery ?? []) as HotspotGalleryItemDto[];
      const keepGalleryIds = new Set<number | bigint>();

      for (const g of incomingGallery) {
        if (g.id != null && g.delete) {
          await tx.dvi_hotspot_gallery_details.delete({
            where: { hotspot_gallery_details_id: g.id as any },
          });
          continue;
        }
        if (g.id != null) {
          await tx.dvi_hotspot_gallery_details.update({
            where: { hotspot_gallery_details_id: g.id as any },
            data: {
              hotspot_ID: hotspotIdNumber as any,
              hotspot_gallery_name: g.name,
            } as any,
          });
          keepGalleryIds.add(g.id as any);
        } else {
          const created = await tx.dvi_hotspot_gallery_details.create({
            data: {
              hotspot_ID: hotspotIdNumber as any,
              hotspot_gallery_name: g.name,
              status: 1 as any,
              deleted: 0 as any,
            } as any,
          });
          keepGalleryIds.add((created as any).hotspot_gallery_details_id);
        }
      }

      const existingGallery = await tx.dvi_hotspot_gallery_details.findMany({
        where: { hotspot_ID: hotspotIdNumber as any },
        select: { hotspot_gallery_details_id: true },
      });
      for (const g of existingGallery) {
        const gid = (g as any).hotspot_gallery_details_id as number | bigint;
        if (!keepGalleryIds.has(gid)) {
          await tx.dvi_hotspot_gallery_details.delete({
            where: { hotspot_gallery_details_id: gid as any },
          });
        }
      }

      return hotspot;
    });

    return { id: createdOrUpdated.hotspot_ID };
  }

  // ---------------------- Create gallery row (upload helper) ----------------
  async createGalleryRow(hotspotId: number, filename: string) {
    const hp = await this.prisma.dvi_hotspot_place.findUnique({
      where: { hotspot_ID: hotspotId },
      select: { hotspot_ID: true },
    });
    if (!hp) throw new NotFoundException('Hotspot not found');

    return this.prisma.dvi_hotspot_gallery_details.create({
      data: {
        hotspot_ID: hotspotId as any,
        hotspot_gallery_name: filename,
        status: 1 as any,
        deleted: 0 as any,
      } as any,
    });
  }

  // --------------------------- Inline priority ------------------------------
  async updatePriority(id: number, priority: number): Promise<{ ok: true }> {
    if (!Number.isFinite(id) || id <= 0) {
      throw new BadRequestException('Invalid hotspot id');
    }
    if (!Number.isFinite(priority) || priority < 0) {
      throw new BadRequestException('Invalid priority');
    }

    const exists = await this.prisma.dvi_hotspot_place.findUnique({
      where: { hotspot_ID: id },
      select: { hotspot_ID: true },
    });
    if (!exists) throw new NotFoundException('Hotspot not found');

    await this.prisma.dvi_hotspot_place.update({
      where: { hotspot_ID: id },
      data: { hotspot_priority: priority },
    });

    return { ok: true };
  }

  // --------------------------- Soft delete ----------------------------------
  async softDelete(id: number): Promise<{ ok: true }> {
    const exists = await this.prisma.dvi_hotspot_place.findUnique({
      where: { hotspot_ID: id },
      select: { hotspot_ID: true },
    });
    if (!exists) throw new NotFoundException('Hotspot not found');

    await this.prisma.dvi_hotspot_place.update({
      where: { hotspot_ID: id },
      data: { deleted: 1 },
    });

    return { ok: true };
  }

  // --------------------------- Basic getOne ---------------------------------
  async getOne(id: number) {
    const row = await this.prisma.dvi_hotspot_place.findUnique({
      where: { hotspot_ID: id },
    });
    if (!row || row.deleted === 1) throw new NotFoundException('Hotspot not found');
    return row;
  }

  // ======================================================================
  // ============ NEW: Parking Charge CSV Import Flow (PHP parity) =========
  // ======================================================================

  /**
   * Step 1: Parse CSV and stage rows into dvi_tempcsv with csvtype=4, status=1.
   * CSV Columns (two supported layouts):
   *   A) hotspot_name, hotspot_location, vehicle_type_title, parking_charge
   *   B) S.NO, hotspot_name, hotspot_location, vehicle_type_title, parking_charge  ← (your React export)
   * Returns a sessionId to reference in subsequent steps.
   *
   * IMPORTANT: dvi_tempcsv.field1..field4 are STRINGS in DB. We must insert strings.
   */
  async importParkingCsv(csvFilePath: string) {
    const sessionId = crypto.randomBytes(8).toString('hex');

    // Keep values as strings (field4 numeric value stored as string)
    const rows: Array<{
      hotspot_name: string;
      hotspot_location: string;
      vehicle_type_title: string;
      parking_charge: string;
    }> = [];
    const rejectedRows: Array<{
      hotspot_name: string;
      hotspot_location: string;
      vehicle_type_title: string;
      parking_charge: string;
      reason: string;
    }> = [];

    const rl = readline.createInterface({
      input: fs.createReadStream(csvFilePath),
      crlfDelay: Infinity,
    });

    let lineNo = 0;
    let expectedLayout: '4col' | '5col-sno' | null = null;
    for await (const rawLine of rl) {
      let line = (rawLine ?? '').trim();
      if (!line) continue;
      if (line.charCodeAt(0) === 0xfeff) line = line.slice(1); // strip BOM
      lineNo++;

      const cols = parseCsvLine(line).map(csvUnquote);

      // Header validation (PHP parity + backward compatibility for 4-col format)
      if (lineNo === 1) {
        const h = cols.map((c) => c.trim().toLowerCase());
        const is4 =
          h.length >= 4 &&
          h[0] === 'hotspot_name' &&
          h[1] === 'hotspot_location' &&
          h[2] === 'vehicle_type_title' &&
          h[3] === 'parking_charge';
        const is5 =
          h.length >= 5 &&
          (h[0] === 's.no' || h[0] === 's_no' || h[0] === 'sno') &&
          h[1] === 'hotspot_name' &&
          h[2] === 'hotspot_location' &&
          h[3] === 'vehicle_type_title' &&
          h[4] === 'parking_charge';
        if (!is4 && !is5) {
          throw new BadRequestException(
            'Invalid CSV header. Expected hotspot_name,hotspot_location,vehicle_type_title,parking_charge (optionally with leading S.NO).',
          );
        }
        expectedLayout = is5 ? '5col-sno' : '4col';
        continue;
      }

      if (cols.length < 4) {
        rejectedRows.push({
          hotspot_name: '',
          hotspot_location: '',
          vehicle_type_title: '',
          parking_charge: '',
          reason: `Row ${lineNo}: insufficient columns`,
        });
        continue;
      }

      let idxName = 0, idxLoc = 1, idxType = 2, idxCharge = 3;
      if (expectedLayout === '5col-sno') {
        idxName = 1; idxLoc = 2; idxType = 3; idxCharge = 4;
      }

      const hotspot_name = (cols[idxName] ?? '').trim();
      const hotspot_location = (cols[idxLoc] ?? '').trim();
      const vehicle_type_title = (cols[idxType] ?? '').trim();
      const parking_charge = (cols[idxCharge] ?? '').trim();

      if (!hotspot_name || !hotspot_location || !vehicle_type_title || parking_charge === '') {
        const missing: string[] = [];
        if (!hotspot_name) missing.push('hotspot_name');
        if (!hotspot_location) missing.push('hotspot_location');
        if (!vehicle_type_title) missing.push('vehicle_type_title');
        if (parking_charge === '') missing.push('parking_charge');
        rejectedRows.push({
          hotspot_name,
          hotspot_location,
          vehicle_type_title,
          parking_charge,
          reason: `Row ${lineNo}: missing ${missing.join(', ')}`,
        });
        continue;
      }

      rows.push({
        hotspot_name,
        hotspot_location,
        vehicle_type_title,
        parking_charge,
      });
    }

    for (const r of rows) {
      await this.prisma.dvi_tempcsv.create({
        data: {
          csvtype: 4 as any,                     // parking charge import
          sessionID: sessionId as any,
          field1: String(r.hotspot_name),        // TEXT → Hotspot Name
          field2: String(r.hotspot_location),    // TEXT → Hotspot Location
          field3: String(r.vehicle_type_title),  // TEXT → Vehicle Type
          field4: String(r.parking_charge),      // TEXT → Parking Charge
          status: 1 as any,                      // staged
        } as Prisma.dvi_tempcsvCreateInput,
      });
    }

    for (const r of rejectedRows) {
      await this.prisma.dvi_tempcsv.create({
        data: {
          csvtype: 4 as any,
          sessionID: sessionId as any,
          field1: String(r.hotspot_name || ''),
          field2: String(r.hotspot_location || ''),
          field3: String(r.vehicle_type_title || ''),
          field4: String(r.parking_charge || ''),
          field5: String(r.reason || 'Rejected'),
          status: 3 as any, // rejected
        } as Prisma.dvi_tempcsvCreateInput,
      });
    }

    try { fs.unlinkSync(csvFilePath); } catch {}

    return { sessionId, stagedCount: rows.length, rejectedCount: rejectedRows.length };
  }

  /**
   * Step 2: Read staged rows for preview (status=1, csvtype=4, by sessionId)
   */
  async getParkingTemplist(sessionId: string) {
    const data = await this.prisma.dvi_tempcsv.findMany({
      where: {
        csvtype: 4 as any,
        sessionID: sessionId as any,
        status: { in: [1, 2, 3] as any },
      },
      orderBy: { temp_id: 'asc' },
      select: {
        temp_id: true,
        field1: true, // hotspot_name
        field2: true, // hotspot_location
        field3: true, // vehicle_type_title
        field4: true, // parking_charge (stored as STRING)
        field5: true, // reject reason
        status: true,
      },
    });

    return {
      sessionId,
      rows: data.map((r) => ({
        ...(Number(r.status) === 2
          ? { row_status: 'imported' }
          : Number(r.status) === 1
          ? { row_status: 'staged' }
          : { row_status: 'rejected' }),
        id: Number(r.temp_id),
        hotspot_name: r.field1 ?? '',
        hotspot_location: r.field2 ?? '',
        vehicle_type_title: r.field3 ?? '',
        parking_charge: Number(r.field4 ?? 0), // convert to number for UI
        reason: r.field5 ?? '',
      })),
    };
  }

  /**
   * Step 3: Confirm import
   * - Resolve hotspot (by name + optional location token) and vehicle_type (by title)
   * - Upsert into dvi_hotspot_vehicle_parking_charges (update if exists, else insert)
   * - Mark dvi_tempcsv.status = 2 for imported rows
   */
  async confirmParkingImport(sessionId: string, onlyTempIds?: number[]) {
    const whereTemp: Prisma.dvi_tempcsvWhereInput = {
      csvtype: 4 as any,
      sessionID: sessionId as any,
      status: 1 as any,
    };
    if (onlyTempIds && onlyTempIds.length) {
      whereTemp.temp_id = { in: onlyTempIds as any };
    }

    const temps = await this.prisma.dvi_tempcsv.findMany({
      where: whereTemp,
      orderBy: { temp_id: 'asc' },
    });

    let imported = 0;
    let failed = 0;

    for (const t of temps) {
      const hotspotName = trimStr((t as any).field1);
      const hotspotLocToken = trimStr((t as any).field2);
      const vehTypeTitle = trimStr((t as any).field3);
      const charge = toNumber((t as any).field4); // from STRING

      try {
        // Resolve hotspot
        const hotspot = await this.prisma.dvi_hotspot_place.findFirst({
          where: {
            AND: [
              { hotspot_name: { equals: hotspotName } as any },
              ...(hotspotLocToken
                ? [{ hotspot_location: { contains: hotspotLocToken } as any }]
                : []),
              { status: 1 as any },
              { deleted: 0 as any },
            ] as any,
          },
          select: { hotspot_ID: true },
        });
        if (!hotspot) {
          failed++;
          await this.prisma.dvi_tempcsv.update({
            where: { temp_id: (t as any).temp_id as any },
            data: { status: 3 as any, field5: 'Hotspot not found for name/location' as any },
          });
          continue;
        }

        // Resolve vehicle type
        const vtype = await this.prisma.dvi_vehicle_type.findFirst({
          where: {
            vehicle_type_title: { equals: vehTypeTitle } as any,
            status: 1 as any,
            deleted: 0 as any,
          },
          select: { vehicle_type_id: true },
        });
        if (!vtype) {
          failed++;
          await this.prisma.dvi_tempcsv.update({
            where: { temp_id: (t as any).temp_id as any },
            data: { status: 3 as any, field5: 'Vehicle type not found' as any },
          });
          continue;
        }

        // If a record exists for (hotspot_id, vehicle_type_id) -> UPDATE else INSERT
        const existing = await this.prisma.dvi_hotspot_vehicle_parking_charges.findFirst({
          where: {
            AND: [
              { hotspot_id: hotspot.hotspot_ID as any },
              { vehicle_type_id: vtype.vehicle_type_id as any },
              { status: 1 as any },
              { deleted: 0 as any },
            ] as any,
          },
          select: { vehicle_parking_charge_ID: true },
        });

        if (existing) {
          await this.prisma.dvi_hotspot_vehicle_parking_charges.update({
            where: { vehicle_parking_charge_ID: existing.vehicle_parking_charge_ID as any },
            data: {
              hotspot_id: hotspot.hotspot_ID as any,
              vehicle_type_id: vtype.vehicle_type_id as any,
              parking_charge: charge as any,
            } as any,
          });
        } else {
          await this.prisma.dvi_hotspot_vehicle_parking_charges.create({
            data: {
              hotspot_id: hotspot.hotspot_ID as any,
              vehicle_type_id: vtype.vehicle_type_id as any,
              parking_charge: charge as any,
              status: 1 as any,
              deleted: 0 as any,
            } as any,
          });
        }

        // Mark temp row as imported (status=2)
        await this.prisma.dvi_tempcsv.update({
          where: { temp_id: (t as any).temp_id as any },
          data: { status: 2 as any },
        });

        imported++;
      } catch {
        failed++;
        try {
          await this.prisma.dvi_tempcsv.update({
            where: { temp_id: (t as any).temp_id as any },
            data: { status: 3 as any, field5: 'Unexpected import error' as any },
          });
        } catch {
          // ignore secondary update failure
        }
      }
    }

    const total = temps.length;
    return { sessionId, total, imported, failed };
  }

  // ======================================================================
  // NEW: Availability helper — find hotspots open at a given day/time/location
  // ======================================================================
  /**
   * Find hotspots that are OPEN at a specific time and (optionally) location.
   *
   * @param params.location  Optional location keyword; matches inside hotspot_location pipe list
   * @param params.datetime  ISO string like "2025-06-30T14:00:00+05:30" (preferred)
   * @param params.day       Optional: 0..6 (Mon..Sun) or "monday".."sunday"
   * @param params.time      Optional: "HH:mm" (24h). If datetime is given, time is derived from it.
   * @param params.limit     Optional: max results (default 100)
   * @param params.includeGallery Optional: include first gallery image url
   */
  async findOpenAt(params: {
    location?: string;
    datetime?: string;
    day?: number | string;
    time?: string;
    limit?: number;
    includeGallery?: boolean;
  }) {
    const limit = Math.max(1, Math.min(500, params.limit ?? 100));

    // Resolve day/time
    let dayInt: number | null = null;
    let hhmm: string | null = null;

    if (params.datetime) {
      const dt = new Date(params.datetime);
      if (!Number.isFinite(dt.getTime())) {
        throw new BadRequestException('Invalid datetime');
      }
      // JS: 0=Sun..6=Sat -> DB: 0=Mon..6=Sun
      const js = dt.getDay(); // 0..6
      dayInt = js === 0 ? 6 : js - 1;
      hhmm = `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
    }

    if (params.day != null) {
      if (typeof params.day === 'number') {
        if (params.day < 0 || params.day > 6) throw new BadRequestException('day must be 0..6 (Mon..Sun)');
        dayInt = params.day;
      } else {
        const d = DAY_NAME_TO_INT[String(params.day).toLowerCase().trim()];
        if (d == null) throw new BadRequestException('day must be 0..6 or weekday name');
        dayInt = d;
      }
    }

    if (params.time) {
      if (!/^\d{1,2}:\d{2}$/.test(params.time)) throw new BadRequestException('time must be HH:mm');
      hhmm = params.time;
    }

    if (dayInt == null || !hhmm) {
      throw new BadRequestException('Provide either a valid datetime OR both day and time');
    }

    const tAsUtc = hhmmToUTCDate(hhmm);
    if (!tAsUtc) throw new BadRequestException('Invalid HH:mm');

    // Step 1: find timing rows matching "open at this time" for that day
    const timingRows = await this.prisma.dvi_hotspot_timing.findMany({
      where: {
        hotspot_timing_day: dayInt as any,
        status: 1 as any,
        deleted: 0 as any,
        OR: [
          { hotspot_open_all_time: 1 as any },
          {
            AND: [
              { hotspot_closed: 0 as any },
              { hotspot_start_time: { lte: tAsUtc as any } as any },
              { hotspot_end_time: { gte: tAsUtc as any } as any },
            ] as any,
          },
        ],
      },
      select: {
        hotspot_ID: true,
      },
    });

    const ids = Array.from(new Set((timingRows as any[]).map((r) => Number(r.hotspot_ID)).filter(Boolean)));
    if (ids.length === 0) return { data: [] };

    // Step 2: optional location filter (pipe-separated field contains token)
    const locationToken = (params.location ?? '').trim();
    const placeWhere: Prisma.dvi_hotspot_placeWhereInput = {
      hotspot_ID: { in: ids } as any,
      status: 1,
      deleted: 0,
    };
    if (locationToken) {
      // Keep it simple: contains() over the pipe field.
      placeWhere.hotspot_location = { contains: locationToken } as any;
    }

    const places = await this.prisma.dvi_hotspot_place.findMany({
      where: placeWhere,
      orderBy: [{ hotspot_priority: 'asc' }, { hotspot_name: 'asc' }],
      take: limit,
      select: {
        hotspot_ID: true,
        hotspot_name: true,
        hotspot_priority: true,
        hotspot_location: true,
        hotspot_address: true,
        hotspot_landmark: true,
        hotspot_latitude: true,
        hotspot_longitude: true,
      },
    });

    if (places.length === 0) return { data: [] };

    // Optional: include first gallery image URL
    let firstImgById: Record<number, string> = {};
    if (params.includeGallery) {
      const g = await this.prisma.dvi_hotspot_gallery_details.findMany({
        where: { hotspot_ID: { in: places.map((p) => p.hotspot_ID) } as any, status: 1 as any, deleted: 0 as any },
        orderBy: [{ hotspot_gallery_details_id: 'asc' }],
        select: { hotspot_ID: true, hotspot_gallery_name: true },
      });
      firstImgById = {};
      for (const row of g) {
        const id = row.hotspot_ID as unknown as number;
        const fileName = (row.hotspot_gallery_name ?? '').toString();
        const url = buildImageUrl(fileName);
        if (!firstImgById[id] && url) firstImgById[id] = url;
      }
    }

    const data = places.map((p) => ({
      id: p.hotspot_ID,
      name: p.hotspot_name ?? '',
      priority: p.hotspot_priority ?? 0,
      locations: splitPipeToArray(p.hotspot_location ?? ''),
      address: (p as any).hotspot_address ?? null,
      landmark: (p as any).hotspot_landmark ?? null,
      lat: (p as any).hotspot_latitude ?? null,
      lng: (p as any).hotspot_longitude ?? null,
      photo_url: firstImgById[p.hotspot_ID as unknown as number] ?? '',
    }));

    return { data, at: { day: dayInt, time: hhmm } };
  }
}
