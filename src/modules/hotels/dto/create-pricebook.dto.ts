// FILE: src/modules/hotels/dto/create-pricebook.dto.ts
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  ValidateIf,
} from 'class-validator';
import { PartialType } from '@nestjs/mapped-types';

/* ---------- small helpers to coerce inputs safely ---------- */
const toInt = (v: any) =>
  v === '' || v === null || v === undefined
    ? undefined
    : Number.isFinite(Number(v))
    ? parseInt(String(v), 10)
    : v;

const toFloat = (v: any) =>
  v === '' || v === null || v === undefined
    ? undefined
    : Number.isFinite(Number(v))
    ? parseFloat(String(v))
    : v;

/**
 * CreatePriceBookDto
 * - Works for simple month-based room pricebooks (per-day prices),
 *   or a simple single-price payload.
 * - Numeric strings are allowed; they’re coerced to numbers.
 * - createdby defaults to 1, status defaults to 1.
 */
export class CreatePriceBookDto {
  @Transform(({ value }) => toInt(value))
  @IsInt()
  hotel_id!: number;

  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  room_type_id?: number;

 /** Optional label like "Peak", "Off", etc. */
  @IsOptional()
  @IsString()
  season?: string;

 /** If your schema is month-granular, include these (strings to match DB). */
  @IsOptional()
  @IsString()
 year?: string; // e.g. "2025"

  @IsOptional()
  @IsString()
 month?: string; // e.g. "11" or "NOV" depending on your table

 /** Simple one-shot price (if you dont want to send per-day fields). */
  @ValidateIf((o) =>
    [o.day_1, o.day_2, o.day_3, o.day_4, o.day_5, o.day_6, o.day_7, o.day_8, o.day_9, o.day_10,
     o.day_11, o.day_12, o.day_13, o.day_14, o.day_15, o.day_16, o.day_17, o.day_18, o.day_19, o.day_20,
     o.day_21, o.day_22, o.day_23, o.day_24, o.day_25, o.day_26, o.day_27, o.day_28, o.day_29, o.day_30, o.day_31]
      .every((v) => v === undefined),
  )
  @IsOptional()
  @Transform(({ value }) => toFloat(value))
  @IsNumber()
  price?: number;

 /** Optional granular fields often used by your UI for room pricebook */
  @IsOptional()
  @Transform(({ value }) => toFloat(value))
  @IsNumber()
  roomPrice?: number;

  @IsOptional()
  @Transform(({ value }) => toFloat(value))
  @IsNumber()
  extraBed?: number;

  @IsOptional()
  @Transform(({ value }) => toFloat(value))
  @IsNumber()
  childWithBed?: number;

  @IsOptional()
  @Transform(({ value }) => toFloat(value))
  @IsNumber()
  childWithoutBed?: number;

 /** Per-day prices (month view). Send any subset you need. */
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_1?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_2?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_3?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_4?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_5?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_6?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_7?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_8?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_9?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_10?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_11?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_12?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_13?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_14?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_15?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_16?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_17?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_18?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_19?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_20?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_21?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_22?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_23?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_24?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_25?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_26?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_27?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_28?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_29?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_30?: number;
  @IsOptional() @Transform(({ value }) => toFloat(value)) @IsNumber() day_31?: number;

 /** Auditing / flags */
  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
 createdby: number = 1; // default to 1 as requested

  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  status: number = 1;
}

export class UpdatePriceBookDto extends PartialType(CreatePriceBookDto) {}
