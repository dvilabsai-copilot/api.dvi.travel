import { allocateTboRouteNightPricing } from '../../hotels/utils/tbo-room-night-pricing';
import { projectHotelPayablePricing } from './hotel-payable-pricing.util';

export interface HotelCardQuote {
  basis: 'ROUTE_NIGHT';
  routeId: number;
  date: string;
  roomCount: number;
  currency: string;
  payableAmount: number;
  baseAmount: number;
}

const positive = (...values: unknown[]): number => {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
};

/** Display projection only: never rewrite supplier/selection financial fields. */
export function buildHotelCardQuote(row: any, margin: number, rooms: number): HotelCardQuote | null {
  const routeId = Number(row?.itineraryRouteId || row?.routeId || 0);
  const date = String(row?.date || row?.itineraryRouteDate || row?.checkInDate || '').slice(0, 10);
  if (routeId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const roomCount = Math.max(Number(rooms || 1), 1);
  const provider = String(row?.provider || '').toLowerCase();
  const percentage = positive(margin);
  let payableAmount = 0;
  let baseAmount = 0;
  if (['tbo', 'vsr'].includes(provider) && Array.isArray(row?.tboRoomNightBreakdown) && row.tboRoomNightBreakdown.length) {
    // Cached nested totals can be projected twice. The server's supplier
    // room-night lines retain the exact amounts for unequal nightly fares.
    const breakdown = row.tboRoomNightBreakdown;
    const dates: string[] = Array.from(new Set<string>(breakdown.map((night: any) => String(night.date || '').slice(0, 10)))).sort();
    if (dates.some(day => !/^\d{4}-\d{2}-\d{2}$/.test(day))) return null;
    if (dates.some(day => new Set(breakdown.filter((night: any) => String(night.date).slice(0, 10) === day).map((night: any) => Number(night.roomNumber))).size !== roomCount)) return null;
    const prices = allocateTboRouteNightPricing(dates.map((day, index) => ({
      routeId: index + 1, routeDate: day, breakdown, marginPercentage: percentage,
    })));
    const price = prices?.get(dates.indexOf(date) + 1);
    if (!price) return null;
    baseAmount = price.baseTotalPrice;
    payableAmount = price.totalPrice + (row.tboMapFallbackApplied === true
      ? positive(row.tboMapFallbackDinnerPerNight) : 0);
  } else {
    const nightly = Array.isArray(row?.nightlyRates)
      ? row.nightlyRates.find((night: any) => String(night.date || '').slice(0, 10) === date)
      : null;
    // Do not average an opaque full-stay fare into an invented route quote.
    const nights = positive(row?.numberOfNights, row?.nights, 1);
    if (!nightly && nights > 1 && !positive(row?.pricePerNight)) return null;
    const nightlyBase = positive(nightly?.baseAmount);
    const source = nightlyBase > 0 ? {
      ...row, ...nightly, provider,
      basePricePerNight: nightlyBase / roomCount,
      baseTotalPrice: nightlyBase, totalRoomCost: nightlyBase,
      totalPrice: nightlyBase, totalStayPrice: nightlyBase, totalHotelCost: nightlyBase,
      price: nightlyBase, pricePerNight: nightlyBase,
      amountIncludesHotelMargin: false, pricingIncludesHotelMargin: false,
    } : row;
    const priced = projectHotelPayablePricing({ ...source, numberOfNights: 1, hotelMarginPercentage: percentage }, percentage);
    // Explicit nightly payable wins over an unrelated full-stay total.
    payableAmount = positive(priced.pricePerNight);
    baseAmount = positive(priced.basePricePerNight) * roomCount;
  }
  if (!(payableAmount > 0) || !Number.isFinite(payableAmount)) return null;
  return {
    basis: 'ROUTE_NIGHT', routeId, date, roomCount,
    currency: String(row?.currency || 'INR').toUpperCase(),
    payableAmount: Number(payableAmount.toFixed(2)), baseAmount: Number(baseAmount.toFixed(2)),
  };
}
