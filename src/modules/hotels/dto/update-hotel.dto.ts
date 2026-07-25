import { PartialType } from '@nestjs/mapped-types';
import { CreateHotelDto } from './create-hotel.dto';
import { IsInt, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateHotelDto extends PartialType(CreateHotelDto) {
 // Redefine explicitly so ValidationPipe keeps it on PATCH
  @IsOptional() @Type(() => Number) @IsInt()
  hotel_category?: number;
}
