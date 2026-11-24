import { ConflictException } from '@nestjs/common';
import type { PrismaClient, dvi_itinerary_plan_hotel_details as HotelRow } from '@prisma/client';
import { priceTboMultiBatchStay, type TboMultiBatchStaySnapshot } from '../../hotels/utils/tbo-multi-batch-stay.util';
import { parseHotelSelectionSnapshot } from './hotel-selection-identity.util';
import { tboStayMealNightFields } from './tbo-map-fallback.util';

export type SplitVsrFareUpdate = {
  previous: TboMultiBatchStaySnapshot;
  approved: TboMultiBatchStaySnapshot;
  margin: number;
  hotelName: string;
  rows: HotelRow[];
};

export function describeSplitVsrFareUpdates(updates: SplitVsrFareUpdate[]) {
  return updates.map(({ previous, approved, margin, hotelName }) => ({
    routeId: previous.anchorRouteId,
    hotelName,
    roomCount: previous.roomCount,
    previousAmount: priceTboMultiBatchStay(previous, margin).totalPrice,
    newAmount: priceTboMultiBatchStay(approved, margin).totalPrice,
  }));
}

export async function persistApprovedSplitVsrFares(
  prisma: PrismaClient,
  planId: number,
  updates: SplitVsrFareUpdate[],
): Promise<string | null> {
  const stale = () => new ConflictException({
    code: 'VSR_RATE_UNVERIFIED',
    message: 'The saved VSR stay changed. Check Availability before confirming.',
  });
  return prisma.$transaction(async (tx) => {
    const [plan] = await tx.$queryRaw<Array<{ quotation_status: number; itinerary_quote_ID: string | null }>>
      `SELECT quotation_status, itinerary_quote_ID FROM dvi_itinerary_plan_details
        WHERE itinerary_plan_ID = ${planId} FOR UPDATE`;
    if (!plan || Number(plan.quotation_status) === 1) throw stale();
    for (const { previous, approved, rows, margin } of updates) {
      const changedBatches = approved.batches.filter((batch, index) =>
        batch.supplierNetAmount !== previous.batches[index].supplierNetAmount ||
        batch.supplierTotalFare !== previous.batches[index].supplierTotalFare,
      ).map((batch) => batch.batchIndex);
      const unresolved = await tx.tbo_hotel_booking_attempt.findFirst({
        where: {
          itinerary_plan_ID: planId,
          itinerary_route_ID: approved.anchorRouteId,
          batch_index: { in: changedBatches },
          state: { not: 'REJECTED' },
        },
        select: { id: true },
      });
      if (unresolved) throw new ConflictException({
        code: 'VSR_RATE_UNVERIFIED',
        message: 'Reconcile the existing VSR supplier attempt before approving new fares for that batch.',
      });
      const { baseByNight, payableByNight, marginByNight, mealCostPerNight } = priceTboMultiBatchStay(approved, margin);
      for (const [index, routeId] of approved.routeIds.entries()) {
        const row = rows.find((item) => item.itinerary_route_id === routeId);
        if (!row?.selected_price_snapshot) throw stale();
        const snapshot = parseHotelSelectionSnapshot(row);
        if (JSON.stringify((snapshot as { tboMultiBatchStay?: unknown }).tboMultiBatchStay) !== JSON.stringify(previous)) {
          throw stale();
        }
        const baseTotalPrice = baseByNight[index];
        const totalPrice = payableByNight[index];
        const hotelMarginAmount = marginByNight[index];
        const basePricePerNight = Math.round(baseTotalPrice * 100 / approved.roomCount) / 100;
        const updatedon = new Date();
        const data = {
          total_room_cost: baseTotalPrice,
          hotel_margin_rate: hotelMarginAmount,
          total_hotel_cost: totalPrice,
          selected_price_per_night: totalPrice,
          selected_total_price: totalPrice,
          selected_price_snapshot: JSON.stringify({
            ...snapshot,
            tboMultiBatchStay: approved,
            baseTotalPrice,
            basePricePerNight,
            hotelMarginBaseAmount: Math.round((baseTotalPrice + mealCostPerNight) * 100) / 100,
            hotelMarginAmount,
            hotelMarginTotalAmount: hotelMarginAmount,
            pricePerNight: totalPrice,
            totalPrice,
            ...tboStayMealNightFields(approved.mealPlan, approved.dviMealSupplement),
          }),
          updatedon,
        };
        const where = {
          itinerary_plan_hotel_details_ID: row.itinerary_plan_hotel_details_ID,
          itinerary_plan_id: planId,
          group_type: row.group_type,
          status: 1,
          deleted: 0,
          selected_price_snapshot: row.selected_price_snapshot,
        };
        const count = await tx.dvi_itinerary_plan_hotel_details.updateMany({ where, data });
        if (count.count !== 1) throw stale();
        // A partial provider retry may already have copied these route rows.
        await tx.dvi_confirmed_itinerary_plan_hotel_details.updateMany({ where, data });
        const roomWhere = {
          itinerary_plan_hotel_details_id: row.itinerary_plan_hotel_details_ID,
          itinerary_plan_id: planId,
          room_qty: approved.roomCount,
          status: 1,
          deleted: 0,
        };
        const roomData = { room_rate: basePricePerNight, total_room_cost: baseTotalPrice, updatedon };
        await tx.dvi_itinerary_plan_hotel_room_details.updateMany({ where: roomWhere, data: roomData });
        await tx.dvi_confirmed_itinerary_plan_hotel_room_details.updateMany({ where: roomWhere, data: roomData });
      }
    }
    return plan.itinerary_quote_ID;
  });
}
