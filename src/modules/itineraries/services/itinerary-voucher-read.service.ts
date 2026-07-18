// FILE: src/modules/itineraries/services/itinerary-voucher-read.service.ts

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { TransportVoucherDetails } from '../dto/transport-voucher-details.dto';
import { getTransportEarlyArrivalMessage } from '../transport-early-arrival';

type VoucherReadCallbacks = Partial<Record<
  'toDateOnly'
  | 'getInvoiceToLabel'
  | 'getVoucherStatusLabel'
  | 'formatTransportVoucherDate'
  | 'buildTransportDateRange'
  | 'buildPassengerMixLabel'
  | 'buildTransportVoucherNumber'
  | 'shortTransportLocationName'
  | 'decodeTransportHtml'
  | 'parseTransportFlightDetails'
  | 'formatTime',
  (...args: any[]) => any
>>;


@Injectable()
export class ItineraryVoucherReadService {
  private callbacks: VoucherReadCallbacks = {};

  constructor(private readonly prisma: PrismaService) {}

  setCallbacks(callbacks: VoucherReadCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  private call(name: keyof VoucherReadCallbacks, ...args: any[]) {
    const callback = this.callbacks[name];
    if (!callback) {
      throw new Error(`Voucher read callback is not configured: ${String(name)}`);
    }
    return callback(...args);
  }

  private toDateOnly(...args: any[]) { return this.call('toDateOnly', ...args); }
  private getInvoiceToLabel(...args: any[]) { return this.call('getInvoiceToLabel', ...args); }
  private getVoucherStatusLabel(...args: any[]) { return this.call('getVoucherStatusLabel', ...args); }
  private formatTransportVoucherDate(...args: any[]) { return this.call('formatTransportVoucherDate', ...args); }
  private buildTransportDateRange(...args: any[]) { return this.call('buildTransportDateRange', ...args); }
  private buildPassengerMixLabel(...args: any[]) { return this.call('buildPassengerMixLabel', ...args); }
  private buildTransportVoucherNumber(...args: any[]) { return this.call('buildTransportVoucherNumber', ...args); }
  private shortTransportLocationName(...args: any[]) { return this.call('shortTransportLocationName', ...args); }
  private decodeTransportHtml(...args: any[]) { return this.call('decodeTransportHtml', ...args); }
  private parseTransportFlightDetails(...args: any[]) { return this.call('parseTransportFlightDetails', ...args); }
  private formatTime(...args: any[]) { return this.call('formatTime', ...args); }

  async getVoucherDetails(itineraryPlanId: number) {
    const plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
      where: { itinerary_plan_ID: itineraryPlanId, deleted: 0 },
    });

    if (!plan) {
      throw new NotFoundException('Confirmed itinerary plan not found');
    }

    const customer = await this.prisma.dvi_confirmed_itinerary_customer_details.findFirst({
      where: { itinerary_plan_ID: itineraryPlanId, primary_customer: 1, deleted: 0 },
    });

    const itineraryPreference = Number(plan.itinerary_preference || 0);
    const shouldShowHotels = itineraryPreference === 1 || itineraryPreference === 3;
    const shouldShowVehicles = itineraryPreference === 2 || itineraryPreference === 3;

    const [
      hotels,
      hotelRooms,
      hotelVouchers,
      hotelCancellationPolicies,
      vehicles,
      vehicleVouchers,
      vehicleCancellationPolicies,
    ] = await Promise.all([
      shouldShowHotels
        ? this.prisma.dvi_confirmed_itinerary_plan_hotel_details.findMany({
            where: { itinerary_plan_id: itineraryPlanId, deleted: 0, status: 1 },
            orderBy: [{ itinerary_route_date: 'asc' }, { confirmed_itinerary_plan_hotel_details_ID: 'asc' }],
          })
        : Promise.resolve([] as any[]),
      shouldShowHotels
        ? this.prisma.dvi_confirmed_itinerary_plan_hotel_room_details.findMany({
            where: { itinerary_plan_id: itineraryPlanId, deleted: 0, status: 1 },
            orderBy: [{ itinerary_route_date: 'asc' }, { confirmed_itinerary_plan_hotel_room_details_ID: 'asc' }],
          })
        : Promise.resolve([] as any[]),
      shouldShowHotels
        ? this.prisma.dvi_confirmed_itinerary_plan_hotel_voucher_details.findMany({
            where: { itinerary_plan_id: itineraryPlanId, deleted: 0 },
            orderBy: [{ updatedon: 'desc' }, { cnf_itinerary_plan_hotel_voucher_details_ID: 'desc' }],
          })
        : Promise.resolve([] as any[]),
      shouldShowHotels
        ? this.prisma.dvi_confirmed_itinerary_plan_hotel_cancellation_policy.findMany({
            where: { itinerary_plan_id: itineraryPlanId, deleted: 0, status: 1 },
          })
        : Promise.resolve([] as any[]),
      shouldShowVehicles
        ? this.prisma.dvi_confirmed_itinerary_plan_vendor_eligible_list.findMany({
            where: {
              itinerary_plan_id: itineraryPlanId,
              deleted: 0,
              status: 1,
              itineary_plan_assigned_status: 1,
            },
            orderBy: [{ vehicle_type_id: 'asc' }, { confirmed_itinerary_plan_vendor_eligible_ID: 'asc' }],
          })
        : Promise.resolve([] as any[]),
      shouldShowVehicles
        ? this.prisma.dvi_confirmed_itinerary_plan_vehicle_voucher_details.findMany({
            where: { itinerary_plan_id: itineraryPlanId, deleted: 0 },
            orderBy: [{ updatedon: 'desc' }, { cnf_itinerary_plan_vehicle_voucher_details_ID: 'desc' }],
          })
        : Promise.resolve([] as any[]),
      shouldShowVehicles
        ? this.prisma.dvi_confirmed_itinerary_plan_vehicle_cancellation_policy.findMany({
            where: { itinerary_plan_id: itineraryPlanId, deleted: 0, status: 1 },
          })
        : Promise.resolve([] as any[]),
    ]);

