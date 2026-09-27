import { PrismaClient } from '@prisma/client';

/**
 * Repair the two known offline Cherai hotel masters that were imported with
 * the unrelated Andorra La Vella city id. The default mode is a dry run;
 * pass --apply to persist the correction in the selected database.
 */
const HOTEL_CODES = ['DVIHTL540883', 'DVIHTL540884'];

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const targetCities = await prisma.dvi_cities.findMany({
    where: { deleted: 0, name: { in: ['Cherai'] } },
    select: { id: true, name: true, status: true },
  });

  if (targetCities.length !== 1) {
    throw new Error(`Expected exactly one active Cherai city row, found ${targetCities.length}`);
  }

  const targetCity = targetCities[0];
  const hotels = await prisma.dvi_hotel.findMany({
    where: {
      hotel_code: { in: HOTEL_CODES },
      deleted: false,
    },
    select: {
      hotel_id: true,
      hotel_code: true,
      hotel_name: true,
      hotel_city: true,
      hotel_address: true,
      hotel_place: true,
    },
    orderBy: { hotel_code: 'asc' },
  });

  const invalidRows = hotels.filter((hotel) => {
    const text = [hotel.hotel_name, hotel.hotel_address, hotel.hotel_place]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return text.includes('cherai') && String(hotel.hotel_city || '') !== String(targetCity.id);
  });

  const skippedRows = hotels.filter((hotel) => !invalidRows.includes(hotel));
  const result = {
    mode: apply ? 'apply' : 'dry-run',
    targetCity,
    candidates: hotels.map((hotel) => ({
      hotelId: hotel.hotel_id,
      hotelCode: hotel.hotel_code,
      hotelName: hotel.hotel_name,
      currentCity: hotel.hotel_city,
      action: invalidRows.includes(hotel) ? 'move-to-Cherai' : 'skip',
    })),
    skippedCount: skippedRows.length,
  };

  if (apply) {
    for (const hotel of invalidRows) {
      await prisma.dvi_hotel.update({
        where: { hotel_id: hotel.hotel_id },
        data: { hotel_city: String(targetCity.id) },
      });
    }
  }

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
