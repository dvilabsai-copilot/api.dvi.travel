import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type Args = {
  apply: boolean;
  hotelId: number | null;
  propertyId: string | null;
};

type MappingRow = {
  sourceRoomId: string;
  targetRoomId: string;
  reason: string;
};

function parseArgs(argv: string[]): Args {
  const apply = argv.includes('--apply');

  const readValue = (flag: string): string => {
    const idx = argv.findIndex((arg) => arg === flag);
    return idx >= 0 ? String(argv[idx + 1] || '').trim() : '';
  };

  const hotelIdRaw = readValue('--hotel-id');
  const propertyIdRaw = readValue('--property-id');

  const hotelId = hotelIdRaw ? Number(hotelIdRaw) : null;
  if (hotelIdRaw && (!Number.isFinite(hotelId) || (hotelId as number) <= 0)) {
    throw new Error(`Invalid --hotel-id value: ${hotelIdRaw}`);
  }

  return {
    apply,
    hotelId,
    propertyId: propertyIdRaw || null,
  };
}

function normalizeExact(value: unknown): string {
  return String(value || '').trim().toUpperCase();
}

function normalizeLoose(value: unknown): string {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function isSourceNewer(
  source: { id: number; created_at?: Date | null; received_at?: Date | null },
  target: { id: number; created_at?: Date | null; received_at?: Date | null },
  field: 'created_at' | 'received_at',
): boolean {
  const sourceTime = source[field] instanceof Date ? source[field]!.getTime() : 0;
  const targetTime = target[field] instanceof Date ? target[field]!.getTime() : 0;
  if (sourceTime !== targetTime) {
    return sourceTime > targetTime;
  }
  return Number(source.id || 0) > Number(target.id || 0);
}

async function processRateplans(propertyId: string, mapping: MappingRow, apply: boolean) {
  const rows = await prisma.staah_rateplan.findMany({
    where: {
      staah_property_id: propertyId,
      room_id: mapping.sourceRoomId,
    },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
  });

  let updated = 0;
  let deleted = 0;
  let merged = 0;

  for (const row of rows) {
    const target = await prisma.staah_rateplan.findFirst({
      where: {
        staah_property_id: propertyId,
        room_id: mapping.targetRoomId,
        rateplan_id: row.rateplan_id,
      },
    });

    if (!target) {
      updated += 1;
      if (apply) {
        await prisma.staah_rateplan.update({
          where: { id: row.id },
          data: { room_id: mapping.targetRoomId },
        });
      }
      continue;
    }

    merged += 1;
    deleted += 1;
    if (!apply) {
      continue;
    }

    if (isSourceNewer(row, target, 'created_at')) {
      await prisma.staah_rateplan.update({
        where: { id: target.id },
        data: {
          rateplan_name: row.rateplan_name,
          occupancy: row.occupancy as any,
          commission_perc: row.commission_perc,
          tax_perc: row.tax_perc,
          currency: row.currency,
          created_at: row.created_at,
        },
      });
    }

    await prisma.staah_rateplan.delete({ where: { id: row.id } });
  }

  return { updated, deleted, merged };
}

async function processInventory(propertyId: string, mapping: MappingRow, apply: boolean) {
  const rows = await prisma.staah_inventory.findMany({
    where: {
      staah_property_id: propertyId,
      room_id: mapping.sourceRoomId,
    },
    orderBy: [{ received_at: 'desc' }, { id: 'desc' }],
  });

  let updated = 0;
  let deleted = 0;
  let merged = 0;

  for (const row of rows) {
    const target = await prisma.staah_inventory.findFirst({
      where: {
        staah_property_id: propertyId,
        room_id: mapping.targetRoomId,
        start_date: row.start_date,
        end_date: row.end_date,
      },
    });

    if (!target) {
      updated += 1;
      if (apply) {
        await prisma.staah_inventory.update({
          where: { id: row.id },
          data: { room_id: mapping.targetRoomId },
        });
      }
      continue;
    }

    merged += 1;
    deleted += 1;
    if (!apply) {
      continue;
    }

    if (isSourceNewer(row, target, 'received_at')) {
      await prisma.staah_inventory.update({
        where: { id: target.id },
        data: {
          free: row.free,
          received_at: row.received_at,
        },
      });
    }

    await prisma.staah_inventory.delete({ where: { id: row.id } });
  }

  return { updated, deleted, merged };
}

async function processRates(propertyId: string, mapping: MappingRow, apply: boolean) {
  const rows = await prisma.staah_rate.findMany({
    where: {
      staah_property_id: propertyId,
      room_id: mapping.sourceRoomId,
    },
    orderBy: [{ received_at: 'desc' }, { id: 'desc' }],
  });

  let updated = 0;
  let deleted = 0;
  let merged = 0;

  for (const row of rows) {
    const target = await prisma.staah_rate.findFirst({
      where: {
        staah_property_id: propertyId,
        room_id: mapping.targetRoomId,
        rateplan_id: row.rateplan_id,
        start_date: row.start_date,
        end_date: row.end_date,
      },
    });

    if (!target) {
      updated += 1;
      if (apply) {
        await prisma.staah_rate.update({
          where: { id: row.id },
          data: { room_id: mapping.targetRoomId },
        });
      }
      continue;
    }

    merged += 1;
    deleted += 1;
    if (!apply) {
      continue;
    }

    if (isSourceNewer(row, target, 'received_at')) {
      await prisma.staah_rate.update({
        where: { id: target.id },
        data: {
          occupancy_rates: row.occupancy_rates as any,
          received_at: row.received_at,
        },
      });
    }

    await prisma.staah_rate.delete({ where: { id: row.id } });
  }

  return { updated, deleted, merged };
}

async function processRestrictions(propertyId: string, mapping: MappingRow, apply: boolean) {
  const rows = await prisma.staah_restriction.findMany({
    where: {
      staah_property_id: propertyId,
      room_id: mapping.sourceRoomId,
    },
  });

  if (apply && rows.length > 0) {
    await prisma.staah_restriction.updateMany({
      where: {
        staah_property_id: propertyId,
        room_id: mapping.sourceRoomId,
      },
      data: {
        room_id: mapping.targetRoomId,
      },
    });
  }

  return { updated: rows.length, deleted: 0, merged: 0 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const hotel = await prisma.dvi_hotel.findFirst({
    where: args.hotelId
      ? { hotel_id: args.hotelId, deleted: { not: true } }
      : args.propertyId
        ? { staah_property_id: args.propertyId, deleted: { not: true } }
        : undefined,
    select: {
      hotel_id: true,
      hotel_name: true,
      staah_property_id: true,
      staah_enabled: true,
    },
  });

  if (!hotel) {
    throw new Error('Target STAAH hotel not found. Pass --hotel-id or --property-id.');
  }

  const propertyId = String(hotel.staah_property_id || '').trim();
  const hotelId = Number(hotel.hotel_id || 0);
  if (!propertyId || !hotelId) {
    throw new Error('Target hotel is missing staah_property_id or hotel_id.');
  }

  const activeRooms = await prisma.dvi_hotel_rooms.findMany({
    where: {
      hotel_id: hotelId,
      status: 1,
      deleted: 0,
      room_ref_code: { not: null },
    } as any,
    select: {
      room_ref_code: true,
      room_title: true,
    },
    orderBy: { room_ID: 'asc' } as any,
  });

  const exactCodes = new Set<string>();
  const looseToExactCodes = new Map<string, Set<string>>();
  for (const room of activeRooms as any[]) {
    const exact = normalizeExact(room.room_ref_code);
    const loose = normalizeLoose(room.room_ref_code);
    if (!exact) continue;
    exactCodes.add(exact);
    if (!looseToExactCodes.has(loose)) {
      looseToExactCodes.set(loose, new Set<string>());
    }
    looseToExactCodes.get(loose)!.add(exact);
  }

  const [rateplanRoomIds, inventoryRoomIds, rateRoomIds, restrictionRoomIds] = await Promise.all([
    prisma.staah_rateplan.findMany({
      where: { staah_property_id: propertyId },
      select: { room_id: true },
      distinct: ['room_id'],
    }),
    prisma.staah_inventory.findMany({
      where: { staah_property_id: propertyId },
      select: { room_id: true },
      distinct: ['room_id'],
    }),
    prisma.staah_rate.findMany({
      where: { staah_property_id: propertyId },
      select: { room_id: true },
      distinct: ['room_id'],
    }),
    prisma.staah_restriction.findMany({
      where: { staah_property_id: propertyId },
      select: { room_id: true },
      distinct: ['room_id'],
    }),
  ]);

  const sourceRoomIds = Array.from(
    new Set(
      [
        ...rateplanRoomIds,
        ...inventoryRoomIds,
        ...rateRoomIds,
        ...restrictionRoomIds,
      ].map((row: any) => String(row.room_id || '').trim()).filter(Boolean),
    ),
  ).sort();

  const mappings: MappingRow[] = [];
  const skipped: Array<{ roomId: string; reason: string }> = [];

  for (const sourceRoomId of sourceRoomIds) {
    const exact = normalizeExact(sourceRoomId);
    if (exactCodes.has(exact)) {
      continue;
    }

    const loose = normalizeLoose(sourceRoomId);
    const matches = looseToExactCodes.get(loose);
    if (!matches || matches.size !== 1) {
      skipped.push({
        roomId: sourceRoomId,
        reason: matches && matches.size > 1 ? 'ambiguous_loose_match' : 'no_match',
      });
      continue;
    }

    const [targetRoomId] = Array.from(matches);
    if (!targetRoomId || targetRoomId === exact) {
      continue;
    }

    mappings.push({
      sourceRoomId,
      targetRoomId,
      reason: 'unique_loose_match_to_active_admin_room',
    });
  }

  console.log(`\n[STAAH ROOM BACKFILL] hotelId=${hotelId} hotelName="${hotel.hotel_name}" propertyId=${propertyId}`);
  console.log(`Mode: ${args.apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Active admin room_ref_code values: ${Array.from(exactCodes).join(', ') || '(none)'}`);
  console.log(`Source STAAH room ids: ${sourceRoomIds.join(', ') || '(none)'}`);

  if (mappings.length === 0) {
    console.log('No canonical room-id mappings found.');
  } else {
    console.log('\nMappings to apply:');
    for (const mapping of mappings) {
      console.log(`- ${mapping.sourceRoomId} -> ${mapping.targetRoomId} (${mapping.reason})`);
    }
  }

  if (skipped.length > 0) {
    console.log('\nSkipped room ids:');
    for (const item of skipped) {
      console.log(`- ${item.roomId}: ${item.reason}`);
    }
  }

  const summary = {
    staah_rateplan: { updated: 0, deleted: 0, merged: 0 },
    staah_inventory: { updated: 0, deleted: 0, merged: 0 },
    staah_rate: { updated: 0, deleted: 0, merged: 0 },
    staah_restriction: { updated: 0, deleted: 0, merged: 0 },
  };

  for (const mapping of mappings) {
    const rateplanSummary = await processRateplans(propertyId, mapping, args.apply);
    const inventorySummary = await processInventory(propertyId, mapping, args.apply);
    const rateSummary = await processRates(propertyId, mapping, args.apply);
    const restrictionSummary = await processRestrictions(propertyId, mapping, args.apply);

    summary.staah_rateplan.updated += rateplanSummary.updated;
    summary.staah_rateplan.deleted += rateplanSummary.deleted;
    summary.staah_rateplan.merged += rateplanSummary.merged;

    summary.staah_inventory.updated += inventorySummary.updated;
    summary.staah_inventory.deleted += inventorySummary.deleted;
    summary.staah_inventory.merged += inventorySummary.merged;

    summary.staah_rate.updated += rateSummary.updated;
    summary.staah_rate.deleted += rateSummary.deleted;
    summary.staah_rate.merged += rateSummary.merged;

    summary.staah_restriction.updated += restrictionSummary.updated;
    summary.staah_restriction.deleted += restrictionSummary.deleted;
    summary.staah_restriction.merged += restrictionSummary.merged;
  }

  console.log('\nSummary:');
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    console.error('[STAAH ROOM BACKFILL] Failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