    const hotelIds = Array.from(new Set(hotels.map((h: any) => Number(h.hotel_id || 0)).filter((id) => id > 0)));
    const hotelRoomTypeIds = Array.from(new Set(hotelRooms.map((r: any) => Number(r.room_type_id || 0)).filter((id) => id > 0)));
    const vendorIds = Array.from(new Set(vehicles.map((v: any) => Number(v.vendor_id || 0)).filter((id) => id > 0)));
    const vendorBranchIds = Array.from(new Set(vehicles.map((v: any) => Number(v.vendor_branch_id || 0)).filter((id) => id > 0)));
    const vehicleTypeIds = Array.from(new Set(vehicles.map((v: any) => Number(v.vehicle_type_id || 0)).filter((id) => id > 0)));

    const [hotelMasters, roomTypes, vendorMasters, vendorBranches, vehicleTypes] = await Promise.all([
      hotelIds.length > 0
        ? this.prisma.dvi_hotel.findMany({
            where: { hotel_id: { in: hotelIds } as any },
            select: {
              hotel_id: true,
              hotel_name: true,
              hotel_email: true,
              hotel_city: true,
              hotel_state: true,
            },
          })
        : Promise.resolve([] as any[]),
      hotelRoomTypeIds.length > 0
        ? this.prisma.dvi_hotel_roomtype.findMany({
            where: { room_type_id: { in: hotelRoomTypeIds } as any },
            select: { room_type_id: true, room_type_title: true },
          })
        : Promise.resolve([] as any[]),
      vendorIds.length > 0
        ? this.prisma.dvi_vendor_details.findMany({
            where: { vendor_id: { in: vendorIds } as any },
            select: { vendor_id: true, vendor_name: true, vendor_email: true },
          })
        : Promise.resolve([] as any[]),
      vendorBranchIds.length > 0
        ? this.prisma.dvi_vendor_branches.findMany({
            where: { vendor_branch_id: { in: vendorBranchIds } as any },
            select: { vendor_branch_id: true, vendor_branch_name: true, vendor_branch_emailid: true },
          })
        : Promise.resolve([] as any[]),
      vehicleTypeIds.length > 0
        ? this.prisma.dvi_vehicle_type.findMany({
            where: { vehicle_type_id: { in: vehicleTypeIds } as any },
            select: { vehicle_type_id: true, vehicle_type_title: true },
          })
        : Promise.resolve([] as any[]),
    ]);

    const hotelById = new Map<number, any>();
    for (const hotel of hotelMasters as any[]) {
      hotelById.set(Number(hotel.hotel_id), hotel);
    }

    const roomTypeById = new Map<number, string>();
    for (const roomType of roomTypes as any[]) {
      roomTypeById.set(Number(roomType.room_type_id), String(roomType.room_type_title || ''));
    }

    const vendorById = new Map<number, any>();
    for (const vendor of vendorMasters as any[]) {
      vendorById.set(Number(vendor.vendor_id), vendor);
    }

    const vendorBranchById = new Map<number, any>();
    for (const branch of vendorBranches as any[]) {
      vendorBranchById.set(Number(branch.vendor_branch_id), branch);
    }

    const vehicleTypeById = new Map<number, string>();
    for (const vehicleType of vehicleTypes as any[]) {
      vehicleTypeById.set(Number(vehicleType.vehicle_type_id), String(vehicleType.vehicle_type_title || ''));
    }

    const itineraryDates = Array.from(
      new Set(
        hotels
          .map((hotel: any) => this.toDateOnly(hotel.itinerary_route_date))
          .filter(Boolean),
      ),
    ).sort();
    const dayNumberByDate = new Map<string, number>();
    itineraryDates.forEach((date, index) => {
      dayNumberByDate.set(date, index + 1);
    });

