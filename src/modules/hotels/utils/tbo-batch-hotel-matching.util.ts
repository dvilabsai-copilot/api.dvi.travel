
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

      const propertyKey = JSON.stringify([
        hotelCode,
        mealPlan,
        currency,
        hotel.isRefundable === true,
      ]);
      const propertyGroup = propertyGroups.get(propertyKey);
      const propertyBatch = propertyGroup?.batches.find(item => item.batch.batchIndex === batch.batchIndex);
      if (propertyBatch) {
        propertyBatch.rates.push(hotel);
      } else if (propertyGroup) {
        propertyGroup.batches.push({ batch, rates: [hotel] });
      } else if (resultIndex === 0) {
        propertyGroups.set(propertyKey, {
          hotelCode, roomType, mealPlan, currency, batches: [{ batch, rates: [hotel] }],
        });
      }

      const key = JSON.stringify([propertyKey, roomType]);
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

  const complete = (group: TboMatchingHotel) =>
    group.batches.length === results.length &&
      group.batches.every((item, index) =>
        item.batch.batchIndex === results[index].batch.batchIndex &&
        item.rates.length > 0,
      );
  const completeUniform = [...groups.entries()].filter(([, group]) => complete(group));
  const uniformPropertyKeys = new Set(completeUniform.map(([key]) => (JSON.parse(key) as [string])[0]));
  const mixed = [...propertyGroups.entries()].flatMap(([key, group]) => {
    if (!complete(group) || uniformPropertyKeys.has(key)) return [];
    // Pick one complete mixed allocation for this set of supplier terms.
    // Prefer the lowest positive fare for each batch, keeping each code unique.
    const codes = new Set<string>();
    const batches: TboMatchingHotel['batches'] = [];
    for (const entry of group.batches) {
      const rate = [...entry.rates]
        .filter(candidate => !codes.has(String(candidate.searchReference).trim()))
        .sort((left, right) => Number(left.totalFare ?? left.price) - Number(right.totalFare ?? right.price) ||
          String(left.roomType).localeCompare(String(right.roomType)))[0];
      if (!rate) return [];
      codes.add(String(rate.searchReference).trim());
      batches.push({ batch: entry.batch, rates: [rate] });
    }
    return [{
      ...group, batches,
      roomType: tboBatchRoomTypeLabel(batches.map(entry => ({ roomType: String(entry.rates[0].roomType).trim() }))),
    }];
  });
  return [...completeUniform.map(([, group]) => group), ...mixed];
}
