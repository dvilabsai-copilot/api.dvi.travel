import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SystemRole, getRoleId, isVehicleAgentUser } from '../../auth/constants/system-role.constants';

export const VEHICLE_ONLY_PREFERENCE = 2;

export type VehicleAgentPlanSnapshot = {
  agent_id?: number | null;
  itinerary_preference?: number | null;
};

export function assertVehicleAgentCreatePolicy(user: any, plan: any): void {
  if (!isVehicleAgentUser(user)) return;

  const agentId = Number(user?.agentId ?? user?.agent_id ?? 0) || 0;
  if (agentId <= 0) {
    throw new ForbiddenException('Vehicle agent account is not linked to an active agent.');
  }
  if (Number(plan?.itinerary_preference) !== VEHICLE_ONLY_PREFERENCE) {
    throw new ForbiddenException('Vehicle agents can create vehicle-only itineraries only.');
  }
  if (Number(plan?.staff_id ?? 0) > 0) {
    throw new ForbiddenException('Vehicle agent staff ownership cannot be changed.');
  }
  if (plan?.agent_id !== undefined && plan?.agent_id !== null && Number(plan.agent_id) > 0 && Number(plan.agent_id) !== agentId) {
    throw new ForbiddenException('Vehicle agent ownership cannot be changed.');
  }
}

export function assertVehicleAgentUpdatePolicy(
  user: any,
  existing: VehicleAgentPlanSnapshot,
  requestedPlan: any,
): void {
  if (!isVehicleAgentUser(user)) return;

  const agentId = Number(user?.agentId ?? user?.agent_id ?? 0) || 0;
  if (agentId <= 0 || Number(existing.agent_id) !== agentId) {
    throw new ForbiddenException('You are not allowed to edit this itinerary.');
  }
  if (Number(existing.itinerary_preference) !== VEHICLE_ONLY_PREFERENCE) {
    throw new ForbiddenException('Vehicle agents can access vehicle-only itineraries only.');
  }
  if (Number(requestedPlan?.itinerary_preference) !== VEHICLE_ONLY_PREFERENCE) {
    throw new ForbiddenException('Vehicle-only itinerary preference cannot be changed.');
  }
  if (Number(requestedPlan?.staff_id ?? 0) > 0) {
    throw new ForbiddenException('Vehicle agent staff ownership cannot be changed.');
  }
  if (requestedPlan?.agent_id !== undefined && Number(requestedPlan.agent_id) > 0 && Number(requestedPlan.agent_id) !== agentId) {
    throw new ForbiddenException('Vehicle agent ownership cannot be changed.');
  }
}

export function assertVehicleAgentPlanAccess(user: any, plan: VehicleAgentPlanSnapshot): void {
  if (!isVehicleAgentUser(user)) return;
  const agentId = Number(user?.agentId ?? user?.agent_id ?? 0) || 0;
  if (agentId <= 0 || Number(plan.agent_id) !== agentId || Number(plan.itinerary_preference) !== VEHICLE_ONLY_PREFERENCE) {
    throw new ForbiddenException('You are not allowed to access this itinerary.');
  }
}

export function assertVehicleAgentHotelMutation(user: any): void {
  if (getRoleId(user) === SystemRole.VEHICLE_AGENT) {
    throw new ForbiddenException('Vehicle agents cannot modify hotel data.');
  }
}

export function hasHotelPayload(dto: any): boolean {
  const hotelKeys = ['hotel_bookings', 'hotels', 'hotel_details', 'selected_hotels', 'hotelBookings'];
  const candidates = [dto, dto?.plan].filter(Boolean);
  return candidates.some((candidate) =>
    hotelKeys.some((key) => Array.isArray(candidate?.[key])
      ? candidate[key].length > 0
      : candidate?.[key] != null)
    || Array.isArray(candidate?.hotel_facilities) && candidate.hotel_facilities.length > 0
    || Array.isArray(candidate?.preferred_hotel_category) && candidate.preferred_hotel_category.length > 0,
  );
}

export function assertVehicleAgentNoHotelPayload(user: any, dto: any): void {
  if (isVehicleAgentUser(user) && hasHotelPayload(dto)) {
    throw new ForbiddenException('Vehicle agents cannot submit hotel data.');
  }
}