    const roomsByConfirmedHotelId = new Map<number, any[]>();
    for (const room of hotelRooms as any[]) {
      const confirmedHotelId = Number(room.confirmed_itinerary_plan_hotel_details_id || 0);
      if (!confirmedHotelId) continue;
      if (!roomsByConfirmedHotelId.has(confirmedHotelId)) {
        roomsByConfirmedHotelId.set(confirmedHotelId, []);
      }
      roomsByConfirmedHotelId.get(confirmedHotelId)!.push(room);
    }

    const hotelGroupMap = new Map<number, any>();
    for (const hotel of hotels as any[]) {
      const hotelId = Number(hotel.hotel_id || 0);
      if (!hotelId) continue;

      const dateKey = this.toDateOnly(hotel.itinerary_route_date);
      const hotelMaster = hotelById.get(hotelId);
      const hotelRoomsForRow = roomsByConfirmedHotelId.get(Number(hotel.confirmed_itinerary_plan_hotel_details_ID || 0)) || [];
      const roomTypesForRow = Array.from(
        new Set(
          hotelRoomsForRow
            .map((room: any) => roomTypeById.get(Number(room.room_type_id || 0)) || '')
            .filter(Boolean),
        ),
      );

      if (!hotelGroupMap.has(hotelId)) {
        hotelGroupMap.set(hotelId, {
          routeId: Number(hotel.itinerary_route_id || 0),
          hotelId,
          hotelName: String(hotelMaster?.hotel_name || 'N/A'),
          hotelEmail: String(hotelMaster?.hotel_email || ''),
          hotelStateCity: [hotelMaster?.hotel_state, hotelMaster?.hotel_city].filter(Boolean).join(', '),
          routeDates: [] as string[],
          dayNumbers: [] as number[],
          hotelDetailsIds: [] as number[],
          confirmedHotelDetailsIds: [] as number[],
          destinations: [] as string[],
          roomTypes: [] as string[],
          hotelRequired: Number(hotel.hotel_required || 0) === 1,
          hotelCancellationStatus: Number(hotel.hotel_cancellation_status || 0),
        });
      }

      const group = hotelGroupMap.get(hotelId)!;
      if (dateKey && !group.routeDates.includes(dateKey)) {
        group.routeDates.push(dateKey);
      }
      const dayNumber = dayNumberByDate.get(dateKey);
      if (dayNumber && !group.dayNumbers.includes(dayNumber)) {
        group.dayNumbers.push(dayNumber);
      }
      const hotelDetailsId = Number(hotel.itinerary_plan_hotel_details_ID || 0);
      if (hotelDetailsId > 0 && !group.hotelDetailsIds.includes(hotelDetailsId)) {
        group.hotelDetailsIds.push(hotelDetailsId);
      }
      const confirmedHotelDetailsId = Number(hotel.confirmed_itinerary_plan_hotel_details_ID || 0);
      if (confirmedHotelDetailsId > 0 && !group.confirmedHotelDetailsIds.includes(confirmedHotelDetailsId)) {
        group.confirmedHotelDetailsIds.push(confirmedHotelDetailsId);
      }
      const destination = String(hotel.itinerary_route_location || '').trim();
      if (destination && !group.destinations.includes(destination)) {
        group.destinations.push(destination);
      }
      roomTypesForRow.forEach((roomType: string) => {
        if (roomType && !group.roomTypes.includes(roomType)) {
          group.roomTypes.push(roomType);
        }
      });
      group.hotelCancellationStatus = Math.max(group.hotelCancellationStatus, Number(hotel.hotel_cancellation_status || 0));
    }

    const hotelVoucherGroups = Array.from(hotelGroupMap.values())
      .map((group) => {
        const matchedVouchers = hotelVouchers.filter((voucher: any) => {
          const hotelDetailsId = Number(voucher.itinerary_plan_hotel_details_ID || 0);
          const confirmedHotelDetailsId = Number(voucher.confirmed_itinerary_plan_hotel_details_ID || 0);
          return (
            Number(voucher.hotel_id || 0) === Number(group.hotelId) ||
            group.hotelDetailsIds.includes(hotelDetailsId) ||
            group.confirmedHotelDetailsIds.includes(confirmedHotelDetailsId)
          );
        });
        const latestVoucher = matchedVouchers[0] || null;
        const policyCount = hotelCancellationPolicies.filter((policy: any) => Number(policy.hotel_id || 0) === Number(group.hotelId)).length;
        const voucherCancelled =
          matchedVouchers.some((voucher: any) => Number(voucher.hotel_voucher_cancellation_status || 0) === 1) ||
          Number(group.hotelCancellationStatus || 0) === 1;

        return {
          ...group,
          routeDates: [...group.routeDates].sort(),
          dayNumbers: [...group.dayNumbers].sort((a: number, b: number) => a - b),
          roomTypes: [...group.roomTypes].sort(),
          hasVoucher: matchedVouchers.length > 0,
          voucherCount: matchedVouchers.length,
          cancellationPolicyCount: policyCount,
          voucherCancelled,
          bookingStatusCode: Number(latestVoucher?.hotel_booking_status || 0),
          bookingStatusLabel: this.getVoucherStatusLabel(
            Number(latestVoucher?.hotel_booking_status || 0),
            voucherCancelled,
          ),
          confirmedBy: String(latestVoucher?.hotel_confirmed_by || ''),
          confirmedEmail: String(latestVoucher?.hotel_confirmed_email_id || ''),
          confirmedMobile: String(latestVoucher?.hotel_confirmed_mobile_no || ''),
          invoiceToCode: Number(latestVoucher?.invoice_to || 0),
          invoiceToLabel: this.getInvoiceToLabel(Number(latestVoucher?.invoice_to || 0)),
        };
      })
      .sort((a, b) => {
        const aDay = Number(a.dayNumbers?.[0] || 0);
        const bDay = Number(b.dayNumbers?.[0] || 0);
        return aDay - bDay || Number(a.hotelId || 0) - Number(b.hotelId || 0);
      });

