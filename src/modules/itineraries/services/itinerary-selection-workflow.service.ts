// FILE: src/modules/itineraries/services/itinerary-selection-workflow.service.ts

import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { RouteEngineService } from '../engines/route-engine.service';
import { ItineraryVehiclesEngine } from '../engines/itinerary-vehicles.engine';
import { ItineraryHotelDetailsTboService } from '../itinerary-hotel-details-tbo.service';
import { OfflineHotelCatalogService } from './offline-hotel-catalog.service';
import { filterActiveVendorCandidateRows } from '../utils/active-vendor-candidate.util';
import { getVehicleRateAvailability } from '../utils/vehicle-rate-availability.util';
import { hotelSelectionKey, hotelSelectionKeyFromRow } from '../utils/hotel-selection-identity.util';

@Injectable()
export class ItinerarySelectionWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly routeEngine: RouteEngineService,
    private readonly itineraryVehiclesEngine: ItineraryVehiclesEngine,
    private readonly hotelDetailsTboService: ItineraryHotelDetailsTboService,
    private readonly offlineHotelCatalogService?: OfflineHotelCatalogService,
  ) {}

  async getAvailableHotels(routeId: number) {
 // Get route details
    const route = await (this.prisma as any).dvi_itinerary_route_details.findFirst({
      where: { itinerary_route_ID: routeId },
    });

    if (!route || !route.location_id) {
      return [];
    }

 // Get location coordinates separately
    const location = await (this.prisma as any).dvi_stored_locations.findFirst({
      where: { location_ID: Number(route.location_id) },
      select: {
        destination_location_lattitude: true,
        destination_location_longitude: true,
      },
    });

    if (!location || !location.destination_location_lattitude || !location.destination_location_longitude) {
      return [];
    }

    const destLat = Number(location.destination_location_lattitude);
    const destLng = Number(location.destination_location_longitude);

 // Fetch hotels with Haversine distance calculation
    const hotels = await this.prisma.$queryRaw`
      SELECT
        h.hotel_id,
        h.hotel_name,
        h.hotel_address,
        h.hotel_latitude,
        h.hotel_longitude,
        h.hotel_category,
        (6371 * acos(
          cos(radians(${destLat})) *
          cos(radians(h.hotel_latitude)) *
          cos(radians(h.hotel_longitude) - radians(${destLng})) +
          sin(radians(${destLat})) *
          sin(radians(h.hotel_latitude))
        )) AS distance_in_km
      FROM dvi_hotel h
      WHERE h.status = 1
        AND h.deleted = 0
        AND h.hotel_latitude IS NOT NULL
        AND h.hotel_longitude IS NOT NULL
      HAVING distance_in_km <= 20
      ORDER BY distance_in_km ASC
      LIMIT 20
    `;

    return (hotels as any[]).map(h => ({
      id: h.hotel_id,
      name: h.hotel_name,
      address: h.hotel_address,
      category: h.hotel_category,
      distance: Number(h.distance_in_km).toFixed(2),
    }));
  }

 /**
   * Select/update hotel for a route
 */
  async selectHotel(data: {
    planId: number;
    routeId: number;
    hotelId: number;
    roomTypeId: number;
 groupType?: number; // ADD groupType parameter
    mealPlan?: { all?: boolean; breakfast?: boolean; lunch?: boolean; dinner?: boolean; };
    canonicalHotelId?: number;
    rateOptionId?: string;
    provider?: string;
    optionKey?: string;
    pricePerNight?: number;
    totalPrice?: number;
    currency?: string;
    hotelName?: string;
    category?: number;
    roomType?: string;
    mealPlanCode?: string;
    bookingCode?: string;
    searchReference?: string;
    roomId?: string | number;
    rateId?: string | number;
    roomCount?: number;
    requestedBy?: number;
  }) {
    if (String(data.provider || '').trim().toLowerCase() === 'offline' || String(data.rateOptionId || '').startsWith('offline:')) {
      return this.selectOfflineHotel(data);
    }
    const userId = 1;
    const liveRateMetadata = this.getLiveRateMetadata(data.provider);

 // Get the quote ID and Day 1 early-check-in metadata.
    const [plan, route, previousDayMarker] = await Promise.all([
      this.prisma.dvi_itinerary_plan_details.findUnique({
        where: { itinerary_plan_ID: data.planId },
      }),
      (this.prisma as any).dvi_itinerary_route_details.findFirst({
        where: {
          itinerary_plan_ID: data.planId,
          itinerary_route_ID: data.routeId,
          deleted: 0,
        },
      }),
      (this.prisma as any).dvi_itinerary_plan_hotel_details.findFirst({
        where: {
          itinerary_plan_id: data.planId,
          itinerary_route_id: data.routeId,
          group_type: data.groupType || 1,
          hotel_required: 2,
          hotel_id: 0,
          deleted: 0,
          status: 1,
        },
      }),
    ]);
    const quoteId = (plan as any)?.itinerary_quote_ID || '';

    const actualGuestArrivalAt = (plan as any)?.trip_start_date_and_time
      ? new Date((plan as any).trip_start_date_and_time)
      : null;
    const routeDate = route?.itinerary_route_date
      ? new Date(route.itinerary_route_date)
      : null;
    const hotelCheckOutDate = routeDate && !Number.isNaN(routeDate.getTime())
      ? new Date(Date.UTC(
          routeDate.getUTCFullYear(),
          routeDate.getUTCMonth(),
          routeDate.getUTCDate() + 1,
          0,
          0,
          0,
        ))
      : null;
    const shouldApplyEarlyCheckIn =
      Boolean(previousDayMarker?.itinerary_route_date) &&
      Boolean(actualGuestArrivalAt && !Number.isNaN(actualGuestArrivalAt.getTime())) &&
      (Number((plan as any)?.itinerary_preference || 0) === 1 ||
        Number((plan as any)?.itinerary_preference || 0) === 3);
    const earlyCheckInNote = shouldApplyEarlyCheckIn
      ? `Guest has opted for early morning check-in with extra payment. ` +
        `Room to be blocked from ${new Date(previousDayMarker.itinerary_route_date).toISOString().slice(0, 10)}, ` +
        `with actual guest arrival/check-in on ${actualGuestArrivalAt!.toISOString().slice(0, 10)} ` +
        `at ${actualGuestArrivalAt!.toISOString().slice(11, 19)}.`
      : null;
    const earlyCheckInData = shouldApplyEarlyCheckIn
      ? {
          hotel_check_in_date: previousDayMarker.itinerary_route_date,
          actual_guest_arrival_at: actualGuestArrivalAt,
          hotel_check_out_date: hotelCheckOutDate,
          early_checkin: 1,
          early_checkin_extra_payment_applicable: 1,
          early_checkin_payment_status: 'EXTRA_PAYMENT_APPLICABLE',
          early_checkin_note: earlyCheckInNote,
        }
      : {
          hotel_check_in_date: null,
          actual_guest_arrival_at: null,
          hotel_check_out_date: null,
          early_checkin: 0,
          early_checkin_extra_payment_applicable: 0,
          early_checkin_payment_status: null,
          early_checkin_note: null,
        };

 // Check if hotel assignment already exists in hotel_details
    const existingHotelCandidates = await (this.prisma as any).dvi_itinerary_plan_hotel_details.findMany({
      where: {
        itinerary_plan_id: data.planId,
        itinerary_route_id: data.routeId,
        group_type: data.groupType || 1,
        hotel_required: 1,
        deleted: 0,
        status: 1,
      },
      orderBy: { itinerary_plan_hotel_details_ID: 'desc' },
    });
    const selectionKey = hotelSelectionKey(
      data.planId,
      data.routeId,
      data.groupType || 1,
      route?.itinerary_route_date,
    );
    const existingHotelDetails = existingHotelCandidates.find((row: any) =>
      hotelSelectionKeyFromRow(data.planId, row) === selectionKey,
    ) || existingHotelCandidates[0];

    const mealBreakfast = data.mealPlan?.breakfast || data.mealPlan?.all ? 1 : 0;
    const mealLunch = data.mealPlan?.lunch || data.mealPlan?.all ? 1 : 0;
    const mealDinner = data.mealPlan?.dinner || data.mealPlan?.all ? 1 : 0;

    let hotelDetailsId: number;

    if (existingHotelDetails) {
 // Update existing hotel assignment
 console.log(` Updating existing hotel - Old ID: ${existingHotelDetails.hotel_id}, New ID: ${data.hotelId}, GroupType: ${data.groupType}`);
      await (this.prisma as any).dvi_itinerary_plan_hotel_details.update({
        where: { itinerary_plan_hotel_details_ID: existingHotelDetails.itinerary_plan_hotel_details_ID },
        data: {
          hotel_id: data.hotelId,
          hotel_required: 1,
          ...earlyCheckInData,
 group_type: data.groupType || 1, // Save groupType
          updatedon: new Date(),
          ...liveRateMetadata,
          selected_rate_option_id: data.rateOptionId || data.optionKey || null,
          selected_price_per_night: data.pricePerNight ?? null,
          selected_total_price: data.totalPrice ?? null,
          selected_currency: data.currency || null,
          selected_price_snapshot: JSON.stringify({
            optionKey: data.optionKey || null,
            rateOptionId: data.rateOptionId || null,
            selectionOrigin: 'USER_SELECTED',
            hotelName: data.hotelName || null,
            category: data.category || null,
            roomType: data.roomType || null,
            mealPlan: data.mealPlanCode || null,
            bookingCode: data.bookingCode || null,
            searchReference: data.searchReference || null,
            roomId: data.roomId || null,
            rateId: data.rateId || null,
          }),
        },
      });
      await (this.prisma as any).dvi_itinerary_plan_hotel_details.updateMany({
        where: {
          itinerary_plan_id: data.planId,
          itinerary_route_id: data.routeId,
          group_type: data.groupType || 1,
          hotel_required: 1,
          deleted: 0,
          status: 1,
          itinerary_plan_hotel_details_ID: { not: existingHotelDetails.itinerary_plan_hotel_details_ID },
        },
        data: { status: 0, deleted: 1, updatedon: new Date() },
      });
      const updated = await (this.prisma as any).dvi_itinerary_plan_hotel_details.findUnique({
        where: { itinerary_plan_hotel_details_ID: existingHotelDetails.itinerary_plan_hotel_details_ID },
      });
 console.log(` Updated. New values - hotel_id: ${(updated as any).hotel_id}, group_type: ${(updated as any).group_type}`);
      hotelDetailsId = existingHotelDetails.itinerary_plan_hotel_details_ID;
    } else {
 // Create new hotel assignment
 console.log(` Creating new hotel - ID: ${data.hotelId}, GroupType: ${data.groupType}`);
      const created = await (this.prisma as any).dvi_itinerary_plan_hotel_details.create({
        data: {
          itinerary_plan_id: data.planId,
          itinerary_route_id: data.routeId,
          itinerary_route_date: route?.itinerary_route_date || null,
          itinerary_route_location:
            route?.next_visiting_location || route?.location_name || null,
          hotel_id: data.hotelId,
          hotel_required: 1,
          ...earlyCheckInData,
 group_type: data.groupType || 1, // Save groupType
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
          ...liveRateMetadata,
          selected_rate_option_id: data.rateOptionId || data.optionKey || null,
          selected_price_per_night: data.pricePerNight ?? null,
          selected_total_price: data.totalPrice ?? null,
          selected_currency: data.currency || null,
          selected_price_snapshot: JSON.stringify({
            optionKey: data.optionKey || null,
            rateOptionId: data.rateOptionId || null,
            selectionOrigin: 'USER_SELECTED',
            hotelName: data.hotelName || null,
            category: data.category || null,
            roomType: data.roomType || null,
            mealPlan: data.mealPlanCode || null,
            bookingCode: data.bookingCode || null,
            searchReference: data.searchReference || null,
            roomId: data.roomId || null,
            rateId: data.rateId || null,
          }),
        },
      });
 console.log(` Created. Values - hotel_id: ${(created as any).hotel_id}, group_type: ${(created as any).group_type}`);
      hotelDetailsId = created.itinerary_plan_hotel_details_ID;
    }

 // Check if room details already exist
    const existingRoomDetails = await (this.prisma as any).dvi_itinerary_plan_hotel_room_details.findFirst({
      where: {
        itinerary_plan_hotel_details_id: hotelDetailsId,
        deleted: 0,
        status: 1,
      },
      orderBy: { itinerary_plan_hotel_room_details_ID: 'desc' },
    });

    if (existingRoomDetails) {
 // Update existing room details
      await (this.prisma as any).dvi_itinerary_plan_hotel_room_details.update({
        where: { itinerary_plan_hotel_room_details_ID: existingRoomDetails.itinerary_plan_hotel_room_details_ID },
        data: {
          room_type_id: data.roomTypeId,
          breakfast_required: mealBreakfast,
          lunch_required: mealLunch,
          dinner_required: mealDinner,
          updatedon: new Date(),
        },
      });
      await (this.prisma as any).dvi_itinerary_plan_hotel_room_details.updateMany({
        where: {
          itinerary_plan_hotel_details_id: hotelDetailsId,
          deleted: 0,
          status: 1,
          itinerary_plan_hotel_room_details_ID: { not: existingRoomDetails.itinerary_plan_hotel_room_details_ID },
        },
        data: { status: 0, deleted: 1, updatedon: new Date() },
      });
    } else {
 // Create new room details
      await (this.prisma as any).dvi_itinerary_plan_hotel_room_details.create({
        data: {
          itinerary_plan_hotel_details_id: hotelDetailsId,
          itinerary_plan_id: data.planId,
          itinerary_route_id: data.routeId,
          hotel_id: data.hotelId,
          room_type_id: data.roomTypeId,
          breakfast_required: mealBreakfast,
          lunch_required: mealLunch,
          dinner_required: mealDinner,
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });
    }

 // Clear cache for this quote so next request gets fresh data
    if (quoteId) {
      this.hotelDetailsTboService.clearCacheForQuote(quoteId);
    }

    return {
      success: true,
      message: 'Hotel selected successfully',
    };
  }

  private getLiveRateMetadata(provider?: string) {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    if (!['tbo', 'axisrooms', 'staah', 'resavenue', 'hobse'].includes(normalizedProvider)) return {};
    return {
      hotel_provider: normalizedProvider,
      hotel_booking_mode: 'LIVE_API',
      price_source: 'LIVE_API',
      is_live_rate: true,
      hotel_approval_status: 'NOT_REQUIRED',
      manual_confirmation_status: 'NOT_STARTED',
      requires_price_reacceptance: false,
    };
  }

  private async selectOfflineHotel(data: {
    planId: number;
    routeId: number;
    hotelId: number;
    roomTypeId: number;
    canonicalHotelId?: number;
    rateOptionId?: string;
    roomCount?: number;
    groupType?: number;
    mealPlan?: { all?: boolean; breakfast?: boolean; lunch?: boolean; dinner?: boolean };
    requestedBy?: number;
  }) {
    const canonicalHotelId = Number(data.canonicalHotelId ?? data.hotelId ?? 0);
    const rateOptionId = String(data.rateOptionId || '').trim();
    if (!canonicalHotelId || !rateOptionId) {
      throw new BadRequestException('Offline hotel selection requires canonicalHotelId and rateOptionId');
    }

    let resolvedRate;
    try {
      if (!this.offlineHotelCatalogService) throw new Error('Offline hotel catalog service is not configured');
      resolvedRate = await this.offlineHotelCatalogService.resolveOfflineRateOption({
        planId: Number(data.planId),
        routeId: Number(data.routeId),
        canonicalHotelId,
        rateOptionId,
        roomCount: Math.max(Number(data.roomCount || 1), 1),
      });
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Offline hotel rate is stale or invalid');
    }

    const requestedBy = Number(data.requestedBy || 1);
    const now = new Date();
    const snapshot = JSON.stringify(resolvedRate);
    const checkInDate = resolvedRate.nightlyRates[0]?.date || null;
    const checkOutDate = resolvedRate.nightlyRates.length
      ? new Date(`${resolvedRate.nightlyRates[resolvedRate.nightlyRates.length - 1].date}T00:00:00.000Z`)
      : null;
    if (checkOutDate) checkOutDate.setUTCDate(checkOutDate.getUTCDate() + 1);

    await this.prisma.$transaction(async (tx) => {
      const existingHotelCandidates = await (tx as any).dvi_itinerary_plan_hotel_details.findMany({
        where: {
          itinerary_plan_id: Number(data.planId),
          itinerary_route_id: Number(data.routeId),
          group_type: Number(data.groupType || 1),
          hotel_required: 1,
          deleted: 0,
          status: 1,
        },
        orderBy: { itinerary_plan_hotel_details_ID: 'desc' },
      });
      const offlineSelectionKey = hotelSelectionKey(
        Number(data.planId),
        Number(data.routeId),
        Number(data.groupType || 1),
        checkInDate,
      );
      const existingHotel = existingHotelCandidates.find((row: any) =>
        hotelSelectionKeyFromRow(Number(data.planId), row) === offlineSelectionKey,
      ) || existingHotelCandidates[0];
      const hotelData = {
        hotel_id: resolvedRate.canonicalHotelId,
        hotel_code: String(resolvedRate.canonicalHotelId),
        hotel_required: 1,
        hotel_provider: 'offline',
        hotel_booking_mode: 'MANUAL_APPROVAL',
        price_source: 'DATABASE',
        is_live_rate: false,
        selected_rate_option_id: rateOptionId,
        selected_price_per_night: resolvedRate.pricePerNight,
        selected_total_price: resolvedRate.totalStayPrice,
        selected_currency: resolvedRate.currency,
        selected_price_snapshot: snapshot,
        hotel_approval_status: 'PENDING_APPROVAL',
        hotel_approval_requested_at: now,
        hotel_approval_requested_by: requestedBy,
        hotel_approved_at: null,
        hotel_approved_by: null,
        hotel_rejected_at: null,
        hotel_rejected_by: null,
        hotel_approval_notes: null,
        manual_confirmation_status: 'NOT_STARTED',
        manual_confirmation_requested_at: null,
        manually_confirmed_at: null,
        manually_confirmed_by: null,
        manual_confirmation_notes: null,
        requires_price_reacceptance: false,
        updatedon: now,
        status: 1,
        deleted: 0,
        ...(checkInDate ? { hotel_check_in_date: new Date(`${checkInDate}T00:00:00.000Z`) } : {}),
        ...(checkOutDate ? { hotel_check_out_date: checkOutDate } : {}),
      };
      const selection = existingHotel
        ? await (tx as any).dvi_itinerary_plan_hotel_details.update({
            where: { itinerary_plan_hotel_details_ID: existingHotel.itinerary_plan_hotel_details_ID },
            data: hotelData,
          })
        : await (tx as any).dvi_itinerary_plan_hotel_details.create({
            data: {
              itinerary_plan_id: Number(data.planId),
              itinerary_route_id: Number(data.routeId),
              group_type: Number(data.groupType || 1),
              createdby: requestedBy,
              createdon: now,
              itinerary_route_date: checkInDate ? new Date(`${checkInDate}T00:00:00.000Z`) : null,
              ...hotelData,
            },
          });

      const existingRoom = await (tx as any).dvi_itinerary_plan_hotel_room_details.findFirst({
        where: { itinerary_plan_hotel_details_id: selection.itinerary_plan_hotel_details_ID, deleted: 0 },
      });
      const roomData = {
        hotel_id: resolvedRate.canonicalHotelId,
        room_id: resolvedRate.roomId,
        room_type_id: resolvedRate.roomTypeId,
        room_qty: Math.max(Number(data.roomCount || 1), 1),
        room_rate: resolvedRate.pricePerNight,
        total_room_cost: resolvedRate.totalStayPrice,
        breakfast_required: data.mealPlan?.breakfast || data.mealPlan?.all ? 1 : 0,
        lunch_required: data.mealPlan?.lunch || data.mealPlan?.all ? 1 : 0,
        dinner_required: data.mealPlan?.dinner || data.mealPlan?.all ? 1 : 0,
        status: 1,
        deleted: 0,
        updatedon: now,
      };
      if (existingRoom) {
        await (tx as any).dvi_itinerary_plan_hotel_room_details.update({
          where: { itinerary_plan_hotel_room_details_ID: existingRoom.itinerary_plan_hotel_room_details_ID },
          data: roomData,
        });
      } else {
        await (tx as any).dvi_itinerary_plan_hotel_room_details.create({
          data: {
            itinerary_plan_hotel_details_id: selection.itinerary_plan_hotel_details_ID,
            itinerary_plan_id: Number(data.planId),
            itinerary_route_id: Number(data.routeId),
            group_type: Number(data.groupType || 1),
            createdby: requestedBy,
            createdon: now,
            ...roomData,
          },
        });
      }

      await (tx as any).dvi_itinerary_plan_hotel_approval_history.create({
        data: {
          itinerary_plan_hotel_details_id: selection.itinerary_plan_hotel_details_ID,
          previous_approval_status: existingHotel?.hotel_approval_status || 'NOT_REQUESTED',
          new_approval_status: 'PENDING_APPROVAL',
          previous_confirmation_status: existingHotel?.manual_confirmation_status || 'NOT_STARTED',
          new_confirmation_status: 'NOT_STARTED',
          price: resolvedRate.totalStayPrice,
          currency: resolvedRate.currency,
          notes: 'Offline hotel selection requested',
          acted_by: requestedBy,
          acted_at: now,
          metadata: snapshot,
        },
      });
    });

    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({ where: { itinerary_plan_ID: Number(data.planId) } });
    if (plan?.itinerary_quote_ID) this.hotelDetailsTboService.clearCacheForQuote(String(plan.itinerary_quote_ID));
    return {
      success: true,
      message: 'Hotel selected successfully and is pending hotel approval',
      approvalStatus: 'PENDING_APPROVAL',
      manualConfirmationStatus: 'NOT_STARTED',
      canonicalHotelId: resolvedRate.canonicalHotelId,
      rateOptionId,
    };
  }

 /**
   * Bulk save hotel selections - used before confirming itinerary
 */
  async bulkSaveHotels(planId: number, hotels: any[]) {
    const userId = 1;

 // Get the quote ID to clear the cache
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: planId },
    });
    const quoteId = (plan as any)?.itinerary_quote_ID || '';

 console.log(` Bulk saving ${hotels.length} hotel(s) for plan ${planId}`);

    for (const hotel of hotels) {
      await this.selectHotel({
        planId,
        routeId: hotel.routeId,
        hotelId: hotel.hotelId,
        roomTypeId: hotel.roomTypeId || 1,
        groupType: hotel.groupType,
        mealPlan: hotel.mealPlan,
      });
    }

 // Clear cache once at the end
    if (quoteId) {
      this.hotelDetailsTboService.clearCacheForQuote(quoteId);
    }

    return {
      success: true,
      message: `Successfully saved ${hotels.length} hotel selections`,
    };
  }

  private async getVehicleRateAvailabilityForEligible(
    planId: number,
    vendorEligibleId: number,
  ) {
    const detailRows = await this.prisma.$queryRawUnsafe(`
      SELECT
        travel_type,
        total_pickup_km,
        total_running_km,
        total_siteseeing_km,
        total_drop_km,
        vehicle_rental_charges
      FROM dvi_itinerary_plan_vendor_vehicle_details
      WHERE itinerary_plan_id = ${Number(planId)}
        AND itinerary_plan_vendor_eligible_ID = ${Number(vendorEligibleId)}
        AND deleted = 0
    `) as any[];

    return getVehicleRateAvailability(detailRows);
  }

 async selectVehicleVendor(data: {
  planId: number;
  vehicleTypeId: number;
  vendorEligibleId: number;
}) {
  const planId = Number(data.planId || 0);
  const vehicleTypeId = Number(data.vehicleTypeId || 0);
  const vendorEligibleId = Number(data.vendorEligibleId || 0);

  const selectedEligible = await (
    this.prisma as any
  ).dvi_itinerary_plan_vendor_eligible_list.findFirst({
    where: {
      itinerary_plan_vendor_eligible_ID: vendorEligibleId,
      itinerary_plan_id: planId,
      vehicle_type_id: vehicleTypeId,
      status: 1,
      deleted: 0,
    },
  });

  if (!selectedEligible) {
    throw new NotFoundException(
      'Selected vendor eligible row not found for plan/vehicle type',
    );
  }

  const { rows: activeSelectedRows } =
    await filterActiveVendorCandidateRows<any>(
      this.prisma,
      [selectedEligible],
    );

  if (!activeSelectedRows.length) {
    throw new BadRequestException(
      'Selected vendor is no longer active and cannot be assigned',
    );
  }

  const selectedRateAvailability =
    await this.getVehicleRateAvailabilityForEligible(
      planId,
      vendorEligibleId,
    );

  if (!selectedRateAvailability.available) {
    throw new BadRequestException(
      'Selected vendor does not have applicable local or outstation rates for this vehicle type',
    );
  }

  const requiredVehicleRows =
    await this.prisma.dvi_itinerary_plan_vehicle_details.findMany({
      where: {
        itinerary_plan_id: planId,
        vehicle_type_id: vehicleTypeId,
        status: 1,
        deleted: 0,
      },
      select: {
        vehicle_count: true,
      },
    });

  const requiredVehicleCount = Math.max(
    1,
    requiredVehicleRows.reduce(
      (sum, row) => sum + Number(row.vehicle_count || 0),
      0,
    ),
  );

  const candidateRows = await (
    this.prisma as any
  ).dvi_itinerary_plan_vendor_eligible_list.findMany({
    where: {
      itinerary_plan_id: planId,
      vehicle_type_id: vehicleTypeId,
      vehicle_grand_total: { gt: 0 },
      status: 1,
      deleted: 0,
    },
    orderBy: [
      { vehicle_grand_total: 'asc' },
      { itinerary_plan_vendor_eligible_ID: 'asc' },
    ],
  });

  const { rows: activeCandidateRows } =
    await filterActiveVendorCandidateRows<any>(
      this.prisma,
      candidateRows,
    );

  const rateValidCandidates: any[] = [];

  for (const candidate of activeCandidateRows) {
    const candidateEligibleId = Number(
      candidate.itinerary_plan_vendor_eligible_ID || 0,
    );

    const availability =
      candidateEligibleId === vendorEligibleId
        ? selectedRateAvailability
        : await this.getVehicleRateAvailabilityForEligible(
            planId,
            candidateEligibleId,
          );

    if (availability.available) {
      rateValidCandidates.push(candidate);
    }
  }

  const isSameSelectedVendor = (candidate: any) =>
    Number(candidate.vendor_id || 0) ===
      Number(selectedEligible.vendor_id || 0) &&
    Number(candidate.vendor_branch_id || 0) ===
      Number(selectedEligible.vendor_branch_id || 0) &&
    Number(candidate.vendor_vehicle_type_id || 0) ===
      Number(selectedEligible.vendor_vehicle_type_id || 0);

  const selectedCandidate = rateValidCandidates.find(
    (candidate) =>
      Number(candidate.itinerary_plan_vendor_eligible_ID || 0) ===
      vendorEligibleId,
  );

  if (!selectedCandidate) {
    throw new BadRequestException(
      'Selected vehicle vendor is no longer available',
    );
  }

  const remainingCandidates = rateValidCandidates
    .filter(
      (candidate) =>
        Number(candidate.itinerary_plan_vendor_eligible_ID || 0) !==
        vendorEligibleId,
    )
    .sort((a, b) => {
      const sameVendorDifference =
        Number(!isSameSelectedVendor(a)) -
        Number(!isSameSelectedVendor(b));

      if (sameVendorDifference !== 0) {
        return sameVendorDifference;
      }

      const amountDifference =
        Number(a.vehicle_grand_total || 0) -
        Number(b.vehicle_grand_total || 0);

      if (amountDifference !== 0) {
        return amountDifference;
      }

      return (
        Number(a.itinerary_plan_vendor_eligible_ID || 0) -
        Number(b.itinerary_plan_vendor_eligible_ID || 0)
      );
    });

  const assignedRows = [
    selectedCandidate,
    ...remainingCandidates,
  ].slice(0, requiredVehicleCount);

  const assignedVendorEligibleIds = assignedRows
    .map((row) =>
      Number(row.itinerary_plan_vendor_eligible_ID || 0),
    )
    .filter((id) => id > 0);

  await this.prisma.$transaction(async (tx) => {
    await (
      tx as any
    ).dvi_itinerary_plan_vendor_eligible_list.updateMany({
      where: {
        itinerary_plan_id: planId,
        vehicle_type_id: vehicleTypeId,
        status: 1,
        deleted: 0,
      },
      data: {
        itineary_plan_assigned_status: 0,
      },
    });

    await (
      tx as any
    ).dvi_itinerary_plan_vendor_eligible_list.updateMany({
      where: {
        itinerary_plan_vendor_eligible_ID: {
          in: assignedVendorEligibleIds,
        },
      },
      data: {
        itineary_plan_assigned_status: 1,
      },
    });

    await (
      tx as any
    ).dvi_itinerary_plan_vehicle_vendor_selection.upsert({
      where: {
        itinerary_plan_id_vehicle_type_id: {
          itinerary_plan_id: planId,
          vehicle_type_id: vehicleTypeId,
        },
      },
      create: {
        itinerary_plan_id: planId,
        vehicle_type_id: vehicleTypeId,
        selected_vendor_eligible_id: vendorEligibleId,
        vendor_id: Number(selectedEligible.vendor_id || 0),
        vendor_branch_id: Number(
          selectedEligible.vendor_branch_id || 0,
        ),
        vendor_vehicle_type_id: Number(
          selectedEligible.vendor_vehicle_type_id || 0,
        ),
        vehicle_id: Number(selectedEligible.vehicle_id || 0),
        selection_source: 'manual',
        createdby: 1,
        createdon: new Date(),
        updatedon: new Date(),
        status: 1,
        deleted: 0,
      },
      update: {
        selected_vendor_eligible_id: vendorEligibleId,
        vendor_id: Number(selectedEligible.vendor_id || 0),
        vendor_branch_id: Number(
          selectedEligible.vendor_branch_id || 0,
        ),
        vendor_vehicle_type_id: Number(
          selectedEligible.vendor_vehicle_type_id || 0,
        ),
        vehicle_id: Number(selectedEligible.vehicle_id || 0),
        selection_source: 'manual',
        updatedon: new Date(),
        status: 1,
        deleted: 0,
      },
    });
  });

  return {
    success: true,
    message: 'Vehicle vendor selected successfully',
    vehicleTypeId,
    selectedVendorEligibleId: vendorEligibleId,
    assignedVendorEligibleIds,
    selectionSource: 'manual' as const,
  };
}

  private async rebuildVehiclePricingWithSlabOverrides(data: {
  planId: number;
  selectedTimeLimitByEligible?: Record<string, number>;
}) {
  const userId = 1;

  await this.itineraryVehiclesEngine.rebuildEligibleVendorList({
    planId: Number(data.planId),
    createdBy: userId,
    selectedTimeLimitByEligible:
      data.selectedTimeLimitByEligible || {},
    beforeVehicleDetailsBuild: async ({
      tx,
      planId,
    }) => {
      await this.routeEngine.rebuildPermitCharges(
        tx,
        Number(planId),
        userId,
      );
    },
  });
}

  // Backward-compatible wrapper for legacy select-slab endpoint.
  async selectVehicleSlab(data: {
    planId: number;
    vehicleTypeId: number;
    vendorEligibleId?: number;
    timeLimitId?: number;
  }) {
    const planId = Number(data?.planId || 0);
    const vehicleTypeId = Number(
      data?.vehicleTypeId || 0,
    );
    const vendorEligibleId = Number(
      data?.vendorEligibleId || 0,
    );
    const timeLimitId = Number(
      data?.timeLimitId || 0,
    );

    if (
      !planId ||
      !vehicleTypeId ||
      !vendorEligibleId ||
      !timeLimitId
    ) {
      throw new BadRequestException(
        'planId, vehicleTypeId, vendorEligibleId and timeLimitId are required',
      );
    }

    const selectedEligible = await (
      this.prisma as any
    ).dvi_itinerary_plan_vendor_eligible_list.findFirst({
      where: {
        itinerary_plan_vendor_eligible_ID:
          vendorEligibleId,
        itinerary_plan_id: planId,
        vehicle_type_id: vehicleTypeId,
        status: 1,
        deleted: 0,
      },
      select: {
        itinerary_plan_vendor_eligible_ID: true,
        vendor_id: true,
        vendor_branch_id: true,
        vendor_vehicle_type_id: true,
        vehicle_id: true,
        vehicle_type_id: true,
      },
    });

    if (!selectedEligible) {
      throw new NotFoundException(
        'Selected vendor eligible row not found for plan/vehicle type',
      );
    }

    const selectedMap: Record<string, number> = {};

    selectedMap[String(vendorEligibleId)] =
      timeLimitId;

    const compositeKey = [
      Number(selectedEligible.vendor_id || 0),
      Number(
        selectedEligible.vendor_branch_id || 0,
      ),
      Number(
        selectedEligible.vendor_vehicle_type_id || 0,
      ),
      Number(selectedEligible.vehicle_id || 0),
    ].join(':');

    selectedMap[compositeKey] = timeLimitId;

   await this.rebuildVehiclePricingWithSlabOverrides({
  planId,
  selectedTimeLimitByEligible: selectedMap,
});
    return {
      success: true,
      message:
        'Vehicle slab selected and pricing recalculated successfully',
      planId,
      vehicleTypeId,
      vendorEligibleId,
      timeLimitId,
    };
  }

