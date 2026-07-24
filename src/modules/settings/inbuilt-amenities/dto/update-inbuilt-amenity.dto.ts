// FILE: src/modules/inbuilt-amenities/dto/update-inbuilt-amenity.dto.ts

import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString } from "class-validator";

export class UpdateInbuiltAmenityDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  title?: string;

 /**
   * IMPORTANT:
   * Your PHP updatestatus handler receives the CURRENT status and flips it.
   * Your frontend toggleStatus(id, status) likely passes current status.
 */
  @IsOptional()
  @IsInt()
  @IsIn([0, 1])
  status?: 0 | 1;
}
