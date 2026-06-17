import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type Args = {
  propertyId: string;
  apply: boolean;
};

type RoomTypeMaster = {
  room_type_id: number;
  room_type_title: string | null;
  status: number | null;
  deleted: number | null;
};

type CandidateSummary = {
  roomTypeId: number;
  roomTypeTitle: string;
};

function parseArgs(argv: string[]): Args {
  const apply = argv.includes('--apply');

  const propertyFlagIndex = argv.findIndex((arg) => arg === '--property-id');
  const propertyFromFlag =
    propertyFlagIndex >= 0 ? String(argv[propertyFlagIndex + 1] || '').trim() : '';

  const positional = argv.find((arg) => !arg.startsWith('--')) || '';
  const propertyId = propertyFromFlag || String(positional || '').trim();

  if (!propertyId) {
    throw new Error(
      'Missing property id. Usage: npx tsx scripts/fix-axisrooms-roomtype-mismatches.ts AX_DVI_HOTEL_408 [--apply]',
    );
  }

  return { propertyId, apply };
}

function normalizeLabel(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeExactTrimmedLabel(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase();
}

function extractHotelIdFromPropertyId(propertyId: string): number | null {
  const match = String(propertyId || '').trim().match(/^AX_DVI_HOTEL_(\d+)$/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function safeJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, currentValue) =>
      typeof currentValue === 'bigint' ? currentValue.toString() : currentValue,
    2,
  );
}

