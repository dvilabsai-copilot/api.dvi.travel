import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryInvoiceReadService } from '../src/modules/itineraries/services/itinerary-invoice-read.service';

test('invoice reads missing hotel destinations from itinerary routes and preserves saved text and supplier identity', async () => {
  const hotels = ['offline', 'offline', 'tbo'].map((provider, index) => ({
    hotel_id: 0, hotel_provider: provider, hotel_code: '280',
    itinerary_route_date: new Date(2026, 10, 26 + index, 12),
    itinerary_route_id: index + 10,
    itinerary_route_location: [null, '3915', 'Pondicherry'][index],
    total_hotel_cost: index < 2 ? 12285 : 1000,
  }));
  const missing = { findFirst: async () => null };
  const empty = { findMany: async () => [] };
  const service = new ItineraryInvoiceReadService({
    dvi_confirmed_itinerary_plan_details: { findFirst: async () => ({
      itinerary_quote_ID: 'DVD2026117', agent_id: 0,
    }) },
    dvi_agent: { findUnique: async () => null },
    dvi_agent_configuration: missing,
    dvi_confirmed_itinerary_customer_details: missing,
    dvi_global_settings: missing,
    dvi_accounts_itinerary_details: missing,
    dvi_confirmed_itinerary_plan_hotel_details: { findMany: async () => hotels },
    dvi_itinerary_route_details: { findMany: async ({ where }: any) => {
      assert.deepEqual(where, { itinerary_plan_ID: 12268, itinerary_route_ID: { in: [10, 11] }, deleted: 0 });
      return [
        { itinerary_route_ID: 10, next_visiting_location: 'Mahabalipuram', location_name: 'Chennai' },
        { itinerary_route_ID: 11, next_visiting_location: null, location_name: 'Mahabalipuram' },
      ];
    } },
    dvi_confirmed_itinerary_plan_vendor_eligible_list: empty,
    dvi_accounts_itinerary_activity_details: empty,
    dvi_accounts_itinerary_guide_details: empty,
    dvi_accounts_itinerary_hotspot_details: empty,
    dvi_hotel: { findMany: async ({ where }: any) => {
      assert.deepEqual(where.hotel_id.in, [280]);
      return [{ hotel_id: 280, hotel_name: 'GRAND BAY RESORT AND SPA' }];
    } },
  } as any);

  const invoice = await service.getInvoiceData(12268);
  const hotelCharges = invoice.lineItems.find((item) => item.key === 'hotel_base');
  assert.deepEqual(hotelCharges?.notes, [
    { label: '26 Nov 2026 - Mahabalipuram - GRAND BAY RESORT AND SPA' },
    { label: '27 Nov 2026 - Mahabalipuram - GRAND BAY RESORT AND SPA' },
    { label: '28 Nov 2026 - Pondicherry - Hotel' },
  ]);
  assert.equal(hotelCharges?.amount, 25570);
  assert.equal(invoice.totals.totalAmount, 25570);
});

test('rejects a pluck-card request when the confirmed plan is missing', async () => {
  const service = new ItineraryInvoiceReadService({
    dvi_confirmed_itinerary_plan_details: { findFirst: async () => null },
    dvi_confirmed_itinerary_customer_details: { findFirst: async () => null },
    dvi_global_settings: { findFirst: async () => null },
  } as any);

  await assert.rejects(
    service.getPluckCardData(42),
    (error: any) => error?.message === 'Confirmed itinerary plan not found',
  );
});

test('projects pluck-card customer and company presentation fields', async () => {
  const service = new ItineraryInvoiceReadService({
    dvi_confirmed_itinerary_plan_details: {
      findFirst: async () => ({
        itinerary_plan_ID: 42,
        arrival_location: 'COK',
        departure_location: 'TRV',
        trip_start_date_and_time: '2026-07-20T10:00:00.000Z',
        trip_end_date_and_time: '2026-07-25T10:00:00.000Z',
      }),
    },
    dvi_confirmed_itinerary_customer_details: {
      findFirst: async () => ({
        customer_salutation: 'Ms.',
        customer_name: 'Traveler',
        primary_contact_no: '9999999999',
        arrival_place: 'COK Airport',
        departure_place: 'TRV Airport',
        arrival_flight_details: 'AI 101',
        departure_flight_details: 'AI 202',
      }),
    },
    dvi_global_settings: {
      findFirst: async () => ({ company_name: 'DVI Travel', company_logo: 'logo.png' }),
    },
  } as any);

  assert.deepEqual(await service.getPluckCardData(42), {
    guestName: 'Ms. Traveler',
    contactNo: '9999999999',
    arrivalLocation: 'COK Airport',
    arrivalDateTime: '2026-07-20T10:00:00.000Z',
    arrivalFlightDetails: 'AI 101',
    departureLocation: 'TRV Airport',
    departureDateTime: '2026-07-25T10:00:00.000Z',
    departureFlightDetails: 'AI 202',
    companyName: 'DVI Travel',
    companyLogoUrl: '/uploads/logo/logo.png',
  });
});
