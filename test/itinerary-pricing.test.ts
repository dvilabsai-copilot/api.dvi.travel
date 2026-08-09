import test from 'node:test';
import assert from 'node:assert/strict';
import { ItineraryPricingService } from '../src/modules/itineraries/itinerary-pricing.service';

test('hotel pricing includes amenities and margin GST exactly once', () => {
  const result = ItineraryPricingService.hotel({
    total_room_cost: '100', total_room_gst_amount: '18',
    total_hotel_meal_plan_cost: '20', total_hotel_meal_plan_cost_gst_amount: '3.60',
    total_extra_bed_cost: '10', total_extra_bed_cost_gst_amount: '1.80',
    total_childwith_bed_cost: '5', total_childwith_bed_cost_gst_amount: '.90',
    total_childwithout_bed_cost: '4', total_childwithout_bed_cost_gst_amount: '.72',
    total_amenities_cost: '6', total_amenities_gst_amount: '1.08',
    hotel_margin_rate: '12', hotel_margin_rate_tax_amt: '2.16',
    total_hotel_cost: '152.32', total_hotel_tax_amount: '20.94',
  });
  assert.equal(result.sales, 171.10);
  assert.equal(result.cost, 185.26);
  assert.equal(result.pl, 14.16);
});

test('vehicle quantity is applied once and margin remains the P&L', () => {
  const result = ItineraryPricingService.vehicle({
    total_vehicle_qty: 2, vehicle_total_amount: 800, vehicle_gst_amount: 144,
    vendor_margin_amount: 40, vendor_margin_gst_amount: 7, vehicle_grand_total: 1000,
  });
  assert.equal(result.grandTotal, 1982);
  assert.equal(result.cost, 2000);
  assert.equal(result.sales, 1953);
  assert.equal(result.pl, 47);
});

test('legacy round-off keeps the signed fractional delta', () => {
  const result = ItineraryPricingService.roundoff('34641.70');
  assert.equal(result.roundoff, 0.30);
  assert.equal(result.finalPayable, 34642);
});

test('overall supports inclusive GST, day-limited margin, coupon, and user payable branch', () => {
  const result = ItineraryPricingService.overall({
    hotspot: 0, activity: 0, hotel: 1000, vehicle: 0, guide: 0,
    incidentalCount: 1, agentMarginRate: 10, agentMarginGstRate: 18,
    agentMarginGstType: 1, additionalMarginPercentage: 10,
    additionalMarginDayLimit: 3, noOfDays: 2, marginBase: 100,
    marginDiscountPercentage: 5, userLevel: 1,
  });
  assert.equal(result.agentMargin, 82);
  assert.equal(result.agentMarginTax, 18);
  assert.equal(result.additionalMargin, 110);
  assert.equal(result.couponDiscount, 5);
  assert.equal(result.payableLabel, 'Net Payable To Doview Holidays India Pvt ltd');
});
