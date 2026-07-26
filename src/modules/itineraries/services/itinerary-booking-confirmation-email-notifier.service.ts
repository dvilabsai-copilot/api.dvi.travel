import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { PrismaService } from '../../../prisma.service';

type VoucherInformation = {
  label: string;
  previewPath: string;
  opsEmails: string[];
};

@Injectable()
export class ItineraryBookingConfirmationEmailNotifierService {
  private readonly logger = new Logger(
    ItineraryBookingConfirmationEmailNotifierService.name,
  );

  private transporter: Transporter | null = null;
  private warnedDisabled = false;
  private warnedMissingConfig = false;

  constructor(
    private readonly prisma: PrismaService,
  ) {}

  private isEnabled(): boolean {
    const value = String(
      process.env.BOOKING_CONFIRMATION_MAIL_ENABLED ??
        process.env.VEHICLE_VOUCHER_MAIL_ENABLED ??
        'false',
    )
      .trim()
      .toLowerCase();

    return (
      value === 'true' ||
      value === '1' ||
      value === 'yes'
    );
  }

  private parseEmails(
    value?: string | null,
  ): string[] {
    return String(value || '')
      .split(/[;,]/)
      .map((email) =>
        email.trim().toLowerCase(),
      )
      .filter(Boolean);
  }

  private uniqueEmails(
    emails: string[],
  ): string[] {
    return Array.from(
      new Set(
        emails
          .map((email) =>
            email.trim().toLowerCase(),
          )
          .filter(Boolean),
      ),
    );
  }

  private escapeHtml(
    value: unknown,
  ): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  private formatDate(
    value?: Date | string | null,
  ): string {
    if (!value) {
      return '--';
    }

    const date =
      value instanceof Date
        ? value
        : new Date(value);

    if (Number.isNaN(date.getTime())) {
      return '--';
    }

    return date.toLocaleDateString(
      'en-IN',
      {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      },
    );
  }

  private getTransporter(): Transporter | null {
    if (!this.isEnabled()) {
      if (!this.warnedDisabled) {
        this.logger.warn(
          'Booking confirmation email is disabled. Set BOOKING_CONFIRMATION_MAIL_ENABLED=true.',
        );

        this.warnedDisabled = true;
      }

      return null;
    }

    if (this.transporter) {
      return this.transporter;
    }

    const host = String(
      process.env
        .BOOKING_CONFIRMATION_MAIL_HOST ||
        process.env
          .VEHICLE_VOUCHER_MAIL_HOST ||
        process.env.SMTP_HOST ||
        '',
    ).trim();

    const port = Number(
      process.env
        .BOOKING_CONFIRMATION_MAIL_PORT ||
        process.env
          .VEHICLE_VOUCHER_MAIL_PORT ||
        process.env.SMTP_PORT ||
        587,
    );

    const secure =
      String(
        process.env
          .BOOKING_CONFIRMATION_MAIL_SECURE ||
          process.env
            .VEHICLE_VOUCHER_MAIL_SECURE ||
          process.env.SMTP_SECURE ||
          'false',
      )
        .trim()
        .toLowerCase() === 'true';

    const user = String(
      process.env
        .BOOKING_CONFIRMATION_MAIL_USER ||
        process.env
          .VEHICLE_VOUCHER_MAIL_USER ||
        process.env.SMTP_USER ||
        '',
    ).trim();

    const pass = String(
      process.env
        .BOOKING_CONFIRMATION_MAIL_PASS ||
        process.env
          .VEHICLE_VOUCHER_MAIL_PASS ||
        process.env.SMTP_PASS ||
        '',
    ).trim();

    if (!host) {
      if (!this.warnedMissingConfig) {
        this.logger.warn(
          'Booking confirmation SMTP host is not configured.',
        );

        this.warnedMissingConfig = true;
      }

      return null;
    }

    this.transporter =
      nodemailer.createTransport({
        host,
        port,
        secure,
        auth:
          user && pass
            ? {
                user,
                pass,
              }
            : undefined,
      });

    return this.transporter;
  }

