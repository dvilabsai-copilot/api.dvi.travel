import assert from 'node:assert/strict';
import test from 'node:test';
import { AxisRoomsBookingPushService } from '../src/modules/itineraries/services/axisrooms-booking-push.service';

test('AxisRooms hold notification uses confirmed status with paymentStatus zero and does not persist as paid booking', async () => {
  let sentPayload: Record<string, any> | null = null;
  let persistCalls = 0;
  const prisma: any = {
    dvi_hotel: { findFirst: async () => ({ hotel_id: 123, axisrooms_property_id: 'AX-123' }) },
    axisrooms_hotel_booking_confirmation: { create: async () => { persistCalls += 1; } },
  };
  const service = new AxisRoomsBookingPushService(prisma);
  (service as any).pushBookingNotification = async (payload: Record<string, any>) => {
    sentPayload = payload;
    return { success: true, message: 'accepted', response: { status: 'success' } };
  };

  const result = await service.pushForHotelSelection({
    bookingStatus: 'confirmed',
    confirmedItineraryPlanId: 12029,
    itineraryPlanId: 12029,
    confirmationNo: 'DVI-HOLD-12029-9001-AX123',
    persistConfirmation: false,
    hotel: {
      routeId: 9001,
      routeIds: [9001],
      hotelCode: 'AX-123',
      bookingCode: 'AX-RATE-1',
      checkInDate: '2027-01-10',
      checkOutDate: '2027-01-11',
      numberOfRooms: 1,
      netAmount: 5000,
      occupancies: [{ adults: 2, children: 1 }],
      passengers: [{ firstName: 'Lead Guest', leadPassenger: true }],
    },
  });

  assert.equal(result.success, true);
  assert.equal((sentPayload as any)?.bookingStatus, 'confirmed');
  assert.equal((sentPayload as any)?.paymentStatus, 0);
  assert.equal((sentPayload as any)?.confirmationNo, 'DVI-HOLD-12029-9001-AX123');
  assert.equal(persistCalls, 0);
});