    const vehicleVoucherGroups = vehicles.map((vehicle: any) => {
      const matchedVouchers = vehicleVouchers.filter((voucher: any) => {
        return (
          Number(voucher.confirmed_itinerary_plan_vendor_eligible_ID || 0) === Number(vehicle.confirmed_itinerary_plan_vendor_eligible_ID || 0) ||
          Number(voucher.itinerary_plan_vendor_eligible_ID || 0) === Number(vehicle.itinerary_plan_vendor_eligible_ID || 0)
        );
      });
      const latestVoucher = matchedVouchers[0] || null;
      const cancellationPolicyCount = vehicleCancellationPolicies.filter(
        (policy: any) =>
          Number(policy.vendor_id || 0) === Number(vehicle.vendor_id || 0) &&
          Number(policy.vendor_vehicle_type_id || 0) === Number(vehicle.vendor_vehicle_type_id || 0),
      ).length;
      const vendor = vendorById.get(Number(vehicle.vendor_id || 0));
      const branch = vendorBranchById.get(Number(vehicle.vendor_branch_id || 0));
      const vehicleTypeTitle = vehicleTypeById.get(Number(vehicle.vehicle_type_id || 0)) || 'N/A';
      const totalQty = Number(vehicle.total_vehicle_qty || 0);
      const totalAmount =
        totalQty > 0 && Number(vehicle.vehicle_grand_total || 0) > 0
          ? totalQty * Number(vehicle.vehicle_grand_total || 0)
          : totalQty * Number(vehicle.vehicle_total_amount || 0);

        return {
          vendorEligibleId: Number(vehicle.itinerary_plan_vendor_eligible_ID || 0),
          confirmedVendorEligibleId: Number(vehicle.confirmed_itinerary_plan_vendor_eligible_ID || 0),
        vehicleTypeId: Number(vehicle.vehicle_type_id || 0),
        vendorVehicleTypeId: Number(vehicle.vendor_vehicle_type_id || 0),
        vendorId: Number(vehicle.vendor_id || 0),
        vendorName: String(vendor?.vendor_name || 'N/A'),
        vendorEmail: String(branch?.vendor_branch_emailid || vendor?.vendor_email || ''),
        vendorBranchId: Number(vehicle.vendor_branch_id || 0),
        vendorBranchName: String(branch?.vendor_branch_name || 'N/A'),
        vehicleTypeTitle,
        vehicleOrigin: String(vehicle.vehicle_orign || '').trim(),
        totalQty,
        totalAmount,
        cancellationPolicyCount,
        hasVoucher: matchedVouchers.length > 0,
        voucherCount: matchedVouchers.length,
          bookingStatusCode: Number(latestVoucher?.vehicle_booking_status || 0),
          bookingStatusLabel: this.getVoucherStatusLabel(Number(latestVoucher?.vehicle_booking_status || 0), false),
          confirmedBy: String(latestVoucher?.vehicle_confirmed_by || ''),
          confirmedEmail: String(latestVoucher?.vehicle_confirmed_email_id || ''),
          confirmedMobile: String(latestVoucher?.vehicle_confirmed_mobile_no || ''),
          reservationNo: String(latestVoucher?.vehicle_confirmed_reservation || ''),
          verifiedBy: String(latestVoucher?.vehicle_confirmation_verified_by || ''),
          verifiedMobile: String(latestVoucher?.vehicle_confirmation_verified_mobile_no || ''),
          verifiedEmail: String(latestVoucher?.vehicle_confirmation_verified_email_id || ''),
          statusRemarks: String(latestVoucher?.vehicle_confirmation_status_remarks || ''),
          invoiceToCode: Number(latestVoucher?.invoice_to || 0),
          invoiceToLabel: this.getInvoiceToLabel(Number(latestVoucher?.invoice_to || 0)),
        };
      });

