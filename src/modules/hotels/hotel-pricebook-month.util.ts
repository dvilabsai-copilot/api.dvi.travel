const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

/**
 * Price-book rows exist in both the legacy month-name format ("October") and
 * the newer numeric format ("10"). Keep range reads compatible with both.
 */
export function normalizeHotelPricebookMonth(value: unknown): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return '';

  const numericMonth = Number(normalized);
  if (Number.isInteger(numericMonth) && numericMonth >= 1 && numericMonth <= 12) {
    return String(numericMonth).padStart(2, '0');
  }

  const fullNameIndex = MONTH_NAMES.indexOf(normalized as (typeof MONTH_NAMES)[number]);
  if (fullNameIndex >= 0) return String(fullNameIndex + 1).padStart(2, '0');

  const abbreviationIndex = MONTH_NAMES.findIndex((month) => month.slice(0, 3) === normalized);
  return abbreviationIndex >= 0 ? String(abbreviationIndex + 1).padStart(2, '0') : '';
}
