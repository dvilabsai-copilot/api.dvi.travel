import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsNotEmpty,
  IsDateString,
  Min,
} from 'class-validator';

export class VehiclePricebookQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  vendorId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  vendorBranchId?: number;

  @IsOptional()
  @IsString()
 month?: string; // e.g. "February"

  @IsOptional()
  @IsString()
 year?: string; // e.g. "2030"
}

export class HotelRoomExportQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  stateId!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  cityId!: number;

  @IsDateString()
 startDate!: string; // YYYY-MM-DD

  @IsDateString()
 endDate!: string; // YYYY-MM-DD
}

export class HotelAmenityExportQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  stateId!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  cityId!: number;

  @IsString()
  @IsNotEmpty()
  month!: string;

  @IsString()
  @IsNotEmpty()
  year!: string;
}

export class GuideExportQueryDto {
  @IsString()
  @IsNotEmpty()
  month!: string;

  @IsString()
  @IsNotEmpty()
  year!: string;
}

export class HotspotExportQueryDto {
  @IsString()
  @IsNotEmpty()
  hotspotLocation!: string;
}

export class ActivityQueryDto {
  @IsString()
  @IsNotEmpty()
  month!: string;

  @IsString()
  @IsNotEmpty()
  year!: string;
}

export class TollQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  vehicleTypeId!: number;
}

export class ParkingQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  vehicleTypeId?: number;

  @IsOptional()
  @IsString()
  hotspotLocation?: string;
}
