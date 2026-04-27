import { IsNotEmpty, ValidateNested, IsArray, IsString, IsDateString, IsOptional, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';
import { AuthDto } from './auth.dto';

export class RateEntryDto {
  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsOptional()
  @IsNumber()
  SINGLE?: number;

  @IsOptional()
  @IsNumber()
  DOUBLE?: number;

  @IsOptional()
  @IsNumber()
  TRIPLE?: number;

  @IsOptional()
  @IsNumber()
  QUAD?: number;

  @IsOptional()
  @IsNumber()
  PENTA?: number;

  @IsOptional()
  @IsNumber()
  HEXA?: number;

  @IsOptional()
  @IsNumber()
  HEPTA?: number;

  @IsOptional()
  @IsNumber()
  OCTA?: number;

  @IsOptional()
  @IsNumber()
  NINE?: number;

  @IsOptional()
  @IsNumber()
  TEN?: number;

  @IsOptional()
  @IsNumber()
  EXTRABED?: number;

  @IsOptional()
  @IsNumber()
  EXTRAADULT?: number;

  @IsOptional()
  @IsNumber()
  EXTRACHILD?: number;

  @IsOptional()
  @IsNumber()
  EXTRAADULT2?: number;

  @IsOptional()
  @IsNumber()
  EXTRACHILD2?: number;

  @IsOptional()
  @IsNumber()
  EXTRAADULT3?: number;

  @IsOptional()
  @IsNumber()
  EXTRACHILD3?: number;

  @IsOptional()
  @IsNumber()
  EXTRAINFANT?: number;

  @IsOptional()
  @IsNumber()
  CHILD_WITH_BED?: number;

  @IsOptional()
  @IsNumber()
  CHILD_WITHOUT_BED?: number;

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
