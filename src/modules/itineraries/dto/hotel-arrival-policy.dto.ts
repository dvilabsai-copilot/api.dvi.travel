import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class HotelArrivalPolicyRequestDto {
  @ApiPropertyOptional({ example: 33977 })
  @IsOptional()
  @IsInt()
  @Min(1)
  itineraryPlanId?: number;

  @ApiPropertyOptional({ example: 207447 })
  @IsOptional()
  @IsInt()
  @Min(1)
  itineraryRouteId?: number;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  routeDayNumber?: number;

  @ApiPropertyOptional({ example: '2026-05-15' })
  @IsOptional()
  @IsString()
  routeDate?: string;

  @ApiPropertyOptional({ example: '2026-05-15T06:30:00+05:30' })
  @IsOptional()
  @IsString()
  arrivalDateTime?: string;

  @ApiPropertyOptional({ example: 'Madurai Airport' })
  @IsOptional()
  @IsString()
  arrivalCityName?: string;

  @ApiPropertyOptional({ example: 'Madurai Airport' })
  @IsOptional()
  @IsString()
  routeSourceCityName?: string;

  @ApiPropertyOptional({ example: 'Madurai' })
  @IsOptional()
  @IsString()
  nightStayCityName?: string;

  @ApiPropertyOptional({ example: 101 })
  @IsOptional()
  @IsInt()
  @Min(1)
  arrivalCityId?: number;

  @ApiPropertyOptional({ example: 101 })
  @IsOptional()
  @IsInt()
  @Min(1)
  routeSourceCityId?: number;

  @ApiPropertyOptional({ example: 101 })
  @IsOptional()
  @IsInt()
  @Min(1)
  nightStayCityId?: number;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  previousDayBillingDecisionProvided?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  previousDayBillingConfirmed?: boolean;
}

export class HotelArrivalPolicyResponseDto {
  @ApiProperty({ example: 'RESOLVED' })
  resolutionStatus!: string;

  @ApiProperty({ example: 'MORNING_09_TO_1259' })
  arrivalWindow!: string;

  @ApiProperty({ example: false })
  requiresPreviousDayBillingConfirmation!: boolean;

  @ApiProperty({ example: true })
  shouldOpenHotelSearch!: boolean;

  @ApiProperty({ example: 'SAME_DAY' })
  hotelSearchMode!: string;

  @ApiProperty({ example: 'DIRECT_SIGHTSEEING' })
  hotelFlowAction!: string;

  @ApiProperty({ example: true })
  deferHotelToEndOfDay!: boolean;

  @ApiProperty({ example: false })
  goToHotelImmediately!: boolean;

  @ApiProperty({ example: '2026-05-15' })
  effectiveCheckInDate!: string;

  @ApiProperty({ example: '2026-05-16' })
  effectiveCheckOutDate!: string;

  @ApiProperty({ example: true })
  sameCityArrival!: boolean;

  @ApiProperty({ example: true })
  normalizationApplied!: boolean;

  @ApiPropertyOptional({ example: 'Customer arrives after 9 AM; start sightseeing and check in end of day.' })
  message?: string;

  @ApiPropertyOptional({
    example: {
      rawArrivalDateTime: '2026-05-15T06:30:00+05:30',
      normalizedArrivalCity: 'madurai',
      normalizedNightStayCity: 'madurai',
      decisionSource: 'plan+route',
    },
  })
  debug?: Record<string, unknown>;
}
