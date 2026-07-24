// FILE: src/modules/staff/dto/update-staff.dto.ts
import { IsEmail, IsInt, IsOptional, IsString, Length, Matches, Min } from 'class-validator';

export class UpdateStaffDto {
  @IsOptional() @IsInt() @Min(0)
  agentId?: number;

  @IsOptional() @IsString()
  staffName?: string;

  @IsOptional()
  @Matches(/^\d{10}$/, { message: 'staffMobile must be a 10 digit number' })
  staffMobile?: string;

  @IsOptional() @IsEmail()
  staffEmail?: string;

  @IsOptional() @IsInt() @Min(0)
  roleId?: number;

 // Optional login updates
  @IsOptional() @IsEmail()
  loginEmail?: string;

  @IsOptional() @IsString() @Length(6, 100)
  password?: string;

  @IsOptional() @IsInt()
 status?: number; // 0/1
}
