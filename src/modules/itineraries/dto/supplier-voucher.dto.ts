import { IsEmail, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class OpenSupplierVoucherDto {
  @IsString()
  @MaxLength(10_000)
  @Matches(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)
  token!: string;
}

export class ConfirmSupplierVoucherDto extends OpenSupplierVoucherDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(/\S/)
  confirmedBy!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  @Matches(/\d/)
  phone!: string;

  @ValidateIf((body) => body.reservationNo !== undefined)
  @IsString()
  @MaxLength(100)
  reservationNo?: string;

  @ValidateIf((body) => body.email !== undefined)
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ValidateIf((body) => body.remarks !== undefined)
  @IsString()
  @MaxLength(2000)
  remarks?: string;
}
