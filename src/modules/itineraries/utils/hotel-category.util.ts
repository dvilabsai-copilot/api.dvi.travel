/** Map supplier/master category values to the application's logical buckets. */
export const HOUSEBOAT_CATEGORY_CODE = 'HOUSEBOAT';

export function isHouseboatCategory(value: unknown): boolean {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  return text === 'houseboat' || text === 'houseboats';
}

export function normalizeHotelCategory(value: unknown): number | null {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  if (/\b(budget|std|standard)\b/.test(text)) return 2;
  const match = text.match(/(?:^|\D)([1-5])\s*(?:\*|[-_ ]?star|[-_ ]?stars)?\b/);
  if (!match) return null;
  const category = Number(match[1]);
  return category === 1 ? 2 : category;
}

/** Normalize a supplier/master star rating without remapping numeric 1-star values. */
export function normalizeHotelStarRating(value: unknown): number | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^[1-5](?:\.0+)?$/.test(text)) return Number(text);
  return normalizeHotelCategory(value);
}

export function normalizeHotelCategoryLabel(value: unknown): string {
  if (isHouseboatCategory(value)) return HOUSEBOAT_CATEGORY_CODE;
  const category = normalizeHotelCategory(value);
  return category === null ? 'UNKNOWN' : `STAR_${category}`;
}
