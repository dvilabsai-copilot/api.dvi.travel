import { Injectable, NotFoundException } from '@nestjs/common';

@Injectable()
export class ItineraryHotelCancellationService {
  constructor(private readonly prisma: any) {}

  async getConfirmedItineraryForCancellation(confirmedPlanId: number) {
    const plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findUnique({
      where: { confirmed_itinerary_plan_ID: confirmedPlanId },
    });
    if (!plan) throw new NotFoundException('Confirmed itinerary not found');

    const routes = await this.prisma.dvi_confirmed_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: plan.itinerary_plan_ID, deleted: 0 },
      orderBy: { itinerary_route_date: 'asc' },
    });

    const hotelsData = await Promise.all(routes.map(async (route: any) => {
      const hotels = await this.prisma.dvi_confirmed_itinerary_plan_hotel_details.findMany({
        where: { itinerary_plan_id: plan.itinerary_plan_ID, itinerary_route_id: route.itinerary_route_ID, deleted: 0 },
      });

      const enrichedHotels = await Promise.all(hotels.map(async (hotel: any) => {
        const hotelInfo = await this.prisma.dvi_hotel.findUnique({
          where: { hotel_id: hotel.hotel_id },
          select: { hotel_name: true },
        });
        const rooms = await this.prisma.dvi_confirmed_itinerary_plan_hotel_room_details.findMany({
          where: { confirmed_itinerary_plan_hotel_details_id: hotel.confirmed_itinerary_plan_hotel_details_ID, deleted: 0 },
        });

        return {
          hotel_id: hotel.hotel_id,
          hotel_name: hotelInfo?.hotel_name || 'N/A',
          date: route.itinerary_route_date,
          total_cost: hotel.total_hotel_cost || 0,
          rooms: rooms.map((room: any) => ({
            room_qty: room.room_qty,
            room_rate: room.room_rate,
            extra_bed_count: room.extra_bed_count,
            extra_bed_rate: room.extra_bed_rate,
            child_with_bed_count: room.child_with_bed_count,
            child_with_bed_charges: room.child_with_bed_charges,
            child_without_bed_count: room.child_without_bed_count,
            child_without_bed_charges: room.child_without_bed_charges,
          })),
        };
      }));

      return { route_id: route.itinerary_route_ID, date: route.itinerary_route_date, hotels: enrichedHotels };
    }));

    return {
      plan: {
        itinerary_plan_ID: plan.itinerary_plan_ID,
        confirmed_itinerary_plan_ID: confirmedPlanId,
        booking_id: plan.itinerary_quote_ID,
      },
      routes_with_hotels: hotelsData,
    };
  }

  async getEntireDayCancellationCharges(
    confirmedPlanId: number,
    hotelId: number,
    date: string,
    cancellationPercentage: number = 10,
  ) {
    const plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findUnique({
      where: { confirmed_itinerary_plan_ID: confirmedPlanId },
    });
    if (!plan) throw new NotFoundException('Confirmed itinerary not found');

    const hotelDetails = await this.prisma.dvi_confirmed_itinerary_plan_hotel_details.findFirst({
      where: { itinerary_plan_id: plan.itinerary_plan_ID, hotel_id: hotelId, deleted: 0 },
    });
    if (!hotelDetails) throw new NotFoundException('Hotel not found for this itinerary');

    const totalCost = hotelDetails.total_hotel_cost || 0;
    const cancellationCharge = Math.round((totalCost * cancellationPercentage) / 100);
    return {
      total_cost: totalCost,
      cancellation_percentage: cancellationPercentage,
      cancellation_charge: cancellationCharge,
      refund_amount: Math.max(0, totalCost - cancellationCharge),
      breakdown: {
        room_cost: hotelDetails.total_room_cost || 0,
        meal_plan_cost: hotelDetails.total_hotel_meal_plan_cost || 0,
        amenities_cost: hotelDetails.total_amenities_cost || 0,
        tax_amount: hotelDetails.total_hotel_tax_amount || 0,
      },
    };
  }

  async cancelHotel(
    confirmedPlanId: number,
    hotelId: number,
    date: string,
    totalCancellationCharge: number,
    totalRefundAmount: number,
    defectType: string = 'dvi',
  ) {
    const userId = 1;
    const plan = await this.prisma.dvi_confirmed_itinerary_plan_details.findUnique({
      where: { confirmed_itinerary_plan_ID: confirmedPlanId },
    });
    if (!plan) throw new NotFoundException('Confirmed itinerary not found');

    return this.prisma.$transaction(async (tx: any) => {
      try {
        await tx.dvi_hotel_cancellations.create({
          data: {
            confirmed_itinerary_plan_ID: confirmedPlanId,
            hotel_id: hotelId,
            cancellation_date: new Date(date),
            total_cancellation_charge: totalCancellationCharge,
            total_refund_amount: totalRefundAmount,
            defect_type: defectType,
            createdby: userId,
            createdon: new Date(),
            status: 1,
            deleted: 0,
          },
        });
      } catch (error) {
        console.log('Hotel cancellation table not found, skipping audit record');
      }

      const hotelDetails = await tx.dvi_confirmed_itinerary_plan_hotel_details.findFirst({
        where: { itinerary_plan_id: plan.itinerary_plan_ID, hotel_id: hotelId, deleted: 0 },
      });
      if (hotelDetails) {
        await tx.dvi_confirmed_itinerary_plan_hotel_details.update({
          where: { confirmed_itinerary_plan_hotel_details_ID: hotelDetails.confirmed_itinerary_plan_hotel_details_ID },
          data: { deleted: 1, updatedon: new Date() },
        });
        await tx.dvi_confirmed_itinerary_plan_hotel_room_details.updateMany({
          where: { confirmed_itinerary_plan_hotel_details_id: hotelDetails.confirmed_itinerary_plan_hotel_details_ID },
          data: { deleted: 1 },
        });
      }

      if (totalRefundAmount > 0) {
        await tx.dvi_confirmed_itinerary_plan_details.update({
          where: { confirmed_itinerary_plan_ID: confirmedPlanId },
          data: {
            total_hotel_charges: { decrement: totalCancellationCharge + totalRefundAmount },
            itinerary_total_net_payable_amount: { decrement: totalCancellationCharge },
            updatedon: new Date(),
          },
        });
        await tx.dvi_accounts_itinerary_details.updateMany({
          where: { confirmed_itinerary_plan_ID: confirmedPlanId },
          data: {
            total_received_amount: { decrement: totalCancellationCharge },
            total_payout_amount: { increment: totalRefundAmount },
          },
        });
      }

      return { success: true, message: 'Hotel cancelled successfully', refund_amount: totalRefundAmount };
    });
  }
}
