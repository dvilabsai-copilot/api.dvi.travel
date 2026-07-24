
// FILE: src/modules/guides/dto/guide-create.dto.ts
import {
  IsArray,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';

export class GuideBankDto {
  @IsOptional() @IsString() bank_name?: string;
  @IsOptional() @IsString() branch_name?: string;
  @IsOptional() @IsString() ifsc_code?: string;
  @IsOptional() @IsString() account_number?: string;
  @IsOptional() @IsString() confirm_account_number?: string;
}

export class GuidePricebookRowDto {
  @IsString() pax_label!: '1-5' | '6-14' | '15-40';
 @IsOptional() @IsNumber() slot1_price?: number; // 91
 @IsOptional() @IsNumber() slot2_price?: number; // 94
 @IsOptional() @IsNumber() slot3_price?: number; // 69
}

export class GuidePricebookDto {
  @IsOptional() @IsDateString() start_date?: string;
  @IsOptional() @IsDateString() end_date?: string;

  @IsArray() @ValidateNested({ each: true }) @Type(() => GuidePricebookRowDto)
  rows!: GuidePricebookRowDto[];
}

export class GuideReviewCreateDto {
 @IsInt() @Min(1) rating!: number; // 1..5
  @IsString() @IsNotEmpty() feedback!: string;
}

export class GuideCreateDto {
 // Basic
  @IsString() @IsNotEmpty() guide_name!: string;
  @IsDateString() dob!: string;
  @IsString() @IsNotEmpty() blood_group!: string;
  @IsString() @IsIn(['Male', 'Female', 'Other']) gender!: string;

 // Contacts
  @IsString() @IsNotEmpty() mobile_primary!: string;
  @IsOptional() @IsString() mobile_alt?: string;
  @IsEmail() email!: string;
  @IsOptional() @IsString() emergency_mobile?: string;

 // Auth / Role
  @IsString() @IsNotEmpty() password!: string;
 @IsString() @IsNotEmpty() role!: string; // map to role id or keep string

 // KYC & meta
  @IsOptional() @IsString() aadhar_no?: string;
  @IsOptional() @IsInt() @Min(0) experience_years?: number;
 @IsArray() @IsString({ each: true }) languages!: string[]; // list of language names or ids

 // Geo + Tax
  @IsInt() country_id!: number;
  @IsInt() state_id!: number;
  @IsInt() city_id!: number;
 @IsString() @IsNotEmpty() gst_type!: string; // Included/Excluded/N.A.
 @IsNumber() gst_percent!: number; // 18, 5, etc.

 // Availability Slots (Slot 1/2/3 as per PHP)
  @IsArray() @IsInt({ each: true }) slot_ids!: number[];

 // Preferred For
  @IsBoolean() @Type(() => Boolean) preferred_hotspot!: boolean;
  @IsBoolean() @Type(() => Boolean) preferred_activity!: boolean;
  @IsBoolean() @Type(() => Boolean) preferred_itinerary!: boolean;

 // Bank
  @ValidateNested() @Type(() => GuideBankDto)
  bank!: GuideBankDto;

 // Pricebook (Step 2)
  @IsOptional() @ValidateNested() @Type(() => GuidePricebookDto)
  pricebook?: GuidePricebookDto;

 // Reviews (Step 3) optional initial seed
  @IsOptional() @ValidateNested({ each: true }) @Type(() => GuideReviewCreateDto)
  reviews?: GuideReviewCreateDto[];
}
