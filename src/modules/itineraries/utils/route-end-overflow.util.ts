type CalculateRouteEndOverflowParams = {
  timeline: any[];
  routeStartTime: any;
  routeEndTime: any;
  parseTimeToMinutes: (value: any) => number | null;
  parseSegmentStartMinutes: (segment: any) => number | null;
  parseSegmentEndMinutes: (segment: any) => number | null;
};

const MINUTES_PER_DAY = 24 * 60;
const HALF_DAY_MINUTES = 12 * 60;

export function calculateRouteEndOverflowMinutes({
  timeline,
  routeStartTime,
  routeEndTime,
  parseTimeToMinutes,
  parseSegmentStartMinutes,
  parseSegmentEndMinutes,
}: CalculateRouteEndOverflowParams): number {
  const routeStartMinutes = parseTimeToMinutes(routeStartTime) ?? 0;
  const routeEndMinutes = parseTimeToMinutes(routeEndTime) ?? routeStartMinutes;
  const routeEndAbsoluteMinutes = routeEndMinutes < routeStartMinutes
    ? routeEndMinutes + MINUTES_PER_DAY
    : routeEndMinutes;

  let dayOffset = 0;
  let previousStartAbsoluteMinutes: number | null = null;
  let maxEndAbsoluteMinutes = routeStartMinutes;

  for (const segment of Array.isArray(timeline) ? timeline : []) {
    const startMinutes = parseSegmentStartMinutes(segment);
    const endMinutes = parseSegmentEndMinutes(segment);
    if (startMinutes === null && endMinutes === null) continue;

    let startAbsoluteMinutes = startMinutes === null
      ? (previousStartAbsoluteMinutes ?? routeStartMinutes) + dayOffset
      : startMinutes + dayOffset;

    if (
      startMinutes !== null
      && previousStartAbsoluteMinutes !== null
      && startAbsoluteMinutes < previousStartAbsoluteMinutes - HALF_DAY_MINUTES
    ) {
      dayOffset += MINUTES_PER_DAY;
      startAbsoluteMinutes += MINUTES_PER_DAY;
    }

    let endAbsoluteMinutes = endMinutes === null
      ? startAbsoluteMinutes
      : endMinutes + dayOffset;

    while (endAbsoluteMinutes < startAbsoluteMinutes) {
      endAbsoluteMinutes += MINUTES_PER_DAY;
    }

    previousStartAbsoluteMinutes = startAbsoluteMinutes;
    maxEndAbsoluteMinutes = Math.max(maxEndAbsoluteMinutes, endAbsoluteMinutes);
  }

  return Math.max(0, Math.ceil(maxEndAbsoluteMinutes - routeEndAbsoluteMinutes));
}
