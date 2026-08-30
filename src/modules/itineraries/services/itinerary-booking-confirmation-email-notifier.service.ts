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

/**
 * Resolve recipient emails only from successfully confirmed
 * live-supplier hotel rows.
 *
 * No hotel/vendor email is hardcoded.
 *
 * Confirmed hotel:
 *   dvi_confirmed_itinerary_plan_hotel_details.hotel_id
 *
 * Hotel master:
 *   dvi_hotel.hotel_email
 */
private async resolveSupplierHotelEmails(
  itineraryPlanId: number,
): Promise<string[]> {
  const supplierProviders = new Set([
    'tbo',
    'vsr',
    'resavenue',
    'hobse',
    'axisrooms',
    'staah',
  ]);

  const confirmedHotels =
    await this.prisma
      .dvi_confirmed_itinerary_plan_hotel_details
      .findMany({
        where: {
          itinerary_plan_id:
            itineraryPlanId,
          status: 1,
          deleted: 0,
        },
        select: {
          hotel_id: true,
          hotel_provider: true,
        },
      });

  const supplierHotelRows =
    confirmedHotels.filter((hotel) =>
      supplierProviders.has(
        String(
          hotel.hotel_provider || '',
        )
          .trim()
          .toLowerCase(),
      ),
    );

  if (supplierHotelRows.length === 0) {
    return [];
  }

  const supplierHotelIds =
    Array.from(
      new Set(
        supplierHotelRows
          .map((hotel) =>
            Number(hotel.hotel_id || 0),
          )
          .filter(
            (hotelId) =>
              Number.isFinite(hotelId) &&
              hotelId > 0,
          ),
      ),
    );

  if (supplierHotelIds.length === 0) {
    this.logger.warn(
      `Confirmed supplier hotel rows for itinerary ${itineraryPlanId} do not have a canonical hotel_id. Hotel confirmation email cannot be resolved.`,
    );

    return [];
  }

  const hotelMasters =
    await this.prisma.dvi_hotel.findMany({
      where: {
        hotel_id: {
          in: supplierHotelIds,
        } as any,
      },
      select: {
        hotel_id: true,
        hotel_name: true,
        hotel_email: true,
      },
    });

  const supplierHotelEmails =
    this.uniqueEmails(
      hotelMasters.flatMap((hotel) =>
        this.parseEmails(
          hotel.hotel_email,
        ),
      ),
    );

  if (supplierHotelEmails.length === 0) {
    this.logger.warn(
      `No hotel_email was found for the confirmed supplier hotel(s) of itinerary ${itineraryPlanId}.`,
    );
  }

  return supplierHotelEmails;
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

async sendDailyMomentTripCompletedNotification(
  itineraryPlanId: number,
  itineraryRouteId: number,
): Promise<void> {
  try {
    if (
      !Number.isInteger(itineraryPlanId) ||
      itineraryPlanId <= 0 ||
      !Number.isInteger(itineraryRouteId) ||
      itineraryRouteId <= 0
    ) {
      this.logger.warn(
        `Invalid Daily Moment trip completion IDs. Plan: ${itineraryPlanId}, Route: ${itineraryRouteId}`,
      );

      return;
    }

    const transporter = this.getTransporter();

    if (!transporter) {
      return;
    }

const [confirmedPlan, originalPlan, route, settings] =
  await Promise.all([
    this.prisma.dvi_confirmed_itinerary_plan_details.findFirst({
      where: {
        itinerary_plan_ID: itineraryPlanId,
        status: 1,
        deleted: 0,
      },
      select: {
        itinerary_plan_ID: true,
        itinerary_quote_ID: true,
        agent_id: true,
        staff_id: true,
        arrival_location: true,
        departure_location: true,
      },
    }),

    this.prisma.dvi_itinerary_plan_details.findFirst({
      where: {
        itinerary_plan_ID: itineraryPlanId,
        status: 1,
        deleted: 0,
      },
      select: {
        createdby: true,
      },
    }),

    this.prisma.dvi_confirmed_itinerary_route_details.findFirst({
      where: {
        itinerary_plan_ID: itineraryPlanId,
        itinerary_route_ID: itineraryRouteId,
        status: 1,
        deleted: 0,
      },
      select: {
        itinerary_route_ID: true,
        itinerary_route_date: true,
        no_of_days: true,
        location_name: true,
        next_visiting_location: true,
        driver_trip_completed: true,
      },
    }),

    this.prisma.dvi_global_settings.findFirst({
      where: {
        status: 1,
        deleted: 0,
      },
      select: {
        site_title: true,
        company_name: true,
        company_email_id: true,
        cc_email_id: true,
      },
    }),
  ]);

    if (!confirmedPlan || !route) {
      this.logger.warn(
        `Daily Moment trip completion email data not found. Plan: ${itineraryPlanId}, Route: ${itineraryRouteId}`,
      );

      return;
    }

    if (route.driver_trip_completed !== 1) {
      return;
    }

    /*
     * Senior requirement:
     *
     * 1. Travel Agent who booked the itinerary
     *    -> confirmedPlan.agent_id
     *
     * 2. Travel Expert of this itinerary
     *    -> confirmedPlan.staff_id
     */
    const [agent, travelExpert, hotspotRows] =
      await Promise.all([
        Number(confirmedPlan.agent_id || 0) > 0
          ? this.prisma.dvi_agent.findFirst({
              where: {
                agent_ID: Number(confirmedPlan.agent_id),
                status: 1,
                deleted: 0,
              },
              select: {
                agent_email_id: true,
              },
            })
          : Promise.resolve(null),

      Number(originalPlan?.createdby || 0) > 0
  ? this.prisma.dvi_users.findFirst({
      where: {
        userID: BigInt(
          Number(originalPlan?.createdby || 0),
        ),
        roleID: 3,
        status: 1,
        deleted: 0,
      },
      select: {
        useremail: true,
      },
    })
  : Promise.resolve(null),

        this.prisma.dvi_confirmed_itinerary_route_hotspot_details.findMany({
          where: {
            itinerary_plan_ID: itineraryPlanId,
            itinerary_route_ID: itineraryRouteId,
            item_type: {
              in: [4, 6, 7],
            },
            status: 1,
            deleted: 0,
          },
          orderBy: {
            hotspot_order: 'asc',
          },
          select: {
            hotspot_ID: true,
            hotspot_order: true,
            item_type: true,
            hotspot_start_time: true,
            hotspot_end_time: true,
            driver_hotspot_status: true,
            driver_not_visited_description: true,
          },
        }),
      ]);

    /*
     * Email goes ONLY to:
     * - Agent who booked
     * - Travel Expert of the itinerary
     */
    const agentEmails =
      this.parseEmails(
        agent?.agent_email_id,
      );

   const travelExpertEmails =
  this.parseEmails(
    travelExpert?.useremail,
  );

 const recipientEmails =
  this.uniqueEmails([
    ...agentEmails,
    ...travelExpertEmails,
    'sales@dvi.co.in',
  ]);

    if (recipientEmails.length === 0) {
      this.logger.warn(
        `No Agent or Travel Expert email found for Daily Moment. Plan: ${itineraryPlanId}`,
      );

      return;
    }

    /*
     * Same duplicate handling as Daily Moment day view.
     */
    const visitRows =
      hotspotRows.filter(
        (row, index, rows) =>
          rows.findIndex(
            (candidate) =>
              candidate.hotspot_ID === row.hotspot_ID &&
              candidate.item_type === row.item_type,
          ) === index,
      );

    const hotspotIds =
      Array.from(
        new Set(
          visitRows
            .map((row) =>
              Number(row.hotspot_ID || 0),
            )
            .filter((id) => id > 0),
        ),
      );

    const hotspotMasters =
      hotspotIds.length > 0
        ? await this.prisma.dvi_hotspot_place.findMany({
            where: {
              hotspot_ID: {
                in: hotspotIds,
              },
              status: 1,
              deleted: 0,
            },
            select: {
              hotspot_ID: true,
              hotspot_name: true,
            },
          })
        : [];

    const hotspotNameById =
      new Map<number, string>();

    hotspotMasters.forEach((hotspot) => {
      hotspotNameById.set(
        hotspot.hotspot_ID,
        String(
          hotspot.hotspot_name || 'N/A',
        ).trim() || 'N/A',
      );
    });

    const formatVisitTime = (
      value?: Date | null,
    ): string => {
      if (!value) {
        return '--';
      }

      const date = new Date(value);

      if (Number.isNaN(date.getTime())) {
        return '--';
      }

      let hours = date.getHours();

      const minutes =
        date.getMinutes();

      const amPm =
        hours >= 12
          ? 'PM'
          : 'AM';

      hours = hours % 12;

      if (hours === 0) {
        hours = 12;
      }

      return `${String(hours).padStart(
        2,
        '0',
      )}:${String(minutes).padStart(
        2,
        '0',
      )} ${amPm}`;
    };

    const visitDetails =
      visitRows.map((row, index) => {
        const status =
          Number(
            row.driver_hotspot_status || 0,
          );

        const statusText =
          status === 1
            ? 'Visited'
            : status === 2
              ? 'Not Visited'
              : 'Pending';

        const reason =
          status === 2
            ? String(
                row.driver_not_visited_description ||
                  '--',
              ).trim() || '--'
            : '--';

        return {
          serialNo: index + 1,

          name:
            hotspotNameById.get(
              Number(row.hotspot_ID),
            ) || 'N/A',

          time:
            `${formatVisitTime(
              row.hotspot_start_time,
            )} - ${formatVisitTime(
              row.hotspot_end_time,
            )}`,

          status,

          statusText,

          reason,
        };
      });

    const frontendBaseUrl =
      String(
        process.env.FRONTEND_URL ||
          process.env.DVI_FRONTEND_URL ||
          'https://dvi.travel',
      ).replace(/\/+$/, '');

    const dailyMomentUrl =
      `${frontendBaseUrl}/daily-moment/public/${itineraryPlanId}`;

    const quotationNumber =
      String(
        confirmedPlan.itinerary_quote_ID ||
          itineraryPlanId,
      ).trim();

    const dayNumber =
      Number(route.no_of_days || 0);

    const routeDate =
      this.formatDate(
        route.itinerary_route_date,
      );

    const fromLocation =
      String(
        route.location_name || '--',
      ).trim();

    const toLocation =
      String(
        route.next_visiting_location || '--',
      ).trim();

    const companyName =
      String(
        settings?.company_name ||
          settings?.site_title ||
          'DVI Travel',
      ).trim() || 'DVI Travel';

    const subject =
      `DVI Holidays - Trip Update Day ${dayNumber} - #${quotationNumber}`;

    const visitText =
      visitDetails
        .map((visit) => {
          const reasonText =
            visit.status === 2
              ? ` | Reason: ${visit.reason}`
              : '';

          return (
            `${visit.serialNo}. ${visit.name} | ` +
            `${visit.time} | ` +
            `${visit.statusText}${reasonText}`
          );
        })
        .join('\n');

    const text = [
      'Trip Update!',
      '',
      `Day ${dayNumber} of Itinerary #${quotationNumber} has been successfully completed.`,
      '',
      'Visit Details:',
      visitText || 'No visit details available.',
      '',
      `View Your Trip: ${dailyMomentUrl}`,
    ].join('\n');

    const visitDetailsHtml =
      visitDetails.length > 0
        ? visitDetails
            .map((visit) => {
              const statusColor =
                visit.status === 1
                  ? '#198754'
                  : visit.status === 2
                    ? '#dc3545'
                    : '#6c757d';

              const statusIcon =
                visit.status === 1
                  ? '&#10003;'
                  : visit.status === 2
                    ? '&#10005;'
                    : '';

              return `
                <tr>
                  <td
                    style="
                      padding:10px;
                      border:1px solid #eadcfb;
                      text-align:center;
                    "
                  >
                    ${this.escapeHtml(
                      visit.serialNo,
                    )}
                  </td>

                  <td
                    style="
                      padding:10px;
                      border:1px solid #eadcfb;
                    "
                  >
                    ${this.escapeHtml(
                      visit.name,
                    )}
                  </td>

                  <td
                    style="
                      padding:10px;
                      border:1px solid #eadcfb;
                    "
                  >
                    ${this.escapeHtml(
                      visit.time,
                    )}
                  </td>

                  <td
                    style="
                      padding:10px;
                      border:1px solid #eadcfb;
                      font-weight:600;
                      color:${statusColor};
                      white-space:nowrap;
                    "
                  >
                    ${statusIcon}
                    ${this.escapeHtml(
                      visit.statusText,
                    )}
                  </td>

                  <td
                    style="
                      padding:10px;
                      border:1px solid #eadcfb;
                    "
                  >
                    ${this.escapeHtml(
                      visit.reason,
                    )}
                  </td>
                </tr>
              `;
            })
            .join('')
        : `
            <tr>
              <td
                colspan="5"
                style="
                  padding:12px;
                  border:1px solid #eadcfb;
                  text-align:center;
                  color:#777777;
                "
              >
                No visit details available.
              </td>
            </tr>
          `;

    const html = `
      <div
        style="
          font-family:Arial,sans-serif;
          max-width:760px;
          margin:0 auto;
          color:#342d42;
        "
      >
        <div
          style="
            padding:24px;
            border:1px solid #eadcfb;
            border-radius:14px;
            background:#ffffff;
          "
        >
          <h2
            style="
              margin:0 0 18px;
              color:#4a4260;
            "
          >
            Trip Completed
          </h2>

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
                Day
              </th>

              <td
                style="
                  padding:9px;
                  border:1px solid #eadcfb;
                "
              >
                Day ${this.escapeHtml(
                  dayNumber,
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
                Date
              </th>

              <td
                style="
                  padding:9px;
                  border:1px solid #eadcfb;
                "
              >
                ${this.escapeHtml(
                  routeDate,
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
                  fromLocation,
                )}
                to
                ${this.escapeHtml(
                  toLocation,
                )}
              </td>
            </tr>
          </table>

          <h3
            style="
              margin:0 0 12px;
              color:#4a4260;
            "
          >
            Visit Details
          </h3>

          <table
            cellpadding="0"
            cellspacing="0"
            style="
              width:100%;
              border-collapse:collapse;
              margin-bottom:22px;
            "
          >
            <thead>
              <tr
                style="
                  background:#faf7ff;
                "
              >
                <th
                  style="
                    padding:10px;
                    border:1px solid #eadcfb;
                  "
                >
                  #
                </th>

                <th
                  align="left"
                  style="
                    padding:10px;
                    border:1px solid #eadcfb;
                  "
                >
                  Visit
                </th>

                <th
                  align="left"
                  style="
                    padding:10px;
                    border:1px solid #eadcfb;
                  "
                >
                  Time
                </th>

                <th
                  align="left"
                  style="
                    padding:10px;
                    border:1px solid #eadcfb;
                  "
                >
                  Status
                </th>

                <th
                  align="left"
                  style="
                    padding:10px;
                    border:1px solid #eadcfb;
                  "
                >
                  Reason
                </th>
              </tr>
            </thead>

            <tbody>
              ${visitDetailsHtml}
            </tbody>
          </table>

          <a
            href="${this.escapeHtml(
              dailyMomentUrl,
            )}"
            style="
              display:inline-block;
              padding:12px 20px;
              border-radius:7px;
              background:#28a745;
              color:#ffffff;
              text-decoration:none;
              font-weight:600;
            "
          >
            View Your Trip
          </a>
        </div>
      </div>
    `;

    const smtpUser =
      String(
        process.env.BOOKING_CONFIRMATION_MAIL_USER ||
          process.env.VEHICLE_VOUCHER_MAIL_USER ||
          process.env.SMTP_USER ||
          '',
      ).trim();

    const fromAddress =
      String(
        process.env.BOOKING_CONFIRMATION_MAIL_FROM ||
          process.env.VEHICLE_VOUCHER_MAIL_FROM ||
          process.env.SMTP_FROM ||
          smtpUser ||
          settings?.company_email_id ||
          '',
      ).trim();

    if (!fromAddress) {
      this.logger.warn(
        'Daily Moment sender email is not configured.',
      );

      return;
    }

    const fromName =
      String(
        process.env.SMTP_FROM_NAME ||
          companyName,
      ).trim();

   const info = await transporter.sendMail({
  from: {
    name: fromName,
    address: fromAddress,
  },
  to: recipientEmails,
  subject,
  text,
  html,
});

this.logger.log(
  `Daily Moment recipients: ${recipientEmails.join(', ')}`,
);

this.logger.log(
  `Daily Moment accepted: ${
    info.accepted?.join(', ') || 'none'
  }`,
);

this.logger.log(
  `Daily Moment rejected: ${
    info.rejected?.join(', ') || 'none'
  }`,
);

this.logger.log(
  `Daily Moment Message ID: ${info.messageId || 'none'}`,
);

this.logger.log(
  `Daily Moment SMTP response: ${info.response || 'none'}`,
);

this.logger.log(
  `Daily Moment Trip Completed email sent. Plan: ${itineraryPlanId}, Route: ${itineraryRouteId}, Day: ${dayNumber}`,
);
  } catch (error: any) {
    /*
     * Email failure must never undo
     * driver_trip_completed = 1.
     */
    this.logger.error(
      `Daily Moment Trip Completed email failed for plan ${itineraryPlanId}, route ${itineraryRouteId}: ${
        error?.message || error
      }`,
    );
  }
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
              travel_expert_id: true,
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
 * Supplier hotel recipient comes only from
 * successfully confirmed hotel rows.
 *
 * Hotel Only = 1
 * Transportation + Hotel = 3
 */
const supplierHotelEmails =
  [1, 3].includes(itineraryPreference)
    ? await this.resolveSupplierHotelEmails(
        itineraryPlanId,
      )
    : [];

/*
 * Travel Expert recipient comes from
 * dvi_staff_details.staff_email via
 * dvi_agent.travel_expert_id.
 */
      const travelExpertId = Number(
        agent?.travel_expert_id || 0,
      );

      let travelExpertEmails: string[] = [];

      if (travelExpertId > 0) {
        const travelExpert =
          await this.prisma.dvi_staff_details
            .findFirst({
              where: {
                staff_id: travelExpertId,
                deleted: 0,
              },
              select: {
                staff_email: true,
              },
            });

        travelExpertEmails =
          this.parseEmails(
            travelExpert?.staff_email,
          );
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
          ...travelExpertEmails,
        ]);

/*
 * Preserve the existing recipient behaviour:
 *
 * - Agent remains primary when available.
 * - Admin / OPS / mapped Travel Expert remain internal recipients.
 * - Confirmed supplier hotels receive the same confirmation through BCC,
 *   so different hotels cannot see one another's email addresses.
 *
 * If no existing internal recipient exists, use the first supplier
 * hotel as the primary recipient and BCC any remaining hotel emails.
 */
const primaryEmails =
  agentEmails.length > 0
    ? agentEmails
    : internalEmails;

const toEmails =
  primaryEmails.length > 0
    ? primaryEmails
    : supplierHotelEmails.slice(0, 1);

const ccEmails =
  agentEmails.length > 0
    ? internalEmails.filter(
        (email) =>
          !agentEmails.includes(email),
      )
    : [];

const bccEmails =
  supplierHotelEmails.filter(
    (email) =>
      !toEmails.includes(email) &&
      !ccEmails.includes(email),
  );

if (
  toEmails.length === 0 &&
  bccEmails.length === 0
) {
  this.logger.warn(
    `No Agent, Admin, OPS, Travel Expert, or supplier hotel email was found for itinerary ${itineraryPlanId}`,
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

  /*
   * Supplier hotel recipients are deliberately BCC'd.
   * This prevents one hotel from seeing another hotel's
   * email address on multi-hotel itineraries.
   */
  bcc:
    bccEmails.length > 0
      ? bccEmails
      : undefined,

  subject,
  text,
  html,
});

this.logger.log(
  `Booking confirmation email sent for itinerary ${itineraryPlanId}. ` +
    `To: ${toEmails.join(', ')}; ` +
    `CC: ${ccEmails.join(', ') || 'none'}; ` +
    `Supplier hotels: ${
      supplierHotelEmails.join(', ') ||
      'none'
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