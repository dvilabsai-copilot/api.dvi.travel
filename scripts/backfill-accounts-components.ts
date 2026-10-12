/// <reference types="node" />

// scripts/backfill-accounts-components.ts

import "dotenv/config";

import { PrismaService } from "../src/prisma.service";

import { AccountsComponentSyncService } from
  "../src/modules/accounts-manager/accounts-component-sync.service";

const prisma = new PrismaService();

const syncService =
  new AccountsComponentSyncService(prisma);

const args = process.argv.slice(2);

const apply = args.includes("--apply");

const getArg = (name: string): string | undefined =>
  args
    .find((arg) => arg.startsWith(`${name}=`))
    ?.slice(name.length + 1);

function readInteger(
  name: string,
  fallback: number,
): number {
  const raw = getArg(name);

  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number(raw);

  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0
  ) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }

  return parsed;
}

async function main() {
  const after = readInteger("--after", 0);

  const limit = readInteger("--limit", 25);

  if (limit < 1 || limit > 100) {
    throw new Error(
      "--limit must be between 1 and 100",
    );
  }

  const quoteId = String(
    getArg("--quote") || "",
  ).trim();

  const confirmedPlans =
    await prisma
      .dvi_confirmed_itinerary_plan_details
      .findMany({
        where: {
          status: 1,
          deleted: 0,

          ...(quoteId
            ? {
                itinerary_quote_ID: quoteId,
              }
            : {
                confirmed_itinerary_plan_ID: {
                  gt: after,
                },
              }),
        },

        select: {
          confirmed_itinerary_plan_ID: true,
          itinerary_quote_ID: true,
        },

        orderBy: {
          confirmed_itinerary_plan_ID: "asc",
        },

        take: quoteId ? 1 : limit,
      });

  console.log(
    `[ACCOUNTS_BACKFILL] Mode: ${
      apply ? "APPLY" : "DRY RUN"
    }`,
  );

  console.log(
    `[ACCOUNTS_BACKFILL] Candidates: ${confirmedPlans.length}`,
  );

  let succeeded = 0;
  let failed = 0;
  let lastId = after;

  for (const plan of confirmedPlans) {
    const id = Number(
      plan.confirmed_itinerary_plan_ID,
    );

    const quote = String(
      plan.itinerary_quote_ID || "",
    ).trim();

    lastId = id;

    if (!quote) {
      console.warn(
        `[ACCOUNTS_BACKFILL] Missing quote ID for ${id}`,
      );

      failed++;
      continue;
    }

    if (!apply) {
      console.log(
        `[DRY RUN] Would synchronize ${quote}`,
      );

      continue;
    }

    try {
      await syncService.ensureConfirmedQuote(
        quote,
      );

      succeeded++;

      console.log(
        `[ACCOUNTS_BACKFILL] Synchronized ${quote}`,
      );
    } catch (error) {
      failed++;

      console.error(
        `[ACCOUNTS_BACKFILL] Failed ${quote}`,
        error,
      );
    }
  }

  console.log({
    mode: apply ? "APPLY" : "DRY RUN",
    candidates: confirmedPlans.length,
    succeeded,
    failed,
    lastId,
  });

  if (!quoteId) {
    console.log(
      `Next batch: --after=${lastId}`,
    );
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(
      "[ACCOUNTS_BACKFILL_FATAL]",
      error,
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });