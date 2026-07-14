// FILE: src/modules/itinerary/dto/latest-itinerary-query.dto.ts

import { Transform } from "class-transformer";
import { IsInt, IsOptional, IsString, Min } from "class-validator";

export class LatestItineraryQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  // Alias retained for existing clients that used the old helper name.
  @IsOptional()
  @IsString()
  search_value?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  draw?: number;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  start?: number;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  length?: number;

  @IsOptional()
  @IsString()
  start_date?: string; // DD/MM/YYYY

  @IsOptional()
  @IsString()
  end_date?: string; // DD/MM/YYYY

  @IsOptional()
  @IsString()
  source_location?: string;

  @IsOptional()
  @IsString()
  destination_location?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  agent_id?: number;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  staff_id?: number;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  guide_id?: number;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  vendor_id?: number;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  include_cancelled?: boolean;
}
