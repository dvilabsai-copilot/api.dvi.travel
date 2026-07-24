import { IsArray, ArrayNotEmpty, IsString } from 'class-validator';

export class CheckDistanceLimitDto {
  @IsString()
  source!: string;

  @IsString()
  destination!: string;

 /**
   * Array of via route location IDs (dvi_stored_location_via_routes.via_route_location_ID)
 */
  @IsArray()
  @ArrayNotEmpty()
  via_routes!: (number | string)[];
}
