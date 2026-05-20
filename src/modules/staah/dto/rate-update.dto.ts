import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsString,
} from 'class-validator';

export type RateEntryDto = Record<string, any>;

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
  data: RateEntryDto[];
}

export class RateUpdateResponseDto {
  status: 'success' | 'fail';
  error_desc: string;
}
