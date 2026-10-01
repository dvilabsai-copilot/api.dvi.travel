import {
  ApiProperty,
} from '@nestjs/swagger';

import {
  IsEmail,
  IsString,
  Length,
  MinLength,
} from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({
    example: 'agent@example.com',
  })
  @IsEmail()
  email!: string;

  @ApiProperty({
    example: '123456',
  })
  @IsString()
  @Length(6, 6)
  otp!: string;

  @ApiProperty({
    example: 'NewPassword123',
  })
  @IsString()
  @MinLength(6)
  newPassword!: string;

  @ApiProperty({
    example: 'NewPassword123',
  })
  @IsString()
  @MinLength(6)
  confirmPassword!: string;
}