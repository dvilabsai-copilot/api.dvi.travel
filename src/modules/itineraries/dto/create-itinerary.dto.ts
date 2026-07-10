import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
  IsISO8601,
  Min,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreatePlanDto {
  @ApiProperty({
    example: 0,
    required: false,
    description:
      'Optional. If >0, Nest will UPDATE that itinerary_plan_ID (PHP hidden_itinerary_plan_ID parity). If 0/absent, Nest will CREATE.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  itinerary_plan_id?: number;

  @ApiProperty({ example: 126 }) @IsInt() @Min(0) agent_id!: number;
  @ApiProperty({ example: 0 }) @IsInt() @Min(0) staff_id!: number;

  @ApiProperty({
    example: 0,
    description: 'Matches dvi_itinerary_plan_details.location_id (BigInt in DB)',
  })
  @IsInt()
  @Min(0)
  location_id!: number;

  @ApiProperty({ example: 'Chennai International Airport' })
  @IsString()
  arrival_point!: string;

  @ApiProperty({ example: 'Pondicherry' })
  @IsString()
  departure_point!: string;

  @ApiProperty({ example: 3, description: '1=Hotel, 2=Vehicle, 3=Both' })
  @IsInt()
  itinerary_preference!: number;

  @ApiProperty({ example: 2 }) @IsInt() itinerary_type!: number;

  @ApiProperty({ type: [Number], example: [13] })
  @IsArray()
  @Type(() => Number)
  preferred_hotel_category!: number[];

  @ApiProperty({ type: [String], example: ['24hr-business-center', '24hr-checkin'] })
  @IsArray()
  @Type(() => String)
  hotel_facilities!: string[];

  @ApiProperty({ example: '2025-11-29T12:00:00+05:30' })
  @IsISO8601()
  trip_start_date!: string;

  @ApiProperty({ example: '2025-12-01T12:00:00+05:30' })
  @IsISO8601()
  trip_end_date!: string;

  @ApiProperty({ example: '2025-11-29T12:00:00+05:30' })
  @IsISO8601()
  pick_up_date_and_time!: string;

  @ApiProperty({ example: 1 }) @IsInt() arrival_type!: number;
  @ApiProperty({ example: 1 }) @IsInt() departure_type!: number;

  @ApiProperty({ example: 2 }) @IsInt() no_of_nights!: number;
  @ApiProperty({ example: 3 }) @IsInt() no_of_days!: number;

  @ApiProperty({ example: 15000 }) @IsInt() budget!: number;

  @ApiProperty({ example: 0 }) @IsInt() entry_ticket_required!: number;
  @ApiProperty({ example: 0 }) @IsInt() guide_for_itinerary!: number;
  @ApiProperty({ example: 0 }) @IsInt() nationality!: number;

  @ApiProperty({ example: 1, required: false })
  @IsOptional()
  @IsInt()
  meal_plan_breakfast?: number;

  @ApiProperty({ example: 0, required: false })
  @IsOptional()
  @IsInt()
  meal_plan_lunch?: number;

  @ApiProperty({ example: 0, required: false })
  @IsOptional()
  @IsInt()
  meal_plan_dinner?: number;

  @ApiProperty({ example: 'CP', required: false })
  @IsOptional()
  @IsString()
  @Matches(/^(CP|EP|MAP|AP)$/)
  meal_plan_code?: string;

  @ApiProperty({
    example: 0,
    description: 'Never send null. Use 0 if unknown (PHP defaults to 0).',
  })
  @IsInt()
  food_type!: number;

  @ApiProperty({ example: 2 }) @IsInt() adult_count!: number;
  @ApiProperty({ example: 0 }) @IsInt() child_count!: number;
  @ApiProperty({ example: 0 }) @IsInt() infant_count!: number;

  @ApiProperty({ example: '' })
  @IsString()
  special_instructions!: string;

  @ApiProperty({
    example: 'DVI20260710',
    required: false,
    description:
      'Optional base quote for a suggested-route family. Backend will persist variants as ${base}-R{index}.',
  })
  @IsOptional()
  @IsString()
  route_family_base_quote_id?: string;

  @ApiProperty({
    example: 1,
    required: false,
    description:
      'Optional 1-based route family variant index for suggested-route creates.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  route_variant_index?: number;

  @ApiProperty({
    example: 3,
    required: false,
    description:
      'Optional total number of suggested route variants created in the same family.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  route_variant_count?: number;
}

export class CreateRouteDto {
  @ApiProperty({
    example: 0,
    required: false,
    description:
      'Optional. If >0, Nest will UPDATE that itinerary_route_ID (PHP hidden_itinerary_route_ID parity). If 0/absent, Nest will CREATE.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  itinerary_route_id?: number;

  @ApiProperty({ example: 'Chennai International Airport' })
  @IsString()
  location_name!: string;

  @ApiProperty({ example: 'Chennai' })
  @IsString()
  next_visiting_location!: string;

  @ApiProperty({
    example: '2025-11-29T00:00:00+05:30',
    description: 'ISO date-time; we store Date-only into DB',
  })
  @IsISO8601()
  itinerary_route_date!: string;

  @ApiProperty({ example: 1 })
  @IsInt()
  no_of_days!: number;

  @ApiProperty({ example: '', required: false })
  @IsOptional()
  @IsString()
  no_of_km?: string;

  @ApiProperty({ example: 1 })
  @IsInt()
  direct_to_next_visiting_place!: number;

  @ApiProperty({
    example: '',
    required: false,
    description: 'Empty string or comma-separated via names',
  })
  @IsOptional()
  @IsString()
  via_route?: string;

  @ApiProperty({ example: '08:00:00', required: false })
  @IsOptional()
  @IsString()
  route_start_time?: string;

  @ApiProperty({ example: '20:00:00', required: false })
  @IsOptional()
  @IsString()
  route_end_time?: string;

  @ApiProperty({
    type: () => [CreateViaRouteDto],
    required: false,
    description: 'Array of via route locations for this route segment',
    example: [{ itinerary_via_location_ID: 101, itinerary_via_location_name: 'Mahabalipuram' }]
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateViaRouteDto)
  via_routes?: CreateViaRouteDto[];
}

export class CreateViaRouteDto {
  @ApiProperty({ example: 101, description: 'Via location ID from dvi_stored_locations' })
  @IsInt()
  itinerary_via_location_ID!: number;

  @ApiProperty({ example: 'Mahabalipuram', description: 'Via location name' })
  @IsString()
  itinerary_via_location_name!: string;
}

export class CreateVehicleDto {
  @ApiProperty({
    example: 0,
    required: false,
    description:
      'Optional. If >0, Nest will UPDATE that vehicle_details_ID (PHP hidden_vehicle_details_ID parity). If 0/absent, Nest will CREATE.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  vehicle_details_id?: number;

  @ApiProperty({ example: 20 }) @IsInt() vehicle_type_id!: number;
  @ApiProperty({ example: 1 }) @IsInt() vehicle_count!: number;
}

export class CreateTravellerDto {
  @ApiProperty({ example: 1 }) @IsInt() room_id!: number;

  @ApiProperty({ example: 1, description: '1=Adult, 2=Child, 3=Infant' })
  @IsInt()
  traveller_type!: number;

  @ApiProperty({
    example: '8',
    required: false,
    description: 'Child age as string. Optional for non-child travellers.',
  })
  @IsOptional()
  @IsString()
  traveller_age?: string;

      @ApiProperty({
    example: 1,
    required: false,
    description: 'Child bed type (0=NA, 1=Without Bed, 2=With Bed).',
  })
  @IsOptional()
  @IsInt()
  child_bed_type?: number;

  @ApiProperty({
    example: 0,
    required: false,
    description:
      '1 when user chooses to proceed without extra bed subject to hotel approval.',
  })
  @IsOptional()
  @IsInt()
  child_extra_bed_hotel_approval_required?: number;
}

export class CreateItineraryDto {
  @ApiProperty({ type: () => CreatePlanDto })
  @ValidateNested()
  @Type(() => CreatePlanDto)
  plan!: CreatePlanDto;

  @ApiProperty({ type: () => [CreateRouteDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateRouteDto)
  routes!: CreateRouteDto[];

  @ApiProperty({ type: () => [CreateVehicleDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateVehicleDto)
  vehicles!: CreateVehicleDto[];

  @ApiProperty({ type: () => [CreateTravellerDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateTravellerDto)
  travellers!: CreateTravellerDto[];

  @ApiProperty({
    example: false,
    required: false,
    description: 'Whether the user explicitly answered the Day 1 previous-day hotel billing confirmation.',
  })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  previousDayBillingDecisionProvided?: boolean;

  @ApiProperty({
    example: false,
    required: false,
    description: 'If provided, whether the user confirmed previous-day billing for early Day 1 arrival.',
  })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  previousDayBillingConfirmed?: boolean;
}
