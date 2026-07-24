// FILE: src/modules/hotel-category/dto/create-hotel-category.dto.ts

import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateHotelCategoryDto {
  @IsString()
  @IsNotEmpty()
 @MaxLength(65535) // TEXT max (practically you'll keep it small)
  title!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  code!: string;

 // Optional: allow client to pass initial status (defaults to 1 in service)
  @IsOptional()
  status?: number;
}
