// FILE: src/modules/hotspots/dto/hotspot-create.dto.ts

import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// ---- Nested DTOs kept minimal ----
export class OperatingSlotDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  id?: number; // hotspot_timing_ID

  @IsString()
  start!: string; // "HH:mm"

  @IsString()
  end!: string;   // "HH:mm"
}

export class OperatingDayDto {
  @IsOptional() @IsBoolean()
  open24hrs?: boolean;

  @IsOptional() @IsBoolean()
  closed24hrs?: boolean;

  @IsArray() @ValidateNested({ each: true }) @Type(() => OperatingSlotDto)
  slots!: OperatingSlotDto[];
}

export class ParkingChargeDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  id?: number; // vehicle_parking_charge_ID

  @Type(() => Number) @IsInt() @Min(1)
  vehicleTypeId!: number;

  @Type(() => Number) @IsNumber() @Min(0)
  charge!: number;
}

export class GalleryItemDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  id?: number; // hotspot_gallery_details_id

  @IsString()
  name!: string; // stored filename

  @IsOptional() @IsBoolean()
  delete?: boolean;
}

// ---- Create payload covering the whole form ----
export class HotspotCreateDto {
  // Master
  @IsString()
  hotspot_name!: string;

  @IsOptional() @IsString()
  hotspot_type?: string | null;

  @IsOptional() @Type(() => Number) @IsNumber()
  hotspot_rating?: number | null;

  @IsOptional() @Type(() => Number) @IsNumber()
  hotspot_priority?: number | null;

  @IsOptional() @IsString()
  hotspot_latitude?: string | null;

  @IsOptional() @IsString()
  hotspot_longitude?: string | null;

  @IsOptional() @IsString()
  hotspot_address?: string | null;

  @IsOptional() @IsString()
  hotspot_landmark?: string | null;

  @IsOptional() @IsString()
  hotspot_description?: string | null;

  @IsOptional() @IsString()
  hotspot_video_url?: string | null;

  @IsOptional() @IsString()
  hotspot_duration?: string | null;

  @IsOptional() @Type(() => Number) @IsInt()
  status?: number | null;   // default 1

  @IsOptional() @Type(() => Number) @IsInt()
  deleted?: number | null;  // default 0

  // Entry costs
  @IsOptional() @Type(() => Number) @IsNumber()
  hotspot_adult_entry_cost?: number | null;

  @IsOptional() @Type(() => Number) @IsNumber()
  hotspot_child_entry_cost?: number | null;

  @IsOptional() @Type(() => Number) @IsNumber()
  hotspot_infant_entry_cost?: number | null;

  @IsOptional() @Type(() => Number) @IsNumber()
  hotspot_foreign_adult_entry_cost?: number | null;

  @IsOptional() @Type(() => Number) @IsNumber()
  hotspot_foreign_child_entry_cost?: number | null;

  @IsOptional() @Type(() => Number) @IsNumber()
  hotspot_foreign_infant_entry_cost?: number | null;

  // Locations (multi-select) -> pipe-joined in service
  @IsOptional() @IsArray() @IsString({ each: true })
  hotspot_location_list?: string[];

  // Children
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ParkingChargeDto)
  parkingCharges?: ParkingChargeDto[];

  /** Keys like "mon","tue" or "Monday" → { open24hrs, closed24hrs, slots[] } */
  @IsOptional()
  operatingHours?: Record<string, OperatingDayDto>;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => GalleryItemDto)
  gallery?: GalleryItemDto[];
}
