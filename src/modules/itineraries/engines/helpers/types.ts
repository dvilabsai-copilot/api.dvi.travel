// FILE: src/modules/itineraries/engines/helpers/types.ts

export interface HotspotDetailRow {
  itinerary_plan_ID: number;
  itinerary_route_ID: number;
  item_type: number;
  hotspot_order: number;
 hotspot_ID?: number; // Optional: PHP doesn't set this for item_type=1 (refreshment)

 hotspot_adult_entry_cost?: number; // Optional: only for item_type=4 (stay)
  hotspot_child_entry_cost?: number;
  hotspot_infant_entry_cost?: number;
  hotspot_foreign_adult_entry_cost?: number;
  hotspot_foreign_child_entry_cost?: number;
  hotspot_foreign_infant_entry_cost?: number;
  hotspot_amout?: number;

  hotspot_traveling_time: Date | string;
  itinerary_travel_type_buffer_time?: Date | string;
 hotspot_travelling_distance?: string | null; // Optional: only for item_type=3 (travel)

  hotspot_start_time: Date | string;
  hotspot_end_time: Date | string;

  allow_break_hours?: 0 | 1;
  allow_via_route?: 0 | 1;
  via_location_name?: string | null;
  hotspot_plan_own_way?: 0 | 1;

 // Conflict tracking (not in DB, used for UI/Preview)
  isConflict?: boolean;
  conflictReason?: string;
  isManual?: boolean;

  createdby: number;
  createdon?: Date;
  updatedon?: Date | null;
  status: 0 | 1;
  deleted: 0 | 1;
}

export enum RebuildWarningSeverity {
  GREEN = 'green',
  YELLOW = 'yellow',
  ORANGE = 'orange',
  RED = 'red',
}

export interface RebuildWarning {
  code: string;
  severity: RebuildWarningSeverity;
  message: string;
  routeId?: number;
  hotspotId?: number;
}

export interface RebuildSummary {
  planId: number;
  totalHotspotsAttempted: number;
  totalHotspotsScheduled: number;
  totalHotspotsDropped: number;
  totalHotspotsShifted: number;
  warningCount: number;
  hasCriticalIssues: boolean;
}

export interface RouteRejectionSummary {
  totalRejectedCandidates: number;
  totalSelectedCandidates: number;
  routeEnd: number;
  operatingHours: number;
  duplicate: number;
  noRemainingWindow: number;
  other: number;
}
