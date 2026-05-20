// FILE: src/modules/vehicle-availability/dto/vehicle-availability-query.dto.ts

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches } from 'class-validator';

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
    description: 'Optional filter by vehicle type id',
    type: Number,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  vehicleTypeId?: number;

  @ApiPropertyOptional({
    description: 'Optional filter by agent id',
    type: Number,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  agentId?: number;

  @ApiPropertyOptional({
    description: 'Optional exact route-location label filter',
    type: String,
  })
  @IsOptional()
  @IsString()
  locationLabel?: string;

  @ApiPropertyOptional({
    description: 'Alias for locationLabel (frontend backward compatibility)',
    type: String,
  })
  @IsOptional()
  @IsString()
  locationId?: string;
}
