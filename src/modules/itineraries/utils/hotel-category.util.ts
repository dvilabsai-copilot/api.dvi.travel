/** Map supplier/master category values to the application's logical buckets. */
export const HOUSEBOAT_CATEGORY_CODE = 'HOUSEBOAT';

export function isHouseboatCategory(value: unknown): boolean {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  return text === 'houseboat' || text === 'houseboats';
}

/**
 * Detect a Houseboat without depending on a particular supplier's naming.
 * Category metadata is authoritative when present; the legacy text fields
 * remain supported for older VSR/AX/offline rows.
 */
export function isHouseboatHotel(candidate: unknown): boolean {
  const hotel = (candidate || {}) as Record<string, unknown>;
  const values = [
    hotel.hotelCategoryName,
    hotel.hotelCategoryCode,
    hotel.category,
    hotel.accommodationType,
    hotel.propertyType,
    hotel.hotelName,
    ...(Array.isArray(hotel.tags) ? hotel.tags : []),
  ];

  return hotel.isHouseboat === true || values.some((value) =>
    isHouseboatCategory(value) || /house\s*-?\s*boat/i.test(String(value ?? '')),
  );
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
