import { IsNotEmpty, ValidateNested, IsArray, IsString, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';
import { AuthDto } from './auth.dto';

export class RateEntryDto {
  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  [key: string]: any; // Dynamic occupancy keys (SINGLE, DOUBLE, TRIPLE, EXTRABED, etc.)
}

export class RateDataDto {
  @IsString()
  @IsNotEmpty()
  propertyId: string;

  @IsString()
  @IsNotEmpty()
  roomId: string;

  @IsString()
  @IsNotEmpty()
  rateplanId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RateEntryDto)
  rate: RateEntryDto[];
}

export class RateUpdateRequestDto {
  @ValidateNested()
  @Type(() => AuthDto)
  @IsNotEmpty()
  auth: AuthDto;

  @ValidateNested()
  @Type(() => RateDataDto)
  @IsNotEmpty()
  data: RateDataDto;
}

export class RateUpdateResponseDto {
  message: string;
  status: 'success' | 'failure';
}
