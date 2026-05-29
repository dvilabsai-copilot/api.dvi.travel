const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes('--dry-run');

const QUOTE_ID = process.argv
  .find((arg) => arg.startsWith('--quote='))
  ?.split('=')[1];

if (!QUOTE_ID) {
  console.error('Usage: node scripts/unconfirm.js --quote=DVI20260589 --dry-run');
  process.exit(1);
}

async function getPlanIdByQuoteId(tx, quoteId) {
  const plan = await tx.dvi_itinerary_plan_details.findFirst({
    where: {
      itinerary_quote_ID: quoteId,
      deleted: 0,
    },
    select: {
      itinerary_plan_ID: true,
      itinerary_quote_ID: true,
      quotation_status: true,
    },
    orderBy: {
      itinerary_plan_ID: 'desc',
    },
  });

  if (!plan) {
    throw new Error(`No itinerary plan found for quote ID: ${quoteId}`);
  }

  return plan.itinerary_plan_ID;
}

async function countRows(tx, PLAN_ID) {
  return {
    plan: await tx.dvi_itinerary_plan_details.count({
      where: { itinerary_plan_ID: PLAN_ID, itinerary_quote_ID: QUOTE_ID },
    }),
    confirmedPlan: await tx.dvi_confirmed_itinerary_plan_details.count({
      where: { itinerary_plan_ID: PLAN_ID },
    }),
    customers: await tx.dvi_confirmed_itinerary_customer_details.count({
      where: { itinerary_plan_ID: PLAN_ID },
    }),
    accounts: await tx.dvi_accounts_itinerary_details.count({
      where: { itinerary_plan_ID: PLAN_ID },
    }),
    cashWallet: await tx.dvi_cash_wallet.count({
      where: { transaction_id: QUOTE_ID, transaction_type: 2 },
    }),
    confirmedHotels: await tx.dvi_confirmed_itinerary_plan_hotel_details.count({
      where: { itinerary_plan_id: PLAN_ID },
    }),
    confirmedRoutes: await tx.dvi_confirmed_itinerary_route_details.count({
      where: { itinerary_plan_ID: PLAN_ID },
    }),
  };
}

async function main() {
  const PLAN_ID = await getPlanIdByQuoteId(prisma, QUOTE_ID);

  console.log('[UNCONFIRM] Starting for', { QUOTE_ID, PLAN_ID, DRY_RUN });

  const before = await countRows(prisma, PLAN_ID);
  console.log('[UNCONFIRM] Before:', before);

  if (DRY_RUN) {
    console.log('[UNCONFIRM] Dry run only. No DB changes made.');
    return;
  }

  await prisma.$transaction(async (tx) => {
    const confirmedPlan = await tx.dvi_confirmed_itinerary_plan_details.findFirst({
      where: {
        itinerary_plan_ID: PLAN_ID,
        itinerary_quote_ID: QUOTE_ID,
      },
    });

    if (!confirmedPlan) {
      console.log('[UNCONFIRM] Confirmed plan not found. It may already be unconfirmed. Skipping delete flow.');

      await tx.dvi_itinerary_plan_details.update({
        where: { itinerary_plan_ID: PLAN_ID },
        data: {
          quotation_status: 0,
          updatedon: new Date(),
        },
      });

      return;
    }

    const debitRows = await tx.dvi_cash_wallet.findMany({
      where: {
        transaction_id: QUOTE_ID,
        transaction_type: 2,
      },
    });

    const totalDebit = debitRows.reduce(
      (sum, row) => sum + Number(row.transaction_amount || 0),
      0,
    );

    console.log('[UNCONFIRM] Wallet debit rows to remove:', debitRows.length, 'amount:', totalDebit);

    if (totalDebit > 0 && confirmedPlan.agent_id) {
      await tx.dvi_agent.update({
        where: { agent_ID: confirmedPlan.agent_id },
        data: {
          total_cash_wallet: {
            increment: totalDebit,
          },
        },
      });
    }

    await tx.tbo_hotel_booking_confirmation.deleteMany({
      where: { itinerary_plan_ID: PLAN_ID },
    });

    await tx.resavenue_hotel_booking_confirmation.deleteMany({
      where: { itinerary_plan_ID: PLAN_ID },
    });

    await tx.axisrooms_hotel_booking_confirmation.deleteMany({
      where: {
        itinerary_plan_ID: PLAN_ID,
      },
    });

    await tx.hobse_hotel_booking_confirmation.deleteMany({
      where: { plan_id: PLAN_ID },
    });

    await tx.dvi_confirmed_itinerary_plan_route_permit_charge.deleteMany({
      where: { itinerary_plan_ID: PLAN_ID },
    });

    await tx.dvi_confirmed_itinerary_plan_vendor_vehicle_details.deleteMany({
      where: { itinerary_plan_id: PLAN_ID },
    });

    await tx.dvi_confirmed_itinerary_plan_vendor_eligible_list.deleteMany({
      where: { itinerary_plan_id: PLAN_ID },
    });

    await tx.dvi_confirmed_itinerary_route_guide_details.deleteMany({
      where: { itinerary_plan_ID: PLAN_ID },
    });

    await tx.dvi_confirmed_itinerary_route_activity_details.deleteMany({
      where: { itinerary_plan_ID: PLAN_ID },
    });

    await tx.dvi_confirmed_itinerary_route_hotspot_details.deleteMany({
      where: { itinerary_plan_ID: PLAN_ID },
    });

    await tx.dvi_confirmed_itinerary_plan_hotel_room_amenities.deleteMany({
      where: { itinerary_plan_id: PLAN_ID },
    });

    await tx.dvi_confirmed_itinerary_plan_hotel_room_details.deleteMany({
      where: { itinerary_plan_id: PLAN_ID },
    });

    await tx.dvi_confirmed_itinerary_plan_hotel_details.deleteMany({
      where: { itinerary_plan_id: PLAN_ID },
    });

    await tx.dvi_confirmed_itinerary_via_route_details.deleteMany({
      where: { itinerary_plan_ID: PLAN_ID },
    });

    await tx.dvi_confirmed_itinerary_route_details.deleteMany({
      where: { itinerary_plan_ID: PLAN_ID },
    });

    await tx.dvi_confirmed_itinerary_plan_vehicle_details.deleteMany({
      where: { itinerary_plan_id: PLAN_ID },
    });

    await tx.dvi_confirmed_itinerary_customer_details.deleteMany({
      where: { itinerary_plan_ID: PLAN_ID },
    });

    await tx.dvi_accounts_itinerary_details.deleteMany({
      where: { itinerary_plan_ID: PLAN_ID },
    });

    await tx.dvi_cash_wallet.deleteMany({
      where: {
        transaction_id: QUOTE_ID,
        transaction_type: 2,
      },
    });

    await tx.dvi_confirmed_itinerary_plan_details.deleteMany({
      where: {
        itinerary_plan_ID: PLAN_ID,
        itinerary_quote_ID: QUOTE_ID,
      },
    });

    await tx.dvi_itinerary_plan_details.update({
      where: { itinerary_plan_ID: PLAN_ID },
      data: {
        quotation_status: 0,
        updatedon: new Date(),
      },
    });
  });

  const after = await countRows(prisma, PLAN_ID);
  console.log('[UNCONFIRM] After:', after);
  console.log('[UNCONFIRM] Done. Quote is ready for confirm retest.');
}

main()
  .catch((error) => {
    console.error('[UNCONFIRM] Failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    prisma.$disconnect();
  });
