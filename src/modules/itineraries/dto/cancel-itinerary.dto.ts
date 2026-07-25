import { IsNumber, IsOptional, IsBoolean, Min, Max, IsString, ValidateNested } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

// New structure for cancellation options
export class CancellationOptionsDto {
  @ApiProperty({ example: true, required: false, description: 'Cancel hotspot bookings' })
  @IsOptional()
  @IsBoolean()
  modify_hotspot?: boolean;

  @ApiProperty({ example: true, required: false, description: 'Cancel hotel bookings' })
  @IsOptional()
  @IsBoolean()
  modify_hotel?: boolean;

  @ApiProperty({ example: false, required: false, description: 'Cancel vehicle bookings' })
  @IsOptional()
  @IsBoolean()
  modify_vehicle?: boolean;

  @ApiProperty({ example: false, required: false, description: 'Cancel guide bookings' })
  @IsOptional()
  @IsBoolean()
  modify_guide?: boolean;

  @ApiProperty({ example: false, required: false, description: 'Cancel activity bookings' })
  @IsOptional()
  @IsBoolean()
  modify_activity?: boolean;
}

export class CancelItineraryDto {
  @ApiProperty({ example: 33960, description: 'Itinerary Plan ID' })
  @IsNumber()
  itinerary_plan_ID!: number;

  @ApiProperty({ example: 'Customer requested cancellation', description: 'Reason for cancellation' })
  @IsString()
  reason!: string;

  @ApiProperty({ example: 10, required: false, description: 'Cancellation percentage (0-100)' })
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(100)
  cancellation_percentage?: number;

  @ApiProperty({
    required: false,
    type: CancellationOptionsDto,
    description: 'Selective cancellation options for different components'
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CancellationOptionsDto)
  cancellation_options?: CancellationOptionsDto;

 // Legacy fields for backward compatibility
  @ApiProperty({ required: false, deprecated: true })
  @IsOptional()
  @IsBoolean()
  cancel_guide?: boolean;

  @ApiProperty({ required: false, deprecated: true })
  @IsOptional()
  @IsBoolean()
  cancel_hotspot?: boolean;

  @ApiProperty({ required: false, deprecated: true })
  @IsOptional()
  @IsBoolean()
  cancel_activity?: boolean;

  @ApiProperty({ required: false, deprecated: true })
  @IsOptional()
  @IsBoolean()
  cancel_hotel?: boolean;

  @ApiProperty({ required: false, deprecated: true })
  @IsOptional()
  @IsBoolean()
  cancel_vehicle?: boolean;
}
