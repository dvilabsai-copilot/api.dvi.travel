// FILE: src/modules/accounts-ledger/dto/accounts-ledger-query.dto.ts

import { IsEnum, IsInt, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export enum AccountsLedgerComponentType {
  ALL = 'all',
  GUIDE = 'guide',
  HOTSPOT = 'hotspot',
  ACTIVITY = 'activity',
  HOTEL = 'hotel',
  VEHICLE = 'vehicle',
  AGENT = 'agent',
}

export class AccountsLedgerQueryDto {
  @IsOptional()
  @IsString()
  quoteId?: string;

  @IsEnum(AccountsLedgerComponentType)
  componentType: AccountsLedgerComponentType =
    AccountsLedgerComponentType.AGENT;

 /** DD/MM/YYYY */
  @IsOptional()
  @IsString()
  fromDate?: string;

 /** DD/MM/YYYY */
  @IsOptional()
  @IsString()
  toDate?: string;

 // GUIDE
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  guideId?: number;

 // HOTEL
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  hotelId?: number;

 // ACTIVITY
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  activityId?: number;

 // HOTSPOT
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  hotspotId?: number;

 // VEHICLE (start with vendor; extended with branch/type)
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  vendorId?: number;

 // VEHICLE BRANCH (dvi_vendor_branches)
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  vendorBranchId?: number;

 // VEHICLE TYPE (dvi_vehicle_type)
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  vehicleTypeId?: number;

 // AGENT
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  agentId?: number;
}
