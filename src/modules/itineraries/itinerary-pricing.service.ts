import { Injectable } from '@nestjs/common';

// Money is carried as four-decimal scaled integers while formulas run. This
// avoids binary floating point deciding the two-decimal result we expose.
const SCALE = 10_000n;
const CENT = 100n;

function scaled(value: unknown): bigint {
  const text = String(value ?? '0').trim();
  if (!text || !Number.isFinite(Number(text))) return 0n;
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const digits = `${fraction}0000`.slice(0, 4);
  const result = BigInt(whole || '0') * SCALE + BigInt(digits || '0');
  return negative ? -result : result;
}

function fromScaled(value: bigint): number {
  return Number(value) / Number(SCALE);
}

function roundMoneyScaled(value: bigint): bigint {
  const remainder = value % (SCALE / CENT);
  const base = value - remainder;
  return base + (remainder >= 50n ? 100n : remainder <= -50n ? -100n : 0n);
}

function amount(value: unknown): number {
  if (typeof value === 'bigint') return fromScaled(roundMoneyScaled(value));
  return fromScaled(roundMoneyScaled(scaled(value)));
}

function sum(...values: unknown[]): number {
  return amount(values.reduce<bigint>((total, value) => total + scaled(value), 0n));
}

function percent(value: unknown, percentage: unknown): number {
  // Percentage is parsed at the same precision as all other inputs.
  return amount((scaled(value) * scaled(percentage)) / (SCALE * 100n));
}

export type HotelPricingResult = {
  sales: number;
  cost: number;
  pl: number;
  grandTotal: number;
  margin: number;
  marginGst: number;
};

export type VehiclePricingResult = {
  unitGrandTotal: number;
  grandTotal: number;
  sales: number;
  cost: number;
  pl: number;
};

export type OverallPricingInput = {
  hotspot: unknown;
  activity: unknown;
  hotel: unknown;
  vehicle: unknown;
  guide: unknown;
  agentMarginRate?: unknown;
  agentMarginValue?: unknown;
  agentMarginGstRate?: unknown;
  agentMarginGstType?: unknown;
  incidentalCount?: number;
  additionalMarginPercentage?: unknown;
  additionalMarginDayLimit?: unknown;
  noOfDays?: unknown;
  marginDiscountPercentage?: unknown;
  marginBase?: unknown;
  userLevel?: unknown;
};

export type OverallPricingResult = {
  grossAmount: number;
  totalNetCharge: number;
  agentMargin: number;
  agentMarginTax: number;
  totalNetAmount: number;
  additionalMargin: number;
  couponDiscount: number;
  totalDiscountAmount: number;
  payableBeforeRoundoff: number;
  roundoff: number;
  finalPayable: number;
  payableLabel: string;
};

@Injectable()
export class ItineraryPricingService {
  static hotel(row: Record<string, unknown>): HotelPricingResult {
    const sales = sum(
      row.total_hotel_meal_plan_cost,
      row.total_hotel_meal_plan_cost_gst_amount,
      row.total_extra_bed_cost,
      row.total_extra_bed_cost_gst_amount,
      row.total_childwith_bed_cost,
      row.total_childwith_bed_cost_gst_amount,
      row.total_childwithout_bed_cost,
      row.total_childwithout_bed_cost_gst_amount,
      row.total_room_cost,
      row.total_room_gst_amount,
      row.total_amenities_cost,
      row.total_amenities_gst_amount,
    );
    const margin = amount(row.hotel_margin_rate);
    const marginGst = amount(row.hotel_margin_rate_tax_amt);
    const cost = sum(sales, margin, marginGst);
    return { sales, cost, pl: amount(scaled(cost) - scaled(sales)), margin, marginGst, grandTotal: sum(row.total_hotel_cost, row.total_hotel_tax_amount) };
  }

  static vehicle(row: Record<string, unknown>): VehiclePricingResult {
    const qty = scaled(row.total_vehicle_qty || 1);
    const unitGrandTotal = sum(
      row.vehicle_total_amount,
      row.vehicle_gst_amount,
      row.vendor_margin_amount,
      row.vendor_margin_gst_amount,
    );
    const grandTotal = amount((qty * scaled(unitGrandTotal)) / SCALE);
    const margin = sum(row.vendor_margin_amount, row.vendor_margin_gst_amount);
    const cost = amount((qty * scaled(row.vehicle_grand_total || unitGrandTotal)) / SCALE);
    const sales = amount(scaled(cost) - scaled(margin));
    return { unitGrandTotal, grandTotal, sales, cost, pl: margin };
  }

  static roundoff(payableBeforeRoundoff: unknown): { roundoff: number; finalPayable: number } {
    const payable = amount(payableBeforeRoundoff);
    const whole = Math.round(payable);
    const fraction = amount(payable - whole);
    const roundoff = fraction === 0 ? 0 : fraction >= 0.5 ? amount(1 - fraction) : amount(-fraction);
    return { roundoff, finalPayable: amount(payable + roundoff) };
  }

  static overall(input: OverallPricingInput): OverallPricingResult {
    const grossAmount = sum(input.hotspot, input.activity, input.hotel, input.vehicle);
    const totalNetCharge = sum(grossAmount, input.guide);
    const incidental = Number(input.incidentalCount || 0);
    const rate = incidental > 0 ? input.agentMarginRate : 0;
    const grossAgentMargin = percent(totalNetCharge, rate);
    const agentMarginTax = percent(grossAgentMargin, input.agentMarginGstRate);
    const agentMargin = Number(input.agentMarginGstType) === 1
      ? amount(grossAgentMargin - agentMarginTax)
      : grossAgentMargin;
    const netWithAgent = sum(totalNetCharge, agentMargin, agentMarginTax);
    const additionalMargin = Number(input.noOfDays || 0) <= Number(input.additionalMarginDayLimit || 0)
      ? percent(netWithAgent, input.additionalMarginPercentage)
      : 0;
    const totalNetAmount = sum(netWithAgent, additionalMargin);
    const couponDiscount = percent(input.marginBase ?? sum(agentMargin), input.marginDiscountPercentage);
    const totalDiscountAmount = amount(scaled(totalNetAmount) - scaled(couponDiscount));
    const payableBeforeRoundoff = Number(input.userLevel) === 1
      ? totalDiscountAmount
      : sum(input.agentMarginValue ?? agentMargin, totalDiscountAmount);
    const rounded = ItineraryPricingService.roundoff(payableBeforeRoundoff);
    return { grossAmount, totalNetCharge, agentMargin, agentMarginTax, totalNetAmount, additionalMargin, couponDiscount, totalDiscountAmount, payableBeforeRoundoff, ...rounded, payableLabel: Number(input.userLevel) === 1 ? 'Net Payable To Doview Holidays India Pvt ltd' : 'Net Pay' };
  }
}

export const money = amount;
