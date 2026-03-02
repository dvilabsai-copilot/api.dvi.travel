import { IsArray, IsOptional, IsString, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * DTO for requesting eligible vehicle types
 * Mirrors PHP parameters: itinerary_plan_ID, source_location[], next_visiting_location[]
 */
export class EligibleVehicleTypesDto {
  /**
   * Itinerary Plan ID (optional)
   * If provided, also return selectedVehicleIds from dvi_itinerary_plan_vehicle_details
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  itineraryPlanId?: string | number;

  /**
   * Source locations (e.g., ["Chennai Domestic Airport"])
   * Array of location names
   */
  @IsArray()
  @IsString({ each: true })
  sourceLocation: string[];

  /**
   * Next visiting locations (e.g., ["Pondicherry"])
   * Array of location names
   */
  @IsArray()
  @IsString({ each: true })
  nextVisitingLocation: string[];
}

/**
 * Response DTO for eligible vehicle types
 */
export class EligibleVehicleTypesResponseDto {
  /**
   * List of eligible vehicle types
   */
  vehicleTypes: Array<{
    id: string;
    label: string;
  }>;

  /**
   * Selected vehicle IDs for the itinerary plan (if itineraryPlanId was provided)
   */
  selectedVehicleIds: string[];
}
