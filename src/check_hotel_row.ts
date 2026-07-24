import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function check() {
  const row = await (prisma as any).dvi_itinerary_route_hotspot_details.findFirst({
    where: {
      itinerary_plan_ID: { startsWith: "DVI20251213" },
      status: 1,
      deleted: 0,
    },
    select: {
      route_hotspot_ID: true,
      itinerary_plan_ID: true,
      itinerary_route_ID: true,
      hotspot_start_time: true,
      hotspot_end_time: true,
      hotspot_ID: true,
      hotspot_traveling_time: true,
      itinerary_travel_type_buffer_time: true,
      hotspot_travelling_distance: true,
    },
  });

  if (row) {
 console.log("Hotel row found:");
    for (const [key, value] of Object.entries(row)) {
 console.log(` ${key}: ${value}`);
    }
  } else {
 console.log("No hotel row found");
  }

  await prisma.$disconnect();
}

check().catch(console.error);
