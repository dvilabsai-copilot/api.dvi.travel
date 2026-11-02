/** Converts a database TIME value into whole minutes without dropping partial hours. */
export function hotspotDurationToMinutes(value: unknown): number {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.getUTCHours() * 60 + value.getUTCMinutes() + Math.round(value.getUTCSeconds() / 60);
  }

  const raw = String(value ?? "").trim();
  const timeMatch = raw.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (timeMatch) {
    return Number(timeMatch[1]) * 60 + Number(timeMatch[2]) + Math.round(Number(timeMatch[3] || 0) / 60);
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return 0;
  return parsed.getUTCHours() * 60 + parsed.getUTCMinutes() + Math.round(parsed.getUTCSeconds() / 60);
}
