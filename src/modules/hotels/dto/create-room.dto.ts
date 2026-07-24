import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * UI item coming from the Rooms form.
 */
export class UiRoomItemDto {
  @IsInt()
  hotel_id!: number;

  @IsOptional()
 room_type?: number | string; // can be id or label; we'll resolve

  @IsOptional()
  @IsString()
  room_type_name?: string;

  @IsOptional()
  @IsString()
  room_title?: string;

 // "1,2" or ["1","2"] or [1,2]
  @IsOptional()
  preferred_for?: string | string[] | number[];

  @IsOptional()
  @IsInt()
  no_of_rooms?: number;

 // 1/0
  @IsOptional()
  @IsInt()
  @IsIn([0, 1])
  ac_availability?: number;

  @IsOptional()
  @IsInt()
  @IsIn([0, 1])
  status?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  max_adult?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  max_children?: number;

 // "12:00 PM" or "12:00"
  @IsOptional()
  @IsString()
  check_in_time?: string;

  @IsOptional()
  @IsString()
  check_out_time?: string;

 // 1=Included, 2=Excluded
  @IsOptional()
  @IsInt()
  @IsIn([1, 2])
  gst_type?: number;

 // NOTE: UI may send number; DB column is String we'll stringify
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  gst_percentage?: number;

 // amenity ids
  @IsOptional()
  @IsArray()
  amenities?: Array<number | string>;

 // booleans in UI 1/0 in DB
  @IsOptional()
  @IsBoolean()
  food_breakfast?: boolean;

  @IsOptional()
  @IsBoolean()
  food_lunch?: boolean;

  @IsOptional()
  @IsBoolean()
  food_dinner?: boolean;
}

export class UiRoomsBulkDto {
  @ValidateNested({ each: true })
  @Type(() => UiRoomItemDto)
  @IsArray()
  items!: UiRoomItemDto[];
}

/** Shape that matches dvi_hotel_rooms */
export type DbRoomRow = {
  hotel_id: number;
  room_type_id: number | null;
  room_title: string | null;
 preferred_for: string | null; // "1,2"
 no_of_rooms_available: number; // from no_of_rooms
 air_conditioner_availability: number; // 1/0
 status: number; // 1/0
  total_max_adults: number;
  total_max_childrens: number;
 check_in_time: string | null; // "HH:MM:SS"
 check_out_time: string | null; // "HH:MM:SS"
 gst_type: number; // 1/2
 gst_percentage: string | null; // STRING
 inbuilt_amenities: string | null; // "1,2,3"
 breakfast_included: number; // 1/0
 lunch_included: number; // 1/0
 dinner_included: number; // 1/0
};

/* ============================ Helpers ============================ */

const toGstNum = (v: any): 1 | 2 => {
  if (v === 1 || v === '1' || String(v ?? '').toLowerCase().includes('include')) return 1;
  if (v === 2 || v === '2' || String(v ?? '').toLowerCase().includes('exclude')) return 2;
  return 1;
};

// "12:00 PM" | "12:00" "HH:MM:SS"
export const toTimeHHMMSS = (val?: string | null): string | null => {
  if (!val) return null;
  const s = String(val).trim();

 // "hh:mm AM/PM"
  const ampm = s.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const m = ampm[2];
    const p = ampm[3].toUpperCase();
    if (p === 'AM') h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
    return `${String(h).padStart(2, '0')}:${m}:00`;
  }

 // "HH:MM"
  const hm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const h = parseInt(hm[1], 10);
    const m = hm[2];
    return `${String(h).padStart(2, '0')}:${m}:00`;
  }

 // Already "HH:MM:SS"?
  if (/^\d{1,2}:\d{2}:\d{2}$/.test(s)) return s;

  return null;
};

const toCommaString = (v?: string | number | Array<string | number> | null) => {
  if (v == null) return null;
  if (Array.isArray(v)) {
    const arr = v.map((x) => String(x).trim()).filter(Boolean);
    return arr.length ? arr.join(',') : null;
    }
  const s = String(v).trim();
  return s || null;
};

/**
 * Main mapper UI → DB
 */
export function mapUiRoomToDbRow(
  ui: UiRoomItemDto,
  opts?: { roomTypeResolver?: (nameOrId: string | number) => number | null }
): DbRoomRow {
  let room_type_id: number | null = null;
  if (ui.room_type != null) {
    const asNum = Number(ui.room_type);
    if (Number.isFinite(asNum) && String(ui.room_type).trim() !== '') {
      room_type_id = asNum;
    } else if (opts?.roomTypeResolver) {
      room_type_id = opts.roomTypeResolver(ui.room_type as any);
    }
  }

  const preferred_for = toCommaString(ui.preferred_for);
  const inbuilt_amenities = Array.isArray(ui.amenities)
    ? ui.amenities
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n))
        .join(',') || null
    : null;

  const check_in_time = toTimeHHMMSS(ui.check_in_time);
  const check_out_time = toTimeHHMMSS(ui.check_out_time);

  return {
    hotel_id: ui.hotel_id,
    room_type_id,
    room_title: ui.room_title ?? null,
    preferred_for,
    no_of_rooms_available: Number(ui.no_of_rooms ?? 1),
    air_conditioner_availability: Number(ui.ac_availability ?? 0),
    status: Number(ui.status ?? 1),
    total_max_adults: Number(ui.max_adult ?? 0),
    total_max_childrens: Number(ui.max_children ?? 0),
    check_in_time,
    check_out_time,
    gst_type: toGstNum(ui.gst_type ?? 1),
    gst_percentage:
 ui.gst_percentage != null ? String(ui.gst_percentage) : null, // STRING
    inbuilt_amenities,
    breakfast_included: ui.food_breakfast ? 1 : 0,
    lunch_included: ui.food_lunch ? 1 : 0,
    dinner_included: ui.food_dinner ? 1 : 0,
  };
}

export function mapUiRoomsToDbRows(
  items: UiRoomItemDto[],
  opts?: { roomTypeResolver?: (nameOrId: string | number) => number | null }
): DbRoomRow[] {
  return items.map((it) => mapUiRoomToDbRow(it, opts));
}