async function resolveHotel(propertyId: string) {
  const mappedHotels = await prisma.dvi_hotel.findMany({
    where: {
      axisrooms_property_id: propertyId,
      axisrooms_enabled: 1,
      deleted: { not: true },
    },
    select: {
      hotel_id: true,
      hotel_name: true,
      axisrooms_property_id: true,
    },
    orderBy: { hotel_id: 'asc' },
  });

  if (!mappedHotels.length) {
    throw new Error(`No active AxisRooms hotel mapping found for propertyId=${propertyId}`);
  }

  const expectedHotelId = extractHotelIdFromPropertyId(propertyId);
  const selectedHotel =
    (expectedHotelId !== null
      ? mappedHotels.find((hotel) => Number(hotel.hotel_id) === expectedHotelId)
      : null) || mappedHotels[0];

  return {
    mappedHotels,
    selectedHotel,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { mappedHotels, selectedHotel } = await resolveHotel(args.propertyId);

  const hotelId = Number(selectedHotel.hotel_id);

  const [roomRows, roomTypeMasters] = await Promise.all([
    prisma.dvi_hotel_rooms.findMany({
      where: {
        hotel_id: hotelId,
        deleted: 0,
        status: 1,
      },
      select: {
        room_ID: true,
        hotel_id: true,
        room_title: true,
        room_ref_code: true,
        room_type_id: true,
        updatedon: true,
      } as any,
      orderBy: { room_ID: 'asc' } as any,
    }),
    prisma.dvi_hotel_roomtype.findMany({
      where: {
        status: 1 as any,
        deleted: 0 as any,
      },
      select: {
        room_type_id: true,
        room_type_title: true,
        status: true,
        deleted: true,
      },
      orderBy: { room_type_id: 'asc' } as any,
    }),
  ]);

  const masterById = new Map<number, RoomTypeMaster>();
  const masterByNormalizedTitle = new Map<string, RoomTypeMaster[]>();
  const masterByExactTrimmedTitle = new Map<string, RoomTypeMaster[]>();

  for (const master of roomTypeMasters as RoomTypeMaster[]) {
    const id = Number(master.room_type_id);
    masterById.set(id, master);

    const exactTrimmed = normalizeExactTrimmedLabel(master.room_type_title);
    if (exactTrimmed) {
      const exactBucket = masterByExactTrimmedTitle.get(exactTrimmed) || [];
      exactBucket.push(master);
      masterByExactTrimmedTitle.set(exactTrimmed, exactBucket);
    }

    const normalized = normalizeLabel(master.room_type_title);
    if (!normalized) continue;
    const bucket = masterByNormalizedTitle.get(normalized) || [];
    bucket.push(master);
    masterByNormalizedTitle.set(normalized, bucket);
  }

  const inspection = roomRows.map((room: any) => {
    const normalizedRoomTitle = normalizeLabel(room.room_title);
    const exactTrimmedRoomTitle = normalizeExactTrimmedLabel(room.room_title);
    const currentTypeId = Number(room.room_type_id || 0);
    const currentMaster = masterById.get(currentTypeId) || null;
    const exactCandidates = exactTrimmedRoomTitle
      ? (masterByExactTrimmedTitle.get(exactTrimmedRoomTitle) || [])
      : [];
    const normalizedCandidates = normalizedRoomTitle
      ? (masterByNormalizedTitle.get(normalizedRoomTitle) || [])
      : [];
    const candidates = exactCandidates.length ? exactCandidates : normalizedCandidates;

    let status:
      | 'already_aligned'
      | 'fixable'
      | 'missing_room_title'
      | 'no_master_match'
      | 'ambiguous_master_match' = 'no_master_match';

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
        currentTypeId === Number(targetMaster.room_type_id) ? 'already_aligned' : 'fixable';
    }

    return {
      roomId: Number(room.room_ID),
      hotelId: Number(room.hotel_id),
      roomRefCode: String(room.room_ref_code || ''),
      roomTitle: String(room.room_title || ''),
      normalizedRoomTitle,
      exactTrimmedRoomTitle,
      currentRoomTypeId: currentTypeId,
      currentRoomTypeTitle: String(currentMaster?.room_type_title || ''),
      status,
      targetRoomTypeId: targetMaster ? Number(targetMaster.room_type_id) : null,
      targetRoomTypeTitle: targetMaster ? String(targetMaster.room_type_title || '') : '',
      candidateMatches: candidates.map(
        (candidate): CandidateSummary => ({
          roomTypeId: Number(candidate.room_type_id),
          roomTypeTitle: String(candidate.room_type_title || ''),
        }),
      ),
      updatedOn: room.updatedon,
    };
  });

  const fixableRooms = inspection.filter((row) => row.status === 'fixable');
  const skippedRooms = inspection.filter((row) => row.status !== 'fixable');

  console.log('=== AxisRooms Room Type Mismatch Inspection ===');
  console.log(
    safeJson({
      propertyId: args.propertyId,
      apply: args.apply,
      selectedHotel: {
        hotelId,
        hotelName: selectedHotel.hotel_name,
        axisroomsPropertyId: selectedHotel.axisrooms_property_id,
      },
      mappedHotels: mappedHotels.map((hotel) => ({
        hotelId: Number(hotel.hotel_id),
        hotelName: hotel.hotel_name,
      })),
      summary: {
        totalRooms: inspection.length,
        fixable: fixableRooms.length,
        alreadyAligned: inspection.filter((row) => row.status === 'already_aligned').length,
        missingRoomTitle: inspection.filter((row) => row.status === 'missing_room_title').length,
        noMasterMatch: inspection.filter((row) => row.status === 'no_master_match').length,
        ambiguousMasterMatch: inspection.filter((row) => row.status === 'ambiguous_master_match')
          .length,
      },
      fixableRooms,
      skippedRooms,
    }),
  );

  if (!args.apply) {
    console.log('\nDry run only. Re-run with --apply to persist fixable rows.');
    return;
  }

  if (!fixableRooms.length) {
    console.log('\nNo fixable rows found. Nothing to update.');
    return;
  }

  const appliedAt = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const updatedRooms: Array<{
      roomId: number;
      roomRefCode: string;
      roomTitle: string;
      fromRoomTypeId: number;
      toRoomTypeId: number;
      updatedRoomRatePlans: number;
    }> = [];

    for (const row of fixableRooms) {
      await tx.dvi_hotel_rooms.update({
        where: { room_ID: row.roomId } as any,
        data: {
          room_type_id: row.targetRoomTypeId!,
          updatedon: appliedAt,
        } as any,
      });

      const ratePlanUpdate = await tx.dvi_hotel_room_rate_plan.updateMany({
        where: {
          hotel_id: hotelId,
          room_id: row.roomId,
          deleted: 0,
        } as any,
        data: {
          room_type_id: row.targetRoomTypeId!,
          updatedon: appliedAt,
        } as any,
      });

      updatedRooms.push({
        roomId: row.roomId,
        roomRefCode: row.roomRefCode,
        roomTitle: row.roomTitle,
        fromRoomTypeId: row.currentRoomTypeId,
        toRoomTypeId: row.targetRoomTypeId!,
        updatedRoomRatePlans: Number(ratePlanUpdate.count || 0),
      });
    }

    return updatedRooms;
  });

  console.log('\n=== Applied Fixes ===');
  console.log(
    safeJson({
      propertyId: args.propertyId,
      hotelId,
      updatedRooms: result,
    }),
  );
}

main()
  .catch((error) => {
    console.error('Failed to inspect/fix AxisRooms room type mismatches:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
