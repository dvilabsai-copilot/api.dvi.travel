import type { RoomOccupancy } from '../interfaces/hotel-provider.interface';

type TboDayRate = { BasePrice?: unknown };

export type TboRoomNightBreakdown = {
  roomNumber: number;
  date: string;
  adults: number;
  children: number;
  childrenAges: number[];
  baseAmount: number;
  fareAdjustment: number;
  allInAmount: number;
  nightTotal: number;
};

export type TboRouteNightPricingInput = {
  routeId: number;
  routeDate: string;
  breakdown: unknown;
  marginPercentage: number;
};

export type TboRouteNightPricing = {
  routeId: number;
  routeDate: string;
  baseTotalPrice: number;
  hotelMarginAmount: number;
  totalPrice: number;
};

const toCents = (value: unknown): number | null => {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null;
};

/**
 * Convert the supplier's room-night lines into one payable amount per route.
 * A continuous-stay rate can carry an averaged per-night amount at the parent
 * level, so route rows must use the date-matched room lines instead. Margin
 * rounding is allocated across the selected nights so their sum remains the
 * correctly rounded margin for the complete stay.
 */
export function allocateTboRouteNightPricing(
  selections: TboRouteNightPricingInput[],
): Map<number, TboRouteNightPricing> | undefined {
  if (!Array.isArray(selections) || selections.length === 0) return undefined;

  const routeNights = selections.map((selection) => {
    const routeDate = String(selection.routeDate || '').slice(0, 10);
    const routeId = Number(selection.routeId);
    const percentage = Number(selection.marginPercentage);
    if (!routeDate || !Number.isInteger(routeId) || routeId <= 0 || !Number.isFinite(percentage) || percentage < 0) {
      return null;
    }
    if (!Array.isArray(selection.breakdown)) return null;
    const matchingRows = selection.breakdown.filter((item: any) =>
      String(item?.date || '').slice(0, 10) === routeDate,
    );
    if (matchingRows.length === 0) return null;
    const roomAmounts = matchingRows.map((item: any) => toCents(item?.allInAmount));
    if (roomAmounts.some((amount) => amount === null)) return null;
    const baseCents = (roomAmounts as number[]).reduce((sum, amount) => sum + amount, 0);
    if (baseCents <= 0) return null;
    const reportedNightTotals = matchingRows.map((item: any) => toCents(item?.nightTotal));
    if (reportedNightTotals.some((amount) => amount === null) ||
      reportedNightTotals.some((amount) => amount !== baseCents)) return null;
    return {
      routeId,
      routeDate,
      baseCents,
      exactMarginCents: (baseCents * percentage) / 100,
    };
  });
  if (routeNights.some((item) => item === null)) return undefined;

  const validNights = routeNights as Array<NonNullable<(typeof routeNights)[number]>>;
  const targetMarginCents = Math.round(validNights.reduce((sum, item) => sum + item.exactMarginCents, 0));
  const allocated = validNights.map((item, index) => ({
    index,
    cents: Math.floor(item.exactMarginCents),
    fraction: item.exactMarginCents - Math.floor(item.exactMarginCents),
  }));
  let remainingCents = targetMarginCents - allocated.reduce((sum, item) => sum + item.cents, 0);
  const allocationOrder = [...allocated].sort((left, right) =>
    right.fraction - left.fraction || left.index - right.index,
  );
  for (let index = 0; index < remainingCents; index += 1) {
    allocationOrder[index % allocationOrder.length].cents += 1;
  }

  const marginByIndex = new Map(allocated.map((item) => [item.index, item.cents]));
  return new Map(validNights.map((item, index) => {
    const marginCents = marginByIndex.get(index) || 0;
    const payableCents = item.baseCents + marginCents;
    return [item.routeId, {
      routeId: item.routeId,
      routeDate: item.routeDate,
      baseTotalPrice: item.baseCents / 100,
      hotelMarginAmount: marginCents / 100,
      totalPrice: payableCents / 100,
    }];
  }));
}

