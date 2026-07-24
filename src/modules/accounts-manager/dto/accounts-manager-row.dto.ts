// FILE: src/modules/accounts-manager/dto/accounts-manager-row.dto.ts

export type AccountsManagerRowStatus = "paid" | "due";

export type AccountsManagerRowComponentType =
  | "guide"
  | "hotspot"
  | "activity"
  | "hotel"
  | "vehicle";

/**
 * Shape returned by /accounts-manager for each row in the table.
 * Property names are aligned with the React <AccountsManager /> page
 * (see AccountRow type in AccountsManager.tsx).
 */
export class AccountsManagerRowDto {
 /**
   * Primary key of the underlying *_details row
   * (e.g. accounts_itinerary_hotel_details_ID).
 */
  id!: number;

 /**
   * Header primary key: accounts_itinerary_details_ID
   * from dvi_accounts_itinerary_details.
   * Used by Pay Now to validate / link header-detail relationship.
 */
  headerId!: number;

 /** itinerary_quote_ID from dvi_accounts_itinerary_details */
  quoteId!: string;

 /**
   * Generic "name" column used by the UI.
   * - For hotels: dvi_hotel.hotel_name
   * - For vehicles: registration_number / owner_name
   * - For guides: dvi_guide_details.guide_name
   * - For hotspots: dvi_hotspot_place.hotspot_name
   * - For activities: dvi_activity.activity_name
 */
  hotelName!: string;

 /** Component-level payable amount (total_payable from *_details) */
  amount!: number;

 /** Component-level payout (total_paid from *_details) */
  payout!: number;

 /** Component-level balance (total_balance from *_details) */
  payable!: number;

 /** Derived from payable: "paid" (balance <= 0) or "due" (balance > 0) */
  status!: AccountsManagerRowStatus;

 /** Component type: hotel / vehicle / guide / hotspot / activity */
  componentType!: AccountsManagerRowComponentType;

 /** Agent name (dvi_agent.agent_name) */
  agent?: string;

 /** Trip start date (header.trip_start_date_and_time) in DD/MM/YYYY */
  startDate?: string;

 /** Trip end date (header.trip_end_date_and_time) in DD/MM/YYYY */
  endDate?: string;

 /** Optional per-route date (itinerary_route_date / confirmed route date) in DD/MM/YYYY */
  routeDate?: string;

 /** Optional IDs used by future Pay Now / drill-down flows */
  vehicleId?: number;
  vendorId?: number;

 // --- NEW FIELDS FOR PARITY ---
  receivableFromAgentAmount?: number;
  inhandAmount?: number;
  marginAmount?: number;
  tax?: number;
  guestName?: string;
  arrivalLocation?: string;
  departureLocation?: string;
  roomCount?: number;
}
