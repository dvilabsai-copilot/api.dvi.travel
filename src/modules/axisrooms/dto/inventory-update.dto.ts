import { IsNotEmpty, ValidateNested, IsArray, IsNumber, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { AuthDto } from './auth.dto';

export class InventoryEntryDto {
  @IsString()
  @IsNotEmpty()
  startDate: string;

  @IsString()
  @IsNotEmpty()
  endDate: string;

  @IsNumber()
  free: number;
}

export class InventoryDataDto {
  @IsString()
  @IsNotEmpty()
  propertyId: string;

  @IsString()
  @IsNotEmpty()
  roomId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InventoryEntryDto)
  inventory: InventoryEntryDto[];
}

export class InventoryUpdateRequestDto {
  @ValidateNested()
  @Type(() => AuthDto)
  @IsNotEmpty()
  auth: AuthDto;

  @ValidateNested()
  @Type(() => InventoryDataDto)
  @IsNotEmpty()
  data: InventoryDataDto;
}

export class InventoryUpdateResponseDto {
  message: string;
  status: 'success' | 'failure';
}
