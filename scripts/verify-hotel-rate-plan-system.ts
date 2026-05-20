import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const HOTEL_ID = Number(process.env.VERIFY_HOTEL_ID ?? '153');
const ROOM_ID = Number(process.env.VERIFY_ROOM_ID ?? '189');
const ROOM_REF_CODE = process.env.VERIFY_ROOM_REF_CODE ?? 'DVIRHON666981';
const PROPERTY_ID = process.env.VERIFY_PROPERTY_ID ?? 'AX_DVI_HOTEL_153';
const RATEPLAN_ID = process.env.VERIFY_RATEPLAN_ID ?? 'CP_PLAN';
const EXPECTED_CODES = ['CP', 'EP', 'MAP', 'AP'];
const VERIFY_DATE = process.env.VERIFY_DATE ?? new Date().toISOString().slice(0, 10);

function safeStringify(value: unknown) {
  return JSON.stringify(value, (_key, current) => (typeof current === 'bigint' ? Number(current) : current), 2);
}

async function main() {
  const masterRows = await prisma.dvi_hotel_rate_plan_master.findMany({
    where: { deleted: 0, status: 1 },
    orderBy: { sort_order: 'asc' },
  });

  const roomPlans = await prisma.dvi_hotel_room_rate_plan.findMany({
    where: { hotel_id: HOTEL_ID, room_id: ROOM_ID, deleted: 0, status: 1 },
    orderBy: { rateplan_id: 'asc' },
  });

  const axisroomsPlan = await prisma.axisrooms_rateplan.findFirst({
    where: {
      axisrooms_property_id: PROPERTY_ID,
      room_id: ROOM_REF_CODE,
      rateplan_id: RATEPLAN_ID,
    },
  });

  const axisroomsRates = await prisma.axisrooms_rate.findMany({
    where: {
      axisrooms_property_id: PROPERTY_ID,
      room_id: ROOM_REF_CODE,
      rateplan_id: RATEPLAN_ID,
    },
    orderBy: [{ start_date: 'asc' }, { end_date: 'asc' }],
  });

  const verifyDate = new Date(`${VERIFY_DATE}T00:00:00.000Z`);
  const currentRate = await prisma.axisrooms_rate.findFirst({
    where: {
      axisrooms_property_id: PROPERTY_ID,
      room_id: ROOM_REF_CODE,
      rateplan_id: RATEPLAN_ID,
      start_date: { lte: verifyDate },
      end_date: { gte: verifyDate },
    },
    orderBy: [{ start_date: 'desc' }, { received_at: 'desc' }],
  });

  const canonicalPass = EXPECTED_CODES.every((code) => masterRows.some((row) => row.rate_plan_code === code));
  const roomPlanPass = roomPlans.some((row) => row.rateplan_id === RATEPLAN_ID);
  const axisroomsPlanPass = !!axisroomsPlan;
  const axisroomsRatesPass = axisroomsRates.length > 0;
  const currentDayPass = !!currentRate && typeof currentRate.occupancy_rates === 'object';

  const result = {
    status: canonicalPass && roomPlanPass && axisroomsPlanPass && axisroomsRatesPass && currentDayPass ? 'PASS' : 'FAIL',
    checks: [
      {
        label: 'Canonical hotel rate plan master rows exist',
        pass: canonicalPass,
        details: masterRows.map((row) => ({ code: row.rate_plan_code, id: row.default_rateplan_id })),
      },
      {
        label: 'Room to rate plan mapping exists',
        pass: roomPlanPass,
        details: roomPlans.map((row) => ({ roomId: row.room_id, rateplanId: row.rateplan_id, ratePlanCode: row.rate_plan_code })),
      },
      {
        label: 'AxisRooms rate plan row exists for booking-facing rateId',
        pass: axisroomsPlanPass,
        details: axisroomsPlan
          ? {
              propertyId: axisroomsPlan.axisrooms_property_id,
              roomId: axisroomsPlan.room_id,
              rateplanId: axisroomsPlan.rateplan_id,
              occupancy: axisroomsPlan.occupancy,
            }
          : null,
      },
      {
        label: 'AxisRooms rate rows exist with occupancy JSON',
        pass: axisroomsRatesPass,
        details: axisroomsRates.map((row) => ({
          startDate: row.start_date.toISOString().slice(0, 10),
          endDate: row.end_date.toISOString().slice(0, 10),
          occupancyRates: row.occupancy_rates,
        })),
      },
      {
        label: 'Current-day rate row covers the requested date',
        pass: currentDayPass,
        details: currentRate
          ? {
              verifyDate: VERIFY_DATE,
              occupancyRates: currentRate.occupancy_rates,
            }
          : null,
      },
    ],
  };

  console.log(safeStringify(result));
  if (result.status !== 'PASS') process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('Hotel rate plan verification failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });