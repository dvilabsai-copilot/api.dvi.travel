import { Type } from 'class-transformer';
import { IsEmail, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class CreateActivityBookingDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  activityId!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  agentId!: number;

  @IsString()
  @IsOptional()
  activityTitle?: string;

  @IsString()
  @IsOptional()
  destination?: string;

  @IsString()
  @IsOptional()
  activityDate?: string;

  @IsString()
  @IsOptional()
  travelDate?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  guests!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  totalAmount!: number;

  @IsString()
  @IsOptional()
  salutation?: string;

  @IsString()
  customerName!: string;

  @IsString()
  customerPhone!: string;

  @IsEmail()
  @IsOptional()
  customerEmail?: string;

  @IsString()
  @IsOptional()
  customerAge?: string;

  @IsString()
  @IsOptional()
  nationality?: string;

  @IsString()
  @IsOptional()
  panNo?: string;

  @IsString()
  @IsOptional()
  passportNo?: string;

  @IsString()
  @IsOptional()
  alternativePhone?: string;

  @IsString()
  @IsOptional()
  notes?: string;

  @IsString()
  @IsOptional()
  remarks?: string;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  createdby?: number;
}
