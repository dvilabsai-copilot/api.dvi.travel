import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsNumber, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

// Response DTO: all fields returned by location endpoints
export class LocationResponseDto {
  @ApiProperty() location_ID!: number;
  @ApiProperty() source_location!: string;
  @ApiProperty() source_city!: string;
  @ApiProperty() source_state!: string;
  @ApiProperty() source_latitude!: string;
  @ApiProperty() source_longitude!: string;
  @ApiProperty() destination_location!: string;
  @ApiProperty() destination_city!: string;
  @ApiProperty() destination_state!: string;
  @ApiProperty() destination_latitude!: string;
  @ApiProperty() destination_longitude!: string;
  @ApiProperty() distance_km!: number;
  @ApiProperty() duration_text!: string;
  @ApiProperty({ nullable: true }) location_description!: string | null;
}

// CREATE DTO: source required, destination optional
export class CreateLocationDto {
  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  source_location!: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  source_city!: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  source_state!: string;

  @ApiProperty({ description: 'Numeric value as string' })
  @IsNotEmpty()
  @IsString()
  source_latitude!: string;

  @ApiProperty({ description: 'Numeric value as string' })
  @IsNotEmpty()
  @IsString()
  source_longitude!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  destination_location?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  destination_city?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  destination_state?: string;

  @ApiProperty({ required: false, description: 'Numeric value as string' })
  @IsOptional()
  @IsString()
  destination_latitude?: string;

  @ApiProperty({ required: false, description: 'Numeric value as string' })
  @IsOptional()
  @IsString()
  destination_longitude?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  duration_text?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  location_description?: string | null;
}

// UPDATE DTO: All fields optional (partial)
export class UpdateLocationDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  source_location?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  source_city?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  source_state?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  source_latitude?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  source_longitude?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  destination_location?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  destination_city?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  destination_state?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  destination_latitude?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  destination_longitude?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  distance_km?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  duration_text?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  location_description?: string | null;
}

export class ModifyLocationNameDto {
  @ApiProperty({ enum: ['source', 'destination'] })
  @IsNotEmpty()
  @IsString()
  scope!: 'source' | 'destination';

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  new_name!: string;
}

// Toll Response DTO: single toll charge object
export class TollResponseDto {
  @ApiProperty() vehicle_type_id!: number;
  @ApiProperty() vehicle_type_name!: string;
  @ApiProperty() toll_charge!: number;
}

// Toll Upsert DTO: single item in bulk payload
export class TollChargeUpsertDto {
  @ApiProperty()
  @IsNotEmpty()
  @IsNumber()
  vehicle_type_id!: number;

  @ApiProperty()
  @IsNotEmpty()
  @IsNumber()
  toll_charge!: number;
}

// Toll Bulk Payload DTO: array of items
export class BulkTollPayloadDto {
  @ApiProperty({ type: [TollChargeUpsertDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TollChargeUpsertDto)
  items!: TollChargeUpsertDto[];
}

export class ViaRouteResponseDto {
  @ApiProperty() count!: string;
  @ApiProperty() via_route_location_ID!: number;
  @ApiProperty() location_id!: number;
  @ApiProperty() via_route_location!: string;
  @ApiProperty() via_route_location_lattitude!: string;
  @ApiProperty() via_route_location_longitude!: string;
  @ApiProperty() via_route_location_city!: string;
  @ApiProperty() via_route_location_state!: string;
  @ApiProperty() distance_from_source_to_via_route!: string;
  @ApiProperty() duration_from_source_to_via_route!: string;
  @ApiProperty() modify!: string;
}

export class CreateViaRouteDto {
  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  via_route_location!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  via_route_location_lattitude?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  via_route_location_longitude?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  via_route_location_city?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  via_route_location_state?: string;
}

export class SuggestedRouteResponseDto {
  @ApiProperty() count!: string;
  @ApiProperty() routes!: string;
  @ApiProperty() no_of_nights!: string;
  @ApiProperty() route_details!: string;
  @ApiProperty() modify!: string;
}
