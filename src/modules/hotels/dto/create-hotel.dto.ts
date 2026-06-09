import { IsInt, IsNumber, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateHotelDto {
  @IsOptional() @IsString() hotel_name?: string;
  @IsOptional() @IsString() hotel_code?: string;
  @IsOptional() @IsString() resavenue_hotel_code?: string;
  @IsOptional() @IsString() hotel_mobile?: string;
  @IsOptional() @IsString() hotel_email?: string;
  @IsOptional() @IsString() hotel_country?: string;
  @IsOptional() @IsString() hotel_city?: string;
  @IsOptional() @IsString() hotel_state?: string;
  @IsOptional() @IsString() hotel_place?: string;
  @IsOptional() @IsString() hotel_address?: string;
  @IsOptional() @IsString() hotel_pincode?: string;

  // >>> NEW: category (FK id). Use Type(() => Number) so "3" becomes 3.
  @IsOptional() @Type(() => Number) @IsInt()
  hotel_category?: number;

  @IsOptional() @Type(() => Number) @IsNumber()
  hotel_margin?: number;

  @IsOptional() @Type(() => Number) @IsInt()
  hotel_margin_gst_type?: number;

  @IsOptional() @Type(() => Number) @IsNumber()
  hotel_margin_gst_percentage?: number;

  @IsOptional() @Type(() => Number) @IsInt()
  createdby?: number;

  @IsOptional() @Type(() => Number) @IsInt()
  status?: number;   // TinyInt

  @IsOptional() @Type(() => Number) @IsInt()
  deleted?: number;  // TinyInt
}
