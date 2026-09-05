/**
 * Role IDs shared by authentication and authorization code.
 *
 * Role 7 is already used by the legacy sales/menu tables. Role 9 is the
 * first unused numeric role in the current database and is reserved for the
 * restricted vehicle-only agent account.
 */
export const SystemRole = {
  ADMIN: 1,
  VENDOR: 2,
  STAFF: 3,
  AGENT: 4,
  GUIDE: 5,
  ACCOUNTS: 6,
  TRAVEL_EXPERT: 8,
  VEHICLE_AGENT: 9,
  HOTEL_ADMIN: 10,
} as const;

export type SystemRoleId = (typeof SystemRole)[keyof typeof SystemRole];

export function getRoleId(user: any): number {
  return Number(user?.roleID ?? user?.roleId ?? user?.role ?? 0) || 0;
}

export function isVehicleAgentUser(user: any): boolean {
  return getRoleId(user) === SystemRole.VEHICLE_AGENT;
}
