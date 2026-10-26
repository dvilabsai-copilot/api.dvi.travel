import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const HOTEL_HOLD_POLICY = {
  hotel_hold_no_block_before_hours: 48,
  hotel_hold_min_lead_days: 3,
  hotel_hold_short_lead_days: 15,
  hotel_hold_medium_lead_days: 30,
  hotel_hold_short_duration_hours: 4,
  hotel_hold_medium_duration_hours: 12,
  hotel_hold_long_duration_hours: 48,
} as const;

async function main() {
  const existing = await prisma.dvi_global_settings.findFirst({
    where: { deleted: 0 },
    orderBy: { global_settings_ID: "asc" },
    select: { global_settings_ID: true },
  });

  const now = new Date();

  if (existing) {
    await prisma.dvi_global_settings.update({
      where: { global_settings_ID: existing.global_settings_ID },
      data: { ...HOTEL_HOLD_POLICY, updatedon: now },
    });
  } else {
    await prisma.dvi_global_settings.create({
      data: {
        ...HOTEL_HOLD_POLICY,
        createdby: 0,
        createdon: now,
        updatedon: now,
        status: 1,
        deleted: 0,
      },
    });
  }

  console.log(JSON.stringify({ seeded: true, ...HOTEL_HOLD_POLICY }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
