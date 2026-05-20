import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TARGET_HOTEL_ID = 153;
const TARGET_PROPERTY_ID = 'AX_DVI_HOTEL_153';
const TARGET_ROOM_REF_CODE = 'DVIRHON666981';

type JsonObj = Record<string, unknown>;

function asDateOnly(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value.toISOString().slice(0, 10);
}

function isNonEmptyObject(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as JsonObj).length > 0;
}

function isNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function safeStringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, val) => (typeof val === 'bigint' ? val.toString() : val),
    2,
  );
}

async function main(): Promise<void> {
  console.log('=== AxisRooms DB Inspection (Read-Only) ===');
  console.log(
    safeStringify(
      {
        targets: {
          hotelId: TARGET_HOTEL_ID,
          propertyId: TARGET_PROPERTY_ID,
          roomRefCode: TARGET_ROOM_REF_CODE,
        },
      },
    ),
  );

  const hotelById = await prisma.dvi_hotel.findUnique({
    where: { hotel_id: TARGET_HOTEL_ID },
    select: {
      hotel_id: true,
      hotel_name: true,
      axisrooms_property_id: true,
      axisrooms_enabled: true,
      status: true,
      deleted: true,
    },
  });

  const hotelsByProperty = await prisma.dvi_hotel.findMany({
    where: { axisrooms_property_id: TARGET_PROPERTY_ID },
    select: {
      hotel_id: true,
      hotel_name: true,
      axisrooms_property_id: true,
      axisrooms_enabled: true,
      status: true,
      deleted: true,
    },
    orderBy: { hotel_id: 'asc' },
  });

  const roomByRefCode = await prisma.dvi_hotel_rooms.findMany({
    where: { room_ref_code: TARGET_ROOM_REF_CODE },
    select: {
      room_ID: true,
      hotel_id: true,
      room_title: true,
      room_ref_code: true,
      status: true,
      deleted: true,
    },
    orderBy: { room_ID: 'asc' },
  });

  const roomForHotel153ByRef = await prisma.dvi_hotel_rooms.findMany({
    where: {
      hotel_id: TARGET_HOTEL_ID,
      room_ref_code: TARGET_ROOM_REF_CODE,
    },
    select: {
      room_ID: true,
      hotel_id: true,
      room_title: true,
      room_ref_code: true,
      status: true,
      deleted: true,
    },
  });

  const axisroomsRateplans = await prisma.axisrooms_rateplan.findMany({
    where: {
      axisrooms_property_id: TARGET_PROPERTY_ID,
      room_id: TARGET_ROOM_REF_CODE,
    },
    select: {
      id: true,
      axisrooms_property_id: true,
      room_id: true,
      rateplan_id: true,
      rateplan_name: true,
      occupancy: true,
      commission_perc: true,
      tax_perc: true,
      currency: true,
      created_at: true,
    },
    orderBy: [{ rateplan_id: 'asc' }, { created_at: 'asc' }],
  });

  const axisroomsRates = await prisma.axisrooms_rate.findMany({
    where: {
      axisrooms_property_id: TARGET_PROPERTY_ID,
      room_id: TARGET_ROOM_REF_CODE,
    },
    select: {
      id: true,
      axisrooms_property_id: true,
      room_id: true,
      rateplan_id: true,
      start_date: true,
      end_date: true,
      occupancy_rates: true,
      received_at: true,
    },
    orderBy: [{ rateplan_id: 'asc' }, { start_date: 'asc' }, { end_date: 'asc' }],
  });

  const ratesByPlan = new Map<
    string,
    {
      rows: number;
      minStartDate: string | null;
      maxEndDate: string | null;
      emptyOccupancyRows: number;
      nonEmptyOccupancyRows: number;
    }
  >();

  for (const row of axisroomsRates) {
    const key = row.rateplan_id;
    const curr = ratesByPlan.get(key) ?? {
      rows: 0,
      minStartDate: null,
      maxEndDate: null,
      emptyOccupancyRows: 0,
      nonEmptyOccupancyRows: 0,
    };

    curr.rows += 1;

    const start = asDateOnly(row.start_date);
    const end = asDateOnly(row.end_date);

    if (start && (!curr.minStartDate || start < curr.minStartDate)) {
      curr.minStartDate = start;
    }
    if (end && (!curr.maxEndDate || end > curr.maxEndDate)) {
      curr.maxEndDate = end;
    }

    if (isNonEmptyObject(row.occupancy_rates)) {
      curr.nonEmptyOccupancyRows += 1;
    } else {
      curr.emptyOccupancyRows += 1;
    }

    ratesByPlan.set(key, curr);
  }

  const dbDerivedValidityByRateplan = Array.from(ratesByPlan.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rateplanId, stats]) => ({
      rateplanId,
      ...stats,
    }));

  const hardcodedRatePlanInfoValidity = {
    startDate: '2014-06-02',
    endDate: '2099-12-31',
  };

  const response = {
    hotelById,
    hotelsByProperty,
    roomByRefCode,
    roomForHotel153ByRef,
    axisroomsRateplansSummary: {
      count: axisroomsRateplans.length,
      rows: axisroomsRateplans.map((r) => ({
        id: r.id,
        propertyId: r.axisrooms_property_id,
        roomId: r.room_id,
        rateplanId: r.rateplan_id,
        rateplanName: r.rateplan_name,
        occupancyHasValues: isNonEmptyArray(r.occupancy),
        occupancy: r.occupancy,
        commissionPerc: r.commission_perc,
        taxPerc: r.tax_perc,
        currency: r.currency,
        createdAt: r.created_at.toISOString(),
      })),
    },
    axisroomsRatesSummary: {
      count: axisroomsRates.length,
      first10Rows: axisroomsRates.slice(0, 10).map((r) => ({
        id: r.id,
        propertyId: r.axisrooms_property_id,
        roomId: r.room_id,
        rateplanId: r.rateplan_id,
        startDate: asDateOnly(r.start_date),
        endDate: asDateOnly(r.end_date),
        occupancyRatesIsNonEmptyObject: isNonEmptyObject(r.occupancy_rates),
        occupancyRates: r.occupancy_rates,
        receivedAt: r.received_at.toISOString(),
      })),
      dbDerivedValidityByRateplan,
    },
    validityComparison: {
      hardcodedRatePlanInfoValidity,
      dbDerivedValidityByRateplan,
      note: 'hardcodedRatePlanInfoValidity currently does not use DB-derived dates',
    },
  };

  console.log(safeStringify(response));
}

main()
  .catch((error: unknown) => {
    console.error('Script failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
