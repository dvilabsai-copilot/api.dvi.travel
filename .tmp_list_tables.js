const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const tables = await p.$queryRawUnsafe("SHOW TABLES");
  const keys = Object.keys(tables[0] || {});
  const col = keys[0];
  const filtered = tables.map(r => r[col]).filter(n => /itinerary|vehicle|time_limit|vendor|route/i.test(String(n)));
  console.log(JSON.stringify(filtered, null, 2));
})().catch(e=>{console.error(e);process.exit(1);}).finally(async()=>{await p.$disconnect();});
