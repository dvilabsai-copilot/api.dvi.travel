import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryConfirmationService } from '../src/modules/itineraries/services/itinerary-confirmation.service';

function createService(prisma: any = {}) {
  return new ItineraryConfirmationService(prisma, null as any, null as any);
}

test('quotation confirmation preserves missing-plan validation', async () => {
  await assert.rejects(
    () => createService({ dvi_itinerary_plan_details: { findUnique: async () => null } }).confirmQuotation({ itinerary_plan_ID: 99 } as any),
    /Itinerary plan not found/,
  );
});

test('confirmation preserves provider-bookable hotel filtering', () => {
  const service = createService();
  const bookings = [
    { provider: 'staah', hotelCode: 'H-1', netAmount: 100 },
    { provider: 'external', hotelCode: 'H-2', netAmount: 100 },
    { provider: 'tbo', hotelCode: 'H-3', bookingCode: '!TB!fresh', netAmount: 100 },
  ];

  assert.deepEqual(service.getProviderBookableHotelBookings(bookings), [bookings[0], bookings[2]]);
});

test('confirmation preserves booking-key normalization', () => {
  assert.equal(createService().bookingKey(' STAah ', 7), 'staah::7');
});

test('successful manual-hold payment atomically claims holds, debits wallet, and confirms the itinerary', async () => {
  const selectedHotelId = 101;
  const holdId = 201;
  const walletUpdates: any[] = [];
  const cashWalletEntries: any[] = [];
  const accountEntries: any[] = [];
  const confirmedPlans: any[] = [];
  const quotationUpdates: any[] = [];
  const paidHoldClaims: any[] = [];
  const transaction = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [{ itinerary_plan_hotel_details_ID: selectedHotelId }],
    },
    dvi_hotel_block_request: {
      findMany: async () => [{
        id: holdId,
        status: 'BLOCKED',
        cutoff_at: new Date('2030-11-10T12:00:00.000Z'),
        paid_confirmed_at: null,
        selection_ids: JSON.stringify([selectedHotelId]),
      }],
      updateMany: async (args: any) => {
        paidHoldClaims.push(args);
        return { count: 1 };
      },
    },
    dvi_agent: {
      findUnique: async () => ({ total_cash_wallet: 1000 }),
      updateMany: async (args: any) => {
        walletUpdates.push(args);
        return { count: 1 };
      },
    },
    dvi_cash_wallet: {
      create: async (args: any) => cashWalletEntries.push(args.data),
    },
    dvi_confirmed_itinerary_plan_details: {
      create: async (args: any) => {
        confirmedPlans.push(args.data);
        return { confirmed_itinerary_plan_ID: 555 };
      },
    },
    dvi_confirmed_itinerary_customer_details: {
      create: async () => ({ id: 1 }),
    },
    dvi_accounts_itinerary_details: {
      create: async (args: any) => accountEntries.push(args.data),
    },
    dvi_itinerary_plan_details: {
      update: async (args: any) => quotationUpdates.push(args),
    },
  };
  const plan = {
    itinerary_plan_ID: 800,
    agent_id: 70,
    staff_id: 0,
    location_id: 0n,
    itinerary_quote_ID: 'MOCK_HOLD_PAYMENT_800',
    trip_start_date_and_time: new Date('2030-11-08T03:30:00.000Z'),
    trip_end_date_and_time: new Date('2030-11-09T12:30:00.000Z'),
    itinerary_preference: 1,
    quotation_status: 0,
  };
  const prisma = {
    dvi_itinerary_plan_details: { findUnique: async () => plan },
    dvi_confirmed_itinerary_plan_details: { findFirst: async () => null },
    $transaction: async (callback: (tx: any) => Promise<any>) => callback(transaction),
  };
  const itineraryDetails = {
    getItineraryDetails: async () => ({
      vehicles: [],
      vehicleRateAvailability: [],
      costBreakdown: {
        totalHotspotCost: 0,
        totalActivityCost: 0,
        totalHotelAmount: 1000,
        totalVehicleAmount: 0,
        totalGuideCost: 0,
        totalAmount: 1000,
        agentMargin: 0,
        additionalMargin: 0,
        netPayable: 1000,
      },
    }),
  };
  const service = new ItineraryConfirmationService(prisma as any, itineraryDetails as any, null as any);
  service.setCallbacks({
    formatDateOnly: (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10),
    syncSelectedHotelDraftRowsForConfirmation: async () => ({
      providerHotelBookings: [],
      selectedRouteIds: [3],
      externalRouteIds: [],
      groupType: 1,
      skippedExternalStayCount: 0,
    }),
    getAgentWalletBalance: async () => ({ balance: 1000 }),
    copyDraftToConfirmed: async () => undefined,
  });

  const result = await service.confirmQuotation({
    itinerary_plan_ID: 800,
    agent: 70,
    manualHotelHoldWorkflow: true,
    selectedGroupType: 1,
    primary_guest_name: 'Mock Guest',
    primary_guest_age: '35',
    primary_guest_contact_no: '9000000000',
    arrival_date_and_time: '08-11-2030 9:00 AM',
    departure_date_and_time: '09-11-2030 6:00 PM',
    arrival_date_time: '08-11-2030 9:00 AM',
    departure_date_time: '09-11-2030 6:00 PM',
    arrival_place: 'Test Airport',
    departure_place: 'Test Airport',
  } as any);

  assert.equal(result.success, true);
  assert.equal(result.confirmed_itinerary_plan_ID, 555);
  assert.equal(result.bookingResults, null);
  assert.equal(paidHoldClaims.length, 1);
  assert.deepEqual(paidHoldClaims[0].where, {
    id: { in: [holdId] },
    status: { in: ['BLOCKED', 'CONFIRMED'] },
    paid_confirmed_at: null,
    cutoff_at: { gt: paidHoldClaims[0].data.paid_confirmed_at },
  });
  assert.equal(walletUpdates.length, 1);
  assert.equal(Number(walletUpdates[0].data.total_cash_wallet.toString()), 0);
  assert.equal(cashWalletEntries.length, 1);
  assert.equal(cashWalletEntries[0].transaction_type, 2);
  assert.equal(cashWalletEntries[0].transaction_amount, 1000);
  assert.equal(confirmedPlans.length, 1);
  assert.equal(confirmedPlans[0].status, 1);
  assert.equal(accountEntries.length, 1);
  assert.equal(accountEntries[0].total_received_amount, 1000);
  assert.equal(quotationUpdates[0].data.quotation_status, 1);
});
