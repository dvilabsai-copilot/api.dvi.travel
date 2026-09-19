import {
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class UpdateAgentSelfProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(250)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(250)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  primaryMobile?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  alternativeMobile?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  agentGstin?: string;

  @IsOptional()
  @IsString()
  @MaxLength(250)
  companyName?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  termsAndCondition?: string;

  @IsOptional()
  @IsString()
  @MaxLength(15)
  gstinNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  panNo?: string;

 @IsOptional()
@IsString()
invoiceAddress?: string;

@IsOptional()
@IsString()
removeSiteLogo?: string;

@IsOptional()
@IsString()
removeInvoiceLogo?: string;
}