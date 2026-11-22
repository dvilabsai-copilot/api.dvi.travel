import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

export class VehicleUpgradePricesDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  itineraryPlanId!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  currentVehicleTypeId!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  selectedVendorEligibleId?: number;
}