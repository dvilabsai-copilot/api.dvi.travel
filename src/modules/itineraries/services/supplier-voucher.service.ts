import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';
import { OfflineHotelBookingDetailsDto } from '../dto/offline-hotel-booking.dto';
import { ConfirmSupplierVoucherDto } from '../dto/supplier-voucher.dto';
import { HotelBlockEmailService } from './hotel-block-email.service';
import {
  isProviderHotelVoucher, linkedVoucherEmail, readSupplierVoucherScope, supplierVoucherLink,
  SupplierVoucherScope, unavailableVoucher, voucherEmailAddresses, voucherRecipientHash,
} from './supplier-voucher-links';

type OfflineScope = Extract<SupplierVoucherScope, { kind: 'offline-hotel' }>;
type VehicleScope = Extract<SupplierVoucherScope, { kind: 'vehicle' }>;

@Injectable()
export class SupplierVoucherService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: HotelBlockEmailService,
  ) {}

  private async planSummary(planId: number, kind: SupplierVoucherScope['kind']) {
    const travelFields = { itinerary_quote_ID: true, trip_start_date_and_time: true, trip_end_date_and_time: true } as const;
    const [plan, cancelled, revision] = await Promise.all([
      this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
        where: { itinerary_plan_ID: planId, status: 1, deleted: 0 },
        orderBy: { confirmed_itinerary_plan_ID: 'desc' },
        select: { ...travelFields, itinerary_cancellation_status: true },
      }),
      this.prisma.dvi_cancelled_itineraries.findFirst({
        where: { itinerary_plan_id: planId, status: 1, deleted: 0,
          cancellation_status: 'completed', ...(kind === 'vehicle' ? { modify_vehicle: 1 } : { modify_hotel: 1 }) },
        select: { cancelled_itinerary_ID: true },
      }),
      this.prisma.dvi_itinerary_quote_revision.findUnique({
        where: { plan_id: planId }, select: { status: true, superseded_at: true },
      }),
    ]);
    if (cancelled || plan?.itinerary_cancellation_status === 1 ||
      (revision && (revision.status !== 'READY' || revision.superseded_at))) throw unavailableVoucher();
    const active = plan ?? await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: planId, deleted: 0 },
      select: travelFields,
    });
    if (!active) throw unavailableVoucher();
    return {
      reference: active.itinerary_quote_ID || String(planId),
      startDate: active.trip_start_date_and_time?.toISOString().slice(0, 10),
      endDate: active.trip_end_date_and_time?.toISOString().slice(0, 10),
    };
  }

  private async offlineBooking(scope: OfflineScope) {
    const where = {
      itinerary_plan_id: scope.planId,
      group_type: scope.groupType,
      route_id: scope.routeId,
      hotel_key: scope.hotelKey,
      check_in: new Date(scope.checkIn),
      check_out: new Date(scope.checkOut),
      version: scope.version,
    };
    const [booking, route] = await Promise.all([
      this.prisma.dvi_itinerary_offline_hotel_booking.findFirst({ where }),
      this.prisma.dvi_itinerary_route_details.findFirst({
        where: { itinerary_plan_ID: scope.planId, itinerary_route_ID: scope.routeId, deleted: 0,
          itinerary_route_date: { gte: where.check_in, lt: where.check_out } },
        select: { itinerary_route_ID: true },
      }),
    ]);
    const details = booking?.details as unknown as OfflineHotelBookingDetailsDto | undefined;
    if (!route || !details || details.status === 'cancelled') throw unavailableVoucher();
    return { where, details, savedDetails: booking!.details as Prisma.JsonObject };
  }

  private async vehicleBooking(planId: number, voucherId: number, version?: number) {
    const where = {
      cnf_itinerary_plan_vehicle_voucher_details_ID: voucherId,
      itinerary_plan_id: planId,
      supplier_confirmation_version: version,
      status: 1,
      deleted: 0,
      vehicle_booking_status: { in: [1, 2, 3, 4, 5] },
    };
    const voucher = await this.prisma.dvi_confirmed_itinerary_plan_vehicle_voucher_details.findFirst({ where });
    if (!voucher) throw unavailableVoucher();
    return voucher;
  }

  private async vehicleSummary(voucher: Awaited<ReturnType<SupplierVoucherService['vehicleBooking']>>) {
    const [vendor, type] = await Promise.all([
      this.prisma.dvi_vendor_details.findFirst({
        where: { vendor_id: voucher.vendor_id }, select: { vendor_name: true },
      }),
      this.prisma.dvi_vehicle_type.findFirst({
        where: { vehicle_type_id: voucher.vehicle_type_id }, select: { vehicle_type_title: true },
      }),
    ]);
    return {
      supplierName: vendor?.vendor_name || 'Transport supplier',
      vehicleType: type?.vehicle_type_title || 'Vehicle',
    };
  }

  async sendVehicleVoucher(planId: number, voucherId: number) {
    if (!this.email.isDispatchEnabled()) throw new ServiceUnavailableException('Voucher email delivery is disabled.');
    const [voucher, { reference, startDate, endDate }] = await Promise.all([this.vehicleBooking(planId, voucherId), this.planSummary(planId, 'vehicle')]);
    const recipients = voucherEmailAddresses(voucher.vehicle_confirmed_email_id);
    if (!recipients.length) throw new BadRequestException('Save a supplier email before sending the voucher.');
    const { supplierName, vehicleType } = await this.vehicleSummary(voucher);
    const url = supplierVoucherLink({ kind: 'vehicle', planId, voucherId, version: voucher.supplier_confirmation_version });
    const outcome = await this.email.dispatchOfflineVoucher(recipients, linkedVoucherEmail(
      'DVi Travel | Vehicle Voucher | ' + reference,
      [supplierName, vehicleType, 'Booking ' + reference, [startDate, endDate].filter(Boolean).join(' to ')].filter(Boolean).join(' · '),
      url,
      voucher.vehicle_booking_status < 4 ? 'Confirm Book' : 'View Voucher',
    ), undefined, true);
    return { status: outcome.demo ? 'demo' : outcome.partial ? 'partial' : 'sent' };
  }

  async open(token: string) {
    const scope = readSupplierVoucherScope(token);
    const { reference, startDate, endDate } = await this.planSummary(scope.planId, scope.kind);
    if (scope.kind === 'offline-hotel') {
      const { details } = await this.offlineBooking(scope);
      return {
        kind: 'hotel' as const, reference, supplierName: scope.hotelName, status: details.status,
        canConfirm: details.status === 'pending',
        stays: [{ checkIn: scope.checkIn, checkOut: scope.checkOut, roomCount: details.rooms.reduce((total, room) => total + room.quantity, 0) }],
        rooms: details.rooms,
        cancellationPolicies: details.cancellationPolicies,
      };
    }
    if (scope.kind === 'vehicle') {
      const voucher = await this.vehicleBooking(scope.planId, scope.voucherId, scope.version);
      return {
        kind: 'vehicle' as const, reference, startDate, endDate, ...await this.vehicleSummary(voucher),
        status: ({ 1: 'pending', 2: 'waitlisted', 3: 'blocked', 4: 'confirmed', 5: 'sold out' })[voucher.vehicle_booking_status],
        canConfirm: voucher.vehicle_booking_status < 4, reservationNo: voucher.vehicle_confirmed_reservation,
      };
    }
    const [hotel, stays] = await Promise.all([
      this.prisma.dvi_hotel.findFirst({ where: { hotel_id: scope.hotelId }, select: { hotel_name: true, hotel_email: true } }),
      this.prisma.dvi_confirmed_itinerary_plan_hotel_details.findMany({
        where: {
          itinerary_plan_id: scope.planId, hotel_id: scope.hotelId, status: 1, deleted: 0, hotel_cancellation_status: 0,
          confirmed_itinerary_plan_hotel_details_ID: { in: scope.stayIds },
        },
        orderBy: { hotel_check_in_date: 'asc' },
        select: { hotel_check_in_date: true, hotel_check_out_date: true, total_no_of_rooms: true, hotel_provider: true },
      }),
    ]);
    if (stays.length !== scope.stayIds.length || stays.some((stay) => !isProviderHotelVoucher(stay.hotel_provider)) || !voucherEmailAddresses(hotel?.hotel_email).some(
      (email) => voucherRecipientHash(email) === scope.recipientHash,
    )) throw unavailableVoucher();
    return {
      kind: 'hotel' as const, reference, supplierName: hotel!.hotel_name || 'Hotel', status: 'confirmed', canConfirm: false,
      stays: stays.map((stay) => ({
        checkIn: stay.hotel_check_in_date?.toISOString().slice(0, 10),
        checkOut: stay.hotel_check_out_date?.toISOString().slice(0, 10),
        roomCount: stay.total_no_of_rooms,
      })),
    };
  }

  async confirm(input: ConfirmSupplierVoucherDto) {
    const scope = readSupplierVoucherScope(input.token);
    if (scope.kind === 'provider-hotel') throw unavailableVoucher();
    await this.planSummary(scope.planId, scope.kind);
    const confirmedBy = input.confirmedBy.trim();
    const phone = input.phone.trim();
    const reservationNo = input.reservationNo?.trim();
    if (scope.kind === 'offline-hotel') {
      const { details, where, savedDetails } = await this.offlineBooking(scope);
      if (details.status !== 'pending') throw unavailableVoucher();
      if (!reservationNo) throw new BadRequestException('Enter the reservation number.');
      const email = input.email?.trim();
      if (!email) throw new BadRequestException('Enter the hotel email.');
      const hotelResponse = {
        status: 'confirmed',
        reservationNumber: reservationNo,
        verifiedBy: confirmedBy,
        phone,
        email,
        remarks: input.remarks?.trim() ?? '',
        submittedAt: new Date().toISOString(),
      };
      const result = await this.prisma.dvi_itinerary_offline_hotel_booking.updateMany({
        where,
        data: { details: { ...savedDetails, status: 'confirmed', hotelResponse }, version: { increment: 1 }, updated_by: 0 },
      });
      if (result.count !== 1) throw unavailableVoucher();
    } else {
      if (!reservationNo) throw new BadRequestException('Enter the reservation number.');
      await this.confirmVehicle(scope, reservationNo, confirmedBy, phone);
    }
    return { confirmed: true };
  }

  private async confirmVehicle(scope: VehicleScope, reservationNo: string, confirmedBy: string, phone: string) {
    const result = await this.prisma.dvi_confirmed_itinerary_plan_vehicle_voucher_details.updateMany({
      where: {
        cnf_itinerary_plan_vehicle_voucher_details_ID: scope.voucherId, itinerary_plan_id: scope.planId,
        supplier_confirmation_version: scope.version, status: 1, deleted: 0, vehicle_booking_status: { in: [1, 2, 3] },
      },
      data: {
        vehicle_confirmed_reservation: reservationNo, vehicle_confirmation_verified_by: confirmedBy,
        vehicle_confirmation_verified_mobile_no: phone, vehicle_booking_status: 4,
        supplier_confirmation_version: { increment: 1 }, updatedon: new Date(),
      },
    });
    if (result.count !== 1) throw unavailableVoucher();
  }
}
