import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type Args = {
  apply: boolean;
  propertyId: string | null;
  hotelId: number | null;
  limit: number | null;
};

type RoomTypeMaster = {
  room_type_id: number;
  room_type_title: string | null;
};

type InspectionRow = {
  propertyId: string;
  hotelId: number;
  hotelName: string;
  roomId: number;
  roomRefCode: string;
  roomTitle: string;
  exactTrimmedRoomTitle: string;
  currentRoomTypeId: number;
  currentRoomTypeTitle: string;
  status:
    | 'already_aligned'
    | 'fixable'
    | 'missing_room_title'
    | 'no_master_match'
    | 'ambiguous_master_match';
  targetRoomTypeId: number | null;
  targetRoomTypeTitle: string;
  candidateMatches: Array<{ roomTypeId: number; roomTypeTitle: string }>;
};

function parseArgs(argv: string[]): Args {
  const apply = argv.includes('--apply');

  const readValue = (flag: string): string => {
    const idx = argv.findIndex((arg) => arg === flag);
    return idx >= 0 ? String(argv[idx + 1] || '').trim() : '';
  };

  const propertyIdRaw = readValue('--property-id');
  const hotelIdRaw = readValue('--hotel-id');
  const limitRaw = readValue('--limit');

  const hotelId = hotelIdRaw ? Number(hotelIdRaw) : null;
  const limit = limitRaw ? Number(limitRaw) : null;

  if (hotelIdRaw && (!Number.isFinite(hotelId) || (hotelId as number) <= 0)) {
    throw new Error(`Invalid --hotel-id value: ${hotelIdRaw}`);
  }

  if (limitRaw && (!Number.isFinite(limit) || (limit as number) <= 0)) {
    throw new Error(`Invalid --limit value: ${limitRaw}`);
  }

  return {
    apply,
    propertyId: propertyIdRaw || null,
    hotelId,
    limit,
  };
}

function normalizeLabel(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeExactTrimmedLabel(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase();
}

function safeJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, currentValue) =>
      typeof currentValue === 'bigint' ? currentValue.toString() : currentValue,
    2,
  );
}

async function loadMasterMaps() {
  const roomTypeMasters = await prisma.dvi_hotel_roomtype.findMany({
    where: {
      status: 1 as any,
      deleted: 0 as any,
    },
    select: {
      room_type_id: true,
      room_type_title: true,
    } as any,
    orderBy: { room_type_id: 'asc' } as any,
  });

  const masterById = new Map<number, RoomTypeMaster>();
  const masterByExactTrimmedTitle = new Map<string, RoomTypeMaster[]>();
  const masterByNormalizedTitle = new Map<string, RoomTypeMaster[]>();

  for (const master of roomTypeMasters as RoomTypeMaster[]) {
    const id = Number(master.room_type_id);
    masterById.set(id, master);

    const exact = normalizeExactTrimmedLabel(master.room_type_title);
    if (exact) {
      const bucket = masterByExactTrimmedTitle.get(exact) || [];
      bucket.push(master);
      masterByExactTrimmedTitle.set(exact, bucket);
    }

    const normalized = normalizeLabel(master.room_type_title);
    if (normalized) {
      const bucket = masterByNormalizedTitle.get(normalized) || [];
      bucket.push(master);
      masterByNormalizedTitle.set(normalized, bucket);
    }
  }

  return {
    masterById,
    masterByExactTrimmedTitle,
    masterByNormalizedTitle,
  };
}

