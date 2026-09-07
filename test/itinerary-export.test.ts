import test from 'node:test';
import assert from 'node:assert/strict';
import * as ExcelJS from 'exceljs';
import { ItineraryExportService } from '../src/modules/itineraries/itinerary-export.service';

const plan = (preference: number) => ({
  itinerary_plan_ID: 51788, itinerary_quote_ID: 'DVI202608336', deleted: 0,
  itinerary_preference: preference, arrival_location: 'Delhi', departure_location: 'Mumbai',
  trip_start_date_and_time: new Date('2026-08-01T10:15:00'), trip_end_date_and_time: new Date('2026-08-04T18:20:00'),
  no_of_days: 4, no_of_nights: 3, total_adult: 2, total_children: 1, total_infants: 0,
});

function prismaFor(preference: number) {
  return {
    dvi_itinerary_plan_details: { findFirst: async () => plan(preference) },
    $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = strings.join('?');
      if (sql.includes('GROUP BY group_type')) return preference === 1 || preference === 3 ? [{ group_type: 1 }] : [];
      if (sql.includes('FROM dvi_itinerary_plan_hotel_details h')) return [{
        itinerary_plan_hotel_details_ID: 1, itinerary_route_date: new Date('2026-08-01'), itinerary_route_location: 'Agra', hotel_name: null, selected_price_snapshot: JSON.stringify({ hotelName: 'Saved Hotel List Name', roomTypeName: 'Deluxe from snapshot' }), room_type_title: null, room_title: null,
        total_no_of_rooms: 1, total_room_cost: 100, total_room_gst_amount: 18, total_hotel_meal_plan_cost: 20, total_hotel_meal_plan_cost_gst_amount: 3.6,
        total_extra_bed_cost: 0, total_extra_bed_cost_gst_amount: 1.8, room_extra_bed_rate: 10, total_childwith_bed_cost: 5, total_childwith_bed_cost_gst_amount: 0.9,
        total_childwithout_bed_cost: 4, total_childwithout_bed_cost_gst_amount: 0.72, hotel_margin_rate: 12, hotel_margin_rate_tax_amt: 2.16,
        total_amenities_cost: 6, total_amenities_gst_amount: 1.08, hotel_breakfast_cost: 20, hotel_lunch_cost: 0, hotel_dinner_cost: 0,
        breakfast_required: 1, breakfast_cost_per_person: 10, lunch_required: 0, lunch_cost_per_person: 0, dinner_required: 0, dinner_cost_per_person: 0,
        room_extra_bed_count: 1, room_cnb_count: 2, room_cwb_count: 3,
      }];
      if (sql.includes('FROM dvi_itinerary_plan_vehicle_details')) return preference === 1 ? [] : [{ vehicle_type_id: 7, vehicle_count: 2 }];
      if (sql.includes('FROM dvi_vehicle_type')) return [{ vehicle_type_title: 'SUV' }];
      if (sql.includes('FROM dvi_itinerary_plan_vendor_eligible_list')) return [{ itinerary_plan_vendor_eligible_ID: 9, vendor_name: 'Vendor', vendor_branch_name: 'Branch', vehicle_orign: 'Delhi', total_vehicle_qty: 2, vehicle_grand_total: 1000, vehicle_total_amount: 800, vehicle_gst_amount: 144, vendor_margin_amount: 40, vendor_margin_gst_amount: 7, total_kms: '400', total_allowed_kms: '500', total_allowed_local_kms: '100', extra_km_rate: '10', total_extra_kms: '2', total_extra_local_kms: '1', total_extra_kms_charge: 20, total_extra_local_kms_charge: 10 }];
      if (sql.includes('FROM dvi_itinerary_plan_vendor_vehicle_details')) return [{ itinerary_route_date: new Date('2026-08-01'), itinerary_route_id: 1, travel_type: 1, total_travelled_km: '100', total_travelled_time: '2:00', total_pickup_km: '5', total_pickup_duration: '1:00', total_drop_km: '6', total_drop_duration: '1:30', location_name: 'Delhi', next_visiting_location: 'Agra', status: 1, deleted: 0 }];
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as any;
}

async function workbookFor(preference: number) {
  const result = await new ItineraryExportService(prismaFor(preference)).exportItineraryToExcel(51788);
  const buffer = await result.workbook.xlsx.writeBuffer();
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer as Buffer);
  return { workbook, result };
}

function rowsWithLabel(
  sheet: ExcelJS.Worksheet,
  label: string,
): ExcelJS.Row[] {
  const rows: ExcelJS.Row[] = [];

  sheet.eachRow((row) => {
    if (
      String(row.getCell(1).value ?? '').trim() ===
      label.trim()
    ) {
      rows.push(row);
    }
  });

  return rows;
}

function valueForLabel(
  sheet: ExcelJS.Worksheet,
  label: string,
  occurrence = 0,
): any {
  const rows = rowsWithLabel(sheet, label);

  assert.ok(
    rows.length > occurrence,
    `Missing vertical export field: ${label} occurrence ${occurrence}`,
  );

  return rows[occurrence].getCell(2).value;
}

function valueCellForLabel(
  sheet: ExcelJS.Worksheet,
  label: string,
  occurrence = 0,
): ExcelJS.Cell {
  const rows = rowsWithLabel(sheet, label);

  assert.ok(
    rows.length > occurrence,
    `Missing vertical export field: ${label} occurrence ${occurrence}`,
  );

  return rows[occurrence].getCell(2);
}