  private resolveVoucherInformation(
    itineraryPreference: number,
    itineraryPlanId: number,
    settings: {
      default_hotel_voucher_email_id?:
        | string
        | null;
      default_vehicle_voucher_email_id?:
        | string
        | null;
    } | null,
  ): VoucherInformation | null {
    // 1 = Hotel Only
    if (itineraryPreference === 1) {
      return {
        label: 'Hotel Voucher',
        previewPath:
          `/pdf-preview/hotel-voucher/${itineraryPlanId}`,
        opsEmails: this.parseEmails(
          settings
            ?.default_hotel_voucher_email_id,
        ),
      };
    }

    // 2 = Transportation Only
    if (itineraryPreference === 2) {
      return {
        label: 'Transport Voucher',
        previewPath:
          `/pdf-preview/travel-voucher/${itineraryPlanId}`,
        opsEmails: this.parseEmails(
          settings
            ?.default_vehicle_voucher_email_id,
        ),
      };
    }

    // 3 = Transportation + Hotel
    if (itineraryPreference === 3) {
      return {
        label:
          'Hotel and Transport Detailed Voucher',
        previewPath:
          `/pdf-preview/voucher/${itineraryPlanId}`,
        opsEmails: this.uniqueEmails([
          ...this.parseEmails(
            settings
              ?.default_hotel_voucher_email_id,
          ),
          ...this.parseEmails(
            settings
              ?.default_vehicle_voucher_email_id,
          ),
        ]),
      };
    }

    return null;
  }

