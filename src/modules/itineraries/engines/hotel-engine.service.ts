import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { HotelPricingService } from "../hotels/hotel-pricing.service";

type Tx = Prisma.TransactionClient;

@Injectable()
export class HotelEngineService {
  constructor(private readonly hotelPricing: HotelPricingService) {}

  private normalizeFacilityCode(value: unknown): string {
    return String(value ?? "").trim().toLowerCase();
  }

  private async filterHotelsBySelectedFacilities(
    hotels: any[],
    selectedFacilities: string[],
    tx: Tx,
  ): Promise<any[]> {
    if (!Array.isArray(hotels) || hotels.length === 0) {
      return [];
    }

    const requiredFacilities = Array.from(
      new Set(
        (selectedFacilities || [])
          .map((facility) => this.normalizeFacilityCode(facility))
          .filter(Boolean),
      ),
    );

 // No facility selected: preserve the existing hotel-selection behaviour.
    if (requiredFacilities.length === 0) {
      return hotels;
    }

    const hotelIds = Array.from(
      new Set(
        hotels
          .map((hotel) => Number(hotel?.hotel_id || 0))
          .filter((hotelId) => hotelId > 0),
      ),
    );

    if (hotelIds.length === 0) {
      return [];
    }

    const amenityRows = await (tx as any).dvi_hotel_amenities.findMany({
      where: {
        hotel_id: { in: hotelIds },
        amenities_code: { not: null },
        OR: [{ deleted: 0 }, { deleted: null }],
      },
      select: {
        hotel_id: true,
        amenities_code: true,
      },
    });

    const facilityCodesByHotelId = new Map<number, Set<string>>();

    for (const amenityRow of amenityRows || []) {
      const hotelId = Number(amenityRow?.hotel_id || 0);
      const facilityCode = this.normalizeFacilityCode(
        amenityRow?.amenities_code,
      );

      if (hotelId <= 0 || !facilityCode) {
        continue;
      }

      const hotelFacilityCodes =
        facilityCodesByHotelId.get(hotelId) || new Set<string>();

      hotelFacilityCodes.add(facilityCode);
      facilityCodesByHotelId.set(hotelId, hotelFacilityCodes);
    }

 // A hotel must contain every facility selected by the user.
    return hotels.filter((hotel) => {
      const hotelId = Number(hotel?.hotel_id || 0);
      const hotelFacilityCodes = facilityCodesByHotelId.get(hotelId);

      if (!hotelFacilityCodes) {
        return false;
      }

      return requiredFacilities.every((requiredFacility) =>
        hotelFacilityCodes.has(requiredFacility),
      );
    });
  }

