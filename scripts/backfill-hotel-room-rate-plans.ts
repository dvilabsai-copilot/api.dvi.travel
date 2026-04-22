import { PrismaClient } from '@prisma/client';
import {
  CANONICAL_HOTEL_RATE_PLANS,
  getCanonicalHotelRatePlanDefinition,
  inferCanonicalHotelRatePlanCode,
} from '../src/modules/hotels/hotel-rate-plans';

const prisma = new PrismaClient();

async function main() {
  for (const plan of CANONICAL_HOTEL_RATE_PLANS) {
    await prisma.dvi_hotel_rate_plan_master.upsert({
      where: { rate_plan_code: plan.code },
      update: {
        default_rateplan_id: plan.defaultRateplanId,
        rate_plan_name: plan.name,
        description: plan.description,
        includes_breakfast: plan.includesBreakfast,
        includes_lunch: plan.includesLunch,
        includes_dinner: plan.includesDinner,
        sort_order: plan.sortOrder,
        status: 1,
        deleted: 0,
        updatedon: new Date(),
      },
      create: {
        rate_plan_code: plan.code,
        default_rateplan_id: plan.defaultRateplanId,
        rate_plan_name: plan.name,
        description: plan.description,
        includes_breakfast: plan.includesBreakfast,
        includes_lunch: plan.includesLunch,
        includes_dinner: plan.includesDinner,
        sort_order: plan.sortOrder,
        status: 1,
        deleted: 0,
        createdon: new Date(),
        updatedon: new Date(),
      },
    });
  }

  const hotels = await prisma.dvi_hotel.findMany({
    where: {
      axisrooms_enabled: 1,
      deleted: false,
      axisrooms_property_id: { not: null },
    },
    select: {
      hotel_id: true,
      axisrooms_property_id: true,
    },
  });

  const hotelByProperty = new Map(
    hotels.map((hotel) => [String(hotel.axisrooms_property_id || ''), Number(hotel.hotel_id)]),
  );

  const roomRows = await prisma.dvi_hotel_rooms.findMany({
    where: {
      deleted: 0,
      status: 1,
      room_ref_code: { not: null },
    },
    select: {
      room_ID: true,
      hotel_id: true,
      room_type_id: true,
      room_ref_code: true,
    },
  });

  const roomByHotelAndRef = new Map(
    roomRows.map((room) => [
      `${Number(room.hotel_id)}:${String(room.room_ref_code || '')}`,
      {
        roomId: Number(room.room_ID),
        roomTypeId: Number(room.room_type_id || 0),
        axisroomsRoomId: String(room.room_ref_code || ''),
      },
    ]),
  );

  const rateplans = await prisma.axisrooms_rateplan.findMany({
    orderBy: [{ axisrooms_property_id: 'asc' }, { room_id: 'asc' }, { rateplan_id: 'asc' }],
  });

  let synced = 0;
  let skipped = 0;

  for (const rateplan of rateplans) {
    const hotelId = hotelByProperty.get(String(rateplan.axisrooms_property_id || ''));
    if (!hotelId) {
      skipped++;
      continue;
    }

    const roomKey = `${hotelId}:${String(rateplan.room_id || '')}`;
    const room = roomByHotelAndRef.get(roomKey);
    if (!room) {
      skipped++;
      continue;
    }

    const canonical = getCanonicalHotelRatePlanDefinition(rateplan.rateplan_id || rateplan.rateplan_name);
    const ratePlanCode = canonical?.code || inferCanonicalHotelRatePlanCode(rateplan.rateplan_id || rateplan.rateplan_name);

    await prisma.dvi_hotel_room_rate_plan.upsert({
      where: {
        hotel_id_room_id_rateplan_id: {
          hotel_id: hotelId,
          room_id: room.roomId,
          rateplan_id: rateplan.rateplan_id,
        },
      },
      update: {
        room_type_id: room.roomTypeId,
        axisrooms_room_id: room.axisroomsRoomId,
        rate_plan_code: ratePlanCode,
        rateplan_name: rateplan.rateplan_name,
        meal_plan_description: canonical?.description || rateplan.rateplan_name,
        commission_perc: rateplan.commission_perc,
        tax_perc: rateplan.tax_perc,
        currency: rateplan.currency,
        status: 1,
        deleted: 0,
        updatedon: new Date(),
      },
      create: {
        hotel_id: hotelId,
        room_id: room.roomId,
        room_type_id: room.roomTypeId,
        axisrooms_room_id: room.axisroomsRoomId,
        rate_plan_code: ratePlanCode,
        rateplan_id: rateplan.rateplan_id,
        rateplan_name: rateplan.rateplan_name,
        meal_plan_description: canonical?.description || rateplan.rateplan_name,
        commission_perc: rateplan.commission_perc,
        tax_perc: rateplan.tax_perc,
        currency: rateplan.currency,
        status: 1,
        deleted: 0,
        createdon: new Date(),
        updatedon: new Date(),
      },
    });

    synced++;
  }

  console.log(JSON.stringify({ status: 'ok', synced, skipped }, null, 2));
}

main()
  .catch((error) => {
    console.error('Failed to backfill hotel room rate plans:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });