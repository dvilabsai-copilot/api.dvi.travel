import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { ItineraryDetailsService } from './itinerary-details.service';
import { ItineraryHotelDetailsService } from './itinerary-hotel-details.service';
import { getTransportEarlyArrivalMessage } from './transport-early-arrival';

type ClipboardMode = 'recommended' | 'highlights' | 'para';

export interface ClipboardPayload {
  html: string;
  plainText: string;
}

type ClipboardCostBreakdown = {
  totalRoomCost?: number;
  totalHotelAmount?: number;
  totalAmenitiesCost?: number;
  extraBedCost?: number;
  childWithBedCost?: number;
  childWithoutBedCost?: number;
  totalGuideCost?: number;
  totalHotspotCost?: number;
  totalActivityCost?: number;
  additionalMargin?: number;
  totalVehicleAmount?: number;
  totalVehicleCost?: number;
  totalVehicleQty?: number;
  couponDiscount?: number;
  agentMargin?: number;
  totalRoundOff?: number;
  companyName?: string;
  [key: string]: unknown;
};

@Injectable()
export class ItineraryClipboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly detailsService: ItineraryDetailsService,
    private readonly hotelDetailsService: ItineraryHotelDetailsService,
  ) {}

  private escapeHtml(value: unknown): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  private formatCurrency(value: number): string {
    return `Rs ${Number(value || 0).toFixed(2)}`;
  }

  private formatCurrencyInr(value: number): string {
    const amount = Number(value || 0);
    return `₹ ${amount.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  private formatNumberInr(value: number): string {
    const amount = Number(value || 0);
    return amount.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  private formatDateReadable(value?: Date | string | null): string {
    if (!value) return '';
    const dt = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(dt.getTime())) return '';
    const dd = String(dt.getDate()).padStart(2, '0');
    const mon = dt.toLocaleString('en-US', { month: 'short' });
    const yyyy = dt.getFullYear();
    return `${dd} ${mon} ${yyyy}`;
  }

  private formatDateTime(value?: Date | string | null): string {
    if (!value) return '';
    const dt = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(dt.getTime())) return '';

    const dd = String(dt.getDate()).padStart(2, '0');
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const yyyy = dt.getFullYear();

    let hh = dt.getHours();
    const min = String(dt.getMinutes()).padStart(2, '0');
    const ampm = hh >= 12 ? 'PM' : 'AM';
    hh = hh % 12;
    if (hh === 0) hh = 12;

    return `${dd}-${mm}-${yyyy} ${String(hh).padStart(2, '0')}:${min} ${ampm}`;
  }

  private formatDate(value?: Date | string | null): string {
    if (!value) return '';
    const dt = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(dt.getTime())) return '';
    const dd = String(dt.getDate()).padStart(2, '0');
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const yyyy = dt.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  }

  private formatDateWithWeekday(value?: Date | string | null): string {
    if (!value) return '';
    const dt = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(dt.getTime())) return '';

    const weekday = dt.toLocaleString('en-US', { weekday: 'short' });
    const month = dt.toLocaleString('en-US', { month: 'short' });
    const day = String(dt.getDate()).padStart(2, '0');
    const year = dt.getFullYear();

    return `${weekday}, ${month} ${day}, ${year}`;
  }

  private normalizeGroupTypes(groupTypes: number[]): number[] {
    const cleaned = Array.from(
      new Set(
        groupTypes
          .map((g) => Number(g))
          .filter((g) => Number.isInteger(g) && g >= 1 && g <= 4),
      ),
    );

    return cleaned.length ? cleaned : [1];
  }

  private buildSummaryTable(plan: any): string {
    const totalAdult = Number(plan.total_adult || 0);
    const totalChildren = Number(plan.total_children || 0);
    const totalInfants = Number(plan.total_infants || 0);

    const entryTicketRequired = Number(plan.entry_ticket_required || 0) === 1 ? 'Yes' : 'No';
    const nights = Number(plan.no_of_nights || 0);
    const days = Number(plan.no_of_days || 0);
    const earlyArrivalMessage = getTransportEarlyArrivalMessage(
      plan.transport_early_arrival_option,
    );

    return `
      <table width="700" align="left" border="1" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background-color:#fff; font-family:Calibri; font-size:11px; color:#302c6e;">
        <tr>
          <td align="center" valign="middle" style="color:#302c6e; font-size:22px; line-height:40px; font-weight:600; text-align:center;">
            Tour Itinerary Plan
          </td>
        </tr>
      </table>
      ${earlyArrivalMessage ? `
        <table width="700" align="left" border="1" cellpadding="0" cellspacing="0" style="border-collapse:collapse; background:#fff8e7; font-size:11px; font-family:Calibri; color:#6b4500;">
          <tr><td style="padding:8px; font-weight:700;">Early-arrival preference</td><td style="padding:8px;">${this.escapeHtml(earlyArrivalMessage)}</td></tr>
        </table>` : ''}
      <table width="700" align="left" border="1" cellpadding="0" cellspacing="0" style="border-collapse:collapse; background:#fff; font-size:11px; line-height:1.2; font-family:Calibri; color:#302c6e;">
        <tr>
          <td width="25%" style="text-align:center; padding:3px; border:1px solid #b1b1b1;">
            <span style="color:#afafaf; font-weight:500; display:block;">Start Date & Time</span>
            <span style="color:#302c6e; font-weight:700; display:block;">${this.escapeHtml(this.formatDateTime(plan.trip_start_date_and_time))}</span>
          </td>
          <td width="25%" style="text-align:center; padding:3px; border:1px solid #b1b1b1;">
            <span style="color:#afafaf; font-weight:500; display:block;">End Date & Time</span>
            <span style="color:#302c6e; font-weight:700; display:block;">${this.escapeHtml(this.formatDateTime(plan.trip_end_date_and_time))}</span>
          </td>
          <td width="25%" style="text-align:center; padding:3px; border:1px solid #b1b1b1;">
            <span style="color:#afafaf; font-weight:500; display:block;">Quote Id</span>
            <span style="color:#302c6e; font-weight:700; display:block;">${this.escapeHtml(plan.itinerary_quote_ID)}</span>
          </td>
          <td width="25%" style="text-align:center; padding:3px; border:1px solid #b1b1b1;">
            <span style="color:#afafaf; font-weight:500; display:block;">Trip Night & Day</span>
            <span style="color:#302c6e; font-weight:700; display:block;">${this.escapeHtml(nights)} Nights, ${this.escapeHtml(days)} Days</span>
          </td>
        </tr>
        <tr>
          <td width="25%" style="text-align:center; padding:3px; border:1px solid #b1b1b1;">
            <span style="color:#afafaf; font-weight:500; display:block;">Entry Ticket Required</span>
            <span style="color:#302c6e; font-weight:700; display:block;">${entryTicketRequired}</span>
          </td>
          <td width="25%" style="text-align:center; padding:3px; border:1px solid #b1b1b1;">
            <span style="color:#afafaf; font-weight:500; display:block;">Nationality</span>
            <span style="color:#302c6e; font-weight:700; display:block;">${this.escapeHtml(String(plan.nationality || ''))}</span>
          </td>
          <td width="25%" style="text-align:center; padding:3px; border:1px solid #b1b1b1;">
            <span style="color:#afafaf; font-weight:500; display:block;">Total Pax</span>
            <span style="color:#302c6e; font-weight:700; display:block;">${totalAdult} Adult, ${totalChildren} Children, ${totalInfants} Infant</span>
          </td>
          <td width="25%" style="text-align:center; padding:3px; border:1px solid #b1b1b1;">
            <span style="color:#afafaf; font-weight:500; display:block;">Room Count</span>
            <span style="color:#302c6e; font-weight:700; display:block;">${this.escapeHtml(Number(plan.preferred_room_count || 0))}</span>
          </td>
        </tr>
      </table>
    `;
  }

  private async resolveNationalityLabel(nationalityId: unknown): Promise<string> {
    const id = Number(nationalityId || 0);
    if (!id) return '';

    const country = await this.prisma.dvi_countries.findFirst({
      where: {
        id,
        deleted: 0,
      },
      select: {
        name: true,
      },
    });

    return String(country?.name || id);
  }

  private expandHotelRowsForClipboard(hotels: any[]): any[] {
    return hotels.flatMap((hotel) => {
      const previousNight = String(hotel?.hotelCheckInDate || '').slice(0, 10);
      if (
        hotel?.previousDayBillingSynthetic === true ||
        hotel?.earlyCheckIn !== true ||
        !/^\d{4}-\d{2}-\d{2}$/.test(previousNight)
      ) {
        return [hotel];
      }

      return [
        {
          ...hotel,
          __clipboardDayZero: true,
          day: 'Day 0',
          dayNumber: 0,
          date: previousNight,
          previousDayBillingSynthetic: true,
        },
        hotel,
      ];
    });
  }

  private getClipboardDayNumber(hotel: any, fallback: number): number {
    if (hotel?.__clipboardDayZero === true || hotel?.previousDayBillingSynthetic === true) {
      return 0;
    }

    const explicitDay = Number(hotel?.dayNumber || 0);
    if (Number.isFinite(explicitDay) && explicitDay > 0) return explicitDay;

    const match = String(hotel?.day || '').match(/day\s*(\d+)/i);
    const parsedDay = Number(match?.[1] || 0);
    return Number.isFinite(parsedDay) && parsedDay > 0 ? parsedDay : fallback;
  }

  private buildHotelSection(args: {
    selectedGroupTypes: number[];
    hotels: any[];
    roomCount: number;
    showRates: boolean;
    noOfDays: number;
    additionalMarginPct: number;
    additionalMarginDayLimit: number;
  }): string {
    const {
      selectedGroupTypes,
      hotels,
      roomCount,
      showRates,
      noOfDays,
      additionalMarginPct,
      additionalMarginDayLimit,
    } = args;

    let groupSections = '';
    const totalColumns = showRates ? 6 : 5;

    for (const groupType of selectedGroupTypes) {
      const groupRows = hotels
        .filter((h) => Number(h.groupType) === groupType)
        .sort((a, b) => Number(a.itineraryRouteId || 0) - Number(b.itineraryRouteId || 0));

      const clipboardRows = this.expandHotelRowsForClipboard(groupRows);
      const rowHtml = clipboardRows.length
        ? clipboardRows
            .map((hotel, idx) => {
              const baseDayAmount = Number(hotel.totalHotelCost || 0) + Number(hotel.totalHotelTaxAmount || 0);
              const addMargin = noOfDays <= additionalMarginDayLimit
                ? (additionalMarginPct * baseDayAmount) / 100
                : 0;
              const isDayZero =
                hotel.__clipboardDayZero === true || hotel.previousDayBillingSynthetic === true;
              const dayNumber = this.getClipboardDayNumber(hotel, idx + 1);
              const dayDate = isDayZero ? hotel.hotelCheckInDate : hotel.date || hotel.day;
              const hotelName = isDayZero
                ? `${String(hotel.hotelName || '--')} (Early check-in room block)`
                : String(hotel.hotelName || '--');
              const displayPrice = `${this.formatCurrency(baseDayAmount + addMargin)}${isDayZero ? ' (included in Day 1 total)' : ''}`;

              return `
                <tr>
                  <td style="text-align:left; width:15%; border:1px solid #b1b1b1; padding:3px;">Day- ${dayNumber} | ${this.escapeHtml(this.formatDate(dayDate))}</td>
                  <td style="text-align:left; width:15%; border:1px solid #b1b1b1; padding:3px;">${this.escapeHtml(hotel.destination || '')}</td>
                  <td style="text-align:left; width:15%; border:1px solid #b1b1b1; padding:3px;">${this.escapeHtml(hotelName)} - ${this.escapeHtml(hotel.category ?? '')}</td>
                  <td style="text-align:left; width:15%; border:1px solid #b1b1b1; padding:3px;">${this.escapeHtml(hotel.roomType || '')} - ${roomCount || '-'}</td>
                  ${showRates ? `<td style="text-align:left; width:15%; border:1px solid #b1b1b1; padding:3px;"><b>${this.escapeHtml(displayPrice)}</b></td>` : ''}
                  <td style="text-align:left; width:15%; border:1px solid #b1b1b1; padding:3px;">${this.escapeHtml(hotel.mealPlan || 'EP')}</td>
                </tr>
              `;
            })
            .join('')
        : `<tr><td colspan="${showRates ? 6 : 5}" style="border: 1px solid #b1b1b1;text-align: center;">No hotel available</td></tr>`;

      groupSections += `
        <tr>
          <td colspan="${totalColumns}" align="center" valign="middle" style="color:#302c6e; font-size:18px; line-height:32px; font-weight:600; border:1px solid #b1b1b1; padding:4px;">
            Recommended Hotel - ${groupType}
          </td>
        </tr>
        <tr>
          <th style="background-color:#f2f2f2; text-align:left; padding:3px; border:1px solid #b1b1b1;">Day</th>
          <th style="background-color:#f2f2f2; text-align:left; padding:3px; border:1px solid #b1b1b1;">Destination</th>
          <th style="background-color:#f2f2f2; text-align:left; padding:3px; border:1px solid #b1b1b1;">Hotel Name - Category</th>
          <th style="background-color:#f2f2f2; text-align:left; padding:3px; border:1px solid #b1b1b1;">Room Type - Count</th>
          ${showRates ? '<th style="background-color:#f2f2f2; text-align:left; padding:3px; border:1px solid #b1b1b1;">Price</th>' : ''}
          <th style="background-color:#f2f2f2; text-align:left; padding:3px; border:1px solid #b1b1b1;">Meal Plan</th>
        </tr>
        ${rowHtml}
      `;
    }

    return `
      <table width="700" align="left" border="1" cellpadding="0" cellspacing="0" style="border-collapse:collapse; background-color:#fff; font-family:Calibri; font-size:11px; color:#302c6e; table-layout:fixed;">
        ${groupSections}
      </table>
    `;
  }

  private buildVehicleTitle(vehicle: any): string {
    const name = this.escapeHtml(vehicle.vehicleTypeName || 'Vehicle');
    const qty = this.escapeHtml(vehicle.totalQty || '0');

    const dayWise = Array.isArray(vehicle.dayWisePricing) ? vehicle.dayWisePricing : [];
    const firstDay = dayWise[0];
    const lastDay = dayWise[dayWise.length - 1];

    const extractFromTo = (route?: string) => {
      const parts = String(route || '')
        .split('→')
        .map((p) => p.trim())
        .filter(Boolean);
      return {
        from: parts[0] || '',
        to: parts[parts.length - 1] || '',
      };
    };

    const firstRoute = extractFromTo(firstDay?.route);
    const lastRoute = extractFromTo(lastDay?.route);

    const from = firstRoute.from || this.escapeHtml(vehicle.fromLabel || '');
    const to = lastRoute.to || this.escapeHtml(vehicle.toLabel || '');

    const startDate = firstDay?.date ? this.formatDateReadable(firstDay.date) : '';
    const endDate = lastDay?.date ? this.formatDateReadable(lastDay.date) : '';

    const locationPart = from || to ? `${this.escapeHtml(from)} ==> ${this.escapeHtml(to)}` : '==>';
    const datePart = startDate || endDate ? ` - ${this.escapeHtml(startDate)} ==> ${this.escapeHtml(endDate)}` : '';

    return `${name} (${qty}) - ${locationPart}${datePart}`;
  }

  private buildVehicleSection(vehicles: any[]): string {
    const rows = vehicles?.length
      ? vehicles
          .map((v) => {
            return `
              <tr>
                <td style="border:1px solid #b1b1b1; text-align:left; padding:3px;">${this.buildVehicleTitle(v)}</td>
                <td style="border:1px solid #b1b1b1; text-align:left; padding:3px;"><b>${this.escapeHtml(this.formatNumberInr(Number(v.totalAmount || 0)))}</b></td>
              </tr>
            `;
          })
          .join('')
      : '<tr><td colspan="2" style="border:1px solid #b1b1b1; text-align:center; padding:3px;">No Vehicle available</td></tr>';

    return `
      <table width="700" align="left" border="1" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background-color:#fff; font-family:Calibri; font-size:11px; color:#302c6e; table-layout:fixed;">
        <tr><td colspan="2" align="center" valign="middle" style="color:#302c6e; font-size:18px; line-height:40px; font-weight:600;">Vehicle Details</td></tr>
        <tr>
          <th style="background-color:#f2f2f2; text-align:left; padding:3px; border:1px solid #b1b1b1;">Vehicle Details</th>
          <th style="background-color:#f2f2f2; text-align:left; padding:3px; border:1px solid #b1b1b1;">Total Amount</th>
        </tr>
        ${rows}
      </table>
    `;
  }

  private buildCostSection(cost: any): string {
    const roomCost = Number(cost.totalRoomCost || 0);
    const roomCostPerPerson = Number(cost.roomCostPerPerson || 0);
    const hotelPaxCount = Number(cost.hotelPaxCount || 0);
    const extraBedCost = Number(cost.extraBedCost || 0);
    const childWithBedCost = Number(cost.childWithBedCost || 0);
    const childWithoutBedCost = Number(cost.childWithoutBedCost || 0);
    const totalVehicleQty = Number(cost.totalVehicleQty || 0);
    const safeVehicleQty = totalVehicleQty > 0 ? totalVehicleQty : 0;
    const totalVehicleAmount = Number(cost.totalVehicleAmount || cost.totalVehicleCost || 0);
    const couponDiscount = Number(cost.couponDiscount || 0);
    const totalRoundOff = Number(cost.totalRoundOff || 0);
    const roundOffLabel = totalRoundOff >= 0
      ? this.formatCurrencyInr(totalRoundOff)
      : `- ${this.formatCurrencyInr(Math.abs(totalRoundOff))}`;

    const roomLabel = hotelPaxCount > 0 && roomCostPerPerson > 0
      ? `Total Room Cost (${hotelPaxCount} * ${this.formatNumberInr(roomCostPerPerson)})`
      : 'Total Room Cost';

    return `
      <table width="700" align="left" border="1" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background-color:#fff; font-family:Calibri; font-size:11px; color:#302c6e;">
        ${roomCost > 0 ? `<tr><th style="text-align:left; padding:3px; border:1px solid #b1b1b1;">${this.escapeHtml(roomLabel)}</th><td style="text-align:left; padding:3px; border:1px solid #b1b1b1;"><b>${this.escapeHtml(this.formatCurrencyInr(roomCost))}</b></td></tr>` : ''}
        ${extraBedCost > 0 ? `<tr><th style="text-align:left; padding:3px; border:1px solid #b1b1b1;">Extra Bed Cost (${this.escapeHtml(Number(cost.extraBed || 0))})</th><td style="text-align:left; padding:3px; border:1px solid #b1b1b1;"><b>${this.escapeHtml(this.formatCurrencyInr(extraBedCost))}</b></td></tr>` : ''}
        ${childWithBedCost > 0 ? `<tr><th style="text-align:left; padding:3px; border:1px solid #b1b1b1;">Child With Bed Cost (${this.escapeHtml(Number(cost.childWithBed || 0))})</th><td style="text-align:left; padding:3px; border:1px solid #b1b1b1;"><b>${this.escapeHtml(this.formatCurrencyInr(childWithBedCost))}</b></td></tr>` : ''}
        ${childWithoutBedCost > 0 ? `<tr><th style="text-align:left; padding:3px; border:1px solid #b1b1b1;">Child Without Bed Cost (${this.escapeHtml(Number(cost.childWithoutBed || 0))})</th><td style="text-align:left; padding:3px; border:1px solid #b1b1b1;"><b>${this.escapeHtml(this.formatCurrencyInr(childWithoutBedCost))}</b></td></tr>` : ''}
        ${totalVehicleAmount > 0 ? `<tr><th style="text-align:left; padding:3px; border:1px solid #b1b1b1;">Total Vehicle Cost (${this.escapeHtml(safeVehicleQty)})</th><td style="text-align:left; padding:3px; border:1px solid #b1b1b1;"><b>${this.escapeHtml(this.formatCurrencyInr(totalVehicleAmount))}</b></td></tr>` : ''}
        <tr><th style="text-align:left; padding:3px; border:1px solid #b1b1b1;">Total Amount</th><td style="text-align:left; padding:3px; border:1px solid #b1b1b1;"><b>${this.escapeHtml(this.formatCurrencyInr(Number(cost.totalAmount || 0)))}</b></td></tr>
        ${couponDiscount !== 0 ? `<tr><th style="text-align:left; padding:3px; border:1px solid #b1b1b1;">Coupon Discount</th><td style="text-align:left; padding:3px; border:1px solid #b1b1b1;">- ${this.escapeHtml(this.formatCurrencyInr(couponDiscount))}</td></tr>` : ''}
        <tr><th style="text-align:left; padding:3px; border:1px solid #b1b1b1;">Total Round Off</th><td style="text-align:left; padding:3px; border:1px solid #b1b1b1;">${this.escapeHtml(roundOffLabel)}</td></tr>
        <tr><th style="text-align:left; padding:3px; border:1px solid #b1b1b1;">Net Payable To ${this.escapeHtml(cost.companyName || 'DVI')}</th><td style="text-align:left; padding:3px; border:1px solid #b1b1b1;"><b>${this.escapeHtml(this.formatCurrencyInr(Number(cost.netPayable || 0)))}</b></td></tr>
      </table>
    `;
  }

  private buildHotspotSection(
  mode: ClipboardMode,
  days: any[],
  labels?: {
    firstDayStartLabel: string;
    otherDayStartLabel: string;
  },
): string {
  const firstDayStartLabel =
    labels?.firstDayStartLabel?.trim() || 'Start your Journey';

  const otherDayStartLabel =
    labels?.otherDayStartLabel?.trim() || 'Start Your Day';

 /**
   * Recommended mode:
   * Each hotspot/travel/description item becomes a separate table row,
   * matching the B2B Copy to Recommended output.
   *
   * Highlights and Para:
   * Continue using the existing paragraph-based output.
 */
  const buildLine = (content: string): string => {
    if (mode === 'recommended') {
      return `
        <tr>
          <td style="padding:3px; border:1px solid #b1b1b1; line-height:1.45;">
            ${content}
          </td>
        </tr>
      `;
    }

    return `
      <div style="margin:0 0 14px 0; line-height:1.45;">
        ${content}
      </div>
    `;
  };

  let html = `
    <table
      width="700"
      align="center"
      border="1"
      cellpadding="0"
      cellspacing="0"
      style="
        border-collapse:collapse;
        background-color:#fff;
        font-family:Calibri;
        font-size:11px;
        color:#302c6e;
      "
    >
      <tr>
        <td
          align="center"
          valign="middle"
          style="
            color:#302c6e;
            font-size:18px;
            line-height:40px;
            font-weight:600;
          "
        >
          Hotspot Details
        </td>
      </tr>
    </table>
  `;

  for (const day of days || []) {
    const dayTitle =
      `Day ${this.escapeHtml(day.dayNumber)} - ` +
      `${this.escapeHtml(
        this.formatDateWithWeekday(day.date) ||
          this.formatDate(day.date),
      )}`;

    const routeTitle =
      `${this.escapeHtml(day.departure || '')} to ` +
      `${this.escapeHtml(day.arrival || '')}`;

    const dayTimeRange =
      day.startTime && day.endTime
        ? ` (${this.escapeHtml(day.startTime)} - ${this.escapeHtml(
            day.endTime,
          )})`
        : '';

    const dayDistance = this.escapeHtml(
      day.distance || day.intercityDistance || '',
    );

    const dayDistancePart = dayDistance
      ? ` - (${dayDistance})`
      : '';

    const lines: string[] = [];

    const segments = Array.isArray(day.segments)
      ? day.segments
      : [];

    for (const segment of segments) {
 /*
       * Keep Copy to Highlights unchanged.
 */
      if (mode === 'highlights') {
        if (segment.type === 'attraction') {
          lines.push(
            buildLine(
              `<b>${this.escapeHtml(
                segment.name || '',
              )}</b> ${this.escapeHtml(
                segment.description || '',
              )}`,
            ),
          );
        }

        continue;
      }

      if (segment.type === 'start') {
        const startLabel =
          Number(day.dayNumber) === 1
            ? firstDayStartLabel
            : otherDayStartLabel;

        const range = this.escapeHtml(
          segment.timeRange || '',
        );

        lines.push(
          buildLine(
            `${this.escapeHtml(startLabel)}${
              range ? ` ${range}` : ''
            }`,
          ),
        );

        continue;
      }

      if (segment.type === 'travel') {
        const distance = this.escapeHtml(
          segment.distance || '',
        );

        const duration = this.escapeHtml(
          segment.duration || '',
        );

        const range = this.escapeHtml(
          segment.timeRange || '',
        );

        const metrics = [
          distance
            ? `<span style="color:#7e7d88; margin-right:5px;">Distance:</span> ${distance}`
            : '',
          duration
            ? `<span style="color:#7e7d88; margin:0 5px;">Duration:</span> ${duration}`
            : '',
        ]
          .filter(Boolean)
          .join(', ');

        lines.push(
          buildLine(
            `Travelling from ${this.escapeHtml(
              segment.from || '',
            )} to ${this.escapeHtml(
              segment.to || '',
            )}${range ? ` - ${range}` : ''}${
              metrics ? ` [${metrics}]` : ''
            }`,
          ),
        );

        continue;
      }

      if (segment.type === 'break') {
        const duration = this.escapeHtml(
          segment.duration || '',
        );

        const range = this.escapeHtml(
          segment.timeRange || '',
        );

        lines.push(
          buildLine(
            `Expect a waiting time of approximately ${duration} ` +
              `at this location ${this.escapeHtml(
                segment.location || '',
              )}` +
              `${range ? ` - ${range}` : ''}` +
              `${
                duration
                  ? ` [<span style="color:#7e7d88; margin:0 5px;">Duration:</span> ${duration}]`
                  : ''
              }`,
          ),
        );

        continue;
      }

      if (segment.type === 'attraction') {
        const range = this.escapeHtml(
          segment.visitTime ||
            segment.timeRange ||
            '',
        );

        const duration = this.escapeHtml(
          segment.duration || '',
        );

 /*
         * First recommended table row:
         * hotspot timing, duration and hotspot name.
 */
        lines.push(
          buildLine(
            `${range ? `${range} - ` : ''}` +
              `${duration ? `${duration} - ` : ''}` +
              `<b>${this.escapeHtml(
                segment.name || '',
              )}</b>`,
          ),
        );

 /*
         * Second recommended table row:
         * hotspot description.
 */
        if (segment.description) {
          lines.push(
            buildLine(
              this.escapeHtml(segment.description),
            ),
          );
        }

        continue;
      }

 /*
       * Keep Copy to Para check-in logic unchanged.
 */
      if (
        segment.type === 'checkin' &&
        mode === 'para'
      ) {
        lines.push(
          buildLine(
            `Check-in: ${this.escapeHtml(
              segment.hotelName || 'Hotel',
            )} ${this.escapeHtml(
              segment.time || '',
            )}`,
          ),
        );

        continue;
      }

      if (segment.type === 'return') {
        lines.push(
          buildLine(
            `Return: ${this.escapeHtml(
              segment.time || '',
            )}`,
          ),
        );
      }
    }

    if (!lines.length) {
      continue;
    }

 /*
     * Recommended mode receives a light-grey day heading,
     * matching the B2B copied table appearance.
     *
     * Highlights and Para retain the existing day heading.
 */
    const dayHeaderStyle =
      mode === 'recommended'
        ? `
          padding:3px;
          border:1px solid #b1b1b1;
          background-color:#f2f2f2;
        `
        : `
          padding:3px;
          border:1px solid #b1b1b1;
        `;

 /*
     * Recommended:
     * lines already contain individual <tr><td> rows.
     *
     * Highlights and Para:
     * keep all paragraph lines inside the existing single table cell.
 */
    const dayBody =
      mode === 'recommended'
        ? lines.join('')
        : `
          <tr>
            <td style="padding:3px; border:1px solid #b1b1b1;">
              ${lines.join('')}
            </td>
          </tr>
        `;

    html += `
      <table
        width="700"
        align="left"
        border="1"
        cellpadding="0"
        cellspacing="0"
        style="
          border-collapse:collapse;
          background-color:#fff;
          font-family:Calibri;
          font-size:11px;
          color:#302c6e;
          margin-top:8px;
          table-layout:fixed;
        "
      >
        <tr>
          <td style="${dayHeaderStyle}">
            <b>
              ${dayTitle}${dayTimeRange} -
              ${routeTitle}${dayDistancePart}
            </b>
          </td>
        </tr>

        ${dayBody}
      </table>
    `;
  }

  return html;
}
  private buildTermsSection(plan: any, globalSettings: any): string {
    const preference = Number(plan?.itinerary_preference || 0);

    const hotelTerms = this.decodeHtmlEntities(
      String(
      (plan as any)?.hotel_terms_condition ||
        globalSettings?.hotel_terms_condition ||
        '',
      ).trim(),
    );

    const vehicleTerms = this.decodeHtmlEntities(
      String(
      (plan as any)?.vehicle_terms_condition ||
        globalSettings?.vehicle_terms_condition ||
        '',
      ).trim(),
    );

    let includeHotel = preference === 1 || preference === 3;
    let includeVehicle = preference === 2 || preference === 3;

    if (!includeHotel && !includeVehicle) {
      includeHotel = Boolean(hotelTerms);
      includeVehicle = Boolean(vehicleTerms);
    }

    const termsBody = [
      includeHotel && hotelTerms ? hotelTerms : '',
      includeVehicle && vehicleTerms ? vehicleTerms : '',
    ]
      .filter(Boolean)
      .join('');

    if (!termsBody) {
      return '';
    }

    return `
      <table width="700" align="left" border="1" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background-color:#fff; font-family:Calibri; font-size:11px; color:#302c6e;">
        <tr><td align="center" valign="middle" style="color:#302c6e; font-size:20px; line-height:40px; font-weight:600; text-align:center;">Terms & Condition</td></tr>
      </table>
      <table width="700" align="left" border="1" cellpadding="5" cellspacing="0" style="border-collapse: collapse; background-color:#fff; font-family:Calibri; font-size:11px; color:#302c6e;">
        <tr>
          <td>
            <table width="100%" align="left" border="1" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background-color:#fff;">
              <tr>
                ${termsBody}
              </tr>
            </table>
          </td>
        </tr>
      </table>
    `;
  }

  private decodeHtmlEntities(value: string): string {
    if (!value) return '';

    return value
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#039;/gi, "'")
      .replace(/&#39;/gi, "'");
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  async generateClipboardByQuoteId(
    quoteId: string,
    mode: ClipboardMode,
    requestedGroupTypes: number[],
  ): Promise<ClipboardPayload> {
    const plan = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_quote_ID: quoteId, deleted: 0 },
    });

    if (!plan) {
      throw new NotFoundException('Itinerary not found');
    }

    const globalSettings = await this.prisma.dvi_global_settings.findFirst({
      where: { status: 1, deleted: 0 },
    });

    const itinerary = await this.detailsService.getItineraryDetails(quoteId);
    const hotelDetails = await this.hotelDetailsService.getHotelDetailsByQuoteId(quoteId);

    const nationalityLabel = await this.resolveNationalityLabel(
      (plan as any)?.nationality,
    );
    const summaryPlan = {
      ...plan,
      nationality: nationalityLabel,
    };

    const selectedGroupTypes = this.normalizeGroupTypes(requestedGroupTypes);
    const showRates = Boolean(hotelDetails.hotelRatesVisible);

    const additionalMarginPct = Number(process.env.ITINERARY_ADDITIONAL_MARGIN_PERCENTAGE || 0);
    const additionalMarginDayLimit = Number(process.env.ITINERARY_ADDITIONAL_MARGIN_DAY_LIMIT || 0);

    const summaryHtml = this.buildSummaryTable(summaryPlan);
    const hotelsHtml = this.buildHotelSection({
      selectedGroupTypes,
      hotels: hotelDetails.hotels,
      roomCount: Number(plan.preferred_room_count || itinerary.roomCount || 0),
      showRates,
      noOfDays: Number(plan.no_of_days || 0),
      additionalMarginPct,
      additionalMarginDayLimit,
    });
    const allVehicles = Array.isArray(itinerary.vehicles) ? itinerary.vehicles : [];
    const assignedVehicles = allVehicles.filter((v: any) => Boolean(v?.isAssigned));
    const vehiclesForClipboard = assignedVehicles.length ? assignedVehicles : allVehicles;

    const selectedVehicleQty = vehiclesForClipboard.reduce((sum: number, v: any) => {
      return sum + Number(v?.totalQty || 0);
    }, 0);

    const selectedVehicleAmount = vehiclesForClipboard.reduce((sum: number, v: any) => {
      return sum + Number(v?.totalAmount || 0);
    }, 0);

    const selectedHotelRows = (hotelDetails.hotels || []).filter((h: any) => {
      const groupMatch = selectedGroupTypes.includes(Number(h.groupType || 0));
      const hasHotel = String(h.hotelName || '').trim().toLowerCase() !== 'no hotels available';
      return groupMatch && hasHotel;
    });

    let confirmedFallbackRows: any[] = [];
    if (!selectedHotelRows.length) {
      confirmedFallbackRows = await this.prisma.dvi_confirmed_itinerary_plan_hotel_details.findMany({
        where: {
          itinerary_plan_id: plan.itinerary_plan_ID,
          deleted: 0,
          ...(selectedGroupTypes.length
            ? { group_type: { in: selectedGroupTypes } }
            : {}),
        } as any,
        select: {
          total_room_cost: true,
          total_room_gst_amount: true,
          total_extra_bed_cost: true,
          total_childwith_bed_cost: true,
          total_childwithout_bed_cost: true,
          total_hotel_cost: true,
          total_hotel_tax_amount: true,
          total_amenities_cost: true,
          itinerary_route_id: true,
          group_type: true,
          itinerary_plan_hotel_details_ID: true,
        },
      });
    }

    const dedupedConfirmedRowsMap = new Map<string, any>();
    for (const row of confirmedFallbackRows) {
      const key = `${Number((row as any).itinerary_route_id || 0)}-${Number((row as any).group_type || 0)}`;
      const existing = dedupedConfirmedRowsMap.get(key);
      if (!existing) {
        dedupedConfirmedRowsMap.set(key, row);
        continue;
      }
      if (
        Number((row as any).itinerary_plan_hotel_details_ID || 0) >
        Number((existing as any).itinerary_plan_hotel_details_ID || 0)
      ) {
        dedupedConfirmedRowsMap.set(key, row);
      }
    }
    const dedupedConfirmedRows = Array.from(dedupedConfirmedRowsMap.values());

    const fallbackRoomCostFromHotelRows = selectedHotelRows.reduce((sum: number, h: any) => {
      return sum + Number(h.totalHotelCost || 0) + Number(h.totalHotelTaxAmount || 0);
    }, 0);

    const fallbackRoomCostFromConfirmedRows = dedupedConfirmedRows.reduce((sum: number, h: any) => {
      const hotelCost = Number((h as any).total_hotel_cost || 0);
      const hotelTax = Number((h as any).total_hotel_tax_amount || 0);
      if (hotelCost + hotelTax > 0) {
        return sum + hotelCost + hotelTax;
      }
      return sum + Number((h as any).total_room_cost || 0) + Number((h as any).total_room_gst_amount || 0);
    }, 0);

    const fallbackExtraBedFromConfirmedRows = dedupedConfirmedRows.reduce(
      (sum: number, h: any) => sum + Number((h as any).total_extra_bed_cost || 0),
      0,
    );
    const fallbackChildWithBedFromConfirmedRows = dedupedConfirmedRows.reduce(
      (sum: number, h: any) => sum + Number((h as any).total_childwith_bed_cost || 0),
      0,
    );
    const fallbackChildWithoutBedFromConfirmedRows = dedupedConfirmedRows.reduce(
      (sum: number, h: any) => sum + Number((h as any).total_childwithout_bed_cost || 0),
      0,
    );
    const fallbackAmenitiesFromConfirmedRows = dedupedConfirmedRows.reduce(
      (sum: number, h: any) => sum + Number((h as any).total_amenities_cost || 0),
      0,
    );

    const incomingCost: ClipboardCostBreakdown =
      (itinerary?.costBreakdown ?? {}) as ClipboardCostBreakdown;
    const totalRoomCost =
      Number(incomingCost.totalRoomCost || incomingCost.totalHotelAmount || 0) ||
      fallbackRoomCostFromHotelRows ||
      fallbackRoomCostFromConfirmedRows;
    const totalAmenitiesCost =
      Number(incomingCost.totalAmenitiesCost || 0) || fallbackAmenitiesFromConfirmedRows;
    const extraBedCost =
      Number(incomingCost.extraBedCost || 0) || fallbackExtraBedFromConfirmedRows;
    const childWithBedCost =
      Number(incomingCost.childWithBedCost || 0) || fallbackChildWithBedFromConfirmedRows;
    const childWithoutBedCost =
      Number(incomingCost.childWithoutBedCost || 0) || fallbackChildWithoutBedFromConfirmedRows;
    const totalGuideCost = Number(incomingCost.totalGuideCost || 0);
    const totalHotspotCost = Number(incomingCost.totalHotspotCost || 0);
    const totalActivityCost = Number(incomingCost.totalActivityCost || 0);
    const additionalMargin = Number(incomingCost.additionalMargin || 0);

    const vehicleAmount =
      selectedVehicleAmount > 0
        ? selectedVehicleAmount
        : Number(incomingCost.totalVehicleAmount || incomingCost.totalVehicleCost || 0);

    const totalAmount =
      totalRoomCost +
      vehicleAmount +
      totalAmenitiesCost +
      extraBedCost +
      childWithBedCost +
      childWithoutBedCost +
      totalGuideCost +
      totalHotspotCost +
      totalActivityCost +
      additionalMargin;

    const couponDiscount = Number(incomingCost.couponDiscount || 0);
    const agentMargin = Number(incomingCost.agentMargin || 0);
    const totalRoundOff = Number(incomingCost.totalRoundOff || 0);
    const netPayable = totalAmount - couponDiscount + agentMargin + totalRoundOff;

    const costBreakdown = {
      ...incomingCost,
      totalRoomCost,
      totalVehicleQty: selectedVehicleQty > 0 ? selectedVehicleQty : Number(incomingCost.totalVehicleQty || 0),
      totalVehicleAmount: vehicleAmount,
      totalAmount,
      netPayable,
      extraBed: Number(itinerary.extraBed || 0),
      childWithBed: Number(itinerary.childWithBed || 0),
      childWithoutBed: Number(itinerary.childWithoutBed || 0),
      companyName: incomingCost.companyName || 'Doview Holidays India Pvt ltd',
    };

    const vehiclesHtml = this.buildVehicleSection(vehiclesForClipboard);
    const costHtml = this.buildCostSection(costBreakdown);
    const hotspotHtml = this.buildHotspotSection(mode, itinerary.days || [], {
      firstDayStartLabel:
        globalSettings?.itinerary_break_time || 'Start your Journey',
      otherDayStartLabel:
        globalSettings?.itinerary_hotel_start || 'Start Your Day',
    });
    const termsHtml = this.buildTermsSection(plan, globalSettings);

    const html = `
      <div style="margin:0; padding:0; background-color:#f9f9f9; font-family:Calibri; font-size:11px; color:#302c6e;">
        <div id="contentToCopy" style="font-family:Calibri; font-size:11px !important; color:#302c6e; width:700px;">
          <table width="700" align="left" border="1" cellpadding="0" cellspacing="0" style="border-collapse:collapse; background-color:#fff; font-family:Calibri; font-size:11px; color:#302c6e;">
            <tr><td>${summaryHtml}</td></tr>
            <tr><td>${hotelsHtml}</td></tr>
            <tr><td>${vehiclesHtml}</td></tr>
            <tr><td>${costHtml}</td></tr>
            <tr><td>${hotspotHtml}</td></tr>
            <tr><td>${termsHtml}</td></tr>
          </table>
            <div style="clear:both; display:block; line-height:0; font-size:0; height:0;">&nbsp;</div>
        </div>
      </div>
    `;

    return {
      html,
      plainText: this.stripHtml(html),
    };
  }
}

