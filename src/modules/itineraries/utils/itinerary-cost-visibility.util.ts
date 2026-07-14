/**
 * Roles allowed to see internal itinerary cost calculations.
 *
 * These IDs match dvi_users.roleID in the legacy application:
 * 1 = Admin, 3/8 = Travel Expert, 6 = Accounts.
 */
export const ITINERARY_COST_BREAKDOWN_VISIBLE_ROLES = new Set([1, 3, 6, 8]);

export function canViewItineraryCostBreakdown(role: unknown): boolean {
  const roleId = Number(role);
  return Number.isInteger(roleId) && ITINERARY_COST_BREAKDOWN_VISIBLE_ROLES.has(roleId);
}

export function isAgentRole(role: unknown): boolean {
  return Number(role) === 4;
}

const VEHICLE_COST_FIELDS = [
  'rentalCharges',
  'tollCharges',
  'tollBreakupText',
  'parkingCharges',
  'parkingBreakupText',
  'driverCharges',
  'permitCharges',
  'before6amDriver',
  'before6amVendor',
  'after8pmDriver',
  'after8pmVendor',
  'breakdown',
  'dayWisePricing',
  'totalDays',
  'totalCostOfVehicle',
  'totalPickupKm',
  'totalTravelKm',
  'totalSightseeingKm',
  'totalPickupDuration',
  'totalDropKm',
  'totalDropDuration',
  'totalUsedKm',
  'localUsedKm',
  'outstationUsedKm',
  'totalAllowedLocalKm',
  'totalAllowedOutstationKm',
  'totalAllowedKm',
  'localDaysCount',
  'outstationDaysCount',
  'outstationAllowedKmPerDay',
  'localAllowedKmBreakdown',
  'extraKms',
  'localExtraKms',
  'localExtraKmCharge',
  'outstationExtraKms',
  'outstationExtraKmCharge',
  'extraKmRate',
  'extraKmCharge',
  'extraHourCount',
  'extraHourRate',
  'extraHourCharge',
  'subtotal',
  'vehicleGstPercentage',
  'vehicleGstAmount',
  'vendorMarginPercentage',
  'vendorMarginAmount',
  'vendorMarginGstPercentage',
  'vendorMarginGstAmount',
  'grandTotal',
] as const;

/** Keep the vendor card and selling amount, but remove internal vehicle pricing. */
export function redactVehicleCostBreakdown<T extends Record<string, any>>(vehicle: T): T {
  const safeVehicle = { ...vehicle };
  for (const field of VEHICLE_COST_FIELDS) {
    delete safeVehicle[field];
  }
  return safeVehicle;
}

/** Agent view also hides supplier identity, matching the PHP vehicle table. */
export function redactVehicleForAgent<T extends Record<string, any>>(vehicle: T): T {
  const safeVehicle: Record<string, any> = redactVehicleCostBreakdown(vehicle);
  safeVehicle.vendorName = null;
  safeVehicle.branchName = null;
  return safeVehicle as T;
}

export function redactVehicleCostBreakdowns<T extends Record<string, any>>(vehicles: T[]): T[] {
  return vehicles.map(redactVehicleCostBreakdown);
}

/**
 * Preserve final payable totals while removing component costs and margins.
 * This mirrors the legacy PHP behavior where agents could see the final amount
 * but not the internal cost lines.
 */
export function redactItineraryCostBreakdown<T extends Record<string, any>>(costBreakdown: T): T {
  return {
    totalAmount: costBreakdown.totalAmount,
    couponDiscount: costBreakdown.couponDiscount,
    totalRoundOff: costBreakdown.totalRoundOff,
    netPayable: costBreakdown.netPayable,
    companyName: costBreakdown.companyName,
  } as unknown as T;
}
