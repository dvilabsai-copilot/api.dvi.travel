import { Prisma } from '@prisma/client';

/** Serialize one plan without locking another plan's timeline index range. */
export async function lockItineraryForRebuild(tx: Prisma.TransactionClient, planId: number): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT itinerary_plan_ID FROM dvi_itinerary_plan_details
    WHERE itinerary_plan_ID = ${planId} FOR UPDATE
  `);
}

/** Unique-key deletes avoid next-key locks on an empty plan-ID index range. */
export async function deleteExistingRebuildRows(
  model: any, where: Record<string, any>, primaryKey: string,
): Promise<{ count: number }> {
  const rows = await model.findMany({
    where, select: { [primaryKey]: true }, orderBy: { [primaryKey]: 'asc' },
  });
  let count = 0;
  for (let offset = 0; offset < rows.length; offset += 500) {
    const ids = rows.slice(offset, offset + 500).map((row: any) => row[primaryKey]);
    count += (await model.deleteMany({ where: { [primaryKey]: { in: ids } } })).count;
  }
  return { count };
}

/** The callback must contain only transactional DB work, never provider calls. */
export async function withRebuildTransactionRetry<T>(
  run: () => Promise<T>,
  wait: (milliseconds: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if ((error as any)?.code !== 'P2034' || attempt >= 3) throw error;
      await wait(50 * attempt + Math.floor(Math.random() * 50));
    }
  }
}
