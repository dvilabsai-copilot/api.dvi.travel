import { Injectable } from '@nestjs/common';
import type { ItineraryHotelRowDto } from '../itinerary-hotel-details.service';

export interface StaahConfirmedOverrideCallbacks {
  parseSearchReference: (reference: any) => { propertyId: string; roomId: string; rateId: string } | null;
  log?: (message: string) => void;
  debug?: (value: unknown) => void;
}

/** Applies the latest confirmed STAAH booking values to matching hotel response rows. */
@Injectable()
export class StaahConfirmedBookingOverrideService {
  apply(
    hotelRows: ItineraryHotelRowDto[],
    confirmedByRouteId: Map<number, any>,
    quoteId: string,
    planId: number,
    callbacks: StaahConfirmedOverrideCallbacks,
  ): void {
    for (let i = 0; i < hotelRows.length; i++) {
      const row: any = hotelRows[i];
      const routeId = Number(row?.itineraryRouteId || 0);
      const confirmedRow = confirmedByRouteId.get(routeId);
      if (!confirmedRow) {
        callbacks.debug?.({ routeId, hotelId: row.hotelId, status: 'override_missed' });
        continue;
      }

      const apiResponse: any = confirmedRow.api_response || {};
      const isVoucherCancelled = !!apiResponse?.cancellation;
      const reservation: any = apiResponse?.confirm?.request?.reservations?.reservation?.[0] || {};
      const reservationRoom: any = reservation?.room?.[0] || {};
      const reservationPrice: any = reservationRoom?.price?.[0] || {};
      const hotelCodeNum = Number(confirmedRow.staah_hotel_code || 0);
      const safeCheckIn = confirmedRow.check_in_date
        ? new Date(confirmedRow.check_in_date).toISOString().split('T')[0]
        : row.date;
      const confirmedBookingCode = String(confirmedRow.booking_code || '').trim();
      const confirmedSearchReference = confirmedBookingCode.startsWith('STAAH-') ? confirmedBookingCode : '';
      const confirmedReferenceParts = callbacks.parseSearchReference(confirmedSearchReference);

      hotelRows[i] = {
        ...row,
        provider: 'staah',
        itineraryRouteId: routeId,
        hotelId: Number.isFinite(hotelCodeNum) ? hotelCodeNum : 0,
        hotelName: String(reservation?.propertyname || 'STAAH Hotel'),
        roomType: String(reservationRoom?.room_name || ''),
        mealPlan: String(reservationPrice?.rate_name || ''),
        totalHotelCost: Number(confirmedRow.net_amount || 0),
        totalHotelTaxAmount: Number(reservation?.totaltax || 0),
        bookingCode: confirmedBookingCode || undefined,
        searchReference: confirmedSearchReference || undefined,
        roomId: confirmedReferenceParts?.roomId || undefined,
        rateId: confirmedReferenceParts?.rateId || undefined,
        voucherCancelled: isVoucherCancelled,
        voucherStatus: isVoucherCancelled ? 'cancelled' : 'active',
        itineraryPlanHotelDetailsId: 0,
        date: safeCheckIn,
        checkInDate: confirmedRow.check_in_date || undefined,
        checkOutDate: confirmedRow.check_out_date || undefined,
        numberOfRooms: Number(confirmedRow.number_of_rooms || 0),
        guestNationality: String(confirmedRow.guest_nationality || ''),
        totalGuests: Number(confirmedRow.total_guests || 0),
        isConfirmedBooking: true,
        voucherAvailable: true,
      } as any;

      callbacks.log?.(
        `[HOTEL_DETAILS_CONFIRMED_STAAH_OVERRIDE] quoteId=${quoteId} planId=${planId} routeId=${routeId} staahHotelCode=${String(confirmedRow.staah_hotel_code || '')} bookingReference=${String(confirmedRow.staah_booking_reference || '')}`,
      );
      callbacks.debug?.({ routeId, staahHotelCode: confirmedRow.staah_hotel_code, voucherCancelled: isVoucherCancelled });
    }
  }
}
