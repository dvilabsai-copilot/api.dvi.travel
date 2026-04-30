// FILE: src/modules/hotels/hotels.service.ts
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { Prisma } from '@prisma/client';
import { PaginationQueryDto } from './dto/pagination.dto';
import { CreateHotelDto } from './dto/create-hotel.dto';
import { UpdateHotelDto } from './dto/update-hotel.dto';
import { UiRoomItemDto as CreateRoomDto } from './dto/create-room.dto';
import { CreateAmenityDto } from './dto/create-amenity.dto';
import { CreatePriceBookDto } from './dto/create-pricebook.dto';
import { CreateReviewDto } from './dto/create-review.dto';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class HotelsService {
  constructor(private prisma: PrismaService) {}

  private readonly basicInfoRequiredKeys = [
    'hotel_name',
    'hotel_code',
    'hotel_place',
    'hotel_mobile',
    'hotel_email',
    'hotel_address',
    'hotel_category',
    'status',
    'hotel_power_backup',
    'hotel_country',
    'hotel_state',
    'hotel_city',
    'hotel_pincode',
    'hotel_margin',
    'hotel_margin_gst_type',
    'hotel_margin_gst_percentage',
  ] as const;

  // =====================================================================================
  // Helpers
  // =====================================================================================

  // For dvi_hotel (Boolean deleted)
  private notDeletedBool = { OR: [{ deleted: { equals: false } }, { deleted: null }] } as const;

  // For master tables that use deleted: INT (0/1)
  private notDeletedInt = { OR: [{ deleted: 0 }, { deleted: null }] } as const;

  // Format TIME / DATETIME safely for API responses
  private toHHmm(v: any): string | null {
    if (!v) return null;
    const s = String(v);
    const m = s.match(/^(\d{2}):(\d{2})(?::\d{2})?$/);
    if (m) return `${m[1]}:${m[2]}`;
    try {
      const d = new Date(v);
      if (!isNaN(d.getTime())) {
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
      }
    } catch {}
    return null;
  }

  private toISOorNull(v: any): string | null {
    if (!v) return null;
    try {
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d.toISOString();
    } catch {
      return null;
    }
  }

  /** Parse date-like input; returns JS Date or undefined (won't write invalid dates). */
  private toDate(v: any): Date | undefined {
    if (v === undefined || v === null || v === '') return undefined;
    const d = new Date(v);
    return isNaN(d.getTime()) ? undefined : d;
  }

  /** number normalizer: omit invalid/blank */
  private toNumStrict(v: any): number | undefined {
    if (v === '' || v === undefined || v === null) return undefined;
    const n = typeof v === 'string' ? Number(v.trim()) : Number(v);
    return Number.isFinite(n) ? n : undefined;
  }

  /** string normalizer: trim & omit blank */
  private toStr(v: any): string | undefined {
    if (v === undefined || v === null) return undefined;
    const s = String(v).trim();
    return s.length ? s : undefined;
  }

  /** "hh:mm" or "hh:mm AM/PM" → Date (UTC Jan 1, 1970 hh:mm) */
  private timeToDate(v: any): Date | undefined {
    if (!v) return undefined;
    const raw = String(v).trim();
    const ampmMatch = raw.match(/\s*(am|pm)\s*$/i);
    const ampm = ampmMatch ? (ampmMatch[1] as string) : '';
    const base = raw.replace(/\s*(am|pm)\s*$/i, '');
    const [hStr, mStr] = base.split(':');
    let h = Number(hStr ?? 0);
    const m = Number(mStr ?? 0);
    if (ampm) {
      const isPM = /pm/i.test(ampm);
      if (isPM && h < 12) h += 12;
      if (!isPM && h === 12) h = 0;
    }
    if (!Number.isFinite(h) || !Number.isFinite(m)) return undefined;
    return new Date(Date.UTC(1970, 0, 1, h, m, 0, 0));
  }

  /** UI strings → legacy integer codes for gst_type */
  private mapGstType(v: any): number | undefined {
    if (v === '' || v === undefined || v === null) return undefined;
    if (typeof v === 'number') return v;
    const s = String(v).toLowerCase();
    if (['included', 'incl', 'inc', '1', 'included'].some((x) => s.includes(x))) return 1;
    if (['excluded', 'excl', 'exc', '2', 'excluded'].some((x) => s.includes(x))) return 2;
    return 1;
  }

  /** Map UI/legacy payload → actual dvi_hotel columns; strip unknown/invalid */
  private mapHotelDto(dto: any) {
    const mapped: any = {
      hotel_name: this.toStr(dto.hotel_name),
      hotel_place: this.toStr(dto.hotel_place),
      hotel_mobile: this.toStr(dto.hotel_mobile ?? dto.hotel_mobile_no),
      hotel_email: this.toStr(dto.hotel_email ?? dto.hotel_email_id),
      hotel_country: this.toStr(dto.hotel_country),
      hotel_state: this.toStr(dto.hotel_state),
      hotel_city: this.toStr(dto.hotel_city),
      hotel_pincode: this.toStr(dto.hotel_pincode ?? dto.hotel_postal_code),
      hotel_code: this.toStr(dto.hotel_code),
      hotel_address: this.toStr(dto.hotel_address ?? dto.hotel_address_1),

      // persist selected category id
      hotel_category: this.toNumStrict(dto.hotel_category),

      hotel_margin: this.toNumStrict(dto.hotel_margin),
      hotel_margin_gst_type: this.toNumStrict(dto.hotel_margin_gst_type),
      hotel_margin_gst_percentage: this.toNumStrict(dto.hotel_margin_gst_percentage),
      hotel_latitude: this.toStr(dto.hotel_latitude),
      hotel_longitude: this.toStr(dto.hotel_longitude),
      status:
        dto.status !== undefined
          ? this.toNumStrict(dto.status)
          : dto.hotel_status !== undefined
          ? this.toNumStrict(dto.hotel_status)
          : undefined,
      hotel_power_backup:
        dto.hotel_power_backup !== undefined
          ? this.toNumStrict(dto.hotel_power_backup)
          : dto.hotel_powerbackup !== undefined
          ? this.toNumStrict(dto.hotel_powerbackup)
          : undefined,
      hotel_hotspot_status:
        dto.hotel_hotspot_status !== undefined ? this.toNumStrict(dto.hotel_hotspot_status) : undefined,
    };

    Object.keys(mapped).forEach((k) => mapped[k] === undefined && delete mapped[k]);
    return mapped;
  }

  private isBlank(v: any): boolean {
    if (v === undefined || v === null) return true;
    if (typeof v === 'string') return v.trim().length === 0;
    return false;
  }

  private validateBasicInfoRequired(mapped: Record<string, any>) {
    const errors: Record<string, boolean> = {};

    if (this.isBlank(mapped.hotel_name)) errors.hotel_name_required = true;
    if (this.isBlank(mapped.hotel_code)) errors.hotel_code_required = true;
    if (this.isBlank(mapped.hotel_place)) errors.hotel_place_required = true;
    if (this.isBlank(mapped.hotel_mobile)) errors.hotel_mobile_no_required = true;
    if (this.isBlank(mapped.hotel_email)) errors.hotel_email_id_required = true;
    if (this.isBlank(mapped.hotel_address)) errors.hotel_address_required = true;
    if (this.isBlank(mapped.hotel_category)) errors.hotel_category_required = true;
    if (this.isBlank(mapped.status)) errors.hotel_status_required = true;
    if (this.isBlank(mapped.hotel_power_backup)) errors.hotel_powerbackup_required = true;
    if (this.isBlank(mapped.hotel_country)) errors.hotel_country_required = true;
    if (this.isBlank(mapped.hotel_state)) errors.hotel_state_required = true;
    if (this.isBlank(mapped.hotel_city)) errors.hotel_city_required = true;
    if (this.isBlank(mapped.hotel_pincode)) errors.hotel_postal_code_required = true;
    if (this.isBlank(mapped.hotel_margin)) errors.hotel_margin_required = true;
    if (this.isBlank(mapped.hotel_margin_gst_type)) {
      errors.hotel_margin_gst_type_required = true;
    }
    if (this.isBlank(mapped.hotel_margin_gst_percentage)) {
      errors.hotel_margin_gst_percentage_required = true;
    }

    if (Object.keys(errors).length) {
      throw new BadRequestException({ success: false, errors });
    }
  }

  private isBasicInfoAttempt(dto: Record<string, any>): boolean {
    return this.basicInfoRequiredKeys.some((k) => Object.prototype.hasOwnProperty.call(dto, k));
  }

  // =====================================================================================
  // Hotels: list / options / derived cities / getOne / create / update / remove
  // =====================================================================================

  async list(q: PaginationQueryDto) {
    const page = Math.max(1, Number(q.page ?? 1));
    const limit = Math.max(1, Math.min(100, Number(q.limit ?? 10)));
    const skip = (page - 1) * limit;

    const AND: Prisma.dvi_hotelWhereInput[] = [this.notDeletedBool as any];

    const rawStatus: any = (q as any).status;
    if (rawStatus !== undefined && rawStatus !== null && rawStatus !== '') {
      AND.push({ status: Number(rawStatus) } as any);
    }

    if (q.hotel_state) AND.push({ hotel_state: q.hotel_state } as any);
    if (q.hotel_city) AND.push({ hotel_city: q.hotel_city } as any);

    const term = (q.search ?? '').toString().trim();
    if (term) {
      AND.push({
        OR: [
          { hotel_name: { contains: term } as any },
          { hotel_code: { contains: term } as any },
          { hotel_mobile: { contains: term } as any },
          { hotel_email: { contains: term } as any },
          { hotel_address: { contains: term } as any },
          { hotel_place: { contains: term } as any },
          { hotel_city: { contains: term } as any },
          { hotel_state: { contains: term } as any },
        ],
      } as any);
    }

    const where: Prisma.dvi_hotelWhereInput | undefined = AND.length ? { AND } : undefined;

    const orderBy =
      q.sortBy && typeof q.sortBy === 'string'
        ? ([{ [q.sortBy]: (q.sortOrder as 'asc' | 'desc') ?? 'asc' }] as any)
        : [{ hotel_name: 'asc' as const }];

    const [items, total] = await this.prisma.$transaction([
      this.prisma.dvi_hotel.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        select: {
          hotel_id: true,
          hotel_name: true,
          hotel_code: true,
          hotel_state: true,
          hotel_city: true,
          hotel_mobile: true,
          hotel_email: true,
          status: true,
          hotel_country: true,
          hotel_place: true,
          hotel_address: true,
          hotel_pincode: true,
          hotel_margin: true,
          hotel_margin_gst_type: true,
          hotel_margin_gst_percentage: true,
          hotel_latitude: true,
          hotel_longitude: true,
          hotel_category: true,
          hotel_power_backup: true,
          hotel_hotspot_status: true,
        },
      }),
      this.prisma.dvi_hotel.count({ where }),
    ]);

    const rows = items.map((h) => ({
      hotel_id: h.hotel_id,
      hotel_name: h.hotel_name,
      hotel_code: h.hotel_code,
      hotel_state: h.hotel_state,
      hotel_city: h.hotel_city,
      hotel_mobile: h.hotel_mobile,
      status: h.status,
    }));

    return { page, limit, total, rows };
  }

  async options(term: string, limit = 50) {
    const AND: Prisma.dvi_hotelWhereInput[] = [this.notDeletedBool as any];

    const t = (term ?? '').toString().trim();
    if (t) {
      AND.push({
        OR: [{ hotel_name: { contains: t } as any }, { hotel_code: { contains: t } as any }],
      } as any);
    }

    const where: Prisma.dvi_hotelWhereInput = { AND };

    const items = await this.prisma.dvi_hotel.findMany({
      where,
      orderBy: [{ hotel_name: 'asc' }],
      take: Math.min(200, Math.max(1, limit)),
      select: { hotel_id: true, hotel_name: true, hotel_code: true },
    });

    return items.map((i) => ({ id: i.hotel_id, label: i.hotel_name, code: i.hotel_code }));
  }

  async searchHotelNames(phrase: string) {
    const term = (phrase ?? '').toString().trim();
    if (!term) return [];

    const rows = await this.prisma.dvi_hotel.findMany({
      where: {
        AND: [
          this.notDeletedBool as any,
          { hotel_name: { contains: term } as any },
        ],
      } as any,
      select: { hotel_name: true },
      orderBy: { hotel_name: 'asc' } as any,
      take: 50,
    });

    if (!rows.length) return [{ check_hotel_name: term }];
    return rows.map((r: any) => ({ check_hotel_name: r.hotel_name }));
  }

  async searchRoomTypeNames(phrase: string) {
    const term = (phrase ?? '').toString().trim();
    if (!term) return [];

    const rows = await this.prisma.dvi_hotel_roomtype.findMany({
      where: {
        AND: [
          { OR: [{ deleted: 0 as any }, { deleted: null as any }] } as any,
          { room_type_title: { contains: term } as any },
        ],
      } as any,
      select: { room_type_title: true },
      orderBy: { room_type_title: 'asc' } as any,
      take: 50,
    } as any);

    if (!rows.length) return [{ check_room_type: term }];
    return rows.map((r: any) => ({ check_room_type: r.room_type_title }));
  }

  async citiesByState(hotel_state: string) {
    if (!hotel_state) return [];
    const groups = await this.prisma.dvi_hotel.groupBy({
      by: ['hotel_city'],
      where: {
        AND: [this.notDeletedBool as any, { hotel_state }, { hotel_city: { not: null } as any }],
      },
      _count: { hotel_city: true },
      orderBy: { hotel_city: 'asc' },
    });

    return groups
      .map((g) => g.hotel_city)
      .filter((c) => !!c && c.trim().length > 0)
      .map((name) => ({ name }));
  }

  // -------- dynamic filters ----------
  async availableStates() {
    const groups = await this.prisma.dvi_hotel.groupBy({
      by: ['hotel_state'],
      where: {
        AND: [this.notDeletedBool as any, { hotel_state: { not: null } as any }],
      },
      _count: { hotel_state: true },
      orderBy: { hotel_state: 'asc' },
    });
    return groups
      .map((g) => g.hotel_state)
      .filter((s) => !!s && s.trim().length > 0)
      .map((name) => ({ name }));
  }

  async availableCities(hotel_state?: string) {
    const AND: Prisma.dvi_hotelWhereInput[] = [this.notDeletedBool as any, { hotel_city: { not: null } as any }];
    if (hotel_state) AND.push({ hotel_state });

    const groups = await this.prisma.dvi_hotel.groupBy({
      by: ['hotel_city'],
      where: { AND } as any,
      _count: { hotel_city: true },
      orderBy: { hotel_city: 'asc' },
    });

    return groups
      .map((g) => g.hotel_city)
      .filter((c) => !!c && c.trim().length > 0)
      .map((name) => ({ name }));
  }
  // -----------------------------------
  // Simple static meal types meta: 1 = Breakfast, 2 = Lunch, 3 = Dinner
  mealTypes() {
    return [
      { id: 1, value: 1, code: 'B', name: 'Breakfast' },
      { id: 2, value: 2, code: 'L', name: 'Lunch' },
      { id: 3, value: 3, code: 'D', name: 'Dinner' },
    ];
  }

  getOne(hotel_id: number) {
    const id = Number(hotel_id);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error('Invalid hotel_id');
    }
    return this.prisma.dvi_hotel.findUnique({
      where: { hotel_id: id },
      select: {
        hotel_id: true,
        hotel_name: true,
        hotel_code: true,
        hotel_state: true,
        hotel_city: true,
        hotel_mobile: true,
        hotel_email: true,
        status: true,
        hotel_country: true,
        hotel_place: true,
        hotel_address: true,
        hotel_pincode: true,
        hotel_margin: true,
        hotel_margin_gst_type: true,
        hotel_margin_gst_percentage: true,
        hotel_latitude: true,
        hotel_longitude: true,
        hotel_category: true,
        hotel_power_backup: true,
        hotel_hotspot_status: true,
      },
    });
  }

  create(dto: CreateHotelDto) {
    const data = this.mapHotelDto(dto);
    this.validateBasicInfoRequired(data);
    if ((data as any).deleted === undefined) (data as any).deleted = false;
    if ((data as any).status === undefined) (data as any).status = 1;
    if ((data as any).hotel_power_backup === undefined) (data as any).hotel_power_backup = 0;
    if ((data as any).hotel_hotspot_status === undefined) (data as any).hotel_hotspot_status = 0;
    if ((data as any).hotel_margin === undefined) (data as any).hotel_margin = 0;

    return this.prisma.dvi_hotel.create({ data } as any);
  }

  async update(hotel_id: number, dto: UpdateHotelDto) {
    const id = Number(hotel_id);
    if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid hotel_id');

    const incoming = this.mapHotelDto(dto);
    if (this.isBasicInfoAttempt(dto as any)) {
      const current = await this.prisma.dvi_hotel.findUnique({
        where: { hotel_id: id },
        select: {
          hotel_name: true,
          hotel_code: true,
          hotel_place: true,
          hotel_mobile: true,
          hotel_email: true,
          hotel_address: true,
          hotel_category: true,
          status: true,
          hotel_power_backup: true,
          hotel_country: true,
          hotel_state: true,
          hotel_city: true,
          hotel_pincode: true,
          hotel_margin: true,
          hotel_margin_gst_type: true,
          hotel_margin_gst_percentage: true,
        },
      });
      const merged = { ...(current ?? {}), ...incoming };
      this.validateBasicInfoRequired(merged);
    }

    const data = incoming;
    if ((data as any).deleted !== undefined) delete (data as any).deleted;

    return this.prisma.dvi_hotel.update({
      where: { hotel_id: id },
      data: data as any,
    });
  }

  remove(hotel_id: number) {
    const id = Number(hotel_id);
    if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid hotel_id');
    return this.prisma.dvi_hotel.update({
      where: { hotel_id: id },
      data: { deleted: true } as any,
    });
  }

  // =====================================================================================
  // Form meta
  // =====================================================================================

  async generateCode(city: string | number) {
    const cityKey = String(city ?? '').trim();
    const prefix = cityKey ? cityKey.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() : 'CTY';

    const count = await this.prisma.dvi_hotel.count({
      where: cityKey ? ({ hotel_city: { contains: cityKey } } as any) : ({} as any),
    });

    const code = `${prefix}-${(count + 1).toString().padStart(4, '0')}`;
    return { code };
  }

  async getCategories() {
    const rows = await this.prisma.dvi_hotel_category.findMany({
      select: {
        hotel_category_id: true,
        hotel_category_title: true,
        hotel_category_code: true,
      },
      orderBy: [{ hotel_category_title: 'asc' } as any],
    });
    return rows.map((r: any) => ({
      id: r.hotel_category_id,
      name: r.hotel_category_title,
      code: r.hotel_category_code,
    }));
  }

  async countries() {
    return this.prisma.dvi_countries.findMany({
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }],
    } as any);
  }

  async states(countryId: number) {
    const cid = Number(countryId);
    if (!Number.isFinite(cid) || cid <= 0) return [];
    return this.prisma.dvi_states.findMany({
      where: { country_id: cid } as any,
      select: { id: true, name: true, country_id: true },
      orderBy: [{ name: 'asc' }],
    } as any);
  }

  async statesAll() {
    return this.prisma.dvi_states.findMany({
      select: { id: true, name: true, country_id: true },
      orderBy: [{ name: 'asc' }],
    } as any);
  }

  async stateById(id: number) {
    const sid = Number(id);
    if (!Number.isFinite(sid) || sid <= 0) return null as any;
    return this.prisma.dvi_states.findFirst({
      where: { id: sid } as any,
      select: { id: true, name: true, country_id: true },
    } as any);
  }

  async cities(stateId: number) {
    const sid = Number(stateId);
    if (!Number.isFinite(sid) || sid <= 0) return [];
    return this.prisma.dvi_cities.findMany({
      where: { state_id: sid } as any,
      select: { id: true, name: true, state_id: true },
      orderBy: [{ name: 'asc' }],
    } as any);
  }

  async citiesAll() {
    return this.prisma.dvi_cities.findMany({
      select: { id: true, name: true, state_id: true },
      orderBy: [{ name: 'asc' }],
    } as any);
  }

  async cityById(id: number) {
    const cid = Number(id);
    if (!Number.isFinite(cid) || cid <= 0) return null as any;
    return this.prisma.dvi_cities.findFirst({
      where: { id: cid } as any,
      select: { id: true, name: true, state_id: true },
    } as any);
  }

  async gstTypes() {
    return [
      { id: 1, name: 'Included' },
      { id: 2, name: 'Excluded' },
    ];
  }

  async gstPercentages() {
    const rows = await this.prisma.dvi_gst_setting.findMany({
      select: { gst_setting_id: true, gst_value: true },
      orderBy: [{ gst_value: 'asc' } as any],
    } as any);

    const seen = new Set<number>();
    const options: Array<{ id: number; name: string; value: number }> = [];
    for (const r of rows) {
      const v = Number(r.gst_value);
      if (Number.isFinite(v) && !seen.has(v)) {
        seen.add(v);
        options.push({ id: r.gst_setting_id, name: `${v}%`, value: v });
      }
    }
    if (options.length === 0) {
      return [
        { id: 0, name: '0%', value: 0 },
        { id: 5, name: '5%', value: 5 },
        { id: 12, name: '12%', value: 12 },
        { id: 18, name: '18%', value: 18 },
      ];
    }
    return options;
  }

  async inbuiltAmenities() {
    const rows = await this.prisma.dvi_inbuilt_amenities.findMany({
      select: {
        inbuilt_amenity_type_id: true,
        inbuilt_amenity_title: true,
      },
      orderBy: [
        {
          inbuilt_amenity_title: 'asc',
        },
      ],
    } as any);

    return rows.map((r: any) => ({
      id: r.inbuilt_amenity_type_id,
      name: r.inbuilt_amenity_title,
    }));
  }

  async roomTypes() {
    const rows = await this.prisma.dvi_hotel_roomtype.findMany({
      where: {
        OR: [{ deleted: 0 as any }, { deleted: null as any }],
      },
      select: {
        room_type_id: true,
        room_type_title: true,
      },
      orderBy: { room_type_title: 'asc' } as any,
    } as any);

    return rows.map((r: any) => ({
      id: r.room_type_id,
      roomtype_id: r.room_type_id,
      room_type_id: r.room_type_id,
      value: r.room_type_id,
      name: r.room_type_title,
      title: r.room_type_title,
      room_type: r.room_type_title,
    }));
  }

  async roomTypesByHotel(hotelId: number) {
    const hid = Number(hotelId);
    if (!Number.isFinite(hid) || hid <= 0) return [];

    const roomRows = await this.prisma.dvi_hotel_rooms.findMany({
      where: {
        hotel_id: hid,
        OR: [{ deleted: 0 as any }, { deleted: null as any }, { deleted: false as any }],
      } as any,
      select: { room_type_id: true },
      distinct: ['room_type_id'] as any,
    } as any);

    const roomTypeIds = roomRows
      .map((r: any) => Number(r.room_type_id))
      .filter((id: number) => Number.isFinite(id) && id > 0);

    if (!roomTypeIds.length) return [];

    const rows = await this.prisma.dvi_hotel_roomtype.findMany({
      where: {
        room_type_id: { in: roomTypeIds } as any,
        OR: [{ deleted: 0 as any }, { deleted: null as any }],
      } as any,
      select: {
        room_type_id: true,
        room_type_title: true,
      },
      orderBy: { room_type_title: 'asc' } as any,
    } as any);

    return rows.map((r: any) => ({
      id: r.room_type_id,
      roomtype_id: r.room_type_id,
      room_type_id: r.room_type_id,
      value: r.room_type_id,
      name: r.room_type_title,
      title: r.room_type_title,
      room_type: r.room_type_title,
    }));
  }

  // =====================================================================================
  // Rooms (Step 2)
  // =====================================================================================

  private mapRoomDto(input: any) {
    const data: any = {};

    const hid = this.toNumStrict(input?.hotel_id);
    if (hid) data.hotel_id = hid;

    const roomTypeId = this.toNumStrict(input?.room_type_id);
    if (roomTypeId !== undefined) data.room_type_id = roomTypeId;
    const roomTypeText = this.toStr(input?.room_type);
    if (roomTypeText) data.room_ref_code = roomTypeText.slice(0, 60);

    data.room_title = this.toStr(input?.room_title);
    data.preferred_for = this.toStr(input?.preferred_for);

    const nor = this.toNumStrict(input?.no_of_rooms ?? input?.no_of_rooms_available);
    if (nor !== undefined) data.no_of_rooms_available = nor;

    const ac = this.toNumStrict(input?.ac_availability ?? input?.air_conditioner_availability);
    if (ac !== undefined) data.air_conditioner_availability = ac;

    const maxA = this.toNumStrict(input?.total_max_adults ?? input?.max_adult);
    if (maxA !== undefined) data.total_max_adults = maxA;
    const maxC = this.toNumStrict(input?.total_max_childrens ?? input?.max_children);
    if (maxC !== undefined) data.total_max_childrens = maxC;

    const cin = this.timeToDate(input?.check_in_time);
    if (cin) data.check_in_time = cin;
    const cout = this.timeToDate(input?.check_out_time);
    if (cout) data.check_out_time = cout;

    const gstT = this.mapGstType(input?.gst_type);
    if (gstT !== undefined) data.gst_type = gstT;

    const gstP =
      this.toStr(typeof input?.gst_percentage === 'number' ? String(input?.gst_percentage) : input?.gst_percentage) ??
      undefined;
    if (gstP !== undefined) data.gst_percentage = gstP;

    if (Array.isArray(input?.amenities)) {
      data.inbuilt_amenities = input.amenities.map((x: any) => String(x).trim()).filter(Boolean).join(', ');
    } else if (input?.inbuilt_amenities) {
      data.inbuilt_amenities = this.toStr(input.inbuilt_amenities);
    }

    // food flags may come as booleans or 0/1
    const bf = input?.breakfast_included ?? input?.food_breakfast ?? input?.food_included?.breakfast;
    if (bf !== undefined) data.breakfast_included = bf ? 1 : 0;
    const ln = input?.lunch_included ?? input?.food_lunch ?? input?.food_included?.lunch;
    if (ln !== undefined) data.lunch_included = ln ? 1 : 0;
    const dn = input?.dinner_included ?? input?.food_dinner ?? input?.food_included?.dinner;
    if (dn !== undefined) data.dinner_included = dn ? 1 : 0;

    const st = this.toNumStrict(input?.status);
    if (st !== undefined) data.status = st;

    Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);
    return data;
  }

  async listRooms(hotel_id: number) {
    const id = Number(hotel_id);
    if (!Number.isFinite(id) || id <= 0) return [];

    const rows = await this.prisma.dvi_hotel_rooms.findMany({
      where: { hotel_id: id } as any,
      orderBy: { room_ID: 'asc' } as any,
      select: {
        room_ID: true,
        hotel_id: true,
        room_type_id: true,
        preferred_for: true,
        room_title: true,
        no_of_rooms_available: true,
        room_ref_code: true,
        air_conditioner_availability: true,
        total_max_adults: true,
        total_max_childrens: true,
        check_in_time: true,
        check_out_time: true,
        gst_type: true,
        gst_percentage: true,
        breakfast_included: true,
        lunch_included: true,
        dinner_included: true,
        inbuilt_amenities: true,
        createdby: true,
        createdon: true,
        updatedon: true,
        status: true,
        deleted: true,
      },
    } as any);

    return rows.map((r: any) => ({
      ...r,
      check_in_time: this.toHHmm(r.check_in_time),
      check_out_time: this.toHHmm(r.check_out_time),
      createdon: this.toISOorNull(r.createdon),
      updatedon: this.toISOorNull(r.updatedon),
    }));
  }

  // >>> createdby default to 1, plus timestamps on create
  addRoom(dto: CreateRoomDto) {
    const data = this.mapRoomDto(dto);
    if (data.hotel_id === undefined) {
      throw new Error('hotel_id is required to create a room');
    }
    if (data.createdby === undefined) data.createdby = 1;
    const now = new Date();
    if (data.createdon === undefined) data.createdon = now;
    if (data.updatedon === undefined) data.updatedon = now;

    return this.prisma.dvi_hotel_rooms.create({
      data: data as any,
      select: { room_ID: true, hotel_id: true } as any,
    });
  }

  updateRoom(dto: Partial<CreateRoomDto> & { room_id?: number; room_ID?: number; hotel_id: number }) {
    const roomId = (dto as any).room_id ?? (dto as any).room_ID;
    if (!roomId) throw new Error('room_id is required to update a room');

    const data = this.mapRoomDto(dto);
    delete (data as any).hotel_id;
    // always touch updatedon
    (data as any).updatedon = new Date();

    return this.prisma.dvi_hotel_rooms.update({
      where: { room_ID: Number(roomId) } as any,
      data: data as any,
      select: { room_ID: true } as any,
    });
  }

  removeRoom(_hotel_id: number, room_id: number) {
    return this.prisma.dvi_hotel_rooms.delete({
      where: { room_ID: Number(room_id) } as any,
    });
  }

  async saveRoom(body: any) {
    const hasId = body?.room_id ?? body?.room_ID;
    if (hasId) {
      return this.updateRoom({
        ...(body ?? {}),
        room_ID: Number(body.room_id ?? body.room_ID),
        hotel_id: Number(body.hotel_id),
      } as any);
    }
    const created = await this.addRoom(body as any);
    return { success: true, ...created };
  }

  // =====================================================================================
  // NEW: Room Gallery (upload files & insert into dvi_hotel_room_gallery_details)
  // =====================================================================================

  /**
   * Save room gallery:
   * - Files already uploaded by Multer to uploads/tmp-room-gallery
   * - Move each file into ../../uploads/room_gallery/ (relative to compiled __dirname)
   * - New filename: room_ref_code + '_' + index + extension
   * - Insert row into dvi_hotel_room_gallery_details with hotel_id, room_id, room_gallery_name
   */
  async saveRoomGallery(params: {
    hotelId: number;
    roomId: number;
    roomRefCode: string;
    files: Express.Multer.File[];
    createdBy: number;
  }) {
    const hotelId = Number(params.hotelId);
    const roomId = Number(params.roomId);
    const roomRefCode = String(params.roomRefCode || '').trim();
    const createdBy = Number(params.createdBy) || 1;
    const files = params.files || [];

    if (!Number.isFinite(hotelId) || hotelId <= 0) {
      throw new Error('Invalid hotelId for room gallery');
    }
    if (!Number.isFinite(roomId) || roomId <= 0) {
      throw new Error('Invalid roomId for room gallery');
    }
    if (!roomRefCode) {
      throw new Error('roomRefCode is required for room gallery filenames');
    }
    if (!files.length) {
      return { success: true, count: 0 };
    }

    // ../../uploads/room_gallery relative to dist/modules/hotels
    const finalDir = path.resolve(__dirname, '../../uploads/room_gallery');

    await fs.promises.mkdir(finalDir, { recursive: true });

    const now = new Date();
    const rows: {
      hotel_id: number;
      room_id: number;
      room_gallery_name: string;
      createdby: number;
      createdon: Date;
      updatedon: Date;
      status: number;
      deleted: number;
    }[] = [];

    const safeRef = roomRefCode.replace(/[^A-Za-z0-9_-]/g, '');

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!f || !f.path) continue;

      const ext =
        path.extname(f.originalname || '') ||
        path.extname((f as any).filename || '') ||
        '.jpg';
      const indexStr = String(i + 1);
      const newName = `${safeRef}_${indexStr}${ext}`;
      const targetPath = path.join(finalDir, newName);

      // Handle relative vs absolute tmp path robustly
      const tmpPath = path.isAbsolute(f.path)
        ? f.path
        : path.join(process.cwd(), f.path);

      // Move file from tmp folder to final room_gallery folder
      await fs.promises.rename(tmpPath, targetPath);

      rows.push({
        hotel_id: hotelId,
        room_id: roomId,
        room_gallery_name: newName,
        createdby: createdBy,
        createdon: now,
        updatedon: now,
        status: 1,
        deleted: 0,
      });
    }

    if (!rows.length) {
      return { success: true, count: 0 };
    }

    await this.prisma.dvi_hotel_room_gallery_details.createMany({
      data: rows as any,
      skipDuplicates: false,
    } as any);

    return {
      success: true,
      count: rows.length,
      files: rows.map((r) => r.room_gallery_name),
    };
  }

  // =====================================================================================
  // Amenities (Step 3)
  // =====================================================================================

  async listAmenities(hotel_id: number) {
    const id = Number(hotel_id);
    if (!Number.isFinite(id) || id <= 0) return [];

    const rows = await this.prisma.dvi_hotel_amenities.findMany({
      where: { hotel_id: id } as any,
      orderBy: { hotel_amenities_id: 'asc' } as any,
      select: {
        hotel_amenities_id: true,
        hotel_id: true,
        amenities_title: true,
        amenities_code: true,
        quantity: true,
        availability_type: true,
        start_time: true,
        end_time: true,
        createdon: true,
        updatedon: true,
        createdby: true,
        status: true,
        deleted: true,
      },
    } as any);

    return rows.map((r: any) => ({
      ...r,
      start_time: this.toHHmm(r.start_time),
      end_time: this.toHHmm(r.end_time),
      createdon: this.toISOorNull(r.createdon),
      updatedon: this.toISOorNull(r.updatedon),
    }));
  }

  /** normalize single amenity payload → table columns */
  private mapAmenityDto(input: any) {
    const data: any = {};
    const hid = this.toNumStrict(input?.hotel_id);
    if (hid !== undefined) data.hotel_id = hid;

    data.amenities_title = this.toStr(input?.amenities_title ?? input?.title ?? input?.name);
    data.amenities_code = this.toStr(input?.amenities_code ?? input?.code);

    const qty = this.toNumStrict(input?.quantity);
    if (qty !== undefined) data.quantity = qty;

    const av = this.toNumStrict(input?.availability_type);
    if (av !== undefined) data.availability_type = av;

    const st = this.timeToDate(input?.start_time ?? input?.startTime);
    if (st !== undefined) data.start_time = st;

    const et = this.timeToDate(input?.end_time ?? input?.endTime);
    if (et !== undefined) data.end_time = et;

    const status = this.toNumStrict(input?.status);
    if (status !== undefined) data.status = status;

    // defaults for create
    if (input?.createdby !== undefined) data.createdby = this.toNumStrict(input.createdby);
    if (data.createdby === undefined) data.createdby = 1; // default creator
    const now = new Date();
    if (data.createdon === undefined) data.createdon = now;
    if (data.updatedon === undefined) data.updatedon = now;
    if (data.deleted === undefined) data.deleted = 0;

    Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);
    return data;
  }

  /** create single amenity row */
  addAmenity(dto: CreateAmenityDto) {
    // guard: if mistakenly called with bulk body { items: [...] }, reject here
    if (Array.isArray((dto as any)?.items)) {
      throw new Error('Use addAmenitiesBulk() for items array');
    }
    const data = this.mapAmenityDto(dto as any);
    if (data.hotel_id === undefined) {
      throw new Error('hotel_id is required to create an amenity');
    }
    return this.prisma.dvi_hotel_amenities.create({ data } as any);
  }

  /** bulk create amenity rows (createMany) */
  async addAmenitiesBulk(hotel_id: number, items: any[]) {
    const hid = Number(hotel_id);
    if (!Number.isFinite(hid) || hid <= 0) throw new Error('Invalid hotel_id');
    if (!Array.isArray(items) || items.length === 0) return { count: 0 };

    const rows = items
      .map((it) => this.mapAmenityDto({ ...(it ?? {}), hotel_id: hid }))
      .filter((r) => r.amenities_title); // need at least a title

    if (rows.length === 0) return { count: 0 };

    const result = await this.prisma.dvi_hotel_amenities.createMany({
      data: rows as any,
      skipDuplicates: false,
    } as any);

    return { success: true, count: (result as any).count ?? rows.length };
  }

  updateAmenity(dto: Partial<CreateAmenityDto> & { amenity_id?: number; hotel_id: number }) {
    if (!(dto as any).amenity_id) {
      throw new Error('amenity_id is required to update an amenity');
    }
    const { amenity_id, hotel_id, ...rest } = dto as any;
    const data = this.mapAmenityDto({ ...rest, hotel_id });
    // always touch updatedon
    data.updatedon = new Date();

    return this.prisma.dvi_hotel_amenities.update({
      where: { hotel_amenities_id: Number(amenity_id) } as any,
      data: data as any,
      select: { hotel_amenities_id: true } as any,
    });
  }

  removeAmenity(_hotel_id: number, amenity_id: number) {
    return this.prisma.dvi_hotel_amenities.delete({
      where: { hotel_amenities_id: Number(amenity_id) } as any,
    });
  }

  // =====================================================================================
  // PriceBook (Step 4)  — ROOM price book (existing single-row helpers)
  // =====================================================================================

  getPricebook(hotel_id: number) {
    const id = Number(hotel_id);
    if (!Number.isFinite(id) || id <= 0) return null as any;
    return this.prisma.dvi_hotel_room_price_book.findFirst({
      where: { hotel_id: id } as any,
      orderBy: { hotel_price_book_id: 'asc' } as any,
    } as any);
  }

  addPrice(dto: CreatePriceBookDto) {
    return this.prisma.dvi_hotel_room_price_book.create({ data: dto as any });
  }

  async upsertPricebook(hotel_id: number, dto: Partial<CreatePriceBookDto>) {
    const existing = await this.prisma.dvi_hotel_room_price_book.findFirst({
      where: { hotel_id: Number(hotel_id) } as any,
      select: { hotel_price_book_id: true } as any,
    });

    if (!existing) {
      const created = await this.prisma.dvi_hotel_room_price_book.create({
        data: { ...(dto as any), hotel_id: Number(hotel_id) } as any,
        select: { hotel_price_book_id: true } as any,
      });
      return { success: true, id: created.hotel_price_book_id };
    }

    const updated = await this.prisma.dvi_hotel_room_price_book.update({
      where: { hotel_price_book_id: (existing as any).hotel_price_book_id } as any,
      data: dto as any,
      select: { hotel_price_book_id: true } as any,
    });
    return { success: true, id: updated.hotel_price_book_id };
  }

  // =====================================================================================
  // NEW: Meal Price Book (per-month rows with day_1..day_31 & meal_type)
  // NOTE: Your Prisma model has no start_date/end_date columns. We therefore
  //       write one row per (hotel_id, meal_type, year, month) and populate
  //       the appropriate day_N columns over the requested date range.
  //       meal_type convention used: 1=Breakfast, 2=Lunch, 3=Dinner.
  // =====================================================================================

  /** Split an inclusive range into month buckets. */
  private splitRangeByMonth(
    startDate: Date,
    endDate: Date,
  ): Array<{ year: string; month: string; days: number[] }> {
    const start = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
    if (end < start) return [];

    const buckets: Record<string, { year: string; month: string; days: Set<number> }> = {};
    const cur = new Date(start);
    while (cur <= end) {
      const y = cur.getFullYear();
      const m = cur.getMonth() + 1; // 1..12
      const key = `${y}-${m}`;
      if (!buckets[key]) buckets[key] = { year: String(y), month: String(m).padStart(2, '0'), days: new Set() };
      buckets[key].days.add(cur.getDate());
      cur.setDate(cur.getDate() + 1);
    }

    return Object.values(buckets).map((b) => ({
      year: b.year,
      month: b.month,
      days: [...b.days].sort((a, b2) => a - b2),
    }));
  }

  /** Build partial update for day columns. */
  private buildDayPatch(value: number | string, dayNumbers: number[]) {
    const obj: Record<string, number> = {};
    const val = Number(value);
    for (const d of dayNumbers) {
      obj[`day_${d}`] = Number.isFinite(val) ? val : 0;
    }
    return obj;
  }

  /** For UI: list raw meal pricebook rows (all months/meal types). */
  async listMealPricebook(hotel_id: number) {
    const id = Number(hotel_id);
    if (!Number.isFinite(id) || id <= 0) return [];
    return this.prisma.dvi_hotel_meal_price_book.findMany({
      where: { hotel_id: id } as any,
      orderBy: [
        { year: 'asc' } as any,
        { month: 'asc' } as any,
        { meal_type: 'asc' } as any,
        { hotel_meal_price_book_id: 'asc' } as any,
      ],
    } as any);
  }

  /** Return prices on a specific date (breakfast/lunch/dinner) by reading day_N. */
  async getMealPricebook(hotel_id: number, onDate?: string | Date) {
    const id = Number(hotel_id);
    if (!Number.isFinite(id) || id <= 0) return null as any;

    const d = this.toDate(onDate ?? new Date());
    if (!d) return null;

    const year = String(d.getFullYear());
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const dayIdx = d.getDate();
    const dayKey = `day_${dayIdx}` as keyof Prisma.dvi_hotel_meal_price_bookSelect;

    const [b, l, dn] = await Promise.all(
      [1, 2, 3].map((mt) =>
        this.prisma.dvi_hotel_meal_price_book.findFirst({
          where: { hotel_id: id, meal_type: mt, year, month } as any,
          select: { [dayKey]: true } as any,
        } as any),
      ),
    );

    return {
      date: d.toISOString().slice(0, 10),
      breakfast: b ? (b as any)[dayKey] ?? 0 : 0,
      lunch: l ? (l as any)[dayKey] ?? 0 : 0,
      dinner: dn ? (dn as any)[dayKey] ?? 0 : 0,
    };
  }

  /**
   * Upsert meal pricebook for a date range.
   * DTO from controller:
   *  - startDate, endDate
   *  - breakfastCost?, lunchCost?, dinnerCost?
   * Writes per (year, month, meal_type) rows and sets day_N columns.
   */
  async upsertMealPricebook(
    hotel_id: number,
    dto: {
      startDate: string | Date;
      endDate: string | Date;
      breakfastCost?: number;
      lunchCost?: number;
      dinnerCost?: number;
      status?: number;
    },
  ) {
    try {
      const id = Number(hotel_id);
      if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid hotel_id');

      const start = this.toDate(dto.startDate);
      const end = this.toDate(dto.endDate);
      if (!start || !end) throw new Error('startDate and endDate are required');

      const status = dto.status !== undefined ? Number(dto.status) : 1;
      const buckets = this.splitRangeByMonth(start, end);

      const doWrite = async (mealType: 1 | 2 | 3, price: number) => {
        for (const b of buckets) {
          const dayPatch = this.buildDayPatch(price, b.days);

          // find row if exists for (hotel, meal_type, year, month)
          const existing = await this.prisma.dvi_hotel_meal_price_book.findFirst({
            where: {
              hotel_id: id,
              meal_type: mealType,
              year: b.year,
              month: b.month,
            } as any,
            select: { hotel_meal_price_book_id: true } as any,
          });

          if (!existing) {
            await this.prisma.dvi_hotel_meal_price_book.create({
              data: {
                hotel_id: id,
                meal_type: mealType,
                year: b.year,
                month: b.month,
                status,
                deleted: 0,
                createdby: 1,
                createdon: new Date(),
                updatedon: new Date(),
                ...dayPatch,
              } as any,
            } as any);
          } else {
            await this.prisma.dvi_hotel_meal_price_book.update({
              where: { hotel_meal_price_book_id: (existing as any).hotel_meal_price_book_id } as any,
              data: { ...dayPatch, status, updatedon: new Date() } as any,
            } as any);
          }
        }
      };

      const tasks: Promise<any>[] = [];
      if (dto.breakfastCost !== undefined && dto.breakfastCost !== null) {
        tasks.push(doWrite(1, Number(dto.breakfastCost)));
      }
      if (dto.lunchCost !== undefined && dto.lunchCost !== null) {
        tasks.push(doWrite(2, Number(dto.lunchCost)));
      }
      if (dto.dinnerCost !== undefined && dto.dinnerCost !== null) {
        tasks.push(doWrite(3, Number(dto.dinnerCost)));
      }

      await Promise.all(tasks);
      return { success: true, monthsAffected: buckets.length };
    } catch (e: any) {
      throw new BadRequestException(
        e?.message || 'Meal pricebook save failed',
      );
    }
  }

  // =====================================================================================
  // NEW: PriceBook Writers for Amenities & Rooms
  // =====================================================================================

  /** Inclusive day range → per-month buckets with which day indices to fill. */
  private splitRangeByMonth_forRoomsAndAmenities(
    startDate: Date,
    endDate: Date,
  ): Array<{ year: string; month: string; days: number[] }> {
    // Keep a separate helper name to avoid accidental refactor collisions
    return this.splitRangeByMonth(startDate, endDate);
  }

  /** Build an object like { day_1: value, day_2: value, ... } for provided day numbers. */
  private buildDayPatch_forRoomsAndAmenities(value: number | string, dayNumbers: number[], asString = false) {
    const obj: Record<string, any> = {};
    for (const d of dayNumbers) {
      const key = `day_${d}`;
      obj[key] = asString ? String(value) : Number(value);
    }
    return obj;
  }

  /** AMENITIES: Upsert price rows for a date range. */
  async upsertAmenitiesPricebookRange(hotel_id: number, body: {
    hotel_amenities_id: number;
    startDate: string | Date;
    endDate: string | Date;
    hoursCharge?: number | string;
    dayCharge?: number | string;
  }) {
    const hid = Number(hotel_id);
    const amenityId = Number(body.hotel_amenities_id);
    const start = this.toDate(body.startDate);
    const end = this.toDate(body.endDate);
    if (!Number.isFinite(hid) || hid <= 0) throw new Error('Invalid hotel_id');
    if (!Number.isFinite(amenityId) || amenityId <= 0) throw new Error('Invalid hotel_amenities_id');
    if (!start || !end) throw new Error('startDate and endDate are required');

    const buckets = this.splitRangeByMonth_forRoomsAndAmenities(start, end);
    const tasks: Promise<any>[] = [];

    const upsertOne = async (pricetype: 1 | 2, charge: number | string) => {
      for (const b of buckets) {
        const dataPatch = {
          hotel_id: hid,
          hotel_amenities_id: amenityId,
          pricetype,
          year: b.year,
          month: b.month,
          ...this.buildDayPatch_forRoomsAndAmenities(charge, b.days, true), // amenity table stores strings
        };

        tasks.push(
          this.prisma.dvi_hotel_amenities_price_book.upsert({
            where: {
              hotel_id_hotel_amenities_id_pricetype_year_month: {
                hotel_id: hid,
                hotel_amenities_id: amenityId,
                pricetype,
                year: b.year,
                month: b.month,
              },
            } as any,
            create: dataPatch as any,
            update: dataPatch as any,
          } as any),
        );
      }
    };

    if (body.hoursCharge !== undefined && body.hoursCharge !== null && body.hoursCharge !== '') {
      await upsertOne(1, body.hoursCharge);
    }
    if (body.dayCharge !== undefined && body.dayCharge !== null && body.dayCharge !== '') {
      await upsertOne(2, body.dayCharge);
    }

    await Promise.all(tasks);
    return { success: true, rows: tasks.length };
  }

  /** ROOMS: Bulk upsert price rows for date ranges. */
  async bulkUpsertRoomPricebook(
    hotel_id: number,
    body: {
      items: Array<{
        room_id: number;
        startDate: string | Date;
        endDate: string | Date;
        roomPrice?: number | string;
        extraBed?: number | string;
        childWithBed?: number | string;
        childWithoutBed?: number | string;
        axisroomsRoomId?: string;
        rateplanId?: string;
        ratePlanName?: string;
      }>;
    },
  ) {
    const hid = Number(hotel_id);
    if (!Number.isFinite(hid) || hid <= 0) throw new Error('Invalid hotel_id');
    if (!body || !Array.isArray(body.items)) throw new Error('items array is required');

    const mkTask = async (
      roomId: number,
      priceType: 1 | 2 | 3 | 4,
      start: Date,
      end: Date,
      value: number | string,
    ) => {
      const buckets = this.splitRangeByMonth_forRoomsAndAmenities(start, end);
      for (const b of buckets) {
        const dayPatch = this.buildDayPatch_forRoomsAndAmenities(value, b.days, false);
        const existing = await this.prisma.dvi_hotel_room_price_book.findFirst({
          where: {
            hotel_id: hid,
            room_id: Number(roomId),
            price_type: priceType,
            year: b.year,
            month: b.month,
          } as any,
          select: { hotel_price_book_id: true } as any,
        });

        if (!existing) {
          await this.prisma.dvi_hotel_room_price_book.create({
            data: {
              hotel_id: hid,
              room_id: Number(roomId),
              price_type: priceType,
              year: b.year,
              month: b.month,
              status: 1,
              deleted: 0,
              ...dayPatch,
            } as any,
          } as any);
        } else {
          await this.prisma.dvi_hotel_room_price_book.update({
            where: { hotel_price_book_id: (existing as any).hotel_price_book_id } as any,
            data: { ...dayPatch } as any,
          } as any);
        }
      }
    };

    const hotel = await this.prisma.dvi_hotel.findFirst({
      where: { hotel_id: hid } as any,
      select: {
        axisrooms_enabled: true,
        axisrooms_property_id: true,
      } as any,
    });

    const axisroomsEnabled = Number(hotel?.axisrooms_enabled || 0) === 1;
    const axisroomsPropertyId = this.toStr(hotel?.axisrooms_property_id);
    const roomRefCache = new Map<number, string | undefined>();

    let axisroomsSyncedCount = 0;
    let axisroomsSkippedCount = 0;

    for (const it of body.items) {
      const roomId = Number(it.room_id);
      const start = this.toDate(it.startDate);
      const end = this.toDate(it.endDate);
      if (!Number.isFinite(roomId) || roomId <= 0) continue;
      if (!start || !end) continue;

      if (it.roomPrice !== undefined && it.roomPrice !== '' && it.roomPrice !== null) {
        await mkTask(roomId, 1, start, end, it.roomPrice);
      }
      if (it.extraBed !== undefined && it.extraBed !== '' && it.extraBed !== null) {
        await mkTask(roomId, 2, start, end, it.extraBed);
      }
      if (it.childWithBed !== undefined && it.childWithBed !== '' && it.childWithBed !== null) {
        await mkTask(roomId, 3, start, end, it.childWithBed);
      }
      if (it.childWithoutBed !== undefined && it.childWithoutBed !== '' && it.childWithoutBed !== null) {
        await mkTask(roomId, 4, start, end, it.childWithoutBed);
      }

      const rateplanId = this.toStr(it.rateplanId);
      if (!rateplanId) {
        continue;
      }

      if (!axisroomsEnabled || !axisroomsPropertyId) {
        axisroomsSkippedCount++;
        continue;
      }

      let axisroomsRoomId = this.toStr(it.axisroomsRoomId);
      if (!axisroomsRoomId) {
        if (!roomRefCache.has(roomId)) {
          const roomRow = await this.prisma.dvi_hotel_rooms.findFirst({
            where: {
              hotel_id: hid,
              room_ID: roomId,
            } as any,
            select: {
              room_ref_code: true,
            } as any,
          });
          roomRefCache.set(roomId, this.toStr(roomRow?.room_ref_code));
        }
        axisroomsRoomId = roomRefCache.get(roomId);
      }

      if (!axisroomsRoomId) {
        axisroomsSkippedCount++;
        continue;
      }

      const ratePlanName = this.toStr(it.ratePlanName) || rateplanId;

      const occupancyRates: Record<string, number> = {};
      if (it.roomPrice !== undefined && it.roomPrice !== '' && it.roomPrice !== null) {
        const single = Number(it.roomPrice);
        if (Number.isFinite(single)) occupancyRates.SINGLE = single;
      }
      if (it.extraBed !== undefined && it.extraBed !== '' && it.extraBed !== null) {
        const extraBed = Number(it.extraBed);
        if (Number.isFinite(extraBed)) occupancyRates.EXTRABED = extraBed;
      }
      if (it.childWithBed !== undefined && it.childWithBed !== '' && it.childWithBed !== null) {
        const childWithBed = Number(it.childWithBed);
        if (Number.isFinite(childWithBed)) occupancyRates.CHILD_WITH_BED = childWithBed;
      }
      if (it.childWithoutBed !== undefined && it.childWithoutBed !== '' && it.childWithoutBed !== null) {
        const childWithoutBed = Number(it.childWithoutBed);
        if (Number.isFinite(childWithoutBed)) occupancyRates.CHILD_WITHOUT_BED = childWithoutBed;
      }

      await this.prisma.dvi_hotel_room_rate_plan.upsert({
        where: {
          hotel_id_room_id_rateplan_id: {
            hotel_id: hid,
            room_id: roomId,
            rateplan_id: rateplanId,
          },
        },
        update: {
          axisrooms_room_id: axisroomsRoomId,
          rateplan_name: ratePlanName,
          occupancy: Object.keys(occupancyRates),
          updatedon: new Date(),
        },
        create: {
          hotel_id: hid,
          room_id: roomId,
          axisrooms_room_id: axisroomsRoomId,
          rateplan_id: rateplanId,
          rateplan_name: ratePlanName,
          occupancy: Object.keys(occupancyRates),
          commission_perc: '0.0',
          tax_perc: '0.0',
          currency: 'INR',
          createdon: new Date(),
          updatedon: new Date(),
        },
      });

      if (Object.keys(occupancyRates).length > 0) {
        await this.prisma.dvi_hotel_occupancy_rate.upsert({
          where: {
            hotel_id_room_id_rateplan_id_start_date_end_date: {
              hotel_id: hid,
              room_id: roomId,
              rateplan_id: rateplanId,
              start_date: start,
              end_date: end,
            },
          },
          update: {
            occupancy_rates: occupancyRates,
            received_at: new Date(),
          },
          create: {
            hotel_id: hid,
            room_id: roomId,
            rateplan_id: rateplanId,
            start_date: start,
            end_date: end,
            occupancy_rates: occupancyRates,
          },
        });
      }

      axisroomsSyncedCount++;
    }

    return {
      success: true,
      axisroomsSync: {
        synced: axisroomsSyncedCount,
        skipped: axisroomsSkippedCount,
      },
    };
  }

  // =====================================================================================
  // Reviews (Step 5)
  // =====================================================================================

  private truncate20(v: string | undefined): string | undefined {
    if (v == null) return undefined;
    const s = String(v);
    return s.length <= 20 ? s : s.slice(0, 20);
  }

  private mapReviewDto(input: any) {
    const data: any = {};
    const hid = this.toNumStrict(input?.hotel_id);
    if (hid !== undefined) data.hotel_id = hid;

    const rating = this.toStr(input?.rating ?? input?.hotel_rating);
    if (rating !== undefined) data.hotel_rating = rating;

    const desc = this.truncate20(this.toStr(input?.description ?? input?.hotel_description));
    if (desc !== undefined) data.hotel_description = desc;

    const status = this.toNumStrict(input?.status);
    if (status !== undefined) data.status = status;

    Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);
    return data;
  }

  listReviews(hotel_id: number) {
    const id = Number(hotel_id);
    if (!Number.isFinite(id) || id <= 0) return [];
    return this.prisma.dvi_hotel_review_details.findMany({
      where: { hotel_id: id } as any,
      orderBy: { hotel_review_id: 'desc' } as any,
    });
  }

  addReviewUnified(
    dto: { hotel_id: number; rating?: string; description?: string; status?: number },
    createdBy?: number,
  ) {
    const data = this.mapReviewDto(dto);
    if (data.hotel_id === undefined) throw new Error('hotel_id is required');

    const now = new Date();
    if (Number.isFinite(createdBy as any)) data.createdby = Number(createdBy);
    if (!data.createdon) data.createdon = now;
    if (!data.updatedon) data.updatedon = now;

    return this.prisma.dvi_hotel_review_details.create({ data } as any);
  }

  updateReviewUnified(review_id: number, hotel_id: number, body: any, updatedBy?: number) {
    const payload = this.mapReviewDto({ ...(body ?? {}), hotel_id });
    payload.updatedon = new Date();
    if (Number.isFinite(updatedBy as any)) payload.createdby = Number(updatedBy); // legacy column
    return this.prisma.dvi_hotel_review_details.update({
      where: { hotel_review_id: Number(review_id) } as any,
      data: payload as any,
      select: { hotel_review_id: true } as any,
    });
  }

  removeReview(_hotel_id: number, review_id: number) {
    return this.prisma.dvi_hotel_review_details.delete({
      where: { hotel_review_id: Number(review_id) } as any,
    });
  }
}
