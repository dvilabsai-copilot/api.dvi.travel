// FILE: src/modules/settings/inbuilt-amenities/dto/create-inbuilt-amenity.dto.ts

import { IsNotEmpty, IsOptional, IsString, IsIn, IsInt } from "class-validator";

export class CreateInbuiltAmenityDto {
  @IsString()
  @IsNotEmpty()
  title!: string;

 /**
   * Frontend may send 0/1, but PHP always stores status=1 on create.
   * We keep it optional for compatibility.
 */
  @IsOptional()
  @IsInt()
  @IsIn([0, 1])
  status?: 0 | 1;
}