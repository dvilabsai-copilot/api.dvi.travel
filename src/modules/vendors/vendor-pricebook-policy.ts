/** Pure normalization rules used by vendor pricebook CRUD workflows. */

export function normalizeOutstationKmSignature(
  limit: number | null,
  title: string | null | undefined,
): { normalizedLimit: number; normalizedTitle: string } {
  const normalizedTitle = String(title ?? '').trim();
  const numericFromLimit = Number(limit ?? 0);
  if (Number.isFinite(numericFromLimit) && numericFromLimit > 0) {
    return { normalizedLimit: numericFromLimit, normalizedTitle };
  }

  const titleMatch = normalizedTitle.match(/(\d+(?:\.\d+)?)/);
  const numericFromTitle = titleMatch ? Number(titleMatch[1]) : 0;
  return {
    normalizedLimit: Number.isFinite(numericFromTitle) ? numericFromTitle : 0,
    normalizedTitle,
  };
}

export function nextSoftDeleteValue(deletedValues: Array<number | null | undefined>): number {
  return Math.max(1, ...deletedValues.map((value) => Number(value ?? 0))) + 1;
}

export function normalizeLocalTimeLimitSignature(
  hours: number | null,
  kmLimit: number | null,
  title: string | null | undefined,
): { normalizedHours: number; normalizedKm: number; normalizedTitle: string } {
  const normalizedTitle = String(title ?? '').trim();
  const numericHours = Number(hours ?? 0);
  const numericKm = Number(kmLimit ?? 0);

  if (Number.isFinite(numericHours) && numericHours > 0 && Number.isFinite(numericKm) && numericKm > 0) {
    return { normalizedHours: numericHours, normalizedKm: numericKm, normalizedTitle };
  }

  const matches = normalizedTitle.match(/(\d+(?:\.\d+)?)/g) ?? [];
  const parsedHours = Number(matches[0] ?? 0);
  const parsedKm = Number(matches[1] ?? 0);

  return {
    normalizedHours: Number.isFinite(parsedHours) ? parsedHours : 0,
    normalizedKm: Number.isFinite(parsedKm) ? parsedKm : 0,
    normalizedTitle,
  };
}
