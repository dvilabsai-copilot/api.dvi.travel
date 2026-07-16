import { Injectable } from '@nestjs/common';
import { HotelSearchResult } from '../../hotels/interfaces/hotel-provider.interface';

export interface StaahCandidateResultCallbacks {
  isAllowedRoom: (propertyId: string, roomId: string) => boolean;
  normalizeExactRoom: (value: unknown) => string;
  normalizeLooseRoom: (value: unknown) => string;
  buildAvailabilityMessage: (reason: string | null, availableAgainFrom: string | null) => string;
  warn?: (message: string) => void;
}

/** Projects selected STAAH rate candidates into bookable or restricted hotel results. */
@Injectable()
export class StaahCandidateResultService {
  build(input: {
    candidate: { rate: any; rp: any; price: number; reason?: string; availableAgainFrom?: string | null };
    isBookable: boolean;
    routeId: number;
    propertyId: string;
    hotel: any;
    destination: string;
    dateStamp: string;
    hotelIdByPropertyId: Map<string, number>;
    roomTitleByHotelAndCode: Map<string, string>;
    pushedKeys: Set<string>;
    callbacks: StaahCandidateResultCallbacks;
  }): HotelSearchResult | null {
    const { candidate, isBookable, propertyId, hotel, callbacks } = input;
    const roomId = String(candidate.rate.room_id || '');
    const rateplanId = String(candidate.rate.rateplan_id || '');
    const resultKey = `${roomId}|${rateplanId}|${isBookable ? 'bookable' : 'restricted'}`;
    if (input.pushedKeys.has(resultKey)) return null;
    if (!callbacks.isAllowedRoom(propertyId, roomId)) {
      callbacks.warn?.(`[STAAH STALE ROOM SKIPPED IN RESULT PUSH] routeId=${input.routeId} propertyId=${propertyId} roomId=${roomId}`);
      return null;
    }
    input.pushedKeys.add(resultKey);

    const cancellation = String(hotel.hotel_cancel_policy || '').trim();
    const mealPlan = String(candidate.rp?.meal_plan_description || candidate.rp?.rateplan_name || '-').trim() || '-';
    const currency = String(candidate.rp?.currency || 'INR').trim() || 'INR';
    const exactRoomCode = callbacks.normalizeExactRoom(roomId);
    const looseRoomCode = callbacks.normalizeLooseRoom(roomId);
    const hotelId = input.hotelIdByPropertyId.get(propertyId) || Number(hotel.hotel_id || 0);
    const roomName =
      input.roomTitleByHotelAndCode.get(`${hotelId}|${exactRoomCode}`) ||
      input.roomTitleByHotelAndCode.get(`${hotelId}|${looseRoomCode}`) ||
      `Room ${roomId}`;
    const availableAgainFrom = candidate.availableAgainFrom ?? null;

    return {
      provider: 'staah',
      hotelCode: String(hotel.hotel_id),
      hotelName: String(hotel.hotel_name || ''),
      cityCode: String(hotel.hotel_city || input.destination),
      address: String(hotel.hotel_address || ''),
      rating: Number(hotel.hotel_category || 0),
      facilities: [],
      amenities: [],
      inclusions: [],
      rateConditions: [],
      cancellationPolicy: cancellation ? [cancellation] : [],
      images: [],
      price: Number(candidate.price || 0),
      currency,
      roomTypes: [{ roomCode: roomId, roomName, bedType: '', capacity: 0, price: Number(candidate.price || 0), cancellationPolicy: cancellation }],
      roomType: roomName,
      mealPlan,
      hotel_margin: Number(hotel.hotel_margin || 0),
      hotel_margin_gst_type: Number(hotel.hotel_margin_gst_type || 0),
      hotel_margin_gst_percentage: Number(hotel.hotel_margin_gst_percentage || 0),
      searchReference: `STAAH-${propertyId}-${roomId}-${rateplanId}-${input.dateStamp}`,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      isMappedAdminRoom: true,
      providerRoomId: roomId,
      isBookable,
      externalStay: false,
      availabilityStatus: isBookable ? 'AVAILABLE' : 'NOT_BOOKABLE',
      availabilityMessage: isBookable ? '' : callbacks.buildAvailabilityMessage(candidate.reason || null, availableAgainFrom),
      availableAgainFrom,
    } as any;
  }
}
