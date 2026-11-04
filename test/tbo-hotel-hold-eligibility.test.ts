import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import {
  isTboInsufficientBalanceResponse,
  isTboPrebookRateEligibleForHold,
} from '../src/modules/itineraries/utils/tbo-hold-eligibility.util';
import { TboHotelBookingService } from '../src/modules/itineraries/services/tbo-hotel-booking.service';

const now = new Date('2026-11-04T12:00:00+05:30');

test('recognizes only TBO status 300 insufficient balance for hold continuation', () => {
  assert.equal(isTboInsufficientBalanceResponse({ Status: { Code: 300, Description: 'Insufficient Balance' } }), true);
  assert.equal(isTboInsufficientBalanceResponse({ Status: 300, Message: 'Insufficient Balance' }), true);
  assert.equal(isTboInsufficientBalanceResponse({ Status: 300, Message: 'Booking code expired' }), false);
  assert.equal(isTboInsufficientBalanceResponse({ Status: 200, Message: 'Insufficient Balance' }), false);
});

test('requires each fresh prebook room to be refundable with a deadline meeting the India-date buffer', () => {
  const response = (rooms: unknown[]) => ({ HotelResult: [{ Rooms: rooms }] });
  const refundable = (deadline: string) => ({ IsRefundable: true, LastCancellationDeadline: deadline });

  assert.equal(isTboPrebookRateEligibleForHold(response([refundable('05-11-2026 00:00:00')]), 1, now), true);
  assert.equal(isTboPrebookRateEligibleForHold(response([refundable('04-11-2026 23:59:59')]), 1, now), false);
  assert.equal(isTboPrebookRateEligibleForHold(response([refundable('31-02-2026 23:59:59')]), 1, now), false);
  assert.equal(isTboPrebookRateEligibleForHold(response([refundable('06-11-2026 23:59:59'), { ...refundable('06-11-2026 23:59:59'), IsRefundable: false }]), 1, now), false);
  assert.equal(isTboPrebookRateEligibleForHold(response([{ IsRefundable: true }]), 1, now), false);
  assert.equal(isTboPrebookRateEligibleForHold(response([]), 1, now), false);
});

test('only the hold-specific PreBook method accepts status 300', async () => {
  const service: any = Object.create(TboHotelBookingService.prototype);
  service.USE_MOCK_TBO = false;
  service.PREBOOK_URL = 'prebook-test';
  service.logger = { log() {}, warn() {}, error() {} };
  service.validateSelection = () => undefined;
  service.client = {
    post: async () => ({
      data: {
        Status: { Code: 300, Description: 'Insufficient Balance' },
        BookingCode: 'hotel!TB!room',
        NetAmount: 1234,
        HotelResult: [{ Rooms: [{ IsRefundable: true, LastCancellationDeadline: '06-11-2026 23:59:59' }] }],
      },
    }),
  };

  const selection = { hotelCode: 'test', bookingCode: 'hotel!TB!room' };
  const result = await service.preBookHotelForHold(selection);
  assert.equal(result.Status.Code, 300);
  await assert.rejects(() => service.preBookHotel(selection), (error: unknown) => error instanceof BadRequestException);
});

test('the hold Book request uses fresh code, disables vouchers, and keeps passenger types aligned per room', async () => {
  const service: any = Object.create(TboHotelBookingService.prototype);
  service.USE_MOCK_TBO = false;
  service.logger = { log() {}, warn() {}, error() {} };
  service.validateSelection = () => undefined;
  service.authenticate = async () => 'test-token';
  let sentPayload: Record<string, unknown> | undefined;
  service.client = {
    post: async (_url: string, payload: Record<string, unknown>) => {
      sentPayload = payload;
      return { data: { BookResult: { Status: 1, ResponseStatus: 1, BookingRefNo: 'hold-reference' } } };
    },
  };

  await service.holdHotel(
    { Status: 300, BookingCode: 'fresh!TB!booking-code' },
    {
      hotelCode: 'test',
      bookingCode: 'old!TB!code',
      guestNationality: 'IN',
      numberOfRooms: 2,
      passengers: [
        { title: 'Mr', firstName: 'Lead', lastName: 'Guest', nationality: 'IN', paxType: 1, leadPassenger: true, age: 45 },
        { title: 'Ms', firstName: 'Child', lastName: 'Guest', nationality: 'IN', paxType: 2, leadPassenger: false, age: 7 },
        { title: 'Ms', firstName: 'Child', lastName: 'Guest', nationality: 'IN', paxType: 2, leadPassenger: false, age: 7 },
      ],
      occupancies: [
        { adults: 2, children: 1, childrenAges: [7] },
        { adults: 2, children: 1, childrenAges: [7] },
      ],
      netAmount: 987,
    },
    '127.0.0.1',
  );

  assert.equal(sentPayload?.BookingCode, 'fresh!TB!booking-code');
  assert.equal(sentPayload?.NetAmount, 987);
  assert.equal(sentPayload?.IsVoucherBooking, false);
  assert.deepEqual(
    (sentPayload?.HotelRoomsDetails as Array<{ HotelPassenger: Array<{ PaxType: number }> }>)
      .map((room) => room.HotelPassenger.map((passenger) => passenger.PaxType)),
    [[1, 1, 2], [1, 1, 2]],
  );
  assert.throws(
    () => service.mapPassengersToRooms(
      [{ title: 'Ms', firstName: 'Child', lastName: 'Guest', nationality: 'IN', paxType: 2, leadPassenger: true, age: 7 }],
      1,
      [{ adults: 1, children: 1, childrenAges: [7] }],
    ),
    /Passenger details do not match TBO room occupancy for room 1/,
  );
});

test('TBO PreBook and Book payloads default a missing child age to 5', () => {
  const service: any = Object.create(TboHotelBookingService.prototype);
  const selection = {
    numberOfRooms: 1,
    passengers: [
      { title: 'Mr', firstName: 'Lead', lastName: 'Guest', nationality: 'IN', paxType: 1, leadPassenger: true, age: 45 },
      { title: 'Ms', firstName: 'Child', lastName: 'Guest', nationality: 'IN', paxType: 2, leadPassenger: false },
    ],
    occupancies: [{ adults: 1, children: 1, childrenAges: [] }],
  };

  assert.deepEqual(service.buildPaxRooms(selection), [
    { Adults: 1, Children: 1, ChildrenAges: [5] },
  ]);
  assert.equal(service.mapPassengersToRooms(selection.passengers, 1, [
    { adults: 1, children: 1, childrenAges: [5] },
  ])[0].HotelPassenger[1].Age, 5);
});
