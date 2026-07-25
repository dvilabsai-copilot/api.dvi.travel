// FILE: src/modules/itinerary-via-routes/dto/show-form.dto.ts

import { IsOptional, IsString } from 'class-validator';

export class ShowViaRouteFormDto {
  @IsOptional()
  @IsString()
  DAY_NO?: string;

  @IsString()
  selected_source_location!: string;

  @IsString()
  selected_next_visiting_location!: string;

 // dd/mm/yyyy
  @IsString()
  itinerary_route_date!: string;

  @IsOptional()
  @IsString()
  itinerary_route_ID?: string;

  @IsOptional()
  @IsString()
  itinerary_plan_ID?: string;

 // React-side session id (equivalent to PHP session_id())
  @IsOptional()
  @IsString()
  itinerary_session_id?: string;
}
