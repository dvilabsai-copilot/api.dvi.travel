import { IsNotEmpty, ValidateNested, IsArray, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { AuthDto } from './auth.dto';

export class PeriodDto {
  @IsString()
  @IsNotEmpty()
  startDate: string;

  @IsString()
  @IsNotEmpty()
  endDate: string;
}

export class RestrictionsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PeriodDto)
  periods: PeriodDto[];

  @IsString()
  @IsNotEmpty()
  type: string; // Status | COA | COD | MLos

  @IsString()
  @IsNotEmpty()
  value: string; // Open/Close for Status/COA/COD, integer for MLos
}

export class RatePlanDetailsDto {
  @IsString()
  @IsNotEmpty()
  ratePlanId: string;

  @ValidateNested()
  @Type(() => RestrictionsDto)
  @IsNotEmpty()
  restrictions: RestrictionsDto;
}

export class RoomDetailsDto {
  @IsString()
  @IsNotEmpty()
  roomId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RatePlanDetailsDto)
  ratePlanDetails: RatePlanDetailsDto[];
}

export class PropertyRestrictionDto {
  @IsString()
  @IsNotEmpty()
  propertyId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoomDetailsDto)
  roomDetails: RoomDetailsDto[];
}

export class RestrictionUpdateRequestDto {
  @ValidateNested()
  @Type(() => AuthDto)
  @IsNotEmpty()
  auth: AuthDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PropertyRestrictionDto)
  data: PropertyRestrictionDto[];
}

export class RestrictionUpdateResponseDto {
  message: string;
  status: 'success' | 'failure';
}
