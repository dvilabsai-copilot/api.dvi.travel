import { Transform, Type } from 'class-transformer';
import { IsInt, IsIn, IsOptional, IsString, Max, Min } from 'class-validator';

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

  @IsOptional()
  @Type(() => Number)
  @Transform(({ obj, key, value }) => obj[key] === '' ? undefined : value)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  categoryId?: number;

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
  @IsIn(['AX', 'RS', 'ST', 'axisrooms', 'resavenue', 'staah'])
  provider?: 'AX' | 'RS' | 'ST' | 'axisrooms' | 'resavenue' | 'staah';
}