  async rebuildPlanHotels(
    planId: number,
    tx: Tx,
    userId: number,
  ) {
 console.log('[HOTEL-ENGINE] rebuildPlanHotels started for planId:', planId);

 /* ---------------- PHASE 0: HARD RESET ---------------- */
    let opStart = Date.now();

    await (tx as any).dvi_itinerary_plan_hotel_room_amenities.deleteMany({
      where: { itinerary_plan_id: planId },
    });

    await (tx as any).dvi_itinerary_plan_hotel_room_details.deleteMany({
      where: { itinerary_plan_id: planId },
    });

    await (tx as any).dvi_itinerary_plan_hotel_details.deleteMany({
      where: { itinerary_plan_id: planId },
    });
 console.log('[HOTEL-ENGINE] Delete old data:', Date.now() - opStart, 'ms');

 /* ---------------- PLAN & ROUTES ---------------- */
    opStart = Date.now();

    const plan = await (tx as any).dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: planId },
      select: {
        total_adult: true,
        total_children: true,
        total_infants: true,
        preferred_hotel_category: true,
        hotel_facilities: true,
        no_of_nights: true,
      },
    });

    const totalPersons =
      Number(plan?.total_adult || 0) +
      Number(plan?.total_children || 0) +
      Number(plan?.total_infants || 0);

 // Parse preferred hotel categories (can be comma-separated string)
    const categoryStr = String(plan?.preferred_hotel_category || "");
    const categories = categoryStr
      .split(",")
      .map((c) => Number(c.trim()))
      .filter((c) => c > 0);

 const preferredCategory = categories[0] || 2; // Default to category 2

 // Hotel facilities are stored as comma-separated amenities codes.
    const selectedHotelFacilities: string[] = Array.from(
      new Set(
        String(plan?.hotel_facilities || "")
          .split(",")
          .map((facility) => this.normalizeFacilityCode(facility))
          .filter(Boolean),
      ),
    );

    const routes = await (tx as any).dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: planId },
      orderBy: { itinerary_route_ID: "asc" },
      select: {
        itinerary_route_ID: true,
        itinerary_route_date: true,
        location_name: true,
 next_visiting_location: true, // PHP uses this for hotel city!
      },
    });
 console.log('[HOTEL-ENGINE] Fetch plan+routes:', Date.now() - opStart, 'ms, routes:', routes.length);

 /* ---------------- PHASE 1: INSERT ROOMS WITH HOTEL SELECTION ---------------- */
    opStart = Date.now();
    let hotelPickCount = 0;
    let roomPriceCount = 0;
    let mealPriceCount = 0;
    const hotelSearchCache = new Map<string, Promise<any[]>>();
    const roomPricesCache = new Map<string, Promise<any[]>>();
    const mealPricesCache = new Map<string, Promise<any>>();
    const roomTypeCache = new Map<number, Promise<number>>();

    const totalRoutes = routes.length;

 // Collect all hotel selection tasks for parallel execution
    const hotelTasks: Array<{
      routeIndex: number;
      routeId: number;
      routeDate: Date;
      city: string;
      groupType: number;
    }> = [];

    for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
      const r = routes[routeIndex];
      const isLastRoute = (routeIndex === totalRoutes - 1);
      const noOfNights = Number(plan?.no_of_nights || 0);

 // Skip hotel generation for the last route (departure day)
 // UNLESS it's a multi-day trip and we have fewer routes than nights (edge case)
 // Standard: if routeIndex < noOfNights, we need a hotel for that night.
      if (isLastRoute && routeIndex >= noOfNights) continue;

      const routeDate = r.itinerary_route_date ? new Date(r.itinerary_route_date) : new Date();
      const city = r.next_visiting_location;

      for (const groupType of [1, 2, 3, 4]) {
        hotelTasks.push({
          routeIndex,
          routeId: r.itinerary_route_ID,
          routeDate,
          city,
          groupType,
        });
      }
    }

 // Execute all hotel picks + pricing in parallel (now gets MULTIPLE hotels per category)
    const hotelResults = await Promise.all(
      hotelTasks.map(async (task) => {
        hotelPickCount++;
        const routeDateKey = task.routeDate.toISOString().slice(0, 10);
        const hotelCacheKey =
          `${preferredCategory}|${task.city}|${routeDateKey}`;

 // Keep the existing four-argument HotelPricingService method.
 // Facility matching is performed below using dvi_hotel_amenities.
        let hotelsPromise = hotelSearchCache.get(hotelCacheKey);

        if (!hotelsPromise) {
          hotelsPromise = this.hotelPricing.getHotelsByCategory(
            preferredCategory,
            task.city,
            task.routeDate,
            100,
          );

          hotelSearchCache.set(hotelCacheKey, hotelsPromise);
        }

        const candidateHotels = await hotelsPromise;
        const hotels = (
          await this.filterHotelsBySelectedFacilities(
            candidateHotels,
            selectedHotelFacilities,
            tx,
          )
        ).slice(0, 10);

        if (!hotels || hotels.length === 0) {
          return {
            ...task,
            hotels: [],
          };
        }

 // For each hotel, get room prices and meal prices
        const hotelDetailsPromises = hotels.map(async (hotel) => {
          const hotelDateKey = `${hotel.hotel_id}|${routeDateKey}`;

          let roomPricesPromise = roomPricesCache.get(hotelDateKey);
          if (!roomPricesPromise) {
            roomPricesPromise = this.hotelPricing.getRoomPrices(hotel.hotel_id, task.routeDate);
            roomPricesCache.set(hotelDateKey, roomPricesPromise);
          }

          let mealPricesPromise = mealPricesCache.get(hotelDateKey);
          if (!mealPricesPromise) {
            mealPricesPromise = this.hotelPricing.getMealPrice(hotel.hotel_id, task.routeDate);
            mealPricesCache.set(hotelDateKey, mealPricesPromise);
          }

          const [roomPrices, mealPrices] = await Promise.all([
            roomPricesPromise,
            mealPricesPromise,
          ]);

          roomPriceCount++;
          mealPriceCount++;

          const roomPrice = roomPrices.find(rp => rp.rate > 0) || roomPrices[0] || { room_id: 0, rate: 0 };

          let roomTypeId = 0;
          if (roomPrice.room_id > 0) {
            let roomTypePromise = roomTypeCache.get(roomPrice.room_id);
            if (!roomTypePromise) {
              roomTypePromise = (tx as any).dvi_hotel_rooms.findFirst({
                where: { room_ID: roomPrice.room_id },
                select: { room_type_id: true },
              }).then((roomMaster: any) => roomMaster?.room_type_id || 0);
              roomTypeCache.set(roomPrice.room_id, roomTypePromise);
            }
            roomTypeId = await roomTypePromise;
          }

          return {
            hotel,
            roomPrices,
            mealPrices,
            roomPrice,
            roomTypeId,
          };
        });

        const hotelDetails = await Promise.all(hotelDetailsPromises);

        // A reset creates the auto-selection snapshot for each recommendation
        // group. Do not persist the complete hotel list into every group: that
        // makes group 4 a copy of group 1 and prevents the UI from explaining
        // that a route has no distinct hotel for a later group.
        const orderedHotelDetails = [...hotelDetails].sort((left, right) => {
          const leftRate = Number(left.roomPrice?.rate || 0);
          const rightRate = Number(right.roomPrice?.rate || 0);
          return leftRate - rightRate || Number(left.hotel?.hotel_id || 0) - Number(right.hotel?.hotel_id || 0);
        });
        const selectedHotelDetails = orderedHotelDetails.length <= 4
          ? (orderedHotelDetails[task.groupType - 1] ? [orderedHotelDetails[task.groupType - 1]] : [])
          : (() => {
              const index = Math.min(
                Math.floor(((task.groupType - 1) / 4) * orderedHotelDetails.length),
                orderedHotelDetails.length - 1,
              );
              return orderedHotelDetails[index] ? [orderedHotelDetails[index]] : [];
            })();

        return {
          ...task,
          hotels: selectedHotelDetails,
        };
      })
    );

 // Insert all room records for all hotels
    for (const result of hotelResults) {
      const routeForInsert = routes.find((r: any) => r.itinerary_route_ID === result.routeId);
      if (!routeForInsert) continue;

 // For each hotel option in this category/route
      for (const hotelDetail of result.hotels) {
        if (!hotelDetail.hotel) {
 // No hotel, create placeholder
          await (tx as any).dvi_itinerary_plan_hotel_room_details.create({
            data: {
              itinerary_plan_id: planId,
              itinerary_route_id: result.routeId,
              itinerary_route_date: routeForInsert.itinerary_route_date,
              group_type: result.groupType,
              hotel_id: 0,
              room_type_id: 0,
              room_id: 0,
              room_qty: 1,
              room_rate: 0,
              gst_type: 1,
              gst_percentage: 0,
              extra_bed_count: 0,
              extra_bed_rate: 0,
              child_without_bed_count: 0,
              child_without_bed_charges: 0,
              child_with_bed_count: 0,
              child_with_bed_charges: 0,
              breakfast_required: 1,
              lunch_required: 0,
              dinner_required: 0,
              breakfast_cost_per_person: 0,
              lunch_cost_per_person: 0,
              dinner_cost_per_person: 0,
              total_breafast_cost: 0,
              total_lunch_cost: 0,
              total_dinner_cost: 0,
              total_room_cost: 0,
              total_room_gst_amount: 0,
              createdby: userId,
              createdon: new Date(),
              status: 1,
              deleted: 0,
            },
          });
          continue;
        }

        const hotelId = hotelDetail.hotel.hotel_id;
        // `roomPrice` is the validated price selected above.  Using
        // `roomPrices[0]` here could persist a different/zero-rate row than
        // the one used for ranking.  It also made malformed provider data
        // capable of crashing itinerary creation while reading mealPrices.
        const selectedRoomPrice = hotelDetail.roomPrice ?? { room_id: 0, rate: 0 };
        const roomRate = Number(selectedRoomPrice.rate || 0);
        const roomId = Number(selectedRoomPrice.room_id || 0);
        const roomTypeId = Number(hotelDetail.roomTypeId || 0);
        const breakfastCost = Number(hotelDetail.mealPrices?.breakfast?.price || 0);
        const totalBreakfastCost = breakfastCost * totalPersons;

        await (tx as any).dvi_itinerary_plan_hotel_room_details.create({
          data: {
            itinerary_plan_id: planId,
            itinerary_route_id: result.routeId,
            itinerary_route_date: routeForInsert.itinerary_route_date,
            group_type: result.groupType,

            hotel_id: hotelId,
            room_type_id: roomTypeId,
            room_id: roomId,
            room_qty: 1,
            room_rate: roomRate,

            gst_type: 1,
            gst_percentage: 0,

            extra_bed_count: 0,
            extra_bed_rate: 0,
            child_without_bed_count: 0,
            child_without_bed_charges: 0,
            child_with_bed_count: 0,
            child_with_bed_charges: 0,

            breakfast_required: 1,
            lunch_required: 0,
            dinner_required: 0,

            breakfast_cost_per_person: breakfastCost,
            lunch_cost_per_person: 0,
            dinner_cost_per_person: 0,

            total_breafast_cost: totalBreakfastCost,
            total_lunch_cost: 0,
            total_dinner_cost: 0,
            total_room_cost: roomRate,
            total_room_gst_amount: 0,

            createdby: userId,
            createdon: new Date(),
            status: 1,
            deleted: 0,
          },
        });
      }
    }
 console.log('[HOTEL-ENGINE] Phase 1 insert rooms:', Date.now() - opStart, 'ms');
 console.log('[HOTEL-ENGINE] Hotel picks:', hotelPickCount, '| Room prices:', roomPriceCount, '| Meal prices:', mealPriceCount);

 /* ---------------- PHASE 2: CREATE HEADERS FROM ROOMS ---------------- */
    opStart = Date.now();

    for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
      const r = routes[routeIndex];
      const isLastRoute = (routeIndex === totalRoutes - 1);
      const noOfNights = Number(plan?.no_of_nights || 0);

 // Skip last route (same as Phase 1)
      if (isLastRoute && routeIndex >= noOfNights) {
        continue;
      }

      for (const groupType of [1, 2, 3, 4]) {

 // Get ALL unique hotels for this route/category (not just the first one)
        const allRooms = await (tx as any).dvi_itinerary_plan_hotel_room_details.findMany({
          where: {
            itinerary_plan_id: planId,
            itinerary_route_id: r.itinerary_route_ID,
            group_type: groupType,
            deleted: 0,
            status: 1,
          },
          select: { hotel_id: true, total_room_cost: true, total_breafast_cost: true },
          distinct: ['hotel_id'],
        });

 // If no rooms, skip
        if (!allRooms || allRooms.length === 0) {
          continue;
        }

 // Insert ONE header record per unique hotel option
        for (const roomRecord of allRooms) {
          const hotelId = roomRecord.hotel_id || 0;
          if (hotelId === 0) continue;

          const agg = await (tx as any)
            .dvi_itinerary_plan_hotel_room_details.aggregate({
              where: {
                itinerary_plan_id: planId,
                itinerary_route_id: r.itinerary_route_ID,
                group_type: groupType,
                hotel_id: hotelId,
                deleted: 0,
                status: 1,
              },
              _sum: {
                room_qty: true,
                total_room_cost: true,
                total_breafast_cost: true,
              },
            });

          const totalRooms = Number(agg._sum.room_qty || 0);
          const totalRoomCost = Number(agg._sum.total_room_cost || 0);
          const totalBreakfastCost = Number(agg._sum.total_breafast_cost || 0);

 // Calculate hotel margin (12% of room + breakfast costs)
          const baseCost = totalRoomCost + totalBreakfastCost;
 const marginRate = baseCost * 0.12; // 12%
 const marginTaxAmt = marginRate * 0.18; // 18% GST on margin

          const header = await (tx as any)
            .dvi_itinerary_plan_hotel_details.create({
              data: {
                itinerary_plan_id: planId,
                itinerary_route_id: r.itinerary_route_ID,
                itinerary_route_date: r.itinerary_route_date,
 itinerary_route_location: r.next_visiting_location, // PHP uses next_visiting_location!
                group_type: groupType,

                hotel_required: 1,
                hotel_category_id: preferredCategory,
                hotel_id: hotelId,

              hotel_margin_percentage: 12,
              hotel_margin_gst_type: 2,
              hotel_margin_gst_percentage: 18,
              hotel_margin_rate: marginRate,
              hotel_margin_rate_tax_amt: marginTaxAmt,

              hotel_breakfast_cost: totalBreakfastCost,
              hotel_breakfast_cost_gst_amount: 0,
              hotel_lunch_cost: 0,
              hotel_lunch_cost_gst_amount: 0,
              hotel_dinner_cost: 0,
              hotel_dinner_cost_gst_amount: 0,

              total_no_of_persons: totalPersons,
              total_no_of_rooms: totalRooms,

              total_room_cost: totalRoomCost,
              total_room_gst_amount: 0,
              total_hotel_cost: totalRoomCost + totalBreakfastCost,

              total_hotel_meal_plan_cost: totalBreakfastCost,
              total_hotel_meal_plan_cost_gst_amount: 0,

              total_extra_bed_cost: 0,
              total_childwith_bed_cost: 0,
              total_childwithout_bed_cost: 0,

              total_amenities_cost: 0,
              total_amenities_gst_amount: 0,
              total_hotel_tax_amount: 0,

              createdby: userId,
              createdon: new Date(),
              status: 1,
              deleted: 0,
            },
          });

 // Update ONLY the rooms for THIS specific hotel
          await (tx as any).dvi_itinerary_plan_hotel_room_details.updateMany({
            where: {
              itinerary_plan_id: planId,
              itinerary_route_id: r.itinerary_route_ID,
              group_type: groupType,
              hotel_id: hotelId,
            },
            data: {
              itinerary_plan_hotel_details_id:
                header.itinerary_plan_hotel_details_ID,
            },
          });
        }
      }
    }
 console.log('[HOTEL-ENGINE] Phase 2 create headers:', Date.now() - opStart, 'ms');

 /* ---------------- PHASE 3: ZERO-PRICE CLEANUP ---------------- */
    opStart = Date.now();

 // NOTE: We keep the hotel_id even if room_rate is 0
 // Only zero out the room-specific fields
    const zeroRows = await (tx as any)
      .dvi_itinerary_plan_hotel_room_details.findMany({
        where: {
          itinerary_plan_id: planId,
          room_rate: 0,
          deleted: 0,
          status: 1,
        },
        select: {
          itinerary_route_id: true,
          group_type: true,
        },
      });

    for (const row of zeroRows) {
      await (tx as any).dvi_itinerary_plan_hotel_room_details.updateMany({
        where: {
          itinerary_plan_id: planId,
          itinerary_route_id: row.itinerary_route_id,
          group_type: row.group_type,
        },
        data: {
 // Keep hotel_id! Don't reset to 0
          room_type_id: 0,
          room_id: 0,
          room_rate: 0,
          total_breafast_cost: 0,
          total_lunch_cost: 0,
          total_dinner_cost: 0,
          total_room_cost: 0,
          total_room_gst_amount: 0,
        },
      });
    }
 console.log('[HOTEL-ENGINE] Phase 3 zero-price cleanup:', Date.now() - opStart, 'ms');
 console.log('[HOTEL-ENGINE] rebuildPlanHotels completed');
  }
}
