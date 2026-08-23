import {
  inferCanonicalHotelRatePlanCode,
  inferCanonicalHotelRatePlanCodeFromMealText,
} from '../../hotels/hotel-rate-plans';

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
  canonicalHotelId?: string | number;
  providerHotelCode?: string | number;
  selectionKey?: string;
  hotelName?: string;
  category?: string | number;
  roomType?: string;
  mealPlan?: string;
  roomId?: string | number;
  totalPrice?: number;
  pricePerNight?: number;
  searchRunId?: string;
  selectionOrigin?: HotelSelectionOrigin;
  availabilityStatus?: string;
  authoritativeRecommendation?: boolean;
  autoSelectionCandidate?: boolean;
  autoSelectionIdentity?: Record<string, unknown> | null;
  autoSelectionFallbackFromGroup?: number;
  authoritativeStayKey?: string;
  authoritativeParentRouteId?: number;
  authoritativeRouteIds?: number[];
  authoritativeCheckInDate?: string;
  authoritativeCheckOutDate?: string;
};

export type PersistedHotelIdentity = {
  provider: string;
  hotelId: number;
  hotelCode: string;
  hotelName: string;
  category: number;
  consistent: boolean;
  mismatches: string[];
  snapshot: HotelSelectionSnapshot;
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

/** Rate-level identity for an authoritative automatic recommendation. */
export function buildAutoSelectionIdentity(row: any): Record<string, unknown> {
  return {
    provider: clean(row?.provider || row?.hotel_provider),
    canonicalHotelId: Number(row?.canonicalHotelId || row?.canonical_hotel_id || row?.hotelId || row?.hotel_id || 0) || null,
    providerHotelCode: String(row?.providerHotelCode || row?.provider_hotel_code || row?.hotelCode || row?.hotel_code || '').trim(),
    rateOptionId: String(row?.rateOptionId || row?.rate_option_id || row?.optionKey || '').trim(),
    searchReference: String(row?.searchReference || row?.search_reference || '').trim(),
    bookingCode: String(row?.bookingCode || row?.booking_code || '').trim(),
    roomId: String(row?.roomId || row?.room_id || '').trim(),
    roomTypeId: String(row?.roomTypeId || row?.room_type_id || '').trim(),
    roomType: String(row?.roomType || row?.room_type || row?.roomTypeName || '').trim(),
    rateId: String(row?.rateId || row?.rate_id || '').trim(),
    mealPlan: String(row?.mealPlan || row?.meal_plan || row?.mealPlanCode || '').trim().toUpperCase(),
  };
}

/** Match the complete authoritative rate identity; absent legacy fields are wildcards. */
export function autoSelectionIdentityMatches(option: any, identity: any): boolean {
  if (!identity || typeof identity !== 'object') return false;
  const actual = buildAutoSelectionIdentity(option);
  const checks: Array<[unknown, unknown]> = [
    [actual.provider, identity.provider],
    [actual.canonicalHotelId, identity.canonicalHotelId],
    [actual.providerHotelCode, identity.providerHotelCode],
    [actual.rateOptionId, identity.rateOptionId],
    [actual.searchReference, identity.searchReference],
    [actual.bookingCode, identity.bookingCode],
    [actual.roomId, identity.roomId],
    [actual.roomTypeId, identity.roomTypeId],
    [actual.roomType, identity.roomType],
    [actual.rateId, identity.rateId],
    [actual.mealPlan, identity.mealPlan],
  ];
  return checks.every(([actualValue, expectedValue]) => {
    const expected = clean(expectedValue);
    return !expected || clean(actualValue) === expected;
  });
}

/**
 * Fresh recommendation matching. Missing expected fields are not allowed to
 * turn a property-level identity into an arbitrary room/rate match. A rate
 * discriminator must exist, unless both sides genuinely expose no rate-level
 * fields at all (the provider's single-option/property-only case).
 */
export function strictAutoSelectionIdentityMatches(option: any, identity: any): boolean {
  if (!identity || typeof identity !== 'object') return false;
  const actual = buildAutoSelectionIdentity(option);
  const propertyChecks: Array<[unknown, unknown]> = [
    [actual.provider, identity.provider],
    [actual.canonicalHotelId, identity.canonicalHotelId],
    [actual.providerHotelCode, identity.providerHotelCode],
  ];
  if (!propertyChecks.every(([actualValue, expectedValue]) => {
    const expected = clean(expectedValue);
    return !expected || clean(actualValue) === expected;
  })) return false;

  const rateFields = [
    'rateOptionId', 'searchReference', 'bookingCode', 'roomId',
    'roomTypeId', 'roomType', 'rateId', 'mealPlan',
  ] as const;
  const expectedRateFields = rateFields.filter((field) => clean(identity[field]));
  if (expectedRateFields.length === 0) {
    return rateFields.every((field) => !clean(actual[field]));
  }
  return expectedRateFields.every((field) => clean(actual[field]) === clean(identity[field]));
}

export function normalizeHotelDisplayName(value: unknown): string {
  return String(value ?? '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isTboSupplierBookingCode(value: unknown): boolean {
  return String(value || '').trim().includes('!TB!');
}

/**
 * Stable commercial identity for a supplier option. TBO BookingCode contains
 * a search-session UUID, so only the supplier hotel and room-option segment
 * are used for matching a refreshed Search result. The opaque full token is
 * still retained separately for PreBook/Book.
 */
export function supplierSelectionKey(row: any): string {
  const explicit = String(row?.selectionKey || '').trim();
  if (explicit) return explicit;
  const provider = clean(row?.provider || row?.hotel_provider);
  if (provider === 'tbo') {
    const token = [row?.bookingCode, row?.searchReference, row?.rateOptionId, row?.rate_option_id]
      .map((value) => String(value || '').trim())
      .find(isTboSupplierBookingCode) || '';
    const parts = token.split('!TB!');
    if (parts.length >= 2 && parts[0] && parts[1]) return `tbo:${parts[0]}:${parts[1]}`;
  }
  const providerCode = String(row?.providerHotelCode || row?.provider_hotel_code || row?.hotelCode || '').trim();
  const room = String(row?.roomTypeId || row?.roomId || row?.roomType || row?.roomTypeName || '').trim();
  const meal = String(row?.mealPlanCode || row?.mealPlan || '').trim();
  const rate = String(row?.rateId || row?.rateOptionId || '').trim();
  return providerCode || room || meal || rate ? `${provider}:${providerCode}:${room}:${meal}:${rate}` : '';
}

export function normalizeSupplierRateIdentity<T extends Record<string, any>>(row: T): T {
  const provider = clean(row?.provider || row?.hotel_provider);
  const inferredMealPlan = [
    row?.mealPlan,
    row?.meal_plan,
    row?.mealPlanCode,
    row?.ratePlanName,
    row?.rateOptionId,
    row?.rate_option_id,
    row?.rateId,
    row?.bookingCode,
    row?.searchReference,
    row?.optionKey,
  ].map((value) =>
    inferCanonicalHotelRatePlanCode(String(value || '')) ||
    inferCanonicalHotelRatePlanCodeFromMealText(String(value || '')),
  ).find(Boolean) || null;
  const explicitMealPlan = String(row?.mealPlan || row?.meal_plan || row?.mealPlanCode || '').trim();
  const mealPlan = explicitMealPlan && explicitMealPlan !== '-'
    ? explicitMealPlan
    : inferredMealPlan;

  if (provider !== 'tbo') {
    return {
      ...row,
      ...(mealPlan ? { mealPlan, mealPlanCode: mealPlan } : {}),
    };
  }

  const supplierBookingCode = [row?.bookingCode, row?.searchReference]
    .map((value) => String(value || '').trim())
    .find(isTboSupplierBookingCode);
  const rateOptionId = supplierBookingCode || String(row?.rateOptionId || row?.rate_option_id || '').trim() || undefined;

  return {
    ...row,
    ...(mealPlan ? { mealPlan, mealPlanCode: mealPlan } : {}),
    rateOptionId,
    bookingCode: supplierBookingCode || undefined,
    searchReference: supplierBookingCode || String(row?.searchReference || '').trim() || undefined,
  };
}

export function supplierRateIdentityMatches(requestedRow: any, candidateRow: any): boolean {
  const requested = normalizeSupplierRateIdentity(requestedRow || {});
  const candidate = normalizeSupplierRateIdentity(candidateRow || {});
  const provider = clean(requested.provider || requested.hotel_provider);
  if (provider && clean(candidate.provider || candidate.hotel_provider) !== provider) return false;

  if (provider === 'tbo') {
    const requestedBookingCode = [requested.rateOptionId, requested.bookingCode, requested.searchReference]
      .map((value) => String(value || '').trim())
      .find(isTboSupplierBookingCode);
    const candidateRateTokens = [candidate.rateOptionId, candidate.bookingCode, candidate.searchReference]
      .map((value) => String(value || '').trim())
      .filter(isTboSupplierBookingCode);

    // A TBO selectionKey intentionally omits the search-session UUID. It is
    // useful as a fallback, but it must never override an exact booking-code
    // match or match a different session's zero/parent row.
    if (requestedBookingCode) {
      return candidateRateTokens.includes(requestedBookingCode);
    }
    const requestedSelectionKey = supplierSelectionKey(requested);
    const candidateSelectionKey = supplierSelectionKey(candidate);
    if (requestedSelectionKey && candidateSelectionKey) return requestedSelectionKey === candidateSelectionKey;
    if (!requestedBookingCode) return false;
    return [candidate.rateOptionId, candidate.bookingCode, candidate.searchReference]
      .map((value) => String(value || '').trim())
      .includes(requestedBookingCode);
  }

  const requestedPrimary = String(requested.rateOptionId || requested.optionKey || '').trim();
  const candidateIds = [candidate.rateOptionId, candidate.optionKey, candidate.searchReference, candidate.bookingCode]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (requestedPrimary) return candidateIds.includes(requestedPrimary);

  const requestedBookingIdentity = [requested.searchReference, requested.bookingCode]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return requestedBookingIdentity.length > 0 &&
    requestedBookingIdentity.every((value) => candidateIds.includes(value));
}

const normalizeMealIdentity = (value: unknown): string => {
  const normalized = clean(value)
    .replace(/[^a-z]/g, '');
  if (!normalized) return '';
  if (['cp', 'continentalplan', 'breakfast'].includes(normalized)) return 'cp';
  if (['ep', 'europeanplan', 'roomonly'].includes(normalized)) return 'ep';
  if (['map', 'modifiedamericanplan'].includes(normalized)) return 'map';
  if (['ap', 'americanplan', 'fullboard'].includes(normalized)) return 'ap';
  return normalized;
};

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

/**
 * Reconstruct a persisted offline property only when the selected columns,
 * rate identifier, snapshot, and dvi_hotel master all describe the same hotel.
 * Missing fields are allowed for legacy snapshots; contradictory fields are
 * never allowed to override the canonical master identity.
 */
export function resolvePersistedHotelIdentity(row: any, master: any): PersistedHotelIdentity {
  const snapshot = parseHotelSelectionSnapshot(row);
  const provider = clean(row?.hotel_provider || snapshot.provider);
  const hotelId = Number(row?.hotel_id || 0);
  const hotelCode = String(row?.hotel_code || hotelId || '').trim();
  const masterId = Number(master?.hotel_id || 0);
  const masterName = normalizeHotelDisplayName(master?.hotel_name);
  const masterCategory = Number(master?.hotel_category || 0);
  const mismatches: string[] = [];

  if (provider === 'offline') {
    if (!hotelId || !masterId || hotelId !== masterId) mismatches.push('masterHotelId');

    const snapshotId = Number(snapshot.canonicalHotelId || snapshot.hotelId || 0);
    if (snapshotId && snapshotId !== hotelId) mismatches.push('snapshotHotelId');

    const snapshotProvider = clean(snapshot.provider);
    if (snapshotProvider && snapshotProvider !== provider) mismatches.push('snapshotProvider');

    const snapshotCode = clean(snapshot.hotelCode || snapshot.providerHotelCode);
    if (snapshotCode && snapshotCode !== clean(hotelCode)) mismatches.push('snapshotHotelCode');

    const rateOptionId = String(row?.selected_rate_option_id || snapshot.rateOptionId || '').trim();
    const rateParts = rateOptionId.split(':');
    if (rateOptionId && (rateParts[0] !== 'offline' || Number(rateParts[1] || 0) !== hotelId)) {
      mismatches.push('rateOptionHotelId');
    }

    const snapshotName = normalizeHotelDisplayName(snapshot.hotelName);
    if (snapshotName && masterName && clean(snapshotName) !== clean(masterName)) mismatches.push('snapshotHotelName');

    const snapshotCategory = Number(snapshot.category || 0);
    if (snapshotCategory && masterCategory && snapshotCategory !== masterCategory) mismatches.push('snapshotCategory');
  }

  return {
    provider,
    hotelId,
    hotelCode,
    hotelName: masterName,
    category: masterCategory,
    consistent: mismatches.length === 0,
    mismatches,
    snapshot,
  };
}

export function selectionOriginFromRow(row: any): HotelSelectionOrigin {
  const snapshot = parseHotelSelectionSnapshot(row);
  if (snapshot.selectionOrigin === 'USER_SELECTED') return 'USER_SELECTED';
  if (snapshot.selectionOrigin === 'AUTO_SELECTED') return 'AUTO_SELECTED';
  // Legacy offline rows predate explicit origin metadata and represented
  // manual choices. Preserve that compatibility only when the snapshot does
  // not state that the API created the selection.
  if (String(row?.hotel_provider || '').trim().toLowerCase() === 'offline') {
    const bookingMode = String(row?.hotel_booking_mode || '').trim().toUpperCase();
    const priceSource = String(row?.price_source || '').trim().toUpperCase();
    if (bookingMode === 'OFFLINE_MANUAL' || priceSource === 'OFFLINE_DB') return 'AUTO_SELECTED';
    return 'USER_SELECTED';
  }
  return 'AUTO_SELECTED';
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

  const selectedCode = clean(
    snapshot.providerHotelCode || selection?.providerHotelCode || selection?.provider_hotel_code ||
    snapshot.hotelCode || selection?.hotel_code || selection?.hotel_id,
  );
  const optionCode = clean(
    option?.providerHotelCode || option?.provider_hotel_code || option?.hotelCode ||
    option?.hotel_code || option?.hotelId || option?.hotel_id,
  );
  return Boolean(selectedCode && optionCode && selectedCode === optionCode);
}

export function hotelRateMatchesSelection(selection: any, option: any): boolean {
  if (!hotelPropertyMatchesSelection(selection, option)) return false;
  const snapshot = parseHotelSelectionSnapshot(selection);
  const selectedRoom = clean(snapshot.roomType || selection?.room_type);
  const optionRoom = clean(option?.roomType || option?.room_type || option?.roomTypeName);
  if (selectedRoom && optionRoom && selectedRoom !== optionRoom) return false;

  const selectedMeal = clean(snapshot.mealPlan || selection?.meal_plan);
  const optionMeal = normalizeMealIdentity(option?.mealPlan || option?.meal_plan);
  const normalizedSelectedMeal = normalizeMealIdentity(selectedMeal);
  if (normalizedSelectedMeal && optionMeal && normalizedSelectedMeal !== optionMeal) return false;

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
  // A persisted supplier rate ID is the strongest identity. Do this before
  // optionKey/room/meal/price comparison: those fields can be stale after a
  // reset, while the nested rate option ID identifies the exact fresh rate.
  const selectedRate = clean(selection?.selected_rate_option_id || snapshot.rateOptionId);
  const optionIds = [
    option?.rateOptionId,
    option?.rate_option_id,
    option?.rateId,
    option?.searchReference,
    option?.bookingCode,
  ].map(clean).filter(Boolean);
  if (selectedRate && optionIds.includes(selectedRate)) {
    return hotelPropertyMatchesSelection(selection, option);
  }

  const expectedOptionKey = clean(snapshot.optionKey);
  const actualOptionKey = clean(option?.optionKey || hotelOptionKey(option));
  if (expectedOptionKey && expectedOptionKey === actualOptionKey) {
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
    canonicalHotelId: row?.canonicalHotelId ?? row?.canonical_hotel_id ?? row?.hotelId ?? row?.hotel_id ?? null,
    providerHotelCode: row?.providerHotelCode ?? row?.provider_hotel_code ?? null,
    selectionKey: supplierSelectionKey(row) || null,
    roomType: row?.roomType ?? row?.room_type ?? null,
    mealPlan: row?.mealPlan ?? row?.meal_plan ?? null,
    totalPrice: Number(row?.totalPrice ?? row?.totalStayPrice ?? row?.totalHotelCost ?? row?.total_hotel_cost ?? row?.totalAmount ?? row?.selected_total_price ?? 0),
    pricePerNight: Number(row?.pricePerNight ?? row?.price_per_night ?? row?.price ?? row?.selected_price_per_night ?? 0),
    baseTotalPrice: Number(row?.baseTotalPrice ?? row?.base_total_price ?? row?.baseHotelCost ?? row?.base_hotel_cost ?? 0),
    extraBedCount: Number(row?.extraBedCount ?? row?.extra_bed_count ?? 0),
    extraBedRate: Number(row?.extraBedRate ?? row?.extra_bed_rate ?? 0),
    extraBedAmount: Number(row?.extraBedAmount ?? row?.extra_bed_amount ?? row?.extraBedCost ?? row?.total_extra_bed_cost ?? 0),
    childWithBedCount: Number(row?.childWithBedCount ?? row?.child_with_bed_count ?? 0),
    childWithBedRate: Number(row?.childWithBedRate ?? row?.child_with_bed_rate ?? 0),
    childWithBedAmount: Number(row?.childWithBedAmount ?? row?.child_with_bed_amount ?? row?.childWithBedCost ?? row?.total_childwith_bed_cost ?? 0),
    childWithoutBedCount: Number(row?.childWithoutBedCount ?? row?.child_without_bed_count ?? 0),
    childWithoutBedRate: Number(row?.childWithoutBedRate ?? row?.child_without_bed_rate ?? 0),
    childWithoutBedAmount: Number(row?.childWithoutBedAmount ?? row?.child_without_bed_amount ?? row?.childWithoutBedCost ?? row?.total_childwithout_bed_cost ?? 0),
    hotelMarginBaseAmount: Number(row?.hotelMarginBaseAmount ?? row?.hotel_margin_base_amount ?? 0),
    hotelMarginPercentage: Number(row?.hotelMarginPercentage ?? row?.hotel_margin_percentage ?? 0),
    hotelMarginAmount: Number(row?.hotelMarginAmount ?? row?.hotel_margin_amount ?? row?.hotel_margin_rate ?? 0),
    currency: row?.currency ?? row?.selected_currency ?? null,
    optionKey: (row?.optionKey ?? selectedOptionKeyFromRow(row)) || null,
    rateOptionId: row?.rateOptionId ?? row?.selected_rate_option_id ?? null,
    rateId: row?.rateId ?? row?.rate_id ?? null,
    bookingCode: row?.bookingCode ?? row?.booking_code ?? null,
    searchReference: row?.searchReference ?? row?.search_reference ?? null,
    searchRunId: row?.searchRunId ?? null,
    availabilityStatus: row?.availabilityStatus ?? null,
    requestedCategory: Number(row?.requestedCategory ?? row?.requested_category ?? 0) || null,
    selectedCategory: Number(row?.selectedCategory ?? row?.selected_category ?? row?.category ?? 0) || null,
    categoryFallbackApplied: row?.categoryFallbackApplied ?? row?.category_fallback_applied ?? false,
    categoryFallbackReason: row?.categoryFallbackReason ?? row?.category_fallback_reason ?? null,
  };
}
