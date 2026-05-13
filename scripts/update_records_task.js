const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    console.log('Updating dvi_time_limit...');
    const updatedTimeLimit = await prisma.dvi_time_limit.update({
      where: { time_limit_id: 139 },
      data: {
        km_limit: 80,
        updatedon: new Date()
      }
    });
    console.log('Updated dvi_time_limit ID 139. New km_limit:', updatedTimeLimit.km_limit);
    console.log('Updated dvi_time_limit ID 139. updatedon:', updatedTimeLimit.updatedon);

    console.log('Updating dvi_itinerary_plan_vendor_vehicle_details...');
    const updatedDetails = await prisma.dvi_itinerary_plan_vendor_vehicle_details.update({
      where: { itinerary_plan_vendor_vehicle_details_ID: 10946 },
      data: {
        total_extra_km: '7.70',
        total_extra_km_charges: 138.60,
        updatedon: new Date()
      }
    });
    console.log('Updated ID 10946. total_extra_km:', updatedDetails.total_extra_km, 'total_extra_km_charges:', updatedDetails.total_extra_km_charges);
    console.log('Updated ID 10946. updatedon:', updatedDetails.updatedon);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}
main();
