import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const HOTEL_ID = Number(process.env.VERIFY_HOTEL_ID ?? '153');
const ROOM_ID = Number(process.env.VERIFY_ROOM_ID ?? '189');
const RATEPLAN_ID = String(process.env.VERIFY_RATEPLAN_ID ?? 'CP_PLAN');
const START_DATE = String(process.env.VERIFY_START_DATE ?? '2026-04-22');
const END_DATE = String(process.env.VERIFY_END_DATE ?? '2026-04-25');

function safeStringify(value: unknown) {
  return JSON.stringify(value, (_key, current) => (typeof current === 'bigint' ? Number(current) : current), 2);
}

function utcDateOnly(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function parseIsoDate(value: string): Date {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${value}`);
  return parsed;
}

function toIsoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function expandRange(startDate: Date, endDate: Date): Date[] {
  if (endDate < startDate) throw new Error('endDate must be >= startDate');
  const dates: Date[] = [];
  for (let cursor = new Date(startDate); cursor <= endDate; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    dates.push(new Date(cursor));
  }
  return dates;
}

async function main() {
  const start = parseIsoDate(START_DATE);
  const end = parseIsoDate(END_DATE);
  const days = expandRange(start, end);

  const hotel = await prisma.dvi_hotel.findFirst({
    where: { hotel_id: HOTEL_ID } as any,
    select: { hotel_id: true, axisrooms_property_id: true, axisrooms_enabled: true } as any,
  });

  if (!hotel) throw new Error(`Hotel not found: ${HOTEL_ID}`);

  const room = await prisma.dvi_hotel_rooms.findFirst({
    where: { hotel_id: HOTEL_ID, room_ID: ROOM_ID, deleted: 0, status: 1 } as any,
    select: { room_ID: true, room_title: true, room_ref_code: true, room_type_id: true } as any,
  });

  if (!room) throw new Error(`Room not found: ${ROOM_ID} for hotel ${HOTEL_ID}`);

  const roomType = Number(room.room_type_id || 0)
    ? await prisma.dvi_hotel_roomtype.findFirst({
        where: { room_type_id: Number(room.room_type_id || 0) } as any,
        select: { room_type_title: true } as any,
      })
    : null;

  const rateRows = await prisma.axisrooms_rate.findMany({
    where: {
      axisrooms_property_id: String(hotel.axisrooms_property_id || ''),
      room_id: String(room.room_ref_code || ''),
      rateplan_id: RATEPLAN_ID,
      start_date: { lte: utcDateOnly(end) } as any,
      end_date: { gte: utcDateOnly(start) } as any,
    } as any,
    orderBy: [{ start_date: 'desc' } as any, { received_at: 'desc' } as any],
  });

  const occupancyPriority = [
    'SINGLE',
    'DOUBLE',
    'TRIPLE',
    'QUAD',
    'PENTA',
    'HEXA',
    'HEPTA',
    'OCTA',
    'NONA',
    'DECA',
    'EXTRABED',
    'EXTRAADULT',
    'EXTRACHILD',
    'EXTRAADULT2',
    'EXTRACHILD2',
    'EXTRAADULT3',
    'EXTRACHILD3',
    'EXTRAINFANT',
  ];

  const seenKeys = new Set<string>(occupancyPriority);
  for (const row of rateRows) {
    const occupancy = row.occupancy_rates && typeof row.occupancy_rates === 'object'
      ? (row.occupancy_rates as Record<string, unknown>)
      : {};
    for (const key of Object.keys(occupancy)) {
      if (key !== 'CHILD_WITH_BED' && key !== 'CHILD_WITHOUT_BED') {
        seenKeys.add(key);
      }
    }
  }

  const orderedKeys = [
    ...occupancyPriority,
    ...Array.from(seenKeys).filter((key) => !occupancyPriority.includes(key)),
  ];

  const prices: Record<string, number> = {};
  const occupancies = orderedKeys.map((occupancyType) => {
    const values: Record<string, number> = {};

    for (const day of days) {
      const matching = rateRows.find((row) => row.start_date <= day && row.end_date >= day);
      const occupancy = matching?.occupancy_rates && typeof matching.occupancy_rates === 'object'
        ? (matching.occupancy_rates as Record<string, unknown>)
        : {};

      if (occupancyType === 'DOUBLE' || occupancyType === 'SINGLE') {
        const doubleValue = Number(occupancy.DOUBLE);
        const singleValue = Number(occupancy.SINGLE);
        prices[toIsoDay(day)] = Number.isFinite(doubleValue)
          ? doubleValue
          : Number.isFinite(singleValue)
          ? singleValue
          : 0;
      }

      const value = Number(occupancy[occupancyType]);
      values[toIsoDay(day)] = Number.isFinite(value) ? value : 0;
    }

    return {
      roomId: Number(room.room_ID),
      roomName: String(room.room_title || 'N/A'),
      roomType: String(roomType?.room_type_title || 'N/A'),
      rateplanId: RATEPLAN_ID,
      occupancyType,
      values,
    };
  });

  const output = {
    status: 'PASS',
    input: {
      hotelId: HOTEL_ID,
      roomId: ROOM_ID,
      rateplanId: RATEPLAN_ID,
      startDate: START_DATE,
      endDate: END_DATE,
    },
    checks: {
      hasAxisroomsRows: rateRows.length > 0,
      hasOccupancyJson: rateRows.some((row) => row.occupancy_rates && typeof row.occupancy_rates === 'object'),
      expandedDateCount: days.length,
    },
    previewRangeView: {
      dates: days.map(toIsoDay),
      rooms: [
        {
          roomId: Number(room.room_ID),
          roomName: String(room.room_title || 'N/A'),
          roomType: String(roomType?.room_type_title || 'N/A'),
          rateplanId: RATEPLAN_ID,
          prices,
        },
      ],
      occupancies,
    },
  };

  console.log(safeStringify(output));

  if (!output.checks.hasAxisroomsRows || !output.checks.hasOccupancyJson) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error('Range-view verification failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
