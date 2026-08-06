import { Injectable, NotFoundException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../prisma.service';

type ItineraryExportResult = { workbook: ExcelJS.Workbook; fileName: string };

const vehicleHeaders = ['Vendor Name', 'Branch Name', 'Origin', 'Total Days', 'Rental Charges', 'Toll Charges', 'Parking Charges', 'Driver Charges', 'Permit Charges', '6AM Charges(D)', '6AM Charges(V)', '8PM Charges(D)', '8PM Charges(V)', 'Total Used KM', 'Total Outstation Allowed KM', 'Total Location Allowed KM', 'Extra Rate', 'Total Extra KM', 'Extra Charge', 'Subtotal', 'GST Amount', 'Margin Amount', 'Margin Tax Amount', 'Total Sales', 'Total Cost', 'Total P&L'];
const dayHeaders = ['Day', 'Location', 'Cost Type', 'Total Travelled KM', 'Total Travelled Time', 'Total Pickup KM', 'Total Pickup Duration', 'Total Drop KM', 'Total Drop Duration'];
const hotelHeaders = ['Day', 'Destination', 'Hotel & Category', 'Room Type', 'Meal Plan', 'No of Room', 'Extra Bed Count', 'CWB Count', 'CNB Count', 'Room Rent', 'Breakfast', 'Lunch', 'Dinner', 'EB Cost', 'CWB Cost', 'CNB Cost', 'Margin Cost', 'Margin Rate Tax', 'Total Sales', 'Total Cost', 'Total P&L'];

@Injectable()
export class ItineraryExportService {
  constructor(private readonly prisma: PrismaService) {}

  async exportItineraryToExcel(planId: number): Promise<ItineraryExportResult> {
    const plan = await this.prisma.dvi_itinerary_plan_details.findFirst({ where: { itinerary_plan_ID: planId, deleted: 0 } });
    if (!plan) throw new NotFoundException('Itinerary plan not found');

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Worksheet');
    const styles = this.styles();
    let row = 2;
    this.writeHeaderRow(sheet, row, ['Quote ID', plan.itinerary_quote_ID || '', 'Source Location', plan.arrival_location || '', 'Departure Location', plan.departure_location || '', 'Trip Start Date', this.dateTime(plan.trip_start_date_and_time), 'Trip End Date', this.dateTime(plan.trip_end_date_and_time), 'No of Days', this.num(plan.no_of_days), 'No of Nights', this.num(plan.no_of_nights), 'No of Adults', this.num(plan.total_adult), 'No of Children', this.num(plan.total_children), 'No of Infants', this.num(plan.total_infants)], styles);
    row += 3;

    const preference = Number(plan.itinerary_preference);
    if (preference === 1 || preference === 3) row = await this.writeHotels(sheet, row, planId, styles);
    if (preference === 3) row += 1;
    if (preference === 2 || preference === 3) row = await this.writeVehicles(sheet, row, planId, this.num(plan.no_of_days), preference, styles);
    this.autoSize(sheet);
    return { workbook, fileName: `ITINERARY-${this.safeFilePart(plan.itinerary_quote_ID || `DVI${planId}`)}.xlsx` };
  }

  private async writeHotels(sheet: ExcelJS.Worksheet, start: number, planId: number, styles: ReturnType<ItineraryExportService['styles']>): Promise<number> {
    const groups = await this.prisma.$queryRaw<any[]>`SELECT group_type FROM dvi_itinerary_plan_hotel_details WHERE itinerary_plan_id = ${planId} AND deleted = 0 GROUP BY group_type ORDER BY group_type`;
    let row = start;
    let counter = 1;
    for (const group of groups) {
      sheet.mergeCells(row, 1, row, 21);
      this.writeMerged(sheet, row, `Hotel Recommendation - ${counter++}`, styles.orange, 21);
      row += 1;
      this.writeRow(sheet, row, hotelHeaders, styles.yellow, 21);
      row += 1;
      const details = await this.prisma.$queryRaw<any[]>`
        SELECT h.*, MAX(r.breakfast_required) AS breakfast_required, MAX(r.lunch_required) AS lunch_required, MAX(r.dinner_required) AS dinner_required,
          MAX(r.breakfast_cost_per_person) AS breakfast_cost_per_person, MAX(r.lunch_cost_per_person) AS lunch_cost_per_person, MAX(r.dinner_cost_per_person) AS dinner_cost_per_person,
          COALESCE(SUM(r.extra_bed_count), 0) AS room_extra_bed_count,
          COALESCE(SUM(r.child_without_bed_count), 0) AS room_cnb_count,
          COALESCE(SUM(r.child_with_bed_count), 0) AS room_cwb_count,
          MAX(hotel.hotel_name) AS hotel_name, MAX(rt.room_type_title) AS room_type_title
        FROM dvi_itinerary_plan_hotel_details h
        LEFT JOIN dvi_itinerary_plan_hotel_room_details r ON r.itinerary_plan_hotel_details_id = h.itinerary_plan_hotel_details_ID AND r.group_type = h.group_type AND r.deleted = 0 AND r.status = 1
        LEFT JOIN dvi_hotel hotel ON hotel.hotel_id = h.hotel_id
        LEFT JOIN dvi_hotel_roomtype rt ON rt.room_type_id = r.room_type_id
        WHERE h.itinerary_plan_id = ${planId} AND h.group_type = ${Number(group.group_type)} AND h.deleted = 0 AND h.status = 1
        GROUP BY h.itinerary_plan_hotel_details_ID, h.itinerary_route_date ORDER BY h.itinerary_route_date ASC`;
      let overallCost = 0, overallSales = 0, overallPL = 0;
      for (const d of details) {
        const roomRent = this.num(d.total_room_cost) + this.num(d.total_room_gst_amount);
        const totalCost = this.num(d.hotel_margin_rate) + this.num(d.hotel_margin_rate_tax_amt) + this.num(d.total_hotel_meal_plan_cost) + this.num(d.total_hotel_meal_plan_cost_gst_amount) + this.num(d.total_extra_bed_cost) + this.num(d.total_extra_bed_cost_gst_amount) + this.num(d.total_childwith_bed_cost) + this.num(d.total_childwith_bed_cost_gst_amount) + this.num(d.total_childwithout_bed_cost) + this.num(d.total_childwithout_bed_cost_gst_amount) + this.num(d.total_room_cost) + this.num(d.total_room_gst_amount) + this.num(d.total_amenities_cost) + this.num(d.total_amenities_gst_amount);
        const totalSales = this.num(d.total_hotel_meal_plan_cost) + this.num(d.total_hotel_meal_plan_cost_gst_amount) + this.num(d.total_extra_bed_cost) + this.num(d.total_extra_bed_cost_gst_amount) + this.num(d.total_childwith_bed_cost) + this.num(d.total_childwith_bed_cost_gst_amount) + this.num(d.total_childwithout_bed_cost) + this.num(d.total_childwithout_bed_cost_gst_amount) + this.num(d.total_room_cost) + this.num(d.total_room_gst_amount) + this.num(d.total_amenities_cost) + this.num(d.total_amenities_gst_amount);
        const pl = totalCost - totalSales; overallCost += totalCost; overallSales += totalSales; overallPL += pl;
        const meals = [['B', d.breakfast_required, d.breakfast_cost_per_person], ['L', d.lunch_required, d.lunch_cost_per_person], ['D', d.dinner_required, d.dinner_cost_per_person]].filter(([, required, cost]) => Number(required) === 1 && this.num(cost) !== 0).map(([label]) => label).join(', ') || 'EP';
        this.writeRow(sheet, row, [this.date(d.itinerary_route_date), d.itinerary_route_location || '', d.hotel_name || '', d.room_type_title || '', meals, this.num(d.total_no_of_rooms), this.num(d.room_extra_bed_count), this.num(d.room_cnb_count), this.num(d.room_cwb_count), roomRent, this.num(d.hotel_breakfast_cost), this.num(d.hotel_lunch_cost), this.num(d.hotel_dinner_cost), this.num(d.total_extra_bed_cost), this.num(d.total_childwith_bed_cost), this.num(d.total_childwithout_bed_cost), this.num(d.hotel_margin_rate), this.num(d.hotel_margin_rate_tax_amt), totalCost, totalSales, pl], styles.data, 21, 10);
        row += 1;
      }
      if (details.length) {
        this.writePartialRow(sheet, row, 19, overallCost, styles.green); this.writePartialRow(sheet, row, 20, overallSales, styles.green); this.writePartialRow(sheet, row, 21, overallPL, styles.green);
      }
      row += 2;
    }
    return row + 1;
  }

  private async writeVehicles(sheet: ExcelJS.Worksheet, start: number, planId: number, noOfDays: number, preference: number, styles: ReturnType<ItineraryExportService['styles']>): Promise<number> {
    const types = await this.prisma.$queryRaw<any[]>`SELECT vehicle_type_id, vehicle_count FROM dvi_itinerary_plan_vehicle_details WHERE itinerary_plan_id = ${planId} AND deleted = 0 AND status = 1 ORDER BY vehicle_type_id`;
    let row = start;
    const width = preference === 2 ? 21 : 26;
    for (const type of types) {
      const titleRows = await this.prisma.$queryRaw<any[]>`SELECT vehicle_type_title FROM dvi_vehicle_type WHERE vehicle_type_id = ${Number(type.vehicle_type_id)} LIMIT 1`;
      const title = titleRows[0]?.vehicle_type_title || 'Vehicle';
      sheet.mergeCells(row, 1, row, width); this.writeMerged(sheet, row, `Vehicle Type: ${title} | Total Required Vehicle Count: ${this.num(type.vehicle_count)} `, styles.orange, width); row += 1;
      const vehicles = await this.prisma.$queryRaw<any[]>`SELECT v.*, vd.vendor_name, vb.vendor_branch_name FROM dvi_itinerary_plan_vendor_eligible_list v LEFT JOIN dvi_vendor_details vd ON vd.vendor_id = v.vendor_id LEFT JOIN dvi_vendor_branches vb ON vb.vendor_branch_id = v.vendor_branch_id WHERE v.itinerary_plan_id = ${planId} AND v.vehicle_type_id = ${Number(type.vehicle_type_id)} AND v.deleted = 0 AND v.status = 1 ORDER BY v.itinerary_plan_vendor_eligible_ID`;
      for (const v of vehicles) {
        this.writeRow(sheet, row, vehicleHeaders, styles.yellow, 26); row += 1;
        const qty = this.num(v.total_vehicle_qty), grand = this.num(v.vehicle_grand_total), margin = this.num(v.vendor_margin_amount), marginTax = this.num(v.vendor_margin_gst_amount);
        const totalAmount = Math.round(qty * grand), totalSale = Math.round(totalAmount - margin - marginTax), totalPL = Math.round(margin + marginTax);
        const details = await this.prisma.$queryRaw<any[]>`SELECT d.*, r.location_name, r.next_visiting_location FROM dvi_itinerary_plan_vendor_vehicle_details d LEFT JOIN dvi_itinerary_route_details r ON r.itinerary_route_ID = d.itinerary_route_id WHERE d.itinerary_plan_vendor_eligible_ID = ${Number(v.itinerary_plan_vendor_eligible_ID)} AND d.deleted = 0 AND d.status = 1 ORDER BY d.itinerary_route_date ASC, d.itinerary_route_id ASC`;
        const pickupKm = details.reduce((sum, d) => sum + this.num(d.total_pickup_km), 0), dropKm = details.reduce((sum, d) => sum + this.num(d.total_drop_km), 0);
        this.writeRow(sheet, row, [v.vendor_name || '-', v.vendor_branch_name || '-', v.vehicle_orign || '', `Day- ${noOfDays}`, this.round(v.total_rental_charges), this.round(v.total_toll_charges), this.round(v.total_parking_charges), this.round(v.total_driver_charges), this.round(v.total_permit_charges), this.round(v.total_before_6_am_charges_for_driver), this.round(v.total_before_6_am_charges_for_vehicle), this.round(v.total_after_8_pm_charges_for_driver), this.round(v.total_after_8_pm_charges_for_vehicle), this.round(v.total_kms), this.round(v.total_allowed_kms), this.round(v.total_allowed_local_kms), this.round(v.extra_km_rate), this.round(this.num(v.total_extra_kms) + this.num(v.total_extra_local_kms)), this.round(this.num(v.total_extra_kms_charge) + this.num(v.total_extra_local_kms_charge)), this.round(v.vehicle_total_amount), this.round(v.vehicle_gst_amount), this.round(margin), this.round(marginTax), totalAmount, totalSale, totalPL], styles.data, 26, 5, 26);
        row += 1; this.writeRow(sheet, row, dayHeaders, styles.blue, 9); row += 2;
        details.forEach((d, index) => { const first = index === 0, last = index === details.length - 1; this.writeRow(sheet, row++, [`Day ${index + 1}`, `${d.location_name || ''} to ${d.next_visiting_location || ''}`, Number(d.travel_type) === 1 ? 'Local Trip' : 'Outstation Trip', this.round(d.total_travelled_km), d.total_travelled_time || '', preference === 2 && first ? pickupKm : (preference === 3 ? this.num(d.total_pickup_km) : ''), preference === 2 && first ? this.duration(details, 'pickup') : (preference === 3 ? this.durationValue(d.total_pickup_duration) : ''), preference === 2 && last ? dropKm : (preference === 3 ? this.num(d.total_drop_km) : ''), preference === 2 && last ? this.duration(details, 'drop') : (preference === 3 ? this.durationValue(d.total_drop_duration) : '')], styles.data, 9, 1); });
        row += 2;
      }
      row += 1;
    }
    return row;
  }

  private styles() { const border: Partial<ExcelJS.Borders> = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }; const fill = (argb: string, bold = false): Partial<ExcelJS.Style> => ({ font: { bold }, alignment: { horizontal: 'left', vertical: 'middle', wrapText: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb } }, border }); return { yellow: fill('FFFFFF00', true), blue: fill('FF8DB4E2', true), orange: fill('FFFFA500', true), green: fill('FF90EE90', true), label: { font: { bold: true }, alignment: { horizontal: 'left' }, border } as Partial<ExcelJS.Style>, data: { alignment: { vertical: 'middle', wrapText: true }, border } as Partial<ExcelJS.Style> }; }
  private writeHeaderRow(sheet: ExcelJS.Worksheet, rowNumber: number, values: any[], styles: ReturnType<ItineraryExportService['styles']>) { values.forEach((value, index) => { const cell = sheet.getRow(rowNumber).getCell(index + 1); cell.value = value; cell.style = { ...(index < 2 ? styles.yellow : index % 2 === 0 ? styles.label : styles.data) }; }); }
  private writeRow(sheet: ExcelJS.Worksheet, rowNumber: number, values: any[], style: Partial<ExcelJS.Style>, columns: number, moneyFrom?: number, moneyTo?: number) { const row = sheet.getRow(rowNumber); values.forEach((value, i) => { const cell = row.getCell(i + 1); cell.value = value; cell.style = { ...style }; if (moneyFrom && i + 1 >= moneyFrom && (!moneyTo || i + 1 <= moneyTo)) cell.numFmt = '0.00'; }); }
  private writeMerged(sheet: ExcelJS.Worksheet, row: number, value: string, style: Partial<ExcelJS.Style>, columns: number) { const cell = sheet.getRow(row).getCell(1); cell.value = value; cell.style = { ...style, alignment: { horizontal: 'center', vertical: 'middle' } }; for (let i = 2; i <= columns; i += 1) sheet.getRow(row).getCell(i).style = { ...style }; }
  private writePartialRow(sheet: ExcelJS.Worksheet, row: number, col: number, value: number, style: Partial<ExcelJS.Style>) { const cell = sheet.getRow(row).getCell(col); cell.value = value; cell.style = { ...style }; cell.numFmt = '0.00'; }
  private autoSize(sheet: ExcelJS.Worksheet) { sheet.columns.forEach((column) => { let max = 10; column.eachCell?.({ includeEmpty: false }, (cell) => { max = Math.max(max, String(cell.value ?? '').length + 2); }); column.width = Math.min(45, max); }); }
  private duration(details: any[], kind: 'pickup' | 'drop') { const field = kind === 'pickup' ? 'total_pickup_duration' : 'total_drop_duration'; return this.durationValue(details.find((d) => d[field])?.[field]); }
  private durationValue(value: any) { if (!value) return ''; const text = String(value); const match = text.match(/(\d{1,3}):(\d{2})(?::(\d{2}))?/); if (!match) return text; const minutes = Math.round(Number(match[1]) * 60 + Number(match[2]) + Number(match[3] || 0) / 60); const h = Math.floor(minutes / 60), m = minutes % 60; return h && m ? `${h} Hour ${m} Min` : h ? `${h} Hour` : `${m} Min`; }
  private num(value: any): number { const n = Number(value); return Number.isFinite(n) ? n : 0; }
  private round(value: any): number { return Math.round(this.num(value)); }
  private date(value: any): string { const d = value ? new Date(value) : null; return d && !Number.isNaN(d.getTime()) ? `${String(d.getDate()).padStart(2, '0')} ${d.toLocaleString('en-US', { month: 'short' })} ${d.getFullYear()}` : ''; }
  private dateTime(value: any): string { const d = value ? new Date(value) : null; if (!d || Number.isNaN(d.getTime())) return ''; const h = d.getHours(), hh = String(h % 12 || 12).padStart(2, '0'); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${hh}:${String(d.getMinutes()).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; }
  private safeFilePart(value: string): string { return this.clean(value).replace(/[^a-zA-Z0-9_-]/g, '') || 'DVI'; }
  private clean(value: any): string { return value == null ? '' : String(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(); }
}
