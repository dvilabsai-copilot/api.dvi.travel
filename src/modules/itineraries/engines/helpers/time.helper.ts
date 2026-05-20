// FILE: src/modules/itineraries/engines/helpers/time.helper.ts

export type TimeLike = string | Date | number | null | undefined;

/**
 * Interprets input as a TIME-OF-DAY (HH:MM:SS) and returns seconds since 00:00.
 * - If Date is given, uses UTC HH:MM:SS (to match DB TIME usage).
 * - If number is given, assumes it is already seconds.
 */
export function timeToSeconds(value: TimeLike): number {
  if (value == null) return 0;

  if (value instanceof Date) {
    const h = value.getUTCHours();
    const m = value.getUTCMinutes();
    const s = value.getUTCSeconds();
    return h * 3600 + m * 60 + s;
  }

  if (typeof value === "number") {
    return Math.max(0, value);
  }

  const str = String(value).trim();
  if (!str) return 0;

  // Format "HH:MM:SS" or "HH:MM"
  const parts = str.split(":").map((p) => parseInt(p, 10) || 0);
  const [h, m, s] =
    parts.length === 3 ? parts : parts.length === 2 ? [parts[0], parts[1], 0] : [0, 0, 0];

  return h * 3600 + m * 60 + s;
}

/**
 * Formats seconds as TIME-OF-DAY (wraps at 24h).
 * ✅ Use this only for DB TIME fields.
 */
export function secondsToTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds)) totalSeconds = 0;
  const secs = Math.max(0, Math.floor(totalSeconds)) % 86400; // wrap 24h
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * Formats seconds as DURATION (does NOT wrap at 24h).
 * ✅ Use this for travel durations like "1 day 2 hours", "26:15:00", etc.
 */
export function secondsToDurationTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds)) totalSeconds = 0;
  const secs = Math.max(0, Math.floor(totalSeconds)); // no wrap
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  // NOTE: hours can exceed 24 here (intended)
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * Adds two TIME-OF-DAY values and returns TIME-OF-DAY (wraps at 24h).
 */
export function addTimes(base: TimeLike, delta: TimeLike): string {
  const total = timeToSeconds(base) + timeToSeconds(delta);
  return secondsToTime(total);
}

/**
 * Adds seconds to a TIME-OF-DAY base and returns TIME-OF-DAY (wraps at 24h).
 */
export function addSeconds(base: TimeLike, seconds: number): string {
  const total = timeToSeconds(base) + seconds;
  return secondsToTime(total);
}

/**
 * Converts minutes to TIME-OF-DAY (wraps at 24h).
 * ✅ keep for TIME fields only
 */
export function minutesToTime(minutes: number): string {
  const secs = Math.round(Math.max(0, minutes) * 60);
  return secondsToTime(secs);
}

/**
 * Converts minutes to DURATION time (does NOT wrap).
 * ✅ use for travel durations
 */
export function minutesToDurationTime(minutes: number): string {
  const secs = Math.round(Math.max(0, minutes) * 60);
  return secondsToDurationTime(secs);
}

/**
 * Wraps absolute seconds to 0-86399 range (24-hour day).
 * Use ONLY for final display/storage formatting.
 * ✅ Keep absolute seconds for ALL validation logic.
 */
export function wrapToDay(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  return ((seconds % 86400) + 86400) % 86400;
}

/**
 * Checks if a time range spans midnight (end < start in same-day seconds).
 * Returns { isOvernight: true/false, absoluteEndSeconds: adjusted end }
 * 
 * Example:
 * - start=82800 (23:00), end=3600 (01:00) -> isOvernight=true, absoluteEndSeconds=90000
 * - start=36000 (10:00), end=72000 (20:00) -> isOvernight=false, absoluteEndSeconds=72000
 */
export function normalizeTimeRange(
  startSeconds: number,
  endSeconds: number,
): { isOvernight: boolean; absoluteEndSeconds: number } {
  if (endSeconds < startSeconds) {
    // Spans midnight: add 24 hours to end
    return { isOvernight: true, absoluteEndSeconds: endSeconds + 86400 };
  }
  return { isOvernight: false, absoluteEndSeconds: endSeconds };
}