function rowIndexContaining(
  sheet: ExcelJS.Worksheet,
  value: string,
): number {
  let found = 0;

  sheet.eachRow((row, rowNumber) => {
    row.eachCell((cell) => {
      if (
        found === 0 &&
        cell.value === value
      ) {
        found = rowNumber;
      }
    });
  });

  return found;
}

test('preference 1 writes vertical itinerary and hotel details', async () => {
  const { workbook, result } = await workbookFor(1);
  const sheet = workbook.getWorksheet('Worksheet')!;

  assert.equal(result.fileName, 'ITINERARY-DVI202608336.xlsx');
  assert.equal(sheet.getCell('A1').value, null);
  assert.equal(sheet.getCell('A2').value, 'Quote ID');
  assert.equal(sheet.getCell('B2').value, 'DVI202608336');

  assert.equal(valueForLabel(sheet, 'Source Location'), 'Delhi');
  assert.equal(valueForLabel(sheet, 'Departure Location'), 'Mumbai');
  assert.equal(valueForLabel(sheet, 'Hotel & Category'), 'Saved Hotel List Name');
  assert.equal(valueForLabel(sheet, 'Room Type'), 'Deluxe from snapshot');
  assert.equal(valueForLabel(sheet, 'Extra Bed Count'), 1);
  assert.equal(valueForLabel(sheet, 'EB Cost'), 10);

  assert.equal(
    valueCellForLabel(sheet, 'Room Rent').numFmt,
    '0.00',
  );

  assert.ok(
    rowIndexContaining(
      sheet,
      'Hotel Recommendation - 1',
    ) > 0,
  );

  assert.ok(sheet.actualColumnCount <= 2);
  assert.ok(Object.keys((sheet as any)._merges).length > 0);
});

test('preference 2 writes vertical vehicle totals and route details', async () => {
  const { workbook } = await workbookFor(2);
  const sheet = workbook.getWorksheet('Worksheet')!;

  assert.ok(
    rowIndexContaining(
      sheet,
      'Vehicle Type: SUV | Total Required Vehicle Count: 2 ',
    ) > 0,
  );

  assert.equal(valueForLabel(sheet, 'Total Sales'), 2000);
  assert.equal(valueForLabel(sheet, 'Total Cost'), 1953);
  assert.equal(valueForLabel(sheet, 'Total P&L'), 47);

  assert.equal(
    valueForLabel(sheet, 'Location'),
    'Delhi to Agra',
  );

  assert.equal(
    valueForLabel(sheet, 'Total Pickup KM'),
    5,
  );

  assert.equal(
    valueForLabel(sheet, 'Total Drop KM'),
    6,
  );

  assert.equal(
    valueCellForLabel(
      sheet,
      'Rental Charges',
    ).numFmt,
    '0.00',
  );

  assert.ok(sheet.actualColumnCount <= 2);
  assert.ok(Object.keys((sheet as any)._merges).length > 0);
});

test('preference 3 preserves hotel-before-vehicle ordering in vertical export', async () => {
  const { workbook } = await workbookFor(3);
  const sheet = workbook.getWorksheet('Worksheet')!;

  const hotelRow = rowIndexContaining(
    sheet,
    'Hotel Recommendation - 1',
  );

  const vehicleRow = rowIndexContaining(
    sheet,
    'Vehicle Type: SUV | Total Required Vehicle Count: 2 ',
  );

  assert.ok(hotelRow > 0);
  assert.ok(vehicleRow > hotelRow);
  assert.ok(sheet.actualColumnCount <= 2);
});

test('early-arrival export includes a non-priced Day 0 hotel block row', async () => {
  const prisma = prismaFor(1);
  const originalQueryRaw = prisma.$queryRaw;
  prisma.$queryRaw = async (strings: TemplateStringsArray, ...values: any[]) => {
    const sql = strings.join('?');
    const result = await originalQueryRaw(strings, ...values);
    if (sql.includes('FROM dvi_itinerary_plan_hotel_details h')) {
      const detail = result[0];
      return [
        {
          ...detail,
          itinerary_route_id: 1,
          itinerary_route_date: new Date('2026-08-31'),
          early_checkin: 1,
          hotel_check_in_date: new Date('2026-08-30'),
          hotel_required: 1,
          hotel_id: 101,
        },
        {
          itinerary_route_id: 1,
          itinerary_route_date: new Date('2026-08-30'),
          itinerary_route_location: 'Agra',
          hotel_required: 2,
          hotel_id: 0,
        },
      ];
    }
    return result;
  };
  const { workbook } = await (async () => {
    const result = await new ItineraryExportService(prisma).exportItineraryToExcel(51788);
    const buffer = await result.workbook.xlsx.writeBuffer();
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer as Buffer);
    return { workbook };
  })();
  const sheet = workbook.getWorksheet('Worksheet')!;

  assert.equal(
    valueForLabel(sheet, 'Day', 0),
    'Day 0 | 30 Aug 2026',
  );

  assert.equal(
    valueForLabel(
      sheet,
      'Hotel & Category',
      0,
    ),
    'Saved Hotel List Name (Early check-in room block)',
  );

  assert.equal(
    valueForLabel(sheet, 'Room Rent', 0),
    '',
  );

  assert.equal(
    valueForLabel(sheet, 'Day', 1),
    '31 Aug 2026',
  );

  assert.ok(sheet.actualColumnCount <= 2);
});
