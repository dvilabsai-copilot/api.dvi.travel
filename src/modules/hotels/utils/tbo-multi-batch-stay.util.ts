import { validateTboCompleteBatchGroups } from './tbo-complete-batch-validation.util';
import { TBO_SEARCH_SESSION_VALIDITY_MS } from './tbo-search-session';
import { tboBatchMealPlan, tboBatchRoomTypeLabel } from './tbo-batch-hotel-matching.util';

/**
 * One physical property and one continuous check-in/check-out window.
 * Each item in batches is a genuine independent TBO supplier search offer.
 * Search success is NOT PreBook/Book success.
 */
export type TboStayBatch = {
  batchIndex: number;
  startRoomIndex: number;
  roomCount: number;
  bookingCode: string;
  supplierNetAmount: number;
  supplierTotalFare: number;
  occupancies: Array<{ adults: number; children: number; childrenAges?: number[] }>;
  hotelCode: string;
  roomType: string;
  mealPlan: string;
  currency: string;
  isRefundable: boolean;
};

export type TboStayMealSupplement = {
  mealPlan: 'CP' | 'MAP' | 'AP';
  breakfastRate: number;
  breakfastPerNight: number;
  dinnerRate: number;
  dinnerPerNight: number;
  lunchRate?: number;
  lunchPerNight?: number;
};

export type TboMultiBatchStaySnapshot = {
  schemaVersion: 1;
  provider: 'tbo';
  hotelCode: string;
  roomType: string;
  mealPlan: string;
  currency: string;
  isRefundable: boolean;
  anchorRouteId: number;
  routeIds: number[];
  checkInDate: string;
  checkOutDate: string;
  roomCount: number;
  supplierNetAmount: number;
  supplierTotalFare: number;
  searchVerifiedAt: string;
  batches: TboStayBatch[];
  dviMealSupplement?: TboStayMealSupplement;
};

export function assertTboMultiBatchStay(
  stay: TboMultiBatchStaySnapshot,
): void {
  if (stay?.schemaVersion !== 1 || stay.provider !== 'tbo' ||
      !Number.isInteger(stay.roomCount) || stay.roomCount < 7 || stay.roomCount > 25 ||
      !Array.isArray(stay.batches) || !Array.isArray(stay.routeIds) ||
      !Number.isInteger(stay.anchorRouteId) || stay.anchorRouteId <= 0 ||
      stay.routeIds.length === 0 || stay.routeIds[0] !== stay.anchorRouteId ||
      new Set(stay.routeIds).size !== stay.routeIds.length ||
      stay.routeIds.some((id) => !Number.isInteger(id) || id <= 0) ||
      !String(stay.hotelCode || '').trim() ||
      !String(stay.roomType || '').trim() ||
      !String(stay.currency || '').trim()) {
    throw new Error('Incomplete logical TBO hotel stay.');
  }
  const nights = (Date.parse(`${stay.checkOutDate}T00:00:00Z`) -
    Date.parse(`${stay.checkInDate}T00:00:00Z`)) / 86400000;
  if (!Number.isInteger(nights) || nights !== stay.routeIds.length) {
    throw new Error('The selected TBO stay dates do not match the continuous itinerary nights.');
  }
  if (stay.batches.some((batch) =>
    batch.hotelCode !== stay.hotelCode ||
    !String(batch.roomType || '').trim() ||
    batch.currency !== stay.currency ||
    batch.isRefundable !== stay.isRefundable ||
    !Number.isFinite(batch.supplierNetAmount) || batch.supplierNetAmount <= 0 ||
    !Number.isFinite(batch.supplierTotalFare) || batch.supplierTotalFare <= 0)) {
    throw new Error('TBO batches must have one hotel, compatible rates and genuine positive supplier amounts.');
  }
  if (stay.roomType !== tboBatchRoomTypeLabel(stay.batches)) {
    throw new Error('The TBO stay room summary must match the supplier batches.');
  }
  if (!stay.mealPlan || stay.mealPlan !== tboBatchMealPlan(stay.batches)) {
    throw new Error('The TBO stay meal plan must match the supplier batches.');
  }
  const coverageError = validateTboCompleteBatchGroups(
    stay.batches.map((batch) => ({
      routeId: stay.anchorRouteId,
      hotelCode: batch.hotelCode,
      checkInDate: stay.checkInDate,
      checkOutDate: stay.checkOutDate,
      bookingCode: batch.bookingCode,
      numberOfRooms: batch.roomCount,
      batchIndex: batch.batchIndex,
      startRoomIndex: batch.startRoomIndex,
      occupancies: batch.occupancies,
      roomType: batch.roomType,
      mealPlan: batch.mealPlan,
      currency: batch.currency,
      isRefundable: batch.isRefundable,
    })),
    stay.roomCount,
  );
  if (coverageError) throw new Error(coverageError);
  const sumCents = (field: 'supplierNetAmount' | 'supplierTotalFare') =>
    stay.batches.reduce((cents, batch) => cents + Math.round(batch[field] * 100), 0);
  if (Math.abs(sumCents('supplierNetAmount') - Math.round(stay.supplierNetAmount * 100)) > 0 ||
      Math.abs(sumCents('supplierTotalFare') - Math.round(stay.supplierTotalFare * 100)) > 0) {
    throw new Error('The TBO stay total must equal the exact sum of its supplier batches.');
  }
  if (!Number.isFinite(Date.parse(stay.searchVerifiedAt))) {
    throw new Error('The supplier search verification timestamp is missing.');
  }
  const meals = stay.dviMealSupplement;
  if (stay.batches.some(batch => batch.mealPlan !== stay.mealPlan) &&
      (!meals || meals.breakfastRate <= 0 ||
        Math.round(meals.breakfastPerNight * 100) !== Math.round(meals.breakfastRate * getTboBreakfastGuestCount(stay.batches) * 100))) {
    throw new Error('Mixed supplier meal plans require breakfast for the room-only batches.');
  }
  if (meals && (stay.currency !== 'INR' ||
      !((stay.mealPlan === 'EP' && ['CP', 'MAP'].includes(meals.mealPlan)) ||
        (stay.mealPlan === 'CP' && ['MAP', 'AP'].includes(meals.mealPlan))) ||
      [meals.breakfastRate, meals.breakfastPerNight, meals.dinnerRate, meals.dinnerPerNight,
        meals.lunchRate ?? 0, meals.lunchPerNight ?? 0]
        .some(amount => !Number.isFinite(amount) || amount < 0))) {
    throw new Error('Invalid DVI meal supplement for the supplier stay.');
  }
  if (meals?.mealPlan === 'AP') {
    const guests = stay.batches.flatMap(batch => batch.occupancies)
      .reduce((count, room) => count + room.adults + room.children, 0);
    const lunchRate = meals.lunchRate ?? 0;
    if (lunchRate <= 0 || meals.dinnerRate <= 0 || meals.breakfastRate !== 0 || meals.breakfastPerNight !== 0 ||
        Math.round((meals.lunchPerNight ?? 0) * 100) !== Math.round(lunchRate * guests * 100) ||
        Math.round(meals.dinnerPerNight * 100) !== Math.round(meals.dinnerRate * guests * 100)) {
      throw new Error('AP requires priced lunch and dinner for all guests on the CP supplier stay.');
    }
  }
}

