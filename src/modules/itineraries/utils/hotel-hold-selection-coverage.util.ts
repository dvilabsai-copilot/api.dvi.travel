import type { TboMultiBatchStaySnapshot } from '../../hotels/utils/tbo-multi-batch-stay.util';

type SelectedHotel = { itinerary_plan_hotel_details_ID: number; selected_price_snapshot?: unknown };
type Hold = {
  selection_ids?: unknown;
  request_payload?: unknown;
  hotel_code?: unknown;
  room_count?: unknown;
  room_type?: unknown;
  meal_plan?: unknown;
};
type SplitHoldBatch = { key: string; index: number; count: number };

function parse(value: unknown): any {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function selectionIds(value: unknown): number[] {
  const ids = parse(value);
  return Array.isArray(ids) ? ids.map(Number).filter(id => Number.isInteger(id) && id > 0) : [];
}

export const splitHoldBatch = (hold: Hold): SplitHoldBatch | undefined => parse(hold.request_payload)?.supplierHold?.batch;

export function booksSameBatch(request: Hold, stay: TboMultiBatchStaySnapshot): boolean {
  const hold = parse(request.request_payload)?.supplierHold;
  const batch = stay.batches.find(item => item.batchIndex === hold?.batch?.index);
  return Boolean(batch && hold.batch.count === stay.batches.length && Number(hold.bookingId) > 0 &&
    hold.bookingCode === batch.bookingCode && Number(request.room_count) === batch.roomCount &&
    request.hotel_code === batch.hotelCode && request.room_type === batch.roomType && request.meal_plan === batch.mealPlan);
}

export function getHotelHoldSelectionCoverage<T extends Hold>(selectedRows: SelectedHotel[], requests: T[]) {
  const expectedIds = selectedRows.map(row => Number(row.itinerary_plan_hotel_details_ID)).filter(id => id > 0).sort((a, b) => a - b);
  const savedStays = new Map<number, TboMultiBatchStaySnapshot>();
  for (const row of selectedRows) {
    const stay = parse(row.selected_price_snapshot)?.tboMultiBatchStay;
    if (stay) savedStays.set(Number(row.itinerary_plan_hotel_details_ID), stay);
  }
  const splitRequests = new Map<string, T[]>();
  const coveredIds: number[] = [];
  const invalidRequests: T[] = [];
  for (const request of requests) {
    const batch = splitHoldBatch(request);
    if (batch) {
      const siblings = splitRequests.get(batch.key) || [];
      siblings.push(request);
      splitRequests.set(batch.key, siblings);
      continue;
    }
    const ids = selectionIds(request.selection_ids);
    if (ids.some(id => savedStays.has(id))) invalidRequests.push(request);
    coveredIds.push(...ids);
  }
  for (const siblings of splitRequests.values()) {
    const first = siblings[0];
    const ids = selectionIds(first.selection_ids);
    const stay = savedStays.get(ids[0]);
    const bookingIds = new Set(siblings.map(row => Number(parse(row.request_payload)?.supplierHold?.bookingId)));
    if (!stay?.batches?.length || ids.some(id => JSON.stringify(savedStays.get(id)) !== JSON.stringify(stay)) ||
        siblings.length !== stay.batches.length || new Set(siblings.map(row => splitHoldBatch(row)?.index)).size !== siblings.length ||
        bookingIds.size !== siblings.length ||
        !siblings.every(row => row.selection_ids === first.selection_ids && booksSameBatch(row, stay))) {
      invalidRequests.push(...siblings);
      continue;
    }
    coveredIds.push(...ids);
  }
  coveredIds.sort((a, b) => a - b);
  return { expectedIds, invalidRequests, matches: expectedIds.length === coveredIds.length && expectedIds.every((id, index) => id === coveredIds[index]) };
}
