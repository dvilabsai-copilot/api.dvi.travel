import { IsArray, IsBoolean, IsDateString, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class UpdateTboMasterHotelDto {
  @IsOptional() @IsString() name?: string | null;
  @IsOptional() @IsString() address?: string | null;
  @IsOptional() @IsString() city?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(5) rating?: number | null;
  @IsOptional() @IsString() imageUrl?: string | null;
  @IsOptional()
  @IsString()
  description?: string | null;
  @IsOptional() @IsString() checkInTime?: string | null;
  @IsOptional() @IsString() checkOutTime?: string | null;
  @IsOptional() @IsArray() @IsString({ each: true }) facilities?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) amenities?: string[];
  @IsOptional() @IsArray() reviews?: Array<Record<string, unknown>>;
  @IsOptional() @IsString() latitude?: string | null;
  @IsOptional() @IsString() longitude?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(1) status?: number;
  @IsOptional() @IsBoolean() isPriority?: boolean;
}

export class TboMasterPricePreviewDto {
  @IsDateString()
  checkIn!: string;

  @IsDateString()
  checkOut!: string;

  @IsInt()
  @Min(1)
  @Max(6)
  rooms!: number;

  @IsInt()
  @Min(1)
  adults!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  children?: number;

  @IsOptional()
  @IsString()
  mealPlanCode?: string;
}
