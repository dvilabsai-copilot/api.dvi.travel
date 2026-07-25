// FILE: src/modules/role-permission/dto/role-permission.dto.ts

import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class RolePermissionPageDto {
  @IsString()
  @IsNotEmpty()
 pageKey!: string; // maps to dvi_pagemenu.page_name

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
 pageName!: string; // dvi_pagemenu.page_title or label

  @IsBoolean()
  read!: boolean;

  @IsBoolean()
  write!: boolean;

  @IsBoolean()
  modify!: boolean;

  @IsBoolean()
  full!: boolean;
}

export class CreateRolePermissionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  roleName!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RolePermissionPageDto)
  pages!: RolePermissionPageDto[];
}

export class UpdateRolePermissionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  roleName!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RolePermissionPageDto)
  pages!: RolePermissionPageDto[];
}

export class UpdateRolePermissionStatusDto {
  @IsBoolean()
  status!: boolean;
}