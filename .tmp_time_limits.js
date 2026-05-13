const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const rows = await p.$queryRawUnsafe(`
    SELECT time_limit_id, vendor_id, vendor_vehicle_type_id, time_limit_title, hours_limit, km_limit, status, deleted, createdon, updatedon
    FROM dvi_time_limit
    WHERE vendor_id = 26 AND vendor_vehicle_type_id = 115
    ORDER BY hours_limit, km_limit, time_limit_id
  `);
  console.log(JSON.stringify(rows, null, 2));
})();
