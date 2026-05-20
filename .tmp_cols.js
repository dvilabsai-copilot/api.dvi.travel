const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const tables = ["dvi_itinerary_plan_details","dvi_itinerary_route_details","dvi_itinerary_plan_vendor_vehicle_details","dvi_time_limit","dvi_vendor_branches"];
  for (const t of tables) {
    const cols = await p.$queryRawUnsafe(`SHOW COLUMNS FROM ${t}`);
    console.log(`\n=== ${t} ===`);
    console.log(cols.map(c => c.Field).join(", "));
  }
})().catch(e=>{console.error(e);process.exit(1);}).finally(async()=>{await p.$disconnect();});
