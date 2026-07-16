import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class SendRegistrationEmailOtpDto {
  @ApiProperty({ example: 'partner@example.com' })
  @IsEmail()
  email!: string;
}
