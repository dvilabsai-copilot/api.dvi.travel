// FILE: src/modules/daily-moment-tracker/dto/daily-moment-tracker.dto.ts

import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  Max,
} from 'class-validator';

export class ListDailyMomentQueryDto {
  @IsNotEmpty()
  @IsString()
  fromDate!: string; // supports "YYYY-MM-DD" or "DD-MM-YYYY" (we parse in service)

  @IsNotEmpty()
  @IsString()
  toDate!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  itineraryPlanId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  agentId?: number;
}

export class DailyMomentRowDto {
  count!: number;

  // Guest details
  guest_name!: string;
  guest_mobile!: string; // NEW
  guest_email!: string;  // NEW

  quote_id!: string | null;
  itinerary_plan_ID!: number;
  itinerary_route_ID!: number;
  route_date!: string; // dd-mm-YYYY (formatted like PHP)
  trip_type!: 'Arrival' | 'Departure' | 'Ongoing';
  location_name!: string | null;
  next_visiting_location!: string | null;
  arrival_flight_details!: string;
  departure_flight_details!: string;
  hotel_name!: string;
  vehicle_type_title!: string;
  vendor_name!: string;
  meal_plan!: string; // e.g. "B L D"
  vehicle_no!: string;

  driver_name!: string;
  driver_mobile!: string;

  special_remarks!: string;

  // Travel expert details
  travel_expert_name!: string;
  travel_expert_mobile!: string; // NEW
  travel_expert_email!: string;  // NEW

  agent_name!: string;
}

/**
 * Add / Update extra charges (car icon popup)
 */
export class UpsertDailyMomentChargeDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  driverChargeId?: number; // maps to driver_charge_ID

  @Type(() => Number)
  @IsInt()
  itineraryPlanId!: number; // itinerary_plan_ID

  @Type(() => Number)
  @IsInt()
  itineraryRouteId!: number; // itinerary_route_ID

  @IsNotEmpty()
  @IsString()
  chargeType!: string; // charge_type

  @Type(() => Number)
  @IsNumber()
  chargeAmount!: number; // charge_amount
}

export class DailyMomentChargeRowDto {
  driver_charge_ID!: number;
  itinerary_plan_ID!: number;
  itinerary_route_ID!: number;
  charge_type!: string | null;
  charge_amount!: number;
}

/**
 * Driver Rating listing DTO (per day)
 */
export class DriverRatingRowDto {
  driver_feedback_ID!: number;
  itinerary_plan_ID!: number;
  itinerary_route_ID!: number;
  route_date!: string; // dd-mm-YYYY
  location_name!: string | null;
  next_visiting_location!: string | null;
  driver_rating!: string | null;
  driver_description!: string | null;
}

/**
 * Guide Rating listing DTO (per day, using guide reviews + route_guide mapping)
 */
export class GuideRatingRowDto {
  guide_review_id!: number;
  itinerary_plan_ID!: number;
  itinerary_route_ID!: number;
  route_date!: string; // dd-mm-YYYY
  location_name!: string | null;
  next_visiting_location!: string | null;
  guide_id!: number;
  guide_name!: string | null;
  guide_rating!: string | null;
  guide_description!: string | null;
}

/**
 * Route Hotspot DTO (for the pink cards with Visited / Not-Visited buttons)
 */
export class DailyMomentHotspotRowDto {
  // ordering inside the day (1,2,3,...)
  serial_no!: number;

  // identifiers
  confirmed_route_hotspot_ID!: number;
  route_hotspot_ID!: number;
  itinerary_plan_ID!: number;
  itinerary_route_ID!: number;
  hotspot_ID!: number;
  item_type!: number; // 4=hotspot,6=hotel,7=travel

  // display info
  hotspot_name!: string;
  hotspot_location!: string;

  // timing & duration
  start_time!: string; // e.g. "01:56 PM"
  end_time!: string; // e.g. "03:26 PM"
  duration_minutes!: number; // total minutes
  duration_label!: string; // e.g. "1 Hour 30 Min"

  // visit status (for buttons)
  driver_hotspot_status!: number; // 0=pending, 1=visited, 2=not-visited
  driver_not_visited_description!: string | null;
  guide_hotspot_status!: number;
  guide_not_visited_description!: string | null;

  // optional nested activities in day-view
  activities?: DayViewActivityDto[];
}

// ─── Day-View DTOs ────────────────────────────────────────────────────────────

export class DayViewKmDto {
  opening_km!: string;
  closing_km!: string;
  opening_speedmeter_image?: string | null;
  closing_speedmeter_image?: string | null;
  running_km!: number;
  completed!: boolean;
}