function inspectRoom(
  room: any,
  hotel: any,
  masterMaps: Awaited<ReturnType<typeof loadMasterMaps>>,
): InspectionRow {
  const roomTitle = String(room.room_title || '');
  const exactTrimmedRoomTitle = normalizeExactTrimmedLabel(roomTitle);
  const normalizedRoomTitle = normalizeLabel(roomTitle);
  const currentRoomTypeId = Number(room.room_type_id || 0);
  const currentMaster = masterMaps.masterById.get(currentRoomTypeId) || null;
  const exactCandidates = exactTrimmedRoomTitle
    ? masterMaps.masterByExactTrimmedTitle.get(exactTrimmedRoomTitle) || []
    : [];
  const normalizedCandidates = normalizedRoomTitle
    ? masterMaps.masterByNormalizedTitle.get(normalizedRoomTitle) || []
    : [];
  const candidates = exactCandidates.length ? exactCandidates : normalizedCandidates;

  let status: InspectionRow['status'] = 'no_master_match';
  let targetMaster: RoomTypeMaster | null = null;

  if (!normalizedRoomTitle) {
    status = 'missing_room_title';
  } else if (!candidates.length) {
    status = 'no_master_match';
  } else if (candidates.length > 1) {
    status = 'ambiguous_master_match';
  } else {
    targetMaster = candidates[0];
    status =
      currentRoomTypeId === Number(targetMaster.room_type_id) ? 'already_aligned' : 'fixable';
  }

  return {
    propertyId: String(hotel.axisrooms_property_id || ''),
    hotelId: Number(hotel.hotel_id),
    hotelName: String(hotel.hotel_name || ''),
    roomId: Number(room.room_ID),
    roomRefCode: String(room.room_ref_code || ''),
    roomTitle,
    exactTrimmedRoomTitle,
    currentRoomTypeId,
    currentRoomTypeTitle: String(currentMaster?.room_type_title || ''),
    status,
    targetRoomTypeId: targetMaster ? Number(targetMaster.room_type_id) : null,
    targetRoomTypeTitle: targetMaster ? String(targetMaster.room_type_title || '') : '',
    candidateMatches: candidates.map((candidate) => ({
      roomTypeId: Number(candidate.room_type_id),
      roomTypeTitle: String(candidate.room_type_title || ''),
    })),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const masterMaps = await loadMasterMaps();

  const hotelWhere: any = {
    axisrooms_enabled: 1,
    deleted: { not: true },
    axisrooms_property_id: { not: null },
  };
  if (args.propertyId) hotelWhere.axisrooms_property_id = args.propertyId;
  if (args.hotelId) hotelWhere.hotel_id = args.hotelId;

  const hotels = await prisma.dvi_hotel.findMany({
    where: hotelWhere,
    select: {
      hotel_id: true,
      hotel_name: true,
      axisrooms_property_id: true,
    },
    orderBy: { hotel_id: 'asc' },
    ...(args.limit ? { take: args.limit } : {}),
  });

  if (!hotels.length) {
    throw new Error('No AxisRooms-enabled hotels found for the given filters.');
  }

  const hotelIds = hotels.map((hotel) => Number(hotel.hotel_id));
  const rooms = await prisma.dvi_hotel_rooms.findMany({
    where: {
      hotel_id: { in: hotelIds } as any,
      deleted: 0,
      status: 1,
    },
    select: {
      room_ID: true,
      hotel_id: true,
      room_title: true,
      room_ref_code: true,
      room_type_id: true,
    } as any,
    orderBy: [{ hotel_id: 'asc' } as any, { room_ID: 'asc' } as any],
  });

  const hotelById = new Map(hotels.map((hotel) => [Number(hotel.hotel_id), hotel]));
  const inspection = rooms
    .map((room) => {
      const hotel = hotelById.get(Number((room as any).hotel_id));
      return hotel ? inspectRoom(room, hotel, masterMaps) : null;
    })
    .filter(Boolean) as InspectionRow[];

  const fixableRows = inspection.filter((row) => row.status === 'fixable');
  const missingRows = inspection.filter((row) => row.status === 'no_master_match' && row.exactTrimmedRoomTitle);
  const ambiguousRows = inspection.filter((row) => row.status === 'ambiguous_master_match');
  const missingTitleRows = inspection.filter((row) => row.status === 'missing_room_title');

  const creationPlan = Array.from(
    missingRows.reduce((acc, row) => {
      if (!acc.has(row.exactTrimmedRoomTitle)) {
        acc.set(row.exactTrimmedRoomTitle, {
          normalizedKey: row.exactTrimmedRoomTitle,
          roomTypeTitle: row.roomTitle,
          affectedRooms: [] as Array<{
            propertyId: string;
            hotelId: number;
            hotelName: string;
            roomId: number;
            roomRefCode: string;
          }>,
        });
      }
      acc.get(row.exactTrimmedRoomTitle)!.affectedRooms.push({
        propertyId: row.propertyId,
        hotelId: row.hotelId,
        hotelName: row.hotelName,
        roomId: row.roomId,
        roomRefCode: row.roomRefCode,
      });
      return acc;
    }, new Map<string, { normalizedKey: string; roomTypeTitle: string; affectedRooms: Array<{ propertyId: string; hotelId: number; hotelName: string; roomId: number; roomRefCode: string }> }>())
      .values(),
  );

  const perHotelSummary = Array.from(
    inspection.reduce((acc, row) => {
      const key = `${row.hotelId}`;
      if (!acc.has(key)) {
        acc.set(key, {
          propertyId: row.propertyId,
          hotelId: row.hotelId,
          hotelName: row.hotelName,
          totalRooms: 0,
          alreadyAligned: 0,
          fixable: 0,
          noMasterMatch: 0,
          ambiguous: 0,
          missingRoomTitle: 0,
        });
      }
      const bucket = acc.get(key)!;
      bucket.totalRooms += 1;
      if (row.status === 'already_aligned') bucket.alreadyAligned += 1;
      if (row.status === 'fixable') bucket.fixable += 1;
      if (row.status === 'no_master_match') bucket.noMasterMatch += 1;
      if (row.status === 'ambiguous_master_match') bucket.ambiguous += 1;
      if (row.status === 'missing_room_title') bucket.missingRoomTitle += 1;
      return acc;
    }, new Map<string, any>())
      .values(),
  );

  console.log('=== AxisRooms Room Type Master Backfill Scan ===');
  console.log(
    safeJson({
      filters: {
        propertyId: args.propertyId,
        hotelId: args.hotelId,
        limit: args.limit,
        apply: args.apply,
      },
      summary: {
        hotelsScanned: hotels.length,
        roomsScanned: inspection.length,
        alreadyAligned: inspection.filter((row) => row.status === 'already_aligned').length,
        fixable: fixableRows.length,
        missingMastersCreatable: creationPlan.length,
        ambiguous: ambiguousRows.length,
        missingRoomTitle: missingTitleRows.length,
      },
      perHotelSummary,
      fixableRows,
      creationPlan,
      ambiguousRows,
      missingTitleRows,
    }),
  );

  if (!args.apply) {
    console.log(
      '\nDry run only. Re-run with --apply to create missing masters and update matching room rows.',
    );
    return;
  }

  if (!fixableRows.length && !creationPlan.length) {
    console.log('\nNothing to update.');
    return;
  }

  const appliedAt = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const createdRoomTypes: Array<{
      roomTypeId: number;
      roomTypeTitle: string;
      affectedRooms: number;
    }> = [];
    const createdRoomTypeIdByKey = new Map<string, number>();

    for (const pending of creationPlan) {
      const created = await tx.dvi_hotel_roomtype.create({
        data: {
          room_type_title: pending.roomTypeTitle,
          createdby: 1,
          createdon: appliedAt,
          updatedon: appliedAt,
          status: 1,
          deleted: 0,
        } as any,
        select: {
          room_type_id: true,
          room_type_title: true,
        } as any,
      });

      const roomTypeId = Number((created as any).room_type_id);
      createdRoomTypeIdByKey.set(pending.normalizedKey, roomTypeId);
      createdRoomTypes.push({
        roomTypeId,
        roomTypeTitle: String((created as any).room_type_title || pending.roomTypeTitle),
        affectedRooms: pending.affectedRooms.length,
      });
    }

    const rowsToUpdate = [
      ...fixableRows,
      ...missingRows.map((row) => ({
        ...row,
        targetRoomTypeId: createdRoomTypeIdByKey.get(row.exactTrimmedRoomTitle) || null,
        targetRoomTypeTitle: row.roomTitle,
      })),
    ].filter((row) => Number.isFinite(Number(row.targetRoomTypeId)) && Number(row.targetRoomTypeId) > 0);

    const updatedRooms: Array<{
      propertyId: string;
      hotelId: number;
      roomId: number;
      roomRefCode: string;
      roomTitle: string;
      fromRoomTypeId: number;
      toRoomTypeId: number;
      updatedRoomRatePlans: number;
    }> = [];

    for (const row of rowsToUpdate) {
      await tx.dvi_hotel_rooms.update({
        where: { room_ID: row.roomId } as any,
        data: {
          room_type_id: row.targetRoomTypeId!,
          updatedon: appliedAt,
        } as any,
      });

      const ratePlanUpdate = await tx.dvi_hotel_room_rate_plan.updateMany({
        where: {
          hotel_id: row.hotelId,
          room_id: row.roomId,
          deleted: 0,
        } as any,
        data: {
          room_type_id: row.targetRoomTypeId!,
          updatedon: appliedAt,
        } as any,
      });

      updatedRooms.push({
        propertyId: row.propertyId,
        hotelId: row.hotelId,
        roomId: row.roomId,
        roomRefCode: row.roomRefCode,
        roomTitle: row.roomTitle,
        fromRoomTypeId: row.currentRoomTypeId,
        toRoomTypeId: row.targetRoomTypeId!,
        updatedRoomRatePlans: Number(ratePlanUpdate.count || 0),
      });
    }

    return {
      createdRoomTypes,
      updatedRooms,
    };
  });

  console.log('\n=== Applied Backfill ===');
  console.log(safeJson(result));
}

main()
  .catch((error) => {
    console.error('Failed to backfill AxisRooms room type masters:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
