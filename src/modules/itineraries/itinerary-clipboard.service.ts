import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { ItineraryDetailsService } from './itinerary-details.service';
import { ItineraryHotelDetailsService } from './itinerary-hotel-details.service';

type ClipboardMode = 'recommended' | 'highlights' | 'para';

export interface ClipboardPayload {
  html: string;
  plainText: string;
}

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

    return `
      <table width="700" align="left" border="0" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background-color:#fff; font-family:Calibri; font-size:11px; color:#302c6e;">
        <tr>
          <td align="center" valign="middle" style="color:#302c6e; font-size:22px; line-height:40px; font-weight:600; text-align:center;">
            Tour Itinerary Plan
          </td>
        </tr>
      </table>
      <table width="700" align="left" border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse; background:#fff; font-size:11px; line-height:1.2; font-family:Calibri; color:#302c6e;">
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

    let html = '';

    for (const groupType of selectedGroupTypes) {
      const groupRows = hotels
        .filter((h) => Number(h.groupType) === groupType)
        .sort((a, b) => Number(a.itineraryRouteId || 0) - Number(b.itineraryRouteId || 0));

      const rowHtml = groupRows.length
        ? groupRows
            .map((hotel, idx) => {
              const baseDayAmount = Number(hotel.totalHotelCost || 0) + Number(hotel.totalHotelTaxAmount || 0);
              const addMargin = noOfDays <= additionalMarginDayLimit
                ? (additionalMarginPct * baseDayAmount) / 100
                : 0;

              return `
                <tr>
                  <td style="text-align:left; width:15%; border:1px solid #b1b1b1; padding:3px;">Day- ${idx + 1} | ${this.escapeHtml(this.formatDate(hotel.date || hotel.day))}</td>
                  <td style="text-align:left; width:15%; border:1px solid #b1b1b1; padding:3px;">${this.escapeHtml(hotel.destination || '')}</td>
                  <td style="text-align:left; width:15%; border:1px solid #b1b1b1; padding:3px;">${this.escapeHtml(hotel.hotelName || '--')} - ${this.escapeHtml(hotel.category ?? '')}</td>
                  <td style="text-align:left; width:15%; border:1px solid #b1b1b1; padding:3px;">${this.escapeHtml(hotel.roomType || '')} - ${roomCount || '-'}</td>
                  ${showRates ? `<td style="text-align:left; width:15%; border:1px solid #b1b1b1; padding:3px;"><b>${this.escapeHtml(this.formatCurrency(baseDayAmount + addMargin))}</b></td>` : ''}
                  <td style="text-align:left; width:15%; border:1px solid #b1b1b1; padding:3px;">${this.escapeHtml(hotel.mealPlan || 'EP')}</td>
                </tr>
              `;
            })
            .join('')
        : `<tr><td colspan="${showRates ? 6 : 5}" style="border: 1px solid #b1b1b1;text-align: center;">No hotel available</td></tr>`;

      html += `
        <table width="700" align="left" border="0" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background-color:#fff; font-family:Calibri; font-size:11px; color:#302c6e;">
          <tr>
            <td align="center" valign="middle" style="color:#302c6e; font-size:18px; line-height:40px; font-weight:600;">Recommended Hotel - ${groupType}</td>
          </tr>
        </table>
        <table width="100%" align="left" border="0" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background-color:#fff; font-family:Calibri; font-size:11px; color:#302c6e;">
          <tr>
            <th style="background-color:#f2f2f2; text-align:left; padding:3px; border:1px solid #b1b1b1;">Day</th>
            <th style="background-color:#f2f2f2; text-align:left; padding:3px; border:1px solid #b1b1b1;">Destination</th>
            <th style="background-color:#f2f2f2; text-align:left; padding:3px; border:1px solid #b1b1b1;">Hotel Name - Category</th>
            <th style="background-color:#f2f2f2; text-align:left; padding:3px; border:1px solid #b1b1b1;">Room Type - Count</th>
            ${showRates ? '<th style="background-color:#f2f2f2; text-align:left; padding:3px; border:1px solid #b1b1b1;">Price</th>' : ''}
            <th style="background-color:#f2f2f2; text-align:left; padding:3px; border:1px solid #b1b1b1;">Meal Plan</th>
          </tr>
          ${rowHtml}
        </table>
        <table width="700" align="left" border="0" cellpadding="0" cellspacing="0"><tr><td><span>&nbsp;</span></td></tr></table>
      `;
    }

    return html;
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
      <table width="700" align="left" border="0" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background-color:#fff; font-family:Calibri; font-size:11px; color:#302c6e;">
        <tr><td align="center" valign="middle" style="color:#302c6e; font-size:18px; line-height:40px; font-weight:600;">Vehicle Details</td></tr>
      </table>
      <table width="100%" align="left" border="0" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background-color:#fff; font-family:Calibri; font-size:11px; color:#302c6e;">
        <tr>
          <th style="background-color:#f2f2f2; text-align:left; padding:3px; border:1px solid #b1b1b1;">Vehicle Details</th>
          <th style="background-color:#f2f2f2; text-align:left; padding:3px; border:1px solid #b1b1b1;">Total Amount</th>
        </tr>
        ${rows}
      </table>
      <table width="700" align="left" border="0" cellpadding="0" cellspacing="0"><tr><td><span>&nbsp;</span></td></tr></table>
    `;
  }

  private buildCostSection(cost: any): string {
    const couponDiscount = Number(cost.couponDiscount || 0);
    const totalRoundOff = Number(cost.totalRoundOff || 0);
    const totalVehicleQty = Number(cost.totalVehicleQty || 0);
    const safeVehicleQty = totalVehicleQty > 0 ? totalVehicleQty : 0;
    const roundOffLabel = totalRoundOff >= 0 ? `${this.formatCurrencyInr(totalRoundOff)}` : `- ${this.formatCurrencyInr(totalRoundOff)}`;

    return `
      <table width="700" align="left" border="0" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background-color:#fff; font-family:Calibri; font-size:11px; color:#302c6e;">
        <tr><th style="text-align:left; padding:3px; border:1px solid #b1b1b1;">Total Vehicle Amount Total Vehicle Cost (${this.escapeHtml(safeVehicleQty)})</th><td style="text-align:left; padding:3px; border:1px solid #b1b1b1;"><b>${this.escapeHtml(this.formatCurrencyInr(Number(cost.totalVehicleAmount || 0)))}</b></td></tr>
        <tr><th style="text-align:left; padding:3px; border:1px solid #b1b1b1;">Total Amount</th><td style="text-align:left; padding:3px; border:1px solid #b1b1b1;"><b>${this.escapeHtml(this.formatCurrencyInr(Number(cost.totalAmount || 0)))}</b></td></tr>
        ${couponDiscount !== 0 ? `<tr><th style="text-align:left; padding:3px; border:1px solid #b1b1b1;">Coupon Discount</th><td style="text-align:left; padding:3px; border:1px solid #b1b1b1;">- ${this.escapeHtml(this.formatCurrencyInr(couponDiscount))}</td></tr>` : ''}
        <tr><th style="text-align:left; padding:3px; border:1px solid #b1b1b1;">Total Round Off</th><td style="text-align:left; padding:3px; border:1px solid #b1b1b1;">${this.escapeHtml(roundOffLabel)}</td></tr>
        <tr><th style="text-align:left; padding:3px; border:1px solid #b1b1b1;">Net Payable To ${this.escapeHtml(cost.companyName || 'DVI')}</th><td style="text-align:left; padding:3px; border:1px solid #b1b1b1;"><b>${this.escapeHtml(this.formatCurrencyInr(Number(cost.netPayable || 0)))}</b></td></tr>
      </table>
      <table width="700" align="left" border="0" cellpadding="0" cellspacing="0"><tr><td><span>&nbsp;</span></td></tr></table>
    `;
  }

  private buildHotspotSection(mode: ClipboardMode, days: any[]): string {
    let html = `
      <table width="700" align="left" border="0" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background-color:#fff; font-family:Calibri; font-size:11px; color:#302c6e;">
        <tr><td align="center" valign="middle" style="color:#302c6e; font-size:18px; line-height:40px; font-weight:600;">Hotspot Details</td></tr>
      </table>
    `;

    for (const day of days || []) {
      const dayTitle = `Day ${day.dayNumber} | ${this.formatDate(day.date)}`;
      const locationTitle = this.escapeHtml(day.arrival || day.departure || '');

      const lines: string[] = [];
      const segments = Array.isArray(day.segments) ? day.segments : [];

      for (const segment of segments) {
        if (mode === 'highlights') {
          if (segment.type === 'attraction') {
            lines.push(`<div><b>${this.escapeHtml(segment.name || '')}</b> ${this.escapeHtml(segment.description || '')}</div>`);
          }
          continue;
        }

        if (segment.type === 'start') {
          lines.push(`<div>Start: ${this.escapeHtml(segment.title || '')} ${this.escapeHtml(segment.timeRange || '')}</div>`);
          continue;
        }

        if (segment.type === 'travel') {
          lines.push(`<div>Travel: ${this.escapeHtml(segment.from || '')} to ${this.escapeHtml(segment.to || '')} (${this.escapeHtml(segment.distance || '')} / ${this.escapeHtml(segment.duration || '')})</div>`);
          continue;
        }

        if (segment.type === 'break') {
          lines.push(`<div>Break: ${this.escapeHtml(segment.location || '')} ${this.escapeHtml(segment.timeRange || '')}</div>`);
          continue;
        }

        if (segment.type === 'attraction') {
          lines.push(`<div><b>${this.escapeHtml(segment.name || '')}</b> ${this.escapeHtml(segment.description || '')}</div>`);
          continue;
        }

        if (segment.type === 'checkin' && mode === 'para') {
          lines.push(`<div>Check-in: ${this.escapeHtml(segment.hotelName || 'Hotel')} ${this.escapeHtml(segment.time || '')}</div>`);
          continue;
        }

        if (segment.type === 'return') {
          lines.push(`<div>Return: ${this.escapeHtml(segment.time || '')}</div>`);
        }
      }

      if (!lines.length) {
        continue;
      }

      html += `
        <table width="700" align="left" border="0" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background-color:#fff; font-family:Calibri; font-size:11px; color:#302c6e; margin-top:8px;">
          <tr><td style="padding:3px; border:1px solid #b1b1b1;"><b>${this.escapeHtml(dayTitle)}</b> - ${locationTitle}</td></tr>
          <tr><td style="padding:3px; border:1px solid #b1b1b1;">${lines.join('')}</td></tr>
        </table>
      `;
    }

    return html;
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

    const itinerary = await this.detailsService.getItineraryDetails(quoteId);
    const hotelDetails = await this.hotelDetailsService.getHotelDetailsByQuoteId(quoteId);

    const selectedGroupTypes = this.normalizeGroupTypes(requestedGroupTypes);
    const showRates = Boolean(hotelDetails.hotelRatesVisible);

    const additionalMarginPct = Number(process.env.ITINERARY_ADDITIONAL_MARGIN_PERCENTAGE || 0);
    const additionalMarginDayLimit = Number(process.env.ITINERARY_ADDITIONAL_MARGIN_DAY_LIMIT || 0);

    const summaryHtml = this.buildSummaryTable(plan);
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

    const costBreakdown = {
      ...(itinerary.costBreakdown || {}),
      totalVehicleQty: selectedVehicleQty,
      totalVehicleAmount:
        selectedVehicleAmount > 0
          ? selectedVehicleAmount
          : Number((itinerary.costBreakdown || {}).totalVehicleAmount || 0),
    };

    const vehiclesHtml = this.buildVehicleSection(vehiclesForClipboard);
    const costHtml = this.buildCostSection(costBreakdown);
    const hotspotHtml = this.buildHotspotSection(mode, itinerary.days || []);

    const html = `
      <div style="margin:0; padding:0; background-color:#f9f9f9; font-family:Calibri; font-size:11px; color:#302c6e;">
        <div id="contentToCopy" style="font-family:Calibri; font-size:11px !important; color:#302c6e; width:700px;">
          ${summaryHtml}
          ${hotelsHtml}
          ${vehiclesHtml}
          ${costHtml}
          ${hotspotHtml}
        </div>
      </div>
    `;

    return {
      html,
      plainText: this.stripHtml(html),
    };
  }
}
