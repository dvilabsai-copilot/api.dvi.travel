import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type CheckResult = {
  label: string;
  pass: boolean;
  details?: string;
};

const HOTEL_ID = Number(process.env.E2E_AXIS_HOTEL_ID ?? '153');
const PROPERTY_ID = process.env.E2E_AXIS_PROPERTY_ID ?? 'AX_DVI_HOTEL_153';
const ROOM_REF_CODE = process.env.E2E_AXIS_ROOM_REF_CODE ?? 'DVIRHON666981';
const RATEPLAN_ID = process.env.E2E_AXIS_RATEPLAN_ID ?? `AUTO_${ROOM_REF_CODE}`;

const START_DATE = process.env.E2E_AXIS_START_DATE ?? '2030-01-01';
const END_DATE = process.env.E2E_AXIS_END_DATE ?? '2030-01-02';

const EXPECTED_SINGLE = Number(process.env.E2E_AXIS_ROOM_PRICE ?? '3111');
const EXPECTED_EXTRABED = Number(process.env.E2E_AXIS_EXTRA_BED ?? '777');
const EXPECTED_CHILD_WITH_BED = Number(process.env.E2E_AXIS_CHILD_WITH_BED ?? '555');
const EXPECTED_CHILD_WITHOUT_BED = Number(process.env.E2E_AXIS_CHILD_WITHOUT_BED ?? '444');
const EXPECTED_EXTRACHILD = Math.max(EXPECTED_CHILD_WITH_BED, EXPECTED_CHILD_WITHOUT_BED);

function isNonEmptyArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0;
}

function asDateOnly(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value.toISOString().slice(0, 10);
}

function safeStringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, val) => (typeof val === 'bigint' ? val.toString() : val),
    2,
  );
}

function push(results: CheckResult[], label: string, pass: boolean, details?: string): void {
  results.push({ label, pass, details });
}

async function main(): Promise<void> {
  const checks: CheckResult[] = [];

  const hotel = await prisma.dvi_hotel.findUnique({
    where: { hotel_id: HOTEL_ID },
    select: {
      hotel_id: true,
      axisrooms_property_id: true,
      axisrooms_enabled: true,
      deleted: true,
      status: true,
    },
  });

  push(
    checks,
    'Hotel exists and is AxisRooms-enabled',
    !!hotel && hotel.axisrooms_property_id === PROPERTY_ID && hotel.axisrooms_enabled === 1,
    `hotel=${safeStringify(hotel)}`,
  );

  const room = await prisma.dvi_hotel_rooms.findFirst({
    where: {
      hotel_id: HOTEL_ID,
      room_ref_code: ROOM_REF_CODE,
    },
    select: {
      room_ID: true,
      room_ref_code: true,
      hotel_id: true,
      status: true,
      deleted: true,
    },
  });

  push(
    checks,
    'Target room exists for hotel',
    !!room,
    `room=${safeStringify(room)}`,
  );

  const rateplan = await prisma.axisrooms_rateplan.findUnique({
    where: {
      axisrooms_property_id_room_id_rateplan_id: {
        axisrooms_property_id: PROPERTY_ID,
        room_id: ROOM_REF_CODE,
        rateplan_id: RATEPLAN_ID,
      },
    },
    select: {
      rateplan_id: true,
      rateplan_name: true,
      occupancy: true,
      commission_perc: true,
      tax_perc: true,
      currency: true,
      created_at: true,
    },
  });

  const occupancy = Array.isArray(rateplan?.occupancy)
    ? (rateplan?.occupancy as string[])
    : [];

  const hasExpectedOccupancyKeys =
    isNonEmptyArray(occupancy) &&
    occupancy.includes('SINGLE') &&
    occupancy.includes('EXTRABED') &&
    occupancy.includes('EXTRACHILD') &&
    !occupancy.includes('CHILD_WITH_BED') &&
    !occupancy.includes('CHILD_WITHOUT_BED');

  push(
    checks,
    'axisrooms_rateplan row has expected occupancy contract keys',
    !!rateplan && hasExpectedOccupancyKeys,
    `rateplan=${safeStringify(rateplan)}`,
  );

  const rateRow = await prisma.axisrooms_rate.findUnique({
    where: {
      axisrooms_property_id_room_id_rateplan_id_start_date_end_date: {
        axisrooms_property_id: PROPERTY_ID,
        room_id: ROOM_REF_CODE,
        rateplan_id: RATEPLAN_ID,
        start_date: new Date(`${START_DATE}T00:00:00.000Z`),
        end_date: new Date(`${END_DATE}T00:00:00.000Z`),
      },
    },
    select: {
      rateplan_id: true,
      start_date: true,
      end_date: true,
      occupancy_rates: true,
      received_at: true,
    },
  });

  const occ = (rateRow?.occupancy_rates || {}) as Record<string, unknown>;
  const actualSingle = Number(occ.SINGLE ?? NaN);
  const actualExtraBed = Number(occ.EXTRABED ?? NaN);
  const actualExtraChild = Number(occ.EXTRACHILD ?? NaN);

  const occupancyValuesPass =
    Number.isFinite(actualSingle) &&
    Number.isFinite(actualExtraBed) &&
    Number.isFinite(actualExtraChild) &&
    actualSingle === EXPECTED_SINGLE &&
    actualExtraBed === EXPECTED_EXTRABED &&
    actualExtraChild === EXPECTED_EXTRACHILD &&
    occ.CHILD_WITH_BED === undefined &&
    occ.CHILD_WITHOUT_BED === undefined;

  push(
    checks,
    'axisrooms_rate row exists with expected occupancy_rates values',
    !!rateRow && occupancyValuesPass,
    `rateRow=${safeStringify(rateRow)}`,
  );

  const rateRowsByPlan = await prisma.axisrooms_rate.findMany({
    where: {
      axisrooms_property_id: PROPERTY_ID,
      room_id: ROOM_REF_CODE,
      rateplan_id: RATEPLAN_ID,
    },
    select: {
      start_date: true,
      end_date: true,
    },
  });

  const minStart = rateRowsByPlan
    .map((r) => asDateOnly(r.start_date))
    .filter((v): v is string => !!v)
    .sort()[0] || null;

  const maxEnd =
    rateRowsByPlan
      .map((r) => asDateOnly(r.end_date))
      .filter((v): v is string => !!v)
      .sort()
      .slice(-1)[0] || null;

  const validityContainsExpected =
    !!minStart && !!maxEnd && minStart <= START_DATE && maxEnd >= END_DATE;

  push(
    checks,
    'Rateplan validity window in DB includes saved start/end',
    validityContainsExpected,
    safeStringify({ minStart, maxEnd, expectedStart: START_DATE, expectedEnd: END_DATE }),
  );

  const passed = checks.every((c) => c.pass);

  console.log(
    safeStringify({
      status: passed ? 'PASS' : 'FAIL',
      targets: {
        HOTEL_ID,
        PROPERTY_ID,
        ROOM_REF_CODE,
        RATEPLAN_ID,
        START_DATE,
        END_DATE,
      },
      expected: {
        SINGLE: EXPECTED_SINGLE,
        EXTRABED: EXPECTED_EXTRABED,
        EXTRACHILD: EXPECTED_EXTRACHILD,
      },
      checks,
    }),
  );

  if (!passed) {
    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error('DB verification script failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
