import { IsInt, IsNotEmpty, IsString, Min } from "class-validator";
import { Type } from "class-transformer";

export class CreateCityDto {
  @IsNotEmpty()
  @IsString()
 city_name!: string; // keep php-style naming too

  @Type(() => Number)
  @IsInt()
  @Min(1)
 state_id!: number; // keep php-style naming too
}
