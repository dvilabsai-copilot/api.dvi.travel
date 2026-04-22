import { PrismaClient } from '@prisma/client';
import { inferCanonicalHotelRatePlanCode } from '../src/modules/hotels/hotel-rate-plans';

const prisma = new PrismaClient();

function readArg(name: string): string | undefined {
  const idx = process.argv.findIndex((item) => item === `--${name}`);
  if (idx === -1) return undefined;
  const next = process.argv[idx + 1];
  if (!next || next.startsWith('--')) return undefined;
  return next;
}

async function main() {
  const hotelIdRaw = readArg('hotelId');
  const roomRef = readArg('roomRef');

  if (!hotelIdRaw) {
    throw new Error('Missing --hotelId. Example: tsx scripts/cleanup-noncanonical-room-rateplans.ts --hotelId 153 --roomRef DVIRHON666981');
  }

  const hotelId = Number(hotelIdRaw);
  if (!Number.isFinite(hotelId) || hotelId <= 0) {
    throw new Error(`Invalid --hotelId value: ${hotelIdRaw}`);
  }

  const hotel = await prisma.dvi_hotel.findFirst({
    where: { hotel_id: hotelId },
    select: { hotel_id: true, axisrooms_property_id: true },
  });

  if (!hotel) {
    throw new Error(`Hotel not found for hotel_id=${hotelId}`);
  }

  const rooms = await prisma.dvi_hotel_rooms.findMany({
    where: {
      hotel_id: hotelId,
      deleted: 0,
      ...(roomRef ? { room_ref_code: roomRef } : {}),
    } as any,
    select: {
      room_ID: true,
      room_ref_code: true,
      room_title: true,
    },
  });

  if (!rooms.length) {
    throw new Error(`No room found for hotel_id=${hotelId}${roomRef ? ` room_ref_code=${roomRef}` : ''}`);
  }

  const summary: Array<Record<string, unknown>> = [];

  for (const room of rooms) {
    const roomId = Number((room as any).room_ID);
    const roomRefCode = String((room as any).room_ref_code || '');

    const plans = await prisma.dvi_hotel_room_rate_plan.findMany({
      where: {
        hotel_id: hotelId,
        room_id: roomId,
        deleted: 0,
      } as any,
      select: {
        rateplan_id: true,
        rateplan_name: true,
        rate_plan_code: true,
      } as any,
    });

    const toDelete = plans.filter((plan: any) => {
      const inferred = inferCanonicalHotelRatePlanCode(
        plan.rate_plan_code || plan.rateplan_id || plan.rateplan_name,
      );
      return !inferred;
    });

    const toDeleteRateplanIds = toDelete
      .map((plan: any) => String(plan.rateplan_id || '').trim())
      .filter((value: string) => !!value);

    if (!toDeleteRateplanIds.length) {
      summary.push({
        hotelId,
        roomId,
        roomRefCode,
        deletedRateplanIds: [],
        deletedRatePlans: 0,
        deletedOccupancyRates: 0,
        deletedAxisroomsRestrictions: 0,
      });
      continue;
    }

    const result = await prisma.$transaction(async (tx) => {
      const deletedOccupancyRates = await tx.dvi_hotel_occupancy_rate.deleteMany({
        where: {
          hotel_id: hotelId,
          room_id: roomId,
          rateplan_id: { in: toDeleteRateplanIds },
        },
      });

      const deletedRatePlans = await tx.dvi_hotel_room_rate_plan.deleteMany({
        where: {
          hotel_id: hotelId,
          room_id: roomId,
          rateplan_id: { in: toDeleteRateplanIds },
        } as any,
      });

      const deletedAxisroomsRestrictions =
        roomRefCode && hotel.axisrooms_property_id
          ? await tx.axisrooms_restriction.deleteMany({
              where: {
                axisrooms_property_id: String(hotel.axisrooms_property_id),
                room_id: roomRefCode,
                rateplan_id: { in: toDeleteRateplanIds },
              },
            })
          : { count: 0 };

      return {
        deletedOccupancyRates: deletedOccupancyRates.count,
        deletedRatePlans: deletedRatePlans.count,
        deletedAxisroomsRestrictions: deletedAxisroomsRestrictions.count,
      };
    });

    summary.push({
      hotelId,
      roomId,
      roomRefCode,
      deletedRateplanIds: toDeleteRateplanIds,
      deletedRatePlans: result.deletedRatePlans,
      deletedOccupancyRates: result.deletedOccupancyRates,
      deletedAxisroomsRestrictions: result.deletedAxisroomsRestrictions,
    });
  }

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        scope: {
          hotelId,
          roomRef: roomRef || null,
        },
        summary,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error('cleanup-noncanonical-room-rateplans failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
