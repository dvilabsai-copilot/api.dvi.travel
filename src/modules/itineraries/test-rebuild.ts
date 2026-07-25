/**
 * Test script to rebuild hotspots for plan
 * Run with: npx ts-node src/modules/itineraries/test-rebuild.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const planId = 33958;

 console.log(`\n=== REBUILDING HOTSPOTS FOR PLAN ${planId} ===\n`);

 // Delete old hotspot data
 console.log("Deleting old hotspot details...");
  const deletedHotspotDetails = await prisma.dvi_itinerary_route_hotspot_details.deleteMany({
    where: {
      itinerary_plan_ID: planId,
    },
  });
 console.log(`Deleted ${deletedHotspotDetails.count} old hotspot detail rows`);

 console.log("Deleting old parking charges...");
  const deletedParking = await prisma.dvi_itinerary_route_hotspot_parking_charge.deleteMany({
    where: {
      itinerary_plan_ID: planId,
    },
  });
 console.log(`Deleted ${deletedParking.count} old parking rows`);

 // Now trigger the rebuild via API or direct service call
 // For now, just report that we've cleared the data
 console.log("\n Old data cleared. Now rebuild via API POST to /api/v1/itineraries");
 console.log(" OR manually call: await itinerariesService.createPlan({...})");

  await prisma.$disconnect();
}

main().catch((err) => {
 console.error("Error:", err);
  process.exit(1);
});
