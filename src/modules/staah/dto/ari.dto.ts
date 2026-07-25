import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  ValidateIf,
} from 'class-validator';

export type AriDataEntryDto = Record<string, any>;

export class AriRequestDto {
  @IsString()
  @IsNotEmpty()
  propertyid: string;

  @IsString()
  @IsNotEmpty()
  room_id: string;

  @IsString()
  @IsNotEmpty()
  rate_id: string;

  @IsString()
  @IsOptional()
  currency?: string;

 // The final single ARI endpoint accepts read-style pull actions as well.
  @IsString()
  @IsOptional()
  @IsIn(['ARR_info', 'year_info_ARR'])
  action?: string;

  @IsString()
  @IsNotEmpty()
  apikey: string;

  @IsString()
  @IsOptional()
  trackingId?: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(['2'])
  version: string;

  @ValidateIf((value) => value.action === 'ARR_info')
  @IsDateString()
  @IsNotEmpty()
  from_date?: string;

  @ValidateIf((value) => value.action === 'ARR_info')
  @IsDateString()
  @IsNotEmpty()
  to_date?: string;

  @ValidateIf((value) => !value.action)
  @IsArray()
  @IsObject({ each: true })
  @Type(() => Object)
  data?: AriDataEntryDto[];
}

export class AriResponseDto {
  status: 'success' | 'fail';
  error_desc: string;
}