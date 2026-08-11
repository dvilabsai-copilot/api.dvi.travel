import { hotelCardPayableAmount } from './hotel-card-pricing.util';
import {
  isTboSupplierBookingCode,
  supplierSelectionKey,
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
  selectedPriceSnapshot: Record<string, unknown> | null;
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

const rowRouteIds = (row: any): number[] => Array.from(new Set([
  Number(row?.itineraryRouteId || row?.routeId || row?.itinerary_route_id || 0),
  ...(Array.isArray(row?.routeIds) ? row.routeIds.map(Number) : []),
].filter((routeId) => Number.isFinite(routeId) && routeId > 0)));

const isUnavailableSelection = (row: any): boolean =>
  String(row?.selectionStatus || row?.selection_status || '').trim().toUpperCase() === 'UNAVAILABLE';

const selectionPriority = (row: any): number => {
  if (isUnavailableSelection(row)) return 1;
  const origin = String(row?.selectionOrigin || row?.selection_origin || '').trim().toUpperCase();
  if (origin === 'USER_SELECTED') return 6;
  if (row?.isSelected === true) return 5;
  if (Number(row?.selectionId || row?.selection_id || 0) > 0) return 4;
  if (origin === 'AUTO_SELECTED') return 3;
  return 0;
};

const selectedView = (row: any): HotelSelectionSelectedView => {
  const snapshot = parseSnapshot(row?.selectedPriceSnapshot ?? row?.selected_price_snapshot);
  const identity = snapshot || {};
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
    identity.pricePerNight ?? identity.selectedPricePerNight ?? row?.pricePerNight ??
      row?.selectedPricePerNight ?? row?.selected_price_per_night ?? payable,
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
    hotelName: String(row?.hotelName ?? row?.hotel_name ?? identity.hotelName ?? '').trim() || null,
    roomType: String(row?.roomType ?? row?.roomTypeName ?? row?.room_type ?? identity.roomType ?? '').trim() || null,
    mealPlan: String(row?.mealPlan ?? row?.mealPlanCode ?? row?.meal_plan ?? identity.mealPlan ?? '').trim() || null,
    selectionKey: supplierSelectionKey({ ...row, ...identity }) || null,
    rateOptionId,
    supplierBookingCode,
    pricePerNight: money(Number.isFinite(pricePerNight) ? pricePerNight : 0),
    totalPrice: money(Number.isFinite(totalPrice) ? totalPrice : payable),
    selectedPriceSnapshot: snapshot,
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
        .sort((left, right) => selectionPriority(right) - selectionPriority(left));
      const selectedRow = candidates.find((row) => selectionPriority(row) >= 3 && !isUnavailableSelection(row));
      const unavailableRow = candidates.find(isUnavailableSelection);
      if (selectedRow) {
        return {
          ...requiredRoute,
          selectionStatus: 'SELECTED' as const,
          selected: selectedView(selectedRow),
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
    const rawTotal = tab.totalAmount ?? tab.partialTotal;
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
