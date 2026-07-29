export type HotelSelectionOrigin = 'USER_SELECTED' | 'AUTO_SELECTED';

export type HotelSelectionSnapshot = {
  optionKey?: string;
  rateOptionId?: string;
  rateId?: string;
  bookingCode?: string;
  searchReference?: string;
  provider?: string;
  hotelCode?: string | number;
  hotelId?: string | number;
  roomType?: string;
  mealPlan?: string;
  roomId?: string | number;
  totalPrice?: number;
  pricePerNight?: number;
  searchRunId?: string;
  selectionOrigin?: HotelSelectionOrigin;
  availabilityStatus?: string;
};

export type HotelOptionIdentity = {
  provider?: string;
  hotelCode?: string | number;
  hotelId?: string | number;
  roomId?: string | number;
  rateId?: string | number;
  rateOptionId?: string | number;
  bookingCode?: string | number;
  mealPlan?: string;
  date?: string | Date | null;
  checkInDate?: string | Date | null;
  checkOutDate?: string | Date | null;
};

const clean = (value: unknown): string => String(value ?? '').trim().toLowerCase();

export function normalizeHotelDate(value: unknown): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

/** One normal selected hotel per plan + route/stay + recommendation group. */
export function hotelSelectionKey(
  planId: number,
  routeId: number,
  groupType: number,
  stayStartDate: unknown,
  normalHotelRowType = 'NORMAL',
): string {
  return [
    Number(planId || 0),
    Number(routeId || 0),
    Number(groupType || 0),
    normalizeHotelDate(stayStartDate),
    normalHotelRowType,
  ].join('|');
}

export function hotelSelectionKeyFromRow(planId: number, row: any): string {
  return hotelSelectionKey(
    planId,
    Number(row?.itinerary_route_id ?? row?.itineraryRouteId ?? 0),
    Number(row?.group_type ?? row?.groupType ?? 0),
    row?.itinerary_route_date ?? row?.itineraryRouteDate ?? row?.hotel_check_in_date ?? row?.date,
  );
}

export function isSpecialHotelPlanRow(row: any): boolean {
  return Number(row?.hotel_required ?? 0) === 2;
}

export function isProtectedHotelSelection(row: any): boolean {
  const bookingMode = clean(row?.hotel_booking_mode ?? row?.hotelBookingMode);
  const approvalStatus = clean(row?.hotel_approval_status ?? row?.hotelApprovalStatus);
  const confirmationStatus = clean(row?.manual_confirmation_status ?? row?.manualConfirmationStatus);
  return bookingMode === 'booked' || bookingMode === 'confirmed' ||
    approvalStatus === 'booked' || approvalStatus === 'confirmed' ||
    confirmationStatus === 'confirmed' || confirmationStatus === 'booked';
}

export function parseHotelSelectionSnapshot(row: any): HotelSelectionSnapshot {
  const raw = row?.selected_price_snapshot;
  if (raw && typeof raw === 'object') return raw as HotelSelectionSnapshot;
  if (raw) {
    try {
      const parsed = JSON.parse(String(raw));
      if (parsed && typeof parsed === 'object') return parsed as HotelSelectionSnapshot;
    } catch {
      // Legacy rows may contain a provider-specific payload; identity falls
      // back to the normalized selected columns below.
    }
  }
  return {};
}

export function selectionOriginFromRow(row: any): HotelSelectionOrigin {
  const snapshot = parseHotelSelectionSnapshot(row);
  if (snapshot.selectionOrigin === 'USER_SELECTED') return 'USER_SELECTED';
  return row?.hotel_provider === 'offline' ? 'USER_SELECTED' : 'AUTO_SELECTED';
}

export function hotelOptionKey(row: HotelOptionIdentity): string {
  return [
    row.provider,
    row.hotelCode || row.hotelId,
    row.roomId,
    row.rateId,
    row.rateOptionId,
    row.bookingCode,
    row.mealPlan,
    row.date || row.checkInDate,
    row.checkOutDate,
  ].map(clean).join('|');
}

export function selectedOptionKeyFromRow(row: any): string {
  const snapshot = parseHotelSelectionSnapshot(row);
  return clean(snapshot.optionKey || row?.selected_rate_option_id);
}

export function hotelPropertyMatchesSelection(selection: any, option: any): boolean {
  const snapshot = parseHotelSelectionSnapshot(selection);
  const selectedProvider = clean(selection?.hotel_provider || snapshot.provider);
  const optionProvider = clean(option?.provider || option?.hotel_provider);
  if (selectedProvider && optionProvider && selectedProvider !== optionProvider) return false;

  const selectedCanonicalId = clean(selection?.hotel_id || snapshot.hotelId);
  const optionCanonicalId = clean(option?.canonicalHotelId || option?.canonical_hotel_id || option?.hotelId || option?.hotel_id);
  if (selectedCanonicalId && optionCanonicalId && selectedCanonicalId === optionCanonicalId) return true;

  const selectedCode = clean(snapshot.hotelCode || selection?.hotel_code || selection?.hotel_id);
  const optionCode = clean(option?.hotelCode || option?.providerHotelCode || option?.hotel_code || option?.hotelId || option?.hotel_id);
  return Boolean(selectedCode && optionCode && selectedCode === optionCode);
}

