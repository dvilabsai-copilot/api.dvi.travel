// FILE: src/modules/itineraries/services/hotel-persist.service.ts
import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../prisma.service";
import { HotelPricingService } from "./hotel-pricing.service";

export interface PersistHotelInput {
  itinerary_plan_id: number;
  itinerary_route_id: number;
  itinerary_route_date: Date | string;
  itinerary_route_location: string | null;
  group_type: number;
  hotel_category_id: number;
  total_no_of_persons: number;
  createdby: number;
}

const money = (v: any) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n)
    ? Math.round((n + Number.EPSILON) * 100) / 100
    : 0;
};

@Injectable()
export class HotelPersistService {
  private readonly log = new Logger("HotelPersistService");

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: HotelPricingService,
  ) {}

 /**
   * Create real hotel rows for a single route/night:
   * - dvi_itinerary_plan_hotel_details (totals, margin, meals)
   * - dvi_itinerary_plan_hotel_room_details (1 room line with meal flags)
   *
   * Parity with PHP (like plan 28232):
   * - margin base = roomCost + mealCost
   * - margin GST split via splitGST
   * - only breakfast cost used from meal price book
 */
  async persistForPlanDay(input: PersistHotelInput) {
    const {
      itinerary_plan_id,
      itinerary_route_id,
      itinerary_route_date,
      itinerary_route_location,
      group_type,
      hotel_category_id,
      total_no_of_persons,
      createdby,
    } = input;

    const routeDate =
      itinerary_route_date instanceof Date
        ? itinerary_route_date
        : new Date(itinerary_route_date);

    const routeDateStr = routeDate.toISOString().slice(0, 10);

    this.log.debug(
      `persistForPlanDay:start plan=${itinerary_plan_id} route=${itinerary_route_id} date=${routeDateStr} city='${itinerary_route_location}' cat=${hotel_category_id} group=${group_type}`,
    );

 // 1) Pick hotel by category + city
    const hotel = await this.pricing.pickHotelByCategory(
      hotel_category_id,
      itinerary_route_location,
    );

    const hotel_id = Number(hotel?.hotel_id ?? 0);
    const marginPct = this.pricing.getHotelMarginPercentage(hotel);
    const marginGstType = Number(hotel?.hotel_margin_gst_type ?? 0);
    const marginGstPct = Number(hotel?.hotel_margin_gst_percentage ?? 0);

    this.log.debug(
      `hotelPick -> id=${hotel_id} city='${(hotel as any)?.hotel_city ?? ""}' marginPct=${marginPct} gstType=${marginGstType} gstPct=${marginGstPct}`,
    );

 // 2) Room price (first non-zero, else first)
    const roomPrices = hotel_id
      ? await this.pricing.getRoomPrices(hotel_id, routeDate)
      : [];

    const room = roomPrices.find((r) => r.rate > 0) ?? roomPrices[0];

    this.log.debug(
      `roomPick -> ${
        room
          ? `room_id=${room.room_id} rate=${room.rate} gstPct=${room.gstPct}`
          : "none"
      }`,
    );

 // 3) Meal price (BREAKFAST only, to match your sample rows)
    const persons = Math.max(0, Number(total_no_of_persons ?? 0));
    const meals =
      hotel_id && persons > 0
        ? await this.pricing.getMealPrice(hotel_id, routeDate)
        : {
            breakfast: { price: 0, gstPct: 0, gstType: 2 },
            lunch: { price: 0, gstPct: 0, gstType: 2 },
            dinner: { price: 0, gstPct: 0, gstType: 2 },
          };

    const bCost = money(persons * meals.breakfast.price);
 const lCost = 0; // match export (only breakfast charged)
    const dCost = 0;

    const bGst = 0;
    const lGst = 0;
    const dGst = 0;

    const mealCost = money(bCost + lCost + dCost);
    const mealGst = money(bGst + lGst + dGst);

 // 4) Room cost & GST (rooms have gstPct=0 in your schema dump)
    let total_no_of_rooms = 0;
    let total_room_cost = 0;
    let total_room_gst_amount = 0;

    let room_type_id: number | null = null;
    let room_id: number | null = null;
    let room_qty = 0;
    let room_rate = 0;
    let room_gst_type = 0;
    let room_gst_pct = 0;

    if (room) {
      room_qty = 1;
      room_rate = Number(room.rate ?? 0);
      room_type_id = Number(room.room_id ?? 0);
      room_id = Number(room.room_id ?? 0);
      room_gst_type = Number(room.gstType ?? 0);
      room_gst_pct = Number(room.gstPct ?? 0);

      const roomGross = money(room_qty * room_rate);

 // If later you add room GST, you can split here with splitGST
 const roomTax = 0; // currently sample shows 0
 const roomNet = roomGross; // same as gross

      total_no_of_rooms = room_qty;
      total_room_cost = roomNet;
      total_room_gst_amount = roomTax;
    }

 // 5) Margin on (room + meal) THIS IS THE KEY TO MATCH 28232
 // Example for 28232:
 // roomCost = 4144, mealCost = 2, marginPct = 12
 // base = 4146, grossMargin = 497.52
 // marginTax = 497.52 * 18% = 89.5536
    const marginBase = money(total_room_cost + mealCost);
    const grossMargin = money((marginBase * marginPct) / 100);

    const { amount: marginRate, tax: marginRateGst } = this.pricing.splitGST(
      grossMargin,
      marginGstPct,
      marginGstType,
    );

 // 6) Insert hotel details (totals row)
    const details = await this.prisma.dvi_itinerary_plan_hotel_details.create({
      data: {
        group_type,
        itinerary_plan_id,
        itinerary_route_id,
        itinerary_route_date: routeDate as any,
        itinerary_route_location,

        hotel_required: hotel_id ? 1 : 0,
        hotel_category_id,
        hotel_id,

        hotel_margin_percentage: marginPct,
        hotel_margin_gst_type: marginGstType,
        hotel_margin_gst_percentage: marginGstPct,
        hotel_margin_rate: marginRate,
        hotel_margin_rate_tax_amt: marginRateGst,

        hotel_breakfast_cost: bCost,
        hotel_breakfast_cost_gst_amount: bGst,
        hotel_lunch_cost: lCost,
        hotel_lunch_cost_gst_amount: lGst,
        hotel_dinner_cost: dCost,
        hotel_dinner_cost_gst_amount: dGst,

        total_no_of_persons: persons,

        total_hotel_meal_plan_cost: mealCost,
        total_hotel_meal_plan_cost_gst_amount: mealGst,

        total_extra_bed_cost: 0,
        total_extra_bed_cost_gst_amount: 0,
        total_childwith_bed_cost: 0,
        total_childwith_bed_cost_gst_amount: 0,
        total_childwithout_bed_cost: 0,
        total_childwithout_bed_cost_gst_amount: 0,

        total_no_of_rooms,
        total_room_cost,
        total_room_gst_amount,

        total_hotel_cost: money(total_room_cost + mealCost + marginRate),
        total_hotel_tax_amount: money(
          total_room_gst_amount + mealGst + marginRateGst,
        ),

        total_amenities_cost: 0,
        total_amenities_gst_amount: 0,

        createdby,
        status: 1,
        deleted: 0,
      } as any,
    });

    const detailsId = (details as any)
      .itinerary_plan_hotel_details_ID as number;

    this.log.debug(
      `hotelDetails:inserted id=${detailsId} plan=${itinerary_plan_id} route=${itinerary_route_id} hotel_id=${hotel_id} rooms=${total_no_of_rooms} roomCost=${total_room_cost} meal=${mealCost} marginRate=${marginRate} marginGst=${marginRateGst}`,
    );

 // 7) Insert room details line (1 record) with meal flags
    if (room) {
      const roomRow = await this.prisma.dvi_itinerary_plan_hotel_room_details.create(
        {
          data: {
            itinerary_plan_hotel_details_id: detailsId,
            group_type,
            itinerary_plan_id,
            itinerary_route_id,
            itinerary_route_date: routeDate as any,
            hotel_id,

            room_type_id: room_type_id ?? 0,
            room_id: room_id ?? 0,
            room_qty,
            room_rate,
            gst_type: room_gst_type,
            gst_percentage: room_gst_pct,

            extra_bed_count: 0,
            extra_bed_rate: 0,
            child_without_bed_count: 0,
            child_without_bed_charges: 0,
            child_with_bed_count: 0,
            child_with_bed_charges: 0,

 // Match sample: breakfast only, lunch/dinner = 0
            breakfast_required: bCost > 0 ? 1 : 0,
            lunch_required: 0,
            dinner_required: 0,

 // We dont know your exact per-person formula, but:
 // total_breafast_cost = bCost (matches hotel_breakfast_cost)
            breakfast_cost_per_person:
              persons > 0 ? money(bCost / persons) : 0,
            lunch_cost_per_person: 0,
            dinner_cost_per_person: 0,

            total_breafast_cost: bCost,
            total_lunch_cost: lCost,
            total_dinner_cost: dCost,

            total_room_cost: total_room_cost,
            total_room_gst_amount: total_room_gst_amount,

            createdby,
            status: 1,
            deleted: 0,
          } as any,
        },
      );

      const roomDetailsId = (roomRow as any)
        .itinerary_plan_hotel_room_details_ID;

      this.log.debug(
        `roomDetails:inserted id=${roomDetailsId} details_id=${detailsId} qty=${room_qty} cost=${total_room_cost}`,
      );
    }

    return detailsId;
  }
}
