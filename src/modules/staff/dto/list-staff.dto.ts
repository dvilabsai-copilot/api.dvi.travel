// FILE: src/modules/staff/dto/list-staff.dto.ts
import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListStaffDto {
  @IsOptional() @Type(() => Number) @IsInt()
  agentId?: number;

  @IsOptional() @IsString()
 search?: string; // matches name/email/mobile

  @IsOptional() @Type(() => Number) @IsInt()
 status?: number; // 0/1

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  pageSize?: number = 20;
}
