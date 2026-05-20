import {
  IsIn,
  IsNotEmpty,
  IsArray,
  IsNumber,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class InventoryEntryDto {
  @IsString()
  @IsNotEmpty()
  start_date: string;

  @IsString()
  @IsNotEmpty()
  end_date: string;

  @IsNumber()
  free: number;
}

export class InventoryUpdateRequestDto {
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
  @Type(() => InventoryEntryDto)
  data: InventoryEntryDto[];
}

export class InventoryUpdateResponseDto {
  status: 'success' | 'fail';
  error_desc: string;
}
