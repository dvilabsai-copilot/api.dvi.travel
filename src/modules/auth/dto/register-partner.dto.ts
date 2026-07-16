import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

export class RegisterPartnerDto {
  @ApiProperty({ example: 'DVI Travel Partners Pvt Ltd' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(250)
  companyName!: string;

  @ApiProperty({ example: '9876543210' })
  @IsString()
  @Matches(/^[+]?[0-9 ()-]{8,20}$/, {
    message: 'mobile must be a valid phone number',
  })
  mobile!: string;

  @ApiProperty({ example: 'partner@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'ABCDE1234F' })
  @IsString()
  @Length(10, 10)
  @Matches(/^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/, {
    message: 'pan must be a valid PAN number',
  })
  pan!: string;

  @ApiProperty({ description: 'Short-lived token returned after registration email OTP verification' })
  @IsString()
  @IsNotEmpty()
  emailVerificationToken!: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  declarationAccepted!: boolean;
}
