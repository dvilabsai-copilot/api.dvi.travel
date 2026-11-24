
import type { HotelSearchResult } from '../interfaces/hotel-provider.interface';
import type { TboRoomBatch } from './tbo-occupancy.util';

export type TboBatchSearchResult = {
  batch: TboRoomBatch;
  hotels: HotelSearchResult[];
};

export type TboMatchingHotel = {
  hotelCode: string;
  roomType: string;
  mealPlan: string;
  currency: string;
  batches: Array<{
    batch: TboRoomBatch;
    rates: HotelSearchResult[];
  }>;
};

export function tboBatchRoomTypeLabel(batches: readonly { roomType: string }[]): string {
  return [...new Set(batches.map(batch => batch.roomType))].join(' + ');
}

export function tboBatchMealPlan(batches: readonly { mealPlan: string }[]): string | undefined {
  const plans = new Set(batches.map(batch => batch.mealPlan));
  if (plans.size === 1) return batches[0]?.mealPlan;
  // EP and CP can be sold together when DVI adds breakfast to the EP rooms.
  if (plans.size === 2 && plans.has('EP') && plans.has('CP')) return 'EP';
}

/**
 * Find hotel/room/meal combinations returned in every TBO batch.
 *
 * This is only search-result matching. It does not calculate a
 * combined price or assert that all rooms can be booked.
 */
export function matchTboBatchHotels(
  results: readonly TboBatchSearchResult[],
): TboMatchingHotel[] {
  if (results.length === 0) return [];

  const groups = new Map<string, TboMatchingHotel>();
  const propertyGroups = new Map<string, TboMatchingHotel>();
  const breakfastGroups = new Map<string, TboMatchingHotel>();

  results.forEach(({ batch, hotels }, resultIndex) => {
    for (const hotel of hotels) {
      const hotelCode = String(hotel.hotelCode || '').trim();
      const roomType = String(hotel.roomType || '').trim();
      const mealPlan = String(hotel.mealPlan || '').trim();
      const currency = String(hotel.currency || '').trim();
      const bookingCode = String(hotel.searchReference || '').trim();

      if (
        !hotelCode ||
        !roomType ||
        !currency ||
        !bookingCode.includes('!TB!') ||
        !Number.isFinite(Number(hotel.price)) ||
        Number(hotel.price) <= 0 ||
        hotel.isLiveBookable !== true
      ) {
        continue;
      }

      const propertyKey = JSON.stringify([
        hotelCode,
        mealPlan,
        currency,
        hotel.isRefundable === true,
      ]);
      const addRate = (target: Map<string, TboMatchingHotel>, key: string) => {
        const group = target.get(key);
        if (!group) {
          if (resultIndex === 0) target.set(key, { hotelCode, roomType, mealPlan, currency, batches: [{ batch, rates: [hotel] }] });
          return;
        }
        const last = group.batches[group.batches.length - 1];
        if (last?.batch.batchIndex === batch.batchIndex) last.rates.push(hotel);
        else group.batches.push({ batch, rates: [hotel] });
      };
      addRate(groups, JSON.stringify([propertyKey, roomType]));
      addRate(propertyGroups, propertyKey);
      if (currency === 'INR' && (mealPlan === 'EP' || mealPlan === 'CP')) {
        addRate(breakfastGroups, JSON.stringify([hotelCode, currency, hotel.isRefundable === true]));
      }
    }
  });

  const complete = (group: TboMatchingHotel) =>
    group.batches.length === results.length &&
      group.batches.every((item, index) =>
        item.batch.batchIndex === results[index].batch.batchIndex &&
        item.rates.length > 0,
      );
  const completeUniform = [...groups.entries()].filter(([, group]) => complete(group));
  const uniformPropertyKeys = new Set(completeUniform.map(([key]) => (JSON.parse(key) as [string])[0]));
  const selectAllocation = (group: TboMatchingHotel, preferIncludedBreakfast: boolean): TboMatchingHotel[] => {
    if (!complete(group)) return [];
    // Pick one complete mixed allocation for this set of supplier terms.
    // Prefer the lowest positive fare for each batch, keeping each code unique.
    const codes = new Set<string>();
    const batches: TboMatchingHotel['batches'] = [];
    for (const entry of group.batches) {
      const rate = [...entry.rates]
        .filter(candidate => !codes.has(String(candidate.searchReference).trim()))
        .sort((left, right) =>
          (preferIncludedBreakfast ? Number(right.mealPlan === 'CP') - Number(left.mealPlan === 'CP') : 0) ||
          Number(left.totalFare ?? left.price) - Number(right.totalFare ?? right.price) ||
          String(left.roomType).localeCompare(String(right.roomType)))[0];
      if (!rate) return [];
      codes.add(String(rate.searchReference).trim());
      batches.push({ batch: entry.batch, rates: [rate] });
    }
    const supplierMeals = batches.map(({ rates }) => ({ mealPlan: String(rates[0].mealPlan || '').trim() }));
    if (preferIncludedBreakfast && new Set(supplierMeals.map(rate => rate.mealPlan)).size !== 2) return [];
    return [{
      ...group, batches,
      mealPlan: tboBatchMealPlan(supplierMeals) || group.mealPlan,
      roomType: tboBatchRoomTypeLabel(batches.map(entry => ({ roomType: String(entry.rates[0].roomType).trim() }))),
    }];
  };
  const mixed = [...propertyGroups.entries()].flatMap(([key, group]) =>
    uniformPropertyKeys.has(key) ? [] : selectAllocation(group, false),
  );
  const withBreakfastSupplement = [...breakfastGroups.values()].flatMap(group => selectAllocation(group, true));
  return [...completeUniform.map(([, group]) => group), ...mixed, ...withBreakfastSupplement];
}
