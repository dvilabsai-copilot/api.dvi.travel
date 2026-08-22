import { PrismaClient } from '@prisma/client';

/**
 * Copies legacy monthly Offline prices into the canonical dated occupancy-rate
 * table. This script is intentionally dry-run by default.
 *
 * Usage:
 *   npx tsx scripts/migrate-room-pricebook-to-occupancy-rates.ts
 *   npx tsx scripts/migrate-room-pricebook-to-occupancy-rates.ts --apply
 *   npx tsx scripts/migrate-room-pricebook-to-occupancy-rates.ts --apply --hotel-id 123
 */
const prisma = new PrismaClient();
const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const hotelArgIndex = process.argv.indexOf('--hotel-id');
const requestedHotelId = hotelArgIndex >= 0 ? Number(process.argv[hotelArgIndex + 1]) : 0;
const batchArgIndex = process.argv.indexOf('--batch-size');
const requestedBatchSize = Number(process.argv[batchArgIndex + 1] || 100);
const batchSize = Number.isFinite(requestedBatchSize)
  ? Math.min(500, Math.max(10, requestedBatchSize))
  : 100;

const keyByPriceType: Record<number, string> = {
  0: 'ROOM_RATE',
  1: 'EXTRABED',
  2: 'CHILD_WITH_BED',
  3: 'CHILD_WITHOUT_BED',
  4: 'CHILD_WITHOUT_BED',
};

type Candidate = {
  hotelId: number;
  roomId: number;
  rateplanId: string;
  date: Date;
  occupancyRates: Record<string, number>;
};

function dateFor(year: unknown, month: unknown, day: number): Date | null {
  const rawMonth = String(month ?? '').trim();
  const numericMonth = Number(rawMonth);
  const monthNames = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];
  const monthNumber = Number.isInteger(numericMonth) && numericMonth >= 1 && numericMonth <= 12
    ? numericMonth - 1
    : monthNames.indexOf(rawMonth.toLowerCase());
  if (monthNumber < 0 || monthNumber > 11) return null;
  const yearNumber = Number(year);
  const date = new Date(Date.UTC(yearNumber, monthNumber, day));
  return date.getUTCMonth() === monthNumber && date.getUTCFullYear() === yearNumber && date.getUTCDate() === day
    ? date
    : null;
}

function compositeKey(candidate: Pick<Candidate, 'hotelId' | 'roomId' | 'rateplanId' | 'date'>): string {
  return `${candidate.hotelId}|${candidate.roomId}|${candidate.rateplanId}|${candidate.date.toISOString().slice(0, 10)}`;
}

