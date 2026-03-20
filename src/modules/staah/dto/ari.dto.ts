import { Type } from 'class-transformer';
import { IsArray, IsIn, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

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

  @IsArray()
  @IsObject({ each: true })
  @Type(() => Object)
  data: AriDataEntryDto[];
}

export class AriResponseDto {
  status: 'success' | 'fail';
  error_desc: string;
}