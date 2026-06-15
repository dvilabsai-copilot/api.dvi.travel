import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { PrismaService } from '../../../prisma.service';

type VehicleVoucherEmailContext = {
  itineraryPlanId: number;
  vendorEligibleId: number;
  vendorName: string;
  vehicleType: string;
  reservationNo: string;
  verifiedBy: string;
  verifiedMobileNo: string;
  verifiedEmailId: string;
  bookingStatusLabel: string;
  vendorEmails: string[];
  travelExpertEmail: string[];
  accountsEmails: string[];
  defaultVehicleEmails: string[];
  ccEmails: string[];
  companyName: string;
  companyAddress: string;
  companyPincode: string;
  companyContactNo: string;
  companyEmailId: string;
  siteTitle: string;
};

@Injectable()
export class VehicleVoucherEmailNotifierService {
  private readonly logger = new Logger(VehicleVoucherEmailNotifierService.name);
  private transporter: Transporter | null = null;
  private warnedDisabled = false;
  private warnedConfig = false;

  constructor(private readonly prisma: PrismaService) {}

  private isEnabled(): boolean {
    const value = String(process.env.VEHICLE_VOUCHER_MAIL_ENABLED ?? 'false').toLowerCase();
    return value === '1' || value === 'true' || value === 'yes';
  }

