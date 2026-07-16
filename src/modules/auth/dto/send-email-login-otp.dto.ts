import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class SendEmailLoginOtpDto {
  @ApiProperty({ example: 'admin@dvi.co.in' })
  @IsEmail()
  email!: string;
}