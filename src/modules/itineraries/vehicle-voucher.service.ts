import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { VehicleVoucherEmailNotifierService } from './services/vehicle-voucher-email-notifier.service';

export interface AddVehicleCancellationPolicyDto {
  itineraryPlanId: number;
  vendorId: number;
  vendorVehicleTypeId: number;
  cancellationDate: string;
  cancellationPercentage: number;
  description: string;
}

export interface CreateVehicleVoucherDto {
  itineraryPlanId: number;
  vouchers: Array<{
    vendorEligibleId?: number;
    confirmedVendorEligibleId?: number;
    vehicleTypeId: number;
    vendorVehicleTypeId: number;
    vendorId: number;
    vendorBranchId: number;
    totalVehicleQty: number;
    grandTotal: number;
    confirmedBy: string;
    emailId: string;
    mobileNumber: string;
    status: string;
    invoiceTo: string;
    voucherTermsCondition: string;
  }>;
}

export interface UpdateVehicleVoucherConfirmationDto {
  reservationNo: string;
  verifiedBy: string;
  verifiedMobileNo: string;
  verifiedEmailId?: string;
  bookingStatus: number;
  statusRemarks?: string;
}

@Injectable()
export class VehicleVoucherService {
  private readonly logger = new Logger(VehicleVoucherService.name);

  constructor(
    private prisma: PrismaService,
    private readonly vehicleVoucherEmailNotifier: VehicleVoucherEmailNotifierService,
  ) {}

  async getAllCancellationPolicies(itineraryPlanId: number) {
    const policies = await this.prisma.dvi_confirmed_itinerary_plan_vehicle_cancellation_policy.findMany({
      where: {
        itinerary_plan_id: itineraryPlanId,
        deleted: 0,
      },
      orderBy: [{ vendor_id: 'asc' }, { vendor_vehicle_type_id: 'asc' }, { cancellation_date: 'asc' }],
    });

    if (!policies.length) {
      return [];
    }

    const vendorIds = Array.from(new Set(policies.map((p) => Number(p.vendor_id || 0)).filter((id) => id > 0)));
    const vehicleTypeIds = Array.from(
      new Set(policies.map((p) => Number(p.vendor_vehicle_type_id || 0)).filter((id) => id > 0)),
    );

    const [vendors, vehicleTypes] = await Promise.all([
      vendorIds.length > 0
        ? this.prisma.dvi_vendor_details.findMany({
            where: { vendor_id: { in: vendorIds } as any },
            select: { vendor_id: true, vendor_name: true },
          })
        : Promise.resolve([] as any[]),
      vehicleTypeIds.length > 0
        ? this.prisma.dvi_vehicle_type.findMany({
            where: { vehicle_type_id: { in: vehicleTypeIds } as any },
            select: { vehicle_type_id: true, vehicle_type_title: true },
          })
        : Promise.resolve([] as any[]),
    ]);

    const vendorNameById = new Map<number, string>();
    vendors.forEach((vendor: any) => {
      vendorNameById.set(Number(vendor.vendor_id), String(vendor.vendor_name || ''));
    });

    const vehicleTypeById = new Map<number, string>();
    vehicleTypes.forEach((vehicleType: any) => {
      vehicleTypeById.set(Number(vehicleType.vehicle_type_id), String(vehicleType.vehicle_type_title || ''));
    });

    return policies.map((policy) => ({
      id: policy.cnf_itinerary_plan_vehicle_cancellation_policy_ID,
      vendorId: policy.vendor_id,
      vendorName: vendorNameById.get(Number(policy.vendor_id)) || '',
      vendorVehicleTypeId: policy.vendor_vehicle_type_id,
      vehicleTypeName: vehicleTypeById.get(Number(policy.vendor_vehicle_type_id)) || '',
      cancellationDate: policy.cancellation_date?.toISOString().split('T')[0],
      cancellationPercentage: policy.cancellation_percentage,
      description: policy.cancellation_descrption || '',
      itineraryPlanId: policy.itinerary_plan_id,
    }));
  }

