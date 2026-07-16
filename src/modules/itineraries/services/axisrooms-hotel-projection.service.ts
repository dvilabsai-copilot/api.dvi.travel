import { Injectable } from '@nestjs/common';
import { HotelSearchResult } from '../../hotels/interfaces/hotel-provider.interface';
import { HOTEL_RATE_PLAN_BY_CODE } from '../../hotels/hotel-rate-plans';

export interface AxisroomsProjectionCallbacks {
  extractRate: (occupancyRates: unknown) => number;
  warn?: (message: string) => void;
}

/** Selects an AxisRooms rate plan and projects the loaded local rows into a hotel result. */
@Injectable()
export class AxisroomsHotelProjectionService {
  build(input: {
    hotel: any;
    availableRoomIds: Set<number>;
    occupancyRows: any[];
    amenities: string[];
    ratePlanMetaByHotelRoom: Map<string, { rateConditions: string[]; inclusions: string[] }>;
    mealPlanByRatePlan: Map<string, string>;
    roomTitleMap: Map<number, string>;
    preferredMealPlanCode?: string | null;
    dateStamp: string;
    destination: string;
    callbacks: AxisroomsProjectionCallbacks;
  }): HotelSearchResult | null {
    const { hotel, availableRoomIds, occupancyRows, callbacks } = input;
    const hotelId = Number(hotel.hotel_id);
    const ratesByPlan = new Map<string, { rate: number; roomId: number }>();

    for (const occupancy of occupancyRows) {
      if (Number(occupancy.hotel_id) !== hotelId) continue;
      const roomId = Number(occupancy.room_id);
      if (!availableRoomIds.has(roomId)) continue;
      const ratePlanId = String(occupancy.rateplan_id || '').trim();
      if (!ratePlanId || ratesByPlan.has(ratePlanId)) continue;
      const rate = callbacks.extractRate(occupancy.occupancy_rates);
      if (rate > 0) ratesByPlan.set(ratePlanId, { rate, roomId });
    }

    if (ratesByPlan.size === 0) {
      callbacks.warn?.(`AxisRooms hotel ${hotelId} has no valid rates for the available rooms`);
      return null;
    }

    const preferredCode = String(input.preferredMealPlanCode || '').trim().toUpperCase();
    const preferredDefinition = preferredCode ? HOTEL_RATE_PLAN_BY_CODE.get(preferredCode as any) : undefined;
    const preferredCandidates = [
      String(preferredDefinition?.defaultRateplanId || '').trim(),
      String(preferredDefinition?.externalRateplanId || '').trim(),
    ].filter(Boolean);

    let selectedRatePlanId = '';
    let selectedRate = Number.POSITIVE_INFINITY;
    let selectedRoomId = 0;
    for (const candidate of preferredCandidates) {
      const hit = ratesByPlan.get(candidate);
      if (hit) {
        selectedRatePlanId = candidate;
        selectedRate = hit.rate;
        selectedRoomId = hit.roomId;
        break;
      }
    }
    if (!selectedRatePlanId) {
      for (const [ratePlanId, hit] of ratesByPlan) {
        if (Number.isFinite(hit.rate) && hit.rate > 0 && hit.rate < selectedRate) {
          selectedRatePlanId = ratePlanId;
          selectedRate = hit.rate;
          selectedRoomId = hit.roomId;
        }
      }
    }
    if (!selectedRatePlanId || !Number.isFinite(selectedRate) || selectedRate <= 0 || !selectedRoomId) return null;

    const roomName = input.roomTitleMap.get(selectedRoomId) || 'Room';
    const rateMeta = input.ratePlanMetaByHotelRoom.get(`${hotelId}|${selectedRoomId}`) || { rateConditions: [], inclusions: [] };
    const cancelPolicy = String(hotel.hotel_cancel_policy || '').trim();
    return {
      provider: 'axisrooms',
      hotelCode: String(hotelId),
      hotelName: String(hotel.hotel_name || `Hotel ${hotelId}`),
      cityCode: String(hotel.hotel_city || input.destination),
      address: String(hotel.hotel_address || ''),
      rating: Number(hotel.hotel_category || 0),
      facilities: Array.from(new Set(input.amenities)),
      amenities: Array.from(new Set(input.amenities)),
      inclusions: Array.from(new Set(rateMeta.inclusions)),
      rateConditions: Array.from(new Set(rateMeta.rateConditions)),
      cancellationPolicy: cancelPolicy ? [cancelPolicy] : [],
      images: [],
      price: Number(selectedRate),
      currency: 'INR',
      roomTypes: [{ roomCode: String(selectedRoomId), roomName, bedType: '', capacity: 0, price: Number(selectedRate), cancellationPolicy: cancelPolicy }],
      roomType: roomName,
      mealPlan: input.mealPlanByRatePlan.get(selectedRatePlanId) || '-',
      searchReference: `AX-${hotelId}-${input.dateStamp}`,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    } as any;
  }
}
