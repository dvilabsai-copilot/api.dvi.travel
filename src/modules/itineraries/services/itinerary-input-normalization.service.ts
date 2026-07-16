/** Pure input and display normalization shared by the itinerary facade. */

export function parseCsvNumberList(value: unknown): number[] {
  return String(value ?? '')
    .split(',')
    .map((item) => Number(String(item).trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
}

export function formatDateOnly(value?: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export function toDateOnly(value: Date | string | null | undefined): string {
  return formatDateOnly(value) || '';
}

export function normalizeToArray(value: any): any[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (value && typeof value === 'object') return [value];
  return [];
}

export function normalizeToUniqueStrings(items: any[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of items) {
    let text = '';
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      text = String(item).trim();
    } else if (item && typeof item === 'object') {
      text = String(item?.name || item?.text || item?.description || item?.label || '').trim();
      if (!text) {
        try {
          text = JSON.stringify(item);
        } catch {
          text = '';
        }
      }
    }

    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }

  return result;
}

export function inferMealPlanFromInclusions(items: string[]): string | null {
  const haystack = items.join(' ').toLowerCase();
  if (!haystack) return null;
  if (haystack.includes('full board')) return 'Full Board';
  if (haystack.includes('half board')) return 'Half Board';
  if (haystack.includes('room only') || haystack.includes('no meals')) return 'Room Only';
  if (haystack.includes('breakfast')) return 'Breakfast Included';
  return null;
}

export function normalizeManualHotspotIds(ids: any[]): number[] {
  return Array.from(
    new Set(
      (ids || [])
        .map((id: any) => Number(id))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    ),
  );
}

export function parseRouteFamilyQuote(quoteId: string | undefined | null): {
  baseQuoteId: string;
  routeVariantIndex: number | null;
} | null {
  const raw = String(quoteId || '').trim();
  if (!raw) return null;

  const match = raw.match(/^(.*)-R(\d+)$/i);
  if (!match) return { baseQuoteId: raw, routeVariantIndex: null };

  const baseQuoteId = String(match[1] || '').trim();
  const routeVariantIndex = Number.parseInt(String(match[2] || ''), 10);
  if (!baseQuoteId || !Number.isFinite(routeVariantIndex) || routeVariantIndex <= 0) {
    return { baseQuoteId: raw, routeVariantIndex: null };
  }

  return { baseQuoteId, routeVariantIndex };
}
