import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class StayExtensionPreviewDto {
  @ApiProperty({ example: 6812 })
  @IsInt()
  @Min(1)
  routeId!: number;

  @ApiProperty({ example: 'staah', enum: ['staah', 'axisrooms'] })
  @IsString()
  @IsIn(['staah', 'axisrooms'])
  provider!: 'staah' | 'axisrooms';

  @ApiProperty({ example: '934001' })
  @IsString()
  hotelCode!: string;

  @ApiProperty({ example: 'STAAH TEST HOTEL', required: false })
  @IsOptional()
  @IsString()
  hotelName?: string;

  @ApiProperty({ example: '10512556XPQ3', required: false })
  @IsOptional()
  @IsString()
  roomId?: string;

  @ApiProperty({ example: 'STAAH194181', required: false })
  @IsOptional()
  @IsString()
  rateId?: string;

  @ApiProperty({ example: 'Suite Room', required: false })
  @IsOptional()
  @IsString()
  roomType?: string;

  @ApiProperty({ example: 'MAP', required: false })
  @IsOptional()
  @IsString()
  mealPlan?: string;

  @ApiProperty({ example: '2026-07-15' })
  @IsString()
  checkInDate!: string;
}
