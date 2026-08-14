// DTO for hotel room selection modal
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, IsNumber, Min } from 'class-validator';

export class GetHotelRoomCategoriesDto {
  @ApiProperty({ description: 'Itinerary Plan Hotel Details ID' })
  @IsInt()
  @IsNotEmpty()
  itinerary_plan_hotel_details_ID: number;

  @ApiProperty({ description: 'Itinerary Plan ID' })
  @IsInt()
  @IsNotEmpty()
  itinerary_plan_id: number;

  @ApiProperty({ description: 'Itinerary Route ID' })
  @IsInt()
  @IsNotEmpty()
  itinerary_route_id: number;

  @ApiProperty({ description: 'Hotel ID' })
  @IsInt()
  @IsNotEmpty()
  hotel_id: number;

  @ApiProperty({ description: 'Group Type' })
  @IsInt()
  @IsNotEmpty()
  group_type: number;

  @ApiProperty({ description: 'Provider hotel code (used by TBO/VSR)', required: false })
  @IsString()
  @IsOptional()
  hotel_code?: string;

  @ApiProperty({ description: 'Hotel provider', required: false })
  @IsString()
  @IsOptional()
  provider?: string;

  @ApiProperty({ description: 'Hotel name (fallback identity for TBO/VSR)', required: false })
  @IsString()
  @IsOptional()
  hotel_name?: string;

  @ApiProperty({ description: 'Hotel Required (0 or 1)', required: false })
  @IsInt()
  @IsOptional()
  hotel_required?: number;

  @ApiProperty({ description: 'All Meal Plan (0 or 1)', required: false })
  @IsInt()
  @IsOptional()
  all_meal_plan?: number;

  @ApiProperty({ description: 'Breakfast Meal Plan (0 or 1)', required: false })
  @IsInt()
  @IsOptional()
  breakfast_meal_plan?: number;

  @ApiProperty({ description: 'Lunch Meal Plan (0 or 1)', required: false })
  @IsInt()
  @IsOptional()
  lunch_meal_plan?: number;

  @ApiProperty({ description: 'Dinner Meal Plan (0 or 1)', required: false })
  @IsInt()
  @IsOptional()
  dinner_meal_plan?: number;
}

export class UpdateRoomCategoryDto {
  @ApiProperty({ description: 'Itinerary Plan Hotel Room Details ID' })
  @IsInt()
  @IsNotEmpty()
  itinerary_plan_hotel_room_details_ID: number;

  @ApiProperty({ description: 'Itinerary Plan Hotel Details ID' })
  @IsInt()
  @IsNotEmpty()
  itinerary_plan_hotel_details_ID: number;

  @ApiProperty({ description: 'Itinerary Plan ID' })
  @IsInt()
  @IsNotEmpty()
  itinerary_plan_id: number;

  @ApiProperty({ description: 'Itinerary Route ID' })
  @IsInt()
  @IsNotEmpty()
  itinerary_route_id: number;

  @ApiProperty({ description: 'Hotel ID' })
  @IsInt()
  @IsNotEmpty()
  hotel_id: number;

  @ApiProperty({ description: 'Group Type' })
  @IsInt()
  @IsNotEmpty()
  group_type: number;

  @ApiProperty({ description: 'Provider hotel code (used by TBO/VSR)', required: false })
  @IsString()
  @IsOptional()
  hotel_code?: string;

  @ApiProperty({ description: 'Hotel provider', required: false })
  @IsString()
  @IsOptional()
  provider?: string;

  @ApiProperty({ description: 'Hotel name (fallback identity for TBO/VSR)', required: false })
  @IsString()
  @IsOptional()
  hotel_name?: string;

  @ApiProperty({ description: 'Selected Room Type ID' })
  @IsInt()
  @IsNotEmpty()
  room_type_id: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  room_number?: number;

  @ApiProperty({ description: 'Room Quantity', required: false })
  @IsInt()
  @IsOptional()
  @Min(1)
  room_qty?: number;

  @ApiProperty({ description: 'All Meal Plan (0 or 1)', required: false })
  @IsInt()
  @IsOptional()
  all_meal_plan?: number;

  @ApiProperty({ description: 'Breakfast Meal Plan (0 or 1)', required: false })
  @IsInt()
  @IsOptional()
  breakfast_meal_plan?: number;

  @ApiProperty({ description: 'Lunch Meal Plan (0 or 1)', required: false })
  @IsInt()
  @IsOptional()
  lunch_meal_plan?: number;

  @ApiProperty({ description: 'Dinner Meal Plan (0 or 1)', required: false })
  @IsInt()
  @IsOptional()
  dinner_meal_plan?: number;
}

export class HotelRoomCategoryResponseDto {
  @ApiProperty({ description: 'Room number (sequential)' })
  room_number: number;

  @ApiProperty({ description: 'Itinerary Plan Hotel Room Details ID', required: false })
  itinerary_plan_hotel_room_details_ID?: number;

  @ApiProperty({ description: 'Selected Room Type ID', required: false })
  room_type_id?: number;

  @ApiProperty({ description: 'Room Type Title', required: false })
  room_type_title?: string;

  @ApiProperty({ description: 'Room Quantity' })
  room_qty: number;

  @ApiProperty({ description: 'Available room types for this hotel' })
  available_room_types: Array<{
    room_type_id: number;
    room_type_title: string;
  }>;
}

export class HotelRoomCategoriesListResponseDto {
  @ApiProperty({ description: 'Itinerary Plan Hotel Details ID' })
  itinerary_plan_hotel_details_ID: number;

  @ApiProperty({ description: 'Hotel ID' })
  hotel_id: number;

  @ApiProperty({ description: 'Hotel Name' })
  hotel_name: string;

  @ApiProperty({ description: 'Preferred Room Count' })
  preferred_room_count: number;

  @ApiProperty({ description: 'List of rooms with their categories' })
  rooms: HotelRoomCategoryResponseDto[];
}
