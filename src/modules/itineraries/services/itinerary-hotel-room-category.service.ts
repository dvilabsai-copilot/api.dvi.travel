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
    const matchingHotelRooms = (tboRoomDetails.rooms || []).filter((room: any) =>
      Number(room.hotelId) === Number(params.hotel_id) && Number(room.groupType) === Number(params.group_type));
    const hotelRoom = matchingHotelRooms[0];
    if (!hotelRoom) throw new NotFoundException('Hotel not found in VSR results');
    const availableRoomTypes = await this.resolveAvailableRoomTypes(params.hotel_id, matchingHotelRooms);
    if (availableRoomTypes.length === 0) throw new NotFoundException('No room types available for this hotel from VSR');

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
        room_type_title: availableRoomTypes.find((type: any) => Number(type.roomTypeId) === Number(room.room_type_id))?.roomTypeTitle || room.room_type_id.toString(),
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
    const matchingHotelRooms = (tboRoomDetails.rooms || []).filter((room: any) =>
      Number(room.hotelId) === Number(params.hotel_id) && Number(room.groupType) === Number(params.group_type));
    const hotelRoom = matchingHotelRooms[0];
    if (!hotelRoom) throw new NotFoundException('Hotel not found in VSR results');
    const availableRoomTypes = await this.resolveAvailableRoomTypes(params.hotel_id, matchingHotelRooms);
    const selectedRoomType = availableRoomTypes.find((roomType: any) =>
      Number(roomType.roomTypeId) === Number(params.room_type_id));
    if (!selectedRoomType) throw new NotFoundException('Selected room type not available from VSR');
    const selectedLiveRoomRow = (tboRoomDetails.rooms || []).find((room: any) =>
      Number(room.hotelId || room.canonicalHotelId || 0) === Number(params.hotel_id || 0) &&
      Number(room.groupType || 0) === Number(params.group_type || 0) &&
      Number(room.roomTypeId || 0) === Number(params.room_type_id || 0),
    ) || hotelRoom;

    const roomRate = Number(selectedRoomType.pricePerNight || hotelRoom.pricePerNight || 0);
    const now = new Date();
    const data = {
      room_type_id: params.room_type_id,
      room_id: Number(selectedRoomType.roomId || params.room_type_id),
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
    const roomDetailsModel = (this.prisma as any).dvi_itinerary_plan_hotel_room_details;
    const activeRoomRows = roomDetailsModel?.findMany ? await roomDetailsModel.findMany({
      where: {
        itinerary_plan_hotel_details_id: params.itinerary_plan_hotel_details_ID,
        itinerary_plan_id: params.itinerary_plan_id,
        itinerary_route_id: params.itinerary_route_id,
        itinerary_route_date: route.itinerary_route_date,
        hotel_id: params.hotel_id,
        group_type: params.group_type,
        deleted: 0,
        status: 1,
      },
      orderBy: { itinerary_plan_hotel_room_details_ID: 'asc' },
    }) : [{ room_qty: data.room_qty || 1 }];
    const totalRooms = Math.max(
      activeRoomRows.reduce((sum: number, room: any) => sum + Math.max(Number(room.room_qty || 1), 1), 0),
      1,
    );
    const selectedRateOptionId =
      String(
        (selectedLiveRoomRow as any)?.rateOptionId ||
        (selectedLiveRoomRow as any)?.searchReference ||
        (selectedLiveRoomRow as any)?.bookingCode ||
        '',
      ).trim() || null;
    const selectedPricePerNight = Number(
      (selectedLiveRoomRow as any)?.pricePerNight ??
      (selectedLiveRoomRow as any)?.basePricePerNight ??
      roomRate ??
      0,
    ) || null;
    const selectedTotalPrice = Number(
      (selectedLiveRoomRow as any)?.totalPrice ??
      (selectedLiveRoomRow as any)?.totalStayPrice ??
      selectedPricePerNight ??
      0,
    ) || null;
    const selectedMealPlan = String(
      (selectedLiveRoomRow as any)?.mealPlan ||
      '',
    ).trim() || null;
    const selectedRoomTypeName = String(
      selectedRoomType.roomTypeTitle ||
      (selectedLiveRoomRow as any)?.roomTypeName ||
      (selectedLiveRoomRow as any)?.roomType ||
      '',
    ).trim() || null;
    const selectedSnapshot = JSON.stringify({
      optionKey: selectedRateOptionId,
      rateOptionId: selectedRateOptionId,
      hotelCode: String((selectedLiveRoomRow as any)?.hotelCode || params.hotel_id || '').trim() || null,
      provider: String((selectedLiveRoomRow as any)?.provider || 'staah').trim().toLowerCase() || null,
      selectionOrigin: 'USER_SELECTED',
      hotelName: String((selectedLiveRoomRow as any)?.hotelName || '').trim() || null,
      category: Number((selectedLiveRoomRow as any)?.hotelCategory || (selectedLiveRoomRow as any)?.category || 0) || null,
      roomType: selectedRoomTypeName,
      mealPlan: selectedMealPlan,
      bookingCode: String((selectedLiveRoomRow as any)?.bookingCode || '').trim() || null,
      searchReference: String((selectedLiveRoomRow as any)?.searchReference || '').trim() || null,
      roomId: String((selectedLiveRoomRow as any)?.roomId || '').trim() || null,
      rateId: String((selectedLiveRoomRow as any)?.rateId || '').trim() || null,
      totalRooms,
    });
    const hotelDetailsModel = (this.prisma as any).dvi_itinerary_plan_hotel_details;
    if (hotelDetailsModel?.update) await hotelDetailsModel.update({
      where: { itinerary_plan_hotel_details_ID: params.itinerary_plan_hotel_details_ID },
      data: {
        hotel_id: params.hotel_id,
        hotel_required: 1,
        total_no_of_rooms: totalRooms,
        hotel_provider: String((selectedLiveRoomRow as any)?.provider || 'staah').trim().toLowerCase(),
        selected_rate_option_id: selectedRateOptionId,
        selected_price_per_night: selectedPricePerNight,
        selected_total_price: selectedTotalPrice,
        selected_currency: String((selectedLiveRoomRow as any)?.currency || 'INR').trim() || null,
        selected_price_snapshot: selectedSnapshot,
        updatedon: now,
      },
    });
    return { success: true, message: 'Room category updated successfully', roomTypeName: selectedRoomType.roomTypeTitle };
  }

  private async resolveAvailableRoomTypes(hotelId: number, matchingHotelRooms: any[]) {
    const roomModel = (this.prisma as any).dvi_hotel_rooms;
    const hotelRooms = roomModel?.findMany ? await roomModel.findMany({
      where: {
        hotel_id: hotelId,
        deleted: 0,
      },
      select: {
        room_ID: true,
        room_type_id: true,
        room_title: true,
        room_ref_code: true,
      },
      orderBy: { room_ID: 'asc' },
    }) : [];

    const hotelRoomByRef = new Map<string, any>();
    const hotelRoomByTitle = new Map<string, any>();
    for (const room of hotelRooms) {
      const refCode = this.normalizeText(room.room_ref_code);
      const title = this.normalizeText(room.room_title);
      if (refCode) hotelRoomByRef.set(refCode, room);
      if (title) hotelRoomByTitle.set(title, room);
    }

    const availableRoomTypes: Array<{
      roomTypeId: number;
      roomTypeTitle: string;
      roomId: number;
      pricePerNight: number;
    }> = [];
    const seenRoomTypeIds = new Set<number>();

    for (const room of matchingHotelRooms) {
      for (const candidate of room.availableRoomTypes || []) {
        const bookingCode = this.normalizeText((candidate as any).bookingCode);
        const roomTitle = this.normalizeText(candidate.roomTypeTitle || (candidate as any).roomName);
        const matchedHotelRoom =
          hotelRoomByRef.get(bookingCode) ||
          hotelRoomByTitle.get(roomTitle);
        if (!matchedHotelRoom) {
          const providerRoomTypeId = Number((candidate as any).roomTypeId || 0);
          const providerRoomTypeTitle = String(candidate.roomTypeTitle || (candidate as any).roomName || '').trim();
          if (providerRoomTypeId > 0 && !seenRoomTypeIds.has(providerRoomTypeId)) {
            seenRoomTypeIds.add(providerRoomTypeId);
            availableRoomTypes.push({
              roomTypeId: providerRoomTypeId,
              roomTypeTitle: providerRoomTypeTitle || `Room ${providerRoomTypeId}`,
              roomId: Number((candidate as any).roomId || providerRoomTypeId),
              pricePerNight: Number((candidate as any).pricePerNight || room.pricePerNight || room.price || 0),
            });
          }
          continue;
        }

        const roomTypeId = Number(matchedHotelRoom.room_type_id || 0);
        if (!roomTypeId || seenRoomTypeIds.has(roomTypeId)) {
          continue;
        }

        seenRoomTypeIds.add(roomTypeId);
        availableRoomTypes.push({
          roomTypeId,
          roomTypeTitle: String(matchedHotelRoom.room_title || candidate.roomTypeTitle || '').trim() || String(matchedHotelRoom.room_ref_code || roomTypeId),
          roomId: Number(matchedHotelRoom.room_ID || 0),
          pricePerNight: Number(room.pricePerNight || room.price || 0),
        });
      }
    }

    return availableRoomTypes;
  }

  private normalizeText(value: unknown): string {
    return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  }
}
