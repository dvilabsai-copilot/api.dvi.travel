// FILE: src/modules/hotel-category/dto/check-hotel-category-code.dto.ts

import { IsNotEmpty, IsOptional, IsString, MaxLength, IsInt } from 'class-validator';
import { Type } from 'class-transformer';

export class CheckHotelCategoryCodeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  code!: string;

 // When editing, exclude current record from uniqueness check
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  excludeId?: number;
}
