import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class ActivatePartnerDto {
  @ApiProperty({
    description: 'One-time partner activation token from the activation email',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9_-]{32,200}$/, {
    message: 'token must be a valid activation token',
  })
  token!: string;
}