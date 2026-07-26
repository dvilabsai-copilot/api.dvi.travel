// FILE: src/modules/global-settings/dto/update-global-settings.dto.ts

import { Allow } from "class-validator";

export class UpdateGlobalSettingsDto {
  // The application uses a global whitelist ValidationPipe. Keep every
  // legacy PHP setting explicitly allowed so the update payload is not
  // silently reduced to an empty object.
  @Allow()
  eligibile_country_code?: string | null;

  @Allow()
  extrabed_rate_percentage?: number;
  @Allow()
  childwithbed_rate_percentage?: number;
  @Allow()
  childnobed_rate_percentage?: number;

  @Allow()
  hotel_margin?: number;
  @Allow()
  hotel_margin_gst_type?: boolean;
  @Allow()
  hotel_margin_gst_percentage?: number;

  @Allow()
  itinerary_distance_limit?: number;
  @Allow()
  allowed_km_limit_per_day?: number;

  @Allow()
  itinerary_common_buffer_time?: string | null;
  @Allow()
  itinerary_travel_by_flight_buffer_time?: string | null;
  @Allow()
  itinerary_travel_by_train_buffer_time?: string | null;
  @Allow()
  itinerary_travel_by_road_buffer_time?: string | null;
  @Allow()
  itinerary_break_time?: string | null;

  @Allow()
  itinerary_hotel_start?: string | null;
  @Allow()
  itinerary_hotel_return?: string | null;
  @Allow()
  itinerary_additional_margin_percentage?: number;
  @Allow()
  itinerary_additional_margin_day_limit?: number;

  @Allow()
  custom_hotspot_or_activity?: string | null;
  @Allow()
  accommodation_return?: string | null;
  @Allow()
  vehicle_terms_condition?: string | null;

  @Allow()
  itinerary_local_speed_limit?: number;
  @Allow()
  itinerary_outstation_speed_limit?: number;

  @Allow()
  agent_referral_bonus_credit?: number;

  @Allow()
  hotel_terms_condition?: string | null;
  @Allow()
  hotel_voucher_terms_condition?: string | null;
  @Allow()
  vehicle_voucher_terms_condition?: string | null;

  @Allow()
  site_title?: string | null;

  @Allow()
  company_name?: string | null;
  @Allow()
  company_address?: string | null;
  @Allow()
  company_pincode?: string | null;
  @Allow()
  company_gstin_no?: string | null;
  @Allow()
  company_pan_no?: string | null;
  @Allow()
  company_contact_no?: string | null;
  @Allow()
  company_email_id?: string | null;
  @Allow()
  company_logo?: string | null;

  @Allow()
  hotel_hsn?: string | null;
  @Allow()
  vehicle_hsn?: string | null;
  @Allow()
  service_component_hsn?: string | null;

  @Allow()
  site_seeing_restriction_km_limit?: number;

  @Allow()
  youtube_link?: string | null;
  @Allow()
  facebook_link?: string | null;
  @Allow()
  instagram_link?: string | null;
  @Allow()
  linkedin_link?: string | null;

  @Allow()
  cc_email_id?: string | null;
  @Allow()
  default_hotel_voucher_email_id?: string | null;
  @Allow()
  default_vehicle_voucher_email_id?: string | null;
  @Allow()
  default_accounts_email_id?: string | null;

  @Allow()
  company_cin?: string | null;
  @Allow()
  bank_acc_holder_name?: string | null;
  @Allow()
  bank_acc_no?: string | null;
  @Allow()
  bank_ifsc_code?: string | null;
  @Allow()
  bank_name?: string | null;
  @Allow()
  branch_name?: string | null;
}
