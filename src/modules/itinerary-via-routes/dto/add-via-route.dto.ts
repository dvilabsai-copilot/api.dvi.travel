import { IsArray, IsOptional, IsString } from 'class-validator';

/**
 * DTO mirroring the legacy PHP `add_via_route` payload as closely as possible.
 *
 * Only the fields actually used in the NestJS implementation are required.
 */
export class AddViaRouteDto {
 /**
   * Selected via route IDs (from dvi_stored_location_via_routes.via_route_location_ID)
 */
  @IsArray()
  via_route_location!: (number | string)[];

  @IsString()
 hidden_route_date!: string; // dd/mm/yyyy

  @IsString()
  hidden_source_location!: string;

  @IsString()
  hidden_destination_location!: string;

 /**
   * Existing itinerary_via_route_IDs when editing (index-aligned with via_route_location).
   * For new entries this can be an empty array.
 */
  @IsArray()
  @IsOptional()
  hidden_itineary_via_route_id?: (number | string)[];

 /**
   * Optional plan/route IDs. For new itineraries these may be omitted.
 */
  @IsOptional()
  itinerary_plan_ID?: number | string | null;

  @IsOptional()
  itinerary_route_ID?: number | string | null;

 /**
   * Optional session / user context, if you decide to send them from the UI.
 */
  @IsOptional()
  itinerary_session_id?: string | null;

  @IsOptional()
  createdby?: number | string | null;
}