  private parseEmails(value?: string | null): string[] {
    return String(value || '')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => !!v);
  }

  private uniqueEmails(values: Array<string | null | undefined>): string[] {
    return Array.from(
      new Set(
        values
          .map((value) => String(value || '').trim())
          .filter((value) => !!value),
      ),
    );
  }

  private getTransporter(): Transporter | null {
    if (!this.isEnabled()) {
      if (!this.warnedDisabled) {
        this.logger.warn('Vehicle voucher email notifier disabled via VEHICLE_VOUCHER_MAIL_ENABLED');
        this.warnedDisabled = true;
      }
      return null;
    }

    if (this.transporter) return this.transporter;

    const host = String(process.env.VEHICLE_VOUCHER_MAIL_HOST || '').trim();
    const port = Number(process.env.VEHICLE_VOUCHER_MAIL_PORT || 587);
    const secure = String(process.env.VEHICLE_VOUCHER_MAIL_SECURE || 'false').toLowerCase() === 'true';
    const user = String(process.env.VEHICLE_VOUCHER_MAIL_USER || '').trim();
    const pass = String(process.env.VEHICLE_VOUCHER_MAIL_PASS || '').trim();

    if (!host || !user || !pass) {
      if (!this.warnedConfig) {
        this.logger.warn('Vehicle voucher mail config incomplete (VEHICLE_VOUCHER_MAIL_HOST/USER/PASS)');
        this.warnedConfig = true;
      }
      return null;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });

    return this.transporter;
  }

  private getStatusLabel(status: number): string {
    switch (Number(status || 0)) {
      case 1:
        return 'Awaiting';
      case 2:
        return 'Waiting List';
      case 3:
        return 'Blocked';
      case 4:
        return 'Confirmed';
      case 5:
        return 'Sold Out';
      case 6:
        return 'Cancelled';
      default:
        return 'Unknown';
    }
  }

  private renderHtml(title: string, intro: string, context: VehicleVoucherEmailContext): string {
    const rows = [
      ['Vehicle Type', context.vehicleType],
      ['Vendor Name', context.vendorName],
      ['Reservation No', context.reservationNo],
      ['Verified By', context.verifiedBy],
      ['Mobile No', context.verifiedMobileNo],
      ['Email', context.verifiedEmailId || '-'],
      ['Status', context.bookingStatusLabel],
    ]
      .map(
        ([label, value]) =>
          `<tr><th align="left" style="padding:8px;border:1px solid #d7d7d7;background:#faf7ff">${label}</th><td style="padding:8px;border:1px solid #d7d7d7">${String(value || '-')}</td></tr>`,
      )
      .join('');

    return `
      <div style="font-family:Arial,sans-serif;color:#2d3142;max-width:720px;margin:0 auto">
        <h2 style="color:#4a4260;margin-bottom:8px">${title}</h2>
        <p style="margin:0 0 18px 0;line-height:1.5">${intro}</p>
        <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin-bottom:20px">
          ${rows}
        </table>
        <p style="margin:0 0 6px 0;font-weight:600">${context.companyName}</p>
        <p style="margin:0;line-height:1.5">
          ${context.companyContactNo || '-'} | ${context.companyEmailId || '-'}<br />
          ${context.companyAddress || '-'}${context.companyPincode ? ` - ${context.companyPincode}` : ''}
        </p>
      </div>
    `;
  }

  private renderText(title: string, intro: string, context: VehicleVoucherEmailContext): string {
    return [
      title,
      '',
      intro,
      '',
      `Vehicle Type: ${context.vehicleType}`,
      `Vendor Name: ${context.vendorName}`,
      `Reservation No: ${context.reservationNo}`,
      `Verified By: ${context.verifiedBy}`,
      `Mobile No: ${context.verifiedMobileNo}`,
      `Email: ${context.verifiedEmailId || '-'}`,
      `Status: ${context.bookingStatusLabel}`,
      '',
      `${context.companyName}`,
      `${context.companyContactNo || '-'} | ${context.companyEmailId || '-'}`,
      `${context.companyAddress || '-'}${context.companyPincode ? ` - ${context.companyPincode}` : ''}`,
    ].join('\n');
  }

  private async buildContext(
    itineraryPlanId: number,
    vendorEligibleId: number,
  ): Promise<VehicleVoucherEmailContext | null> {
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
      return null;
    }

    const [plan, vendor, branch, vehicleType, settings] = await Promise.all([
      this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
        where: { itinerary_plan_ID: itineraryPlanId, deleted: 0 },
        select: { agent_id: true },
      }),
      this.prisma.dvi_vendor_details.findFirst({
        where: { vendor_id: Number(voucher.vendor_id || 0) },
        select: { vendor_name: true, vendor_email: true },
      }),
      this.prisma.dvi_vendor_branches.findFirst({
        where: { vendor_branch_id: Number(voucher.vendor_branch_id || 0) },
        select: { vendor_branch_name: true, vendor_branch_emailid: true },
      }),
      this.prisma.dvi_vehicle_type.findFirst({
        where: { vehicle_type_id: Number(voucher.vehicle_type_id || 0) },
        select: { vehicle_type_title: true },
      }),
      this.prisma.dvi_global_settings.findFirst({
        where: { status: 1, deleted: 0 },
      }),
    ]);

    let travelExpertEmail: string[] = [];
    if (Number(plan?.agent_id || 0) > 0) {
      const agent = await this.prisma.dvi_agent.findFirst({
        where: { agent_ID: Number(plan?.agent_id || 0), deleted: 0 },
        select: { travel_expert_id: true },
      });

      if (Number(agent?.travel_expert_id || 0) > 0) {
        const staff = await this.prisma.dvi_staff_details.findFirst({
          where: { staff_id: Number(agent?.travel_expert_id || 0), deleted: 0 },
          select: { staff_email: true },
        });
        travelExpertEmail = this.parseEmails(staff?.staff_email);
      }
    }

    return {
      itineraryPlanId,
      vendorEligibleId,
      vendorName: String(vendor?.vendor_name || branch?.vendor_branch_name || 'Vendor'),
      vehicleType: String(vehicleType?.vehicle_type_title || 'Vehicle'),
      reservationNo: String(voucher.vehicle_confirmed_reservation || ''),
      verifiedBy: String(voucher.vehicle_confirmation_verified_by || ''),
      verifiedMobileNo: String(voucher.vehicle_confirmation_verified_mobile_no || ''),
      verifiedEmailId: String(voucher.vehicle_confirmation_verified_email_id || voucher.vehicle_confirmed_email_id || ''),
      bookingStatusLabel: this.getStatusLabel(Number(voucher.vehicle_booking_status || 0)),
      vendorEmails: this.uniqueEmails([
        ...this.parseEmails(branch?.vendor_branch_emailid),
        ...this.parseEmails(vendor?.vendor_email),
        ...this.parseEmails(voucher.vehicle_confirmed_email_id),
        ...this.parseEmails(voucher.vehicle_confirmation_verified_email_id),
      ]),
      travelExpertEmail,
      accountsEmails: this.parseEmails(settings?.default_accounts_email_id),
      defaultVehicleEmails: this.parseEmails(settings?.default_vehicle_voucher_email_id),
      ccEmails: this.parseEmails(settings?.cc_email_id),
      companyName: String(settings?.company_name || 'DVI'),
      companyAddress: String(settings?.company_address || ''),
      companyPincode: String(settings?.company_pincode || ''),
      companyContactNo: String(settings?.company_contact_no || ''),
      companyEmailId: String(settings?.company_email_id || ''),
      siteTitle: String(settings?.site_title || 'DVI'),
    };
  }

  async sendVehicleConfirmationNotifications(
    itineraryPlanId: number,
    vendorEligibleId: number,
  ): Promise<void> {
    try {
      const transporter = this.getTransporter();
      if (!transporter) return;

      const context = await this.buildContext(itineraryPlanId, vendorEligibleId);
      if (!context) {
        this.logger.warn(
          `Vehicle voucher email context not found for itinerary ${itineraryPlanId}, vendorEligible ${vendorEligibleId}`,
        );
        return;
      }

      const from =
        String(process.env.VEHICLE_VOUCHER_MAIL_FROM || '').trim() ||
        String(process.env.VEHICLE_VOUCHER_MAIL_USER || '').trim();

      const vendorTo = this.uniqueEmails([
        ...context.vendorEmails,
        ...context.defaultVehicleEmails,
      ]);
      const vendorCc = this.uniqueEmails([
        ...context.travelExpertEmail,
        ...context.ccEmails,
      ]);

      if (vendorTo.length > 0 || vendorCc.length > 0) {
        const subject = `${context.siteTitle} - Vehicle Voucher Status #${context.vendorName}`;
        const intro =
          `We appreciate the vehicle availability update by ${context.verifiedBy}. ` +
          `Please find the latest confirmation details below.`;

        await transporter.sendMail({
          from,
          to: vendorTo.length ? vendorTo : undefined,
          cc: vendorCc.length ? vendorCc : undefined,
          subject,
          text: this.renderText(subject, intro, context),
          html: this.renderHtml(subject, intro, context),
        });
      }

      const internalTo = this.uniqueEmails([
        ...context.travelExpertEmail,
        ...context.accountsEmails,
        ...context.defaultVehicleEmails,
      ]);
      const internalCc = this.uniqueEmails(context.ccEmails);

      if (internalTo.length > 0 || internalCc.length > 0) {
        const subject = `${context.siteTitle} - Vehicle Confirmation Received #${context.vendorName}`;
        const intro =
          `Vehicle booking status has been updated by ${context.verifiedBy}. ` +
          `Please review the supplier response before sharing it with the client.`;

        await transporter.sendMail({
          from,
          to: internalTo.length ? internalTo : undefined,
          cc: internalCc.length ? internalCc : undefined,
          subject,
          text: this.renderText(subject, intro, context),
          html: this.renderHtml(subject, intro, context),
        });
      }
    } catch (error: any) {
      this.logger.error(`Vehicle voucher confirmation email send failed: ${error?.message || error}`);
    }
  }
}
