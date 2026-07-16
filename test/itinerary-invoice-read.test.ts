import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryInvoiceReadService } from '../src/modules/itineraries/services/itinerary-invoice-read.service';

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