export function getTboBreakfastGuestCount(batches: readonly TboStayBatch[]): number {
  return batches.filter(batch => batch.mealPlan === 'EP')
    .reduce((count, batch) => count + batch.occupancies.reduce((guests, room) => guests + room.adults + room.children, 0), 0);
}

/** Stable route-night allocation; never multiply a whole-stay supplier total by nights. */
export function allocateFullStayCents(amount: number, routeIds: readonly number[]): number[] {
  if (!Number.isFinite(amount) || amount <= 0 || !Array.isArray(routeIds) || !routeIds.length) {
    throw new RangeError('A positive full-stay amount and route IDs are required.');
  }
  const totalCents = Math.round(amount * 100);
  const baseCents = Math.floor(totalCents / routeIds.length);
  const remainder = totalCents - baseCents * routeIds.length;
  return routeIds.map((_, index) => (baseCents + (index < remainder ? 1 : 0)) / 100);
}

export function priceTboMultiBatchStay(
  stay: Pick<TboMultiBatchStaySnapshot, 'supplierTotalFare' | 'routeIds' | 'dviMealSupplement'>,
  margin: number,
) {
  if (!Number.isFinite(margin) || margin < 0) throw new RangeError('Hotel margin is invalid.');
  const mealCostPerNight = Math.round(((stay.dviMealSupplement?.breakfastPerNight ?? 0) +
    (stay.dviMealSupplement?.lunchPerNight ?? 0) +
    (stay.dviMealSupplement?.dinnerPerNight ?? 0)) * 100) / 100;
  const roomPayable = Math.round(stay.supplierTotalFare * (100 + margin)) / 100;
  const baseByNight = allocateFullStayCents(stay.supplierTotalFare, stay.routeIds);
  const roomPayableByNight = allocateFullStayCents(roomPayable, stay.routeIds);
  return {
    totalPrice: Math.round((roomPayable + mealCostPerNight * stay.routeIds.length) * 100) / 100,
    baseByNight,
    marginByNight: roomPayableByNight.map((amount, index) => Math.round((amount - baseByNight[index]) * 100) / 100),
    payableByNight: roomPayableByNight.map(amount => Math.round((amount + mealCostPerNight) * 100) / 100),
    mealCostPerNight,
  };
}

