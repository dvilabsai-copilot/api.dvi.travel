import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function check() {
 console.log("=== GLOBAL SETTINGS ===\n");

  const gs = await (prisma as any).dvi_global_settings.findFirst({
    where: { deleted: 0, status: 1 },
  });

  if (gs) {
 console.log("Global settings found:");
 console.log(` itinerary_local_buffer_time: ${gs.itinerary_local_buffer_time}`);
 console.log(` itinerary_outstation_buffer_time: ${gs.itinerary_outstation_buffer_time}`);
 console.log(` itinerary_common_buffer_time: ${gs.itinerary_common_buffer_time}`);
 console.log(` itinerary_local_speed_limit: ${gs.itinerary_local_speed_limit}`);
 console.log(` itinerary_outstation_speed_limit: ${gs.itinerary_outstation_speed_limit}`);
  } else {
 console.log("No global settings found");
  }

  await prisma.$disconnect();
}

check().catch(console.error);
