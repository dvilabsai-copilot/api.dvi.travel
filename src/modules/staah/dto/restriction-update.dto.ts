import { IsIn, IsNotEmpty, ValidateNested, IsArray, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class RestrictionEntryDto {
  @IsString()
  @IsNotEmpty()
  start_date: string;

  @IsString()
  @IsNotEmpty()
  end_date: string;

  @IsString()
  @IsNotEmpty()
  type: string;

  @IsString()
  @IsNotEmpty()
  value: string;
}

export class RestrictionUpdateRequestDto {
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
  @Type(() => RestrictionEntryDto)
  data: RestrictionEntryDto[];
}

export class RestrictionUpdateResponseDto {
  status: 'success' | 'fail';
  error_desc: string;
}