  async sendBookingConfirmationNotifications(
    itineraryPlanId: number,
  ): Promise<void> {
    try {
      if (
        !Number.isInteger(itineraryPlanId) ||
        itineraryPlanId <= 0
      ) {
        this.logger.warn(
          `Invalid itinerary plan ID: ${itineraryPlanId}`,
        );

        return;
      }

      const transporter =
        this.getTransporter();

      if (!transporter) {
        return;
      }

      const confirmedPlan =
        await this.prisma
          .dvi_confirmed_itinerary_plan_details
          .findFirst({
            where: {
              itinerary_plan_ID:
                itineraryPlanId,
              status: 1,
              deleted: 0,
            },
            orderBy: {
              confirmed_itinerary_plan_ID:
                'desc',
            },
            select: {
              itinerary_plan_ID: true,
              itinerary_quote_ID: true,
              itinerary_preference: true,
              agent_id: true,
              arrival_location: true,
              departure_location: true,
              trip_start_date_and_time: true,
              trip_end_date_and_time: true,
              no_of_days: true,
              no_of_nights: true,
            },
          });

      if (!confirmedPlan) {
        this.logger.warn(
          `Active confirmed itinerary was not found for plan ${itineraryPlanId}`,
        );

        return;
      }

      const [agent, settings] =
        await Promise.all([
          this.prisma.dvi_agent.findFirst({
            where: {
              agent_ID: Number(
                confirmedPlan.agent_id || 0,
              ),
              deleted: 0,
            },
            select: {
              agent_name: true,
              agent_lastname: true,
              agent_email_id: true,
            },
          }),

          this.prisma
            .dvi_global_settings
            .findFirst({
              where: {
                status: 1,
                deleted: 0,
              },
              select: {
                site_title: true,
                company_name: true,
                company_email_id: true,
                cc_email_id: true,
                default_hotel_voucher_email_id:
                  true,
                default_vehicle_voucher_email_id:
                  true,
              },
            }),
        ]);

      const itineraryPreference = Number(
        confirmedPlan
          .itinerary_preference || 0,
      );

      const voucher =
        this.resolveVoucherInformation(
          itineraryPreference,
          itineraryPlanId,
          settings,
        );

      if (!voucher) {
        this.logger.warn(
          `Unsupported itinerary preference ${itineraryPreference}. Plan: ${itineraryPlanId}`,
        );

        return;
      }

      /*
       * Agent recipient comes from
       * dvi_agent.agent_email_id.
       */
      const agentEmails =
        this.parseEmails(
          agent?.agent_email_id,
        );

      /*
       * Admin:
       * - Environment setting
       * - Global Settings CC address
       */
      const adminEmails =
        this.uniqueEmails([
          ...this.parseEmails(
            process.env
              .BOOKING_CONFIRMATION_ADMIN_EMAILS ||
              'admin@dvi.co.in',
          ),
          ...this.parseEmails(
            settings?.cc_email_id,
          ),
        ]);

      /*
       * OPS:
       * - Relevant voucher email from
       *   Global Settings
       * - Optional environment override
       */
      const opsEmails =
        this.uniqueEmails([
          ...voucher.opsEmails,
          ...this.parseEmails(
            process.env
              .BOOKING_CONFIRMATION_OPS_EMAILS,
          ),
        ]);

      const internalEmails =
        this.uniqueEmails([
          ...adminEmails,
          ...opsEmails,
        ]);

      /*
       * Agent is the primary recipient.
       * Admin and OPS are CC recipients.
       *
       * When Agent email is unavailable,
       * Admin and OPS become primary recipients.
       */
      const toEmails =
        agentEmails.length > 0
          ? agentEmails
          : internalEmails;

      const ccEmails =
        agentEmails.length > 0
          ? internalEmails.filter(
              (email) =>
                !agentEmails.includes(email),
            )
          : [];

      if (toEmails.length === 0) {
        this.logger.warn(
          `No Agent, Admin, or OPS email was found for itinerary ${itineraryPlanId}`,
        );

        return;
      }

      const frontendBaseUrl = String(
        process.env.FRONTEND_URL ||
          process.env.DVI_FRONTEND_URL ||
          'https://dvi.travel',
      ).replace(/\/+$/, '');

      const voucherUrl =
        `${frontendBaseUrl}${voucher.previewPath}`;

      const quotationNumber =
        String(
          confirmedPlan.itinerary_quote_ID ||
            itineraryPlanId,
        ).trim();

      const agentName = [
        agent?.agent_name,
        agent?.agent_lastname,
      ]
        .map((value) =>
          String(value || '').trim(),
        )
        .filter(Boolean)
        .join(' ');

      const companyName =
        String(
          settings?.company_name ||
            settings?.site_title ||
            'DVI Travel',
        ).trim() || 'DVI Travel';

      const routeText =
        `${String(
          confirmedPlan.arrival_location ||
            '--',
        )} to ${String(
          confirmedPlan.departure_location ||
            '--',
        )}`;

      const startDate =
        this.formatDate(
          confirmedPlan
            .trip_start_date_and_time,
        );

      const endDate =
        this.formatDate(
          confirmedPlan
            .trip_end_date_and_time,
        );

      const durationText =
        `${Number(
          confirmedPlan.no_of_nights || 0,
        )} Nights / ${Number(
          confirmedPlan.no_of_days || 0,
        )} Days`;

      const subject =
        `${companyName} - Booking Confirmed - ${quotationNumber}`;

      const text = [
        'Booking Confirmed',
        '',
        'The itinerary booking has been confirmed successfully.',
        '',
        `Quotation Number: ${quotationNumber}`,
        `Agent: ${agentName || '--'}`,
        `Voucher Type: ${voucher.label}`,
        `Route: ${routeText}`,
        `Travel Dates: ${startDate} to ${endDate}`,
        `Duration: ${durationText}`,
        '',
        `Download Detailed Voucher: ${voucherUrl}`,
      ].join('\n');

      const html = `
        <div
          style="
            font-family:Arial,sans-serif;
            max-width:720px;
            margin:0 auto;
            color:#342d42;
          "
        >
          <div
            style="
              padding:24px;
              border:1px solid #eadcfb;
              border-radius:16px;
              background:#ffffff;
            "
          >
            <h2
              style="
                margin:0 0 8px;
                color:#4a4260;
              "
            >
              Booking Confirmed
            </h2>

            <p
              style="
                margin:0 0 20px;
                line-height:1.6;
                color:#6c6c6c;
              "
            >
              The itinerary booking has been
              confirmed successfully. The detailed
              voucher is ready.
            </p>

            <table
              cellpadding="0"
              cellspacing="0"
              style="
                width:100%;
                border-collapse:collapse;
                margin-bottom:22px;
              "
            >
              <tr>
                <th
                  align="left"
                  style="
                    padding:9px;
                    border:1px solid #eadcfb;
                    background:#faf7ff;
                  "
                >
                  Quotation Number
                </th>

                <td
                  style="
                    padding:9px;
                    border:1px solid #eadcfb;
                  "
                >
                  ${this.escapeHtml(
                    quotationNumber,
                  )}
                </td>
              </tr>

              <tr>
                <th
                  align="left"
                  style="
                    padding:9px;
                    border:1px solid #eadcfb;
                    background:#faf7ff;
                  "
                >
                  Agent
                </th>

                <td
                  style="
                    padding:9px;
                    border:1px solid #eadcfb;
                  "
                >
                  ${this.escapeHtml(
                    agentName || '--',
                  )}
                </td>
              </tr>

              <tr>
                <th
                  align="left"
                  style="
                    padding:9px;
                    border:1px solid #eadcfb;
                    background:#faf7ff;
                  "
                >
                  Voucher
                </th>

                <td
                  style="
                    padding:9px;
                    border:1px solid #eadcfb;
                  "
                >
                  ${this.escapeHtml(
                    voucher.label,
                  )}
                </td>
              </tr>

              <tr>
                <th
                  align="left"
                  style="
                    padding:9px;
                    border:1px solid #eadcfb;
                    background:#faf7ff;
                  "
                >
                  Route
                </th>

                <td
                  style="
                    padding:9px;
                    border:1px solid #eadcfb;
                  "
                >
                  ${this.escapeHtml(
                    routeText,
                  )}
                </td>
              </tr>

              <tr>
                <th
                  align="left"
                  style="
                    padding:9px;
                    border:1px solid #eadcfb;
                    background:#faf7ff;
                  "
                >
                  Travel Dates
                </th>

                <td
                  style="
                    padding:9px;
                    border:1px solid #eadcfb;
                  "
                >
                  ${this.escapeHtml(
                    startDate,
                  )}
                  to
                  ${this.escapeHtml(
                    endDate,
                  )}
                </td>
              </tr>

              <tr>
                <th
                  align="left"
                  style="
                    padding:9px;
                    border:1px solid #eadcfb;
                    background:#faf7ff;
                  "
                >
                  Duration
                </th>

                <td
                  style="
                    padding:9px;
                    border:1px solid #eadcfb;
                  "
                >
                  ${this.escapeHtml(
                    durationText,
                  )}
                </td>
              </tr>
            </table>

            <a
              href="${this.escapeHtml(
                voucherUrl,
              )}"
              style="
                display:inline-block;
                padding:12px 20px;
                border-radius:8px;
                background:#28a745;
                color:#ffffff;
                text-decoration:none;
                font-weight:600;
              "
            >
              Download Detailed Voucher
            </a>

            <p
              style="
                margin:22px 0 0;
                font-size:12px;
                color:#888888;
              "
            >
              Open the voucher link while logged
              in to the DVI portal.
            </p>
          </div>
        </div>
      `;

      const smtpUser = String(
        process.env
          .BOOKING_CONFIRMATION_MAIL_USER ||
          process.env
            .VEHICLE_VOUCHER_MAIL_USER ||
          process.env.SMTP_USER ||
          '',
      ).trim();

      const fromAddress = String(
        process.env
          .BOOKING_CONFIRMATION_MAIL_FROM ||
          process.env
            .VEHICLE_VOUCHER_MAIL_FROM ||
          process.env.SMTP_FROM ||
          smtpUser ||
          settings?.company_email_id ||
          '',
      ).trim();

      if (!fromAddress) {
        this.logger.warn(
          'Booking confirmation sender email is not configured.',
        );

        return;
      }

      const fromName = String(
        process.env.SMTP_FROM_NAME ||
          companyName,
      ).trim();

      await transporter.sendMail({
        from: {
          name: fromName,
          address: fromAddress,
        },
        to: toEmails,
        cc:
          ccEmails.length > 0
            ? ccEmails
            : undefined,
        subject,
        text,
        html,
      });

      this.logger.log(
        `Booking confirmation email sent for itinerary ${itineraryPlanId}. To: ${toEmails.join(
          ', ',
        )}; CC: ${
          ccEmails.join(', ') || 'none'
        }`,
      );
    } catch (error: any) {
      /*
       * Email failure must never cancel or
       * roll back an already confirmed booking.
       */
      this.logger.error(
        `Booking confirmation email failed for itinerary ${itineraryPlanId}: ${
          error?.message || error
        }`,
      );
    }
  }
}