/** Map supplier/master category values to the application's logical buckets. */
export function normalizeHotelCategory(value: unknown): number | null {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  if (/\b(budget|std|standard)\b/.test(text)) return 2;
  const match = text.match(/(?:^|\D)([1-5])\s*(?:\*|[-_ ]?star|[-_ ]?stars)?\b/);
  if (!match) return null;
  const category = Number(match[1]);
  return category === 1 ? 2 : category;
}

export function normalizeHotelCategoryLabel(value: unknown): string {
  const category = normalizeHotelCategory(value);
  return category === null ? 'UNKNOWN' : `STAR_${category}`;
}
