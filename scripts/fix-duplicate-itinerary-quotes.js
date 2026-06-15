const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function getMonthPrefix(dateValue) {
  const date = new Date(dateValue);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `DVI${year}${month}`;
}

function extractQuoteSequence(quoteId, prefix) {
  const normalized = String(quoteId || '').trim();
  if (!normalized.startsWith(prefix)) return null;
  const suffix = normalized.slice(prefix.length);
  if (!/^\d+$/.test(suffix)) return null;
  const parsed = Number.parseInt(suffix, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function main() {
  const apply = process.argv.includes('--apply');

  const rows = await prisma.dvi_itinerary_plan_details.findMany({
    where: {
      deleted: 0,
      itinerary_quote_ID: {
        not: '',
      },
    },
    select: {
      itinerary_plan_ID: true,
      itinerary_quote_ID: true,
      arrival_location: true,
      departure_location: true,
      no_of_nights: true,
      no_of_days: true,
      createdon: true,
      updatedon: true,
      status: true,
      deleted: true,
    },
    orderBy: [
      { itinerary_quote_ID: 'asc' },
      { createdon: 'asc' },
      { itinerary_plan_ID: 'asc' },
    ],
  });

  const groupedByQuote = new Map();
  for (const row of rows) {
    const quoteId = String(row.itinerary_quote_ID || '').trim();
    if (!quoteId) continue;
    const existing = groupedByQuote.get(quoteId) || [];
    existing.push(row);
    groupedByQuote.set(quoteId, existing);
  }

  const duplicateGroups = Array.from(groupedByQuote.entries())
    .map(([quoteId, groupRows]) => ({
      quoteId,
      rows: [...groupRows].sort(
        (a, b) =>
          new Date(a.createdon || 0).getTime() - new Date(b.createdon || 0).getTime() ||
          Number(a.itinerary_plan_ID || 0) - Number(b.itinerary_plan_ID || 0),
      ),
    }))
    .filter((group) => group.rows.length > 1);

  if (duplicateGroups.length === 0) {
    console.log('No duplicate active itinerary quote IDs found.');
    return;
  }

  const monthState = new Map();
  const usedQuoteIds = new Set(
    rows.map((row) => String(row.itinerary_quote_ID || '').trim()).filter(Boolean),
  );

  for (const row of rows) {
    const createdAt = row.createdon || new Date();
    const prefix = getMonthPrefix(createdAt);
    const sequence = extractQuoteSequence(row.itinerary_quote_ID, prefix);
    if (sequence === null) continue;
    const currentMax = monthState.get(prefix) || 0;
    if (sequence > currentMax) {
      monthState.set(prefix, sequence);
    }
  }

  const remediationPlan = [];
  for (const group of duplicateGroups) {
    const keeper = group.rows[0];
    const losers = group.rows.slice(1);
    for (const loser of losers) {
      const prefix = getMonthPrefix(loser.createdon || new Date());
      let nextSequence = monthState.get(prefix) || 0;
      let newQuoteId = '';
      do {
        nextSequence += 1;
        newQuoteId = `${prefix}${nextSequence}`;
      } while (usedQuoteIds.has(newQuoteId));
      monthState.set(prefix, nextSequence);
      usedQuoteIds.add(newQuoteId);

      remediationPlan.push({
        duplicateQuoteId: group.quoteId,
        keepPlanId: Number(keeper.itinerary_plan_ID || 0),
        reassignPlanId: Number(loser.itinerary_plan_ID || 0),
        newQuoteId,
        createdon: loser.createdon,
      });
    }
  }

  console.log('Duplicate active itinerary quote groups:');
  for (const group of duplicateGroups) {
    console.log(
      JSON.stringify({
        quoteId: group.quoteId,
        planIds: group.rows.map((row) => Number(row.itinerary_plan_ID || 0)),
        rows: group.rows,
      }),
    );
  }

  console.log('\nProposed remediation updates:');
  for (const row of remediationPlan) {
    console.log(
      `UPDATE dvi_itinerary_plan_details SET itinerary_quote_ID = '${row.newQuoteId}', updatedon = NOW() WHERE itinerary_plan_ID = ${row.reassignPlanId} AND deleted = 0;`,
    );
  }

  if (!apply) {
    console.log('\nRun with --apply to execute the updates.');
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const row of remediationPlan) {
      await tx.dvi_itinerary_plan_details.update({
        where: { itinerary_plan_ID: row.reassignPlanId },
        data: {
          itinerary_quote_ID: row.newQuoteId,
          updatedon: new Date(),
        },
      });
    }
  });

  console.log(`\nApplied ${remediationPlan.length} itinerary quote ID updates.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
