export type RouteHotspotOperatingStatus = {
  routeDate: Date | null;
  routeDayOfWeek: number | null;
  routeDayLabel: string | null;
  operatingHours: string | null;
  isClosedOnRouteDate: boolean;
  closedDays: string[];
  closedDaysLabel: string | null;
};

const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HOTSPOT_DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export const getClosedDays = (timingRows: any[]): string[] => {
  const rowsByDay = new Map<number, any[]>();
  for (const row of timingRows || []) {
    const day = Number(row?.hotspot_timing_day);
    if (!Number.isInteger(day) || day < 0 || day > 6) continue;
    const rows = rowsByDay.get(day) || [];
    rows.push(row);
    rowsByDay.set(day, rows);
  }

  return HOTSPOT_DAY_LABELS.filter((_, day) => {
    const rows = rowsByDay.get(day) || [];
    return rows.length > 0 && rows.every((row: any) => Number(row?.hotspot_closed || 0) === 1);
  });
};

export const formatClosedDaysLabel = (closedDays: string[]): string | null => {
  if (closedDays.length === 0) return null;
  return closedDays.length === 7 ? 'all days' : closedDays.join(', ');
};

const formatTime = (value: Date | string | null | undefined): string => {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';

  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hours12 = hours % 12 || 12;
  return `${String(hours12).padStart(2, '0')}:${String(minutes).padStart(2, '0')} ${suffix}`;
};

/**
 * hotspot_timing_day uses Monday=0 ... Sunday=6, matching the existing
 * manual-fit operating-hours service and hotspot engine.
 */
export async function getRouteHotspotOperatingStatus(
  prismaOrTransaction: any,
  planId: number,
  routeId: number,
  hotspotId: number,
): Promise<RouteHotspotOperatingStatus> {
  const route = await prismaOrTransaction.dvi_itinerary_route_details.findFirst({
    where: {
      itinerary_plan_ID: Number(planId),
      itinerary_route_ID: Number(routeId),
      deleted: 0,
    },
    select: { itinerary_route_date: true },
  });

  const routeDate = route?.itinerary_route_date ? new Date(route.itinerary_route_date) : null;
  if (!routeDate || !Number.isFinite(routeDate.getTime())) {
    return {
      routeDate: null,
      routeDayOfWeek: null,
      routeDayLabel: null,
      operatingHours: null,
      isClosedOnRouteDate: false,
      closedDays: [],
      closedDaysLabel: null,
    };
  }

  const routeDayOfWeek = (routeDate.getDay() + 6) % 7;
  const routeDayLabel = DAY_LABELS[routeDate.getDay()] || null;
  const timingRows = await prismaOrTransaction.dvi_hotspot_timing.findMany({
    where: {
      hotspot_ID: Number(hotspotId),
      status: 1,
      deleted: 0,
    },
    orderBy: [
      { hotspot_start_time: 'asc' },
      { hotspot_timing_ID: 'asc' },
    ],
  });

  const allTimingRows = Array.isArray(timingRows) ? timingRows : [];
  const closedDays = getClosedDays(allTimingRows);
  const closedDaysLabel = formatClosedDaysLabel(closedDays);
  const dayTimings = allTimingRows.filter((row: any) => Number(row?.hotspot_timing_day) === routeDayOfWeek);
  const openTimings = dayTimings.filter((row: any) => Number(row?.hotspot_closed || 0) !== 1);

  if (dayTimings.length > 0 && openTimings.length === 0) {
    return {
      routeDate,
      routeDayOfWeek,
      routeDayLabel,
      operatingHours: 'Closed',
      isClosedOnRouteDate: true,
      closedDays,
      closedDaysLabel,
    };
  }

  if (openTimings.length === 0) {
    return {
      routeDate,
      routeDayOfWeek,
      routeDayLabel,
      operatingHours: null,
      isClosedOnRouteDate: false,
      closedDays,
      closedDaysLabel,
    };
  }

  if (openTimings.some((row: any) => Number(row?.hotspot_open_all_time || 0) === 1)) {
    return {
      routeDate,
      routeDayOfWeek,
      routeDayLabel,
      operatingHours: 'Open 24 Hours',
      isClosedOnRouteDate: false,
      closedDays,
      closedDaysLabel,
    };
  }

  const windows = openTimings
    .map((row: any) => {
      const start = formatTime(row?.hotspot_start_time);
      const end = formatTime(row?.hotspot_end_time);
      return start && end ? `${start} - ${end}` : '';
    })
    .filter(Boolean);

  return {
    routeDate,
    routeDayOfWeek,
    routeDayLabel,
    operatingHours: windows.length > 0 ? Array.from(new Set(windows)).join(', ') : null,
    isClosedOnRouteDate: false,
    closedDays,
    closedDaysLabel,
  };
}
