import {
  ApiProperty,
} from '@nestjs/swagger';

import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class QuickOnboardAgentDto {
  @ApiProperty({
    example: 'Mahesh Verma',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(250)
  name!: string;

  @ApiProperty({
    example:
      'Mahesh Travel Partners',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(250)
  companyName!: string;

  @ApiProperty({
    example:
      'mahesh@example.com',
  })
  @IsEmail()
  email!: string;

  @ApiProperty({
    example: '9876543210',
  })
  @IsString()
  @Matches(
    /^[+]?[0-9 ()-]{8,20}$/,
    {
      message:
        'mobile must be a valid phone number',
    },
  )
  mobile!: string;
}