export function hotelRateMatchesSelection(selection: any, option: any): boolean {
  if (!hotelPropertyMatchesSelection(selection, option)) return false;
  const snapshot = parseHotelSelectionSnapshot(selection);
  const selectedRoom = clean(snapshot.roomType || selection?.room_type);
  const optionRoom = clean(option?.roomType || option?.room_type || option?.roomTypeName);
  if (selectedRoom && optionRoom && selectedRoom !== optionRoom) return false;

  const selectedMeal = clean(snapshot.mealPlan || selection?.meal_plan);
  const optionMeal = clean(option?.mealPlan || option?.meal_plan);
  if (selectedMeal && optionMeal && selectedMeal !== optionMeal) return false;

  const selectedRoomId = clean(snapshot.roomId || selection?.room_id);
  const optionRoomId = clean(option?.roomId || option?.room_id);
  if (selectedRoomId && optionRoomId && selectedRoomId !== optionRoomId) return false;
  const selectedRateId = clean(snapshot.rateId || selection?.rate_id);
  const optionRateId = clean(option?.rateId || option?.rate_id);
  if (selectedRateId && optionRateId && selectedRateId !== optionRateId) return false;

  const selectedAmounts = [
    snapshot.totalPrice,
    snapshot.pricePerNight,
    selection?.selected_total_price,
    selection?.selected_price_per_night,
    selection?.total_hotel_cost,
  ].map(Number).filter((amount) => Number.isFinite(amount) && amount > 0);
  const optionAmounts = [
    option?.totalHotelCost,
    option?.total_hotel_cost,
    option?.totalPrice,
    option?.totalStayPrice,
    option?.pricePerNight,
    option?.price_per_night,
    option?.totalAmount,
  ].map(Number).filter((amount) => Number.isFinite(amount) && amount > 0);
  return selectedAmounts.length === 0 || optionAmounts.length === 0 || selectedAmounts.some((selectedAmount) =>
    optionAmounts.some((optionAmount) => Math.abs(selectedAmount - optionAmount) <= 0.009),
  );
}

export function optionMatchesSelection(selection: any, option: any): boolean {
  const snapshot = parseHotelSelectionSnapshot(selection);
  const expectedOptionKey = clean(snapshot.optionKey);
  const actualOptionKey = clean(option?.optionKey || hotelOptionKey(option));
  if (expectedOptionKey && expectedOptionKey === actualOptionKey) {
    return hotelRateMatchesSelection(selection, option);
  }

  const selectedRate = clean(snapshot.rateOptionId || selection?.selected_rate_option_id);
  const optionIds = [
    option?.rateOptionId,
    option?.rateId,
    option?.searchReference,
    option?.bookingCode,
  ].map(clean).filter(Boolean);
  if (selectedRate && optionIds.includes(selectedRate)) {
    return hotelRateMatchesSelection(selection, option);
  }

  return hotelRateMatchesSelection(selection, option);
}

export function hotelDisplaySnapshot(row: any): Record<string, unknown> {
  return {
    hotelName: row?.hotelName ?? row?.hotel_name ?? null,
    category: Number(row?.category ?? row?.hotel_category_id ?? 0) || null,
    provider: row?.provider ?? row?.hotel_provider ?? null,
    hotelCode: row?.hotelCode ?? row?.hotel_code ?? row?.hotelId ?? row?.hotel_id ?? null,
    roomType: row?.roomType ?? row?.room_type ?? null,
    mealPlan: row?.mealPlan ?? row?.meal_plan ?? null,
    totalPrice: Number(row?.totalPrice ?? row?.totalHotelCost ?? row?.total_hotel_cost ?? row?.selected_total_price ?? 0),
    pricePerNight: Number(row?.pricePerNight ?? row?.selected_price_per_night ?? 0),
    currency: row?.currency ?? row?.selected_currency ?? null,
    optionKey: (row?.optionKey ?? selectedOptionKeyFromRow(row)) || null,
    rateOptionId: row?.rateOptionId ?? row?.selected_rate_option_id ?? null,
    rateId: row?.rateId ?? row?.rate_id ?? null,
    bookingCode: row?.bookingCode ?? row?.booking_code ?? null,
    searchReference: row?.searchReference ?? row?.search_reference ?? null,
    searchRunId: row?.searchRunId ?? null,
    availabilityStatus: row?.availabilityStatus ?? null,
  };
}
