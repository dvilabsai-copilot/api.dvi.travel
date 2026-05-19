import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CancelHotelVouchersDto {
  @ApiProperty({
    example: 'Customer requested hotel cancellation',
    description: 'Reason for cancellation',
  })
  @IsString()
  reason!: string;

  @ApiProperty({
    required: false,
    type: [Number],
    example: [1201, 1202],
    description: 'Cancel hotels for these route IDs only',
  })
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  route_ids?: number[];

  @ApiProperty({
    required: false,
    type: [Number],
    example: [9091, 9092],
    description: 'Cancel these specific itinerary plan hotel detail IDs',
  })
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  hotel_details_ids?: number[];

  @ApiProperty({
    required: false,
    default: false,
    description: 'If true, cancels all hotels in the itinerary',
  })
  @IsOptional()
  @IsBoolean()
  cancel_all?: boolean;

  @ValidateIf((o) => !o.cancel_all)
  @IsOptional()
  _atLeastOneFilter?: never;
}
