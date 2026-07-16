import { Injectable } from '@nestjs/common';
import { StaahRoomMappings } from './staah-room-mapping.service';

/** Applies exact STAAH room admission and emits one diagnostic per stale room key. */
@Injectable()
export class StaahRoomAdmissionService {
  create(input: {
    routeId: number;
    mappings: Pick<
      StaahRoomMappings,
      'allowedRoomCodesByPropertyId' | 'allowedLooseRoomCodesByPropertyId' | 'allowedLooseExactCodesByPropertyId'
    >;
    normalizeExact: (value: unknown) => string;
    normalizeLoose: (value: unknown) => string;
    warn: (message: string) => void;
  }): (propertyIdValue: unknown, roomIdValue: unknown) => boolean {
    const { routeId, mappings, normalizeExact, normalizeLoose, warn } = input;
    const loggedSkippedRooms = new Set<string>();
    return (propertyIdValue, roomIdValue) => {
      const propertyId = String(propertyIdValue || '').trim();
      const roomIdExact = normalizeExact(roomIdValue);
      const roomIdLoose = normalizeLoose(roomIdValue);
      const logKey = `${propertyId}|${roomIdExact}`;
      const exactCodes = mappings.allowedRoomCodesByPropertyId.get(propertyId);
      const looseCodes = mappings.allowedLooseRoomCodesByPropertyId.get(propertyId);
      const looseExactCodes = mappings.allowedLooseExactCodesByPropertyId.get(propertyId);
      const warnOnce = (message: string) => {
        if (loggedSkippedRooms.has(logKey)) return;
        loggedSkippedRooms.add(logKey);
        warn(message);
      };

      if (!exactCodes || exactCodes.size === 0) {
        warnOnce(
          `[STAAH STALE ROOM SKIPPED] routeId=${routeId} propertyId=${propertyId} providerRoomId=${roomIdExact}. No active dvi_hotel_rooms.room_ref_code mapping found for hotel/property.`,
        );
        return false;
      }
      if (exactCodes.has(roomIdExact)) return true;

      const looseMatches = looseExactCodes?.get(roomIdLoose);
      if (looseCodes?.has(roomIdLoose) && looseMatches && looseMatches.size === 1) {
        warnOnce(
          `[STAAH STALE ROOM SKIPPED] routeId=${routeId} propertyId=${propertyId} providerRoomId=${roomIdExact}. Only normalized match found (${Array.from(looseMatches).join(', ')}); exact active room_ref_code required.`,
        );
        return false;
      }

      warnOnce(
        `[STAAH STALE ROOM SKIPPED] routeId=${routeId} propertyId=${propertyId} providerRoomId=${roomIdExact}. Not found in active dvi_hotel_rooms.room_ref_code.`,
      );
      return false;
    };
  }
}
