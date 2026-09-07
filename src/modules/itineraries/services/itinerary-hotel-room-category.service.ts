import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { ItineraryHotelDetailsTboService } from '../itinerary-hotel-details-tbo.service';
import { resolveHotelOccupancyPricing } from '../utils/hotel-selection-pricing.util';

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
      select: {
        preferred_room_count: true,
        itinerary_quote_ID: true,
        total_adult: true,
        total_extra_bed: true,
        total_child_with_bed: true,
        total_child_without_bed: true,
        meal_plan_code: true,
      },
    });
    if (!plan) throw new NotFoundException('Itinerary plan not found');
    const route = await this.prisma.dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: params.itinerary_route_id },
      select: { itinerary_route_date: true },
    });
    if (!route) throw new NotFoundException('Route not found');

    const providerName = String(params.provider || '').trim().toLowerCase();
    const requiresLiveRoomDetails = !providerName || ['tbo', 'vsr', 'vrs'].includes(providerName);
    // Offline and local supplier cards use the canonical room master below.
    // Do not block opening their editor on a TBO network request.
    const tboRoomDetails = requiresLiveRoomDetails
      ? await this.hotelDetailsTboService.getHotelRoomDetailsFromTbo(plan.itinerary_quote_ID, params.itinerary_route_id)
      : { rooms: [] };
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
    let availableRoomTypes = await this.resolveAvailableRoomTypes(
      params.hotel_id,
      matchingHotelRooms,
      params.provider,
      route.itinerary_route_date,
      plan,
      params.itinerary_plan_id,
      params.itinerary_route_id,
    );

    // VSR is the UI label for TBO. The room-details endpoint can contain only
    // the currently selected room, while the selected-hotel rate refresh
    // exposes the complete room/rate inventory used by select-intent. Use the
    // latter to populate this editor; otherwise a valid multi-category hotel
    // incorrectly appears to have only one dropdown option.
    let hasFreshBreakfastRoomTypes = false;
    if (requiresLiveRoomDetails && ['tbo', 'vsr', 'vrs'].includes(providerName) &&
      typeof this.hotelDetailsTboService.getSelectedHotelRates === 'function') {
      try {
        const routeModel = (this.prisma as any).dvi_itinerary_route_details;
        const stayRoutes = routeModel?.findMany
          ? await routeModel.findMany({
            where: { itinerary_plan_ID: params.itinerary_plan_id, deleted: 0, status: 1 },
            select: { itinerary_route_ID: true, location_id: true, itinerary_route_date: true },
            orderBy: { itinerary_route_date: 'asc' },
          })
          : [];
        const anchorIndex = stayRoutes.findIndex((route: any) =>
          Number(route.itinerary_route_ID) === Number(params.itinerary_route_id),
        );
        const routeIds = [Number(params.itinerary_route_id)];
        if (anchorIndex >= 0) {
          for (let index = anchorIndex + 1; index < stayRoutes.length; index += 1) {
            const previous = stayRoutes[index - 1];
            const current = stayRoutes[index];
            const previousDate = new Date(previous.itinerary_route_date).getTime();
            const currentDate = new Date(current.itinerary_route_date).getTime();
            if (Number(previous.location_id) !== Number(current.location_id) ||
              currentDate - previousDate !== 24 * 60 * 60 * 1000) break;
            routeIds.push(Number(current.itinerary_route_ID));
          }
        }
        const refreshedRows = (await Promise.all(routeIds.map((routeId) =>
          this.hotelDetailsTboService.getSelectedHotelRates(
            plan.itinerary_quote_ID,
            routeId,
            'tbo',
            String(params.hotel_code || params.hotel_id || '').trim(),
            params.group_type,
          ),
        ))).flatMap((selectedRates) => selectedRates.hotels || []).filter((row: any) =>
          String(row?.hotelCode || row?.providerHotelCode || '').trim() ===
          String(params.hotel_code || params.hotel_id || '').trim(),
        );
        // TBO returns multiple rates for the same property. The editor is
        // intentionally breakfast-only (CP); never expose the room-only EP
        // rate as an alternative room category.
        const breakfastRows = refreshedRows.filter((row: any) =>
          String(row?.mealPlan || row?.mealPlanCode || '').trim().toUpperCase() === 'CP',
        );
        const refreshedTypes = breakfastRows.flatMap((row: any) => {
          const options = Array.isArray(row?.rateOptions) && row.rateOptions.length > 0
            ? row.rateOptions
            : [row];
          return options.map((option: any) => ({
            roomTypeId: Number(
              option?.roomTypeId ?? option?.room_type_id ??
              option?.roomId ?? option?.room_id ?? row?.roomTypeId ?? row?.roomId ??
              Number(String(option?.selectionKey || option?.rateOptionId || option?.searchReference || row?.selectionKey || '').match(/:(\d+)$/)?.[1] || 0),
            ),
            roomTypeTitle: String(
              option?.roomType || option?.roomTypeName || option?.room_name ||
              row?.roomType || row?.roomTypeName || row?.room_name || '',
            ).trim(),
            roomId: Number(option?.roomId ?? option?.room_id ?? row?.roomId ?? 0),
            pricePerNight: Number(option?.pricePerNight ?? row?.pricePerNight ?? option?.totalPrice ?? row?.totalPrice ?? 0),
          }));
        }).filter((roomType: any) => roomType.roomTypeId > 0 && roomType.roomTypeTitle);

        if (refreshedTypes.length > 0) {
          hasFreshBreakfastRoomTypes = true;
          availableRoomTypes = refreshedTypes;
        }
        const merged = [...availableRoomTypes];
        const uniqueByTitle = new Map<string, typeof availableRoomTypes[number]>();
        for (const roomType of merged) {
          const key = this.normalizeText(roomType.roomTypeTitle);
          if (key && !uniqueByTitle.has(key)) uniqueByTitle.set(key, roomType);
        }
        availableRoomTypes = Array.from(uniqueByTitle.values());
      } catch (error) {
        // Keep the existing room-details result if the supplementary refresh
        // fails. Opening the editor must not regress into a hard failure.
        console.warn('[HOTEL_ROOM_CATEGORIES] selected-rate inventory refresh failed', error);
      }
    }
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
    const snapshotRoomTypeOptions = Array.isArray(selectedSnapshot.availableRoomTypeOptions)
      ? selectedSnapshot.availableRoomTypeOptions
        .map((option: any) => ({
          roomTypeId: Number(option?.roomTypeId || option?.room_type_id || 0),
          roomTypeTitle: String(option?.roomTypeTitle || option?.room_type_title || '').trim(),
          roomId: Number(option?.roomId || option?.room_id || option?.roomTypeId || 0),
          pricePerNight: Number(option?.pricePerNight || 0),
        }))
        .filter((option: any) => option.roomTypeId > 0 && option.roomTypeTitle)
      : [];
    if (requiresLiveRoomDetails && !hasFreshBreakfastRoomTypes && snapshotRoomTypeOptions.length > 0) {
      const merged = [...availableRoomTypes, ...snapshotRoomTypeOptions];
      const uniqueByTitle = new Map<string, typeof availableRoomTypes[number]>();
      for (const roomType of merged) {
        const key = this.normalizeText(roomType.roomTypeTitle);
        if (key && !uniqueByTitle.has(key)) uniqueByTitle.set(key, roomType);
      }
      availableRoomTypes = Array.from(uniqueByTitle.values());
    }
    if (availableRoomTypes.length === 0) throw new NotFoundException('No room types available for this hotel');
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
    const available = availableRoomTypes.map((roomType: any) => ({
      room_type_id: roomType.roomTypeId,
      room_type_title: roomType.roomTypeTitle || '',
      ...(Number(roomType.pricePerNight || 0) > 0 ? { price_per_night: Number(roomType.pricePerNight) } : {}),
    }));
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
      // A room child can retain a category ID from a previous hotel after the
      // parent hotel changes. Never expose that stale ID to the selector: if
      // it is not part of this hotel's current categories, resolve the room
      // from the persisted selected snapshot instead.
      const roomTypeId = Number(selectedRoomType?.roomTypeId || 0);
      return {
        room_number: index + 1,
        itinerary_plan_hotel_room_details_ID: room.itinerary_plan_hotel_room_details_ID,
        room_type_id: roomTypeId || null,
        room_type_title: selectedRoomType?.roomTypeTitle ||
          selectedSnapshotRoomType,
        room_qty: 1,
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
    room_number?: number;
    room_qty?: number;
    all_meal_plan?: number;
    breakfast_meal_plan?: number;
    lunch_meal_plan?: number;
    dinner_meal_plan?: number;
    propagateContinuous?: boolean;
  }) {
    const route = await this.prisma.dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: params.itinerary_route_id },
      select: { itinerary_route_date: true },
    });
    if (!route) throw new NotFoundException('Route not found');
    const planDetails = await this.prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_plan_ID: params.itinerary_plan_id, deleted: 0 },
      select: {
        itinerary_quote_ID: true,
        total_adult: true,
        preferred_room_count: true,
        total_extra_bed: true,
        total_child_with_bed: true,
        total_child_without_bed: true,
        meal_plan_code: true,
      },
    });
    if (!planDetails) throw new NotFoundException('Itinerary plan details not found');

    // `update-categories` is a persistence mutation. It must not perform a
    // supplier availability request: the selected category came from the
    // already-rendered editor, and availability belongs to the explicit
    // check/preview flow. Use the persisted snapshot/local room master below.
    const matchingHotelRooms: any[] = [];
    const persistedSelectionParent = await this.findPersistedHotelParent(params);
    const persistedSnapshot = this.parseSelectedSnapshot(persistedSelectionParent?.selected_price_snapshot);
    const hotelDetailsModel = (this.prisma as any).dvi_itinerary_plan_hotel_details;
    let selectionMarginPercentage = Number(
      (persistedSelectionParent as any)?.hotel_margin_percentage ||
      (persistedSnapshot as any).hotelMarginPercentage || 0,
    );
    // A continuous-night parent can be newly created for the edited route.
    // In that case its margin columns are still zero; inherit the configured
    // margin from another active parent of the same continuous hotel stay.
    if (selectionMarginPercentage <= 0 && hotelDetailsModel?.findMany) {
      const siblingParents = await hotelDetailsModel.findMany({
        where: {
          itinerary_plan_id: params.itinerary_plan_id,
          hotel_id: params.hotel_id,
          group_type: params.group_type,
          deleted: 0,
          status: 1,
        },
        select: { hotel_margin_percentage: true },
      });
      selectionMarginPercentage = Math.max(
        0,
        ...(siblingParents as any[]).map((row) => Number(row.hotel_margin_percentage || 0)),
      );
    }
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
    let availableRoomTypes = await this.resolveAvailableRoomTypes(
      params.hotel_id,
      matchingHotelRooms,
      params.provider,
      route.itinerary_route_date,
      planDetails,
      params.itinerary_plan_id,
      params.itinerary_route_id,
    );
    // TBO/VSR room options are intentionally not refreshed here. If a live
    // provider selection is edited, use the option inventory captured in the
    // persisted selection snapshot. A fresh supplier check is an explicit
    // availability operation, never a side effect of saving a room category.
    const snapshotRoomTypeOptions = Array.isArray(persistedSnapshot.availableRoomTypeOptions)
      ? persistedSnapshot.availableRoomTypeOptions
        .map((option: any) => ({
          roomTypeId: Number(option?.roomTypeId || option?.room_type_id || 0),
          roomTypeTitle: String(option?.roomTypeTitle || option?.room_type_title || '').trim(),
          roomId: Number(option?.roomId || option?.room_id || option?.roomTypeId || option?.room_type_id || 0),
          pricePerNight: Number(option?.pricePerNight || option?.price_per_night || 0),
        }))
        .filter((option: any) => option.roomTypeId > 0 && option.roomTypeTitle)
      : [];
    if (availableRoomTypes.length === 0 && snapshotRoomTypeOptions.length > 0) {
      availableRoomTypes = snapshotRoomTypeOptions;
    }
    const selectedSnapshotOption = snapshotRoomTypeOptions.find((option: any) =>
      Number(option.roomTypeId) === Number(params.room_type_id),
    );
    const selectedRoomType = availableRoomTypes.find((roomType: any) =>
      Number(roomType.roomTypeId) === Number(params.room_type_id)) || selectedSnapshotOption || (
        Number(params.room_type_id) > 0 && String(persistedSnapshot.roomType || '').trim()
          ? {
            roomTypeId: Number(params.room_type_id),
            roomTypeTitle: String(persistedSnapshot.roomType).trim(),
            roomId: Number(persistedSnapshot.roomId || params.room_type_id),
            pricePerNight: Number(persistedSnapshot.pricePerNight || persistedSnapshot.selectedPricePerNight || 0),
          }
          : null
      );
    if (!selectedRoomType) throw new NotFoundException('Selected room type not available for this hotel');
    const selectedLiveRoomRow = selectedSnapshotOption
      ? { ...hotelRoom, ...selectedSnapshotOption }
      : hotelRoom;

    const canonicalProvider = ['offline', 'axisrooms', 'ax'].includes(
      String(params.provider || hotelRoom.provider || '').trim().toLowerCase(),
    );
    const occupancyRates = canonicalProvider
      ? await this.resolveOccupancyRates(
        params.hotel_id,
        Number(selectedRoomType.roomId || 0),
        route.itinerary_route_date,
      )
      : null;
    if (canonicalProvider && !occupancyRates) {
      throw new NotFoundException('Selected room has no occupancy rate for this date');
    }
    const roomRate = Number(
      occupancyRates
        ? resolveHotelOccupancyPricing({
          rates: occupancyRates,
          roomCount: 1,
          adultCount: Number((planDetails as any)?.total_adult || 0),
        }).roomRate
        : selectedRoomType.pricePerNight || hotelRoom.pricePerNight || 0,
    );
    const now = new Date();
    const selectedRateOptionId =
      String(
        (selectedLiveRoomRow as any)?.rateOptionId ||
        (selectedLiveRoomRow as any)?.searchReference ||
        (selectedLiveRoomRow as any)?.bookingCode ||
        '',
      ).trim() || null;
    let selectedPricePerNight = Number(
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
    // A newly added room may not have a child-row ID yet. Resolve it by its
    // displayed room number before deciding to create, otherwise repeated
    // confirms can target the wrong child row and lose Room 2's selection.
    const roomDetailsModel = (this.prisma as any).dvi_itinerary_plan_hotel_room_details;
    let roomDetailsId = Number(params.itinerary_plan_hotel_room_details_ID || 0);
    // The client can hold a child ID from a previous hotel-details parent
    // after reset/rebuild. Never re-parent that stale row as a side effect of
    // a room edit; only accept an ID that belongs to this active parent and
    // route. Otherwise resolve the physical room by its submitted number.
    if (roomDetailsId && roomDetailsModel?.findFirst) {
      const matchingRoom = await roomDetailsModel.findFirst({
        where: {
          itinerary_plan_hotel_room_details_ID: roomDetailsId,
          itinerary_plan_hotel_details_id: hotelDetailsId,
          itinerary_plan_id: params.itinerary_plan_id,
          itinerary_route_id: params.itinerary_route_id,
          itinerary_route_date: route.itinerary_route_date,
          deleted: 0,
          status: 1,
        },
        select: { itinerary_plan_hotel_room_details_ID: true },
      });
      if (!matchingRoom) roomDetailsId = 0;
    }
    if (!roomDetailsId && Number(params.room_number || 0) > 0) {
      const roomRows = await this.prisma.dvi_itinerary_plan_hotel_room_details.findMany({
        where: {
          itinerary_plan_hotel_details_id: hotelDetailsId,
          itinerary_plan_id: params.itinerary_plan_id,
          itinerary_route_id: params.itinerary_route_id,
          itinerary_route_date: route.itinerary_route_date,
          deleted: 0,
          status: 1,
        },
        orderBy: { itinerary_plan_hotel_room_details_ID: 'asc' },
        select: { itinerary_plan_hotel_room_details_ID: true },
      });
      roomDetailsId = Number(roomRows[Number(params.room_number) - 1]?.itinerary_plan_hotel_room_details_ID || 0);
    }
    const baseData = {
      room_type_id: params.room_type_id,
      room_id: Number(selectedRoomType.roomId || params.room_type_id),
      room_qty: 1,
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
    const data = roomDetailsId
      ? { ...baseData, ...mealPlanData }
      : {
        ...baseData,
        breakfast_required: mealPlanData.breakfast_required ?? 0,
        lunch_required: mealPlanData.lunch_required ?? 0,
        dinner_required: mealPlanData.dinner_required ?? 0,
      };
    if (roomDetailsId) {
      await this.prisma.dvi_itinerary_plan_hotel_room_details.update({
        where: { itinerary_plan_hotel_room_details_ID: roomDetailsId },
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
    let occupancyPricing = occupancyRates
      ? resolveHotelOccupancyPricing({
        rates: occupancyRates,
        roomCount: totalRooms,
        adultCount: Number((planDetails as any)?.total_adult || 0),
        extraBedCount: Number((planDetails as any)?.total_extra_bed || 0),
        childWithBedCount: Number((planDetails as any)?.total_child_with_bed || 0),
        childWithoutBedCount: Number((planDetails as any)?.total_child_without_bed || 0),
        marginPercentage: Number(
        selectionMarginPercentage,
        ),
      })
      : null;
    let roomTypeBreakdown: Array<Record<string, unknown>> | undefined;
    let roomSelections: Array<Record<string, unknown>> | undefined;
    // A multi-room category edit is saved one child row at a time. The old
    // code priced the parent with the itinerary-wide occupancy on every call,
    // so the last edited room type became the rate for all rooms. Rebuild the
    // parent from the persisted physical-room rows instead. This branch is
    // intentionally limited to multi-room stays; single-room selections keep
    // the existing pricing path unchanged.
    if (canonicalProvider && activeRoomRows.length > 1) {
      const travellerRows = await this.prisma.dvi_itinerary_traveller_details.findMany({
        where: { itinerary_plan_ID: params.itinerary_plan_id, deleted: 0, status: 1 },
        select: { room_id: true, traveller_type: true, child_bed_type: true },
      });
      const occupancyByRoom = new Map<number, { adults: number; withBed: number; withoutBed: number }>();
      for (const traveller of travellerRows as any[]) {
        const roomNumber = Number(traveller.room_id || 0);
        if (roomNumber <= 0) continue;
        const current = occupancyByRoom.get(roomNumber) || { adults: 0, withBed: 0, withoutBed: 0 };
        if (Number(traveller.traveller_type) === 1) current.adults += 1;
        if (Number(traveller.traveller_type) === 2) {
          if (Number(traveller.child_bed_type) === 2) current.withBed += 1;
          else current.withoutBed += 1;
        }
        occupancyByRoom.set(roomNumber, current);
      }
      const marginPercentage = selectionMarginPercentage;
      const roomBreakdowns: Array<Record<string, unknown>> = [];
      const selectionRows: Array<Record<string, unknown>> = [];
      let aggregateBase = 0;
      let aggregateExtra = 0;
      let aggregateWithBed = 0;
      let aggregateWithoutBed = 0;
      let aggregateMargin = 0;
      for (let index = 0; index < activeRoomRows.length; index += 1) {
        const room = activeRoomRows[index] as any;
        const roomNumber = index + 1;
        const roomId = Number(room.room_id || 0);
        const roomTypeId = Number(room.room_type_id || 0);
        const roomType = availableRoomTypes.find((candidate: any) => Number(candidate.roomTypeId) === roomTypeId);
        const roomTitle = String(roomType?.roomTypeTitle || room.room_type_title || `Room ${roomNumber}`).trim();
        const occupancy = occupancyByRoom.get(roomNumber) || { adults: 0, withBed: 0, withoutBed: 0 };
        const rates = await this.resolveOccupancyRates(params.hotel_id, roomId, route.itinerary_route_date);
        const pricing = rates
          ? resolveHotelOccupancyPricing({
            rates,
            roomCount: 1,
            adultCount: occupancy.adults,
            extraBedCount: Number(room.extra_bed_count || 0),
            childWithBedCount: occupancy.withBed,
            childWithoutBedCount: occupancy.withoutBed,
            marginPercentage,
          })
          : null;
        const roomRate = pricing?.roomRate ?? Number(room.room_rate || 0);
        const extraBedRate = pricing?.extraBedRate ?? Number(room.extra_bed_rate || 0);
        const childWithBedRate = pricing?.childWithBedRate ?? Number(room.child_with_bed_charges || 0);
        const childWithoutBedRate = pricing?.childWithoutBedRate ?? Number(room.child_without_bed_charges || 0);
        const roomCost = pricing?.baseTotalPrice ?? roomRate;
        const extraCost = pricing?.extraBedAmount ?? extraBedRate * Number(room.extra_bed_count || 0);
        const withBedCost = pricing?.childWithBedAmount ?? childWithBedRate * occupancy.withBed;
        const withoutBedCost = pricing?.childWithoutBedAmount ?? childWithoutBedRate * occupancy.withoutBed;
        const subtotal = Number((roomCost + extraCost + withBedCost + withoutBedCost).toFixed(2));
        const margin = pricing?.hotelMarginAmount ?? Number((subtotal * marginPercentage / 100).toFixed(2));
        aggregateBase += roomCost;
        aggregateExtra += extraCost;
        aggregateWithBed += withBedCost;
        aggregateWithoutBed += withoutBedCost;
        aggregateMargin += margin;
        selectionRows.push({
          roomIndex: index,
          roomNumber,
          roomTypeId,
          roomType: roomTitle,
          roomId,
          mealPlan: selectedMealPlan,
        });
        roomBreakdowns.push({
          roomNumber,
          roomTypeId,
          roomType: roomTitle,
          roomCount: 1,
          adultCount: occupancy.adults,
          roomOccupancy: occupancy.adults <= 1 ? 'SINGLE' : 'DOUBLE',
          roomRate,
          roomCost,
          extraBedCount: Number(room.extra_bed_count || 0),
          extraBedRate,
          extraBedCost: Number(extraCost.toFixed(2)),
          childWithBedCount: occupancy.withBed,
          childWithBedRate,
          childWithBedCost: Number(withBedCost.toFixed(2)),
          childWithoutBedCount: occupancy.withoutBed,
          childWithoutBedRate,
          childWithoutBedCost: Number(withoutBedCost.toFixed(2)),
          subtotal,
          marginAmount: Number(margin.toFixed(2)),
        });
      }
      roomSelections = selectionRows;
      roomTypeBreakdown = roomBreakdowns;
      const baseTotal = Number((aggregateBase + aggregateExtra + aggregateWithBed + aggregateWithoutBed).toFixed(2));
      occupancyPricing = {
        roomOccupancy: 'DOUBLE',
        roomRate: Number((aggregateBase / totalRooms).toFixed(2)),
        baseTotalPrice: Number(aggregateBase.toFixed(2)),
        extraBedCount: activeRoomRows.reduce((sum: number, room: any) => sum + Number(room.extra_bed_count || 0), 0),
        extraBedRate: 0,
        extraBedAmount: Number(aggregateExtra.toFixed(2)),
        childWithBedCount: travellerRows.filter((row: any) => Number(row.traveller_type) === 2 && Number(row.child_bed_type) === 2).length,
        childWithBedRate: 0,
        childWithBedAmount: Number(aggregateWithBed.toFixed(2)),
        childWithoutBedCount: travellerRows.filter((row: any) => Number(row.traveller_type) === 2 && Number(row.child_bed_type) !== 2).length,
        childWithoutBedRate: 0,
        childWithoutBedAmount: Number(aggregateWithoutBed.toFixed(2)),
        hotelMarginBaseAmount: baseTotal,
        hotelMarginPercentage: marginPercentage,
        hotelMarginAmount: Number(aggregateMargin.toFixed(2)),
        totalPrice: Number((baseTotal + aggregateMargin).toFixed(2)),
      };
    }
    if (occupancyPricing) {
      // This field is the complete payable amount for this itinerary day,
      // not a per-room rate. The room rate remains available separately.
      selectedPricePerNight = occupancyPricing.totalPrice;
    }
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
      ...(roomSelections ? { roomSelections } : {}),
      ...(roomTypeBreakdown ? { roomTypeBreakdown } : {}),
      ...(occupancyPricing ? {
        roomRate: occupancyPricing.roomRate,
        baseTotalPrice: occupancyPricing.baseTotalPrice,
        hotelMarginBaseAmount: occupancyPricing.hotelMarginBaseAmount,
        hotelMarginPercentage: occupancyPricing.hotelMarginPercentage,
        hotelMarginAmount: occupancyPricing.hotelMarginAmount,
        hotelMarginTotalAmount: occupancyPricing.hotelMarginAmount,
        extraBedCount: occupancyPricing.extraBedCount,
        extraBedRate: occupancyPricing.extraBedRate,
        extraBedAmount: occupancyPricing.extraBedAmount,
        childWithBedCount: occupancyPricing.childWithBedCount,
        childWithBedRate: occupancyPricing.childWithBedRate,
        childWithBedAmount: occupancyPricing.childWithBedAmount,
        childWithoutBedCount: occupancyPricing.childWithoutBedCount,
        childWithoutBedRate: occupancyPricing.childWithoutBedRate,
        childWithoutBedAmount: occupancyPricing.childWithoutBedAmount,
        totalPrice: occupancyPricing.totalPrice,
      } : {}),
    });
    const persistedParent = hotelDetailsModel?.findFirst
      ? await hotelDetailsModel.findFirst({
        where: { itinerary_plan_hotel_details_ID: hotelDetailsId },
        select: { hotel_id: true },
      })
      : null;
    const persistedHotelId = Number(params.hotel_id || persistedParent?.hotel_id || 0);
    const canonicalPricingData = occupancyPricing ? {
      selected_price_per_night: selectedPricePerNight,
      selected_total_price: occupancyPricing.totalPrice,
      total_room_cost: occupancyPricing.baseTotalPrice,
      total_extra_bed_cost: occupancyPricing.extraBedAmount,
      total_childwith_bed_cost: occupancyPricing.childWithBedAmount,
      total_childwithout_bed_cost: occupancyPricing.childWithoutBedAmount,
      hotel_margin_percentage: occupancyPricing.hotelMarginPercentage,
      hotel_margin_rate: occupancyPricing.hotelMarginAmount,
      total_hotel_cost: occupancyPricing.totalPrice,
    } : {};
    if (hotelDetailsModel?.update) await hotelDetailsModel.update({
      where: { itinerary_plan_hotel_details_ID: hotelDetailsId },
      data: {
        hotel_id: persistedHotelId,
        hotel_required: 1,
        total_no_of_rooms: totalRooms,
        hotel_provider: String((selectedLiveRoomRow as any)?.provider || 'staah').trim().toLowerCase(),
        selected_rate_option_id: selectedRateOptionId,
        selected_price_per_night: occupancyPricing ? selectedPricePerNight : selectedPricePerNight,
        selected_total_price: occupancyPricing ? occupancyPricing.totalPrice : selectedTotalPrice,
        selected_currency: String((selectedLiveRoomRow as any)?.currency || 'INR').trim() || null,
        selected_price_snapshot: selectedSnapshot,
        ...canonicalPricingData,
        updatedon: now,
      },
    });
    if (params.propagateContinuous !== false) {
      await this.propagateContinuousRoomCategory({
        ...params,
        itinerary_plan_hotel_details_ID: hotelDetailsId,
        room_type_id: params.room_type_id,
      });
    }
    return {
      success: true,
      message: 'Room category updated successfully',
      roomTypeName: selectedRoomType.roomTypeTitle,
      itinerary_plan_hotel_details_ID: hotelDetailsId,
      ...(occupancyPricing ? {
        financialSummary: {
          roomCost: occupancyPricing.baseTotalPrice,
          extraBedCost: occupancyPricing.extraBedAmount,
          childWithBedCost: occupancyPricing.childWithBedAmount,
          childWithoutBedCost: occupancyPricing.childWithoutBedAmount,
          subtotal: occupancyPricing.hotelMarginBaseAmount,
          margin: occupancyPricing.hotelMarginAmount,
          grandTotal: occupancyPricing.totalPrice,
        },
      } : {}),
    };
  }

  async updateRoomCategories(params: {
    itinerary_plan_hotel_details_ID: number;
    itinerary_plan_id: number;
    itinerary_route_id: number;
    hotel_id: number;
    group_type: number;
    hotel_code?: string;
    provider?: string;
    hotel_name?: string;
    rooms: Array<{
      itinerary_plan_hotel_room_details_ID?: number;
      room_number: number;
      room_type_id: number;
      room_qty?: number;
    }>;
  }) {
    const rooms = Array.isArray(params.rooms) ? params.rooms : [];
    if (rooms.length === 0) throw new BadRequestException('At least one room selection is required');
    const roomNumbers = rooms.map((room) => Number(room.room_number));
    if (new Set(roomNumbers).size !== roomNumbers.length || roomNumbers.some((roomNumber) => roomNumber < 1)) {
      throw new BadRequestException('Room numbers must be unique positive values');
    }

    // The existing calculation method rebuilds the parent from all persisted
    // physical-room rows. Process the complete submitted set before returning
    // the final result, so the caller receives the final parent total rather
    // than an intermediate per-room total.
    let result: any = null;
    let batchParentId = Number(params.itinerary_plan_hotel_details_ID || 0);
    for (const room of rooms.sort((left, right) => Number(left.room_number) - Number(right.room_number))) {
      result = await this.updateRoomCategory({
        ...params,
        // The first room resolves an old/invalid parent if necessary. Reuse
        // that exact parent for the remaining rooms so one confirmation can
        // never create one hotel-details row per room.
        ...(batchParentId > 0 ? { itinerary_plan_hotel_details_ID: batchParentId } : {}),
        ...room,
        room_type_id: Number(room.room_type_id),
        room_qty: Number(room.room_qty || 1),
        // Propagate the complete submitted allocation below. Propagating
        // inside this loop loses the physical room number for sibling nights
        // and can create/reuse the wrong child row.
        propagateContinuous: false,
      });
      batchParentId = Number(result?.itinerary_plan_hotel_details_ID || batchParentId || 0);
    }
    await this.propagateContinuousRoomCategories({
      ...params,
      rooms: rooms.map((room) => ({
        room_number: Number(room.room_number),
        room_type_id: Number(room.room_type_id),
        room_qty: Number(room.room_qty || 1),
      })),
    });
    return {
      ...result,
      batch: true,
      updatedRoomCount: rooms.length,
    };
  }

  /**
   * A bulk modal submission represents one allocation shared by every night
   * of the same continuous hotel stay. Mirror every submitted physical room
   * to each adjacent matching parent, preserving room_number so Room 1 and
   * Room 2 cannot be collapsed into one category.
   */
  private async propagateContinuousRoomCategories(params: {
    itinerary_plan_hotel_details_ID: number;
    itinerary_plan_id: number;
    itinerary_route_id: number;
    hotel_id: number;
    group_type: number;
    hotel_code?: string;
    provider?: string;
    hotel_name?: string;
    rooms: Array<{ room_number: number; room_type_id: number; room_qty?: number }>;
  }): Promise<void> {
    const hotelDetailsModel = (this.prisma as any).dvi_itinerary_plan_hotel_details;
    if (!hotelDetailsModel?.findMany) return;
    const currentRoute = await this.prisma.dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: params.itinerary_route_id },
      select: { itinerary_route_date: true },
    });
    if (!currentRoute?.itinerary_route_date) return;

    const parents = await hotelDetailsModel.findMany({
      where: {
        itinerary_plan_id: params.itinerary_plan_id,
        hotel_id: params.hotel_id,
        group_type: params.group_type,
        deleted: 0,
        status: 1,
      },
      select: {
        itinerary_plan_hotel_details_ID: true,
        itinerary_route_id: true,
        itinerary_route_date: true,
        hotel_provider: true,
        hotel_code: true,
      },
    });

    const currentDate = new Date(currentRoute.itinerary_route_date).getTime();
    const provider = String(params.provider || '').trim().toLowerCase();
    const code = this.normalizeText(params.hotel_code);
    for (const parent of parents as any[]) {
      const routeId = Number(parent.itinerary_route_id || 0);
      if (!routeId || routeId === Number(params.itinerary_route_id)) continue;
      const parentDate = new Date(parent.itinerary_route_date).getTime();
      const dayDistance = Math.abs(parentDate - currentDate) / 86400000;
      if (!Number.isFinite(dayDistance) || dayDistance !== 1) continue;
      const parentProvider = String(parent.hotel_provider || '').trim().toLowerCase();
      const parentCode = this.normalizeText(parent.hotel_code);
      if (provider && parentProvider && provider !== parentProvider) continue;
      if (code && parentCode && code !== parentCode) continue;

      for (const room of params.rooms) {
        await this.updateRoomCategory({
          ...params,
          itinerary_plan_hotel_details_ID: Number(parent.itinerary_plan_hotel_details_ID || 0),
          itinerary_route_id: routeId,
          room_number: Number(room.room_number),
          room_type_id: Number(room.room_type_id),
          room_qty: Number(room.room_qty || 1),
          itinerary_plan_hotel_room_details_ID: 0,
          propagateContinuous: false,
        });
      }
    }
  }

  /**
   * Room-category confirmation is submitted once per physical room, but a
   * continuous stay has one room allocation across all linked nights. Mirror
   * the same room number/category to adjacent active hotel parents, then let
   * the normal update path calculate that night's own rate and supplements.
   */
  private async propagateContinuousRoomCategory(params: {
    itinerary_plan_hotel_details_ID: number;
    itinerary_plan_id: number;
    itinerary_route_id: number;
    hotel_id: number;
    group_type: number;
    hotel_code?: string;
    provider?: string;
    hotel_name?: string;
    room_type_id: number;
    room_number?: number;
    room_qty?: number;
    all_meal_plan?: number;
    breakfast_meal_plan?: number;
    lunch_meal_plan?: number;
    dinner_meal_plan?: number;
  }): Promise<void> {
    const hotelDetailsModel = (this.prisma as any).dvi_itinerary_plan_hotel_details;
    if (!hotelDetailsModel?.findMany) return;
    const currentRoute = await this.prisma.dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: params.itinerary_route_id },
      select: { itinerary_route_date: true },
    });
    if (!currentRoute?.itinerary_route_date) return;
    const parents = await hotelDetailsModel.findMany({
      where: {
        itinerary_plan_id: params.itinerary_plan_id,
        hotel_id: params.hotel_id,
        group_type: params.group_type,
        deleted: 0,
        status: 1,
      },
      select: {
        itinerary_plan_hotel_details_ID: true,
        itinerary_route_id: true,
        itinerary_route_date: true,
        hotel_provider: true,
        hotel_code: true,
      },
    });
    const currentDate = new Date(currentRoute.itinerary_route_date).getTime();
    const provider = String(params.provider || '').trim().toLowerCase();
    const code = this.normalizeText(params.hotel_code);
    for (const parent of parents as any[]) {
      const routeId = Number(parent.itinerary_route_id || 0);
      if (!routeId || routeId === Number(params.itinerary_route_id)) continue;
      const parentDate = new Date(parent.itinerary_route_date).getTime();
      const dayDistance = Math.abs(parentDate - currentDate) / 86400000;
      if (!Number.isFinite(dayDistance) || dayDistance !== 1) continue;
      const parentProvider = String(parent.hotel_provider || '').trim().toLowerCase();
      const parentCode = this.normalizeText(parent.hotel_code);
      if (provider && parentProvider && provider !== parentProvider) continue;
      if (code && parentCode && code !== parentCode) continue;
      await this.updateRoomCategory({
        ...params,
        itinerary_plan_hotel_details_ID: Number(parent.itinerary_plan_hotel_details_ID || 0),
        itinerary_plan_hotel_room_details_ID: 0,
        itinerary_route_id: routeId,
        propagateContinuous: false,
      });
    }
  }

  /**
   * Occupancy rates are the sole database source for canonical/offline room
   * pricing. Price-book rows are deliberately not consulted here.
   */
  private async resolveOccupancyRates(hotelId: number, roomId: number, routeDate?: Date | null) {
    const occupancyModel = (this.prisma as any).dvi_hotel_occupancy_rate;
    if (!occupancyModel?.findMany || !hotelId || !roomId || !routeDate) return null;
    const date = new Date(routeDate);
    const rows = await occupancyModel.findMany({
      where: {
        hotel_id: hotelId,
        room_id: roomId,
        start_date: { lte: date },
        end_date: { gte: date },
      },
      select: { occupancy_rates: true, start_date: true, received_at: true },
      orderBy: [{ start_date: 'desc' }, { received_at: 'desc' }],
    });
    const row = (rows || []).find((candidate: any) => {
      const rates = candidate?.occupancy_rates;
      return rates && typeof rates === 'object' &&
        Object.values(rates).some((value) => Number(value) > 0);
    });
    return row?.occupancy_rates && typeof row.occupancy_rates === 'object'
      ? row.occupancy_rates as Record<string, unknown>
      : null;
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
    routeDate?: Date | null,
    plan?: any,
    planId?: number,
    routeId?: number,
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

    // Canonical/offline room categories use occupancy-rate rows. The legacy
    // room price-book table is intentionally not part of itinerary pricing.
    if (
      routeDate &&
      availableRoomTypes.length > 0 &&
      ['offline', 'axisrooms', 'ax'].includes(providerName)
    ) {
      for (const roomType of availableRoomTypes) {
        const rates = await this.resolveOccupancyRates(hotelId, roomType.roomId, routeDate);
        if (!rates) continue;
        roomType.pricePerNight = Number(rates.DOUBLE || rates.SINGLE || roomType.pricePerNight || 0);
      }

      // The modal edits every room in a continuous stay. A price-book rate
      // alone is not enough: the concrete room must have a positive current
      // inventory and all required occupancy rates on every linked night.
      // Otherwise a room such as Deluxe can appear selectable even though its
      // inventory is zero on the first night.
      if (providerName === 'axisrooms' || providerName === 'ax') {
        const routeModel = (this.prisma as any).dvi_itinerary_route_details;
        const routes = routeModel?.findMany
          ? await routeModel.findMany({
            where: { itinerary_plan_ID: Number(planId || 0), deleted: 0, status: 1 },
            select: { itinerary_route_ID: true, location_id: true, itinerary_route_date: true },
            orderBy: { itinerary_route_date: 'asc' },
          })
          : [];
        const anchorIndex = routes.findIndex((route: any) => Number(route.itinerary_route_ID) === Number(routeId));
        const stayDates: Date[] = [new Date(routeDate)];
        if (anchorIndex >= 0) {
          const anchor = routes[anchorIndex];
          for (let index = anchorIndex + 1; index < routes.length; index += 1) {
            const previous = routes[index - 1];
            const current = routes[index];
            const previousDate = new Date(previous.itinerary_route_date).getTime();
            const currentDate = new Date(current.itinerary_route_date).getTime();
            if (Number(previous.location_id) !== Number(current.location_id) ||
              currentDate - previousDate !== 24 * 60 * 60 * 1000) break;
            stayDates.push(new Date(current.itinerary_route_date));
          }
        }
        const roomCount = Math.max(Number(plan?.preferred_room_count || 1), 1);
        const adultsPerRoom = Math.max(Math.ceil(Number(plan?.total_adult || 0) / roomCount), 1);
        const baseOccupancyKey = adultsPerRoom <= 1 ? 'SINGLE' : 'DOUBLE';
        const requiredKeys = [
          baseOccupancyKey,
          ...(Number(plan?.total_extra_bed || 0) > 0 ? ['EXTRABED'] : []),
          ...(Number(plan?.total_child_with_bed || 0) > 0 ? ['CHILD_WITH_BED'] : []),
          ...(Number(plan?.total_child_without_bed || 0) > 0 ? ['CHILD_WITHOUT_BED'] : []),
        ];
        const mealPlan = String(plan?.meal_plan_code || 'CP').trim().toUpperCase();
        const rateplanIds = [`${mealPlan}_PLAN`, 'CP_PLAN'];
        const occupancyModel = (this.prisma as any).dvi_hotel_occupancy_rate;
        const availabilityModel = (this.prisma as any).dvi_hotel_room_availability;
        const eligible: typeof availableRoomTypes = [];
        for (const roomType of availableRoomTypes) {
          let roomEligible = true;
          for (const date of stayDates) {
            if (!occupancyModel?.findMany || !availabilityModel?.findMany) continue;
            const [rateRows, inventoryRows] = await Promise.all([
              occupancyModel.findMany({
                where: { hotel_id: hotelId, room_id: roomType.roomId, rateplan_id: { in: rateplanIds }, start_date: { lte: date }, end_date: { gte: date } },
                select: { rateplan_id: true, occupancy_rates: true, received_at: true, start_date: true },
                orderBy: [{ received_at: 'desc' }, { start_date: 'desc' }],
              }),
              availabilityModel.findMany({
                where: { hotel_id: hotelId, room_id: roomType.roomId, start_date: { lte: date }, end_date: { gte: date } },
                select: { free: true, received_at: true, start_date: true },
                orderBy: [{ received_at: 'desc' }, { start_date: 'desc' }],
              }),
            ]);
            const rates = rateRows.find((row: any) => String(row.rateplan_id) === `${mealPlan}_PLAN`) || rateRows[0];
            const occupancyRates = rates?.occupancy_rates && typeof rates.occupancy_rates === 'object' ? rates.occupancy_rates : {};
            const inventory = inventoryRows[0];
            if (!rates || requiredKeys.some((key) => Number(occupancyRates[key]) <= 0) || !inventory || Number(inventory.free) < roomCount) {
              roomEligible = false;
              break;
            }
          }
          if (roomEligible) eligible.push(roomType);
        }
        availableRoomTypes.splice(0, availableRoomTypes.length, ...eligible);
      }
    }

    // IDs are not sufficient for supplier data: the same displayed category
    // can be emitted under multiple room IDs. The editor presents one option
    // per normalized title while retaining the first canonical identity.
    const uniqueByTitle = new Map<string, typeof availableRoomTypes[number]>();
    for (const roomType of availableRoomTypes) {
      const key = this.normalizeText(roomType.roomTypeTitle);
      if (key && !uniqueByTitle.has(key)) uniqueByTitle.set(key, roomType);
    }
    return Array.from(uniqueByTitle.values());
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
