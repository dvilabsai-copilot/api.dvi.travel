/**
 * Debug script to understand the hotspot selection issue
 * Run with: npx ts-node src/modules/itineraries/debug-hotspots.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
 console.log("\n=== DEBUGGING HOTSPOT SELECTION FOR PLAN 2 ===\n");

 // Get plan 2 details
  const plan = await prisma.dvi_itinerary_plan_details.findFirst({
    where: { itinerary_plan_ID: 2, deleted: 0 },
  });

 console.log("Plan 2:", plan);
 console.log("\n--- Routes for Plan 2 ---");

 // Get all routes for plan 2
  const routes = await prisma.dvi_itinerary_route_details.findMany({
    where: { itinerary_plan_ID: 2, deleted: 0, status: 1 },
    orderBy: [
      { itinerary_route_date: "asc" },
      { itinerary_route_ID: "asc" },
    ],
  });

  for (const route of routes) {
 console.log(`\nRoute ${route.itinerary_route_ID} (${route.itinerary_route_date}):`);
 console.log(` location_name: "${route.location_name}"`);
 console.log(` next_visiting_location: "${route.next_visiting_location}"`);
 console.log(` location_id: ${route.location_id}`);

 // For this route, find matching hotspots
    const targetLocation =
      (route.location_name as string) || (route.next_visiting_location as string);

    if (targetLocation) {
 console.log(` \n Searching for hotspots matching: "${targetLocation}"`);

      const allHotspots = await prisma.dvi_hotspot_place.findMany({
        where: { deleted: 0, status: 1 },
        select: {
          hotspot_ID: true,
          hotspot_name: true,
          hotspot_location: true,
          hotspot_priority: true,
        },
        orderBy: [
          { hotspot_priority: "asc" },
          { hotspot_ID: "asc" },
        ],
      });

 console.log(` Total active hotspots: ${allHotspots.length}`);

      const matches = allHotspots.filter((h) => {
        const hsLocation = (h.hotspot_location as string) || "";
        return hsLocation
          .toLowerCase()
          .includes(targetLocation.toLowerCase());
      });

 console.log(
        `  Matched hotspots: ${matches.length}`,
      );
      for (const h of matches) {
 console.log(
          `    - ID: ${h.hotspot_ID}, Name: ${h.hotspot_name}, Location: "${h.hotspot_location}", Priority: ${h.hotspot_priority}`,
        );
      }
    } else {
 console.log(` No location_name or next_visiting_location found`);
    }
  }

 console.log("\n--- ALL Hotspots in Database ---");
  const allHotspots = await prisma.dvi_hotspot_place.findMany({
    where: { deleted: 0, status: 1 },
    select: {
      hotspot_ID: true,
      hotspot_name: true,
      hotspot_location: true,
      hotspot_priority: true,
    },
    orderBy: [{ hotspot_priority: "asc" }, { hotspot_ID: "asc" }],
  });

 console.log(`Total: ${allHotspots.length} hotspots`);
  for (const h of allHotspots.slice(0, 20)) {
 console.log(
      `  ID: ${h.hotspot_ID}, Name: ${h.hotspot_name}, Location: "${h.hotspot_location}", Priority: ${h.hotspot_priority}`,
    );
  }

  await prisma.$disconnect();
}

main().catch((err) => {
 console.error("Error:", err);
  process.exit(1);
});
