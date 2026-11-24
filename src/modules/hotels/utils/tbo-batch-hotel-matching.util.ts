
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

  results.forEach(({ batch, hotels }, resultIndex) => {
    const seen = new Set<string>();

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

      const key = JSON.stringify([
        hotelCode,
        roomType,
        mealPlan,
        currency,
        hotel.isRefundable === true,
      ]);

      if (seen.has(key)) {
        const existing = groups.get(key);
        const entry = existing?.batches.find(
          (item) => item.batch.batchIndex === batch.batchIndex,
        );
        if (entry) entry.rates.push(hotel);
        continue;
      }

      seen.add(key);

      let group = groups.get(key);

      if (!group && resultIndex === 0) {
        group = {
          hotelCode,
          roomType,
          mealPlan,
          currency,
          batches: [],
        };
        groups.set(key, group);
      }

      if (group) {
        group.batches.push({
          batch,
          rates: [hotel],
        });
      }
    }
  });

  return [...groups.values()].filter(
    (group) =>
      group.batches.length === results.length &&
      group.batches.every((item, index) =>
        item.batch.batchIndex === results[index].batch.batchIndex &&
        item.rates.length > 0,
      ),
  );
}
