import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class HotelAdminPermissionDto {
  @IsString()
  key!: string;

  @IsOptional()
  @IsBoolean()
  view?: boolean;

  @IsOptional()
  @IsBoolean()
  create?: boolean;

  @IsOptional()
  @IsBoolean()
  edit?: boolean;

  @IsOptional()
  @IsBoolean()
  delete?: boolean;
}

export class CreateHotelAdminUserDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  hotelIds!: number[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HotelAdminPermissionDto)
  permissions?: HotelAdminPermissionDto[];
}

export class UpdateHotelAdminUserDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  hotelIds?: number[];
}

export class SetHotelAdminPermissionsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HotelAdminPermissionDto)
  permissions!: HotelAdminPermissionDto[];
}