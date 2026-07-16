// FILE: src/modules/itineraries/services/itinerary-confirmed-itinerary-details.service.ts

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';

type ConfirmedItineraryDetailsCallbacks = Record<string, (...args: any[]) => any>;

@Injectable()
export class ItineraryConfirmedItineraryDetailsService {
  private callbacks: ConfirmedItineraryDetailsCallbacks = {};

  constructor(private readonly prisma: PrismaService) {}

  setCallbacks(callbacks: ConfirmedItineraryDetailsCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public async getConfirmedItineraryDetails(confirmedPlanId: number) {
    console.log('🔍 getConfirmedItineraryDetails called with confirmedPlanId:', confirmedPlanId);
    console.log('   this.prisma exists?', !!this.prisma);
    
    if (!this.prisma) {
      throw new Error('PrismaService not initialized in ItinerariesService');
    }

    // Get the confirmed plan
    const plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findUnique({
      where: { confirmed_itinerary_plan_ID: confirmedPlanId },
    });

    if (!plan) {
      throw new NotFoundException('Confirmed itinerary not found');
    }

    // Get the original itinerary plan details separately (no relation in schema)
    const originalPlan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: plan.itinerary_plan_ID },
    });

    if (!originalPlan) {
      throw new NotFoundException('Original itinerary plan not found');
    }

    console.log('   ✅ Found confirmed plan and original plan');

    const routes = await this.prisma.dvi_itinerary_route_details.findMany({
      where: {
        itinerary_plan_ID: plan.itinerary_plan_ID,
        deleted: 0,
      },
      orderBy: [
        { no_of_days: 'asc' },
        { itinerary_route_date: 'asc' },
        { itinerary_route_ID: 'asc' },
      ],
    });

    console.log('   📍 Found', routes.length, 'routes');

    const guideAssignments = await this.callbacks.listConfirmedGuideAssignments(confirmedPlanId);

    const confirmedHotels = await this.prisma.dvi_confirmed_itinerary_plan_hotel_details.findMany({
      where: {
        itinerary_plan_id: plan.itinerary_plan_ID,
        deleted: 0,
      },
      orderBy: [
        { itinerary_route_id: 'asc' },
        { confirmed_itinerary_plan_hotel_details_ID: 'desc' },
      ],
    });

    const confirmedHotelRooms = await this.prisma.dvi_confirmed_itinerary_plan_hotel_room_details.findMany({
      where: {
        itinerary_plan_id: plan.itinerary_plan_ID,
        deleted: 0,
      },
      orderBy: { confirmed_itinerary_plan_hotel_room_details_ID: 'desc' },
    });

    const confirmedHotelVouchers = await this.prisma.dvi_confirmed_itinerary_plan_hotel_voucher_details.findMany({
      where: {
        itinerary_plan_id: plan.itinerary_plan_ID,
        deleted: 0,
      },
      orderBy: { cnf_itinerary_plan_hotel_voucher_details_ID: 'desc' },
    });

    const cancelledVoucherByHotelDetailsId = new Map<number, boolean>();
    confirmedHotelVouchers.forEach((voucher: any) => {
      const hotelDetailsId = Number(voucher?.itinerary_plan_hotel_details_ID || 0);
      if (!hotelDetailsId || cancelledVoucherByHotelDetailsId.has(hotelDetailsId)) {
        return;
      }

      const isCancelled =
        Number(voucher?.hotel_voucher_cancellation_status || 0) === 1 ||
        Number(voucher?.hotel_booking_status || 0) === 2;

      cancelledVoucherByHotelDetailsId.set(hotelDetailsId, isCancelled);
    });

    const roomTypeIds = Array.from(
      new Set(
        confirmedHotelRooms
          .map((row) => Number(row.room_type_id || 0))
          .filter((id) => id > 0),
      ),
    );
    const roomTypeRows = roomTypeIds.length
      ? await this.prisma.dvi_hotel_roomtype.findMany({
          where: {
            room_type_id: { in: roomTypeIds },
            deleted: 0,
          },
          select: {
            room_type_id: true,
            room_type_title: true,
          },
        })
      : [];
    const roomTypeMap = new Map<number, string>();
    roomTypeRows.forEach((row) => {
      roomTypeMap.set(Number(row.room_type_id || 0), String(row.room_type_title || '').trim());
    });

    const hotelIds = Array.from(
      new Set(
        confirmedHotels
          .map((row) => Number(row.hotel_id || 0))
          .filter((id) => id > 0),
      ),
    );
    const hotelCodes = Array.from(
      new Set(
        confirmedHotels
          .map((row) => String(row.hotel_code || '').trim())
          .filter(Boolean),
      ),
    );
    const hotelMasters = hotelIds.length || hotelCodes.length
      ? await this.prisma.dvi_hotel.findMany({
          where: {
            OR: [
              ...(hotelIds.length ? [{ hotel_id: { in: hotelIds } }] : []),
              ...(hotelCodes.length ? [{ tbo_hotel_code: { in: hotelCodes } }] : []),
              ...(hotelCodes.length ? [{ resavenue_hotel_code: { in: hotelCodes } }] : []),
              ...(hotelCodes.length ? [{ hotel_code: { in: hotelCodes } }] : []),
            ],
          },
          select: {
            hotel_id: true,
            hotel_name: true,
            hotel_address: true,
            hotel_city: true,
            hotel_category: true,
            tbo_hotel_code: true,
            resavenue_hotel_code: true,
            hotel_code: true,
          },
        })
      : [];

    const hotelMasterById = new Map<number, any>();
    const hotelMasterByProviderCode = new Map<string, any>();
    hotelMasters.forEach((hotel) => {
      const hotelId = Number((hotel as any).hotel_id || 0);
      if (hotelId > 0) hotelMasterById.set(hotelId, hotel);

      const tboCode = String((hotel as any).tbo_hotel_code || '').trim();
      const resavenueCode = String((hotel as any).resavenue_hotel_code || '').trim();
      const hobseCode = String((hotel as any).hotel_code || '').trim();
      if (tboCode) hotelMasterByProviderCode.set(`tbo|${tboCode}`, hotel);
      if (resavenueCode) hotelMasterByProviderCode.set(`resavenue|${resavenueCode}`, hotel);
      if (hobseCode) {
        hotelMasterByProviderCode.set(`hobse|${hobseCode}`, hotel);
        hotelMasterByProviderCode.set(`axisrooms|${hobseCode}`, hotel);
        hotelMasterByProviderCode.set(`staah|${hobseCode}`, hotel);
      }
    });

    const tboHotelCodes = confirmedHotels
      .map((row: any) => String(row?.hotel_code || '').trim())
      .filter(Boolean);
    const legacyNumericTboCodes = confirmedHotels
      .filter((row: any) => !String(row?.hotel_code || '').trim())
      .map((row: any) => String(row?.hotel_id || '').trim())
      .filter((code: string) => /^\d+$/.test(code) && code !== '0');
    const allTboHotelCodes = Array.from(new Set([...tboHotelCodes, ...legacyNumericTboCodes]));
    const tboMasters = allTboHotelCodes.length
      ? await this.prisma.tbo_hotel_master.findMany({
          where: {
            tbo_hotel_code: { in: allTboHotelCodes },
          },
          select: {
            tbo_hotel_code: true,
            hotel_name: true,
            city_name: true,
            star_rating: true,
          },
        })
      : [];
    const tboMasterByCode = new Map(
      tboMasters.map((row: any) => [
        String(row.tbo_hotel_code || '').trim(),
        row,
      ]),
    );

    const tboRows = await this.prisma.tbo_hotel_booking_confirmation.findMany({
      where: {
        confirmed_itinerary_plan_ID: confirmedPlanId,
        status: 1,
        deleted: 0,
      },
      orderBy: { tbo_hotel_booking_confirmation_ID: 'desc' },
    });
    const resavenueRows = await this.prisma.resavenue_hotel_booking_confirmation.findMany({
      where: {
        confirmed_itinerary_plan_ID: confirmedPlanId,
        status: 1,
        deleted: 0,
      },
      orderBy: { resavenue_hotel_booking_confirmation_ID: 'desc' },
    });
    const axisroomsRows = await (this.prisma as any).axisrooms_hotel_booking_confirmation.findMany({
      where: {
        confirmed_itinerary_plan_ID: confirmedPlanId,
        status: 1,
        deleted: 0,
      },
      orderBy: { axisrooms_hotel_booking_confirmation_ID: 'desc' },
    });
    const staahRows = await (this.prisma as any).staah_hotel_booking_confirmation.findMany({
      where: {
        confirmed_itinerary_plan_ID: confirmedPlanId,
        status: 1,
        deleted: 0,
      },
      orderBy: { staah_hotel_booking_confirmation_ID: 'desc' },
    });
    const hobseRows = await (this.prisma as any).hobse_hotel_booking_confirmation.findMany({
      where: {
        plan_id: plan.itinerary_plan_ID,
        booking_status: 'confirmed',
      },
      orderBy: { hobse_hotel_booking_confirmation_ID: 'desc' },
    });

    const providerBookingByRoute = new Map<number, any>();
    const setProviderBooking = (routeId: number, payload: any) => {
      if (routeId > 0 && !providerBookingByRoute.has(routeId)) {
        providerBookingByRoute.set(routeId, payload);
      }
    };

    tboRows.forEach((row: any) => setProviderBooking(Number(row.itinerary_route_ID || 0), {
      provider: 'tbo',
      hotelCode: String(row.tbo_hotel_code || '').trim(),
      bookingCode: String(row.booking_code || '').trim(),
      hotelName:
        String(
          row?.api_response?.HotelName ||
          row?.api_response?.hotel_name ||
          row?.api_response?.HotelDetails?.HotelName ||
          '',
        ).trim() || null,
      checkInDate: row.check_in_date,
      checkOutDate: row.check_out_date,
      netAmount: Number(row.net_amount || row.booked_amount || 0),
      roomType: String(
        row?.api_response?.HotelRoomsDetails?.[0]?.RoomTypeName ||
        row?.api_response?.HotelRoomsDetails?.[0]?.RoomName ||
        '',
      ).trim() || null,
    }));
    resavenueRows.forEach((row: any) => setProviderBooking(Number(row.itinerary_route_ID || 0), {
      provider: 'resavenue',
      hotelCode: String(row.resavenue_hotel_code || '').trim(),
      bookingCode: String(row.booking_code || '').trim(),
      hotelName: null,
      checkInDate: row.check_in_date,
      checkOutDate: row.check_out_date,
      netAmount: Number(row.net_amount || 0),
      roomType: null,
    }));
    axisroomsRows.forEach((row: any) => setProviderBooking(Number(row.itinerary_route_ID || 0), {
      provider: 'axisrooms',
      hotelCode: String(row.axisrooms_hotel_code || '').trim(),
      bookingCode: String(row.booking_code || '').trim(),
      hotelName: null,
      checkInDate: row.check_in_date,
      checkOutDate: row.check_out_date,
      netAmount: Number(row.net_amount || 0),
      roomType: null,
    }));
    staahRows.forEach((row: any) => setProviderBooking(Number(row.itinerary_route_ID || 0), {
      provider: 'staah',
      hotelCode: String(row.staah_hotel_code || '').trim(),
      bookingCode: String(row.booking_code || '').trim(),
      searchReference: String(row.booking_code || '').trim() || undefined,
      roomId:
        String(row.booking_code || '').trim().startsWith('STAAH-')
          ? String(row.booking_code || '').trim().split('-')[2] || undefined
          : undefined,
      rateId:
        String(row.booking_code || '').trim().startsWith('STAAH-')
          ? String(row.booking_code || '').trim().split('-')[3] || undefined
          : undefined,
      hotelName: String(
        row?.api_response?.confirm?.request?.reservations?.reservation?.[0]?.propertyname || '',
      ).trim() || null,
      checkInDate: row.check_in_date,
      checkOutDate: row.check_out_date,
      netAmount: Number(row.net_amount || 0),
      roomType: String(
        row?.api_response?.confirm?.request?.reservations?.reservation?.[0]?.room?.[0]?.room_name || '',
      ).trim() || null,
    }));
    hobseRows.forEach((row: any) => setProviderBooking(Number(row.route_id || 0), {
      provider: 'hobse',
      hotelCode: String(row.hotel_code || '').trim(),
      bookingCode: String(row.booking_id || '').trim(),
      hotelName: null,
      checkInDate: row.check_in_date,
      checkOutDate: row.check_out_date,
      netAmount: Number(row.total_amount || 0),
      roomType: null,
    }));

    const deriveMealPlan = (room: any): string => {
      const breakfast = Number(room?.breakfast_required || 0) > 0;
      const lunch = Number(room?.lunch_required || 0) > 0;
      const dinner = Number(room?.dinner_required || 0) > 0;
      if (breakfast && lunch && dinner) return 'AP';
      if ((breakfast && lunch) || (breakfast && dinner) || (lunch && dinner)) return 'MAP';
      if (breakfast) return 'CP';
      return 'EP';
    };

    const formatDateLabel = (value: Date | string | null | undefined): string => {
      if (!value) return '';
      const dt = new Date(value);
      if (Number.isNaN(dt.getTime())) return '';
      return dt.toISOString().split('T')[0];
    };

    const confirmedBookedGroupType =
      Number(
        confirmedHotels.find((hotel: any) => Number(hotel?.group_type || 0) > 0)
          ?.group_type || 0,
      ) || 1;

    const hotelRows = routes.flatMap((route, index) => {
      const routeId = Number(route.itinerary_route_ID || 0);
      const dayNumber = Number(route.no_of_days || index + 1);
      const destination = route.next_visiting_location || route.location_name || '';
      const providerBooking = providerBookingByRoute.get(routeId);
      const routeConfirmedHotels = confirmedHotels.filter(
        (hotel) => Number(hotel.itinerary_route_id || 0) === routeId,
      );
      const matchedConfirmedHotel =
        routeConfirmedHotels.find((hotel) => {
          if (!providerBooking) return false;
          const hotelCode = String((hotel as any).hotel_code || '').trim();
          const bookingHotelCode = String(providerBooking.hotelCode || '').trim();
          if (hotelCode && bookingHotelCode && hotelCode === bookingHotelCode) return true;
          const hotelId = Number((hotel as any).hotel_id || 0);
          const providerHotelId = Number(providerBooking.hotelId || 0);
          return hotelId > 0 && providerHotelId > 0 && hotelId === providerHotelId;
        }) || routeConfirmedHotels[0];

      if (!matchedConfirmedHotel && !providerBooking) {
        return [];
      }

      const matchedRoom = confirmedHotelRooms.find(
        (room) => Number(room.itinerary_route_id || 0) === routeId,
      );
      const provider = String(providerBooking?.provider || 'tbo').trim().toLowerCase();
      const persistedHotelCode = String((matchedConfirmedHotel as any)?.hotel_code || '').trim();
      const fallbackHotelCode = String((matchedConfirmedHotel as any)?.hotel_id || '').trim();
      const hotelCode = String(providerBooking?.hotelCode || persistedHotelCode || fallbackHotelCode || '').trim();
      const tboMaster = tboMasterByCode.get(hotelCode);
      const hotelMaster =
        hotelMasterByProviderCode.get(`${provider}|${hotelCode}`) ||
        hotelMasterById.get(Number((matchedConfirmedHotel as any)?.hotel_id || 0));
      const resolvedHotelName = String(
        providerBooking?.hotelName ||
        (matchedConfirmedHotel as any)?.hotel_name ||
        (matchedConfirmedHotel as any)?.hotelName ||
        (hotelMaster as any)?.hotel_name ||
        (tboMaster as any)?.hotel_name ||
        '',
      ).trim();

      if (!resolvedHotelName) {
        console.warn('[CONFIRMED_HOTEL_NAME_MISSING]', {
          quoteId: String(originalPlan?.itinerary_quote_ID || ''),
          routeId,
          provider,
          hotelCode,
          hotelId: Number((matchedConfirmedHotel as any)?.hotel_id || 0),
          destination,
        });
      }

      const roomType = String(
        providerBooking?.roomType ||
        roomTypeMap.get(Number((matchedRoom as any)?.room_type_id || 0)) ||
        '',
      ).trim() || 'Standard';
      const mealPlan = matchedRoom ? deriveMealPlan(matchedRoom) : 'EP';
      const providerAmount = Number(providerBooking?.netAmount || 0);
      const confirmedAmount = Number((matchedConfirmedHotel as any)?.total_hotel_cost || 0);
      const confirmedTaxAmount = Number((matchedConfirmedHotel as any)?.total_hotel_tax_amount || 0);
      const totalHotelCost = confirmedAmount > 0 ? confirmedAmount : providerAmount;

      if (
        providerAmount > 0 &&
        confirmedAmount > 0 &&
        Math.abs(providerAmount - confirmedAmount) > 1
      ) {
        console.warn('[CONFIRMED_HOTEL_AMOUNT_MISMATCH_USING_CONFIRMED_DB_AMOUNT]', {
          confirmedPlanId,
          routeId,
          provider,
          hotelCode,
          providerAmount,
          confirmedAmount,
          usedAmount: totalHotelCost,
        });
      }
      const confirmedCategory = Number((matchedConfirmedHotel as any)?.hotel_category_id || 0);
      const hotelMasterCategory = Number((hotelMaster as any)?.hotel_category || 0);
      const tboStarRating = Number((tboMaster as any)?.star_rating || 0);
      const category = confirmedCategory > 0
        ? confirmedCategory
        : (tboStarRating > 0 ? tboStarRating : hotelMasterCategory);

      const originalHotelDetailsId = Number(
        (matchedConfirmedHotel as any)?.itinerary_plan_hotel_details_ID || 0,
      );

      const confirmedHotelDetailsId = Number(
        (matchedConfirmedHotel as any)?.confirmed_itinerary_plan_hotel_details_ID || 0,
      );

      const voucherCancelled =
        Number((matchedConfirmedHotel as any)?.hotel_cancellation_status || 0) === 1 ||
        cancelledVoucherByHotelDetailsId.get(originalHotelDetailsId) === true;

      const hotelDetailsIds = originalHotelDetailsId > 0
        ? [originalHotelDetailsId]
        : [];

      return [{
        groupType: confirmedBookedGroupType,
        itineraryRouteId: routeId,
        day: `Day ${dayNumber} | ${formatDateLabel(route.itinerary_route_date)}`,
        destination,

        hotelId: Number((matchedConfirmedHotel as any)?.hotel_id || 0),
        hotelCode,
        hotelName: resolvedHotelName || 'Booked hotel name missing',
        category,
        roomType,
        mealPlan,
        totalHotelCost,
        totalHotelTaxAmount: confirmedTaxAmount,
        noOfRooms: Number(providerBooking?.numberOfRooms || (matchedConfirmedHotel as any)?.total_no_of_rooms || 1),
        provider,
        bookingCode: String(providerBooking?.bookingCode || '').trim() || undefined,
        checkInDate: formatDateLabel(providerBooking?.checkInDate || route.itinerary_route_date),
        checkOutDate: formatDateLabel(providerBooking?.checkOutDate),
        searchReference:
          String(providerBooking?.searchReference || providerBooking?.bookingCode || '').trim() || undefined,
        roomId: String(providerBooking?.roomId || '').trim() || undefined,
        rateId: String(providerBooking?.rateId || '').trim() || undefined,

        itineraryPlanHotelDetailsId: originalHotelDetailsId,
        confirmedItineraryPlanHotelDetailsId: confirmedHotelDetailsId,
        hotelDetailsIds,

        voucherCancelled,
        canCancelVoucher: !voucherCancelled && (originalHotelDetailsId > 0 || routeId > 0),

        date: formatDateLabel(providerBooking?.checkInDate || route.itinerary_route_date),
        isBookable: true,
        externalStay: false,
        availabilityStatus: 'AVAILABLE',
        availabilityMessage: null,
      }];
    });

    console.log('[CONFIRMED_HOTELS_RETURNED]', hotelRows.map((h: any) => ({
      routeId: h.itineraryRouteId,
      provider: h.provider,
      hotelCode: h.hotelCode,
      hotelName: h.hotelName,
      category: h.category,
      roomType: h.roomType,
      amount: Number(h.totalHotelCost || 0) + Number(h.totalHotelTaxAmount || 0),
    })));

    const totalAmount = hotelRows.reduce(
      (sum, hotel) => sum + Number(hotel.totalHotelCost || 0) + Number(hotel.totalHotelTaxAmount || 0),
      0,
    );

    return {
      quoteId: String(originalPlan.itinerary_quote_ID || ''),
      planId: Number(originalPlan.itinerary_plan_ID || 0),
      hotelRatesVisible: Number((originalPlan as any)?.hotel_rates_visibility || 0) === 1,
      showHotelMargins: false,
      hotelTabs: [
        {
          groupType: confirmedBookedGroupType,
          label: 'Booked Hotels',
          totalAmount,
        },
      ],
      hotels: hotelRows,
      hotelAvailability: {
        hasSupplierHotels: hotelRows.length > 0,
        supplierHotelCount: hotelRows.length,
        placeholderRowCount: 0,
        totalSearchRoutes: routes.length,
        emptySearchRoutes: Math.max(routes.length - hotelRows.length, 0),
        isPlaceholderOnly: false,
        message: hotelRows.length > 0
          ? 'Showing confirmed booked hotels for this itinerary.'
          : 'No confirmed supplier hotel rows were found for this itinerary.',
      },
      plan: {
        itinerary_plan_ID: originalPlan.itinerary_plan_ID,
        confirmed_itinerary_plan_ID: confirmedPlanId,
      },
      guideAssignments,
    };
  }

  /**
   * Map hotel group type to category name
   */
}

