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

test('preference 1 writes PHP header and hotel totals/styles', async () => {
  const { workbook, result } = await workbookFor(1); const sheet = workbook.getWorksheet('Worksheet')!;
  assert.equal(result.fileName, 'ITINERARY-DVI202608336.xlsx'); assert.equal(sheet.getCell('A1').value, null);
  assert.equal(sheet.getCell('A2').value, 'Quote ID'); assert.equal(sheet.getCell('B2').value, 'DVI202608336');
  assert.equal(sheet.getCell('A6').value, 'Day'); assert.ok(Number(sheet.getCell('U7').value) > 0);
  assert.equal(sheet.getCell('C7').value, 'Saved Hotel List Name'); assert.equal(sheet.getCell('D7').value, 'Deluxe from snapshot');
  assert.equal(sheet.getCell('G7').value, 1); assert.equal(sheet.getCell('N7').value, 10);
  assert.equal(sheet.getCell('J7').numFmt, '0.00'); assert.equal(sheet.getCell('A5').fill.fgColor?.argb, 'FFFFA500');
  assert.ok(Object.keys((sheet as any)._merges).length > 0);
});

test('preference 2 writes vehicle positional totals and route labels', async () => {
  const { workbook } = await workbookFor(2); const sheet = workbook.getWorksheet('Worksheet')!;
  assert.equal(sheet.getCell('A5').value, 'Vehicle Type: SUV | Total Required Vehicle Count: 2 ');
  assert.equal(sheet.getCell('X7').value, 2000); assert.equal(sheet.getCell('Y7').value, 1953); assert.equal(sheet.getCell('Z7').value, 47);
  assert.equal(sheet.getCell('B10').value, 'Delhi to Agra'); assert.equal(sheet.getCell('F10').value, 5); assert.equal(sheet.getCell('H10').value, 6);
  assert.equal(sheet.getCell('E7').numFmt, '0.00'); assert.ok(Object.keys((sheet as any)._merges).length > 0);
});

test('preference 3 preserves hotel-before-vehicle ordering and no duplicate flow', async () => {
  const { workbook } = await workbookFor(3); const sheet = workbook.getWorksheet('Worksheet')!;
  const values: string[] = []; sheet.eachRow((row) => row.eachCell((cell) => { if (typeof cell.value === 'string') values.push(cell.value); }));
  assert.ok(values.indexOf('Hotel Recommendation - 1') < values.indexOf('Vehicle Type: SUV | Total Required Vehicle Count: 2 '));
  assert.equal(sheet.getCell('A5').value, 'Hotel Recommendation - 1');
});
