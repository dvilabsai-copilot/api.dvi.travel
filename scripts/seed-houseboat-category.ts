import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const HOUSEBOAT_CATEGORY_CODE = 'HOUSEBOAT';
const HOUSEBOAT_HOTEL_CODES = ['1674220', '5110229'];

type CategoryRow = { hotel_category_id: number };

async function main(): Promise<void> {
  const result = await prisma.$transaction(async (tx) => {
    let category = await tx.$queryRaw<CategoryRow[]>`
      SELECT hotel_category_id
      FROM dvi_hotel_category
      WHERE hotel_category_code = ${HOUSEBOAT_CATEGORY_CODE}
         OR LOWER(hotel_category_title) = 'houseboat'
      ORDER BY hotel_category_id
      LIMIT 1
    `;

    if (!category[0]) {
      await tx.$executeRaw`
        INSERT INTO dvi_hotel_category
          (hotel_category_title, hotel_category_code, createdon, updatedon, createdby, status, deleted)
        VALUES ('Houseboat', ${HOUSEBOAT_CATEGORY_CODE}, NOW(), NOW(), 0, 1, 0)
      `;

      category = await tx.$queryRaw<CategoryRow[]>`
        SELECT hotel_category_id
        FROM dvi_hotel_category
        WHERE hotel_category_code = ${HOUSEBOAT_CATEGORY_CODE}
        ORDER BY hotel_category_id
        LIMIT 1
      `;
    }

    const categoryId = category[0]?.hotel_category_id;
    if (!categoryId) {
      throw new Error('Houseboat category could not be created or located');
    }

    await tx.$executeRaw`
      UPDATE dvi_hotel_category
      SET hotel_category_title = 'Houseboat',
          hotel_category_code = ${HOUSEBOAT_CATEGORY_CODE},
          status = 1,
          deleted = 0,
          updatedon = NOW()
      WHERE hotel_category_id = ${categoryId}
    `;

    const tboRowsUpdated = await tx.$executeRaw`
      UPDATE tbo_hotel_master
      SET hotel_category_id = ${categoryId}
      WHERE tbo_hotel_code IN (${HOUSEBOAT_HOTEL_CODES[0]}, ${HOUSEBOAT_HOTEL_CODES[1]})
    `;

    const operationalRowsUpdated = await tx.$executeRaw`
      UPDATE dvi_hotel
      SET hotel_category = ${categoryId}
      WHERE tbo_hotel_code IN (${HOUSEBOAT_HOTEL_CODES[0]}, ${HOUSEBOAT_HOTEL_CODES[1]})
    `;

    return {
      categoryId,
      tboRowsUpdated: Number(tboRowsUpdated),
      operationalRowsUpdated: Number(operationalRowsUpdated),
    };
  });

  console.log(JSON.stringify({
    success: true,
    category: { id: result.categoryId, title: 'Houseboat', code: HOUSEBOAT_CATEGORY_CODE },
    hotelCodes: HOUSEBOAT_HOTEL_CODES,
    ...result,
  }));
}

main()
  .catch((error: unknown) => {
    console.error('Houseboat category seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