async function main() {
  if (args.has('--help')) {
    console.log('Dry run: npx tsx scripts/migrate-room-pricebook-to-occupancy-rates.ts');
    console.log('Apply:   npx tsx scripts/migrate-room-pricebook-to-occupancy-rates.ts --apply [--hotel-id ID] [--batch-size N]');
    return;
  }
  if (hotelArgIndex >= 0 && (!Number.isInteger(requestedHotelId) || requestedHotelId <= 0)) {
    throw new Error('--hotel-id must be a positive integer');
  }

  // AxisRooms is excluded by the database flag, not by a provider name in
  // the legacy table. This prevents copying Axis data into manual rates.
  const offlineHotels = await prisma.$queryRawUnsafe<Array<{ hotel_id: number }>>(
    `SELECT hotel_id FROM dvi_hotel
     WHERE status = 1
       AND (axisrooms_enabled IS NULL OR axisrooms_enabled <> 1)
       ${requestedHotelId > 0 ? `AND hotel_id = ${requestedHotelId}` : ''}`,
  );
  const offlineHotelIds = offlineHotels.map((hotel) => Number(hotel.hotel_id)).filter((id) => id > 0);
  if (offlineHotelIds.length === 0) throw new Error('No matching Offline hotels found');

  const legacy = await (prisma as any).dvi_hotel_room_price_book.findMany({
    where: { status: 1, deleted: 0, hotel_id: { in: offlineHotelIds } },
    select: {
      hotel_id: true, room_id: true, price_type: true, year: true, month: true,
      ...Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`day_${i + 1}`, true])),
    },
  });
  const planRows = await (prisma as any).dvi_hotel_room_rate_plan.findMany({
    where: { status: 1, deleted: 0, hotel_id: { in: offlineHotelIds } },
    select: { hotel_id: true, room_id: true, rateplan_id: true },
  });
  const legacyRoomKeys = Array.from(new Set(
    legacy.map((row: any) => `${Number(row.hotel_id)}|${Number(row.room_id)}`),
  ));
  const existingPlanKeys = new Set(
    planRows.map((plan: any) => `${Number(plan.hotel_id)}|${Number(plan.room_id)}`),
  );
  const roomsWithoutPlans = legacyRoomKeys.filter((key) => !existingPlanKeys.has(key));
  if (roomsWithoutPlans.length > 0) {
    console.log(`Rooms without configured rate plans: ${roomsWithoutPlans.length}. ${apply ? 'Creating CP_PLAN fallback rows.' : 'Dry-run only.'}`);
    if (apply) {
      const roomIds = roomsWithoutPlans.map((key) => Number(key.split('|')[1])).filter((id) => id > 0);
      const roomMetadata = await (prisma as any).dvi_hotel_rooms.findMany({
        where: { room_ID: { in: roomIds }, deleted: 0 },
        select: { hotel_id: true, room_ID: true, room_type_id: true },
      });
      for (const room of roomMetadata) {
        const key = `${Number(room.hotel_id)}|${Number(room.room_ID)}`;
        if (!roomsWithoutPlans.includes(key)) continue;
        await (prisma as any).dvi_hotel_room_rate_plan.upsert({
          where: { hotel_id_room_id_rateplan_id: { hotel_id: Number(room.hotel_id), room_id: Number(room.room_ID), rateplan_id: 'CP_PLAN' } },
          update: { status: 1, deleted: 0, rate_plan_code: 'CP', rateplan_name: 'Continental Plan', meal_plan_description: 'Breakfast only' },
          create: { hotel_id: Number(room.hotel_id), room_id: Number(room.room_ID), room_type_id: Number(room.room_type_id || 0), rate_plan_code: 'CP', rateplan_id: 'CP_PLAN', rateplan_name: 'Continental Plan', meal_plan_description: 'Breakfast only', status: 1, deleted: 0 },
        });
        planRows.push({ hotel_id: Number(room.hotel_id), room_id: Number(room.room_ID), rateplan_id: 'CP_PLAN' });
      }
    }
  }
  const plansByRoom = new Map<string, any[]>();
  for (const plan of planRows) {
    const key = `${Number(plan.hotel_id)}|${Number(plan.room_id)}`;
    plansByRoom.set(key, [...(plansByRoom.get(key) || []), plan]);
  }

  // Collapse price-type rows into one candidate per room/plan/date. This
  // preserves existing occupancy keys and makes reruns idempotent.
  const candidates = new Map<string, Candidate>();
  let skippedRows = 0;
  for (const row of legacy) {
    const occupancyType = keyByPriceType[Number(row.price_type)];
    if (!occupancyType) continue;
    const plans = plansByRoom.get(`${Number(row.hotel_id)}|${Number(row.room_id)}`) || [];
    if (!plans.length) { skippedRows++; continue; }
    for (let day = 1; day <= 31; day++) {
      const value = Number(row[`day_${day}`] || 0);
      const date = dateFor(row.year, row.month, day);
      if (!date || !Number.isFinite(value) || value <= 0) continue;
      for (const plan of plans) {
        const key = compositeKey({ hotelId: Number(row.hotel_id), roomId: Number(row.room_id), rateplanId: String(plan.rateplan_id), date });
        const current = candidates.get(key);
        candidates.set(key, {
          hotelId: Number(row.hotel_id), roomId: Number(row.room_id), rateplanId: String(plan.rateplan_id), date,
          occupancyRates: { ...(current?.occupancyRates || {}), [occupancyType]: value },
        });
      }
    }
  }

  const candidateRows = Array.from(candidates.values());
  console.log(JSON.stringify({ mode: apply ? 'APPLY' : 'DRY_RUN', offlineHotels: offlineHotelIds.length, legacyRows: legacy.length, candidates: candidateRows.length, skippedRows, batchSize }, null, 2));
  if (!apply) return;

  const existingRows = await (prisma as any).dvi_hotel_occupancy_rate.findMany({
    where: { hotel_id: { in: offlineHotelIds } },
    select: {
      hotel_id: true, room_id: true, rateplan_id: true,
      start_date: true, end_date: true, occupancy_rates: true,
    },
  });
  const existingByKey = new Map<string, any>();
  for (const row of existingRows as any[]) {
    existingByKey.set(compositeKey({
      hotelId: Number(row.hotel_id),
      roomId: Number(row.room_id),
      rateplanId: String(row.rateplan_id),
      date: new Date(row.start_date),
    }), row);
  }

  let written = 0;
  for (let offset = 0; offset < candidateRows.length; offset += batchSize) {
    const batch = candidateRows.slice(offset, offset + batchSize);
    const creates: any[] = [];
    const updates: Array<{ id: number; occupancyRates: Record<string, number> }> = [];
    for (const candidate of batch) {
      const existing = existingByKey.get(compositeKey(candidate));
      const previous = existing?.occupancy_rates && typeof existing.occupancy_rates === 'object' ? existing.occupancy_rates : {};
      // Existing canonical values win. Legacy values only fill missing keys.
      const occupancyRates = { ...candidate.occupancyRates, ...previous };
      const changed = Object.keys(candidate.occupancyRates).some((key) => previous[key] === undefined);
      if (!existing) {
        creates.push({
          hotel_id: candidate.hotelId,
          room_id: candidate.roomId,
          rateplan_id: candidate.rateplanId,
          start_date: candidate.date,
          end_date: candidate.date,
          occupancy_rates: occupancyRates,
          source: 'manual_legacy',
        });
      } else if (changed) {
        updates.push({ id: Number(existing.id), occupancyRates });
      }
    }
    if (creates.length > 0) {
      await (prisma as any).dvi_hotel_occupancy_rate.createMany({ data: creates, skipDuplicates: true });
      written += creates.length;
    }
    if (updates.length > 0) {
      await prisma.$transaction(
        updates.map((item) => (prisma as any).dvi_hotel_occupancy_rate.update({
          where: { id: item.id },
          data: { occupancy_rates: item.occupancyRates, source: 'manual_legacy', received_at: new Date() },
        })),
      );
      written += updates.length;
    }
    console.log(`Progress: ${Math.min(offset + batch.length, candidateRows.length)}/${candidateRows.length}`);
  }
  console.log(JSON.stringify({ completed: true, written }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