  async getVehicleCancellationPolicies(itineraryPlanId: number, vendorId: number, vendorVehicleTypeId: number) {
    const policies = await this.prisma.dvi_confirmed_itinerary_plan_vehicle_cancellation_policy.findMany({
      where: {
        itinerary_plan_id: itineraryPlanId,
        vendor_id: vendorId,
        vendor_vehicle_type_id: vendorVehicleTypeId,
        deleted: 0,
      },
      orderBy: {
        cancellation_date: 'asc',
      },
    });

    return policies.map((policy) => ({
      id: policy.cnf_itinerary_plan_vehicle_cancellation_policy_ID,
      vendorId: policy.vendor_id,
      vendorVehicleTypeId: policy.vendor_vehicle_type_id,
      cancellationDate: policy.cancellation_date?.toISOString().split('T')[0],
      cancellationPercentage: policy.cancellation_percentage,
      description: policy.cancellation_descrption || '',
      itineraryPlanId: policy.itinerary_plan_id,
    }));
  }

  async addCancellationPolicy(dto: AddVehicleCancellationPolicyDto, userId: number = 1) {
    this.logger.log(
      `Adding vehicle cancellation policy for vendor ${dto.vendorId} / type ${dto.vendorVehicleTypeId} in plan ${dto.itineraryPlanId}`,
    );

    const existing = await this.prisma.dvi_confirmed_itinerary_plan_vehicle_cancellation_policy.findFirst({
      where: {
        itinerary_plan_id: dto.itineraryPlanId,
        vendor_id: dto.vendorId,
        vendor_vehicle_type_id: dto.vendorVehicleTypeId,
        cancellation_date: new Date(dto.cancellationDate),
      },
    });

    const policy = existing
      ? await this.prisma.dvi_confirmed_itinerary_plan_vehicle_cancellation_policy.update({
          where: {
            cnf_itinerary_plan_vehicle_cancellation_policy_ID:
              existing.cnf_itinerary_plan_vehicle_cancellation_policy_ID,
          },
          data: {
            cancellation_descrption: dto.description,
            cancellation_percentage: dto.cancellationPercentage,
            updatedon: new Date(),
            status: 1,
            deleted: 0,
          },
        })
      : await this.prisma.dvi_confirmed_itinerary_plan_vehicle_cancellation_policy.create({
          data: {
            itinerary_plan_id: dto.itineraryPlanId,
            vendor_id: dto.vendorId,
            vendor_vehicle_type_id: dto.vendorVehicleTypeId,
            cancellation_date: new Date(dto.cancellationDate),
            cancellation_percentage: dto.cancellationPercentage,
            cancellation_descrption: dto.description,
            createdby: userId,
            createdon: new Date(),
            updatedon: new Date(),
            status: 1,
            deleted: 0,
          },
        });

    return {
      success: true,
      data: {
        id: policy.cnf_itinerary_plan_vehicle_cancellation_policy_ID,
        vendorId: policy.vendor_id,
        vendorVehicleTypeId: policy.vendor_vehicle_type_id,
        cancellationDate: policy.cancellation_date?.toISOString().split('T')[0],
        cancellationPercentage: policy.cancellation_percentage,
        description: policy.cancellation_descrption || '',
        itineraryPlanId: policy.itinerary_plan_id,
      },
    };
  }

  async deleteCancellationPolicy(policyId: number) {
    const policy = await this.prisma.dvi_confirmed_itinerary_plan_vehicle_cancellation_policy.findUnique({
      where: {
        cnf_itinerary_plan_vehicle_cancellation_policy_ID: policyId,
      },
    });

    if (!policy) {
      throw new NotFoundException('Vehicle cancellation policy not found');
    }

    await this.prisma.dvi_confirmed_itinerary_plan_vehicle_cancellation_policy.update({
      where: {
        cnf_itinerary_plan_vehicle_cancellation_policy_ID: policyId,
      },
      data: {
        deleted: 1,
        updatedon: new Date(),
      },
    });

    return { success: true };
  }

