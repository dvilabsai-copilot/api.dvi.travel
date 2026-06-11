import 'dotenv/config';
import assert from 'node:assert/strict';
import { PrismaService } from '../src/prisma.service';
import { ItineraryVehiclesEngine } from '../src/modules/itineraries/engines/itinerary-vehicles.engine';

async function main() {
  const planId = 9565;
  const prisma = new PrismaService();
  await prisma.$connect();

  try {
    const engine = new ItineraryVehiclesEngine(prisma);
    const result = await engine.rebuildEligibleVendorList({
      planId,
      createdBy: 1,
    });

    const eligibleRows = await prisma.dvi_itinerary_plan_vendor_eligible_list.findMany({
      where: {
        itinerary_plan_id: planId,
        status: 1,
        deleted: 0,
      },
      select: {
        vehicle_type_id: true,
        vendor_id: true,
        vendor_vehicle_type_id: true,
      },
      orderBy: [
        { vehicle_type_id: 'asc' },
        { vendor_id: 'asc' },
        { itinerary_plan_vendor_eligible_ID: 'asc' },
      ],
    });

    const detailCount = await prisma.dvi_itinerary_plan_vendor_vehicle_details.count({
      where: {
        itinerary_plan_id: planId,
        status: 1,
        deleted: 0,
      },
    });

    const hasVehicleType = (vehicleTypeId: number) =>
      eligibleRows.some((row) => Number(row.vehicle_type_id) === vehicleTypeId);

    const hasModernRate23 = await prisma.dvi_vendor_vehicle_types.count({
      where: {
        vendor_id: 60,
        vehicle_type_id: 23,
        status: 1,
        deleted: 0,
      },
    });

    console.log(
      JSON.stringify(
        {
          rebuild_result: result,
          eligible_count: eligibleRows.length,
          vehicle_details_count: detailCount,
          eligible_rows: eligibleRows,
          has_modern_rate_for_23_vendor_60: hasModernRate23 > 0,
        },
        null,
        2,
      ),
    );

    assert.ok(hasVehicleType(1), 'Expected vehicle_type_id 1 to become eligible');
    assert.ok(hasVehicleType(25), 'Expected vehicle_type_id 25 to become eligible');

    if (hasModernRate23 > 0) {
      assert.ok(
        hasVehicleType(23),
        'Expected vehicle_type_id 23 to become eligible because an active vendor_vehicle_types row exists',
      );
    } else {
      assert.ok(
        !hasVehicleType(23),
        'Expected vehicle_type_id 23 to stay ineligible until an active vendor_vehicle_types row exists',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
