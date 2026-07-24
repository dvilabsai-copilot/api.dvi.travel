import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function check() {
  const gs = await (prisma as any).dvi_global_settings.findFirst({
    where: { deleted: 0, status: 1 },
  });

  if (gs) {
    const buff = gs.itinerary_common_buffer_time;
 console.log("Raw buffer:", buff);
 console.log("Type:", typeof buff);
    if (buff instanceof Date) {
 console.log("As Date:", buff.toString());
 console.log("getHours:", buff.getHours());
 console.log("getUTCHours:", buff.getUTCHours());
 console.log("getMinutes:", buff.getMinutes());
 console.log("getUTCMinutes:", buff.getUTCMinutes());
 console.log("getSeconds:", buff.getSeconds());
 console.log("getUTCSeconds:", buff.getUTCSeconds());
    }
  }

  await prisma.$disconnect();
}

check().catch(console.error);
