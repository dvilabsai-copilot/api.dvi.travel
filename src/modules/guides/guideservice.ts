// FILE: src/modules/guides/guideservice.ts

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, dvi_guide_details } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import * as bcrypt from 'bcrypt';

// helpers
const DEFAULT_PAGE = 1;
const DEFAULT_SIZE = 5000;

function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
}
function pad2(n: number) {
  return n.toString().padStart(2, '0');
}
function ymd(d: Date | string | null | undefined): string {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(dt.getTime())) return '';
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}
function startOfDayUTC(date?: Date | string | null): Date | null {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return null;
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0));
}
function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
function monthName(dt: Date) {
  return dt.toLocaleString('en-US', { month: 'long' });
}
function ensureId(id?: number) {
  if (!id || id <= 0) throw new BadRequestException('Invalid id');
  return id;
}
function firstNumeric(val: unknown): number {
  const m = String(val ?? '').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : 0;
}
function parseSlotId(v: unknown): number {
  const raw = String(v ?? '').trim().toLowerCase();
  if (raw === 'slot1') return 1;
  if (raw === 'slot2') return 2;
  if (raw === 'slot3') return 3;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

// Blood groups as PHP getBLOOD_GROUP(label) equivalent (1-indexed)
const BLOOD_GROUPS = [
  'A RhD positive (A+)',
  'A RhD negative (A-)',
  'B RhD positive (B+)',
  'B RhD negative (B-)',
  'O RhD positive (O+)',
  'O RhD negative (O-)',
  'AB RhD positive (AB+)',
  'AB RhD negative (AB-)',
];

// Gender enum parity with schema (guide_gender tinyint)
const GENDERS = [
  { id: 1, label: 'Male' },
  { id: 2, label: 'Female' },
  { id: 3, label: 'Other' },
];

// Guide slots like UI chips
const GUIDE_SLOTS = [
  { id: 1, label: '8 AM to 1 PM' },
  { id: 2, label: '1 PM to 6 PM' },
  { id: 3, label: '8 AM to 6 PM' },
  { id: 4, label: '6 PM to 9 PM' },
];

// Pax buckets used in PHP screen
const GUIDE_PAX = [
  { id: 1, label: '1–5 Pax', min: 1, max: 5 },
  { id: 2, label: '6–14 Pax', min: 6, max: 14 },
  { id: 3, label: '15–40 Pax', min: 15, max: 40 },
];

// Slot types used in pricebook
const SLOT_TYPES = [
  { id: 1, label: '8 AM to 1 PM' },
  { id: 2, label: '1 PM to 6 PM' },
  { id: 3, label: '8 AM to 6 PM' },
  { id: 4, label: '6 PM to 9 PM' },
];

// local DTO shapes
export type GuideListQueryDto = {
  page?: number;
  size?: number;
  q?: string;
 status?: number; // 0/1
};

export type GuideBasicDto = {
  id?: number;
  guide_name: string;
 guide_dob?: string; // yyyy-mm-dd
  guide_bloodgroup?: string;
 guide_gender?: number; // 1/2/3
  guide_primary_mobile_number: string;
  guide_alternative_mobile_number?: string;
  guide_email?: string;
  guide_emergency_mobile_number?: string;
  guide_language_proficiency?: string;
  guide_aadhar_number?: string;
  guide_experience?: string;
  guide_country?: number;
  guide_state?: number;
  guide_city?: number;

 gst_type?: number; // 1=Included, 2=Excluded, 3=NA
 guide_gst?: number; // e.g. 18
 guide_available_slot?: number[]; // [1,2,3]

 // Bank
  guide_bank_name?: string;
  guide_bank_branch_name?: string;
  guide_ifsc_code?: string;
  guide_account_number?: string;
  guide_confirm_account_number?: string;

 // Preferred For (CSV "hotspot,activity,itinerary" parity)
  guide_preffered_for?: Array<string | number> | string | number;
  applicable_hotspot_places?: string;
  applicable_activity_places?: string;

 // PHP form field aliases
  guide_select_role?: string | number;
  guide_password?: string;

 // React camelCase aliases
  name?: string;
  dateOfBirth?: string;
  bloodGroup?: string;
  gender?: string | number;
  primaryMobile?: string;
  alternativeMobile?: string;
  email?: string;
  emergencyMobile?: string;
  experience?: string | number;
  aadharCardNo?: string;
  languageProficiency?: string | number;
  country?: string | number;
  state?: string | number;
  city?: string | number;
  gstType?: string | number;
  gstPercentage?: string | number;
  availableSlots?: Array<string | number>;
  bankDetails?: {
    bankName?: string;
    branchName?: string;
    ifscCode?: string;
    accountNumber?: string;
    confirmAccountNumber?: string;
  };
  preferredFor?: {
    hotspot?: boolean;
    activity?: boolean;
    itinerary?: boolean;
  };
  hotspotPlaces?: Array<string | number>;
  activityPlaces?: Array<string | number>;
  role?: string | number;
  password?: string;

 status?: number; // 0/1
 deleted?: number; // 0/1
};

export type GuidePricebookSaveDto = {
  guide_id: number;
 start_date: string; // yyyy-mm-dd
 end_date: string; // yyyy-mm-dd
  pax_prices: Array<{
 pax_id: number; // 1,2,3
 slot_id: number; // 1,2,3
    price: number | string;
  }>;
};

export type GuideReviewSaveDto = {
  guide_id: number;
 rating: number; // 1..5
  description: string;
};

@Injectable()
export class GuidesService {
  constructor(private readonly prisma: PrismaService) {}

  private async hashGuidePassword(password: string): Promise<string> {
 // New guide passwords are stored as bcrypt. Legacy PHP hashes are
 // upgraded by AuthService after a successful login.
    return bcrypt.hash(password, 10);
  }

  private async syncGuideUserAccount(
    guideId: number,
    input: GuideBasicDto,
  ): Promise<void> {
    const roleRaw = String(input.guide_select_role ?? '').trim();
    const roleId = Number(roleRaw || 0);
    const plainPassword = String(input.guide_password ?? '').trim();

    const existingUser = await this.prisma.dvi_users.findFirst({
      where: { guide_id: guideId, deleted: 0 },
      select: { userID: true },
    });

    if (existingUser) {
      if (plainPassword) {
        const pwdHash = await this.hashGuidePassword(plainPassword);
        await this.prisma.dvi_users.updateMany({
          where: { guide_id: guideId, deleted: 0 },
          data: {
            roleID: roleId > 0 ? roleId : 0,
            password: pwdHash,
          } as any,
        });
      }

      if (roleRaw !== '') {
        await this.prisma.dvi_users.updateMany({
          where: { guide_id: guideId, deleted: 0 },
          data: { roleID: roleId > 0 ? roleId : 0 } as any,
        });
      }
      return;
    }

    if (!plainPassword || roleRaw === '') return;

    const pwdHash = await this.hashGuidePassword(plainPassword);

    await this.prisma.dvi_users.create({
      data: {
        guide_id: guideId as any,
        username: String(input.guide_primary_mobile_number ?? '').trim() || null,
        useremail: String(input.guide_email ?? '').trim() || null,
        password: pwdHash,
        roleID: roleId > 0 ? roleId : 0,
        userapproved: 1 as any,
        status: 1 as any,
        deleted: 0 as any,
      } as any,
    });
  }

  private normalizeGuideBasicInput(input: GuideBasicDto): GuideBasicDto {
    const bloodSource = String(input.guide_bloodgroup ?? input.bloodGroup ?? '').trim();
    const bloodIndex = BLOOD_GROUPS.findIndex(
      (b) => b.toLowerCase() === bloodSource.toLowerCase(),
    );
    const bloodGroup =
      bloodIndex >= 0
        ? String(bloodIndex + 1)
        : bloodSource;

    const genderRaw = String(input.guide_gender ?? input.gender ?? '').trim().toLowerCase();
    const genderMap: Record<string, number> = {
      male: 1,
      female: 2,
      other: 3,
    };
    const normalizedGender =
      genderMap[genderRaw] ?? toNum(input.guide_gender ?? input.gender ?? 0);

    const preferredSingle = (() => {
      if (input.preferredFor) {
        if (input.preferredFor.hotspot) return 1;
        if (input.preferredFor.activity) return 2;
        if (input.preferredFor.itinerary) return 3;
      }
      if (Array.isArray(input.guide_preffered_for)) {
        return toNum(input.guide_preffered_for[0]);
      }
      return toNum(input.guide_preffered_for);
    })();

    const availableSlots =
      Array.isArray(input.guide_available_slot)
        ? input.guide_available_slot
        : Array.isArray(input.availableSlots)
        ? input.availableSlots
        : [];

    return {
      ...input,
      guide_name: String(input.guide_name ?? input.name ?? '').trim(),
      guide_dob: String(input.guide_dob ?? input.dateOfBirth ?? '').trim(),
      guide_bloodgroup: bloodGroup,
      guide_gender: normalizedGender,
      guide_primary_mobile_number: String(
        input.guide_primary_mobile_number ?? input.primaryMobile ?? '',
      ).trim(),
      guide_alternative_mobile_number: String(
        input.guide_alternative_mobile_number ?? input.alternativeMobile ?? '',
      ).trim(),
      guide_email: String(input.guide_email ?? input.email ?? '').trim(),
      guide_emergency_mobile_number: String(
        input.guide_emergency_mobile_number ?? input.emergencyMobile ?? '',
      ).trim(),
      guide_language_proficiency: String(
        input.guide_language_proficiency ?? input.languageProficiency ?? '',
      ).trim(),
      guide_aadhar_number: String(
        input.guide_aadhar_number ?? input.aadharCardNo ?? '',
      ).trim(),
      guide_experience: String(input.guide_experience ?? input.experience ?? '').trim(),
      guide_country: toNum(input.guide_country ?? input.country ?? 0),
      guide_state: toNum(input.guide_state ?? input.state ?? 0),
      guide_city: toNum(input.guide_city ?? input.city ?? 0),
      gst_type: toNum(input.gst_type ?? input.gstType ?? 0),
      guide_gst:
        toNum(input.guide_gst ?? 0) || firstNumeric(input.gstPercentage ?? 0),
      guide_available_slot: availableSlots.map(parseSlotId).filter((x) => x > 0),
      guide_bank_name: String(
        input.guide_bank_name ?? input.bankDetails?.bankName ?? '',
      ).trim(),
      guide_bank_branch_name: String(
        input.guide_bank_branch_name ?? input.bankDetails?.branchName ?? '',
      ).trim(),
      guide_ifsc_code: String(
        input.guide_ifsc_code ?? input.bankDetails?.ifscCode ?? '',
      ).trim(),
      guide_account_number: String(
        input.guide_account_number ?? input.bankDetails?.accountNumber ?? '',
      ).trim(),
      guide_confirm_account_number: String(
        input.guide_confirm_account_number ??
          input.bankDetails?.confirmAccountNumber ??
          '',
      ).trim(),
      guide_preffered_for: preferredSingle,
      applicable_hotspot_places: Array.isArray(input.hotspotPlaces)
        ? input.hotspotPlaces.map((x) => String(x).trim()).filter(Boolean).join(',')
        : String(input.applicable_hotspot_places ?? '').trim(),
      applicable_activity_places: Array.isArray(input.activityPlaces)
        ? input.activityPlaces
            .map((x) => String(x).trim())
            .filter(Boolean)
            .join(',')
        : String(input.applicable_activity_places ?? '').trim(),
      guide_select_role: String(input.guide_select_role ?? input.role ?? '').trim(),
      guide_password: String(input.guide_password ?? input.password ?? '').trim(),
    };
  }

 // List (DataTable)
  async list(q: GuideListQueryDto) {
    const page = q.page ?? DEFAULT_PAGE;
    const size = q.size ?? DEFAULT_SIZE;
    const skip = (page - 1) * size;
    const take = size;

    const where: Prisma.dvi_guide_detailsWhereInput = {
      deleted: 0,
    };
    if (q.status != null) where.status = q.status;
    if (q.q?.trim()) {
      const text = q.q.trim();
      where.OR = [
        { guide_name: { contains: text } as any },
        { guide_email: { contains: text } as any },
        { guide_primary_mobile_number: { contains: text } as any },
        { guide_alternative_mobile_number: { contains: text } as any },
      ];
    }

    const rows = await this.prisma.dvi_guide_details.findMany({
      where,
      orderBy: [{ guide_name: 'asc' }, { guide_id: 'desc' }],
      skip,
      take,
      select: {
        guide_id: true,
        guide_name: true,
        guide_primary_mobile_number: true,
        guide_email: true,
        status: true,
      },
    });

    const data = rows.map((r, idx) => ([
      {
        counter: skip + idx + 1,
        modify: Number(r.guide_id),
        guide_name: r.guide_name ?? '',
        guide_primary_mobile_number: r.guide_primary_mobile_number ?? '',
        guide_email: r.guide_email ?? '',
        status: Number(r.status ?? 0),
      }
    ] as unknown as any)).flat();

    return { data };
  }

 // Dynamic dropdowns for Add/Edit
  async formOptions() {
    const languagesRaw = await this.prisma.dvi_language.findMany({
      where: { deleted: false, status: 1 as any },
      orderBy: { language_id: 'asc' },
      select: { language_id: true, language: true },
    });

    const states = await this.prisma.dvi_states.findMany({
      where: { deleted: 0 },
      orderBy: [{ country_id: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, country_id: true },
    });

    const gst = await this.prisma.dvi_gst_setting.findMany({
      where: { deleted: 0, status: 1 as any },
      orderBy: [{ gst_value: 'asc' }],
      select: { gst_setting_id: true, gst_title: true, gst_value: true },
    });

    return {
      bloodGroups: BLOOD_GROUPS,
      genders: GENDERS,
      guideSlots: GUIDE_SLOTS,
      languages: languagesRaw.map((l) => ({
        id: Number(l.language_id),
        label: l.language ?? '',
      })),
      states: states.map((s) => ({
        id: Number(s.id),
        name: s.name,
        countryId: Number(s.country_id),
      })),
      gst: gst.map((g) => ({
        id: Number(g.gst_setting_id),
        title: g.gst_title ?? '',
        value: Number(g.gst_value ?? 0),
      })),
    };
  }

 // Get form (edit)
  async getForm(id: number) {
    id = ensureId(id);

    const g = await this.prisma.dvi_guide_details.findUnique({
      where: { guide_id: id },
    });
    if (!g || g.deleted === 1) throw new NotFoundException('Guide not found');

    const reviews = await this.prisma.dvi_guide_review_details.findMany({
      where: { guide_id: id, deleted: 0 },
      orderBy: [{ guide_review_id: 'desc' }],
    });

    const payload: GuideBasicDto = {
      id: g.guide_id,
      guide_name: g.guide_name ?? '',
      guide_dob: ymd(g.guide_dob),
      guide_bloodgroup: g.guide_bloodgroup ?? '',
      guide_gender: Number(g.guide_gender ?? 0),
      guide_primary_mobile_number: g.guide_primary_mobile_number ?? '',
      guide_alternative_mobile_number: g.guide_alternative_mobile_number ?? '',
      guide_email: g.guide_email ?? '',
      guide_emergency_mobile_number: g.guide_emergency_mobile_number ?? '',
      guide_language_proficiency: g.guide_language_proficiency ?? '',
      guide_aadhar_number: g.guide_aadhar_number ?? '',
      guide_experience: g.guide_experience ?? '',
      guide_country: Number(g.guide_country ?? 0),
      guide_state: Number(g.guide_state ?? 0),
      guide_city: Number(g.guide_city ?? 0),
      gst_type: Number((g as any).gst_type ?? 0),
      guide_gst: Number((g as any).guide_gst ?? 0),
      guide_available_slot: String((g as any).guide_available_slot ?? '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((x) => Number.isFinite(x) && x > 0),
      guide_bank_name: (g as any).guide_bank_name ?? '',
      guide_bank_branch_name: (g as any).guide_bank_branch_name ?? '',
      guide_ifsc_code: (g as any).guide_ifsc_code ?? '',
      guide_account_number: (g as any).guide_account_number ?? '',
      guide_confirm_account_number: (g as any).guide_confirm_account_number ?? '',
      guide_preffered_for: Number((g as any).guide_preffered_for ?? 0),
      applicable_hotspot_places: String((g as any).applicable_hotspot_places ?? ''),
      applicable_activity_places: String((g as any).applicable_activity_places ?? ''),
      status: Number(g.status ?? 1),
      deleted: Number(g.deleted ?? 0),
    };

    const pricebookRows = await this.prisma.dvi_guide_pricebook.findMany({
      where: {
        guide_id: id,
        deleted: 0,
      },
      orderBy: [{ guide_price_book_ID: 'desc' }],
    });

    return {
      payload,
      reviews,
      pricebook: pricebookRows,
      options: await this.formOptions(),
    };
  }

 // Save Step 1 (basic)
  async saveBasic(input: GuideBasicDto) {
    input = this.normalizeGuideBasicInput(input);

    if (!input.guide_name?.trim()) {
      throw new BadRequestException('guide_name is required');
    }
    if (!toNum(input.guide_gender)) {
      throw new BadRequestException('guide_gender is required');
    }
    if (!input.guide_primary_mobile_number?.trim()) {
      throw new BadRequestException('guide_primary_mobile_number is required');
    }
    if (!input.guide_email?.trim()) {
      throw new BadRequestException('guide_email is required');
    }
    if (!input.guide_language_proficiency?.trim()) {
      throw new BadRequestException('guide_language_proficiency is required');
    }
    if (!toNum(input.guide_gst)) {
      throw new BadRequestException('guide_gst is required');
    }
    if (!Array.isArray(input.guide_available_slot) || input.guide_available_slot.length === 0) {
      throw new BadRequestException('guide_available_slot is required');
    }
    if (!input.id && !String(input.guide_select_role ?? '').trim()) {
      throw new BadRequestException('guide_select_role is required');
    }
    if (!input.id && !String(input.guide_password ?? '').trim()) {
      throw new BadRequestException('guide_password is required');
    }
    if (
      input.guide_emergency_mobile_number &&
      input.guide_emergency_mobile_number === input.guide_primary_mobile_number
    ) {
      throw new BadRequestException(
        'Emergency mobile number and primary mobile number should not be same',
      );
    }
    if (
      input.guide_account_number &&
      input.guide_confirm_account_number &&
      input.guide_account_number !== input.guide_confirm_account_number
    ) {
      throw new BadRequestException('Account number & confirm do not match');
    }

    const masterData: Prisma.dvi_guide_detailsUncheckedCreateInput = {
      guide_name: input.guide_name.trim(),
      guide_dob: input.guide_dob ? startOfDayUTC(input.guide_dob) as any : null,
      guide_bloodgroup: input.guide_bloodgroup ?? null,
      guide_gender: (input.guide_gender ?? 0) as any,
      guide_primary_mobile_number: input.guide_primary_mobile_number ?? null,
      guide_alternative_mobile_number: input.guide_alternative_mobile_number ?? null,
      guide_email: input.guide_email ?? null,
      guide_emergency_mobile_number: input.guide_emergency_mobile_number ?? null,
      guide_language_proficiency: input.guide_language_proficiency ?? null,
      guide_aadhar_number: input.guide_aadhar_number ?? null,
      guide_experience: input.guide_experience ?? null,
      guide_country: (input.guide_country ?? 0) as any,
      guide_state: (input.guide_state ?? 0) as any,
      guide_city: (input.guide_city ?? 0) as any,

      gst_type: (input.gst_type ?? 0) as any,
      guide_gst: (input.guide_gst ?? 0) as any,
      guide_available_slot: Array.isArray(input.guide_available_slot)
        ? input.guide_available_slot.join(',')
        : '',

      guide_bank_name: input.guide_bank_name ?? null,
      guide_bank_branch_name: input.guide_bank_branch_name ?? null,
      guide_ifsc_code: input.guide_ifsc_code ?? null,
      guide_account_number: input.guide_account_number ?? null,

      guide_preffered_for: toNum(input.guide_preffered_for),
      applicable_hotspot_places: input.applicable_hotspot_places ?? null,
      applicable_activity_places: input.applicable_activity_places ?? null,

      status: (input.status ?? 1) as any,
      deleted: (input.deleted ?? 0) as any,
    } as any;

    let saved: dvi_guide_details;
    if (input.id && input.id > 0) {
      saved = await this.prisma.dvi_guide_details.update({
        where: { guide_id: input.id },
        data: masterData as any,
      });
    } else {
      saved = await this.prisma.dvi_guide_details.create({
        data: masterData as any,
      });
    }

    await this.syncGuideUserAccount(saved.guide_id, input);

    return { id: saved.guide_id };
  }

 // Save Step 2 (pricebook)
  async savePricebook(input: GuidePricebookSaveDto) {
    const guideId = ensureId(input.guide_id);
    const sd = startOfDayUTC(input.start_date);
    const ed = startOfDayUTC(input.end_date);
    if (!sd || !ed || ed < sd) throw new BadRequestException('Invalid date range');

    const endDateMonth = ed.getUTCMonth() + 1;
    let currentDate = new Date(Date.UTC(sd.getUTCFullYear(), sd.getUTCMonth(), sd.getUTCDate()));

    while (currentDate <= ed) {
      const currentYear = currentDate.getUTCFullYear();
      const currentMonth = currentDate.getUTCMonth() + 1;
      const currentMonthName = monthName(currentDate);

      const startDayOfMonth = currentDate.getUTCDate();
      const monthEndDate = new Date(Date.UTC(currentYear, currentMonth, 0));
      const endDayOfMonth =
        endDateMonth !== currentMonth ? monthEndDate.getUTCDate() : ed.getUTCDate();

      for (const row of input.pax_prices ?? []) {
        const pax = clamp(Number(row.pax_id), 1, 3);
        const slot = clamp(Number(row.slot_id), 1, 4);
        const rawPrice = String((row as any)?.price ?? '').trim();

 // PHP parity: only skip empty string, allow explicit 0 values.
        if (rawPrice === '') continue;
        const price = toNum(rawPrice);

        const dayFields: Record<string, number> = {};
        for (let d = startDayOfMonth; d <= endDayOfMonth; d++) {
          dayFields[`day_${d}`] = price;
        }

        const existingRows = await this.prisma.dvi_guide_pricebook.findMany({
          where: {
            guide_id: guideId,
            year: String(currentYear),
            month: currentMonthName,
            pax_count: pax,
            slot_type: slot,
            deleted: 0,
          },
          select: { guide_price_book_ID: true },
          orderBy: { guide_price_book_ID: 'asc' },
        });

        const existing = existingRows.length > 0 ? existingRows[0] : null;

        if (existingRows.length > 1) {
          const duplicateIds = existingRows.slice(1).map((r) => r.guide_price_book_ID);
          await this.prisma.dvi_guide_pricebook.updateMany({
            where: { guide_price_book_ID: { in: duplicateIds } as any },
            data: { deleted: 1 as any, updatedon: new Date() as any },
          });
        }

        if (existing) {
          await this.prisma.dvi_guide_pricebook.update({
            where: { guide_price_book_ID: existing.guide_price_book_ID },
            data: dayFields as any,
          });
        } else {
          await this.prisma.dvi_guide_pricebook.create({
            data: {
              guide_id: guideId,
              year: String(currentYear),
              month: currentMonthName,
              pax_count: pax,
              slot_type: slot,
              ...dayFields,
              status: 1,
              deleted: 0,
            } as any,
          });
        }
      }

      currentDate = new Date(Date.UTC(currentYear, currentMonth, 1));
    }

    return { ok: true, guide_id: guideId };
  }

 // Get pricebook rows by date range
  async getPricebookByDateRange(guideId: number, startDate: string, endDate: string) {
    guideId = ensureId(guideId);
    const sd = startOfDayUTC(startDate);
    const ed = startOfDayUTC(endDate);
    if (!sd || !ed || ed < sd) throw new BadRequestException('Invalid date range');

    const rows: any[] = [];
    let current = new Date(Date.UTC(sd.getUTCFullYear(), sd.getUTCMonth(), 1));
    const edFirst = new Date(Date.UTC(ed.getUTCFullYear(), ed.getUTCMonth(), 1));

    while (current <= edFirst) {
      const year = current.getUTCFullYear();
      const month = monthName(current);
      const monthRows = await this.prisma.dvi_guide_pricebook.findMany({
        where: { guide_id: guideId, year: String(year), month, deleted: 0 } as any,
        orderBy: [{ pax_count: 'asc' }, { slot_type: 'asc' }],
      });
      for (const row of monthRows) {
        rows.push(row as any);
      }
      current = new Date(Date.UTC(year, current.getUTCMonth() + 1, 1));
    }

    return rows;
  }

 // Save Step 3 (reviews)
  async addReview(input: GuideReviewSaveDto) {
    const guideId = ensureId(input.guide_id);
    const ratingRaw = Number(input.rating ?? 0);
    if (!ratingRaw) throw new BadRequestException('guide_rating_required');
    const rating = clamp(ratingRaw, 1, 5);
    const description = String(input.description ?? '').trim();
    if (!description) throw new BadRequestException('guide_description_required');

    const created = await this.prisma.dvi_guide_review_details.create({
      data: {
        guide_id: guideId as any,
        guide_rating: String(rating) as any,
        guide_description: description as any,
        status: 1 as any,
        deleted: 0 as any,
        createdon: new Date() as any,
      } as any,
    });

    return { id: created.guide_review_id };
  }

  async updateReview(reviewId: number, input: GuideReviewSaveDto) {
    reviewId = ensureId(reviewId);
    const ratingRaw = Number(input.rating ?? 0);
    if (!ratingRaw) throw new BadRequestException('guide_rating_required');
    const rating = clamp(ratingRaw, 1, 5);
    const description = String(input.description ?? '').trim();
    if (!description) throw new BadRequestException('guide_description_required');

    await this.prisma.dvi_guide_review_details.update({
      where: { guide_review_id: reviewId },
      data: {
        guide_rating: String(rating) as any,
        guide_description: description as any,
        updatedon: new Date() as any,
      } as any,
    });
    return { ok: true };
  }

  async listReviews(guideId: number) {
    guideId = ensureId(guideId);
    const items = await this.prisma.dvi_guide_review_details.findMany({
      where: { guide_id: guideId, deleted: 0 },
      orderBy: [{ guide_review_id: 'desc' }],
    });
    return { data: items };
  }

  async deleteReview(reviewId: number) {
    reviewId = ensureId(reviewId);
    await this.prisma.dvi_guide_review_details.update({
      where: { guide_review_id: reviewId },
      data: { deleted: 1 as any },
    });
    return { ok: true };
  }

 // Step 4 (preview)
 /**
   * Returns raw row + humanized `view` (PHP-parity labels).
   * Adds: city_name & country_name so React shows names instead of IDs.
 */
  async getPreview(guideId: number) {
    guideId = ensureId(guideId);

    const g = await this.prisma.dvi_guide_details.findUnique({
      where: { guide_id: guideId },
    });
    if (!g || g.deleted === 1) throw new NotFoundException('Guide not found');

 // Lookups needed for labels
    const languageIds = String(g.guide_language_proficiency ?? '')
      .split(',')
      .map((v) => Number(String(v).trim()))
      .filter((n) => Number.isFinite(n) && n > 0);

    const hotspotIds = String((g as any).applicable_hotspot_places ?? '')
      .split(',')
      .map((v) => Number(String(v).trim()))
      .filter((n) => Number.isFinite(n) && n > 0);

    const activityIds = String((g as any).applicable_activity_places ?? '')
      .split(',')
      .map((v) => Number(String(v).trim()))
      .filter((n) => Number.isFinite(n) && n > 0);

    const [stateRow, cityRow, countryRow, langRows, hotspotRows, activityRows] = await Promise.all([
      g.guide_state
        ? this.prisma.dvi_states.findUnique({
            where: { id: Number(g.guide_state) },
            select: { id: true, name: true, country_id: true },
          })
        : Promise.resolve(null),
      g.guide_city
        ? this.prisma.dvi_cities.findUnique({
            where: { id: Number(g.guide_city) },
            select: { id: true, name: true, state_id: true },
          })
        : Promise.resolve(null),
      g.guide_country
        ? this.prisma.dvi_countries.findUnique({
            where: { id: Number(g.guide_country) },
            select: { id: true, name: true },
          })
        : Promise.resolve(null),
      languageIds.length
        ? this.prisma.dvi_language.findMany({
            where: { language_id: { in: languageIds as any }, status: 1 as any },
            select: { language_id: true, language: true },
          })
        : Promise.resolve([] as Array<{ language_id: number; language: string | null }>),
      hotspotIds.length
        ? this.prisma.dvi_hotspot_place.findMany({
            where: { hotspot_ID: { in: hotspotIds as any }, deleted: 0 },
            select: { hotspot_ID: true, hotspot_name: true },
            orderBy: { hotspot_ID: 'asc' },
          })
        : Promise.resolve([] as Array<{ hotspot_ID: number; hotspot_name: string | null }>),
      activityIds.length
        ? this.prisma.dvi_activity.findMany({
            where: { activity_id: { in: activityIds as any }, deleted: 0 },
            select: { activity_id: true, activity_title: true },
            orderBy: { activity_id: 'asc' },
          })
        : Promise.resolve([] as Array<{ activity_id: number; activity_title: string | null }>),
    ]);

    const dob = g.guide_dob ? new Date(g.guide_dob as any) : null;
    const dob_text =
      dob && Number.isFinite(dob.getTime())
        ? `${pad2(dob.getUTCDate())}-${pad2(dob.getUTCMonth() + 1)}-${dob.getUTCFullYear()}`
        : '';

    const gender_label =
      GENDERS.find((x) => x.id === Number(g.guide_gender ?? 0))?.label ?? '';

 const bgIndex = Number(g.guide_bloodgroup 0) - 1; // DB stores "1".."8"
    const blood_group_label = BLOOD_GROUPS[bgIndex] ?? (g.guide_bloodgroup ?? '');

    const language_label = langRows
      .sort(
        (a, b) =>
          languageIds.indexOf(Number(a.language_id)) -
          languageIds.indexOf(Number(b.language_id)),
      )
      .map((x) => x.language ?? '')
      .filter(Boolean)
      .join(', ');

    const state_name = stateRow?.name ?? '';
    const city_name = cityRow?.name ?? '';

    const country_name = countryRow?.name ?? '';

    const gst_percent_text =
      (g as any).guide_gst != null && Number((g as any).guide_gst) !== 0
        ? `${Number((g as any).guide_gst)}%`
        : '';

    const preferredForId = Number((g as any).guide_preffered_for ?? 0);
    const preferred_for_label =
      preferredForId === 1
        ? 'Hotspot'
        : preferredForId === 2
        ? 'Activity'
        : preferredForId === 3
        ? 'Itinerary'
        : '';

    const hotspot_places_label = hotspotRows
      .sort(
        (a, b) =>
          hotspotIds.indexOf(Number(a.hotspot_ID)) -
          hotspotIds.indexOf(Number(b.hotspot_ID)),
      )
      .map((x) => x.hotspot_name ?? '')
      .filter(Boolean)
      .join(', ');

    const activity_places_label = activityRows
      .sort(
        (a, b) =>
          activityIds.indexOf(Number(a.activity_id)) -
          activityIds.indexOf(Number(b.activity_id)),
      )
      .map((x) => x.activity_title ?? '')
      .filter(Boolean)
      .join(', ');

    const reviews = await this.prisma.dvi_guide_review_details.findMany({
      where: { guide_id: guideId, deleted: 0 },
      orderBy: [{ guide_review_id: 'desc' }],
      select: {
        guide_review_id: true,
        guide_id: true,
        guide_rating: true,
        guide_description: true,
        createdon: true,
      },
    });

    const reviewsOut = reviews.map((r) => {
      const ratingNum = clamp(Number(r.guide_rating ?? 0), 0, 5);
      const created = r.createdon ? new Date(r.createdon as any) : null;
      const createdon_text =
        created && Number.isFinite(created.getTime())
          ? `${pad2(created.getUTCDate())}-${pad2(created.getUTCMonth() + 1)}-${created.getUTCFullYear()} ${pad2(created.getUTCHours() % 12 || 12)}:${pad2(created.getUTCMinutes())} ${created.getUTCHours() >= 12 ? 'PM' : 'AM'}`
          : '';
      return {
        ...r,
        guide_rating_label: ratingNum > 0 ? '★'.repeat(ratingNum) : '',
        createdon_text,
      };
    });

    const slots = String((g as any).guide_available_slot ?? '')
      .split(',')
      .map((s) => Number(String(s).trim()))
      .filter((x) => Number.isFinite(x) && x > 0)
      .map((id) => GUIDE_SLOTS.find((s) => s.id === id)?.label || `Slot ${id}`);

    const preferredFor = String((g as any).guide_preffered_for ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    return {
      basic: g,
      view: {
        dob_text,
        gender_label,
        blood_group_label,
        language_label,
        state_name,
 city_name, // NEW
        country_name,
        gst_percent_text,
        preferred_for_label,
        hotspot_places_label,
        activity_places_label,
      },
      reviews: reviewsOut,
      slots,
      preferredFor,
    };
  }

  async previewOptions() {
    const states = await this.prisma.dvi_states.findMany({
      where: { deleted: 0 },
      orderBy: [{ country_id: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, country_id: true },
    });

    return {
      states: states.map((s) => ({
        id: Number(s.id),
        name: s.name,
        countryId: Number(s.country_id),
      })),
    };
  }

 // status / delete
  async toggleStatus(id: number, status: number) {
    id = ensureId(id);
    await this.prisma.dvi_guide_details.update({
      where: { guide_id: id },
      data: { status: (status ? 1 : 0) as any },
    });
    return { ok: true };
  }

  async softDelete(id: number) {
    id = ensureId(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.dvi_guide_details.update({
        where: { guide_id: id },
        data: { deleted: 1 as any, updatedon: new Date() as any },
      });

      await tx.dvi_guide_review_details.updateMany({
        where: { guide_id: id, deleted: 0 },
        data: { deleted: 1 as any, updatedon: new Date() as any },
      });

      await tx.dvi_guide_pricebook.updateMany({
        where: { guide_id: id, deleted: 0 },
        data: { deleted: 1 as any, updatedon: new Date() as any },
      });

      await tx.dvi_users.updateMany({
        where: { guide_id: id, deleted: 0 },
        data: { deleted: 1 as any, updatedon: new Date() as any, status: 0 as any },
      });
    });
    return { ok: true };
  }

 // convenience (add/edit orchestration)
  async saveFormStep1(input: GuideBasicDto) {
    return this.saveBasic(this.normalizeGuideBasicInput(input));
  }

  async getById(id: number) {
    id = ensureId(id);
    const form = await this.getForm(id);
    const payload = form.payload;
    const linkedUser = await this.prisma.dvi_users.findFirst({
      where: { guide_id: id, deleted: 0 },
      select: { roleID: true },
    });

    const toSlotPrice = (rows: any[], paxCount: number, slotType: number) => {
      const row = rows.find(
        (r) => Number(r.pax_count) === paxCount && Number(r.slot_type) === slotType,
      );
      if (!row) return 0;
      for (let d = 1; d <= 31; d++) {
        const key = `day_${d}` as keyof typeof row;
        const v = Number((row as any)[key] ?? 0);
        if (v > 0) return v;
      }
      return 0;
    };

    return {
      id: Number(payload.id ?? id),
      name: payload.guide_name ?? '',
      dateOfBirth: payload.guide_dob ?? '',
      bloodGroup: payload.guide_bloodgroup ?? '',
      gender: String(payload.guide_gender ?? ''),
      primaryMobile: payload.guide_primary_mobile_number ?? '',
      alternativeMobile: payload.guide_alternative_mobile_number ?? '',
      email: payload.guide_email ?? '',
      emergencyMobile: payload.guide_emergency_mobile_number ?? '',
      password: '',
      role: String(linkedUser?.roleID ?? ''),
      experience: Number(payload.guide_experience ?? 0),
      aadharCardNo: payload.guide_aadhar_number ?? '',
      languageProficiency: String(payload.guide_language_proficiency ?? ''),
      country: String(payload.guide_country ?? ''),
      state: String(payload.guide_state ?? ''),
      city: String(payload.guide_city ?? ''),
      gstType: String(payload.gst_type ?? ''),
      gstPercentage: String(payload.guide_gst ?? ''),
      availableSlots: (payload.guide_available_slot ?? []).map((x) => `slot${x}`),
      bankDetails: {
        bankName: payload.guide_bank_name ?? '',
        branchName: payload.guide_bank_branch_name ?? '',
        ifscCode: payload.guide_ifsc_code ?? '',
        accountNumber: payload.guide_account_number ?? '',
        confirmAccountNumber: payload.guide_account_number ?? '',
      },
      preferredFor: {
        hotspot: Number(payload.guide_preffered_for ?? 0) === 1,
        activity: Number(payload.guide_preffered_for ?? 0) === 2,
        itinerary: Number(payload.guide_preffered_for ?? 0) === 3,
      },
      hotspotPlaces: String(payload.applicable_hotspot_places ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      activityPlaces: String(payload.applicable_activity_places ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      pricebook: {
        startDate: '',
        endDate: '',
        pax1to5: {
          slot1: toSlotPrice(form.pricebook, 1, 1),
          slot2: toSlotPrice(form.pricebook, 1, 2),
          slot3: toSlotPrice(form.pricebook, 1, 3),
        },
        pax6to14: {
          slot1: toSlotPrice(form.pricebook, 2, 1),
          slot2: toSlotPrice(form.pricebook, 2, 2),
          slot3: toSlotPrice(form.pricebook, 2, 3),
        },
        pax15to40: {
          slot1: toSlotPrice(form.pricebook, 3, 1),
          slot2: toSlotPrice(form.pricebook, 3, 2),
          slot3: toSlotPrice(form.pricebook, 3, 3),
        },
      },
      reviews: (form.reviews ?? []).map((r: any) => ({
        id: String(r.guide_review_id),
        rating: Number(r.guide_rating ?? 0),
        description: String(r.guide_description ?? ''),
        createdOn: r.createdon ? new Date(r.createdon).toLocaleString('en-GB') : '',
      })),
      status: Number(payload.status ?? 1) === 1 ? 1 : 0,
    };
  }

  async saveFormStep2AndPreview(pricing: GuidePricebookSaveDto) {
    await this.savePricebook(pricing);
    return this.getPreview(pricing.guide_id);
  }

 // Dropdown Data (Service)

/** Role dropdown dvi_rolemenu.role_name */
async getRolesDropdown() {
  const rows = await this.prisma.dvi_rolemenu.findMany({
    where: { deleted: 0, status: 1 },
    select: { role_ID: true, role_name: true },
    orderBy: { role_name: 'asc' },
  });
  return rows.map((r) => ({
    id: r.role_ID,
    name: r.role_name,
    label: r.role_name,
    role_id: r.role_ID,
    role_name: r.role_name,
  }));
}

/** Language Proficiency dropdown dvi_language.language */
async getLanguagesDropdown() {
  const rows = await this.prisma.dvi_language.findMany({
    where: { status: 1 },
    select: { language_id: true, language: true },
    orderBy: { language: 'asc' },
  });
  return rows.map((r) => ({
    id: r.language_id,
    name: r.language,
    label: r.language,
    language_id: r.language_id,
    language: r.language,
  }));
}

/** Country dropdown dvi_country (assuming column name `country`) */
async getCountriesDropdown() {
  const rows = await this.prisma.dvi_countries.findMany({
    where: { deleted: 0, status: 1 },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    label: r.name,
    country_id: r.id,
    country_name: r.name,
  }));
}

/** State dropdown (dependent) dvi_state.state filtered by country_id */
async getStatesDropdown(countryId: number) {
  if (!countryId || countryId <= 0) {
    throw new BadRequestException('countryId is required');
  }
  const rows = await this.prisma.dvi_states.findMany({
    where: { deleted: 0, country_id: countryId },
    select: { id: true, name: true, country_id: true },
    orderBy: { name: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    label: r.name,
    state_id: r.id,
    state_name: r.name,
    country_id: r.country_id,
  }));
}

/** City dropdown (dependent) dvi_city.city filtered by state_id */
async getCitiesDropdown(stateId: number) {
  if (!stateId || stateId <= 0) {
    throw new BadRequestException('stateId is required');
  }
  const rows = await this.prisma.dvi_cities.findMany({
    where: { deleted: 0, state_id: stateId },
    select: { id: true, name: true, state_id: true },
    orderBy: { name: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    label: r.name,
    city_id: r.id,
    city_name: r.name,
    state_id: r.state_id,
  }));
}

/** GST Type dropdown static mapping: Included=1, Excluded=2 */
async getGstTypesDropdown() {
  return [
    { value: 1, label: 'Included' },
    { value: 2, label: 'Excluded' },
  ];
}

/** GST% dropdown dvi_gst_setting.gst_title */
async getGstPercentagesDropdown() {
  const rows = await this.prisma.dvi_gst_setting.findMany({
    where: { deleted: 0, status: 1 },
    select: { gst_setting_id: true, gst_title: true },
    orderBy: { gst_title: 'asc' },
  });
 // Expect gst_title like "5%", "12%", etc.
  return rows.map((r) => ({
    id: r.gst_setting_id,
    name: r.gst_title,
    label: r.gst_title,
    gst_setting_id: r.gst_setting_id,
    gst_title: r.gst_title,
  }));
}

/** Hotspot Place dropdown dvi_hotspot_place.hotspot_name */
async getHotspotPlacesDropdown() {
  const rows = await this.prisma.dvi_hotspot_place.findMany({
    where: { deleted: 0, status: 1 },
    select: { hotspot_ID: true, hotspot_name: true },
    orderBy: { hotspot_name: 'asc' },
  });
  return rows.map((r) => ({
    id: r.hotspot_ID,
    name: r.hotspot_name,
    label: r.hotspot_name,
    hotspot_ID: r.hotspot_ID,
    hotspot_name: r.hotspot_name,
  }));
}

/** Activity dropdown dvi_activity.activity_title */
async getActivitiesDropdown() {
  const rows = await this.prisma.dvi_activity.findMany({
    where: { deleted: 0, status: 1 },
    select: { activity_id: true, activity_title: true },
    orderBy: { activity_title: 'asc' },
  });
  return rows.map((r) => ({
    id: r.activity_id,
    name: r.activity_title,
    label: r.activity_title,
    activity_id: r.activity_id,
    activity_title: r.activity_title,
  }));
}

/**
 * All dropdowns in one call (optionally dependent lists via query input).
 * Pass `countryId` and/or `stateId` to get dependent lists scoped properly.
 */
async getAllDropdowns(params?: { countryId?: number; stateId?: number }) {
  const { countryId, stateId } = params ?? {};
  const [
    roles,
    languages,
    countries,
    gstTypes,
    gstPercentages,
    hotspots,
    activities,
  ] = await Promise.all([
    this.getRolesDropdown(),
    this.getLanguagesDropdown(),
    this.getCountriesDropdown(),
    this.getGstTypesDropdown(),
    this.getGstPercentagesDropdown(),
    this.getHotspotPlacesDropdown(),
    this.getActivitiesDropdown(),
  ]);

  const states = countryId ? await this.getStatesDropdown(countryId) : [];
  const cities = stateId ? await this.getCitiesDropdown(stateId) : [];

  return {
    roles,
    languages,
    countries,
    states,
    cities,
    gstTypes,
    gstPercentages,
    hotspots,
    activities,
  };
}

async checkGuideEmailDuplicate(input: {
  guide_email_id?: string;
  old_guide_email_id?: string;
}) {
  const email = String(input.guide_email_id ?? '').trim().toLowerCase();
  const oldEmail = String(input.old_guide_email_id ?? '').trim().toLowerCase();

  if (!email || (oldEmail && oldEmail === email)) {
    return { exists: false };
  }

  const [guideHit, userHit] = await Promise.all([
    this.prisma.dvi_guide_details.findFirst({
      where: {
        deleted: 0,
        guide_email: {
          equals: email,
        } as any,
      },
      select: { guide_id: true },
    }),
    this.prisma.dvi_users.findFirst({
      where: {
        deleted: 0,
        useremail: {
          equals: email,
        } as any,
      },
      select: { userID: true },
    }),
  ]);

  return { exists: Boolean(guideHit || userHit), success: !(guideHit || userHit) };
}
}
