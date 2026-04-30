const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const cityCode = String(process.argv[2] || '127343').trim();

  if (!cityCode) {
    throw new Error('CityCode is required. Example: node scripts/count-hotels-by-city-db.js 127343');
  }

  const [
    tboMasterTotal,
    tboMasterActive,
    tboMasterDistinct,
    dviHotelTotal,
    dviHotelNotDeleted,
    dviHotelDistinct,
  ] = await Promise.all([
    prisma.tbo_hotel_master.count({
      where: { tbo_city_code: cityCode },
    }),
    prisma.tbo_hotel_master.count({
      where: { tbo_city_code: cityCode, status: 1 },
    }),
    prisma.tbo_hotel_master.findMany({
      where: { tbo_city_code: cityCode },
      select: { tbo_hotel_code: true },
      distinct: ['tbo_hotel_code'],
    }),
    prisma.dvi_hotel.count({
      where: { tbo_city_code: cityCode },
    }),
    prisma.dvi_hotel.count({
      where: { tbo_city_code: cityCode, deleted: false },
    }),
    prisma.dvi_hotel.findMany({
      where: { tbo_city_code: cityCode },
      select: { tbo_hotel_code: true },
      distinct: ['tbo_hotel_code'],
    }),
  ]);

  const output = {
    cityCode,
    tbo_hotel_master: {
      total_rows: tboMasterTotal,
      active_rows: tboMasterActive,
      distinct_hotel_codes: tboMasterDistinct.length,
    },
    dvi_hotel: {
      total_rows: dviHotelTotal,
      not_deleted_rows: dviHotelNotDeleted,
      distinct_hotel_codes: dviHotelDistinct.length,
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

main()
  .catch((error) => {
    console.error('FAILED:', error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
