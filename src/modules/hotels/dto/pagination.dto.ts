import { Type } from 'class-transformer';
import { IsInt, IsIn, IsOptional, IsString } from 'class-validator';

export class PaginationQueryDto {
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  page: number = 1;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  limit: number = 10;

  @IsOptional()
  @IsString()
  search?: string;

 // In schema, state/city are strings on dvi_hotel
  @IsOptional()
  @IsString()
  hotel_state?: string;

  @IsOptional()
  @IsString()
  hotel_city?: string;

 // status is TinyInt (number) in schema
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  status?: number;

  @IsOptional()
  @IsString()
 sortBy?: string; // e.g., 'hotel_name' | 'hotel_code' | 'createdon'

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc' = 'asc';

  @IsOptional()
  @IsIn(['axisrooms', 'resavenue', 'staah'])
  provider?: 'axisrooms' | 'resavenue' | 'staah';
}
