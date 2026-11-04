const INDIA_TIME_ZONE = 'Asia/Kolkata';
const INDIA_UTC_OFFSET_MINUTES = 330;

const asArray = (value: unknown): Record<string, any>[] => {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object');
  return value && typeof value === 'object' ? [value as Record<string, any>] : [];
};

const parseIndiaLocalDate = (
  year: string,
  month: string,
  day: string,
  hour = '0',
  minute = '0',
  second = '0',
): Date | null => {
  const parts = [year, month, day, hour, minute, second].map(Number);
  const [numericYear, numericMonth, numericDay, numericHour, numericMinute, numericSecond] = parts;
  if (
    numericMonth < 1 || numericMonth > 12
    || numericDay < 1 || numericDay > 31
    || numericHour < 0 || numericHour > 23
    || numericMinute < 0 || numericMinute > 59
    || numericSecond < 0 || numericSecond > 59
  ) return null;

  const utcMilliseconds = Date.UTC(
    numericYear, numericMonth - 1, numericDay, numericHour, numericMinute, numericSecond,
  ) - INDIA_UTC_OFFSET_MINUTES * 60_000;
  const parsed = new Date(utcMilliseconds);
  const indiaLocal = new Date(utcMilliseconds + INDIA_UTC_OFFSET_MINUTES * 60_000);
  if (
    indiaLocal.getUTCFullYear() !== numericYear
    || indiaLocal.getUTCMonth() !== numericMonth - 1
    || indiaLocal.getUTCDate() !== numericDay
  ) return null;
  return parsed;
};

const parseDeadline = (value: unknown): Date | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || !value.trim()) return null;

  const raw = value.trim();
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  if (hasExplicitZone) {
    const zonedDate = new Date(raw);
    return Number.isNaN(zonedDate.getTime()) ? null : zonedDate;
  }

  // TBO currently returns deadlines like "21-11-2026 23:59:59". Treat
  // timezone-less supplier timestamps as India local time, where these
  // itineraries and supplier operations are managed.
  const dmy = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dmy) {
    const [, day, month, year, hour = '0', minute = '0', second = '0'] = dmy;
    return parseIndiaLocalDate(year, month, day, hour, minute, second);
  }

  const isoLocal = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (isoLocal) {
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = isoLocal;
    return parseIndiaLocalDate(year, month, day, hour, minute, second);
  }

  const fallbackDate = new Date(raw);
  return Number.isNaN(fallbackDate.getTime()) ? null : fallbackDate;
};

const startOfIndiaDayPlusDays = (now: Date, days: number): Date => {
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: INDIA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(dateParts.map((part) => [part.type, part.value]));
  const thresholdUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day) + days,
  ) - INDIA_UTC_OFFSET_MINUTES * 60_000;
  return new Date(thresholdUtc);
};

export const isTboInsufficientBalanceResponse = (response: Record<string, any>): boolean => {
  const status = response?.Status;
  const statusCode = Number(status && typeof status === 'object' ? status.Code : status);
  const description = String(
    (status && typeof status === 'object' ? status.Description : undefined)
      || response?.Message
      || '',
  ).trim().replace(/[.!]+$/, '').toLowerCase();

  return statusCode === 300 && description === 'insufficient balance';
};

/**
 * TBO hold eligibility is based on the fresh PreBook rate, not merely the
 * older itinerary snapshot. Every returned room must be refundable and have
 * an LCD at least the configured number of India calendar days away.
 */
export const isTboPrebookRateEligibleForHold = (
  response: Record<string, any>,
  bufferDays: number,
  now: Date = new Date(),
): boolean => {
  const hotelResults = asArray(response?.HotelResult);
  const rooms = hotelResults.length > 0
    ? hotelResults.flatMap((hotel) => asArray(hotel?.Rooms).map((room) => ({ ...hotel, ...room })))
    : asArray(response?.HotelRoomsDetails || response?.Rooms);
  if (rooms.length === 0 || Number.isNaN(now.getTime())) return false;

  const safeBufferDays = Math.max(0, Math.trunc(Number(bufferDays) || 0));
  const minimumDeadline = startOfIndiaDayPlusDays(now, safeBufferDays).getTime();

  return rooms.every((room) => {
    const refundable = room.IsRefundable ?? room.isRefundable;
    const isRefundable = refundable === true || refundable === 1 || String(refundable).trim().toLowerCase() === 'true';
    if (!isRefundable) return false;

    const deadline = parseDeadline(
      room.LastCancellationDeadline
        ?? room.lastCancellationDeadline
        ?? room.LastCancellationDate
        ?? room.lastCancellationDate,
    );
    return Boolean(deadline && deadline.getTime() >= minimumDeadline);
  });
};
