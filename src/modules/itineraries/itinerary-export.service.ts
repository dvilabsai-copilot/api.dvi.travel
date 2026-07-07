import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import * as ExcelJS from 'exceljs';

type ItineraryExportResult = {
  workbook: ExcelJS.Workbook;
  fileName: string;
};

@Injectable()
export class ItineraryExportService {
  constructor(private prisma: PrismaService) {}

  async exportItineraryToExcel(planId: number): Promise<ItineraryExportResult> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Worksheet');

    const planData = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_plan_ID: planId, deleted: 0 },
      orderBy: { itinerary_plan_ID: 'desc' },
    });

    if (!planData) {
      throw new NotFoundException('Itinerary plan not found');
    }

    const safeQuoteId = this.safeFilePart(planData.itinerary_quote_ID || `DVI${planId}`);

    const vehicleRows = await this.prisma.$queryRaw<any[]>`
      SELECT
        v.*,
        vt.vehicle_type_title,
        vd.vendor_name,
        vb.vendor_branch_name,
        vb.vendor_branch_location,
        city.name AS vendor_branch_city_name
      FROM dvi_itinerary_plan_vendor_eligible_list v
      LEFT JOIN dvi_vehicle_type vt
        ON vt.vehicle_type_id = v.vehicle_type_id
      LEFT JOIN dvi_vendor_details vd
        ON vd.vendor_id = v.vendor_id
      LEFT JOIN dvi_vendor_branches vb
        ON vb.vendor_branch_id = v.vendor_branch_id
      LEFT JOIN dvi_cities city
        ON city.id = vb.vendor_branch_city
      WHERE v.itinerary_plan_id = ${planId}
        AND v.deleted = 0
        AND v.status = 1
      ORDER BY
        v.vehicle_type_id ASC,
        v.vehicle_total_amount ASC,
        v.itinerary_plan_vendor_eligible_ID ASC
    `;

    const eligibleIds = vehicleRows
      .map((row: any) => Number(row.itinerary_plan_vendor_eligible_ID || 0))
      .filter((id: number) => id > 0);

    const vehicleDetailRows = eligibleIds.length
      ? await this.prisma.$queryRaw<any[]>`
          SELECT
            itinerary_plan_vendor_vehicle_details_ID,
            itinerary_plan_vendor_eligible_ID,
            itinerary_plan_id,
            itinerary_route_id,
            itinerary_route_date,
            vehicle_type_id,
            vehicle_qty,
            vendor_id,
            vendor_vehicle_type_id,
            vehicle_id,
            vendor_branch_id,
            time_limit_id,
            kms_limit_id,
            travel_type,
            itinerary_route_location_from,
            itinerary_route_location_to,
            total_running_km,
            CAST(total_running_time AS CHAR) AS total_running_time,
            total_siteseeing_km,
            CAST(total_siteseeing_time AS CHAR) AS total_siteseeing_time,
            total_pickup_km,
            CAST(total_pickup_duration AS CHAR) AS total_pickup_duration,
            total_drop_km,
            CAST(total_drop_duration AS CHAR) AS total_drop_duration,
            total_extra_km,
            extra_km_rate,
            total_extra_km_charges,
            total_travelled_km,
            total_travelled_time,
            vehicle_rental_charges,
            vehicle_toll_charges,
            vehicle_parking_charges,
            vehicle_driver_charges,
            vehicle_permit_charges,
            before_6_am_extra_time,
            after_8_pm_extra_time,
            before_6_am_charges_for_driver,
            before_6_am_charges_for_vehicle,
            after_8_pm_charges_for_driver,
            after_8_pm_charges_for_vehicle,
            total_vehicle_amount,
            createdon,
            status,
            deleted
          FROM dvi_itinerary_plan_vendor_vehicle_details
          WHERE itinerary_plan_id = ${planId}
            AND deleted = 0
            AND itinerary_plan_vendor_eligible_ID IN (${Prisma.join(eligibleIds)})
          ORDER BY itinerary_plan_vendor_eligible_ID ASC, itinerary_route_date ASC, itinerary_route_id ASC
        `
      : [];

    const detailsByEligibleId = new Map<number, any[]>();
    for (const detailRow of vehicleDetailRows) {
      const eligibleId = Number(detailRow.itinerary_plan_vendor_eligible_ID || 0);
      if (!eligibleId) continue;
      if (!detailsByEligibleId.has(eligibleId)) {
        detailsByEligibleId.set(eligibleId, []);
      }
      detailsByEligibleId.get(eligibleId)!.push(detailRow);
    }

    const thinBorder: Partial<ExcelJS.Borders> = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    };

    const yellowStyle: Partial<ExcelJS.Style> = {
      font: { bold: true },
      alignment: { horizontal: 'left', vertical: 'middle', wrapText: true },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } },
      border: thinBorder,
    };

    const blueStyle: Partial<ExcelJS.Style> = {
      font: { bold: true },
      alignment: { horizontal: 'left', vertical: 'middle', wrapText: true },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF9DC3E6' } },
      border: thinBorder,
    };

    const orangeStyle: Partial<ExcelJS.Style> = {
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFA500' } },
      border: thinBorder,
    };

    const borderedStyle: Partial<ExcelJS.Style> = {
      alignment: { horizontal: 'left', vertical: 'middle', wrapText: true },
      border: thinBorder,
    };

    sheet.columns = [
      { width: 18 },
      { width: 28 },
      { width: 30 },
      { width: 28 },
      { width: 18 },
      { width: 18 },
      { width: 18 },
      { width: 18 },
      { width: 18 },
      { width: 18 },
      { width: 18 },
      { width: 18 },
      { width: 18 },
      { width: 18 },
      { width: 24 },
      { width: 24 },
      { width: 16 },
      { width: 18 },
      { width: 18 },
      { width: 18 },
      { width: 18 },
      { width: 18 },
      { width: 18 },
      { width: 18 },
      { width: 18 },
      { width: 18 },
    ];

    let currentRow = 2;

    this.addStyledRow(
      sheet,
      currentRow,
      [
        'Quote ID',
        planData.itinerary_quote_ID || '',
        'Source Location',
        planData.arrival_location || '',
        'Departure Location',
        planData.departure_location || '',
        'Trip Start Date',
        this.formatDateTime(planData.trip_start_date_and_time),
        'Trip End Date',
        this.formatDateTime(planData.trip_end_date_and_time),
        'No of Days',
        this.toNumber(planData.no_of_days),
        'No of Nights',
        this.toNumber(planData.no_of_nights),
        'No of Adults',
        this.toNumber(planData.total_adult),
        'No of Children',
        this.toNumber(planData.total_children),
        'No of Infants',
        this.toNumber(planData.total_infants),
      ],
      yellowStyle,
      26,
    );
    currentRow += 3;

    const vendorColumns = [
      'Vendor Name',
      'Branch Name',
      'Origin',
      'Total Days',
      'Rental Charges',
      'Toll Charges',
      'Parking Charges',
      'Driver Charges',
      'Permit Charges',
      '6AM Charges(D)',
      '6AM Charges(V)',
      '8PM Charges(D)',
      '8PM Charges(V)',
      'Total Used KM',
      'Total Outstation Allowed KM',
      'Total Location Allowed KM',
      'Extra Rate',
      'Total Extra KM',
      'Extra Charge',
      'Subtotal',
      'GST Amount',
      'Margin Amount',
      'Margin Tax Amount',
      'Total Sales',
      'Total Cost',
      'Total P&L',
    ];

    const dayColumns = [
      'Day',
      'Location',
      'Cost Type',
      'Total Travelled KM',
      'Total Travelled Time',
      'Total Pickup KM',
      'Total Pickup Duration',
      'Total Drop KM',
      'Total Drop Duration',
    ];

    if (!vehicleRows.length) {
      this.addMergedSectionRow(
        sheet,
        currentRow,
        'No vehicle export data found for this itinerary.',
        orangeStyle,
        26,
      );

      return {
        workbook,
        fileName: `ITINERARY-${safeQuoteId}.xlsx`,
      };
    }

    for (const vehicleRow of vehicleRows) {
      const eligibleId = Number(vehicleRow.itinerary_plan_vendor_eligible_ID || 0);
      const dayRows = detailsByEligibleId.get(eligibleId) || [];
      const vehicleTypeTitle =
        this.cleanString(vehicleRow.vehicle_type_title) || 'Vehicle';
      const requiredVehicleCount =
        this.toNumber(vehicleRow.total_vehicle_qty || vehicleRow.vehicle_count || 1) || 1;

      this.addMergedSectionRow(
        sheet,
        currentRow,
        `Vehicle Type: ${vehicleTypeTitle} | Total Required Vehicle Count: ${requiredVehicleCount} `,
        orangeStyle,
        26,
      );
      currentRow += 2;

      this.addStyledRow(sheet, currentRow, vendorColumns, yellowStyle, 26);
      currentRow += 1;

      const subtotal = this.toNumber(vehicleRow.vehicle_total_amount);
      const gstAmount = this.toNumber(vehicleRow.vehicle_gst_amount);
      const marginAmount = this.toNumber(vehicleRow.vendor_margin_amount);
      const marginTaxAmount = this.toNumber(vehicleRow.vendor_margin_gst_amount);
      const totalCost = Number(subtotal || 0) + Number(gstAmount || 0);
      const totalSales =
        this.toNumber(vehicleRow.vehicle_grand_total) ||
        totalCost + marginAmount + marginTaxAmount;
      const totalUsedKm =
        this.toNumber(vehicleRow.total_kms) ||
        dayRows.reduce(
          (sum: number, detailRow: any) =>
            sum + this.toNumber(detailRow.total_travelled_km),
          0,
        );
      const totalExtraKm =
        Number(this.toNumber(vehicleRow.total_extra_kms) || 0) +
        Number(this.toNumber(vehicleRow.total_extra_local_kms) || 0);
      const totalExtraCharge =
        Number(this.toNumber(vehicleRow.total_extra_kms_charge) || 0) +
        Number(this.toNumber(vehicleRow.total_extra_local_kms_charge) || 0);

      this.addStyledRow(
        sheet,
        currentRow,
        [
          this.cleanString(vehicleRow.vendor_name) || '-',
          this.cleanString(vehicleRow.vendor_branch_name) || '-',
          this.cleanString(vehicleRow.vehicle_orign) ||
            this.cleanString(vehicleRow.vendor_branch_city_name) ||
            this.cleanString(vehicleRow.vendor_branch_location) ||
            '-',
          `Day- ${this.toNumber(planData.no_of_days) || dayRows.length || 0}`,
          this.toNumber(vehicleRow.total_rental_charges),
          this.toNumber(vehicleRow.total_toll_charges),
          this.toNumber(vehicleRow.total_parking_charges),
          this.toNumber(vehicleRow.total_driver_charges),
          this.toNumber(vehicleRow.total_permit_charges),
          this.toNumber(vehicleRow.total_before_6_am_charges_for_driver),
          this.toNumber(vehicleRow.total_before_6_am_charges_for_vehicle),
          this.toNumber(vehicleRow.total_after_8_pm_charges_for_driver),
          this.toNumber(vehicleRow.total_after_8_pm_charges_for_vehicle),
          totalUsedKm,
          this.toNumber(vehicleRow.total_allowed_kms),
          this.toNumber(vehicleRow.total_allowed_local_kms),
          this.toNumber(vehicleRow.extra_km_rate),
          totalExtraKm,
          totalExtraCharge,
          subtotal,
          gstAmount,
          marginAmount,
          marginTaxAmount,
          totalSales,
          totalCost,
          Number(totalSales || 0) - totalCost,
        ],
        borderedStyle,
        26,
      );
      currentRow += 2;

      this.addStyledRow(sheet, currentRow, dayColumns, blueStyle, 9);
      currentRow += 1;

      if (!dayRows.length) {
        this.addStyledRow(
          sheet,
          currentRow,
          ['-', 'No day-wise vehicle details found', '-', '', '', '', '', '', ''],
          borderedStyle,
          9,
        );
        currentRow += 2;
        continue;
      }

      dayRows.forEach((detailRow: any, index: number) => {
        this.addStyledRow(
          sheet,
          currentRow,
          [
            `Day ${index + 1}`,
            this.getRouteLocationText(detailRow),
            this.getTravelTypeText(detailRow.travel_type),
            this.toNumber(detailRow.total_travelled_km),
            this.cleanString(detailRow.total_travelled_time) ||
              this.cleanString(detailRow.total_running_time),
            this.toNumberOrBlank(detailRow.total_pickup_km),
            this.formatDurationText(detailRow.total_pickup_duration),
            this.toNumberOrBlank(detailRow.total_drop_km),
            this.formatDurationText(detailRow.total_drop_duration),
          ],
          borderedStyle,
          9,
        );
        currentRow += 1;
      });

      currentRow += 2;
    }
    this.optimizeWorksheetSpacing(sheet);

    return {
      workbook,
      fileName: `ITINERARY-${safeQuoteId}.xlsx`,
    };
  }

  private addStyledRow(
    sheet: ExcelJS.Worksheet,
    rowNumber: number,
    values: any[],
    style: Partial<ExcelJS.Style>,
    totalColumns: number,
  ) {
    const row = sheet.getRow(rowNumber);
    row.values = [undefined, ...values];
    for (let col = 1; col <= totalColumns; col += 1) {
      row.getCell(col).style = { ...style };
    }
  }

  private addMergedSectionRow(
    sheet: ExcelJS.Worksheet,
    rowNumber: number,
    value: string,
    style: Partial<ExcelJS.Style>,
    totalColumns: number,
  ) {
    sheet.mergeCells(rowNumber, 1, rowNumber, totalColumns);
    const row = sheet.getRow(rowNumber);
    row.getCell(1).value = value;
    for (let col = 1; col <= totalColumns; col += 1) {
      row.getCell(col).style = { ...style };
    }
  }



    private optimizeWorksheetSpacing(sheet: ExcelJS.Worksheet) {
    const minRowHeight = 18;
    const maxRowHeight = 95;
    const lineHeight = 15;

    sheet.eachRow({ includeEmpty: false }, (row) => {
      let maxLineCount = 1;
      let hasMergedCell = false;

      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const text = this.getCellTextForSpacing(cell.value);
        const columnWidth = Number(sheet.getColumn(colNumber).width || 12);

        if ((cell as any).isMerged) {
          hasMergedCell = true;
        }

        cell.alignment = {
          ...cell.alignment,
          vertical: 'top',
          wrapText: true,
        };

        if (!text) return;

        const effectiveWidth = (cell as any).isMerged
          ? 120
          : Math.max(8, columnWidth);

        const lineCount = text
          .split(/\r\n|\r|\n/)
          .reduce((total, line) => {
            const cleanLine = line.trim();
            if (!cleanLine) return total + 1;

            return total + Math.max(1, Math.ceil(cleanLine.length / (effectiveWidth * 1.1)));
          }, 0);

        maxLineCount = Math.max(maxLineCount, lineCount);
      });

      if (hasMergedCell) {
        row.height = 22;
        return;
      }

      row.height = Math.min(
        maxRowHeight,
        Math.max(minRowHeight, maxLineCount * lineHeight + 4),
      );
    });
  }

  private getCellTextForSpacing(value: ExcelJS.CellValue): string {
    if (value === null || value === undefined) return '';

    if (value instanceof Date) {
      return this.formatDateTime(value);
    }

    if (typeof value === 'object') {
      const cellObject: any = value;

      if (cellObject.result !== undefined) {
        return this.getCellTextForSpacing(cellObject.result);
      }

      if (cellObject.text !== undefined) {
        return String(cellObject.text);
      }

      if (Array.isArray(cellObject.richText)) {
        return cellObject.richText
          .map((item: any) => item?.text || '')
          .join('');
      }

      return '';
    }

    return String(value);
  }

  private cleanString(value: any): string {
    if (value === null || value === undefined) return '';
    return String(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }
  
  private hasValue(value: any): boolean {
    return value !== null && value !== undefined && String(value).trim() !== '';
  }

  private toNumber(value: any): number {
    if (!this.hasValue(value)) return 0;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  private toNumberOrBlank(value: any): number | '' {
    if (!this.hasValue(value)) return '';
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : '';
  }

  private safeFilePart(value: string): string {
    const cleaned = this.cleanString(value).replace(/[^a-zA-Z0-9_-]/g, '');
    return cleaned || 'DVI';
  }

  private formatDateTime(value: any): string {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return this.cleanString(value);

    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHour = String(hours % 12 || 12).padStart(2, '0');

    return `${day}/${month}/${year} ${displayHour}:${minutes} ${ampm}`;
  }

  private formatDurationText(value: any): string {
    if (!this.hasValue(value)) return '';

    const text = this.cleanString(value);
    const match = text.match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?/);
    if (!match) return text;

    const hours = Number(match[1] || 0);
    const minutes = Number(match[2] || 0);
    const seconds = Number(match[3] || 0);
    const totalMinutes = Math.max(0, Math.round(hours * 60 + minutes + seconds / 60));
    const displayHours = Math.floor(totalMinutes / 60);
    const displayMinutes = totalMinutes % 60;

    if (displayHours > 0 && displayMinutes > 0) {
      return `${displayHours} Hour ${displayMinutes} Min`;
    }
    if (displayHours > 0) {
      return `${displayHours} Hour`;
    }
    return `${displayMinutes} Min`;
  }

  private getTravelTypeText(value: any): string {
    const travelType = Number(value || 0);
    if (travelType === 1) return 'Local Trip';
    if (travelType === 2) return 'Outstation Trip';
    return 'Trip';
  }

  private getRouteLocationText(row: any): string {
    const from = this.cleanString(row?.itinerary_route_location_from);
    const to = this.cleanString(row?.itinerary_route_location_to);
    if (from && to) return `${from} to ${to}`;
    return from || to || '-';
  }
}