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
    hotel_code?: string;
    provider?: string;
    hotel_name?: string;
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
    const matchingHotelRooms = this.matchHotelRooms(tboRoomDetails.rooms || [], params);
    // AxisRooms/STAAH selections are persisted in the itinerary snapshot but
    // are not necessarily present in the VSR/TBO room-detail response. The
    // room editor must still be able to use the canonical DB room categories.
    const hotelRoom = matchingHotelRooms[0] || {
      hotelId: params.hotel_id,
      hotelCode: params.hotel_code,
      provider: params.provider,
      hotelName: params.hotel_name || '',
      groupType: params.group_type,
      pricePerNight: 0,
      totalPrice: 0,
      availableRoomTypes: [],
    };
    const availableRoomTypes = await this.resolveAvailableRoomTypes(
      params.hotel_id,
      matchingHotelRooms,
      params.provider,
    );
    if (availableRoomTypes.length === 0) throw new NotFoundException('No room types available for this hotel');

    const hotelDetailsModel = (this.prisma as any).dvi_itinerary_plan_hotel_details;
    const activeHotelDetails = hotelDetailsModel?.findFirst
      ? await hotelDetailsModel.findFirst({
        where: Number(params.itinerary_plan_hotel_details_ID || 0) > 0
          ? {
            itinerary_plan_hotel_details_ID: Number(params.itinerary_plan_hotel_details_ID),
            itinerary_plan_id: params.itinerary_plan_id,
            itinerary_route_id: params.itinerary_route_id,
            deleted: 0,
            status: 1,
          }
          : {
            itinerary_plan_id: params.itinerary_plan_id,
            itinerary_route_id: params.itinerary_route_id,
            hotel_id: params.hotel_id,
            group_type: params.group_type,
            deleted: 0,
            status: 1,
          },
        orderBy: { itinerary_plan_hotel_details_ID: 'desc' },
        select: {
          itinerary_plan_hotel_details_ID: true,
          selected_price_snapshot: true,
        },
      })
      : null;
    const activeHotelDetailsByIdentity = !activeHotelDetails && hotelDetailsModel?.findMany
      ? await this.findActiveParentByIdentity(hotelDetailsModel, {
        ...params,
        itinerary_plan_hotel_details_ID: 0,
      })
      : null;
    const activeHotelDetailsId = Number(
      activeHotelDetails?.itinerary_plan_hotel_details_ID ||
      activeHotelDetailsByIdentity?.itinerary_plan_hotel_details_ID ||
      0,
    );
    let selectedSnapshot: any = {};
    try {
      const rawSnapshot = activeHotelDetails?.selected_price_snapshot ||
        activeHotelDetailsByIdentity?.selected_price_snapshot;
      selectedSnapshot = rawSnapshot
        ? (typeof rawSnapshot === 'string' ? JSON.parse(rawSnapshot) : rawSnapshot)
        : {};
    } catch {
      selectedSnapshot = {};
    }
    const selectedSnapshotRoomType = String(
      selectedSnapshot.roomType ||
      selectedSnapshot.roomTypeName ||
      selectedSnapshot.room_type_title ||
      '',
    ).trim();
    // Orphan rows with parent ID 0 were produced by the old failing update
    // path. They must not inflate the configured room count or reappear as
    // valid persisted categories.
    const existingRooms = activeHotelDetailsId > 0
      ? await this.prisma.dvi_itinerary_plan_hotel_room_details.findMany({
        where: {
          itinerary_plan_hotel_details_id: activeHotelDetailsId,
          itinerary_plan_id: params.itinerary_plan_id,
          itinerary_route_id: params.itinerary_route_id,
          itinerary_route_date: route.itinerary_route_date,
          deleted: 0,
          status: 1,
        },
        orderBy: { itinerary_plan_hotel_room_details_ID: 'asc' },
      })
      : [];
    const available = availableRoomTypes.map((roomType: any) => ({ room_type_id: roomType.roomTypeId, room_type_title: roomType.roomTypeTitle || '' }));
    const configuredRoomCount = Math.max(Number(plan.preferred_room_count || 1), 1);
    const rooms: any[] = existingRooms.map((room: any, index: number) => {
      const persistedRoomTypeId = Number(room.room_type_id || 0);
      const persistedRoomType = availableRoomTypes.find(
        (type: any) => Number(type.roomTypeId) === persistedRoomTypeId,
      );
      const snapshotRoomType = selectedSnapshotRoomType
        ? availableRoomTypes.find((type: any) => {
          const availableTitle = this.normalizeText(type.roomTypeTitle);
          const snapshotTitle = this.normalizeText(selectedSnapshotRoomType);
          return Boolean(
            availableTitle && snapshotTitle &&
            (availableTitle === snapshotTitle ||
              availableTitle.includes(snapshotTitle) ||
              snapshotTitle.includes(availableTitle)),
          );
        })
        : undefined;
      const selectedRoomType = persistedRoomType || snapshotRoomType;
      const roomTypeId = persistedRoomTypeId > 0
        ? persistedRoomTypeId
        : Number(selectedRoomType?.roomTypeId || 0);
      return {
        room_number: index + 1,
        itinerary_plan_hotel_room_details_ID: room.itinerary_plan_hotel_room_details_ID,
        room_type_id: roomTypeId || null,
        room_type_title: selectedRoomType?.roomTypeTitle ||
          (roomTypeId > 0 ? String(roomTypeId) : selectedSnapshotRoomType),
        room_qty: room.room_qty,
        available_room_types: available,
      };
    });
    for (let index = rooms.length; index < configuredRoomCount; index += 1) {
      rooms.push({
        room_number: index + 1,
        room_type_id: null,
        room_type_title: '',
        room_qty: 1,
        available_room_types: available,
      });
    }

    return {
      itinerary_plan_hotel_details_ID: activeHotelDetailsId || params.itinerary_plan_hotel_details_ID,
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
    hotel_code?: string;
    provider?: string;
    hotel_name?: string;
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
    const matchingHotelRooms = this.matchHotelRooms(tboRoomDetails.rooms || [], params);
    const persistedSelectionParent = await this.findPersistedHotelParent(params);
    const persistedSnapshot = this.parseSelectedSnapshot(persistedSelectionParent?.selected_price_snapshot);
    const hotelRoom = matchingHotelRooms[0] || {
      hotelId: params.hotel_id,
      hotelCode: params.hotel_code || persistedSnapshot.hotelCode,
      provider: params.provider || persistedSnapshot.provider,
      hotelName: params.hotel_name || persistedSnapshot.hotelName || '',
      groupType: params.group_type,
      roomTypeName: persistedSnapshot.roomType,
      mealPlan: persistedSnapshot.mealPlan,
      roomId: persistedSnapshot.roomId,
      rateOptionId: persistedSnapshot.rateOptionId || persistedSnapshot.optionKey,
      searchReference: persistedSnapshot.searchReference,
      bookingCode: persistedSnapshot.bookingCode,
      pricePerNight: Number(persistedSnapshot.pricePerNight || persistedSnapshot.selectedPricePerNight || 0),
      totalPrice: Number(persistedSnapshot.totalPrice || persistedSnapshot.selectedTotalPrice || 0),
      availableRoomTypes: [],
    };
    const availableRoomTypes = await this.resolveAvailableRoomTypes(
      params.hotel_id,
      matchingHotelRooms,
      params.provider,
    );
    const selectedRoomType = availableRoomTypes.find((roomType: any) =>
      Number(roomType.roomTypeId) === Number(params.room_type_id));
    if (!selectedRoomType) throw new NotFoundException('Selected room type not available for this hotel');
    const selectedLiveRoomRow = (tboRoomDetails.rooms || []).find((room: any) =>
      this.matchesRoomIdentity(room, params) &&
      Number(room.roomTypeId || 0) === Number(params.room_type_id || 0),
    ) || hotelRoom;

    const roomRate = Number(selectedRoomType.pricePerNight || hotelRoom.pricePerNight || 0);
    const now = new Date();
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
      persistedSnapshot.mealPlan ||
      '',
    ).trim() || null;
    const selectedRoomTypeName = String(
      selectedRoomType.roomTypeTitle ||
      (selectedLiveRoomRow as any)?.roomTypeName ||
      (selectedLiveRoomRow as any)?.roomType ||
      '',
    ).trim() || null;
    const hotelDetailsId = await this.resolveHotelDetailsId({
      ...params,
      routeDate: route.itinerary_route_date,
      hotelRoom,
      selectedLiveRoomRow,
      selectedRoomTypeName,
      selectedRateOptionId,
      selectedPricePerNight,
      selectedTotalPrice,
      now,
    });
    const baseData = {
      room_type_id: params.room_type_id,
      room_id: Number(selectedRoomType.roomId || params.room_type_id),
      room_qty: params.room_qty || 1,
      room_rate: roomRate,
      updatedon: now,
    };
    const hasMealPlanOverride = [
      params.all_meal_plan,
      params.breakfast_meal_plan,
      params.lunch_meal_plan,
      params.dinner_meal_plan,
    ].some((value) => value !== undefined && value !== null);
    const mealPlanData = hasMealPlanOverride
      ? {
        breakfast_required: params.breakfast_meal_plan || params.all_meal_plan || 0,
        lunch_required: params.lunch_meal_plan || params.all_meal_plan || 0,
        dinner_required: params.dinner_meal_plan || params.all_meal_plan || 0,
      }
      : {};
    const data = params.itinerary_plan_hotel_room_details_ID
      ? { ...baseData, ...mealPlanData }
      : {
        ...baseData,
        breakfast_required: mealPlanData.breakfast_required ?? 0,
        lunch_required: mealPlanData.lunch_required ?? 0,
        dinner_required: mealPlanData.dinner_required ?? 0,
      };
    if (params.itinerary_plan_hotel_room_details_ID) {
      await this.prisma.dvi_itinerary_plan_hotel_room_details.update({
        where: { itinerary_plan_hotel_room_details_ID: params.itinerary_plan_hotel_room_details_ID },
        data: {
          ...data,
          // Older live-hotel selections could create room rows with parent ID 0.
          // Repair that orphan link when the room category is saved.
          itinerary_plan_hotel_details_id: hotelDetailsId,
        },
      });
    } else {
      await this.prisma.dvi_itinerary_plan_hotel_room_details.create({
        data: {
          itinerary_plan_hotel_details_id: hotelDetailsId,
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
        itinerary_plan_hotel_details_id: hotelDetailsId,
        itinerary_plan_id: params.itinerary_plan_id,
        itinerary_route_id: params.itinerary_route_id,
        itinerary_route_date: route.itinerary_route_date,
        deleted: 0,
        status: 1,
      },
      orderBy: { itinerary_plan_hotel_room_details_ID: 'asc' },
    }) : [{ room_qty: data.room_qty || 1 }];
    const totalRooms = Math.max(
      activeRoomRows.reduce((sum: number, room: any) => sum + Math.max(Number(room.room_qty || 1), 1), 0),
      1,
    );
    // Room-category edits must not recreate the selection from a partial
    // room-detail response. AxisRooms/STAAH cards often have no live room
    // detail row, and a room-only edit must preserve the selected meal/rate
    // metadata while replacing only the room category.
    const selectedSnapshot = JSON.stringify({
      ...persistedSnapshot,
      optionKey: selectedRateOptionId || persistedSnapshot.optionKey || null,
      rateOptionId: selectedRateOptionId || persistedSnapshot.rateOptionId || null,
      hotelCode: String(
        (selectedLiveRoomRow as any)?.hotelCode ||
        persistedSnapshot.hotelCode ||
        params.hotel_id ||
        '',
      ).trim() || null,
      provider: String(
        (selectedLiveRoomRow as any)?.provider ||
        persistedSnapshot.provider ||
        'staah',
      ).trim().toLowerCase() || null,
      selectionOrigin: persistedSnapshot.selectionOrigin || 'USER_SELECTED',
      hotelName: String(
        (selectedLiveRoomRow as any)?.hotelName ||
        persistedSnapshot.hotelName ||
        params.hotel_name ||
        '',
      ).trim() || null,
      category: Number(
        (selectedLiveRoomRow as any)?.hotelCategory ||
        (selectedLiveRoomRow as any)?.category ||
        persistedSnapshot.category ||
        0,
      ) || null,
      roomType: selectedRoomTypeName,
      roomTypeName: selectedRoomTypeName,
      room_type_title: selectedRoomTypeName,
      roomTypeId: Number(params.room_type_id) || null,
      mealPlan: selectedMealPlan,
      bookingCode: String(
        (selectedLiveRoomRow as any)?.bookingCode ||
        persistedSnapshot.bookingCode ||
        '',
      ).trim() || null,
      searchReference: String(
        (selectedLiveRoomRow as any)?.searchReference ||
        persistedSnapshot.searchReference ||
        '',
      ).trim() || null,
      roomId: String(
        selectedRoomType.roomId ||
        (selectedLiveRoomRow as any)?.roomId ||
        persistedSnapshot.roomId ||
        '',
      ).trim() || null,
      rateId: String(
        (selectedLiveRoomRow as any)?.rateId ||
        persistedSnapshot.rateId ||
        '',
      ).trim() || null,
      totalRooms,
    });
    const hotelDetailsModel = (this.prisma as any).dvi_itinerary_plan_hotel_details;
    const persistedParent = hotelDetailsModel?.findFirst
      ? await hotelDetailsModel.findFirst({
        where: { itinerary_plan_hotel_details_ID: hotelDetailsId },
        select: { hotel_id: true },
      })
      : null;
    const persistedHotelId = Number(params.hotel_id || persistedParent?.hotel_id || 0);
    if (hotelDetailsModel?.update) await hotelDetailsModel.update({
      where: { itinerary_plan_hotel_details_ID: hotelDetailsId },
      data: {
        hotel_id: persistedHotelId,
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
    return {
      success: true,
      message: 'Room category updated successfully',
      roomTypeName: selectedRoomType.roomTypeTitle,
      itinerary_plan_hotel_details_ID: hotelDetailsId,
    };
  }

  /**
   * Resolve the parent hotel-details row before changing a room category.
   *
   * Some supplier cards (especially newly fetched STAAH/TBO cards) used to
   * reach this endpoint with parent ID 0. Updating ID 0 causes Prisma to throw
   * a 500 even though the room/category data is valid. Prefer the supplied
   * active parent, then the active row for this plan/route/hotel/group, and
   * create the parent when the card has not been persisted yet.
   */
  private async resolveHotelDetailsId(params: {
    itinerary_plan_hotel_details_ID: number;
    itinerary_plan_id: number;
    itinerary_route_id: number;
    hotel_id: number;
    group_type: number;
    hotel_code?: string;
    provider?: string;
    hotel_name?: string;
    routeDate: Date | null;
    hotelRoom: any;
    selectedLiveRoomRow: any;
    selectedRoomTypeName: string | null;
    selectedRateOptionId: string | null;
    selectedPricePerNight: number | null;
    selectedTotalPrice: number | null;
    now: Date;
  }): Promise<number> {
    const hotelDetailsModel = (this.prisma as any).dvi_itinerary_plan_hotel_details;
    const requestedId = Number(params.itinerary_plan_hotel_details_ID || 0);
    if (!hotelDetailsModel?.findFirst || !hotelDetailsModel?.create) {
      // Keep the service unit-testable and preserve the legacy update contract
      // when the caller already supplied a valid parent row. A zero parent
      // cannot be repaired without the parent model, so fail explicitly.
      if (requestedId > 0) return requestedId;
      throw new NotFoundException('Hotel details persistence is unavailable');
    }

    const baseWhere = {
      itinerary_plan_id: params.itinerary_plan_id,
      itinerary_route_id: params.itinerary_route_id,
      group_type: params.group_type,
      deleted: 0,
      status: 1,
    };
    const existing = requestedId > 0
      ? await hotelDetailsModel.findFirst({
        where: {
          itinerary_plan_hotel_details_ID: requestedId,
          itinerary_plan_id: params.itinerary_plan_id,
          itinerary_route_id: params.itinerary_route_id,
          deleted: 0,
          status: 1,
        },
        select: { itinerary_plan_hotel_details_ID: true },
      })
      : await hotelDetailsModel.findFirst({
        where: { ...baseWhere, hotel_id: params.hotel_id },
        orderBy: { itinerary_plan_hotel_details_ID: 'desc' },
        select: { itinerary_plan_hotel_details_ID: true },
      });
    if (existing?.itinerary_plan_hotel_details_ID) {
      return Number(existing.itinerary_plan_hotel_details_ID);
    }

    const liveRoom = params.selectedLiveRoomRow || params.hotelRoom || {};
    if (requestedId === 0 && hotelDetailsModel.findMany) {
      const identityMatch = await this.findActiveParentByIdentity(hotelDetailsModel, params, liveRoom);
      if (identityMatch?.itinerary_plan_hotel_details_ID) {
        return Number(identityMatch.itinerary_plan_hotel_details_ID);
      }
    }
    const provider = String(liveRoom.provider || 'staah').trim().toLowerCase();
    const totalPrice = params.selectedTotalPrice || params.selectedPricePerNight || 0;
    const created = await hotelDetailsModel.create({
      data: {
        itinerary_plan_id: params.itinerary_plan_id,
        itinerary_route_id: params.itinerary_route_id,
        itinerary_route_date: params.routeDate,
        itinerary_route_location: String(liveRoom.destination || '').trim() || null,
        group_type: params.group_type,
        hotel_required: 1,
        hotel_category_id: Number(liveRoom.hotelCategory || liveRoom.category || 0),
        hotel_id: params.hotel_id,
        hotel_code: String(liveRoom.hotelCode || liveRoom.providerHotelCode || params.hotel_id).trim() || null,
        hotel_provider: provider,
        hotel_booking_mode: 'LIVE_API',
        price_source: 'LIVE_API',
        is_live_rate: true,
        selected_rate_option_id: params.selectedRateOptionId,
        selected_price_per_night: params.selectedPricePerNight,
        selected_total_price: params.selectedTotalPrice,
        selected_currency: String(liveRoom.currency || 'INR').trim() || 'INR',
        selected_price_snapshot: JSON.stringify({
          optionKey: params.selectedRateOptionId,
          rateOptionId: params.selectedRateOptionId,
          provider,
          hotelName: String(liveRoom.hotelName || '').trim() || null,
          roomType: params.selectedRoomTypeName,
          mealPlan: String(liveRoom.mealPlan || '').trim() || null,
          selectionOrigin: 'USER_SELECTED',
        }),
        total_no_of_rooms: 1,
        total_room_cost: totalPrice,
        total_hotel_cost: totalPrice,
        total_hotel_tax_amount: 0,
        hotel_check_in_date: params.routeDate,
        createdon: params.now,
        updatedon: params.now,
        status: 1,
        deleted: 0,
      },
      select: { itinerary_plan_hotel_details_ID: true },
    });
    return Number(created.itinerary_plan_hotel_details_ID);
  }

  private async findActiveParentByIdentity(
    hotelDetailsModel: any,
    params: {
      itinerary_plan_hotel_details_ID?: number;
      itinerary_plan_id: number;
      itinerary_route_id: number;
      hotel_id: number;
      group_type: number;
      hotel_code?: string;
      provider?: string;
      hotel_name?: string;
    },
    liveRoom?: any,
  ) {
    if (!hotelDetailsModel?.findMany) return null;

    const requestedCode = this.normalizeIdentity(
      params.hotel_code || liveRoom?.hotelCode || liveRoom?.providerHotelCode,
    );
    const requestedProvider = this.normalizeIdentity(
      params.provider || liveRoom?.provider,
    );
    const requestedName = this.normalizeIdentity(
      params.hotel_name || liveRoom?.hotelName || liveRoom?.hotel_name,
    );
    if (!requestedCode && !requestedName) return null;

    const candidates = await hotelDetailsModel.findMany({
      where: {
        itinerary_plan_id: params.itinerary_plan_id,
        itinerary_route_id: params.itinerary_route_id,
        group_type: params.group_type,
        deleted: 0,
        status: 1,
      },
      orderBy: { itinerary_plan_hotel_details_ID: 'desc' },
      select: {
        itinerary_plan_hotel_details_ID: true,
        hotel_id: true,
        hotel_code: true,
        hotel_provider: true,
        selected_price_snapshot: true,
      },
    });

    return (candidates || []).find((candidate: any) => {
      let snapshot: any = {};
      try {
        snapshot = candidate.selected_price_snapshot
          ? JSON.parse(String(candidate.selected_price_snapshot))
          : {};
      } catch {
        snapshot = {};
      }

      const candidateProvider = this.normalizeIdentity(
        candidate.hotel_provider || snapshot.provider,
      );
      if (requestedProvider && candidateProvider && requestedProvider !== candidateProvider) {
        return false;
      }

      const candidateCode = this.normalizeIdentity(
        candidate.hotel_code || snapshot.hotelCode || snapshot.providerHotelCode,
      );
      const candidateName = this.normalizeIdentity(snapshot.hotelName || snapshot.hotel_name);
      return Boolean(
        (requestedCode && candidateCode === requestedCode) ||
        (requestedName && candidateName === requestedName),
      );
    }) || null;
  }

  private async resolveAvailableRoomTypes(
    hotelId: number,
    matchingHotelRooms: any[],
    provider?: string,
  ) {
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
    const providerName = String(provider || matchingHotelRooms[0]?.provider || '').trim().toLowerCase();
    const hasCanonicalRoomMaster = Boolean(roomModel?.findMany);
    const useCanonicalRoomMaster = hasCanonicalRoomMaster && Boolean(providerName) && !['tbo', 'vsr', 'vrs'].includes(providerName);

    if (!useCanonicalRoomMaster) {
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
    }

    // Non-VSR providers (notably AxisRooms and STAAH) can have a valid
    // persisted selection without a corresponding VSR room-detail row. In
    // that case the canonical hotel-room master is the authoritative source
    // for the room-category editor.
    if (useCanonicalRoomMaster) {
      // AxisRooms/STAAH room IDs are canonical DB room-type IDs. Build these
      // first so an incidental supplier/VSR option with the same numeric ID
      // cannot shadow the authoritative DB title (for example Deluxe vs an
      // old Valley View Double label).
      for (const room of hotelRooms) {
        const roomTypeId = Number(room.room_type_id || 0);
        if (roomTypeId <= 0 || seenRoomTypeIds.has(roomTypeId)) continue;
        seenRoomTypeIds.add(roomTypeId);
        availableRoomTypes.push({
          roomTypeId,
          roomTypeTitle: String(room.room_title || room.room_ref_code || `Room ${roomTypeId}`).trim(),
          roomId: Number(room.room_ID || roomTypeId),
          pricePerNight: 0,
        });
      }
    } else if (availableRoomTypes.length === 0) {
      // Preserve the existing fallback for TBO/VSR when the supplier did not
      // return any usable room categories.
      for (const room of hotelRooms) {
        const roomTypeId = Number(room.room_type_id || 0);
        if (roomTypeId <= 0 || seenRoomTypeIds.has(roomTypeId)) continue;
        seenRoomTypeIds.add(roomTypeId);
        availableRoomTypes.push({
          roomTypeId,
          roomTypeTitle: String(room.room_title || room.room_ref_code || `Room ${roomTypeId}`).trim(),
          roomId: Number(room.room_ID || roomTypeId),
          pricePerNight: 0,
        });
      }
    }

    return availableRoomTypes;
  }

  private parseSelectedSnapshot(value: unknown): any {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try {
      return JSON.parse(String(value));
    } catch {
      return {};
    }
  }

  private async findPersistedHotelParent(params: {
    itinerary_plan_hotel_details_ID?: number;
    itinerary_plan_id: number;
    itinerary_route_id: number;
    hotel_id: number;
    group_type: number;
    hotel_code?: string;
    provider?: string;
    hotel_name?: string;
  }) {
    const hotelDetailsModel = (this.prisma as any).dvi_itinerary_plan_hotel_details;
    if (!hotelDetailsModel?.findFirst) return null;
    const requestedId = Number(params.itinerary_plan_hotel_details_ID || 0);
    const direct = requestedId > 0
      ? await hotelDetailsModel.findFirst({
        where: {
          itinerary_plan_hotel_details_ID: requestedId,
          itinerary_plan_id: params.itinerary_plan_id,
          itinerary_route_id: params.itinerary_route_id,
          deleted: 0,
          status: 1,
        },
        select: { selected_price_snapshot: true, hotel_id: true },
      })
      : null;
    if (direct) return direct;

    const byHotel = await hotelDetailsModel.findFirst({
      where: {
        itinerary_plan_id: params.itinerary_plan_id,
        itinerary_route_id: params.itinerary_route_id,
        hotel_id: params.hotel_id,
        group_type: params.group_type,
        deleted: 0,
        status: 1,
      },
      orderBy: { itinerary_plan_hotel_details_ID: 'desc' },
      select: { selected_price_snapshot: true, hotel_id: true },
    });
    if (byHotel) return byHotel;

    if (hotelDetailsModel.findMany) {
      return this.findActiveParentByIdentity(hotelDetailsModel, {
        ...params,
        itinerary_plan_hotel_details_ID: 0,
      });
    }
    return null;
  }

  private matchHotelRooms(
    rooms: any[],
    params: {
      hotel_id: number;
      group_type: number;
      hotel_code?: string;
      provider?: string;
      hotel_name?: string;
    },
  ): any[] {
    return rooms.filter((room) => this.matchesRoomIdentity(room, params));
  }

  private matchesRoomIdentity(
    room: any,
    params: {
      hotel_id: number;
      group_type: number;
      hotel_code?: string;
      provider?: string;
      hotel_name?: string;
    },
  ): boolean {
    const roomGroupType = Number(room.groupType ?? room.group_type ?? 0);
    if (roomGroupType !== Number(params.group_type || 0)) return false;

    const requestedHotelId = Number(params.hotel_id || 0);
    const roomHotelIds = [room.hotelId, room.canonicalHotelId, room.hotel_id]
      .map((value) => Number(value || 0))
      .filter((value) => value > 0);
    if (requestedHotelId > 0 && roomHotelIds.includes(requestedHotelId)) return true;

    const normalizeIdentity = (value: unknown): string =>
      String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    const requestedCode = normalizeIdentity(params.hotel_code);
    const roomCodes = [room.hotelCode, room.providerHotelCode, room.hotel_code, room.code]
      .map(normalizeIdentity)
      .filter(Boolean);
    if (requestedCode && roomCodes.includes(requestedCode)) return true;

    const requestedName = normalizeIdentity(params.hotel_name);
    const roomName = normalizeIdentity(room.hotelName || room.hotel_name);
    if (requestedName && roomName && requestedName === roomName) return true;

    return false;
  }

  private normalizeText(value: unknown): string {
    return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  }

  private normalizeIdentity(value: unknown): string {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  }
}
