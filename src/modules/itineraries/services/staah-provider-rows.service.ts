import { Injectable } from '@nestjs/common';

export interface StaahProviderRowQueries {
  loadInventory: (propertyIds: string[], checkInDate: Date) => Promise<any[]>;
  loadRatePlans: (propertyIds: string[]) => Promise<any[]>;
  loadRates: (input: {
    propertyIds: string[];
    roomIds: string[];
    ratePlanIds: string[];
    checkInDate: Date;
  }) => Promise<any[]>;
  loadRestrictions: (input: {
    propertyIds: string[];
    roomIds: string[];
    ratePlanIds: string[];
    checkInDate: Date;
    checkOutDate: Date;
  }) => Promise<any[]>;
}

export interface StaahProviderRowsResult {
  inventoryRows: any[];
  ratePlanRows: any[];
  rateRows: any[];
  restrictionRowsByRateKey: Map<string, any[]>;
  roomIds: string[];
  ratePlanIds: string[];
}

/** Loads and room-filters the STAAH inventory, rates and restrictions used by selection. */
@Injectable()
export class StaahProviderRowsService {
  async load(input: {
    propertyIds: string[];
    checkInDate: Date;
    checkOutDate: Date;
    isAllowedRoom: (propertyId: unknown, roomId: unknown) => boolean;
    queries: StaahProviderRowQueries;
  }): Promise<StaahProviderRowsResult> {
    const { propertyIds, checkInDate, checkOutDate, isAllowedRoom, queries } = input;
    const [inventoryRowsRaw, ratePlanRowsRaw] = await Promise.all([
      queries.loadInventory(propertyIds, checkInDate),
      queries.loadRatePlans(propertyIds),
    ]);
    const inventoryRows = inventoryRowsRaw.filter((row) =>
      isAllowedRoom(row.staah_property_id, row.room_id),
    );
    const ratePlanRows = ratePlanRowsRaw.filter((row) =>
      isAllowedRoom(row.staah_property_id, row.room_id),
    );
    const roomIds = Array.from(
      new Set(inventoryRows.map((row) => String(row.room_id || '').trim()).filter(Boolean)),
    );
    const ratePlanIds = Array.from(
      new Set(ratePlanRows.map((row) => String(row.rateplan_id || '').trim()).filter(Boolean)),
    );
    if (!roomIds.length || !ratePlanIds.length) {
      return {
        inventoryRows,
        ratePlanRows,
        rateRows: [],
        restrictionRowsByRateKey: new Map(),
        roomIds,
        ratePlanIds,
      };
    }

    const [rateRowsRaw, restrictionRows] = await Promise.all([
      queries.loadRates({ propertyIds, roomIds, ratePlanIds, checkInDate }),
      queries.loadRestrictions({
        propertyIds,
        roomIds,
        ratePlanIds,
        checkInDate,
        checkOutDate,
      }),
    ]);
    const rateRows = rateRowsRaw.filter((row) =>
      isAllowedRoom(row.staah_property_id, row.room_id),
    );
    const restrictionRowsByRateKey = new Map<string, any[]>();
    for (const row of restrictionRows) {
      const rateKey = `${row.staah_property_id}|${row.room_id}|${row.rateplan_id}`;
      const existing = restrictionRowsByRateKey.get(rateKey);
      if (existing) {
        existing.push(row);
      } else {
        restrictionRowsByRateKey.set(rateKey, [row]);
      }
    }

    return {
      inventoryRows,
      ratePlanRows,
      rateRows,
      restrictionRowsByRateKey,
      roomIds,
      ratePlanIds,
    };
  }
}
