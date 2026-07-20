import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

export class CreateRouteVehicleRestrictionDto {
  @IsString() ruleCode!: string;
  @IsString() title!: string;
  @IsOptional() @IsString() description?: string;

  @Type(() => Number) @IsInt() @Min(1) locationId!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) viaRouteLocationId?: number | null;
  @IsIn(['FORWARD', 'REVERSE', 'BOTH']) direction!: 'FORWARD' | 'REVERSE' | 'BOTH';
  @IsIn(['BLOCK']) restrictionAction!: 'BLOCK';

  @IsBoolean() isAllDay!: boolean;
  @IsOptional() @IsBoolean() appliesToAllVehicleTypes?: boolean;
  @IsOptional() @Matches(TIME_PATTERN) startLocalTime?: string | null;
  @IsOptional() @Matches(TIME_PATTERN) endLocalTime?: string | null;
  @IsOptional() @IsString() timezoneName?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) daysOfWeekMask?: number | null;
  @IsOptional() @IsDateString() effectiveFrom?: string | null;
  @IsOptional() @IsDateString() effectiveTo?: string | null;
  @Type(() => Number) @IsInt() priority!: number;
  @IsIn(['SHADOW', 'ENFORCE']) enforcementMode!: 'SHADOW' | 'ENFORCE';

  @IsOptional() @IsArray() @Type(() => Number) @IsInt({ each: true }) @Min(1, { each: true })
  vehicleTypeIds?: number[];

  @IsOptional() @IsString() sourceReference?: string | null;
  @IsOptional() @IsDateString() lastVerifiedOn?: string | null;
}

export class UpdateRouteVehicleRestrictionDto extends CreateRouteVehicleRestrictionDto {}

export class RouteVehicleRestrictionLegDto {
  @IsString() sourceLocation!: string;
  @IsString() destinationLocation!: string;
  @IsDateString() routeDate!: string;
  @Matches(TIME_PATTERN) startTime!: string;
  @Matches(TIME_PATTERN) endTime!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) viaRouteLocationId?: number | null;
}

export class EvaluateRouteVehicleRestrictionDto {
  @IsArray() @ArrayNotEmpty() @Type(() => Number) @IsInt({ each: true }) @Min(1, { each: true })
  vehicleTypeIds!: number[];
  @IsArray() @ArrayNotEmpty() legs!: RouteVehicleRestrictionLegDto[];
}