// Backward-compatible wrapper for legacy auto-select endpoint.
async autoSelectVehicleSlabs(data: {
  planId: number;
  vehicleTypeId?: number;
}) {
  const planId = Number(data?.planId || 0);
  const vehicleTypeId =
    Number(data?.vehicleTypeId || 0) || 0;

  if (!planId) {
    throw new BadRequestException(
      'planId is required',
    );
  }

  await this.rebuildVehiclePricingWithSlabOverrides({
    planId,
    selectedTimeLimitByEligible: {},
  });

  return {
    success: true,
    message:
      'Vehicle slabs auto-selected and pricing recalculated successfully',
    planId,
    vehicleTypeId: vehicleTypeId || undefined,
  };
}
  async forceRebuildVehiclePricingAfterHotspotChange(
    planId: number,
    routeId?: number,
  ) {
    const normalizedPlanId = Number(planId || 0);

    if (!normalizedPlanId) {
      return;
    }

    const vehicleRowsBefore = await (
      this.prisma as any
    ).dvi_itinerary_plan_vendor_vehicle_details.findMany({
      where: {
        itinerary_plan_id: normalizedPlanId,
        deleted: 0,
        ...(routeId
          ? {
              itinerary_route_id: Number(routeId),
            }
          : {}),
      },
      select: {
        itinerary_route_id: true,
        total_travelled_km: true,
        total_vehicle_amount: true,
      },
    });

    const beforeKm = vehicleRowsBefore.reduce(
      (sum: number, row: any) =>
        sum + Number(row?.total_travelled_km || 0),
      0,
    );

    const beforeAmount = vehicleRowsBefore.reduce(
      (sum: number, row: any) =>
        sum + Number(row?.total_vehicle_amount || 0),
      0,
    );

    console.log(
      '[HOTSPOT_CHANGE_VEHICLE_REBUILD_BEFORE]',
      {
        planId: normalizedPlanId,
        routeId: routeId || null,
        totalKms: Number(beforeKm.toFixed(2)),
        totalAmount: Number(beforeAmount.toFixed(2)),
      },
    );

    await this.itineraryVehiclesEngine.rebuildEligibleVendorList({
      planId: normalizedPlanId,
      createdBy: 1,
      beforeVehicleDetailsBuild: async ({
        tx,
        planId,
      }) => {
        await this.routeEngine.rebuildPermitCharges(
          tx,
          Number(planId),
          1,
        );
      },
    });
  }
}