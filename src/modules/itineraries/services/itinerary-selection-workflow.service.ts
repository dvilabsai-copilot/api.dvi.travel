// FILE: src/modules/itineraries/services/itinerary-selection-workflow.service.ts

import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { RouteEngineService } from '../engines/route-engine.service';
import { ItineraryVehiclesEngine } from '../engines/itinerary-vehicles.engine';
import { ItineraryHotelDetailsTboService } from '../itinerary-hotel-details-tbo.service';
import { OfflineHotelCatalogService } from './offline-hotel-catalog.service';
import { filterActiveVendorCandidateRows } from '../utils/active-vendor-candidate.util';
import { getVehicleRateAvailability } from '../utils/vehicle-rate-availability.util';

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
    groupType?: number;  // âœ… ADD groupType parameter
    mealPlan?: { all?: boolean; breakfast?: boolean; lunch?: boolean; dinner?: boolean; };
    canonicalHotelId?: number;
    rateOptionId?: string;
    provider?: string;
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
    const existingHotelDetails = await (this.prisma as any).dvi_itinerary_plan_hotel_details.findFirst({
      where: {
        itinerary_plan_id: data.planId,
        itinerary_route_id: data.routeId,
        group_type: data.groupType || 1,
        hotel_required: { not: 2 },
        deleted: 0,
      },
      orderBy: { itinerary_plan_hotel_details_ID: 'desc' },
    });

    const mealBreakfast = data.mealPlan?.breakfast || data.mealPlan?.all ? 1 : 0;
    const mealLunch = data.mealPlan?.lunch || data.mealPlan?.all ? 1 : 0;
    const mealDinner = data.mealPlan?.dinner || data.mealPlan?.all ? 1 : 0;

    let hotelDetailsId: number;

    if (existingHotelDetails) {
      // Update existing hotel assignment
      console.log(`ðŸ“ Updating existing hotel - Old ID: ${existingHotelDetails.hotel_id}, New ID: ${data.hotelId}, GroupType: ${data.groupType}`);
      await (this.prisma as any).dvi_itinerary_plan_hotel_details.update({
        where: { itinerary_plan_hotel_details_ID: existingHotelDetails.itinerary_plan_hotel_details_ID },
        data: {
          hotel_id: data.hotelId,
          hotel_required: 1,
          ...earlyCheckInData,
          group_type: data.groupType || 1,  // âœ… Save groupType
          updatedon: new Date(),
          ...liveRateMetadata,
        },
      });
      const updated = await (this.prisma as any).dvi_itinerary_plan_hotel_details.findUnique({
        where: { itinerary_plan_hotel_details_ID: existingHotelDetails.itinerary_plan_hotel_details_ID },
      });
      console.log(`âœ… Updated. New values - hotel_id: ${(updated as any).hotel_id}, group_type: ${(updated as any).group_type}`);
      hotelDetailsId = existingHotelDetails.itinerary_plan_hotel_details_ID;
    } else {
      // Create new hotel assignment
      console.log(`âœ¨ Creating new hotel - ID: ${data.hotelId}, GroupType: ${data.groupType}`);
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
          group_type: data.groupType || 1,  // âœ… Save groupType
          createdby: userId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });
      console.log(`âœ… Created. Values - hotel_id: ${(created as any).hotel_id}, group_type: ${(created as any).group_type}`);
      hotelDetailsId = created.itinerary_plan_hotel_details_ID;
    }

    // Check if room details already exist
    const existingRoomDetails = await (this.prisma as any).dvi_itinerary_plan_hotel_room_details.findFirst({
      where: {
        itinerary_plan_id: data.planId,
        itinerary_route_id: data.routeId,
        hotel_id: data.hotelId,
        deleted: 0,
      },
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

    // âœ… Clear cache for this quote so next request gets fresh data
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
      const existingHotel = await (tx as any).dvi_itinerary_plan_hotel_details.findFirst({
        where: {
          itinerary_plan_id: Number(data.planId),
          itinerary_route_id: Number(data.routeId),
          group_type: Number(data.groupType || 1),
          hotel_required: { not: 2 },
          deleted: 0,
        },
        orderBy: { itinerary_plan_hotel_details_ID: 'desc' },
      });
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

    console.log(`ðŸ“¦ Bulk saving ${hotels.length} hotel(s) for plan ${planId}`);

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
    const selectedEligible = await (this.prisma as any).dvi_itinerary_plan_vendor_eligible_list.findFirst({
      where: {
        itinerary_plan_vendor_eligible_ID: Number(data.vendorEligibleId),
        itinerary_plan_id: Number(data.planId),
        vehicle_type_id: Number(data.vehicleTypeId),
        status: 1,
        deleted: 0,
      },
    });

    if (!selectedEligible) {
      throw new NotFoundException('Selected vendor eligible row not found for plan/vehicle type');
    }

    const { rows: activeSelectedRows } = await filterActiveVendorCandidateRows<any>(this.prisma, [selectedEligible]);
    if (!activeSelectedRows.length) {
      throw new BadRequestException('Selected vendor is no longer active and cannot be assigned');
    }

    const rateAvailability = await this.getVehicleRateAvailabilityForEligible(
      Number(data.planId),
      Number(data.vendorEligibleId),
    );
    if (!rateAvailability.available) {
      throw new BadRequestException(
        'Selected vendor does not have applicable local or outstation rates for this vehicle type',
      );
    }

    // First, reset all vendors for this vehicle type to unassigned (0)
    await (this.prisma as any).dvi_itinerary_plan_vendor_eligible_list.updateMany({
      where: {
        itinerary_plan_id: data.planId,
        vehicle_type_id: data.vehicleTypeId,
        status: 1,
        deleted: 0,
      },
      data: {
        itineary_plan_assigned_status: 0,
      },
    });

    // Then, set the selected vendor to assigned (1)
    await (this.prisma as any).dvi_itinerary_plan_vendor_eligible_list.update({
      where: {
        itinerary_plan_vendor_eligible_ID: data.vendorEligibleId,
      },
      data: {
        itineary_plan_assigned_status: 1,
      },
    });

    return {
      success: true,
      message: 'Vehicle vendor selected successfully',
    };
  }

  private async rebuildVehiclePricingWithSlabOverrides(data: {
    planId: number;
    selectedTimeLimitByEligible?: Record<string, number>;
    preserveSelection?: {
      vehicleTypeId: number;
      vendorId: number;
      vendorBranchId: number;
      vendorVehicleTypeId: number;
      vehicleId: number;
    } | null;
  }) {
    const userId = 1;
    await this.itineraryVehiclesEngine.rebuildEligibleVendorList({
      planId: Number(data.planId),
      createdBy: userId,
      selectedTimeLimitByEligible: data.selectedTimeLimitByEligible || {},
      beforeVehicleDetailsBuild: async ({ tx, planId }) => {
        await this.routeEngine.rebuildPermitCharges(tx, Number(planId), userId);
      },
    });

    if (data.preserveSelection) {
      const matched = await (this.prisma as any).dvi_itinerary_plan_vendor_eligible_list.findFirst({
        where: {
          itinerary_plan_id: Number(data.planId),
          vehicle_type_id: Number(data.preserveSelection.vehicleTypeId),
          vendor_id: Number(data.preserveSelection.vendorId),
          vendor_branch_id: Number(data.preserveSelection.vendorBranchId),
          vendor_vehicle_type_id: Number(data.preserveSelection.vendorVehicleTypeId),
          vehicle_id: Number(data.preserveSelection.vehicleId),
          status: 1,
          deleted: 0,
        },
        orderBy: { itinerary_plan_vendor_eligible_ID: 'asc' },
      });

      if (matched?.itinerary_plan_vendor_eligible_ID) {
        await this.selectVehicleVendor({
          planId: Number(data.planId),
          vehicleTypeId: Number(data.preserveSelection.vehicleTypeId),
          vendorEligibleId: Number(matched.itinerary_plan_vendor_eligible_ID),
        });
      }
    }
  }

  // Backward-compatible wrapper for legacy select-slab endpoint.
  async selectVehicleSlab(data: {
    planId: number;
    vehicleTypeId: number;
    vendorEligibleId?: number;
    timeLimitId?: number;
  }) {
    const planId = Number(data?.planId || 0);
    const vehicleTypeId = Number(data?.vehicleTypeId || 0);
    const vendorEligibleId = Number(data?.vendorEligibleId || 0);
    const timeLimitId = Number(data?.timeLimitId || 0);

    if (!planId || !vehicleTypeId || !vendorEligibleId || !timeLimitId) {
      throw new BadRequestException('planId, vehicleTypeId, vendorEligibleId and timeLimitId are required');
    }

    const selectedEligible = await (this.prisma as any).dvi_itinerary_plan_vendor_eligible_list.findFirst({
      where: {
        itinerary_plan_vendor_eligible_ID: vendorEligibleId,
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
      throw new NotFoundException('Selected vendor eligible row not found for plan/vehicle type');
    }

    const selectedMap: Record<string, number> = {};
    selectedMap[String(vendorEligibleId)] = timeLimitId;
    const compositeKey = `${Number(selectedEligible.vendor_id || 0)}:${Number(selectedEligible.vendor_branch_id || 0)}:${Number(selectedEligible.vendor_vehicle_type_id || 0)}:${Number(selectedEligible.vehicle_id || 0)}`;
    selectedMap[compositeKey] = timeLimitId;

    await this.rebuildVehiclePricingWithSlabOverrides({
      planId,
      selectedTimeLimitByEligible: selectedMap,
      preserveSelection: {
        vehicleTypeId,
        vendorId: Number(selectedEligible.vendor_id || 0),
        vendorBranchId: Number(selectedEligible.vendor_branch_id || 0),
        vendorVehicleTypeId: Number(selectedEligible.vendor_vehicle_type_id || 0),
        vehicleId: Number(selectedEligible.vehicle_id || 0),
      },
    });

    return {
      success: true,
      message: 'Vehicle slab selected and pricing recalculated successfully',
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
    const vehicleTypeId = Number(data?.vehicleTypeId || 0) || 0;
    if (!planId) {
      throw new BadRequestException('planId is required');
    }

    const where: any = {
      itinerary_plan_id: planId,
      status: 1,
      deleted: 0,
      itineary_plan_assigned_status: 1,
    };
    if (vehicleTypeId > 0) {
      where.vehicle_type_id = vehicleTypeId;
    }

    const assignedBefore = await (this.prisma as any).dvi_itinerary_plan_vendor_eligible_list.findMany({
      where,
      select: {
        vehicle_type_id: true,
        vendor_id: true,
        vendor_branch_id: true,
        vendor_vehicle_type_id: true,
        vehicle_id: true,
      },
      orderBy: { itinerary_plan_vendor_eligible_ID: 'asc' },
    });

    await this.rebuildVehiclePricingWithSlabOverrides({
      planId,
      selectedTimeLimitByEligible: {},
      preserveSelection: null,
    });

    for (const s of assignedBefore) {
      const matched = await (this.prisma as any).dvi_itinerary_plan_vendor_eligible_list.findFirst({
        where: {
          itinerary_plan_id: planId,
          vehicle_type_id: Number(s.vehicle_type_id || 0),
          vendor_id: Number(s.vendor_id || 0),
          vendor_branch_id: Number(s.vendor_branch_id || 0),
          vendor_vehicle_type_id: Number(s.vendor_vehicle_type_id || 0),
          vehicle_id: Number(s.vehicle_id || 0),
          status: 1,
          deleted: 0,
        },
        select: { itinerary_plan_vendor_eligible_ID: true },
        orderBy: { itinerary_plan_vendor_eligible_ID: 'asc' },
      });

      if (matched?.itinerary_plan_vendor_eligible_ID) {
        await this.selectVehicleVendor({
          planId,
          vehicleTypeId: Number(s.vehicle_type_id || 0),
          vendorEligibleId: Number(matched.itinerary_plan_vendor_eligible_ID),
        });
      }
    }

    return {
      success: true,
      message: 'Vehicle slabs auto-selected and pricing recalculated successfully',
      planId,
      vehicleTypeId: vehicleTypeId || undefined,
    };
  }

  async forceRebuildVehiclePricingAfterHotspotChange(planId: number, routeId?: number) {
    const normalizedPlanId = Number(planId || 0);
    if (!normalizedPlanId) return;

    const assignedBeforeRaw = await (this.prisma as any).dvi_itinerary_plan_vendor_eligible_list.findMany({
      where: {
        itinerary_plan_id: normalizedPlanId,
        status: 1,
        deleted: 0,
        itineary_plan_assigned_status: 1,
      },
      select: {
        vehicle_type_id: true,
        vendor_id: true,
        vendor_branch_id: true,
        vendor_vehicle_type_id: true,
        vehicle_id: true,
      },
    });
    const {
      rows: assignedBefore,
      activeVendorIds,
      activeBranchIds,
      activeVehicleIds,
    } = await filterActiveVendorCandidateRows<any>(this.prisma, assignedBeforeRaw);
    const skippedInactiveAssignedBefore = assignedBeforeRaw.filter((row: any) => (
      !activeVendorIds.has(Number(row?.vendor_id || 0))
      || !activeBranchIds.has(Number(row?.vendor_branch_id || 0))
      || !activeVehicleIds.has(Number(row?.vehicle_id || 0))
    ));

    if (skippedInactiveAssignedBefore.length > 0) {
      console.warn('[HOTSPOT_CHANGE_VEHICLE_REBUILD_SKIP_INACTIVE_ASSIGNED_VENDOR]', {
        planId: normalizedPlanId,
        routeId: routeId || null,
        skipped: skippedInactiveAssignedBefore.map((row: any) => ({
          eligibleId: Number(row?.itinerary_plan_vendor_eligible_ID || 0),
          vehicleTypeId: Number(row?.vehicle_type_id || 0),
          vendorId: Number(row?.vendor_id || 0),
          vendorBranchId: Number(row?.vendor_branch_id || 0),
          vehicleId: Number(row?.vehicle_id || 0),
        })),
      });
    }

    const vehicleRowsBefore = await (this.prisma as any).dvi_itinerary_plan_vendor_vehicle_details.findMany({
      where: {
        itinerary_plan_id: normalizedPlanId,
        deleted: 0,
        ...(routeId ? { itinerary_route_id: Number(routeId) } : {}),
      },
      select: {
        itinerary_route_id: true,
        total_travelled_km: true,
        total_vehicle_amount: true,
      },
    });
    const beforeKm = vehicleRowsBefore.reduce((sum: number, r: any) => sum + Number(r?.total_travelled_km || 0), 0);
    const beforeAmount = vehicleRowsBefore.reduce((sum: number, r: any) => sum + Number(r?.total_vehicle_amount || 0), 0);
    console.log('[HOTSPOT_CHANGE_VEHICLE_REBUILD_BEFORE]', {
      planId: normalizedPlanId,
      routeId: routeId || null,
      totalKms: Number(beforeKm.toFixed(2)),
      totalAmount: Number(beforeAmount.toFixed(2)),
    });

    await this.itineraryVehiclesEngine.rebuildEligibleVendorList({
      planId: normalizedPlanId,
      createdBy: 1,
      beforeVehicleDetailsBuild: async ({ tx, planId }) => {
        await this.routeEngine.rebuildPermitCharges(tx, Number(planId), 1);
      },
    });

    for (const s of assignedBefore) {
      const matched = await (this.prisma as any).dvi_itinerary_plan_vendor_eligible_list.findFirst({
        where: {
          itinerary_plan_id: normalizedPlanId,
          vehicle_type_id: Number(s.vehicle_type_id || 0),
          vendor_id: Number(s.vendor_id || 0),
          vendor_branch_id: Number(s.vendor_branch_id || 0),
          vendor_vehicle_type_id: Number(s.vendor_vehicle_type_id || 0),
          vehicle_id: Number(s.vehicle_id || 0),
          status: 1,
          deleted: 0,
        },
        select: { itinerary_plan_vendor_eligible_ID: true },
      });
      if (matched?.itinerary_plan_vendor_eligible_ID) {
        await this.selectVehicleVendor({
          planId: normalizedPlanId,
          vehicleTypeId: Number(s.vehicle_type_id || 0),
          vendorEligibleId: Number(matched.itinerary_plan_vendor_eligible_ID),
        });
      }
    }
  }
}
