import { IsInt, IsNumber, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateHotelDto {
  @IsOptional() @IsString() hotel_name?: string;
  @IsOptional() @IsString() hotel_code?: string;
  @IsOptional() @IsString() resavenue_hotel_code?: string;

  @IsOptional() @IsString() hotel_mobile?: string;
  @IsOptional() @IsString() hotel_mobile_no?: string;

  @IsOptional() @IsString() hotel_email?: string;
  @IsOptional() @IsString() hotel_email_id?: string;

  @IsOptional() @IsString() hotel_country?: string;
  @IsOptional() @IsString() hotel_city?: string;
  @IsOptional() @IsString() hotel_state?: string;
  @IsOptional() @IsString() hotel_place?: string;

  @IsOptional() @IsString() hotel_address?: string;
  @IsOptional() @IsString() hotel_address_1?: string;

  @IsOptional() @IsString() hotel_pincode?: string;
  @IsOptional() @IsString() hotel_postal_code?: string;

  @IsOptional() @IsString() hotel_latitude?: string;
  @IsOptional() @IsString() hotel_longitude?: string;

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
  hotel_status?: number;

  @IsOptional() @Type(() => Number) @IsInt()
  status?: number;

  @IsOptional() @Type(() => Number) @IsInt()
  hotel_power_backup?: number;

  @IsOptional() @Type(() => Number) @IsInt()
  hotel_powerbackup?: number;

  @IsOptional() @Type(() => Number) @IsInt()
  hotel_hotspot_status?: number;

  @IsOptional() @Type(() => Number) @IsInt()
  createdby?: number;

  @IsOptional() @Type(() => Number) @IsInt()
 deleted?: number; // TinyInt
}
