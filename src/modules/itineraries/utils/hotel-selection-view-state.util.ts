import { hotelCardPayableAmount } from './hotel-card-pricing.util';
import { projectHotelPayablePricing } from './hotel-payable-pricing.util';
import {
  isTboSupplierBookingCode,
  normalizeHotelDisplayName,
  supplierSelectionKey,
  hasCommercialHotelIdentity,
} from './hotel-selection-identity.util';

export type HotelSelectionViewStatus = 'SELECTED' | 'UNRESOLVED' | 'UNAVAILABLE';

export type HotelSelectionSelectedView = {
  provider: string | null;
  canonicalHotelId: number | null;
  providerHotelCode: string | null;
  /** Legacy compatibility alias. Consumers must prefer providerHotelCode. */
  hotelCode: string | null;
  hotelName: string | null;
  roomType: string | null;
  mealPlan: string | null;
  selectionKey: string | null;
  rateOptionId: string | null;
  supplierBookingCode: string | null;
  pricePerNight: number;
  totalPrice: number;
  selectedPricePerNight?: number;
  selectedTotalPrice?: number;
  roomRate?: number;
  totalRoomCost?: number;
  hotelMarginBaseAmount?: number;
  hotelMarginPercentage?: number;
  hotelMarginAmount?: number;
  selectedPriceSnapshot: Record<string, unknown> | null;
  requestedCategory?: number;
  selectedCategory?: number;
  categoryFallbackApplied?: boolean;
  categoryFallbackReason?: string;
};

export type HotelSelectionRouteView = {
  routeId: number;
  routeDate: string;
  selectionStatus: HotelSelectionViewStatus;
  selected: HotelSelectionSelectedView | null;
};

export type HotelSelectionGroupView = {
  groupType: number;
  label: string;
  totalAmount: number | null;
  selectionStatus: HotelSelectionViewStatus;
  routes: HotelSelectionRouteView[];
};

type SelectionStateTab = {
  groupType?: number;
  label?: string;
  totalAmount?: number | null;
  partialTotal?: number | null;
};

type RequiredHotelRoute = {
  routeId?: number;
  itinerary_route_ID?: number;
  routeDate?: unknown;
  date?: unknown;
  itinerary_route_date?: unknown;
  hotelRequired?: boolean | number | null;
  hotel_required?: boolean | number | null;
  isDeparture?: boolean;
  isTransit?: boolean;
  isActivityOnly?: boolean;
};

/**
 * Resolve the itinerary routes that represent payable hotel nights. Semantic
 * exclusions are applied before the night-count cap so a transit/activity row
 * cannot displace a later genuine stay. Legacy route rows carry no semantic
 * flags, in which case the ordered first-N-night behaviour is preserved.
 */
export function resolveHotelRequiredRoutes<T extends RequiredHotelRoute>(
  routes: T[],
  noOfNights: number,
): T[] {
  const nightCount = Math.max(Math.trunc(Number(noOfNights) || 0), 0);
  if (nightCount === 0) return [];

  return (routes || [])
    .filter((route) =>
      route?.hotelRequired !== false &&
      route?.hotelRequired !== 0 &&
      route?.hotel_required !== false &&
      route?.hotel_required !== 0 &&
      !route?.isDeparture &&
      !route?.isTransit &&
      !route?.isActivityOnly,
    )
    .slice(0, nightCount);
}

const money = (value: unknown): number => Math.round(Number(value || 0) * 100) / 100;

const toDateOnly = (value: unknown): string => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const direct = raw.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (direct) return direct;
  const parsed = value instanceof Date ? value : new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  const businessDate = new Date(parsed.getTime() + 330 * 60 * 1000);
  return businessDate.toISOString().slice(0, 10);
};

