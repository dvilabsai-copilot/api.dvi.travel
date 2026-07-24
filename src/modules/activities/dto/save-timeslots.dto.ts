import { IsArray, IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, ValidateNested } from 'class-validator';
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

export class SaveTimeSlotsDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => DefaultSlotDto) @IsOptional()
  defaultSlots?: DefaultSlotDto[];

  @IsBoolean() @IsOptional()
  specialEnabled?: boolean;

  @IsArray() @ValidateNested({ each: true }) @Type(() => SpecialSlotDto) @IsOptional()
  specialSlots?: SpecialSlotDto[];

  @IsInt() @IsOptional()
  createdby?: number;
}
