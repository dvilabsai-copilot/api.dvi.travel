import { IsNotEmpty, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AuthDto } from './auth.dto';

export class RatePlanInfoRequestDto {
  @ValidateNested()
  @Type(() => AuthDto)
  @IsNotEmpty()
  auth: AuthDto;

  @IsNotEmpty()
  propertyId: string;

  @IsNotEmpty()
  roomId: string;
}

export class RatePlanValidityDto {
  startDate: string;
  endDate: string;
}

export class RatePlanDataDto {
  rateplanId: string;
  ratePlanName: string;
  occupancy: string[];
  validity: RatePlanValidityDto;
  commissionPerc: string;
  taxPerc: string;
  currency: string;
}

export class RatePlanInfoResponseDto {
  message: string;
  status: 'success' | 'failure';
  data: RatePlanDataDto[];
}
