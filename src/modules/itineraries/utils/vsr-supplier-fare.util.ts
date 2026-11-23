import { hotelDateOnly } from './hotel-stay-pricing.util';
import { parseHotelSelectionSnapshot } from './hotel-selection-identity.util';
import { normalizeTboHoldAmount } from './tbo-hold-price-approval.util';

type SavedHotelRow = Parameters<typeof parseHotelSelectionSnapshot>[0];
type VsrPricingSnapshot = ReturnType<typeof parseHotelSelectionSnapshot> & {
  tboRoomNightBreakdown?: { date?: unknown; roomNumber?: unknown; allInAmount?: unknown }[];
  nightlyRates?: { date?: unknown; itineraryRouteDate?: unknown; baseAmount?: unknown }[];
  baseTotalPrice?: unknown;
};

/** Compare PreBook to the supplier fare, before DVI margin and local meals. */
export function savedVsrSupplierFare(rows: SavedHotelRow[], checkIn: unknown, checkOut: unknown): number | null {
  const start = hotelDateOnly(checkIn);
  const end = hotelDateOnly(checkOut);
  if (!start || !end || start >= end) return null;
  const nights = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000);
  const nightlyFare = new Map<string, number>();

  for (const row of rows) {
    const snapshot = parseHotelSelectionSnapshot(row) as VsrPricingSnapshot;
    const roomNights = new Map<string, Map<number, number>>();
    for (const room of Array.isArray(snapshot.tboRoomNightBreakdown) ? snapshot.tboRoomNightBreakdown : []) {
      const date = hotelDateOnly(room?.date);
      const amount = normalizeTboHoldAmount(room?.allInAmount);
      const roomNumber = Number(room?.roomNumber);
      if (!date || amount === null || !Number.isInteger(roomNumber) || roomNumber < 1) continue;
      const rooms = roomNights.get(date) ?? new Map<number, number>();
      rooms.set(roomNumber, amount);
      roomNights.set(date, rooms);
    }
    const roomCount = Math.max(Number(row.total_no_of_rooms) || 1, 1);
    for (const [date, rooms] of roomNights) {
      if (rooms.size === roomCount) nightlyFare.set(date, Array.from(rooms.values()).reduce((sum, amount) => sum + amount, 0));
    }
    for (const night of Array.isArray(snapshot.nightlyRates) ? snapshot.nightlyRates : []) {
      const date = hotelDateOnly(night?.date ?? night?.itineraryRouteDate);
      const amount = normalizeTboHoldAmount(night?.baseAmount);
      if (date && amount !== null && !nightlyFare.has(date)) nightlyFare.set(date, amount);
    }
    const rowStart = hotelDateOnly(row.hotel_check_in_date ?? row.itinerary_route_date);
    const rowEnd = hotelDateOnly(row.hotel_check_out_date);
    const base = normalizeTboHoldAmount(snapshot.baseTotalPrice ?? row.total_room_cost);
    if (rowStart && base !== null && !nightlyFare.has(rowStart) &&
      (!rowEnd || Date.parse(rowEnd) - Date.parse(rowStart) === 86_400_000)) nightlyFare.set(rowStart, base);
  }

  const coveredFares = [...nightlyFare].filter(([date]) => date >= start && date < end);
  return coveredFares.length === nights
    ? normalizeTboHoldAmount(coveredFares.reduce((sum, [, amount]) => sum + amount, 0))
    : null;
}