/** Sell amounts for the approval UI with no supplier credentials. */
export function describeTboBatchRoomPrices(stay: TboMultiBatchStaySnapshot, margin: number, nightIndex?: number) {
  const totalGuests = stay.batches.reduce((count, batch) => count +
    batch.occupancies.reduce((guests, room) => guests + room.adults + room.children, 0), 0);
  const pricedNights = nightIndex === undefined ? stay.routeIds.length : 1;
  const pricing = priceTboMultiBatchStay(stay, margin);
  const dinnerCents = Math.round((stay.dviMealSupplement?.dinnerPerNight ?? 0) * 100);
  const lunchCents = Math.round((stay.dviMealSupplement?.lunchPerNight ?? 0) * 100);
  const breakfastCents = Math.round((stay.dviMealSupplement?.breakfastPerNight ?? 0) * 100);
  const breakfastGuests = getTboBreakfastGuestCount(stay.batches);
  const totalPayable = nightIndex === undefined ? pricing.totalPrice : pricing.payableByNight[nightIndex];
  let cumulativeFare = 0;
  let cumulativeGuests = 0;
  let cumulativeBreakfastGuests = 0;
  let previousPayableCents = 0;
  return stay.batches.map((batch, index) => {
    cumulativeFare += Math.round(batch.supplierTotalFare * 100);
    cumulativeGuests += batch.occupancies.reduce((guests, room) => guests + room.adults + room.children, 0);
    cumulativeBreakfastGuests += getTboBreakfastGuestCount([batch]);
    const roomPayable = Math.round(cumulativeFare * (100 + margin) / 100);
    const roomPayableCents = nightIndex === undefined ? roomPayable :
      Math.round(allocateFullStayCents(roomPayable / 100, stay.routeIds)[nightIndex] * 100);
    const mealsPerNight = Math.round(dinnerCents * cumulativeGuests / totalGuests) +
      Math.round(lunchCents * cumulativeGuests / totalGuests) +
      (breakfastGuests ? Math.round(breakfastCents * cumulativeBreakfastGuests / breakfastGuests) : 0);
    const payableCents = index === stay.batches.length - 1 ? Math.round(totalPayable * 100) :
      roomPayableCents + mealsPerNight * pricedNights;
    const amount = (payableCents - previousPayableCents) / 100;
    previousPayableCents = payableCents;
    return { batchIndex: batch.batchIndex, roomCount: batch.roomCount, roomType: batch.roomType, amount, currency: stay.currency };
  });
}

/**
 * Read the whole-stay fare of a cached search preview with genuine, complete
 * supplier batches. A search match must still be rechecked before selection.
 */
export function getTboBatchSearchTotal(row: any, roomCount = Number(row?.roomCount)): number | null {
  const provider = String(row?.provider || '').trim().toLowerCase();
  const hotelCode = String(row?.hotelCode || '').trim();
  const batches = row?.tboRoomBatches as TboStayBatch[] | undefined;
  if (!['tbo', 'vsr'].includes(provider) || row?.isSelectable !== false ||
      !Number.isInteger(roomCount) || roomCount < 7 || roomCount > 25 ||
      Number(row.roomCount) !== roomCount || !hotelCode || !Array.isArray(batches)) return null;
  if (batches.some((batch) => !batch || batch.hotelCode !== hotelCode ||
      !String(batch.bookingCode || '').startsWith(hotelCode + '!TB!') ||
      !Number.isFinite(batch.supplierTotalFare) || batch.supplierTotalFare <= 0)) return null;
  const error = validateTboCompleteBatchGroups(batches.map((batch) => ({
    ...batch,
    routeId: Number(row.itineraryRouteId || row.routeId || 0),
    checkInDate: row.checkInDate,
    checkOutDate: row.checkOutDate,
    numberOfRooms: batch.roomCount,
  })), roomCount);
  return error ? null : batches.reduce((cents, batch) => cents + Math.round(batch.supplierTotalFare * 100), 0) / 100;
}

export function isFreshTboMultiBatchStay(stay?: TboMultiBatchStaySnapshot, now = Date.now()): boolean {
  if (!stay) return false;
  const searchedAt = Date.parse(stay.searchVerifiedAt);
  return searchedAt <= now && now - searchedAt < TBO_SEARCH_SESSION_VALIDITY_MS;
}

/** Server-generated only, from matching supplier batches returned in one search request. */
export function makeTboMultiBatchStay(input: Omit<TboMultiBatchStaySnapshot, 'schemaVersion' | 'provider' | 'supplierNetAmount' | 'supplierTotalFare' | 'searchVerifiedAt'>,
  searchVerifiedAt: string = new Date().toISOString(),
): TboMultiBatchStaySnapshot {
  const snapshot: TboMultiBatchStaySnapshot = {
    ...input,
    schemaVersion: 1,
    provider: 'tbo',
    batches: input.batches.map((batch) => ({
      ...batch,
      occupancies: batch.occupancies.map((room) => ({
        adults: room.adults,
        children: room.children,
        childrenAges: [...(room.childrenAges || [])],
      })),
    })),
    supplierNetAmount: Math.round(input.batches.reduce((sum, batch) => sum + Math.round(batch.supplierNetAmount * 100), 0)) / 100,
    supplierTotalFare: Math.round(input.batches.reduce((sum, batch) => sum + Math.round(batch.supplierTotalFare * 100), 0)) / 100,
    searchVerifiedAt,
  };
  assertTboMultiBatchStay(snapshot);
  return snapshot;
}
