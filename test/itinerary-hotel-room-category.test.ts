import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryHotelRoomCategoryService } from '../src/modules/itineraries/services/itinerary-hotel-room-category.service';

const params = { itinerary_plan_hotel_details_ID: 10, itinerary_plan_id: 1, itinerary_route_id: 2, hotel_id: 3, group_type: 4 };

test('projects preferred room slots from TBO when no selections exist', async () => {
  const service = new ItineraryHotelRoomCategoryService({
    dvi_itinerary_plan_details: { findUnique: async () => ({ preferred_room_count: 2, itinerary_quote_ID: 9 }) },
    dvi_itinerary_route_details: { findUnique: async () => ({ itinerary_route_date: '2026-07-16' }) },
    dvi_itinerary_plan_hotel_room_details: { findMany: async () => [] },
  }, { getHotelRoomDetailsFromTbo: async () => ({ rooms: [{ hotelId: 3, groupType: 4, hotelName: 'Test Hotel', availableRoomTypes: [{ roomTypeId: 8, roomTypeTitle: 'Deluxe' }] }] }) });
  const result = await service.getHotelRoomCategories(params);
  assert.equal(result.rooms.length, 2);
  assert.equal(result.rooms[0].available_room_types[0].room_type_title, 'Deluxe');
});

test('matches TBO/VSR room categories by provider hotel code when numeric hotel id is zero', async () => {
  const service = new ItineraryHotelRoomCategoryService({
    dvi_itinerary_plan_details: { findUnique: async () => ({ preferred_room_count: 1, itinerary_quote_ID: 9 }) },
    dvi_itinerary_route_details: { findUnique: async () => ({ itinerary_route_date: '2026-07-16' }) },
    dvi_itinerary_plan_hotel_room_details: { findMany: async () => [] },
  }, { getHotelRoomDetailsFromTbo: async () => ({
    rooms: [{
      hotelId: 0,
      canonicalHotelId: null,
      hotelCode: 'TBO-123',
      provider: 'tbo',
      groupType: 4,
      hotelName: 'TBO Hotel',
      availableRoomTypes: [{ roomTypeId: 8, roomTypeTitle: 'Deluxe' }],
    }],
  }) });

  const result = await service.getHotelRoomCategories({
    ...params,
    hotel_id: 0,
    hotel_code: 'TBO-123',
    provider: 'tbo',
    hotel_name: 'TBO Hotel',
  });

  assert.equal(result.rooms.length, 1);
  assert.equal(result.rooms[0].available_room_types[0].room_type_title, 'Deluxe');
});

test('prefills room category from the persisted selected snapshot when room row has no provider room type id', async () => {
  const service = new ItineraryHotelRoomCategoryService({
    dvi_itinerary_plan_details: { findUnique: async () => ({ preferred_room_count: 2, itinerary_quote_ID: 9 }) },
    dvi_itinerary_route_details: { findUnique: async () => ({ itinerary_route_date: '2026-07-16' }) },
    dvi_itinerary_plan_hotel_details: {
      findFirst: async () => ({
        itinerary_plan_hotel_details_ID: 10,
        selected_price_snapshot: JSON.stringify({ roomType: 'Deluxe Room' }),
      }),
    },
    dvi_itinerary_plan_hotel_room_details: {
      findMany: async () => [
        { itinerary_plan_hotel_room_details_ID: 20, room_type_id: 0, room_qty: 1 },
        { itinerary_plan_hotel_room_details_ID: 21, room_type_id: 0, room_qty: 1 },
      ],
    },
  }, { getHotelRoomDetailsFromTbo: async () => ({
    rooms: [{
      hotelId: 3,
      groupType: 4,
      hotelName: 'Test Hotel',
      availableRoomTypes: [
        { roomTypeId: 8, roomTypeTitle: 'Deluxe Room' },
        { roomTypeId: 9, roomTypeTitle: 'Suite' },
      ],
    }],
  }) });

  const result = await service.getHotelRoomCategories(params);
  assert.deepEqual(result.rooms.map((room: any) => room.room_type_id), [8, 8]);
  assert.deepEqual(result.rooms.map((room: any) => room.room_type_title), ['Deluxe Room', 'Deluxe Room']);
});

test('updates a selected TBO room and preserves meal-plan flags', async () => {
  let updateQuery: any;
  const service = new ItineraryHotelRoomCategoryService({
    dvi_itinerary_route_details: { findUnique: async () => ({ itinerary_route_date: '2026-07-16' }) },
    dvi_itinerary_plan_details: { findFirst: async () => ({ itinerary_quote_ID: 9 }) },
    dvi_itinerary_plan_hotel_room_details: { update: async (query: any) => { updateQuery = query; } },
  }, { getHotelRoomDetailsFromTbo: async () => ({ rooms: [{ hotelId: 3, groupType: 4, pricePerNight: 250, availableRoomTypes: [{ roomTypeId: 8, roomTypeTitle: 'Deluxe' }] }] }) });
  const result = await service.updateRoomCategory({ ...params, itinerary_plan_hotel_room_details_ID: 20, room_type_id: 8, all_meal_plan: 1 });
  assert.equal(result.roomTypeName, 'Deluxe');
  assert.equal(updateQuery.data.room_rate, 250);
  assert.equal(updateQuery.data.breakfast_required, 1);
  assert.equal(updateQuery.data.dinner_required, 1);
});

test('does not overwrite an existing meal plan when only room category changes', async () => {
  let updateQuery: any;
  const service = new ItineraryHotelRoomCategoryService({
    dvi_itinerary_route_details: { findUnique: async () => ({ itinerary_route_date: '2026-07-16' }) },
    dvi_itinerary_plan_details: { findFirst: async () => ({ itinerary_quote_ID: 9 }) },
    dvi_itinerary_plan_hotel_room_details: { update: async (query: any) => { updateQuery = query; } },
  }, { getHotelRoomDetailsFromTbo: async () => ({ rooms: [{ hotelId: 3, groupType: 4, pricePerNight: 250, availableRoomTypes: [{ roomTypeId: 8, roomTypeTitle: 'Deluxe' }] }] }) });

  await service.updateRoomCategory({ ...params, itinerary_plan_hotel_room_details_ID: 20, room_type_id: 8 });

  assert.equal('breakfast_required' in updateQuery.data, false);
  assert.equal('lunch_required' in updateQuery.data, false);
  assert.equal('dinner_required' in updateQuery.data, false);
});
