import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class UpdateAgentConfigDto {
  @IsOptional() @IsNumber() @Min(0)
  itineraryDiscountMargin?: number;

  @IsOptional() @IsNumber() @Min(0)
  serviceCharge?: number;

  @IsOptional() @IsString()
  agentMarginGstType?: string;

  @IsOptional() @IsNumber() @Min(0)
  agentMarginGstPercentage?: number;

  @IsOptional() @IsString()
  companyName?: string;

  @IsOptional() @IsString()
  address?: string;

  @IsOptional() @IsString()
  termsAndCondition?: string;

  @IsOptional() @IsString()
  gstinNumber?: string;

  @IsOptional() @IsString()
  panNo?: string;

  @IsOptional() @IsString()
  invoiceAddress?: string;

  @IsOptional() @IsString()
  password?: string;
}
