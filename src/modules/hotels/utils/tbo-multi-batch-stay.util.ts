import { validateTboCompleteBatchGroups } from './tbo-complete-batch-validation.util';
import { TBO_SEARCH_SESSION_VALIDITY_MS } from './tbo-search-session';

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
  mealPlan: 'CP' | 'MAP';
  breakfastRate: number;
  breakfastPerNight: number;
  dinnerRate: number;
  dinnerPerNight: number;
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
    batch.roomType !== stay.roomType ||
    batch.mealPlan !== stay.mealPlan ||
    batch.currency !== stay.currency ||
    batch.isRefundable !== stay.isRefundable ||
    !Number.isFinite(batch.supplierNetAmount) || batch.supplierNetAmount <= 0 ||
    !Number.isFinite(batch.supplierTotalFare) || batch.supplierTotalFare <= 0)) {
    throw new Error('TBO batches must have one hotel, compatible rates and genuine positive supplier amounts.');
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
  if (meals && (stay.currency !== 'INR' ||
      !((stay.mealPlan === 'EP' && ['CP', 'MAP'].includes(meals.mealPlan)) ||
        (stay.mealPlan === 'CP' && meals.mealPlan === 'MAP')) ||
      [meals.breakfastRate, meals.breakfastPerNight, meals.dinnerRate, meals.dinnerPerNight]
        .some(amount => !Number.isFinite(amount) || amount < 0))) {
    throw new Error('Invalid DVI meal supplement for the supplier stay.');
  }
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
