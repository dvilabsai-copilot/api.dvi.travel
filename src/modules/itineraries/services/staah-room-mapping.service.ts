import { Injectable } from '@nestjs/common';

export interface StaahRoomMappings {
  activeRoomCodesByHotelId: Map<number, Set<string>>;
  activeRoomLooseCodesByHotelId: Map<number, Set<string>>;
  activeRoomLooseExactCodesByHotelId: Map<number, Map<string, Set<string>>>;
  roomTitleByHotelAndCode: Map<string, string>;
  allowedRoomCodesByPropertyId: Map<string, Set<string>>;
  allowedLooseRoomCodesByPropertyId: Map<string, Set<string>>;
  allowedLooseExactCodesByPropertyId: Map<string, Map<string, Set<string>>>;
  hotelIdByPropertyId: Map<string, number>;
}

/** Builds the exact and normalized STAAH room-code maps used to reject stale inventory. */
@Injectable()
export class StaahRoomMappingService {
  build(
    activeAdminRooms: any[],
    cityHotels: any[],
    normalizeExact: (value: unknown) => string,
    normalizeLoose: (value: unknown) => string,
  ): StaahRoomMappings {
    const activeRoomCodesByHotelId = new Map<number, Set<string>>();
    const activeRoomLooseCodesByHotelId = new Map<number, Set<string>>();
    const activeRoomLooseExactCodesByHotelId = new Map<number, Map<string, Set<string>>>();
    const roomTitleByHotelAndCode = new Map<string, string>();

    for (const room of activeAdminRooms || []) {
      const hotelId = Number(room.hotel_id || 0);
      const exactCode = normalizeExact(room.room_ref_code);
      const looseCode = normalizeLoose(room.room_ref_code);
      const roomTitle = String(room.room_title || '').trim();
      if (!hotelId || !exactCode) continue;

      if (!activeRoomCodesByHotelId.has(hotelId)) activeRoomCodesByHotelId.set(hotelId, new Set());
      if (!activeRoomLooseCodesByHotelId.has(hotelId)) activeRoomLooseCodesByHotelId.set(hotelId, new Set());
      if (!activeRoomLooseExactCodesByHotelId.has(hotelId)) {
        activeRoomLooseExactCodesByHotelId.set(hotelId, new Map());
      }
      activeRoomCodesByHotelId.get(hotelId)!.add(exactCode);
      activeRoomLooseCodesByHotelId.get(hotelId)!.add(looseCode);
      const looseMap = activeRoomLooseExactCodesByHotelId.get(hotelId)!;
      if (!looseMap.has(looseCode)) looseMap.set(looseCode, new Set());
      looseMap.get(looseCode)!.add(exactCode);
      roomTitleByHotelAndCode.set(`${hotelId}|${exactCode}`, roomTitle);
      roomTitleByHotelAndCode.set(`${hotelId}|${looseCode}`, roomTitle);
    }

    const allowedRoomCodesByPropertyId = new Map<string, Set<string>>();
    const allowedLooseRoomCodesByPropertyId = new Map<string, Set<string>>();
    const allowedLooseExactCodesByPropertyId = new Map<string, Map<string, Set<string>>>();
    const hotelIdByPropertyId = new Map<string, number>();
    for (const hotel of cityHotels || []) {
      const propertyId = String(hotel.staah_property_id || '').trim();
      const hotelId = Number(hotel.hotel_id || 0);
      if (!propertyId || !hotelId) continue;
      hotelIdByPropertyId.set(propertyId, hotelId);
      allowedRoomCodesByPropertyId.set(propertyId, activeRoomCodesByHotelId.get(hotelId) || new Set());
      allowedLooseRoomCodesByPropertyId.set(propertyId, activeRoomLooseCodesByHotelId.get(hotelId) || new Set());
      allowedLooseExactCodesByPropertyId.set(
        propertyId,
        activeRoomLooseExactCodesByHotelId.get(hotelId) || new Map(),
      );
    }

    return {
      activeRoomCodesByHotelId,
      activeRoomLooseCodesByHotelId,
      activeRoomLooseExactCodesByHotelId,
      roomTitleByHotelAndCode,
      allowedRoomCodesByPropertyId,
      allowedLooseRoomCodesByPropertyId,
      allowedLooseExactCodesByPropertyId,
      hotelIdByPropertyId,
    };
  }
}
