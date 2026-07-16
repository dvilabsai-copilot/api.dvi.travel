import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { ItineraryHotelDetailsTboService } from '../itinerary-hotel-details-tbo.service';

@Injectable()
export class ItineraryHotelRoomCategoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hotelDetailsTboService: ItineraryHotelDetailsTboService,
  ) {}

  async getHotelRoomCategories(params: {
    itinerary_plan_hotel_details_ID: number;
    itinerary_plan_id: number;
    itinerary_route_id: number;
    hotel_id: number;
    group_type: number;
  }) {
    const plan = await this.prisma.dvi_itinerary_plan_details.findUnique({
      where: { itinerary_plan_ID: params.itinerary_plan_id },
      select: { preferred_room_count: true, itinerary_quote_ID: true },
    });
    if (!plan) throw new NotFoundException('Itinerary plan not found');
    const route = await this.prisma.dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: params.itinerary_route_id },
      select: { itinerary_route_date: true },
    });
    if (!route) throw new NotFoundException('Route not found');

    const tboRoomDetails = await this.hotelDetailsTboService.getHotelRoomDetailsFromTbo(plan.itinerary_quote_ID, params.itinerary_route_id);
    const hotelRoom = (tboRoomDetails.rooms || []).find((room: any) => room.hotelId === params.hotel_id && room.groupType === params.group_type);
    if (!hotelRoom) throw new NotFoundException('Hotel not found in TBO results');
    const availableRoomTypes = hotelRoom.availableRoomTypes || [];
    if (availableRoomTypes.length === 0) throw new NotFoundException('No room types available for this hotel from TBO');

    const existingRooms = await this.prisma.dvi_itinerary_plan_hotel_room_details.findMany({
      where: {
        itinerary_plan_id: params.itinerary_plan_id,
        itinerary_route_id: params.itinerary_route_id,
        itinerary_route_date: route.itinerary_route_date,
        hotel_id: params.hotel_id,
        group_type: params.group_type,
        deleted: 0,
      },
      orderBy: { itinerary_plan_hotel_room_details_ID: 'asc' },
    });
    const available = availableRoomTypes.map((roomType: any) => ({ room_type_id: roomType.roomTypeId, room_type_title: roomType.roomTypeTitle || '' }));
    const rooms: any[] = existingRooms.length > 0
      ? existingRooms.map((room: any, index: number) => ({
        room_number: index + 1,
        itinerary_plan_hotel_room_details_ID: room.itinerary_plan_hotel_room_details_ID,
        room_type_id: room.room_type_id,
        room_type_title: availableRoomTypes.find((type: any) => type.roomTypeId === room.room_type_id)?.roomTypeTitle || room.room_type_id.toString(),
        room_qty: room.room_qty,
        available_room_types: available,
      }))
      : Array.from({ length: plan.preferred_room_count || 1 }, (_, index) => ({
        room_number: index + 1,
        room_type_id: null,
        room_type_title: '',
        room_qty: 1,
        available_room_types: available,
      }));

    return {
      itinerary_plan_hotel_details_ID: params.itinerary_plan_hotel_details_ID,
      hotel_id: params.hotel_id,
      hotel_name: hotelRoom.hotelName || '',
      preferred_room_count: plan.preferred_room_count || 1,
      rooms,
    };
  }

  async updateRoomCategory(params: {
    itinerary_plan_hotel_room_details_ID?: number;
    itinerary_plan_hotel_details_ID: number;
    itinerary_plan_id: number;
    itinerary_route_id: number;
    hotel_id: number;
    group_type: number;
    room_type_id: number;
    room_qty?: number;
    all_meal_plan?: number;
    breakfast_meal_plan?: number;
    lunch_meal_plan?: number;
    dinner_meal_plan?: number;
  }) {
    const route = await this.prisma.dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: params.itinerary_route_id },
      select: { itinerary_route_date: true },
    });
    if (!route) throw new NotFoundException('Route not found');
    const planDetails = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_plan_ID: params.itinerary_plan_id, deleted: 0 },
      select: { itinerary_quote_ID: true },
    });
    if (!planDetails) throw new NotFoundException('Itinerary plan details not found');

    const tboRoomDetails = await this.hotelDetailsTboService.getHotelRoomDetailsFromTbo(planDetails.itinerary_quote_ID, params.itinerary_route_id);
    const hotelRoom = (tboRoomDetails.rooms || []).find((room: any) => room.hotelId === params.hotel_id && room.groupType === params.group_type);
    if (!hotelRoom) throw new NotFoundException('Hotel not found in TBO results');
    const selectedRoomType = (hotelRoom.availableRoomTypes || []).find((roomType: any) => roomType.roomTypeId === params.room_type_id);
    if (!selectedRoomType) throw new NotFoundException('Selected room type not available from TBO');

    const roomRate = hotelRoom.pricePerNight || 0;
    const now = new Date();
    const data = {
      room_type_id: params.room_type_id,
      room_id: params.room_type_id,
      room_qty: params.room_qty || 1,
      room_rate: roomRate,
      breakfast_required: params.breakfast_meal_plan || params.all_meal_plan || 0,
      lunch_required: params.lunch_meal_plan || params.all_meal_plan || 0,
      dinner_required: params.dinner_meal_plan || params.all_meal_plan || 0,
      updatedon: now,
    };
    if (params.itinerary_plan_hotel_room_details_ID) {
      await this.prisma.dvi_itinerary_plan_hotel_room_details.update({
        where: { itinerary_plan_hotel_room_details_ID: params.itinerary_plan_hotel_room_details_ID },
        data,
      });
    } else {
      await this.prisma.dvi_itinerary_plan_hotel_room_details.create({
        data: {
          itinerary_plan_hotel_details_id: params.itinerary_plan_hotel_details_ID,
          group_type: params.group_type,
          itinerary_plan_id: params.itinerary_plan_id,
          itinerary_route_id: params.itinerary_route_id,
          itinerary_route_date: route.itinerary_route_date,
          hotel_id: params.hotel_id,
          ...data,
          gst_type: 0,
          gst_percentage: 0,
          createdon: now,
          status: 1,
          deleted: 0,
        },
      });
    }
    return { success: true, message: 'Room category updated successfully', roomTypeName: selectedRoomType.roomTypeTitle };
  }
}
