import assert from 'node:assert/strict';
import test from 'node:test';
import { TBOHotelProvider } from '../src/modules/hotels/providers/tbo-hotel.provider';

const cancelledBooking = {
  ResponseStatus: 1,
  Status: 6,
  BookingStatus: 3,
  HotelBookingStatus: 'Cancelled',
  VoucherStatus: false,
};

const getProvider = (post: (url: string, data: Record<string, unknown>) => Promise<unknown>): TBOHotelProvider =>
  Object.assign(Object.create(TBOHotelProvider.prototype), {
    BOOKING_DETAIL_URL: 'https://tbo.test/Getbookingdetail/',
    CANCELLATION_URL: 'https://tbo.test/SendChangeRequest/',
    authenticate: async () => 'test-token',
    logger: { log() {}, debug() {}, warn() {}, error() {} },
    http: { post },
  });

test('TBO booking details distinguish a successful cancelled booking from a failed request', async () => {
  let responseStatus = 1;
  const provider = getProvider(async (url, request) => {
    assert.equal(url, 'https://tbo.test/Getbookingdetail/');
    assert.equal(request.BookingRefId, 'test-ref');
    return { data: { GetBookingDetailResult: { ...cancelledBooking, ResponseStatus: responseStatus } } };
  });

  assert.equal((await provider.getConfirmation('test-ref')).status, 'Cancelled');
  responseStatus = 2;
  await assert.rejects(provider.getConfirmation('test-ref'), /Failed to get confirmation details/);
});

test('TBO cancellation recovery uses BookingId and requires a final supplier status', async () => {
  let status = cancelledBooking;
  const calls: string[] = [];
  const provider = getProvider(async (url, request) => {
    assert.equal(request.BookingId, 1234);
    assert.equal(request.BookingRefId, undefined);
    calls.push(url);
    if (url.endsWith('/SendChangeRequest/')) {
      return { data: { HotelChangeRequestResult: { ResponseStatus: 2, ChangeRequestId: 5678 } } };
    }
    return { data: { GetBookingDetailResult: status } };
  });

  assert.equal((await provider.cancelBooking('1234', 'test')).cancellationRef, '5678');
  assert.deepEqual(calls, ['https://tbo.test/SendChangeRequest/', 'https://tbo.test/Getbookingdetail/']);

  status = { ...cancelledBooking, Status: 1, HotelBookingStatus: 'CancellationInProgress' };
  await assert.rejects(provider.cancelBooking('1234', 'test'), /Failed to cancel booking/);
});

test('a successful VSR change request does not confirm cancellation while the booking remains active', async () => {
  let supplierStatus = 'CancellationInProgress';
  const provider = getProvider(async (url, request) => {
    assert.equal(request.BookingId, 1234);
    if (url.endsWith('/SendChangeRequest/')) {
      return { data: { HotelChangeRequestResult: { ResponseStatus: 1, ChangeRequestId: 5678 } } };
    }
    return { data: { GetBookingDetailResult: { ResponseStatus: 1, HotelBookingStatus: supplierStatus } } };
  });

  await assert.rejects(provider.cancelBooking('1234', 'test'), /VSR did not confirm cancellation/);
  supplierStatus = 'Cancelled';
  assert.equal((await provider.cancelBooking('1234', 'test')).cancellationRef, '5678');
  await assert.rejects(provider.cancelBooking('1234wrong', 'test'), /valid VSR booking ID/);
});
