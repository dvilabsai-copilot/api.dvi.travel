import {
  IsIn,
  IsNotEmpty,
  IsArray,
  IsString,
  IsDateString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class RateEntryDto {
  @IsDateString()
  start_date: string;

  @IsDateString()
  end_date: string;

  [key: string]: any;
}

export class RateUpdateRequestDto {
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
  @IsNotEmpty()
  apikey: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(['2'])
  version: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RateEntryDto)
  data: RateEntryDto[];
}

export class RateUpdateResponseDto {
  status: 'success' | 'fail';
  error_desc: string;
}
