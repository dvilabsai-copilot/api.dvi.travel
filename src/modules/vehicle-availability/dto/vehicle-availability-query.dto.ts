// FILE: src/modules/vehicle-availability/dto/vehicle-availability-query.dto.ts

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, Matches } from 'class-validator';

function toNumberArray(value: unknown): number[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const items = Array.isArray(value) ? value : [value];
  const numbers = items
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
  return numbers.length > 0 ? numbers : undefined;
}

function toStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const items = Array.isArray(value) ? value : [value];
  const strings = items
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0);
  return strings.length > 0 ? strings : undefined;
}

export class VehicleAvailabilityQueryDto {
  @ApiPropertyOptional({
    description: 'Inclusive start date in YYYY-MM-DD (defaults to first day of current month)',
    example: '2025-11-01',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateFrom?: string;

  @ApiPropertyOptional({
    description: 'Inclusive end date in YYYY-MM-DD (defaults to last day of current month)',
    example: '2025-11-30',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateTo?: string;

  @ApiPropertyOptional({
    description: 'Filter by vendor id (like PHP filter_by_vendor_id)',
    type: Number,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  vendorId?: number;

  @ApiPropertyOptional({
    description: 'PHP parity: multiple vendor ids',
    type: [Number],
  })
  @IsOptional()
  @Transform(({ value }) => toNumberArray(value))
  @IsArray()
  @IsInt({ each: true })
  vendorIds?: number[];

  @ApiPropertyOptional({
    description: 'Optional filter by vehicle type id',
    type: Number,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  vehicleTypeId?: number;

  @ApiPropertyOptional({
    description: 'PHP parity: multiple vendor vehicle type ids',
    type: [Number],
  })
  @IsOptional()
  @Transform(({ value }) => toNumberArray(value))
  @IsArray()
  @IsInt({ each: true })
  vehicleTypeIds?: number[];

  @ApiPropertyOptional({
    description: 'Optional filter by agent id',
    type: Number,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  agentId?: number;

  @ApiPropertyOptional({
    description: 'PHP parity: multiple agent ids',
    type: [Number],
  })
  @IsOptional()
  @Transform(({ value }) => toNumberArray(value))
  @IsArray()
  @IsInt({ each: true })
  agentIds?: number[];

  @ApiPropertyOptional({
    description: 'Optional exact route-location label filter',
    type: String,
  })
  @IsOptional()
  @IsString()
  locationLabel?: string;

  @ApiPropertyOptional({
    description: 'PHP parity: multiple exact route-location labels',
    type: [String],
  })
  @IsOptional()
  @Transform(({ value }) => toStringArray(value))
  @IsArray()
  @IsString({ each: true })
  locationLabels?: string[];

  @ApiPropertyOptional({
    description: 'Alias for locationLabel (frontend backward compatibility)',
    type: String,
  })
  @IsOptional()
  @IsString()
  locationId?: string;
}