    return {
      summary: {
        itineraryPlanId,
        confirmedItineraryPlanId: Number(plan.confirmed_itinerary_plan_ID || 0),
        quotationNo: String(plan.itinerary_quote_ID || ''),
        itineraryPreference,
        shouldShowHotels,
        shouldShowVehicles,
        arrivalLocation: plan.arrival_location || '',
        departureLocation: plan.departure_location || '',
        tripStartDateTime: plan.trip_start_date_and_time,
        tripEndDateTime: plan.trip_end_date_and_time,
        noOfDays: Number(plan.no_of_days || 0),
        noOfNights: Number(plan.no_of_nights || 0),
        adults: Number(plan.total_adult || 0),
        children: Number(plan.total_children || 0),
        infants: Number(plan.total_infants || 0),
        roomCount: Number(plan.preferred_room_count || 0),
        extraBed: Number(plan.total_extra_bed || 0),
        childWithBed: Number(plan.total_child_with_bed || 0),
        childWithoutBed: Number(plan.total_child_without_bed || 0),
        existingHotelVoucherCount: hotelVouchers.length,
        existingVehicleVoucherCount: vehicleVouchers.length,
      },
      customer: {
        name: customer
          ? `${String(customer.customer_salutation || '').trim()} ${String(customer.customer_name || '').trim()}`.trim()
          : 'N/A',
        age: customer?.customer_age || null,
        contactNo: customer?.primary_contact_no || '',
        emailId: customer?.email_id || '',
      },
      hotelVoucherGroups,
      vehicleVoucherGroups,
    };
  }

  async getTransportVoucherDetails(itineraryPlanId: number): Promise<TransportVoucherDetails> {
    const plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
      where: { itinerary_plan_ID: itineraryPlanId, deleted: 0 },
    });

    if (!plan) {
      throw new NotFoundException('Confirmed itinerary plan not found');
    }

    const [
      customer,
      settings,
      routes,
      routeHotspots,
      eligibleRows,
      vehicleVouchers,
      vehicleTypes,
      vehicles,
      vehicleImages,
    ] = await Promise.all([
      this.prisma.dvi_confirmed_itinerary_customer_details.findFirst({
        where: { itinerary_plan_ID: itineraryPlanId, primary_customer: 1, deleted: 0 },
      }),
      this.prisma.dvi_global_settings.findFirst({
        where: { status: 1, deleted: 0 },
      }),
      this.prisma.dvi_confirmed_itinerary_route_details.findMany({
        where: { itinerary_plan_ID: itineraryPlanId, deleted: 0 },
        orderBy: [{ itinerary_route_date: 'asc' }, { itinerary_route_ID: 'asc' }],
      }),
      (this.prisma as any).dvi_confirmed_itinerary_route_hotspot_details.findMany({
        where: { itinerary_plan_ID: itineraryPlanId, deleted: 0, status: 1 },
        orderBy: [{ itinerary_route_ID: 'asc' }, { hotspot_order: 'asc' }, { route_hotspot_ID: 'asc' }],
      }),
      this.prisma.dvi_confirmed_itinerary_plan_vendor_eligible_list.findMany({
        where: {
          itinerary_plan_id: itineraryPlanId,
          deleted: 0,
          status: 1,
          itineary_plan_assigned_status: 1,
        },
        orderBy: [{ confirmed_itinerary_plan_vendor_eligible_ID: 'asc' }],
      }),
      this.prisma.dvi_confirmed_itinerary_plan_vehicle_voucher_details.findMany({
        where: { itinerary_plan_id: itineraryPlanId, deleted: 0 },
        orderBy: [{ updatedon: 'desc' }, { cnf_itinerary_plan_vehicle_voucher_details_ID: 'desc' }],
      }),
      this.prisma.dvi_vehicle_type.findMany({
        where: { deleted: 0 },
        select: { vehicle_type_id: true, vehicle_type_title: true, occupancy: true },
      }),
      this.prisma.dvi_vehicle.findMany({
        where: { deleted: 0 },
        select: {
          vehicle_id: true,
          vehicle_type_id: true,
          registration_number: true,
          insurance_policy_number: true,
        },
      }),
      this.prisma.dvi_vehicle_gallery_details.findMany({
        where: { deleted: 0, status: 1 },
        orderBy: [{ vehicle_id: 'asc' }, { vehicle_gallery_details_id: 'asc' }],
        select: { vehicle_id: true, vehicle_gallery_name: true },
      }),
    ]);

    const hotspotIds = Array.from(
      new Set(
        (routeHotspots as any[])
          .map((row: any) => Number(row.hotspot_ID || 0))
          .filter((id: number) => id > 0),
      ),
    );

    const hotspots = hotspotIds.length
      ? await this.prisma.dvi_hotspot_place.findMany({
          where: { hotspot_ID: { in: hotspotIds } as any, deleted: 0 },
          select: { hotspot_ID: true, hotspot_name: true },
        })
      : [];

    const vehicleTypeById = new Map<number, { title: string; occupancy: number }>();
    for (const row of vehicleTypes) {
      vehicleTypeById.set(Number(row.vehicle_type_id || 0), {
        title: String(row.vehicle_type_title || 'Vehicle'),
        occupancy: Number(row.occupancy || 0),
      });
    }

    const vehicleById = new Map<number, { registrationNumber: string; insurancePolicy: string; vehicleTypeId: number }>();
    for (const row of vehicles) {
      vehicleById.set(Number(row.vehicle_id || 0), {
        registrationNumber: String(row.registration_number || '').trim(),
        insurancePolicy: String(row.insurance_policy_number || '').trim(),
        vehicleTypeId: Number(row.vehicle_type_id || 0),
      });
    }

    const vehicleImageByVehicleId = new Map<number, string>();
    for (const row of vehicleImages) {
      const vehicleId = Number(row.vehicle_id || 0);
      const imageName = String(row.vehicle_gallery_name || '').trim();
      if (!vehicleId || !imageName || vehicleImageByVehicleId.has(vehicleId)) continue;
      vehicleImageByVehicleId.set(vehicleId, `/uploads/vehicle_gallery/${imageName}`);
    }

    const hotspotNameById = new Map<number, string>();
    for (const hotspot of hotspots) {
      hotspotNameById.set(Number(hotspot.hotspot_ID || 0), String(hotspot.hotspot_name || '').trim());
    }

    const eligibleIds = eligibleRows
      .map((row: any) => Number(row.confirmed_itinerary_plan_vendor_eligible_ID || row.itinerary_plan_vendor_eligible_ID || 0))
      .filter((id: number) => id > 0);

    const vehicleDetailRows = eligibleIds.length
      ? await this.prisma.$queryRawUnsafe(`
          SELECT
            itinerary_plan_vendor_eligible_ID,
            itinerary_route_id,
            itinerary_route_date,
            vehicle_id,
            itinerary_route_location_from,
            itinerary_route_location_to
          FROM dvi_itinerary_plan_vendor_vehicle_details
          WHERE itinerary_plan_id = ${Number(itineraryPlanId || 0)}
            AND deleted = 0
            AND itinerary_plan_vendor_eligible_ID IN (${eligibleIds.join(',')})
          ORDER BY itinerary_route_date ASC, itinerary_route_id ASC, itinerary_plan_vendor_vehicle_details_ID ASC
        `) as any[]
      : [];

    const vehicleDetailByRouteId = new Map<number, any>();
    const vehicleDetailByEligibleId = new Map<number, any>();
    for (const row of vehicleDetailRows) {
      const routeId = Number((row as any).itinerary_route_id || 0);
      if (routeId && !vehicleDetailByRouteId.has(routeId)) {
        vehicleDetailByRouteId.set(routeId, row);
      }

      const eligibleId = Number((row as any).itinerary_plan_vendor_eligible_ID || 0);
      if (eligibleId && !vehicleDetailByEligibleId.has(eligibleId)) {
        vehicleDetailByEligibleId.set(eligibleId, row);
      }
    }

    const eligibleById = new Map<number, any>();
    for (const row of eligibleRows as any[]) {
      const eligibleId = Number(row.confirmed_itinerary_plan_vendor_eligible_ID || row.itinerary_plan_vendor_eligible_ID || 0);
      if (!eligibleId || eligibleById.has(eligibleId)) continue;
      eligibleById.set(eligibleId, row);
    }

    const noVehiclePlaceholder = '/uploads/hd_vehicle_gallery/no_vehicle.jpg';
    const dedupeKeys = new Set<string>();
    const vehicleRowsSource = vehicleVouchers.length ? vehicleVouchers : eligibleRows;
    const vehiclesForVoucher = vehicleRowsSource
      .map((sourceRow: any) => {
        const eligibleId = Number(
          sourceRow.confirmed_itinerary_plan_vendor_eligible_ID
          || sourceRow.itinerary_plan_vendor_eligible_ID
          || 0,
        );
        const eligible = eligibleById.get(eligibleId) || sourceRow;
        const vehicleDetail = vehicleDetailByEligibleId.get(eligibleId) || null;
        const vehicleTypeId = Number(
          eligible?.vehicle_type_id
          || sourceRow?.vehicle_type_id
          || 0,
        );
        const vehicleId = Number(
          eligible?.vehicle_id
          || sourceRow?.vehicle_id
          || vehicleDetail?.vehicle_id
          || 0,
        );
        const dedupeKey = `${eligibleId || 0}:${vehicleTypeId || 0}:${vehicleId || 0}`;
        if (dedupeKeys.has(dedupeKey)) {
          return null;
        }
        dedupeKeys.add(dedupeKey);

        const vehicleType = vehicleTypeById.get(vehicleTypeId) || { title: 'Vehicle', occupancy: 0 };
        const vehicle = vehicleById.get(vehicleId) || null;
        const amountValue = Number(
          sourceRow?.total_amount
          || sourceRow?.vehicle_amount
          || eligible?.total_amount
          || eligible?.vehicle_amount
          || 0,
        );

        return {
          type: String(vehicleType.title || sourceRow?.vehicle_type_title || 'Vehicle').trim() || 'Vehicle',
          vehicleNo: String(vehicle?.registrationNumber || sourceRow?.vehicle_no || 'To be assigned').trim() || 'To be assigned',
          seatingCapacity: vehicleType.occupancy > 0 ? `${vehicleType.occupancy} Seater` : 'As per vehicle type',
          ac: 'Yes',
          luggageSpace: 'Adequate',
          insurance: vehicle?.insurancePolicy ? `Policy: ${vehicle.insurancePolicy}` : 'Comprehensive',
          imagePath: vehicleImageByVehicleId.get(vehicleId)
            || (vehicleId ? '/uploads/vehicle_gallery/no_vehicle.jpeg' : '')
            || noVehiclePlaceholder,
          vendorName: String(eligible?.vendor_name || sourceRow?.vendor_name || '').trim(),
          origin: String(
            eligible?.vehicle_origin
            || eligible?.origin
            || sourceRow?.vehicle_origin
            || sourceRow?.origin
            || '',
          ).trim(),
          qty: Number(sourceRow?.vehicle_count || eligible?.vehicle_count || sourceRow?.total_qty || eligible?.total_qty || 1) || 1,
          amount: amountValue > 0 ? `Rs. ${amountValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '',
          confirmedBy: String(sourceRow?.vehicle_confirmed_by || sourceRow?.confirmed_by || '').trim(),
          confirmedMobile: String(sourceRow?.vehicle_confirmed_mobile_no || sourceRow?.confirmed_mobile_no || '').trim(),
          confirmedEmail: String(sourceRow?.vehicle_confirmed_email_id || sourceRow?.confirmed_email_id || '').trim(),
        };
      })
      .filter(Boolean) as TransportVoucherDetails['vehicles'];

    const fallbackVehicle: TransportVoucherDetails['vehicle'] = {
      type: 'Vehicle',
      vehicleNo: 'To be assigned',
      seatingCapacity: 'As per vehicle type',
      ac: 'Yes',
      luggageSpace: 'Adequate',
      insurance: 'Comprehensive',
      imagePath: noVehiclePlaceholder,
    };
    const primaryVehicle = vehiclesForVoucher[0] || fallbackVehicle;
    const primaryEligibleId = Number(
      primaryVehicle && vehicleRowsSource.length
        ? (
            (vehicleRowsSource[0] as any)?.confirmed_itinerary_plan_vendor_eligible_ID
            || (vehicleRowsSource[0] as any)?.itinerary_plan_vendor_eligible_ID
            || 0
          )
        : 0,
    );
    const selectedVehicleVoucher = primaryEligibleId
      ? vehicleVouchers.find((voucher: any) => (
          Number(voucher.confirmed_itinerary_plan_vendor_eligible_ID || 0) === primaryEligibleId
          || Number(voucher.itinerary_plan_vendor_eligible_ID || 0) === primaryEligibleId
        ))
      : (vehicleVouchers[0] || null);

    const routeLocations = routes
      .map((route: any) => this.shortTransportLocationName(String(route.location_name || '').trim()))
      .filter(Boolean)
      .filter((value: string, index: number, arr: string[]) => arr.indexOf(value) === index);
    const departureLocation = this.shortTransportLocationName(
      String(plan.departure_location || routeLocations[routeLocations.length - 1] || '').trim(),
    );
    if (departureLocation && routeLocations[routeLocations.length - 1] !== departureLocation) {
      routeLocations.push(departureLocation);
    }

    const routeHotspotsByRouteId = new Map<number, any[]>();
    for (const row of routeHotspots as any[]) {
      const routeId = Number(row.itinerary_route_ID || 0);
      if (!routeId) continue;
      if (!routeHotspotsByRouteId.has(routeId)) {
        routeHotspotsByRouteId.set(routeId, []);
      }
      routeHotspotsByRouteId.get(routeId)!.push(row);
    }

    const days = routes.map((route: any, index: number) => {
      const routeId = Number(route.itinerary_route_ID || 0);
      const rows = routeHotspotsByRouteId.get(routeId) || [];
      const placeNames = Array.from(new Set(
        rows
          .map((row: any) => hotspotNameById.get(Number(row.hotspot_ID || 0)) || '')
          .map((value: string) => value.trim())
          .filter(Boolean),
      ));
      const vehicleDetail = vehicleDetailByRouteId.get(routeId);
      const fromLocation = this.shortTransportLocationName(String(
        vehicleDetail?.itinerary_route_location_from
        || route.location_name
        || plan.arrival_location
        || '',
      ).trim());
      const toLocation = this.shortTransportLocationName(String(
        vehicleDetail?.itinerary_route_location_to
        || route.next_visiting_location
        || routes[index + 1]?.location_name
        || departureLocation
        || fromLocation,
      ).trim());
      const routeDate = route.itinerary_route_date ? new Date(route.itinerary_route_date) : null;

      return {
        dayNo: index + 1,
        date: routeDate && !Number.isNaN(routeDate.getTime())
          ? routeDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
          : '--',
        weekday: routeDate && !Number.isNaN(routeDate.getTime())
          ? routeDate.toLocaleDateString('en-IN', { weekday: 'long' })
          : '--',
        routeAndPlaces: placeNames.length > 0
          ? placeNames.map((name: string) => this.decodeTransportHtml(name)).join(', ')
          : this.decodeTransportHtml(String(route.location_name || 'Sightseeing to be advised')),
        travelRoute: [fromLocation, toLocation].filter(Boolean).join(' - ') || 'Route to be advised',
        startTime: this.formatTime(route.route_start_time as any),
        endTime: this.formatTime(route.route_end_time as any),
      };
    });

    const fallbackVoucherNo = this.buildTransportVoucherNumber(itineraryPlanId, plan.createdon || new Date());
    const rawVoucherNo = String(selectedVehicleVoucher?.vehicle_confirmed_reservation || '').trim();
    const voucherNo = rawVoucherNo && rawVoucherNo.length > 3 ? rawVoucherNo : fallbackVoucherNo;

    const primaryGuestName = customer
      ? `${String(customer.customer_salutation || '').trim()} ${String(customer.customer_name || '').trim()}`.trim()
      : '';
    const guestName = primaryGuestName || 'Guest';
    const flightArrival = this.parseTransportFlightDetails(customer?.arrival_flight_details, customer?.arrival_date_and_time || plan.trip_start_date_and_time);
    const flightDeparture = this.parseTransportFlightDetails(customer?.departure_flight_details, customer?.departure_date_and_time || plan.trip_end_date_and_time);

    if (process.env.DEBUG_TRANSPORT_VOUCHER_VEHICLES === '1') {
      console.log('[TRANSPORT_VOUCHER_VEHICLES]', {
        itineraryPlanId,
        vehicleVoucherCount: vehicleVouchers.length,
        eligibleRowsCount: eligibleRows.length,
        vehiclesForVoucher: vehiclesForVoucher.map((vehicle) => ({
          type: vehicle.type,
          vehicleNo: vehicle.vehicleNo,
          qty: vehicle.qty,
          confirmedBy: vehicle.confirmedBy,
        })),
      });
    }

    return {
      voucher: {
        voucherNo,
        date: this.formatTransportVoucherDate(selectedVehicleVoucher?.updatedon || plan.updatedon || new Date()),
        title: String(plan.itinerary_quote_ID || `Plan ${itineraryPlanId}` || 'DVI Holidays Transport Voucher').trim(),
        dateRange: this.buildTransportDateRange(plan.trip_start_date_and_time, plan.trip_end_date_and_time),
      },
      company: {
        name: String(settings?.company_name || 'Doview Holidays India Pvt Ltd').trim() || 'Doview Holidays India Pvt Ltd',
        tagline: 'Travel Beyond Expectations',
        phone: String(settings?.company_contact_no || '9919911948').trim() || '9919911948',
        email: String(settings?.company_email_id || 'vsr@dvi.co.in').trim() || 'vsr@dvi.co.in',
        website: 'www.dvi.travel',
        logoPath: settings?.company_logo ? `/uploads/logo/${String(settings.company_logo).trim()}` : '/uploads/logo/logo.png',
        qrText: `Transport Voucher ${voucherNo}`,
      },
      guest: {
        name: guestName,
        pax: this.buildPassengerMixLabel(
          Number(plan.total_adult || 0),
          Number(plan.total_children || 0),
          Number(plan.total_infants || 0),
        ),
        contactNo: String(customer?.primary_contact_no || '').trim() || '--',
        email: String(customer?.email_id || '').trim() || '--',
        pickupLocation: this.shortTransportLocationName(String(plan.arrival_location || routeLocations[0] || '').trim()) || 'To be advised',
        dropLocation: departureLocation || 'To be advised',
      },
      trip: {
        tourType: 'Private',
        travelRegion: routeLocations.length > 0 ? routeLocations.join(' - ') : 'Travel region to be advised',
        checkInDate: this.formatTransportVoucherDate(plan.trip_start_date_and_time),
        checkOutDate: this.formatTransportVoucherDate(plan.trip_end_date_and_time),
        duration: `${Number(plan.no_of_days || 0)} Days / ${Number(plan.no_of_nights || 0)} Nights`,
        earlyArrivalPreferenceMessage: getTransportEarlyArrivalMessage(
          (plan as any).transport_early_arrival_option,
        ),
      },
        flight: {
          arrival: flightArrival,
          departure: flightDeparture,
        },
        vehicle: primaryVehicle,
        vehicles: vehiclesForVoucher.length ? vehiclesForVoucher : [primaryVehicle],
        days,
      footer: {
        inclusions: [
          'Private vehicle as mentioned above',
          'Fuel, driver allowance, toll and parking',
          'Driver accommodation and meals',
          'All transfers and sightseeing as per itinerary',
        ],
        notes: [
          'This voucher is valid only for the dates mentioned above.',
          'Itinerary is subject to change due to weather, traffic or unforeseen circumstances.',
          'Please carry a valid ID proof during travel.',
          'Please be ready 10 minutes before the scheduled start time.',
        ],
        emergencyPhone: String(settings?.company_contact_no || '9919911948').trim() || '9919911948',
        emergencyEmail: String(settings?.company_email_id || 'vsr@dvi.co.in').trim() || 'vsr@dvi.co.in',
      },
    };
  }

}
