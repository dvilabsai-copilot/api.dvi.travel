// FILE: src/modules/staff/dto/create-staff.dto.ts
import { IsEmail, IsInt, IsNotEmpty, IsOptional, IsString, Length, Matches, Min } from 'class-validator';

export class CreateStaffDto {
  @IsInt() @Min(0)
 agentId!: number; // required definite assignment

  @IsString() @IsNotEmpty()
 staffName!: string; // required

  @IsString()
  @Matches(/^\d{10}$/, { message: 'staffMobile must be a 10 digit number' })
 staffMobile!: string; // required

  @IsEmail()
 staffEmail!: string; // required

  @IsInt() @Min(0)
 roleId!: number; // required

 // Optional login creation fields
  @IsOptional()
  @IsEmail()
  loginEmail?: string;

  @IsOptional()
  @IsString() @Length(6, 100)
  password?: string;

  @IsOptional()
  @IsInt()
 status?: number; // default handled in service
}