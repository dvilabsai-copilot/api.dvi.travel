/**
 * Validate complete room coverage across TBO supplier requests before PreBook
 * or Book. This is a structural check, not a supplier availability guarantee.
 * Never combine the BookingCodes or infer missing room assignments.
 */
export type TboCompleteBatchSelection = {
  routeId: number;
  hotelCode: string;
  checkInDate: string;
  checkOutDate: string;
  bookingCode: string;
  numberOfRooms: number;
  batchIndex?: number;
  startRoomIndex?: number;
  occupancies?: Array<{
    adults: number;
    children: number;
    childrenAges?: number[];
  }>;
};

export function validateTboCompleteBatchGroups(
  selections: readonly TboCompleteBatchSelection[],
  planRoomCount: number,
): string | null {
  if (!Number.isInteger(planRoomCount) || planRoomCount < 1 || planRoomCount > 25) {
    return 'The itinerary has an invalid room count for TBO booking.';
  }
  // Keep the existing 1–6-room supplier path intact.
  if (planRoomCount <= 6) return null;
  if (!Array.isArray(selections) || selections.length === 0) {
    return `TBO ${planRoomCount}-room stay requires complete supplier batches before PreBook or Book.`;
  }

  const expectedBatchCount = Math.ceil(planRoomCount / 6);
  const grouped = new Map<string, TboCompleteBatchSelection[]>();
  const stayIdentityByDates = new Map<string, { routeId: number; hotelCode: string }>();
  const allSupplierBookingCodes = new Set<string>();
  for (const selection of selections) {
    const routeId = Number(selection.routeId);
    const hotelCode = String(selection.hotelCode || '').trim();
    const checkInDate = String(selection.checkInDate || '').slice(0, 10);
    const checkOutDate = String(selection.checkOutDate || '').slice(0, 10);
    if (!Number.isInteger(routeId) || routeId <= 0 || !hotelCode ||
        !/^\d{4}-\d{2}-\d{2}$/.test(checkInDate) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOutDate)) {
      return 'Each TBO batch must identify the itinerary route, hotel and stay dates.';
    }
    const checkInTime = Date.parse(`${checkInDate}T00:00:00.000Z`);
    const checkOutTime = Date.parse(`${checkOutDate}T00:00:00.000Z`);
    if (!Number.isFinite(checkInTime) || !Number.isFinite(checkOutTime) ||
        new Date(checkInTime).toISOString().slice(0, 10) !== checkInDate ||
        new Date(checkOutTime).toISOString().slice(0, 10) !== checkOutDate ||
        checkOutTime <= checkInTime) {
      return 'Each TBO supplier batch must cover a valid positive-length hotel stay.';
    }
    // One continuous stay is one physical property and ONE supplier booking
    // anchor route. Separate itinerary-night rows must never generate another
    // independent 6+N set for the same check-in/check-out dates.
    const datesKey = JSON.stringify([checkInDate, checkOutDate]);
    const priorStay = stayIdentityByDates.get(datesKey);
    if (priorStay && (priorStay.hotelCode !== hotelCode || priorStay.routeId !== routeId)) {
      return 'One continuous TBO hotel stay cannot be split across different properties or itinerary routes.';
    }
    stayIdentityByDates.set(datesKey, { routeId, hotelCode });
    const key = JSON.stringify([routeId, hotelCode, checkInDate, checkOutDate]);
    grouped.set(key, [...(grouped.get(key) || []), selection]);
  }

  for (const group of grouped.values()) {
    if (group.length !== expectedBatchCount) {
      return `TBO ${planRoomCount}-room stay needs ${expectedBatchCount} supplier batches; received ${group.length}.`;
    }
    const byIndex = [...group].sort((a, b) => Number(a.batchIndex) - Number(b.batchIndex));
    // A mixed room/rate/refund policy is not an ordinary one-off booking.
    // Optional metadata is checked when it exists but its absence is NOT
    // evidence that the supplier has validated rate compatibility.
    for (const field of ['roomType', 'mealPlan', 'currency', 'isRefundable'] as const) {
      const values = group.map((item) => (item as TboCompleteBatchSelection & Record<string, unknown>)[field]);
      if (values.some((value) => value !== undefined && value !== null)) {
        const first = values[0];
        if (values.some((value) => value === undefined || value === null || value !== first)) {
          return `TBO supplier batches have incompatible ${field} values.`;
        }
      }
    }
    const codes = new Set<string>();
    let coveredRooms = 0;
    for (let index = 0; index < expectedBatchCount; index += 1) {
      const batch = byIndex[index];
      const expectedRooms = Math.min(6, planRoomCount - index * 6);
      if (batch.batchIndex !== index || batch.startRoomIndex !== index * 6 ||
          batch.numberOfRooms !== expectedRooms) {
        return `TBO batch ${index + 1} must contain rooms ${index * 6 + 1}–${index * 6 + expectedRooms}.`;
      }
      const code = String(batch.bookingCode || '').trim();
      if (!code.includes('!TB!') || codes.has(code) || allSupplierBookingCodes.has(code)) {
        return 'Each TBO supplier batch requires its own distinct valid BookingCode.';
      }
      codes.add(code);
      allSupplierBookingCodes.add(code);
      const occupancies = batch.occupancies;
      if (!Array.isArray(occupancies) || occupancies.length !== expectedRooms) {
        return `TBO batch ${index + 1} requires ${expectedRooms} exact room occupancies.`;
      }
      for (const occupancy of occupancies) {
        if (!Number.isInteger(occupancy.adults) || occupancy.adults < 1 || occupancy.adults > 8 ||
            !Number.isInteger(occupancy.children) || occupancy.children < 0 || occupancy.children > 4 ||
            !Array.isArray(occupancy.childrenAges) || occupancy.childrenAges.length !== occupancy.children ||
            occupancy.childrenAges.some((age) => !Number.isInteger(age) || age < 0 || age > 11)) {
          return 'Every TBO room needs 1–8 adults, 0–4 children and all actual child ages (0–11).';
        }
      }
      coveredRooms += batch.numberOfRooms;
    }
    if (coveredRooms !== planRoomCount) {
      return 'TBO supplier batches do not cover every requested room.';
    }
  }
  return null;
}
