import { IsNumber, IsOptional, IsString, IsArray } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

// Get cancellation data for a confirmed itinerary
export class GetConfirmedItineraryCancellationDto {
  @ApiProperty({ example: 1 })
  @IsNumber()
  confirmed_itinerary_plan_ID!: number;
}

// Cancel entire day - get charges
export class GetEntireDayCancellationChargesDto {
  @ApiProperty({ example: 1 })
  @IsNumber()
  confirmed_itinerary_plan_ID!: number;

  @ApiProperty({ example: '2024-11-27' })
  @IsString()
  date!: string;

  @ApiProperty({ example: 10, minimum: 0, maximum: 100 })
  @IsNumber()
  @IsOptional()
  cancellation_percentage?: number;

  @ApiProperty({ example: 'dvi' })
  @IsString()
  @IsOptional()
 defect_type?: string; // 'dvi' or 'guest'
}

// Cancel entire day - execute cancellation
export class CancelEntireDayDto {
  @ApiProperty({ example: 1 })
  @IsNumber()
  confirmed_itinerary_plan_ID!: number;

  @ApiProperty({ example: 1 })
  @IsNumber()
  hotel_id!: number;

  @ApiProperty({ example: '2024-11-27' })
  @IsString()
  date!: string;

  @ApiProperty({ example: 10 })
  @IsNumber()
  cancellation_percentage!: number;

  @ApiProperty({ example: 'dvi' })
  @IsString()
 defect_type!: string; // 'dvi' or 'guest'
}

// Cancel individual room item
export class CancelRoomItemDto {
  @ApiProperty({ example: 1 })
  @IsNumber()
  confirmed_itinerary_plan_ID!: number;

  @ApiProperty({ example: 1 })
  @IsNumber()
  hotel_id!: number;

  @ApiProperty({ example: '2024-11-27' })
  @IsString()
  date!: string;

 @ApiProperty({ example: 'extra_bed' }) // 'extra_bed', 'child_with_bed', 'child_without_bed'
  @IsString()
  item_type!: string;

  @ApiProperty({ example: 500 })
  @IsNumber()
  item_price!: number;

  @ApiProperty({ example: 10 })
  @IsNumber()
  cancellation_percentage!: number;

  @ApiProperty({ example: 'dvi' })
  @IsString()
 defect_type!: string; // 'dvi' or 'guest'
}

// Confirm cancellation (final)
export class ConfirmHotelCancellationDto {
  @ApiProperty({ example: 1 })
  @IsNumber()
  confirmed_itinerary_plan_ID!: number;

  @ApiProperty({ example: 1 })
  @IsNumber()
  hotel_id!: number;

  @ApiProperty({ example: '2024-11-27' })
  @IsString()
  date!: string;

  @ApiProperty({ example: 100 })
  @IsNumber()
  total_cancellation_charge!: number;

  @ApiProperty({ example: 2500 })
  @IsNumber()
  total_refund_amount!: number;

  @ApiProperty({ example: 'dvi' })
  @IsString()
  defect_type!: string;
}