export class DayViewActivityDto {
  confirmed_route_activity_ID!: number;
  route_activity_ID!: number;
  route_hotspot_ID!: number;
  hotspot_ID!: number;
  activity_ID!: number;
  activity_title!: string;
  driver_activity_status!: number;
  driver_not_visited_description!: string | null;
  guide_activity_status!: number;
  guide_not_visited_description!: string | null;
}

export class DayViewGuideDto {
  confirmed_route_guide_ID!: number;
  guide_id!: number;
  guide_name!: string;
  guide_type!: number; // 1=whole-day, 2=per-route
  driver_guide_status!: number; // 0=pending,1=visited,2=not-visited
  driver_not_visited_description!: string | null;
}

export class DayViewDayDto {
  day_number!: number;
  itinerary_route_ID!: number;
  confirmed_itinerary_route_ID?: number;
  route_date!: string; // DD-MM-YYYY
  from_location!: string;
  to_location!: string;
  trip_type!: 'Arrival' | 'Departure' | 'Ongoing';
  arrival_flight_details!: string;
  departure_flight_details!: string;
  hotel_name!: string;
  vehicle_type_title!: string;
  vendor_name!: string;
  meal_plan!: string;
  vehicle_no!: string;
  driver_name!: string;
  driver_mobile!: string;
  agent_name!: string;
  special_remarks!: string;
  km!: DayViewKmDto;
  wholeday_guide!: DayViewGuideDto | null;
  guides!: DayViewGuideDto[];
  hotspots!: DailyMomentHotspotRowDto[];
}

export class DayViewPlanDto {
  itinerary_plan_ID!: number;
  quote_id!: string;
  trip_start_date!: string;
  trip_end_date!: string;
  no_of_days!: number;
  no_of_nights!: number;
  arrival_location!: string;
  departure_location!: string;
  guest_name!: string;
  guest_mobile!: string;
  guest_email!: string;
  travel_expert_name!: string;
  travel_expert_mobile!: string;
  travel_expert_email!: string;
  days!: DayViewDayDto[];
}

// ─── Status Update DTOs ───────────────────────────────────────────────────────

export class UpdateHotspotStatusDto {
  @IsNotEmpty()
  @Type(() => Number)
  @IsInt()
  confirmedRouteHotspotId!: number;

  @IsInt()
  @Min(0)
  status!: number; // 1=visited, 2=not-visited

  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateGuideStatusDto {
  @IsNotEmpty()
  @Type(() => Number)
  @IsInt()
  confirmedRouteGuideId!: number;

  @IsInt()
  @Min(0)
  status!: number;

  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateWholedayGuideStatusDto {
  @IsNotEmpty()
  @Type(() => Number)
  @IsInt()
  confirmedItineraryRouteId!: number; // PK of dvi_confirmed_itinerary_route_details

  @IsInt()
  @Min(0)
  status!: number;

  @IsOptional()
  @IsString()
  description?: string;
}

// ─── Rating DTOs ──────────────────────────────────────────────────────────────

export class UpsertDriverRatingDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  driverFeedbackId?: number;

  @Type(() => Number)
  @IsInt()
  itineraryPlanId!: number;

  @Type(() => Number)
  @IsInt()
  itineraryRouteId!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  customerRating!: number;

  @IsOptional()
  @IsString()
  feedbackDescription?: string;
}

export class UpsertGuideRatingDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  guideReviewId?: number;

  @Type(() => Number)
  @IsInt()
  itineraryPlanId!: number;

  @Type(() => Number)
  @IsInt()
  itineraryRouteId!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  guideId?: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  guideRating!: number;

  @IsOptional()
  @IsString()
  guideDescription?: string;
}

export class UpdateActivityStatusDto {
  @IsNotEmpty()
  @Type(() => Number)
  @IsInt()
  confirmedRouteActivityId!: number;

  @IsInt()
  @Min(0)
  status!: number;

  @IsOptional()
  @IsString()
  description?: string;
}

// ─── Kilometer DTOs ───────────────────────────────────────────────────────────

export class SaveOpeningKmDto {
  @Type(() => Number)
  @IsInt()
  itineraryPlanId!: number;

  @Type(() => Number)
  @IsInt()
  itineraryRouteId!: number;

  @IsNotEmpty()
  @IsString()
  startingKilometer!: string;
}

export class SaveClosingKmDto {
  @Type(() => Number)
  @IsInt()
  itineraryPlanId!: number;

  @Type(() => Number)
  @IsInt()
  itineraryRouteId!: number;

  @IsNotEmpty()
  @IsString()
  closingKilometer!: string;
}