const parseSnapshot = (value: unknown): Record<string, unknown> | null => {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

const rowRouteIds = (row: any): number[] => {
  const snapshot = parseSnapshot(
    row?.selectedPriceSnapshot ??
    row?.selected_price_snapshot ??
    row?.selection?.selectedPriceSnapshot ??
    row?.selection?.selected_price_snapshot,
  );
  return Array.from(new Set([
    Number(row?.itineraryRouteId || row?.routeId || row?.itinerary_route_id || 0),
    ...(Array.isArray(row?.routeIds) ? row.routeIds.map(Number) : []),
    ...(Array.isArray(row?.authoritativeRouteIds) ? row.authoritativeRouteIds.map(Number) : []),
    ...(Array.isArray(snapshot?.authoritativeRouteIds) ? snapshot.authoritativeRouteIds.map(Number) : []),
    // A continuous-stay availability row is anchored to its first route, but
    // completeStayRouteIds is the authoritative coverage for every night in
    // that same-city block. Include those routes when projecting selection
    // state; otherwise the last available night becomes UNRESOLVED even though
    // the database has a valid rate for it.
    ...(row?.completeStayBookable === true && Array.isArray(row?.completeStayRouteIds)
      ? row.completeStayRouteIds.map(Number)
      : []),
  ].filter((routeId) => Number.isFinite(routeId) && routeId > 0)));
};

const isUnavailableSelection = (row: any): boolean =>
  String(row?.selectionStatus || row?.selection_status || '').trim().toUpperCase() === 'UNAVAILABLE';

const selectionPriority = (row: any): number => {
  if (!hasCommercialHotelIdentity(row)) return 0;
  if (isUnavailableSelection(row)) return 1;
  const origin = String(row?.selectionOrigin || row?.selection_origin || '').trim().toUpperCase();
  if (origin === 'USER_SELECTED') return 6;
  if (row?.isSelected === true) return 5;
  if (Number(row?.selectionId || row?.selection_id || 0) > 0) return 4;
  if (origin === 'AUTO_SELECTED') return 3;
  return 0;
};

const selectedView = (row: any, routeDate = ''): HotelSelectionSelectedView => {
  let snapshot = parseSnapshot(
    row?.selectedPriceSnapshot ??
    row?.selected_price_snapshot ??
    row?.selection?.selectedPriceSnapshot ??
    row?.selection?.selected_price_snapshot,
  );
  const roomTypeBreakdown = Array.isArray(snapshot?.roomTypeBreakdown)
    ? snapshot.roomTypeBreakdown.filter((item: any) => item && typeof item === 'object')
    : [];
  const nestedSelection = row?.selection && typeof row.selection === 'object' ? row.selection : {};
  const nightlyRates = Array.isArray(row?.nightlyRates)
    ? row.nightlyRates
    : Array.isArray(snapshot?.nightlyRates)
      ? snapshot.nightlyRates
      : [];
  const routeNight = nightlyRates.find(
    (night: any) => String(night?.date || '').slice(0, 10) === String(routeDate || '').slice(0, 10),
  );
  const pricingScope = String(snapshot?.pricingScope || '').trim().toUpperCase();
  const isLegacyContinuousOfflineSnapshot =
    String(snapshot?.provider ?? row?.provider ?? '').trim().toLowerCase() === 'offline' &&
    pricingScope !== 'ROUTE_NIGHT' &&
    nightlyRates.length > 1;
  const logicalStayTotal = Number(nightlyRates.length > 1
    ? nightlyRates
        .map((night: any) => Number(night?.sellAmount ?? night?.totalAmount ?? night?.pricePerNight ?? night?.price ?? 0))
        .filter((amount: number) => Number.isFinite(amount) && amount > 0)
        .reduce((sum: number, amount: number) => sum + amount, 0)
        .toFixed(2)
    : 0);
  // A continuous stay is persisted once at its anchor route. Its nightlyRates
  // array is the authoritative price source for each covered route; never
  // expose the anchor night's base total on a later night.
  if (snapshot && routeNight && Number(routeNight.baseAmount || 0) > 0) {
    const roomCount = Math.max(Number(snapshot.roomCount ?? snapshot.totalRooms ?? row?.roomCount ?? row?.noOfRooms ?? 1), 1);
    const canonicalRoomRate = Number(routeNight.roomRate ?? snapshot.roomRate ?? 0);
    const canonicalRoomCost = Number(
      routeNight.totalRoomCost ??
      (isLegacyContinuousOfflineSnapshot ? routeNight.baseAmount : snapshot.totalRoomCost) ??
      0,
    );
    const roomRate = canonicalRoomRate > 0
      ? canonicalRoomRate
      : Number((Number(routeNight.baseAmount || 0) / roomCount).toFixed(2));
    const totalRoomCost = canonicalRoomCost > 0
      ? canonicalRoomCost
      : Number(routeNight.baseAmount || snapshot.baseTotalPrice || 0);
    const extraBedCount = Number(snapshot.extraBedCount ?? nestedSelection.extraBedCount ?? row?.extraBedCount ?? 0);
    const extraBedRate = Number(snapshot.extraBedRate ?? nestedSelection.extraBedRate ?? row?.extraBedRate ?? 0);
    const childWithBedCount = Number(snapshot.childWithBedCount ?? nestedSelection.childWithBedCount ?? row?.childWithBedCount ?? 0);
    const childWithBedRate = Number(snapshot.childWithBedRate ?? nestedSelection.childWithBedRate ?? row?.childWithBedRate ?? 0);
    const childWithoutBedCount = Number(snapshot.childWithoutBedCount ?? nestedSelection.childWithoutBedCount ?? row?.childWithoutBedCount ?? 0);
    const childWithoutBedRate = Number(snapshot.childWithoutBedRate ?? nestedSelection.childWithoutBedRate ?? row?.childWithoutBedRate ?? 0);
    const extraBedAmount = isLegacyContinuousOfflineSnapshot && extraBedRate > 0
      ? Number((extraBedRate * extraBedCount).toFixed(2))
      : Number(snapshot.extraBedAmount ?? nestedSelection.extraBedAmount ?? row?.extraBedAmount ?? 0);
    const childWithBedAmount = isLegacyContinuousOfflineSnapshot && childWithBedRate > 0
      ? Number((childWithBedRate * childWithBedCount).toFixed(2))
      : Number(snapshot.childWithBedAmount ?? nestedSelection.childWithBedAmount ?? row?.childWithBedAmount ?? 0);
    const childWithoutBedAmount = isLegacyContinuousOfflineSnapshot && childWithoutBedRate > 0
      ? Number((childWithoutBedRate * childWithoutBedCount).toFixed(2))
      : Number(snapshot.childWithoutBedAmount ?? nestedSelection.childWithoutBedAmount ?? row?.childWithoutBedAmount ?? 0);
    const supplementTotal = extraBedAmount + childWithBedAmount + childWithoutBedAmount;
    const marginPercentage = Number(snapshot.hotelMarginPercentage ?? row?.hotelMarginPercentage ?? routeNight.marginPercentage ?? 0);
    const marginBase = Number((totalRoomCost + supplementTotal).toFixed(2));
    const marginAmount = Number((marginBase * marginPercentage / 100).toFixed(2));
    const payableTotal = Number((marginBase + marginAmount).toFixed(2));
    snapshot = {
      ...snapshot,
      roomRate,
      roomCount,
      totalRoomCost,
      basePricePerNight: roomRate,
      baseTotalPrice: totalRoomCost,
      extraBedCount,
      extraBedRate,
      extraBedAmount,
      childWithBedCount,
      childWithBedRate,
      childWithBedAmount,
      childWithoutBedCount,
      childWithoutBedRate,
      childWithoutBedAmount,
      hotelMarginBaseAmount: marginBase,
      hotelMarginAmount: marginAmount,
      hotelMarginTotalAmount: marginAmount,
      pricePerNight: payableTotal,
      totalPrice: payableTotal,
      totalStayPrice: payableTotal,
      totalHotelCost: payableTotal,
      totalAmount: payableTotal,
      selectedPricePerNight: payableTotal,
      selectedTotalPrice: payableTotal,
    };
  }
  if (snapshot) {
    const positiveOrNested = (value: unknown, nested: unknown): number =>
      Number(value || 0) > 0 ? Number(value) : Number(nested || 0);
    const extraBedAmount = positiveOrNested(snapshot.extraBedAmount, nestedSelection.extraBedAmount);
    const childWithBedAmount = positiveOrNested(snapshot.childWithBedAmount, nestedSelection.childWithBedAmount);
    const childWithoutBedAmount = positiveOrNested(snapshot.childWithoutBedAmount, nestedSelection.childWithoutBedAmount);
    const supplementTotal = extraBedAmount + childWithBedAmount + childWithoutBedAmount;
    const baseTotal = Number(snapshot.baseTotalPrice ?? snapshot.baseHotelCost ?? 0);
    const marginAmount = Number(snapshot.hotelMarginAmount ?? snapshot.hotelMarginTotalAmount ?? 0);
    if (baseTotal > 0 && supplementTotal > 0) {
      const payableTotal = Number((baseTotal + supplementTotal + marginAmount).toFixed(2));
      snapshot = {
        ...snapshot,
        extraBedCount: positiveOrNested(snapshot.extraBedCount, nestedSelection.extraBedCount),
        extraBedAmount,
        childWithBedCount: positiveOrNested(snapshot.childWithBedCount, nestedSelection.childWithBedCount),
        childWithBedAmount,
        childWithoutBedCount: positiveOrNested(snapshot.childWithoutBedCount, nestedSelection.childWithoutBedCount),
        childWithoutBedAmount,
        hotelMarginBaseAmount: Number((baseTotal + supplementTotal).toFixed(2)),
        totalPrice: payableTotal,
        totalStayPrice: payableTotal,
        totalHotelCost: payableTotal,
        selectedTotalPrice: payableTotal,
        pricePerNight: payableTotal,
        selectedPricePerNight: payableTotal,
      };
    }
  }
  // Multi-room selections carry one pricing record per physical room. The
  // legacy parent fields can still contain the pre-edit aggregate, so rebuild
  // the public financial fields from the room breakdown before projecting the
  // snapshot. Single-room snapshots do not enter this branch.
  if (snapshot && roomTypeBreakdown.length > 0) {
    const sum = (key: string) => roomTypeBreakdown.reduce(
      (total: number, item: any) => total + Number(item?.[key] || 0),
      0,
    );
    const roomCost = Number(sum('roomCost').toFixed(2));
    const extraBedAmount = Number(sum('extraBedCost').toFixed(2));
    const childWithBedAmount = Number(sum('childWithBedCost').toFixed(2));
    const childWithoutBedAmount = Number(sum('childWithoutBedCost').toFixed(2));
    const baseTotal = Number((roomCost + extraBedAmount + childWithBedAmount + childWithoutBedAmount).toFixed(2));
    const marginPercentage = Number(snapshot.hotelMarginPercentage ?? row?.hotelMarginPercentage ?? row?.marginPercentage ?? 0);
    const marginAmount = Number((baseTotal * marginPercentage / 100).toFixed(2));
    const payableTotal = Number((baseTotal + marginAmount).toFixed(2));
    const roomCount = Math.max(Number(snapshot.roomCount ?? snapshot.totalRooms ?? row?.roomCount ?? row?.noOfRooms ?? roomTypeBreakdown.length), 1);
    const totalExtraBeds = sum('extraBedCount');
    const totalWithBed = sum('childWithBedCount');
    const totalWithoutBed = sum('childWithoutBedCount');
    snapshot = {
      ...snapshot,
      roomCount,
      totalRooms: roomCount,
      totalRoomCost: roomCost,
      baseTotalPrice: roomCost,
      roomRate: Number((roomCost / roomCount).toFixed(2)),
      extraBedCount: totalExtraBeds,
      extraBedAmount,
      childWithBedCount: totalWithBed,
      childWithBedAmount,
      childWithoutBedCount: totalWithoutBed,
      childWithoutBedAmount,
      hotelMarginBaseAmount: baseTotal,
      hotelMarginAmount: marginAmount,
      hotelMarginTotalAmount: marginAmount,
      totalPrice: payableTotal,
      totalStayPrice: payableTotal,
      totalHotelCost: payableTotal,
      totalAmount: payableTotal,
      selectedPricePerNight: payableTotal,
      selectedTotalPrice: payableTotal,
      pricePerNight: payableTotal,
      // The parent snapshot may still carry the legacy margin-inclusive
      // marker. Recalculate this multi-room aggregate from its breakdown.
      amountIncludesHotelMargin: false,
      pricingIncludesHotelMargin: false,
    };
  }
  // Persisted selection snapshots may predate the payable-price contract and
  // still contain the supplier/base amount. Project the snapshot itself
  // before exposing it through hotelSelectionState; otherwise the tabs use
  // payable totals while the table hydrates its authoritative selected row
  // from a stale raw snapshot.
  const identity: Record<string, any> = snapshot
    ? (() => {
        const projected: Record<string, any> = projectHotelPayablePricing(
          {
            ...snapshot,
            noOfRooms: Number(
              roomTypeBreakdown.length > 0
                ? 1
                : snapshot.noOfRooms ??
                  snapshot.total_no_of_rooms ??
                  snapshot.roomCount ??
                  row?.noOfRooms ??
                  row?.total_no_of_rooms ??
                  row?.roomCount ??
                  1,
            ),
            isSelected: true,
            selectionOrigin: row?.selectionOrigin ?? row?.selection_origin ?? snapshot.selectionOrigin,
          },
          Number(snapshot.hotelMarginPercentage ?? row?.hotelMarginPercentage ?? row?.marginPercentage ?? 0),
        );
        // Keep the public selected-view shape stable. Only replace pricing
        // fields in the existing snapshot; do not leak internal projection
        // markers or derived aliases into hotelSelectionState.
        return {
          ...snapshot,
          basePricePerNight: projected.basePricePerNight,
          baseTotalPrice: projected.baseTotalPrice,
          roomRate: roomTypeBreakdown.length > 0 ? snapshot.roomRate : projected.roomRate,
          totalRoomCost: projected.totalRoomCost,
          hotelMarginBaseAmount: projected.hotelMarginBaseAmount,
          hotelMarginPercentage: projected.hotelMarginPercentage,
          hotelMarginAmount: roomTypeBreakdown.length > 0
            ? projected.hotelMarginTotalAmount
            : projected.hotelMarginAmount,
          hotelMarginStayAmount: projected.hotelMarginStayAmount,
          hotelMarginTotalAmount: projected.hotelMarginTotalAmount,
          price: projected.price,
          pricePerNight: projected.pricePerNight,
          totalPrice: projected.totalPrice,
          totalStayPrice: projected.totalStayPrice,
          totalHotelCost: projected.totalHotelCost,
          totalAmount: projected.totalAmount,
          totalAmountAfterTax: projected.totalAmountAfterTax,
          selectedPricePerNight: projected.selectedPricePerNight,
          selectedTotalPrice: roomTypeBreakdown.length > 0
            ? projected.selectedTotalPrice
            : logicalStayTotal > 0
              ? logicalStayTotal
              : projected.selectedTotalPrice,
        };
      })()
    : {};
  const selectedPriceSnapshot = snapshot
    ? { ...identity, hotelName: normalizeHotelDisplayName(identity.hotelName) || null }
    : null;
  const roomSelections = Array.isArray(row?.roomSelections)
    ? row.roomSelections
    : Array.isArray(identity.roomSelections)
      ? identity.roomSelections
      : null;
  const providerHotelCode = String(
    row?.providerHotelCode ?? row?.provider_hotel_code ?? identity.providerHotelCode ?? '',
  ).trim() || null;
  const hotelCode = String(
    providerHotelCode ?? row?.hotelCode ?? row?.hotel_code ?? identity.hotelCode ?? '',
  ).trim() || null;
  const canonicalHotelId = Number(
    row?.canonicalHotelId ?? row?.canonical_hotel_id ?? row?.hotelId ?? row?.hotel_id ??
      identity.canonicalHotelId ?? identity.hotelId ?? 0,
  );
  const payable = hotelCardPayableAmount({ ...row, ...identity });
  const pricePerNight = Number(
    roomTypeBreakdown.length > 0
      ? snapshot?.selectedPricePerNight ?? snapshot?.pricePerNight ?? payable
      : row?.selectedPricePerNight ?? row?.selected_price_per_night ??
        row?.totalHotelCost ?? row?.total_hotel_cost ??
        identity.selectedPricePerNight ?? identity.pricePerNight ?? row?.pricePerNight ?? payable,
  );
  const totalPrice = Number(
    identity.totalPrice ?? identity.selectedTotalPrice ?? row?.totalPrice ??
      row?.selected_total_price ?? row?.totalHotelCost ?? row?.total_hotel_cost ?? payable,
  );
  const rateOptionId = String(
    row?.selectedRateOptionId ?? row?.selected_rate_option_id ?? row?.rateOptionId ??
      row?.optionKey ?? identity.rateOptionId ?? identity.optionKey ?? '',
  ).trim() || null;
  const provider = String(
    row?.provider ?? row?.hotel_provider ?? identity.provider ?? '',
  ).trim().toLowerCase() || null;
  const explicitSupplierBookingCode = String(
    row?.supplierBookingCode ?? row?.bookingCode ?? row?.searchReference ??
      identity.supplierBookingCode ?? identity.bookingCode ?? identity.searchReference ?? '',
  ).trim() || null;
  // A stable TBO rate identity is not a PreBook/Book credential. Only retain
  // the opaque supplier token when it has the documented !TB! token shape.
  const supplierBookingCode = provider === 'tbo'
    ? (isTboSupplierBookingCode(explicitSupplierBookingCode) ? explicitSupplierBookingCode : null)
    : explicitSupplierBookingCode;

  return {
    provider,
    canonicalHotelId: Number.isFinite(canonicalHotelId) && canonicalHotelId > 0 ? canonicalHotelId : null,
    providerHotelCode,
    hotelCode,
    hotelName: normalizeHotelDisplayName(
      row?.hotelName ?? row?.hotel_name ?? identity.hotelName,
    ) || null,
    roomType: String(row?.roomType ?? row?.roomTypeName ?? row?.room_type ?? identity.roomType ?? '').trim() || null,
    mealPlan: String(row?.mealPlan ?? row?.mealPlanCode ?? row?.meal_plan ?? identity.mealPlan ?? '').trim() || null,
    ...(roomSelections ? { roomSelections } : {}),
    selectionKey: supplierSelectionKey({ ...row, ...identity }) || null,
    rateOptionId,
    supplierBookingCode,
    pricePerNight: money(Number.isFinite(pricePerNight) ? pricePerNight : 0),
    totalPrice: money(Number.isFinite(totalPrice) ? totalPrice : payable),
    selectedPricePerNight: money(Number(pricePerNight || 0)),
    selectedTotalPrice: roomTypeBreakdown.length > 0
      ? money(Number(identity.selectedTotalPrice ?? totalPrice ?? 0))
      : logicalStayTotal > 0
        ? money(logicalStayTotal)
        : money(Number(identity.selectedTotalPrice ?? totalPrice ?? 0)),
    roomRate: money(Number(identity.roomRate ?? 0)),
    totalRoomCost: money(Number(identity.totalRoomCost ?? 0)),
    hotelMarginBaseAmount: money(Number(identity.hotelMarginBaseAmount ?? 0)),
    hotelMarginPercentage: money(Number(identity.hotelMarginPercentage ?? 0)),
    hotelMarginAmount: money(Number(identity.hotelMarginAmount ?? 0)),
    selectedPriceSnapshot,
    ...(Number(row?.requestedCategory ?? row?.requested_category ?? identity.requestedCategory ?? 0) > 0
      ? { requestedCategory: Number(row?.requestedCategory ?? row?.requested_category ?? identity.requestedCategory) }
      : {}),
    ...(Number(row?.selectedCategory ?? row?.selected_category ?? identity.selectedCategory ?? row?.category ?? identity.category ?? 0) > 0
      ? { selectedCategory: Number(row?.selectedCategory ?? row?.selected_category ?? identity.selectedCategory ?? row?.category ?? identity.category) }
      : {}),
    ...(row?.categoryFallbackApplied != null || row?.category_fallback_applied != null || identity.categoryFallbackApplied != null
      ? { categoryFallbackApplied: Boolean(row?.categoryFallbackApplied ?? row?.category_fallback_applied ?? identity.categoryFallbackApplied) }
      : {}),
    ...(String(row?.categoryFallbackReason ?? row?.category_fallback_reason ?? identity.categoryFallbackReason ?? '').trim()
      ? { categoryFallbackReason: String(row?.categoryFallbackReason ?? row?.category_fallback_reason ?? identity.categoryFallbackReason).trim() }
      : {}),
  };
};

/**
 * Assemble the committed hotel view without invoking supplier selection or a
 * recommendation algorithm. Tabs own package order/totals; required routes own
 * completeness; persisted/decorated rows own the exact selected identity.
 */
export function buildHotelSelectionState({
  tabs,
  rows,
  requiredRoutes,
}: {
  tabs: SelectionStateTab[];
  rows: any[];
  requiredRoutes: RequiredHotelRoute[];
}): HotelSelectionGroupView[] {
  const normalizedRequiredRoutes = (requiredRoutes || [])
    .map((route) => ({
      routeId: Number(route.routeId || route.itinerary_route_ID || 0),
      routeDate: toDateOnly(route.routeDate ?? route.date ?? route.itinerary_route_date),
    }))
    .filter((route) => route.routeId > 0)
    .filter((route, index, routes) => routes.findIndex((candidate) => candidate.routeId === route.routeId) === index);

  return (tabs || []).map((tab) => {
    const groupType = Number(tab.groupType || 0);
    const groupRows = (rows || []).filter((row) =>
      Number(row?.groupType || row?.group_type || 0) === groupType,
    );
    const fallbackRoutes = groupRows
      .flatMap((row) => rowRouteIds(row).map((routeId) => ({ routeId, routeDate: toDateOnly(
        row?.date ?? row?.checkInDate ?? row?.itineraryRouteDate ?? row?.itinerary_route_date,
      ) })))
      .filter((route, index, routes) => routes.findIndex((candidate) => candidate.routeId === route.routeId) === index);
    const routesToBuild = normalizedRequiredRoutes.length > 0 ? normalizedRequiredRoutes : fallbackRoutes;

    const routes: HotelSelectionRouteView[] = routesToBuild.map((requiredRoute) => {
      const candidates = groupRows
        .filter((row) => rowRouteIds(row).includes(requiredRoute.routeId))
        .sort((left, right) => {
          // A continuous-stay recommendation is materialized on its anchor
          // route and projected onto the linked nights. Prefer that
          // authoritative projection over an older route-local selection;
          // otherwise the second night can display a different room count or
          // room allocation even though it belongs to the same stay.
          const isAuthoritativeForRoute = (row: any): number => {
            if (row?.authoritativeRecommendation === true || row?.autoSelectionCandidate === true) return 1;
            const rawSnapshot = row?.selectedPriceSnapshot ?? row?.selected_price_snapshot;
            let snapshot: any = rawSnapshot;
            if (typeof rawSnapshot === 'string' && rawSnapshot.trim()) {
              try { snapshot = JSON.parse(rawSnapshot); } catch { snapshot = null; }
            }
            const routeIds = Array.isArray(snapshot?.authoritativeRouteIds)
              ? snapshot.authoritativeRouteIds.map(Number)
              : [];
            return routeIds.includes(requiredRoute.routeId) ? 1 : 0;
          };
          const leftAuthoritative = isAuthoritativeForRoute(left);
          const rightAuthoritative = isAuthoritativeForRoute(right);
          // Continuous-stay rows advertise every covered route through
          // completeStayRouteIds, but their pricing snapshot belongs to the
          // anchor night. When a route-specific persisted row exists, it must
          // win for that night so date-specific rates are not copied from the
          // first night. Keep the continuous-stay row as the fallback when no
          // exact route row is available.
          const leftRouteId = Number(left?.itineraryRouteId || left?.routeId || left?.itinerary_route_id || 0);
          const rightRouteId = Number(right?.itineraryRouteId || right?.routeId || right?.itinerary_route_id || 0);
          const leftExact = leftRouteId === requiredRoute.routeId ? 1 : 0;
          const rightExact = rightRouteId === requiredRoute.routeId ? 1 : 0;
          return rightAuthoritative - leftAuthoritative ||
            rightExact - leftExact ||
            selectionPriority(right) - selectionPriority(left);
        });
      const selectedRow = candidates.find((row) => selectionPriority(row) >= 3 && !isUnavailableSelection(row));
      const unavailableRow = candidates.find(isUnavailableSelection);
      if (selectedRow) {
        return {
          ...requiredRoute,
          selectionStatus: 'SELECTED' as const,
          selected: selectedView(selectedRow, requiredRoute.routeDate),
        };
      }
      if (unavailableRow) {
        return {
          ...requiredRoute,
          selectionStatus: 'UNAVAILABLE' as const,
          selected: null,
        };
      }
      return {
        ...requiredRoute,
        selectionStatus: 'UNRESOLVED' as const,
        selected: null,
      };
    });
    const statuses = routes.map((route) => route.selectionStatus);
    const selectionStatus: HotelSelectionViewStatus = statuses.length > 0 && statuses.every((status) => status === 'SELECTED')
      ? 'SELECTED'
      : statuses.length > 0 && statuses.every((status) => status === 'UNAVAILABLE')
        ? 'UNAVAILABLE'
        : 'UNRESOLVED';
    // A persisted tab total can belong to an older recommendation package.
    // Rebuild the amount from the currently selected commercial identity when
    // route selections are present. A continuous stay repeats the same
    // selection on each night, so count each selection key only once.
    const selectedTotalByIdentity = new Map<string, number>();
    routes.forEach((route) => {
      if (!route.selected || !Number((route.selected as any).selectedTotalPrice ?? route.selected.totalPrice ?? 0)) return;
      const selected = route.selected;
      const key = String(
        selected.selectionKey || selected.rateOptionId ||
        `${selected.provider || ''}|${selected.hotelCode || ''}|${selected.roomType || ''}|${selected.mealPlan || ''}`,
      ).trim();
      if (!selectedTotalByIdentity.has(key)) {
        selectedTotalByIdentity.set(key, money(Number((selected as any).selectedTotalPrice ?? selected.totalPrice)));
      }
    });
    const selectedTotal = Array.from(selectedTotalByIdentity.values())
      .reduce((sum, amount) => sum + amount, 0);
    const rawTotal = selectedTotal > 0 ? selectedTotal : tab.totalAmount ?? tab.partialTotal;
    const totalAmount = rawTotal == null || !Number.isFinite(Number(rawTotal)) ? null : money(rawTotal);

    return {
      groupType,
      label: String(tab.label || `Recommended #${groupType}`),
      totalAmount,
      selectionStatus,
      routes,
    };
  });
}

/** Keep package totals aligned with the server-authoritative selected state. */
export function synchronizeHotelTabTotals<T extends SelectionStateTab>(
  tabs: T[],
  selectionState: HotelSelectionGroupView[],
): T[] {
  return (tabs || []).map((tab) => {
    const group = (selectionState || []).find(
      (candidate) => Number(candidate.groupType) === Number(tab.groupType),
    );
    const authoritativeTotal = Number(group?.totalAmount ?? 0);
    if (!group || !Number.isFinite(authoritativeTotal) || authoritativeTotal <= 0) {
      return tab;
    }
    return {
      ...tab,
      totalAmount: money(authoritativeTotal),
      ...(tab.partialTotal == null ? {} : { partialTotal: money(authoritativeTotal) }),
    };
  });
}
