import { IsArray, IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class DefaultSlotDto {
  @IsString() @IsNotEmpty()
 start_time!: string; // "HH:MM[:SS]"

  @IsString() @IsNotEmpty()
 end_time!: string; // "HH:MM[:SS]"
}

class SpecialSlotDto {
  @IsString() @IsNotEmpty()
 date!: string; // "YYYY-MM-DD"

  @IsString() @IsNotEmpty()
  start_time!: string;

  @IsString() @IsNotEmpty()
  end_time!: string;
}

export class CreateActivityDto {
  @IsString() @IsNotEmpty()
  activity_title!: string;

  @IsInt()
  hotspot_id!: number;

  @IsInt()
  max_allowed_person_count!: number;

  @IsString() @IsOptional()
 activity_duration?: string; // "HH:MM[:SS]"

  @IsString() @IsOptional()
  @MaxLength(65535)
  activity_description?: string;

  @IsInt() @IsOptional()
  createdby?: number;

  @IsArray() @IsOptional()
  @IsString({ each: true })
  imageNames?: string[];

  @IsArray() @ValidateNested({ each: true }) @Type(() => DefaultSlotDto) @IsOptional()
  defaultSlots?: DefaultSlotDto[];

  @IsBoolean() @IsOptional()
  specialEnabled?: boolean;

  @IsArray() @ValidateNested({ each: true }) @Type(() => SpecialSlotDto) @IsOptional()
  specialSlots?: SpecialSlotDto[];
}