  async getVehicleVoucher(itineraryPlanId: number, vendorEligibleId: number) {
    const voucher = await this.prisma.dvi_confirmed_itinerary_plan_vehicle_voucher_details.findFirst({
      where: {
        itinerary_plan_id: itineraryPlanId,
        OR: [
          { itinerary_plan_vendor_eligible_ID: vendorEligibleId },
          { confirmed_itinerary_plan_vendor_eligible_ID: vendorEligibleId },
        ],
        deleted: 0,
      },
      orderBy: [{ updatedon: 'desc' }, { cnf_itinerary_plan_vehicle_voucher_details_ID: 'desc' }],
    });

    if (!voucher) {
      return null;
    }

    const invoiceToMap: Record<number, string> = {
      1: 'gst_bill_against_dvi',
      2: 'hotel_direct',
      3: 'agent',
    };

    const statusMap: Record<number, string> = {
      4: 'confirmed',
      6: 'cancelled',
      1: 'pending',
      0: 'pending',
    };

    return {
      id: voucher.cnf_itinerary_plan_vehicle_voucher_details_ID,
      itineraryPlanId: voucher.itinerary_plan_id,
      vendorEligibleId: voucher.itinerary_plan_vendor_eligible_ID,
      confirmedVendorEligibleId: voucher.confirmed_itinerary_plan_vendor_eligible_ID,
      vendorId: voucher.vendor_id,
      vendorBranchId: voucher.vendor_branch_id,
      vehicleTypeId: voucher.vehicle_type_id,
      confirmedBy: voucher.vehicle_confirmed_by || '',
      emailId: voucher.vehicle_confirmed_email_id || '',
      mobileNumber: voucher.vehicle_confirmed_mobile_no || '',
      status: statusMap[voucher.vehicle_booking_status] || 'pending',
      invoiceTo: invoiceToMap[voucher.invoice_to] || 'gst_bill_against_dvi',
      voucherTermsCondition: voucher.vehicle_voucher_terms_condition || '',
      reservationNo: voucher.vehicle_confirmed_reservation || '',
      verifiedBy: voucher.vehicle_confirmation_verified_by || '',
      verifiedMobileNo: voucher.vehicle_confirmation_verified_mobile_no || '',
      verifiedEmailId: voucher.vehicle_confirmation_verified_email_id || '',
      statusRemarks: voucher.vehicle_confirmation_status_remarks || '',
      bookingStatusCode: Number(voucher.vehicle_booking_status || 0),
    };
  }

  async createVehicleVouchers(dto: CreateVehicleVoucherDto, userId: number = 1) {
    this.logger.log(`Creating ${dto.vouchers.length} vehicle voucher(s) for plan ${dto.itineraryPlanId}`);

    const invoiceToMap: Record<string, number> = {
      gst_bill_against_dvi: 1,
      hotel_direct: 2,
      agent: 3,
    };

    const statusMap: Record<string, number> = {
      confirmed: 4,
      cancelled: 6,
      pending: 1,
    };

    const persisted: number[] = [];

    for (const voucher of dto.vouchers) {
      const vendorEligibleId = Number(voucher.vendorEligibleId || 0);
      const confirmedVendorEligibleId = Number(voucher.confirmedVendorEligibleId || 0);

      const existing = await this.prisma.dvi_confirmed_itinerary_plan_vehicle_voucher_details.findFirst({
        where: {
          itinerary_plan_id: dto.itineraryPlanId,
          deleted: 0,
          OR: [
            ...(vendorEligibleId > 0 ? [{ itinerary_plan_vendor_eligible_ID: vendorEligibleId }] : []),
            ...(confirmedVendorEligibleId > 0
              ? [{ confirmed_itinerary_plan_vendor_eligible_ID: confirmedVendorEligibleId }]
              : []),
          ],
        },
        orderBy: [{ updatedon: 'desc' }, { cnf_itinerary_plan_vehicle_voucher_details_ID: 'desc' }],
      });

      const payload = {
        confirmed_itinerary_plan_vendor_eligible_ID: confirmedVendorEligibleId,
        itinerary_plan_vendor_eligible_ID: vendorEligibleId,
        itinerary_plan_id: dto.itineraryPlanId,
        vehicle_type_id: voucher.vehicleTypeId,
        vendor_id: voucher.vendorId,
        vendor_branch_id: voucher.vendorBranchId,
        vehicle_confirmed_by: voucher.confirmedBy,
        vehicle_confirmed_email_id: voucher.emailId,
        vehicle_confirmed_mobile_no: voucher.mobileNumber,
        invoice_to: invoiceToMap[voucher.invoiceTo] || 1,
        vehicle_booking_status: statusMap[voucher.status] || 1,
        vehicle_voucher_terms_condition: voucher.voucherTermsCondition,
        updatedon: new Date(),
        status: 1,
        deleted: 0,
      };

      const record = existing
        ? await this.prisma.dvi_confirmed_itinerary_plan_vehicle_voucher_details.update({
            where: {
              cnf_itinerary_plan_vehicle_voucher_details_ID:
                existing.cnf_itinerary_plan_vehicle_voucher_details_ID,
            },
            data: payload,
          })
        : await this.prisma.dvi_confirmed_itinerary_plan_vehicle_voucher_details.create({
            data: {
              ...payload,
              vehicle_id: 0,
              createdby: userId,
              createdon: new Date(),
            },
          });

      persisted.push(record.cnf_itinerary_plan_vehicle_voucher_details_ID);
    }

    return {
      success: true,
      message: `Successfully created ${persisted.length} vehicle voucher(s)`,
      ids: persisted,
    };
  }