/**
 * Allocate TBO's aggregate fare difference over the returned room-night base
 * rates. Largest-remainder rounding makes the displayed all-in lines reconcile
 * exactly to TBO TotalFare, including its final paisa.
 */
export function buildTboRoomNightBreakdown(args: {
  dayRates: unknown;
  totalFare: unknown;
  checkInDate: string;
  occupancies?: RoomOccupancy[];
}): TboRoomNightBreakdown[] | undefined {
  const { dayRates, checkInDate, occupancies = [] } = args;
  const fareCents = toCents(args.totalFare);
  if (!Array.isArray(dayRates) || dayRates.length === 0 || fareCents === null) return undefined;

  const start = new Date(`${String(checkInDate).slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime())) return undefined;

  const entries: Array<{
    roomNumber: number;
    date: string;
    occupancy: RoomOccupancy;
    baseCents: number;
  }> = [];

  dayRates.forEach((roomRates, roomIndex) => {
    if (!Array.isArray(roomRates) || roomRates.length === 0) return;
    const occupancy = occupancies[roomIndex] || { adults: 0, children: 0, childrenAges: [] };
    roomRates.forEach((rate: TboDayRate, nightIndex: number) => {
      const baseCents = toCents(rate?.BasePrice);
      if (baseCents === null) return;
      const night = new Date(start);
      night.setUTCDate(start.getUTCDate() + nightIndex);
      entries.push({
        roomNumber: roomIndex + 1,
        date: night.toISOString().slice(0, 10),
        occupancy,
        baseCents,
      });
    });
  });

  const baseTotalCents = entries.reduce((sum, entry) => sum + entry.baseCents, 0);
  if (entries.length === 0 || baseTotalCents <= 0) return undefined;

  const differenceCents = fareCents - baseTotalCents;
  const allocations = entries.map((entry, index) => {
    const exact = (differenceCents * entry.baseCents) / baseTotalCents;
    const floor = Math.floor(exact);
    return { index, cents: floor, fraction: exact - floor };
  });
  let remainingCents = differenceCents - allocations.reduce((sum, item) => sum + item.cents, 0);
  const allocationOrder = [...allocations].sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let index = 0; remainingCents > 0; index += 1, remainingCents -= 1) {
    allocationOrder[index % allocationOrder.length].cents += 1;
  }
  for (let index = allocations.length - 1; remainingCents < 0; index -= 1, remainingCents += 1) {
    allocations[index].cents -= 1;
  }

  const allocatedByIndex = new Map(allocations.map((allocation) => [allocation.index, allocation.cents]));
  const result = entries.map((entry, index) => {
    const adjustmentCents = allocatedByIndex.get(index) || 0;
    const allInCents = entry.baseCents + adjustmentCents;
    if (allInCents < 0) return null;
    return {
      roomNumber: entry.roomNumber,
      date: entry.date,
      adults: Math.max(Number(entry.occupancy.adults) || 0, 0),
      children: Math.max(Number(entry.occupancy.children) || 0, 0),
      childrenAges: Array.isArray(entry.occupancy.childrenAges)
        ? entry.occupancy.childrenAges.map(Number).filter((age) => Number.isFinite(age) && age >= 0)
        : [],
      baseAmount: entry.baseCents / 100,
      fareAdjustment: adjustmentCents / 100,
      allInAmount: allInCents / 100,
    };
  });

  if (result.some((item) => item === null)) return undefined;
  const partialBreakdown = result as Array<Omit<TboRoomNightBreakdown, 'nightTotal'>>;
  const totalsByNight = new Map<string, number>();
  for (const item of partialBreakdown) {
    totalsByNight.set(item.date, (totalsByNight.get(item.date) || 0) + Math.round(item.allInAmount * 100));
  }
  const breakdown: TboRoomNightBreakdown[] = partialBreakdown.map((item) => ({
    ...item,
    nightTotal: (totalsByNight.get(item.date) || 0) / 100,
  }));
  if (Math.round(breakdown.reduce((sum, item) => sum + item.allInAmount, 0) * 100) !== fareCents) {
    return undefined;
  }
  return breakdown;
}
