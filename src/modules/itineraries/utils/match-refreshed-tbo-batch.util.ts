import { inferCanonicalHotelRatePlanCode, inferCanonicalHotelRatePlanCodeFromMealText } from '../../hotels/hotel-rate-plans';
import type { HotelSearchResult } from '../../hotels/interfaces/hotel-provider.interface';
import type { TboMultiBatchStaySnapshot, TboStayBatch } from '../../hotels/utils/tbo-multi-batch-stay.util';
import { normalizeHotelDisplayName } from './hotel-selection-identity.util';

export function matchRefreshedTboBatchCode(
  offers: HotelSearchResult[], stay: TboMultiBatchStaySnapshot, previous: TboStayBatch,
): string | undefined {
  const room = (value: string) => normalizeHotelDisplayName(value).toLowerCase();
  const meal = (value: string) => inferCanonicalHotelRatePlanCode(value) || inferCanonicalHotelRatePlanCodeFromMealText(value);
  const codes = new Set<string>();
  for (const offer of offers) {
    const batches = (offer as HotelSearchResult & { tboRoomBatches?: TboStayBatch[] }).tboRoomBatches;
    if (!Array.isArray(batches)) continue;
    for (const batch of batches) {
      if (batch.batchIndex !== previous.batchIndex || batch.startRoomIndex !== previous.startRoomIndex ||
        batch.roomCount !== previous.roomCount || batch.hotelCode !== stay.hotelCode ||
        room(batch.roomType) !== room(previous.roomType) || meal(batch.mealPlan) !== meal(previous.mealPlan) ||
        batch.currency !== stay.currency || batch.isRefundable !== stay.isRefundable || !batch.bookingCode.includes('!TB!') ||
        batch.occupancies.length !== previous.occupancies.length) continue;
      if (batch.occupancies.every((occupancy, index) => {
        const saved = previous.occupancies[index];
        return occupancy.adults === saved.adults && occupancy.children === saved.children &&
          (occupancy.childrenAges ?? []).join(',') === (saved.childrenAges ?? []).join(',');
      })) codes.add(batch.bookingCode);
    }
  }
  return codes.size === 1 ? [...codes][0] : undefined;
}