  async updateVehicleVoucherConfirmation(
    itineraryPlanId: number,
    vendorEligibleId: number,
    dto: UpdateVehicleVoucherConfirmationDto,
  ) {
    const voucher = await this.prisma.dvi_confirmed_itinerary_plan_vehicle_voucher_details.findFirst({
      where: {
        itinerary_plan_id: itineraryPlanId,
        deleted: 0,
        OR: [
          { itinerary_plan_vendor_eligible_ID: vendorEligibleId },
          { confirmed_itinerary_plan_vendor_eligible_ID: vendorEligibleId },
        ],
      },
      orderBy: [{ updatedon: 'desc' }, { cnf_itinerary_plan_vehicle_voucher_details_ID: 'desc' }],
    });

    if (!voucher) {
      throw new NotFoundException('Vehicle voucher not found for confirmation update');
    }

    const updated = await this.prisma.dvi_confirmed_itinerary_plan_vehicle_voucher_details.update({
      where: {
        cnf_itinerary_plan_vehicle_voucher_details_ID: voucher.cnf_itinerary_plan_vehicle_voucher_details_ID,
      },
      data: {
        vehicle_confirmed_reservation: dto.reservationNo,
        vehicle_confirmation_verified_by: dto.verifiedBy,
        vehicle_confirmation_verified_mobile_no: dto.verifiedMobileNo,
        vehicle_confirmation_verified_email_id: dto.verifiedEmailId || '',
        vehicle_booking_status: Number(dto.bookingStatus || 0),
        vehicle_confirmation_status_remarks: dto.statusRemarks || '',
        updatedon: new Date(),
      },
    });

    void this.vehicleVoucherEmailNotifier
      .sendVehicleConfirmationNotifications(itineraryPlanId, vendorEligibleId)
      .catch((error) => {
        this.logger.error(
          `Vehicle confirmation email side effect failed for itinerary ${itineraryPlanId}, vendorEligible ${vendorEligibleId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    return {
      success: true,
      message: 'Vehicle voucher confirmation updated successfully',
      data: {
        id: updated.cnf_itinerary_plan_vehicle_voucher_details_ID,
        reservationNo: updated.vehicle_confirmed_reservation || '',
        verifiedBy: updated.vehicle_confirmation_verified_by || '',
        verifiedMobileNo: updated.vehicle_confirmation_verified_mobile_no || '',
        verifiedEmailId: updated.vehicle_confirmation_verified_email_id || '',
        bookingStatusCode: Number(updated.vehicle_booking_status || 0),
        statusRemarks: updated.vehicle_confirmation_status_remarks || '',
      },
    };
  }

  async getDefaultVoucherTerms(): Promise<string> {
    const settings = await this.prisma.dvi_global_settings.findFirst({
      where: { status: 1 },
    });

    return (
      settings?.vehicle_voucher_terms_condition ||
      'Standard vehicle voucher terms and conditions apply.'
    );
  }
}
