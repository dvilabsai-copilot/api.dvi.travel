// FILE: src/modules/global-settings/dto/state-config.dto.ts

import { Allow } from "class-validator";

export class StateConfigUpdateDto {
 // primary key of dvi_states
  @Allow()
  stateId!: number;

 // these map to dvi_states.vehicle_onground_support_number / vehicle_escalation_call_number
  @Allow()
  vehicleOngroundSupportNumber?: string | null;
  @Allow()
  vehicleEscalationCallNumber?: string | null;
}

// Response shape the API returns to frontend
export class StateConfigResultDto {
  stateId!: number;
  countryId!: number;
  stateName!: string;
  vehicleOngroundSupportNumber!: string | null;
  vehicleEscalationCallNumber!: string | null;
}
