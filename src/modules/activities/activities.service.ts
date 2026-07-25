// FILE: src/modules/activities/activities.service.ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { CreateActivityBookingDto } from './dto/create-activity-booking.dto';

// helpers
function toTimeDate(hhmmss?: string | null): Date | null {
  if (!hhmmss) return null;
 // Expect "HH:MM" or "HH:MM:SS"
  const parts = String(hhmmss).split(':').map((x) => parseInt(x, 10));
  if (!parts.length || Number.isNaN(parts[0])) return null;
  const d = new Date();
  d.setHours(parts[0] || 0, parts[1] || 0, parts[2] || 0, 0);
  return d;
}

function toDateOnly(d?: string | Date | null): Date | null {
  if (!d) return null;
  const x = new Date(d as any);
  if (Number.isNaN(x.getTime())) return null;
  x.setHours(0, 0, 0, 0);
  return x;
}

function toInt(v: any, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function toFloat(v: any, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function toBigIntSafe(v: any): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  const s = String(v ?? '').trim();
  if (!s) return BigInt(0);
  return BigInt(s);
}

type StatusFilter = '0' | '1' | undefined;

/** ---- NEW: safe formatters to avoid {} in JSON ---- */
function fmtHMS(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    const hh = String(v.getHours()).padStart(2, '0');
    const mm = String(v.getMinutes()).padStart(2, '0');
    const ss = String(v.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
 // Some drivers may already give "HH:MM:SS" strings
  const s = String(v);
  if (!s || s.toLowerCase() === 'invalid date') return null;
  const [hh = '00', mm = '00', ss = '00'] = s.split(':');
  return `${hh.padStart(2, '0')}:${mm.padStart(2, '0')}:${(ss ?? '00').padStart(2, '0')}`;
}

function fmtDateISO(d: unknown): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  const x = new Date(String(d));
  if (Number.isNaN(x.getTime())) return null;
  return x.toISOString().slice(0, 10);
}

function fmtDateTimeISO(d: unknown): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  const x = new Date(String(d));
  if (Number.isNaN(x.getTime())) return null;
  return x.toISOString();
}

const STOREFRONT_CATEGORIES = [
  { name: 'Adventure', keywords: ['paragliding', 'trek', 'zipline', 'camp', 'adventure', 'rafting'] },
  { name: 'Water Activities', keywords: ['scuba', 'water', 'kayak', 'boat', 'cruise', 'snorkel', 'diving'] },
  { name: 'Sightseeing', keywords: ['tour', 'sightseeing', 'museum', 'palace', 'temple', 'fort', 'garden'] },
  { name: 'Wildlife', keywords: ['safari', 'wildlife', 'zoo', 'tiger', 'forest', 'bird'] },
  { name: 'Cultural', keywords: ['cultural', 'culture', 'heritage', 'dance', 'show'] },
  { name: 'Food & Drink', keywords: ['food', 'drink', 'cafe', 'dinner', 'lunch', 'wine'] },
  { name: 'Wellness', keywords: ['spa', 'wellness', 'massage', 'yoga', 'ayurveda'] },
  { name: 'Fun & Leisure', keywords: ['leisure', 'fun', 'gaming', 'amusement', 'park', 'kayak'] },
] as const;

const ACTIVITY_IMAGE_FALLBACKS: Record<string, string> = {
 Adventure: 'https://images.unsplash.com/photo-1522163182402-834f871fd851?auto=format&fit=crop&w=900&q=80',
 'Water Activities': 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?auto=format&fit=crop&w=900&q=80',
 Sightseeing: 'https://images.unsplash.com/photo-1564507592333-c60657eea523?auto=format&fit=crop&w=900&q=80',
 Wildlife: 'https://images.unsplash.com/photo-1549366021-9f761d450615?auto=format&fit=crop&w=900&q=80',
 Cultural: 'https://images.unsplash.com/photo-1524231757912-21f4fe3a7200?auto=format&fit=crop&w=900&q=80',
 'Food & Drink': 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=900&q=80',
 Wellness: 'https://images.unsplash.com/photo-1540555700478-4be289fbecef?auto=format&fit=crop&w=900&q=80',
 'Fun & Leisure': 'https://images.unsplash.com/photo-1521336575822-6da63fb45455?auto=format&fit=crop&w=900&q=80',
};

const PRICEBOOK_DAY_KEYS = [
  'day_1',
  'day_2',
  'day_3',
  'day_4',
  'day_5',
  'day_6',
  'day_7',
  'day_8',
  'day_9',
  'day_10',
  'day_11',
  'day_12',
  'day_13',
  'day_14',
  'day_15',
  'day_16',
  'day_17',
  'day_18',
  'day_19',
  'day_20',
  'day_21',
  'day_22',
  'day_23',
  'day_24',
  'day_25',
  'day_26',
  'day_27',
  'day_28',
  'day_29',
  'day_30',
  'day_31',
] as const;

type PricebookDayKey = (typeof PRICEBOOK_DAY_KEYS)[number];

type ActivityPricingUnitType = 'PER_ADULT' | 'UNIT';

const ACTIVITY_PRICE_TYPE_ADULT = 1;
const ACTIVITY_PRICE_TYPE_CHILD = 2;
const ACTIVITY_PRICE_TYPE_INFANT = 3;
const ACTIVITY_PRICE_TYPE_UNIT = 4;

function normalizeActivityPricingUnitType(value: unknown): ActivityPricingUnitType {
  return String(value ?? '').toUpperCase() === 'UNIT' ? 'UNIT' : 'PER_ADULT';
}

function getActivityPriceUnitLabel(unitType: ActivityPricingUnitType): string {
  return unitType === 'UNIT' ? 'per unit' : 'per adult';
}

function setPreferredActivityPrice(
  priceMap: Map<number, number>,
  unitTypeMap: Map<number, ActivityPricingUnitType>,
  activityId: number,
  price: number,
  unitType: ActivityPricingUnitType,
): void {
  if (!activityId || price <= 0) return;

  const oldPrice = priceMap.get(activityId);
  const oldUnitType = unitTypeMap.get(activityId);

  if (oldPrice == null || oldUnitType == null) {
    priceMap.set(activityId, price);
    unitTypeMap.set(activityId, unitType);
    return;
  }

  if (oldUnitType === 'UNIT' && unitType !== 'UNIT') {
    return;
  }

  if (unitType === 'UNIT' && oldUnitType !== 'UNIT') {
    priceMap.set(activityId, price);
    unitTypeMap.set(activityId, unitType);
    return;
  }

  if (price < oldPrice) {
    priceMap.set(activityId, price);
    unitTypeMap.set(activityId, unitType);
  }
}

function inferActivityCategory(title?: string | null, description?: string | null, hotspotType?: string | null): string {
  const haystack = `${title ?? ''} ${description ?? ''} ${hotspotType ?? ''}`.toLowerCase();
  for (const category of STOREFRONT_CATEGORIES) {
    if (category.keywords.some((keyword) => haystack.includes(keyword))) return category.name;
  }
  return 'Sightseeing';
}

function imageUrlFromGalleryName(name: string | null | undefined): string | null {
  if (!name) return null;
 if (/^https?:\/\//i.test(name)) return name;
  return `/uploads/activity_gallery/${name}`;
}

function formatDurationLabel(v: unknown): string {
  const hms = fmtHMS(v);
  if (!hms) return 'Flexible';
  const [hh, mm] = hms.split(':').map((part) => Number(part));
  if (hh && mm) return `${hh} hr ${mm} mins`;
  if (hh) return `${hh} hr${hh > 1 ? 's' : ''}`;
  if (mm) return `${mm} mins`;
  return 'Flexible';
}

function formatCurrencyINR(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(Math.max(0, amount || 0));
}

function monthNameFromDate(date: Date): string {
  return date.toLocaleString('en-US', { month: 'long' });
}

function getValidatedPricebookDayKey(day: number): PricebookDayKey | null {
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  return `day_${day}` as PricebookDayKey;
}

const LOCATION_NOISE_PHRASES = [
  'international airport',
  'domestic airport',
  'railway station',
  'railway stn',
  'railway',
  'bus stand',
  'bus station',
  'metro station',
  'train station',
  'airport',
  'station',
  'junction',
  'terminal',
  'central',
  'beach',
  'harbour',
  'harbor',
] as const;

function toTitleCasePreservingAcronyms(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      if (/^[A-Z0-9.&/-]{2,}$/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

function normalizeLocationWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
}

function stripLocationNoise(value: string): string {
  let cleaned = normalizeLocationWhitespace(value);
  for (const phrase of LOCATION_NOISE_PHRASES) {
    cleaned = cleaned.replace(new RegExp(`\\b${phrase.replace(/\s+/g, '\\s+')}\\b`, 'gi'), ' ');
  }
  cleaned = cleaned.replace(/[|]+/g, ' ');
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
  cleaned = cleaned.replace(/^[,.\-\/\s]+|[,.\-\/\s]+$/g, '').trim();
  return cleaned;
}

function cleanActivityLocationLabel(raw: string): string {
  const source = normalizeLocationWhitespace(String(raw || '').trim());
  if (!source) return '';

  const segments = source
    .split('|')
    .map((segment) => normalizeLocationWhitespace(segment))
    .filter(Boolean);

  if (!segments.length) return '';

  const fullCandidates: string[] = [];
  const firstWordFrequency = new Map<string, number>();

  for (const segment of segments) {
    const commaParts = segment
      .split(',')
      .map((part) => stripLocationNoise(part))
      .filter(Boolean);

    const preferredFullCandidate =
      commaParts.find((part) => /\s/.test(part) || /^[A-Za-z]/.test(part)) ||
      stripLocationNoise(segment);

    const fullCandidate = normalizeLocationWhitespace(preferredFullCandidate);
    if (!fullCandidate) continue;

    fullCandidates.push(fullCandidate);

    const firstWord = fullCandidate.split(/\s+/)[0]?.trim();
    if (firstWord && firstWord.length > 2) {
      const key = firstWord.toLowerCase();
      firstWordFrequency.set(key, (firstWordFrequency.get(key) ?? 0) + 1);
    }
  }

  if (!fullCandidates.length) {
    return toTitleCasePreservingAcronyms(segments[0]);
  }

  const bestFirstWord = Array.from(firstWordFrequency.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    if (a[0].length !== b[0].length) return a[0].length - b[0].length;
    return a[0].localeCompare(b[0]);
  })[0];

  if (segments.length > 1 && bestFirstWord && bestFirstWord[1] > 1) {
    return toTitleCasePreservingAcronyms(bestFirstWord[0]);
  }

  const bestFullCandidate = [...fullCandidates].sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  })[0];

  return toTitleCasePreservingAcronyms(bestFullCandidate);
}

function normalizeRouteSearchToken(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeStoredRouteName(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
 .replace(/\s*,\s*/g, ', ')
    .replace(/,\s*india$/i, '');
}

function buildRouteLocationCandidates(value: string): string[] {
  const raw = String(value || '').trim();
  if (!raw) return [];

  const full = cleanActivityLocationLabel(raw);
  const pipeSegments = raw
    .split('|')
    .map((part) => cleanActivityLocationLabel(part))
    .filter(Boolean);

  const all = [full, ...pipeSegments]
    .map((part) => String(part || '').trim())
    .filter(Boolean);

  return Array.from(
    new Map(all.map((item) => [normalizeRouteSearchToken(item), item])).values(),
  );
}

function buildRouteEndpointClauses(sourceTerms: string[], destinationTerms: string[]) {
  const sourceOnlyClauses = sourceTerms.flatMap((term) => [
    { hotspot_location: { contains: term } },
    { hotspot_to_location: { contains: term } },
  ]);

  const destinationOnlyClauses = destinationTerms.flatMap((term) => [
    { hotspot_location: { contains: term } },
    { hotspot_to_location: { contains: term } },
  ]);

  const pairedClauses = sourceTerms.flatMap((sourceTerm) =>
    destinationTerms.flatMap((destinationTerm) => [
      {
        AND: [
          { hotspot_location: { contains: sourceTerm } },
          { hotspot_to_location: { contains: destinationTerm } },
        ],
      },
      {
        AND: [
          { hotspot_location: { contains: destinationTerm } },
          { hotspot_to_location: { contains: sourceTerm } },
        ],
      },
    ]),
  );

  return [...pairedClauses, ...sourceOnlyClauses, ...destinationOnlyClauses];
}

function buildStoredLocationNameCandidates(value: string): string[] {
  const raw = String(value || '').trim();
  if (!raw) return [];

  const short = raw.split(',')[0]?.trim() || raw;
  return Array.from(
    new Map(
      [raw, short]
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .map((item) => [normalizeStoredRouteName(item), item]),
    ).values(),
  );
}

function routeNamesRoughlyMatch(input: string, stored: string): boolean {
  const normalizedInput = normalizeStoredRouteName(input);
  const normalizedStored = normalizeStoredRouteName(stored);

  if (!normalizedInput || !normalizedStored) return false;
  if (normalizedInput === normalizedStored) return true;

  return (
    normalizedInput.includes(normalizedStored) ||
    normalizedStored.includes(normalizedInput)
  );
}

@Injectable()
export class ActivitiesService {
  constructor(private readonly prisma: PrismaService) {}

  getStorefrontCategories() {
    return {
      data: STOREFRONT_CATEGORIES.map((category) => ({ name: category.name })),
    };
  }

  async getStorefrontActivityLocations(q?: string) {
    const normalizedQuery = String(q ?? '').trim().toLowerCase();
    const rows = await this.prisma.$queryRaw<
      Array<{ rawLabel: string; activityId: number | bigint }>
    >(Prisma.sql`
      SELECT
        TRIM(
          COALESCE(
            NULLIF(TRIM(h.hotspot_location), ''),
            NULLIF(TRIM(h.hotspot_to_location), ''),
            NULLIF(TRIM(h.hotspot_name), '')
          )
        ) AS rawLabel,
        a.activity_id AS activityId
      FROM dvi_activity a
      INNER JOIN dvi_hotspot_place h
        ON h.hotspot_ID = a.hotspot_id
      WHERE a.deleted = 0
        AND a.status = 1
        AND h.deleted = 0
        AND h.status = 1
        AND COALESCE(
          NULLIF(TRIM(h.hotspot_location), ''),
          NULLIF(TRIM(h.hotspot_to_location), ''),
          NULLIF(TRIM(h.hotspot_name), '')
        ) IS NOT NULL
        ${normalizedQuery
          ? Prisma.sql`
            AND LOWER(
              CONCAT_WS(
                ' ',
                COALESCE(h.hotspot_location, ''),
                COALESCE(h.hotspot_to_location, ''),
                COALESCE(h.hotspot_name, '')
              )
            ) LIKE ${`%${normalizedQuery}%`}
          `
          : Prisma.empty}
    `);

    const grouped = new Map<
      string,
      {
        label: string;
        value: string;
        activityIds: Set<number>;
        rawMatchesQuery: boolean;
      }
    >();

    for (const row of rows) {
      const rawLabel = String(row.rawLabel || '').trim();
      const cleanedLabel = cleanActivityLocationLabel(rawLabel);
      if (!cleanedLabel) continue;

      const key = cleanedLabel.toLowerCase();
      const existing =
        grouped.get(key) ??
        {
          label: cleanedLabel,
          value: cleanedLabel,
          activityIds: new Set<number>(),
          rawMatchesQuery: false,
        };

      existing.activityIds.add(Number(row.activityId ?? 0));
      if (normalizedQuery) {
        existing.rawMatchesQuery =
          existing.rawMatchesQuery ||
          rawLabel.toLowerCase().includes(normalizedQuery) ||
          cleanedLabel.toLowerCase().includes(normalizedQuery);
      }

      grouped.set(key, existing);
    }

    const data = Array.from(grouped.values())
      .filter((item) => !normalizedQuery || item.rawMatchesQuery || item.label.toLowerCase().includes(normalizedQuery))
      .map((item) => ({
        label: item.label,
        value: item.value,
        activityCount: item.activityIds.size,
      }))
      .sort((a, b) => {
        if (normalizedQuery) {
          const aStarts = a.label.toLowerCase().startsWith(normalizedQuery) ? 1 : 0;
          const bStarts = b.label.toLowerCase().startsWith(normalizedQuery) ? 1 : 0;
          if (bStarts !== aStarts) return bStarts - aStarts;
        }
        if (b.activityCount !== a.activityCount) return b.activityCount - a.activityCount;
        return a.label.localeCompare(b.label);
      })
      .slice(0, 20);

    return {
      data,
    };
  }

  async getStorefrontActivities(opts: {
    source?: string;
    destination?: string;
    activityType?: string;
    q?: string;
    date?: string;
    guests?: number | string;
    limit?: number | string;
  }) {
    const source = String(opts?.source ?? '').trim();
    const destination = String(opts?.destination ?? '').trim();
    const q = String(opts?.q ?? '').trim();
    const activityType = String(opts?.activityType ?? '').trim();
    const selectedDate = toDateOnly(opts?.date);
    if (opts?.date && !selectedDate) {
      throw new BadRequestException('Invalid activity date');
    }
    const selectedDay = selectedDate ? selectedDate.getDate() : 0;
    const selectedMonth = selectedDate ? selectedDate.getMonth() + 1 : 0;
    const selectedYear = selectedDate ? selectedDate.getFullYear() : 0;
    const selectedMonthName = selectedDate ? monthNameFromDate(selectedDate) : '';
    const selectedDayColumn = getValidatedPricebookDayKey(selectedDay);
    const limit = Math.min(Math.max(toInt(opts?.limit, 12), 1), 50);
    const guests = Math.max(toInt(opts?.guests, 1), 1);

    const activityAndFilters: any[] = [{ deleted: 0 }, { status: 1 }];

    if (guests > 1) {
      activityAndFilters.push({
        max_allowed_person_count: { gte: guests },
      });
    }

    let destinationHotspotIds: number[] = [];
    const routeSearchMode = Boolean(source);
    if (routeSearchMode) {
      const sourceCandidates = buildRouteLocationCandidates(source);
      const destinationCandidates = buildRouteLocationCandidates(destination || source);
      const primarySource = sourceCandidates[0] || source;
      const primaryDestination = destinationCandidates[0] || destination || source;

      let viaRouteLabels: string[] = [];
      if (
        primarySource &&
        primaryDestination &&
        normalizeRouteSearchToken(primarySource) !== normalizeRouteSearchToken(primaryDestination)
      ) {
        const sourceLookupCandidates = buildStoredLocationNameCandidates(primarySource);
        const destinationLookupCandidates = buildStoredLocationNameCandidates(primaryDestination);

        const storedLocationCandidates = await this.prisma.dvi_stored_locations.findMany({
          where: {
            deleted: 0,
            status: 1,
            AND: [
              {
                OR: sourceLookupCandidates.flatMap((candidate) => [
                  { source_location: candidate },
                  { source_location: { contains: candidate } },
                ]),
              },
              {
                OR: destinationLookupCandidates.flatMap((candidate) => [
                  { destination_location: candidate },
                  { destination_location: { contains: candidate } },
                ]),
              },
            ],
          } as any,
          select: {
            location_ID: true,
            source_location: true,
            destination_location: true,
          },
          take: 25,
        } as any);

        const storedLocation =
          storedLocationCandidates.find(
            (row: any) =>
              routeNamesRoughlyMatch(primarySource, String(row?.source_location || '')) &&
              routeNamesRoughlyMatch(primaryDestination, String(row?.destination_location || '')),
          ) ??
          storedLocationCandidates[0];

        if (storedLocation?.location_ID) {
          const viaRows = await this.prisma.dvi_stored_location_via_routes.findMany({
            where: {
              deleted: 0,
              status: 1,
              location_id: storedLocation.location_ID,
            } as any,
            select: {
              via_route_location: true,
            },
            orderBy: {
              via_route_location: 'asc',
            },
          } as any);

          viaRouteLabels = viaRows
            .map((row: any) => cleanActivityLocationLabel(String(row?.via_route_location || '')))
            .filter(Boolean);
        }
      }

      const endpointTerms = Array.from(
        new Map(
          [...sourceCandidates, ...destinationCandidates, ...viaRouteLabels].map((term) => [
            normalizeRouteSearchToken(term),
            term,
          ]),
        ).values(),
      );

      const routeEndpointClauses = buildRouteEndpointClauses(
        Array.from(
          new Map(
            [...sourceCandidates, ...viaRouteLabels].map((term) => [
              normalizeRouteSearchToken(term),
              term,
            ]),
          ).values(),
        ),
        Array.from(
          new Map(
            [...destinationCandidates, ...viaRouteLabels].map((term) => [
              normalizeRouteSearchToken(term),
              term,
            ]),
          ).values(),
        ),
      );

      if (routeEndpointClauses.length) {
        const matchingHotspots = await this.prisma.dvi_hotspot_place.findMany({
          where: {
            deleted: 0,
            status: 1,
            OR: routeEndpointClauses,
          },
          select: {
            hotspot_ID: true,
            hotspot_name: true,
            hotspot_location: true,
            hotspot_to_location: true,
          },
        });

        destinationHotspotIds = matchingHotspots
          .map((row) => Number(row.hotspot_ID ?? 0))
          .filter((id) => id > 0);
      }

 console.log('[BookActivities] route-aware search', {
        source: primarySource,
        destination: primaryDestination,
        viaRouteLabels,
        endpointTerms,
        viaSourceLookupCandidates: buildStoredLocationNameCandidates(primarySource),
        viaDestinationLookupCandidates: buildStoredLocationNameCandidates(primaryDestination),
        matchedHotspotIdsCount: destinationHotspotIds.length,
        matchedHotspots: destinationHotspotIds.length
          ? destinationHotspotIds.slice(0, 20)
          : [],
      });

      if (destinationHotspotIds.length) {
        activityAndFilters.push({
          hotspot_id: { in: destinationHotspotIds },
        });
      } else {
        activityAndFilters.push({
          hotspot_id: { in: [-1] },
        });
      }
    } else if (destination) {
      const destinationCandidates = buildRouteLocationCandidates(destination);
      const destinationClauses = buildRouteEndpointClauses(destinationCandidates, []);

      const matchingHotspots = await this.prisma.dvi_hotspot_place.findMany({
        where: {
          deleted: 0,
          status: 1,
          OR: destinationClauses.length
            ? destinationClauses
            : [
                { hotspot_location: { contains: destination } },
                { hotspot_to_location: { contains: destination } },
              ],
        },
        select: {
          hotspot_ID: true,
        },
      });

      destinationHotspotIds = matchingHotspots
        .map((row) => Number(row.hotspot_ID ?? 0))
        .filter((id) => id > 0);

 console.log('[BookActivities] destination search', {
        destination,
        matchedHotspotIdsCount: destinationHotspotIds.length,
        matchedHotspotIds: destinationHotspotIds.slice(0, 20),
      });

      if (destinationHotspotIds.length) {
        activityAndFilters.push({
          hotspot_id: { in: destinationHotspotIds },
        });
      } else {
        activityAndFilters.push({
          hotspot_id: { in: [-1] },
        });
      }
    }

    if (q) {
      activityAndFilters.push({
        OR: [
          { activity_title: { contains: q } },
          { activity_description: { contains: q } },
        ],
      });
    }

    const rows = await this.prisma.dvi_activity.findMany({
      where: { AND: activityAndFilters },
      orderBy: { activity_id: 'desc' },
      take: limit * 6,
      select: {
        activity_id: true,
        activity_title: true,
        hotspot_id: true,
        max_allowed_person_count: true,
        activity_duration: true,
        activity_description: true,
      },
    });

    const activityIds = rows.map((r) => r.activity_id);
    const hotspotIds = Array.from(new Set(rows.map((r) => r.hotspot_id).filter(Boolean)));

    const [hotspots, images, priceRows, reviewRows, timeSlotRows] = await Promise.all([
      hotspotIds.length
        ? this.prisma.dvi_hotspot_place.findMany({
            where: {
              hotspot_ID: { in: hotspotIds as any },
              deleted: 0,
              status: 1,
            },
            select: {
              hotspot_ID: true,
              hotspot_name: true,
              hotspot_location: true,
              hotspot_type: true,
              hotspot_rating: true,
              hotspot_adult_entry_cost: true,
              hotspot_duration: true,
            },
          })
        : Promise.resolve([]),
      activityIds.length
        ? this.prisma.dvi_activity_image_gallery_details.findMany({
            where: { activity_id: { in: activityIds }, deleted: 0, status: 1 },
            orderBy: { activity_image_gallery_details_id: 'asc' },
            select: {
              activity_id: true,
              activity_image_gallery_name: true,
            },
          })
        : Promise.resolve([]),
activityIds.length
  ? this.prisma.dvi_activity_pricebook.findMany({
      where: {
        activity_id: { in: activityIds },
        deleted: 0,
        status: 1,
        nationality: 1,
        price_type: {
          in: [ACTIVITY_PRICE_TYPE_ADULT, ACTIVITY_PRICE_TYPE_UNIT],
        },
      },
      select: {
        activity_id: true,
        price_type: true,
        year: true,
        month: true,
              day_1: true,
              day_2: true,
              day_3: true,
              day_4: true,
              day_5: true,
              day_6: true,
              day_7: true,
              day_8: true,
              day_9: true,
              day_10: true,
              day_11: true,
              day_12: true,
              day_13: true,
              day_14: true,
              day_15: true,
              day_16: true,
              day_17: true,
              day_18: true,
              day_19: true,
              day_20: true,
              day_21: true,
              day_22: true,
              day_23: true,
              day_24: true,
              day_25: true,
              day_26: true,
              day_27: true,
              day_28: true,
              day_29: true,
              day_30: true,
              day_31: true,
            },
          })
        : Promise.resolve([]),
      activityIds.length
        ? this.prisma.dvi_activity_review_details.findMany({
            where: { activity_id: { in: activityIds }, deleted: 0, status: 1 },
            select: { activity_id: true, activity_rating: true },
          })
        : Promise.resolve([]),
      activityIds.length
        ? this.prisma.dvi_activity_time_slot_details.findMany({
            where: { activity_id: { in: activityIds }, deleted: 0, status: 1 },
            orderBy: [{ time_slot_type: 'asc' }, { special_date: 'asc' }, { start_time: 'asc' }],
            select: {
              activity_id: true,
              time_slot_type: true,
              special_date: true,
              start_time: true,
              end_time: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const hotspotMap = new Map(hotspots.map((h) => [h.hotspot_ID, h]));
    const firstImageMap = new Map<number, string>();
    images.forEach((image) => {
      const activityId = Number(image.activity_id ?? 0);
      if (activityId && !firstImageMap.has(activityId)) {
        const imageUrl = imageUrlFromGalleryName(image.activity_image_gallery_name);
        if (imageUrl) firstImageMap.set(activityId, imageUrl);
      }
    });

    const minPriceMap = new Map<number, number>();
const minPriceUnitTypeMap = new Map<number, ActivityPricingUnitType>();
const selectedDatePriceMap = new Map<number, number>();
const selectedDatePriceUnitTypeMap = new Map<number, ActivityPricingUnitType>();

priceRows.forEach((row) => {
  const activityId = Number(row.activity_id ?? 0);
  if (!activityId) return;

  const pricingUnitType: ActivityPricingUnitType =
    Number(row.price_type) === ACTIVITY_PRICE_TYPE_UNIT ? 'UNIT' : 'PER_ADULT';

  for (const dayKey of PRICEBOOK_DAY_KEYS) {
    const price = Number(row[dayKey] ?? 0);
    setPreferredActivityPrice(
      minPriceMap,
      minPriceUnitTypeMap,
      activityId,
      price,
      pricingUnitType,
    );
  }

  if (!selectedDate || !selectedDayColumn) return;
  if (String(row.year ?? '') !== String(selectedYear)) return;
  if (String(row.month ?? '').toLowerCase() !== selectedMonthName.toLowerCase()) return;

  const selectedPrice = Number(row[selectedDayColumn] ?? 0);
  setPreferredActivityPrice(
    selectedDatePriceMap,
    selectedDatePriceUnitTypeMap,
    activityId,
    selectedPrice,
    pricingUnitType,
  );
});
 console.log('[BookActivities] date availability', {
      selectedDate: selectedDate ? fmtDateISO(selectedDate) : null,
      selectedMonth,
      selectedYear,
      selectedDayColumn,
      matchedActivitiesCount: selectedDatePriceMap.size,
      matchedActivityIds: Array.from(selectedDatePriceMap.keys()).slice(0, 20),
    });

    const ratingMap = new Map<number, { total: number; count: number }>();
    reviewRows.forEach((row) => {
      const activityId = Number(row.activity_id ?? 0);
      const rating = Number(row.activity_rating ?? 0);
      if (!activityId || !rating) return;
      const current = ratingMap.get(activityId) ?? { total: 0, count: 0 };
      current.total += rating;
      current.count += 1;
      ratingMap.set(activityId, current);
    });

    const defaultTimeSlotsMap = new Map<
      number,
      Array<{ startTime: string | null; endTime: string | null; type: 'default'; specialDate: null }>
    >();
    const specialTimeSlotsMap = new Map<
      number,
      Map<string, Array<{ startTime: string | null; endTime: string | null; type: 'special'; specialDate: string | null }>>
    >();

    timeSlotRows.forEach((slot) => {
      const activityId = Number(slot.activity_id ?? 0);
      if (!activityId) return;

      if (Number(slot.time_slot_type) === 2) {
        const specialDateKey = fmtDateISO(slot.special_date);
        if (!specialDateKey) return;
        const perActivityMap = specialTimeSlotsMap.get(activityId) ?? new Map();
        const items = perActivityMap.get(specialDateKey) ?? [];
        items.push({
          startTime: fmtHMS(slot.start_time),
          endTime: fmtHMS(slot.end_time),
          type: 'special',
          specialDate: specialDateKey,
        });
        perActivityMap.set(specialDateKey, items);
        specialTimeSlotsMap.set(activityId, perActivityMap);
        return;
      }

      const defaults = defaultTimeSlotsMap.get(activityId) ?? [];
      defaults.push({
        startTime: fmtHMS(slot.start_time),
        endTime: fmtHMS(slot.end_time),
        type: 'default',
        specialDate: null,
      });
      defaultTimeSlotsMap.set(activityId, defaults);
    });

    const data = rows
      .map((row) => {
        const hotspot = hotspotMap.get(row.hotspot_id);
        if (destination && !hotspot) return null;
        if (selectedDate && !selectedDatePriceMap.has(row.activity_id)) return null;

        const category = inferActivityCategory(row.activity_title, row.activity_description, hotspot?.hotspot_type);
        if (
          activityType &&
          activityType !== 'All Activities' &&
          category.toLowerCase() !== activityType.toLowerCase()
        ) {
          return null;
        }

        const avgRating = ratingMap.get(row.activity_id);
        const hotspotRating = Number(hotspot?.hotspot_rating ?? 0);
        const ratingValue = avgRating?.count ? avgRating.total / avgRating.count : hotspotRating || 4.5;
        const reviewCount = avgRating?.count ?? 0;
const selectedDatePrice = selectedDate ? (selectedDatePriceMap.get(row.activity_id) ?? null) : null;

const pricingUnitType: ActivityPricingUnitType =
  selectedDate
    ? selectedDatePriceUnitTypeMap.get(row.activity_id) ??
      minPriceUnitTypeMap.get(row.activity_id) ??
      'PER_ADULT'
    : minPriceUnitTypeMap.get(row.activity_id) ?? 'PER_ADULT';

const price =
  selectedDatePrice ??
  minPriceMap.get(row.activity_id) ??
  Number(hotspot?.hotspot_adult_entry_cost ?? 0);

const location = [hotspot?.hotspot_name, hotspot?.hotspot_location].filter(Boolean).join(', ') || 'India';
        const specialSlotsForDate =
          selectedDate && fmtDateISO(selectedDate)
            ? specialTimeSlotsMap.get(row.activity_id)?.get(fmtDateISO(selectedDate) as string) ?? []
            : [];
        const timeSlots =
          selectedDate && specialSlotsForDate.length
            ? specialSlotsForDate
            : defaultTimeSlotsMap.get(row.activity_id) ?? [];

        return {
          id: row.activity_id,
          activityId: row.activity_id,
          title: row.activity_title || 'Activity',
          category,
          location,
          destination: hotspot?.hotspot_location ?? '',
          duration: formatDurationLabel(row.activity_duration ?? hotspot?.hotspot_duration),
          rating: `${ratingValue.toFixed(1)} (${reviewCount || 0})`,
          ratingValue: Number(ratingValue.toFixed(1)),
          reviewCount,
          price,
pricingUnitType,
priceUnitLabel: getActivityPriceUnitLabel(pricingUnitType),
priceLabel: price > 0 ? formatCurrencyINR(price) : 'On Request',
availableDate: selectedDate ? fmtDateISO(selectedDate) : null,
          availableOnSelectedDate: selectedDate ? selectedDatePrice != null : false,
          selectedDatePrice,
          image:
            firstImageMap.get(row.activity_id) ??
            ACTIVITY_IMAGE_FALLBACKS[category] ??
            ACTIVITY_IMAGE_FALLBACKS.Sightseeing,
          maxGuests: row.max_allowed_person_count ?? 0,
          hotspotId: row.hotspot_id,
          timeSlots,
        };
      })
      .filter(Boolean)
      .slice(0, limit);

    return { data, total: data.length };
  }

  private async ensureActivityBookingRequestsTable() {
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS dvi_activity_booking_requests (
        activity_booking_request_id INT NOT NULL AUTO_INCREMENT,
        activity_id INT NOT NULL DEFAULT 0,
        agent_id INT NOT NULL DEFAULT 0,
        activity_date DATE NULL,
        guests INT NOT NULL DEFAULT 1,
        total_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        wallet_balance_before DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        wallet_balance_after DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        salutation VARCHAR(20) NULL,
        customer_name VARCHAR(250) NULL,
        customer_phone VARCHAR(50) NULL,
        alternative_phone VARCHAR(50) NULL,
        customer_email VARCHAR(250) NULL,
        customer_age VARCHAR(20) NULL,
        nationality VARCHAR(50) NULL,
        pan_no VARCHAR(50) NULL,
        passport_no VARCHAR(80) NULL,
        destination VARCHAR(250) NULL,
        notes TEXT NULL,
        booking_status VARCHAR(50) NOT NULL DEFAULT 'confirmed',
        createdby INT NOT NULL DEFAULT 0,
        createdon DATETIME NULL,
        updatedon DATETIME NULL,
        status TINYINT NOT NULL DEFAULT 1,
        deleted TINYINT NOT NULL DEFAULT 0,
        PRIMARY KEY (activity_booking_request_id),
        INDEX idx_activity_booking_request_activity_id (activity_id),
        INDEX idx_activity_booking_request_agent_id (agent_id),
        INDEX idx_activity_booking_request_activity_date (activity_date),
        INDEX idx_activity_booking_request_status (status),
        INDEX idx_activity_booking_request_deleted (deleted),
        INDEX idx_activity_booking_request_createdon (createdon)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    const missingColumns = [
      "agent_id INT NOT NULL DEFAULT 0",
      "total_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00",
      "wallet_balance_before DECIMAL(12,2) NOT NULL DEFAULT 0.00",
      "wallet_balance_after DECIMAL(12,2) NOT NULL DEFAULT 0.00",
      "salutation VARCHAR(20) NULL",
      "alternative_phone VARCHAR(50) NULL",
      "customer_age VARCHAR(20) NULL",
      "nationality VARCHAR(50) NULL",
      "pan_no VARCHAR(50) NULL",
      "passport_no VARCHAR(80) NULL",
      "destination VARCHAR(250) NULL",
    ];

    for (const definition of missingColumns) {
      const [columnName] = definition.split(' ');
      const rows = await this.prisma.$queryRaw<Array<{ count: bigint | number }>>(
        Prisma.sql`
          SELECT COUNT(*) AS count
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'dvi_activity_booking_requests'
            AND COLUMN_NAME = ${columnName}
        `,
      );

      if (Number(rows?.[0]?.count ?? 0) === 0) {
        await this.prisma.$executeRawUnsafe(
          `ALTER TABLE dvi_activity_booking_requests ADD COLUMN ${definition}`,
        );
      }
    }

    const agentIndexRows = await this.prisma.$queryRaw<Array<{ count: bigint | number }>>(
      Prisma.sql`
        SELECT COUNT(*) AS count
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'dvi_activity_booking_requests'
          AND INDEX_NAME = 'idx_activity_booking_request_agent_id'
      `,
    );

    if (Number(agentIndexRows?.[0]?.count ?? 0) === 0) {
      await this.prisma.$executeRawUnsafe(
        'ALTER TABLE dvi_activity_booking_requests ADD INDEX idx_activity_booking_request_agent_id (agent_id)',
      );
    }
  }

  async getStorefrontAgents() {
    const rows = await this.prisma.dvi_agent.findMany({
      where: {
        deleted: 0,
        status: 1,
      },
      orderBy: [
        { total_cash_wallet: 'desc' },
        { agent_name: 'asc' },
      ],
      select: {
        agent_ID: true,
        agent_name: true,
        agent_lastname: true,
        agent_email_id: true,
        agent_primary_mobile_number: true,
        total_cash_wallet: true,
      },
    });

    return {
      data: rows.map((row) => {
        const firstName = String(row.agent_name ?? '').trim();
        const lastName = String(row.agent_lastname ?? '').trim();
        const name = [firstName, lastName].filter(Boolean).join(' ').trim();

        return {
          id: Number(row.agent_ID),
          name: name || `Agent ${row.agent_ID}`,
          email: row.agent_email_id ?? '',
          phone: row.agent_primary_mobile_number ?? '',
          walletBalance: Number(row.total_cash_wallet ?? 0),
          walletBalanceLabel: formatCurrencyINR(Number(row.total_cash_wallet ?? 0)),
        };
      }),
    };
  }

  async getStorefrontAgentWallet(agentId: number) {
    const agent = await this.prisma.dvi_agent.findFirst({
      where: {
        agent_ID: agentId,
        deleted: 0,
        status: 1,
      },
      select: {
        agent_ID: true,
        agent_name: true,
        agent_lastname: true,
        total_cash_wallet: true,
      },
    });

    if (!agent) {
      throw new NotFoundException('Agent not found');
    }

    const balance = Number(agent.total_cash_wallet ?? 0);

    return {
      data: {
        agentId: Number(agent.agent_ID),
        agentName: [agent.agent_name, agent.agent_lastname].filter(Boolean).join(' ').trim(),
        balance,
        formattedBalance: formatCurrencyINR(balance),
      },
    };
  }

  private async ensureActivityWishlistTable() {
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS dvi_activity_wishlist (
        activity_wishlist_id INT NOT NULL AUTO_INCREMENT,
        activity_id INT NOT NULL DEFAULT 0,
        user_key VARCHAR(120) NOT NULL DEFAULT 'admin',
        createdon DATETIME NULL,
        updatedon DATETIME NULL,
        status TINYINT NOT NULL DEFAULT 1,
        deleted TINYINT NOT NULL DEFAULT 0,
        PRIMARY KEY (activity_wishlist_id),
        UNIQUE KEY uniq_activity_wishlist_user_activity (user_key, activity_id),
        INDEX idx_activity_wishlist_activity_id (activity_id),
        INDEX idx_activity_wishlist_user_key (user_key),
        INDEX idx_activity_wishlist_status_deleted (status, deleted)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  }

  private normalizeWishlistUserKey(userKey?: string | null) {
    const clean = String(userKey ?? '').trim();
    return clean || 'admin';
  }

  private async buildStorefrontCardsByIds(activityIds: number[]) {
    const uniqueIds = Array.from(
      new Set(activityIds.map((id) => toInt(id, 0)).filter((id) => id > 0)),
    );

    if (!uniqueIds.length) return [];

    const rows = await this.prisma.dvi_activity.findMany({
      where: {
        activity_id: { in: uniqueIds },
        deleted: 0,
        status: 1,
      },
      select: {
        activity_id: true,
        activity_title: true,
        hotspot_id: true,
        max_allowed_person_count: true,
        activity_duration: true,
        activity_description: true,
      },
    });

    const hotspotIds = Array.from(
      new Set(rows.map((row) => row.hotspot_id).filter(Boolean)),
    );

    const [hotspots, images, priceRows, reviewRows] = await Promise.all([
      hotspotIds.length
        ? this.prisma.dvi_hotspot_place.findMany({
            where: {
              hotspot_ID: { in: hotspotIds as number[] },
              deleted: 0,
              status: 1,
            },
            select: {
              hotspot_ID: true,
              hotspot_name: true,
              hotspot_location: true,
              hotspot_type: true,
              hotspot_rating: true,
              hotspot_adult_entry_cost: true,
              hotspot_duration: true,
            },
          })
        : Promise.resolve([]),

      uniqueIds.length
        ? this.prisma.dvi_activity_image_gallery_details.findMany({
            where: {
              activity_id: { in: uniqueIds },
              deleted: 0,
              status: 1,
            },
            orderBy: {
              activity_image_gallery_details_id: 'asc',
            },
            select: {
              activity_id: true,
              activity_image_gallery_name: true,
            },
          })
        : Promise.resolve([]),

uniqueIds.length
  ? this.prisma.dvi_activity_pricebook.findMany({
      where: {
        activity_id: { in: uniqueIds },
        deleted: 0,
        status: 1,
        nationality: 1,
        price_type: {
          in: [ACTIVITY_PRICE_TYPE_ADULT, ACTIVITY_PRICE_TYPE_UNIT],
        },
      },
      select: {
        activity_id: true,
        price_type: true,
        day_1: true,
      },
    })
        : Promise.resolve([]),

      uniqueIds.length
        ? this.prisma.dvi_activity_review_details.findMany({
            where: {
              activity_id: { in: uniqueIds },
              deleted: 0,
              status: 1,
            },
            select: {
              activity_id: true,
              activity_rating: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const hotspotMap = new Map(hotspots.map((hotspot) => [hotspot.hotspot_ID, hotspot]));

    const firstImageMap = new Map<number, string>();
    images.forEach((image) => {
      const activityId = Number(image.activity_id ?? 0);
      if (!activityId || firstImageMap.has(activityId)) return;

      const imageUrl = imageUrlFromGalleryName(image.activity_image_gallery_name);
      if (imageUrl) firstImageMap.set(activityId, imageUrl);
    });

    const minPriceMap = new Map<number, number>();
const minPriceUnitTypeMap = new Map<number, ActivityPricingUnitType>();

priceRows.forEach((row) => {
  const activityId = Number(row.activity_id ?? 0);
  const price = Number(row.day_1 ?? 0);
  const pricingUnitType: ActivityPricingUnitType =
    Number(row.price_type) === ACTIVITY_PRICE_TYPE_UNIT ? 'UNIT' : 'PER_ADULT';

  setPreferredActivityPrice(
    minPriceMap,
    minPriceUnitTypeMap,
    activityId,
    price,
    pricingUnitType,
  );
});

    const ratingMap = new Map<number, { total: number; count: number }>();
    reviewRows.forEach((row) => {
      const activityId = Number(row.activity_id ?? 0);
      const rating = Number(row.activity_rating ?? 0);
      if (!activityId || !rating) return;

      const current = ratingMap.get(activityId) ?? { total: 0, count: 0 };
      current.total += rating;
      current.count += 1;
      ratingMap.set(activityId, current);
    });

    const cardMap = new Map(
      rows.map((row) => {
        const hotspot = hotspotMap.get(row.hotspot_id);
        const category = inferActivityCategory(
          row.activity_title,
          row.activity_description,
          hotspot?.hotspot_type,
        );

        const avgRating = ratingMap.get(row.activity_id);
        const hotspotRating = Number(hotspot?.hotspot_rating ?? 0);
        const ratingValue = avgRating?.count
          ? avgRating.total / avgRating.count
          : hotspotRating || 4.5;

const reviewCount = avgRating?.count ?? 0;

const pricingUnitType: ActivityPricingUnitType =
  minPriceUnitTypeMap.get(row.activity_id) ?? 'PER_ADULT';

const price =
  minPriceMap.get(row.activity_id) ??
  Number(hotspot?.hotspot_adult_entry_cost ?? 0);

const location =
          [hotspot?.hotspot_name, hotspot?.hotspot_location].filter(Boolean).join(', ') ||
          'India';

        return [
          row.activity_id,
          {
            id: row.activity_id,
            activityId: row.activity_id,
            title: row.activity_title || 'Activity',
            category,
            location,
            destination: hotspot?.hotspot_location ?? '',
            duration: formatDurationLabel(row.activity_duration ?? hotspot?.hotspot_duration),
            rating: `${ratingValue.toFixed(1)} (${reviewCount || 0})`,
            ratingValue: Number(ratingValue.toFixed(1)),
            reviewCount,
            price,
pricingUnitType,
priceUnitLabel: getActivityPriceUnitLabel(pricingUnitType),
priceLabel: price > 0 ? formatCurrencyINR(price) : 'On Request',
image:
              firstImageMap.get(row.activity_id) ??
              ACTIVITY_IMAGE_FALLBACKS[category] ??
              ACTIVITY_IMAGE_FALLBACKS.Sightseeing,
            maxGuests: row.max_allowed_person_count ?? 0,
            hotspotId: row.hotspot_id,
          },
        ] as const;
      }),
    );

    return uniqueIds.map((id) => cardMap.get(id)).filter(Boolean);
  }

  async getStorefrontWishlist(userKey?: string) {
    await this.ensureActivityWishlistTable();

    const safeUserKey = this.normalizeWishlistUserKey(userKey);

    const rows = await this.prisma.$queryRaw<
      Array<{
        activity_wishlist_id: number;
        activity_id: number;
        createdon: Date | null;
      }>
    >(
      Prisma.sql`
        SELECT activity_wishlist_id, activity_id, createdon
        FROM dvi_activity_wishlist
        WHERE user_key = ${safeUserKey}
          AND status = 1
          AND deleted = 0
        ORDER BY activity_wishlist_id DESC
      `,
    );

    const activityIds = rows.map((row) => Number(row.activity_id));
    const cards = await this.buildStorefrontCardsByIds(activityIds);

    return {
      data: cards.map((card) => {
        const wishlistRow = rows.find(
          (row) => Number(row.activity_id) === Number(card.activityId),
        );

        return {
          ...card,
          wishlistId: Number(wishlistRow?.activity_wishlist_id ?? 0),
          wishlistedAt: fmtDateTimeISO(wishlistRow?.createdon),
        };
      }),
    };
  }

  async toggleStorefrontWishlist(body: { activityId: number; userKey?: string }) {
    await this.ensureActivityWishlistTable();

    const activityId = toInt(body?.activityId, 0);
    if (!activityId) throw new BadRequestException('activityId required');

    const activity = await this.prisma.dvi_activity.findFirst({
      where: {
        activity_id: activityId,
        deleted: 0,
        status: 1,
      },
      select: {
        activity_id: true,
        activity_title: true,
      },
    });

    if (!activity) throw new NotFoundException('Activity not found');

    const safeUserKey = this.normalizeWishlistUserKey(body?.userKey);

    const existing = await this.prisma.$queryRaw<
      Array<{
        activity_wishlist_id: number;
        deleted: number;
        status: number;
      }>
    >(
      Prisma.sql`
        SELECT activity_wishlist_id, deleted, status
        FROM dvi_activity_wishlist
        WHERE user_key = ${safeUserKey}
          AND activity_id = ${activityId}
        LIMIT 1
      `,
    );

    const row = existing?.[0];

    if (!row) {
      await this.prisma.$executeRaw(
        Prisma.sql`
          INSERT INTO dvi_activity_wishlist
            (activity_id, user_key, createdon, status, deleted)
          VALUES
            (${activityId}, ${safeUserKey}, ${new Date()}, 1, 0)
        `,
      );

      return {
        data: {
          activityId,
          wished: true,
          message: `${activity.activity_title || 'Activity'} added to wishlist`,
        },
      };
    }

    const shouldEnable = Number(row.deleted) === 1 || Number(row.status) !== 1;

    await this.prisma.$executeRaw(
      Prisma.sql`
        UPDATE dvi_activity_wishlist
        SET
          status = ${shouldEnable ? 1 : 0},
          deleted = ${shouldEnable ? 0 : 1},
          updatedon = ${new Date()}
        WHERE activity_wishlist_id = ${Number(row.activity_wishlist_id)}
      `,
    );

    return {
      data: {
        activityId,
        wished: shouldEnable,
        message: shouldEnable
          ? `${activity.activity_title || 'Activity'} added to wishlist`
          : `${activity.activity_title || 'Activity'} removed from wishlist`,
      },
    };
  }

  async removeStorefrontWishlist(activityId: number, userKey?: string) {
    await this.ensureActivityWishlistTable();

    const safeActivityId = toInt(activityId, 0);
    if (!safeActivityId) throw new BadRequestException('activityId required');

    const safeUserKey = this.normalizeWishlistUserKey(userKey);

    await this.prisma.$executeRaw(
      Prisma.sql`
        UPDATE dvi_activity_wishlist
        SET status = 0,
            deleted = 1,
            updatedon = ${new Date()}
        WHERE activity_id = ${safeActivityId}
          AND user_key = ${safeUserKey}
      `,
    );

    return {
      data: {
        activityId: safeActivityId,
        wished: false,
        message: 'Activity removed from wishlist',
      },
    };
  }

  async getStorefrontBookings(opts: {
    agentId?: string;
    status?: string;
    q?: string;
    limit?: string;
  }) {
    await this.ensureActivityBookingRequestsTable();

    const agentId = toInt(opts?.agentId, 0);
    const status = String(opts?.status ?? '').trim();
    const q = String(opts?.q ?? '').trim();
    const limit = Math.min(Math.max(toInt(opts?.limit, 25), 1), 100);

    const rows = await this.prisma.$queryRaw<
      Array<{
        activity_booking_request_id: number;
        activity_id: number;
        agent_id: number;
        activity_date: Date | null;
        guests: number;
        total_amount: Prisma.Decimal | number | string;
        wallet_balance_before: Prisma.Decimal | number | string;
        wallet_balance_after: Prisma.Decimal | number | string;
        salutation: string | null;
        customer_name: string | null;
        customer_phone: string | null;
        customer_email: string | null;
        destination: string | null;
        booking_status: string | null;
        createdon: Date | null;
        activity_title: string | null;
        agent_name: string | null;
        agent_lastname: string | null;
      }>
    >(
      Prisma.sql`
        SELECT
          b.activity_booking_request_id,
          b.activity_id,
          b.agent_id,
          b.activity_date,
          b.guests,
          b.total_amount,
          b.wallet_balance_before,
          b.wallet_balance_after,
          b.salutation,
          b.customer_name,
          b.customer_phone,
          b.customer_email,
          b.destination,
          b.booking_status,
          b.createdon,
          a.activity_title,
          ag.agent_name,
          ag.agent_lastname
        FROM dvi_activity_booking_requests b
        LEFT JOIN dvi_activity a ON a.activity_id = b.activity_id
        LEFT JOIN dvi_agent ag ON ag.agent_ID = b.agent_id
        WHERE b.deleted = 0
          AND b.status = 1
          ${agentId ? Prisma.sql`AND b.agent_id = ${agentId}` : Prisma.empty}
          ${status ? Prisma.sql`AND b.booking_status = ${status}` : Prisma.empty}
          ${
            q
              ? Prisma.sql`
                  AND (
                    b.customer_name LIKE ${`%${q}%`}
                    OR b.customer_phone LIKE ${`%${q}%`}
                    OR b.customer_email LIKE ${`%${q}%`}
                    OR b.destination LIKE ${`%${q}%`}
                    OR a.activity_title LIKE ${`%${q}%`}
                  )
                `
              : Prisma.empty
          }
        ORDER BY b.activity_booking_request_id DESC
        LIMIT ${limit}
      `,
    );

    return {
      data: {
        items: rows.map((row) => {
          const totalAmount = Number(row.total_amount ?? 0);
          const walletBefore = Number(row.wallet_balance_before ?? 0);
          const walletAfter = Number(row.wallet_balance_after ?? 0);
          const agentName = [row.agent_name, row.agent_lastname]
            .filter(Boolean)
            .join(' ')
            .trim();

          return {
            bookingRequestId: Number(row.activity_booking_request_id),
            activityId: Number(row.activity_id),
            activityTitle: row.activity_title || `Activity ${row.activity_id}`,
            agentId: Number(row.agent_id),
            agentName: agentName || `Agent ${row.agent_id}`,
            activityDate: fmtDateISO(row.activity_date),
            guests: Number(row.guests ?? 1),
            totalAmount,
            totalAmountLabel: formatCurrencyINR(totalAmount),
            walletBalanceBefore: walletBefore,
            walletBalanceBeforeLabel: formatCurrencyINR(walletBefore),
            walletBalanceAfter: walletAfter,
            walletBalanceAfterLabel: formatCurrencyINR(walletAfter),
            salutation: row.salutation ?? '',
            customerName: row.customer_name ?? '',
            customerPhone: row.customer_phone ?? '',
            customerEmail: row.customer_email ?? '',
            destination: row.destination ?? '',
            status: row.booking_status ?? 'confirmed',
            createdOn: fmtDateTimeISO(row.createdon),
          };
        }),
        total: rows.length,
      },
    };
  }

  async createStorefrontBooking(dto: CreateActivityBookingDto) {
    const activityId = toInt(dto.activityId, 0);
    const agentId = toInt(dto.agentId, 0);
    const guests = Math.max(toInt(dto.guests, 1), 1);
    const totalAmount = Number(dto.totalAmount || 0);

    if (!activityId) throw new BadRequestException('activityId required');
    if (!agentId) throw new BadRequestException('agentId required');
    if (!dto.customerName?.trim()) throw new BadRequestException('customerName required');
    if (!dto.customerPhone?.trim()) throw new BadRequestException('customerPhone required');
    if (totalAmount <= 0) throw new BadRequestException('totalAmount must be greater than zero');

    const activity = await this.prisma.dvi_activity.findFirst({
      where: { activity_id: activityId, deleted: 0, status: 1 },
      select: { activity_id: true, activity_title: true, max_allowed_person_count: true },
    });
    if (!activity) throw new NotFoundException('Activity not found');

    if (activity.max_allowed_person_count && guests > activity.max_allowed_person_count) {
      throw new BadRequestException(`Maximum allowed guests for this activity is ${activity.max_allowed_person_count}`);
    }

    const agent = await this.prisma.dvi_agent.findFirst({
      where: {
        agent_ID: agentId,
        deleted: 0,
        status: 1,
      },
      select: {
        agent_ID: true,
        agent_name: true,
        agent_lastname: true,
        total_cash_wallet: true,
      },
    });

    if (!agent) throw new NotFoundException('Agent not found');

    const walletBefore = Number(agent.total_cash_wallet ?? 0);
    if (walletBefore < totalAmount) {
      throw new BadRequestException(
        `Insufficient wallet balance. Available ${formatCurrencyINR(walletBefore)}, required ${formatCurrencyINR(totalAmount)}`,
      );
    }

    const walletAfter = walletBefore - totalAmount;
    const activityDate = toDateOnly(dto.activityDate ?? dto.travelDate);
    const notes = [dto.notes, dto.remarks].filter(Boolean).join(' | ') || null;

    await this.ensureActivityBookingRequestsTable();

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.dvi_agent.update({
        where: {
          agent_ID: agentId,
        },
        data: {
          total_cash_wallet: new Prisma.Decimal(walletAfter),
        },
      });

      await tx.$executeRaw(
        Prisma.sql`INSERT INTO dvi_activity_booking_requests
          (
            activity_id,
            agent_id,
            activity_date,
            guests,
            total_amount,
            wallet_balance_before,
            wallet_balance_after,
            salutation,
            customer_name,
            customer_phone,
            alternative_phone,
            customer_email,
            customer_age,
            nationality,
            pan_no,
            passport_no,
            destination,
            notes,
            booking_status,
            createdby,
            createdon,
            status,
            deleted
          )
          VALUES
          (
            ${activityId},
            ${agentId},
            ${activityDate},
            ${guests},
            ${totalAmount},
            ${walletBefore},
            ${walletAfter},
            ${dto.salutation ?? null},
            ${dto.customerName},
            ${dto.customerPhone},
            ${dto.alternativePhone ?? null},
            ${dto.customerEmail ?? null},
            ${dto.customerAge ?? null},
            ${dto.nationality ?? 'IN'},
            ${dto.panNo ?? null},
            ${dto.passportNo ?? null},
            ${dto.destination ?? null},
            ${notes},
            'confirmed',
            ${toInt(dto.createdby, 0)},
            ${new Date()},
            1,
            0
          )`,
      );

      const insertedRows = await tx.$queryRaw<Array<{ id: bigint | number }>>(
        Prisma.sql`SELECT LAST_INSERT_ID() AS id`,
      );

      return {
        bookingRequestId: Number(insertedRows?.[0]?.id ?? 0),
      };
    });

    return {
      ok: true,
      bookingRequestId: result.bookingRequestId,
      status: 'confirmed',
      activityId,
      activityTitle: activity.activity_title ?? dto.activityTitle ?? null,
      agentId,
      agentName: [agent.agent_name, agent.agent_lastname].filter(Boolean).join(' ').trim(),
      guests,
      totalAmount,
      totalAmountLabel: formatCurrencyINR(totalAmount),
      walletBalanceBefore: walletBefore,
      walletBalanceAfter: walletAfter,
      walletBalanceAfterLabel: formatCurrencyINR(walletAfter),
      activityDate: fmtDateISO(activityDate),
      message: 'Activity booking confirmed and agent wallet deducted successfully',
    };
  }

 // ====== LIST ======
  async list(opts: { q?: string; status?: StatusFilter }) {
    try {
 console.log('[ActivitiesService] list called with opts:', opts);
      const where: any = {
        deleted: 0,
      };
      if (opts?.status === '0' || opts?.status === '1') {
        where.status = toInt(opts.status);
      }
      if (opts?.q) {
        where.OR = [{ activity_title: { contains: opts.q } }];
      }

 console.log('[ActivitiesService] list where:', JSON.stringify(where));

 // Join hotspot for name/location
      const rows = await this.prisma.dvi_activity.findMany({
        where,
        orderBy: { activity_id: 'desc' },
        select: {
          activity_id: true,
          activity_title: true,
          hotspot_id: true,
          status: true,
        },
      });
 console.log('[ActivitiesService] found rows:', rows.length);

 // fetch hotspot details map
      const hotspotIds = Array.from(new Set(rows.map((r) => r.hotspot_id).filter((id) => id && id !== 0)));
      let hotspotMap = new Map<number, { name: string; location: string }>();
      if (hotspotIds.length) {
        const hotspots = await this.prisma.dvi_hotspot_place.findMany({
          where: { hotspot_ID: { in: hotspotIds as any } },
          select: {
            hotspot_ID: true,
            hotspot_name: true,
            hotspot_location: true,
          },
        });
        hotspots.forEach((h) => {
          hotspotMap.set(h.hotspot_ID, {
            name: h.hotspot_name ?? '',
            location: h.hotspot_location ?? '',
          });
        });
      }

      let counter = 0;
      const data = rows.map((r) => {
        const hp = hotspotMap.get(r.hotspot_id) ?? { name: '', location: '' };
        return {
          counter: ++counter,
 modify: r.activity_id, // keep parity with PHP JSON field
          activity_title: r.activity_title ?? '',
          hotspot_name: hp.name,
          hotspot_location: hp.location,
          status: r.status,
          activity_id: r.activity_id,
        };
      });
 console.log('[ActivitiesService] returning data count:', data.length);

      return { data };
    } catch (error) {
 console.error('[ActivitiesService] list error:', error);
      throw error;
    }
  }

 // ====== HOTSPOTS for dropdown ======
  async hotspots(q?: string) {
    const where: any = { deleted: 0, status: 1 };
    if (q) {
      where.OR = [{ hotspot_name: { contains: q } }, { hotspot_location: { contains: q } }];
    }
    const rows = await this.prisma.dvi_hotspot_place.findMany({
      where,
      orderBy: [{ hotspot_priority: 'desc' }, { hotspot_name: 'asc' }],
      select: { hotspot_ID: true, hotspot_name: true, hotspot_location: true },
    });
    return rows.map((r) => ({
      id: r.hotspot_ID,
      label: [r.hotspot_name, r.hotspot_location].filter(Boolean).join(' — '),
    }));
  }

 // ====== CREATE BASIC INFO ======
  async createActivity(dto: {
    activity_title: string;
    hotspot_id: number | string;
    max_allowed_person_count: number | string;
 activity_duration?: string; // "HH:MM[:SS]"
    activity_description?: string;
    createdby?: number;
 // gallery (optional at create)
    imageNames?: string[];
 // default slots
    defaultSlots?: Array<{ start_time: string; end_time: string }>;
 // special day slots (optional)
    specialEnabled?: boolean;
    specialSlots?: Array<{ date: string; start_time: string; end_time: string }>;
  }) {
    if (!dto.activity_title) throw new BadRequestException('activity_title required');
    const hotspotId = toInt(dto.hotspot_id, 0);
    if (!hotspotId) throw new BadRequestException('hotspot_id required');
    const createdby = toInt(dto.createdby, 0);

    const created = await this.prisma.dvi_activity.create({
      data: {
        activity_title: dto.activity_title,
        hotspot_id: hotspotId,
        max_allowed_person_count: toInt(dto.max_allowed_person_count, 0),
        activity_duration: toTimeDate(dto.activity_duration),
        activity_description: dto.activity_description ?? null,
        createdby,
        status: 1,
        deleted: 0,
        createdon: new Date(),
      },
    });

 // gallery
    if (dto.imageNames?.length) {
      await this.prisma.dvi_activity_image_gallery_details.createMany({
        data: dto.imageNames.map((name) => ({
          activity_id: created.activity_id,
          activity_image_gallery_name: name,
          createdby,
          status: 1,
          deleted: 0,
          createdon: new Date(),
        })),
      });
    }

 // default time slots
    if (dto.defaultSlots?.length) {
      await this.prisma.dvi_activity_time_slot_details.createMany({
        data: dto.defaultSlots.map((s) => ({
          activity_id: created.activity_id,
 time_slot_type: 1, // Default
          special_date: null,
          start_time: toTimeDate(s.start_time),
          end_time: toTimeDate(s.end_time),
          createdby,
          status: 1,
          deleted: 0,
          createdon: new Date(),
        })),
      });
    }

 // special time slots
    if (dto.specialEnabled && dto.specialSlots?.length) {
      await this.prisma.dvi_activity_time_slot_details.createMany({
        data: dto.specialSlots.map((s) => ({
          activity_id: created.activity_id,
 time_slot_type: 2, // Special
          special_date: toDateOnly(s.date),
          start_time: toTimeDate(s.start_time),
          end_time: toTimeDate(s.end_time),
          createdby,
          status: 1,
          deleted: 0,
          createdon: new Date(),
        })),
      });
    }

    return created;
  }

 // ====== UPDATE BASIC INFO ======
  async updateActivity(
    id: number,
    dto: {
      activity_title?: string;
      hotspot_id?: number | string;
      max_allowed_person_count?: number | string;
      activity_duration?: string;
      activity_description?: string;
      updatedby?: number;
    },
  ) {
    const existing = await this.prisma.dvi_activity.findFirst({ where: { activity_id: id, deleted: 0 } });
    if (!existing) throw new NotFoundException('Activity not found');

    return this.prisma.dvi_activity.update({
      where: { activity_id: id },
      data: {
        activity_title: dto.activity_title ?? existing.activity_title,
        hotspot_id: dto.hotspot_id != null ? toInt(dto.hotspot_id) : existing.hotspot_id,
        max_allowed_person_count:
          dto.max_allowed_person_count != null ? toInt(dto.max_allowed_person_count) : existing.max_allowed_person_count,
        activity_duration: dto.activity_duration != null ? toTimeDate(dto.activity_duration) : existing.activity_duration,
        activity_description: dto.activity_description ?? existing.activity_description,
        updatedon: new Date(),
      },
    });
  }

 // ====== STATUS / DELETE ======
  async toggleStatus(id: number, status: number) {
    const existing = await this.prisma.dvi_activity.findFirst({ where: { activity_id: id, deleted: 0 } });
    if (!existing) throw new NotFoundException('Activity not found');
    return this.prisma.dvi_activity.update({
      where: { activity_id: id },
      data: { status: toInt(status) },
    });
  }

  async softDelete(id: number) {
    try {
 console.log('[ActivitiesService] softDelete called for id:', id);
      const existing = await this.prisma.dvi_activity.findFirst({
        where: { activity_id: id, deleted: 0 },
      });
      if (!existing) {
 console.warn('[ActivitiesService] softDelete: activity not found or already deleted:', id);
        throw new NotFoundException('Activity not found');
      }
      const result = await this.prisma.dvi_activity.update({
        where: { activity_id: id },
        data: { deleted: 1, updatedon: new Date() },
      });
 console.log('[ActivitiesService] softDelete success for id:', id);
      return result;
    } catch (error) {
 console.error('[ActivitiesService] softDelete error for id:', id, error);
      throw error;
    }
  }

 // ====== GALLERY ======
  async addImages(activityId: number, imageNames: string[], createdby: number) {
    if (!imageNames?.length) return { count: 0 };
    const existing = await this.prisma.dvi_activity.findFirst({ where: { activity_id: activityId, deleted: 0 } });
    if (!existing) throw new NotFoundException('Activity not found');

    const res = await this.prisma.dvi_activity_image_gallery_details.createMany({
      data: imageNames.map((name) => ({
        activity_id: activityId,
        activity_image_gallery_name: name,
        createdby,
        status: 1,
        deleted: 0,
        createdon: new Date(),
      })),
    });
    return res;
  }

 // ---- NEW: Save uploaded files (from Multer) into DB (filenames only)
  async saveUploadedImages(
    activityId: number,
    files: Express.Multer.File[],
    createdby: number,
  ) {
    if (!files?.length) return { count: 0, files: [] };

    const existing = await this.prisma.dvi_activity.findFirst({
      where: { activity_id: activityId, deleted: 0 },
      select: { activity_id: true },
    });
    if (!existing) throw new NotFoundException('Activity not found');

    const now = new Date();
    const data = files.map((f) => ({
      activity_id: activityId,
 activity_image_gallery_name: f.filename, // stored by Multer
      createdby: toInt(createdby, 0),
      status: 1,
      deleted: 0,
      createdon: now,
    }));


    const created = await Promise.all(
      data.map((d) => this.prisma.dvi_activity_image_gallery_details.create({ data: d as any })),
    );

    return {
      count: created.length,
      files: created.map((r) => r.activity_image_gallery_name),
      ids: created.map((r) => r.activity_image_gallery_details_id),
    };
  }

  async deleteImage(activityId: number, imageId: number) {
 // optional: verify image belongs to activity
    await this.prisma.dvi_activity_image_gallery_details.delete({
      where: { activity_image_gallery_details_id: imageId },
    });
    return { ok: true };
  }

 // ====== TIME SLOTS ======
  async saveTimeSlots(
    activityId: number,
    dto: {
      defaultSlots?: Array<{ start_time: string; end_time: string }>;
      specialEnabled?: boolean;
      specialSlots?: Array<{ date: string; start_time: string; end_time: string }>;
      createdby?: number;
    },
  ) {
    const existing = await this.prisma.dvi_activity.findFirst({ where: { activity_id: activityId, deleted: 0 } });
    if (!existing) throw new NotFoundException('Activity not found');

 // Strategy (parity with PHP UX):
 // - Remove existing default/special slots then re-insert provided
    await this.prisma.dvi_activity_time_slot_details.deleteMany({
      where: { activity_id: activityId },
    });

    const createdby = toInt(dto.createdby, 0);
    const data: any[] = [];

    if (dto.defaultSlots?.length) {
      for (const s of dto.defaultSlots) {
        data.push({
          activity_id: activityId,
          time_slot_type: 1,
          special_date: null,
          start_time: toTimeDate(s.start_time),
          end_time: toTimeDate(s.end_time),
          createdby,
          status: 1,
          deleted: 0,
          createdon: new Date(),
        });
      }
    }
    if (dto.specialEnabled && dto.specialSlots?.length) {
      for (const s of dto.specialSlots) {
        data.push({
          activity_id: activityId,
          time_slot_type: 2,
          special_date: toDateOnly(s.date),
          start_time: toTimeDate(s.start_time),
          end_time: toTimeDate(s.end_time),
          createdby,
          status: 1,
          deleted: 0,
          createdon: new Date(),
        });
      }
    }
    if (data.length) {
      await this.prisma.dvi_activity_time_slot_details.createMany({ data });
    }
    return { ok: true, count: data.length };
  }

 // ====== PRICEBOOK (month rows with 31 day columns) ======
  async getPriceBook(activityId: number) {
  const rows = await this.prisma.dvi_activity_pricebook.findMany({
    where: { activity_id: activityId, deleted: 0, status: 1 },
    orderBy: [{ nationality: 'asc' }, { price_type: 'asc' }],
  });
  if (!rows.length) return null;

 // Derive start/end date from rows
  const years = rows.map((r) => Number(r.year));
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  const monthNums: number[] = [];
  rows.forEach((r) => {
    const m = new Date(`${r.year}-01-01`).getFullYear() === Number(r.year)
      ? new Date(`1 ${r.month} 2000`).getMonth() + 1
      : 1;
    monthNums.push(m);
  });
  const minMonth = Math.min(...monthNums);
  const maxMonth = Math.max(...monthNums);

  const startDate = `${minYear}-${String(minMonth).padStart(2, '0')}-01`;
  const lastDay = new Date(maxYear, maxMonth, 0).getDate();
  const endDate = `${maxYear}-${String(maxMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

 // Extract per-type prices from day_1 value (uniform per row)
  const getPrice = (nat: number, type: number): number => {
    const row = rows.find((r) => Number(r.nationality) === nat && Number(r.price_type) === type);
    return row ? Number((row as any).day_1 ?? 0) : 0;
  };

  const indianUnitCost = getPrice(1, ACTIVITY_PRICE_TYPE_UNIT);
  const nonIndianUnitCost = getPrice(2, ACTIVITY_PRICE_TYPE_UNIT);

  const pricingUnitType: ActivityPricingUnitType =
    indianUnitCost > 0 || nonIndianUnitCost > 0 ? 'UNIT' : 'PER_ADULT';

  return {
    start_date: startDate,
    end_date: endDate,
    pricing_unit_type: pricingUnitType,
    hotspot_id: rows[0]?.hotspot_id ? Number(rows[0].hotspot_id) : null,
    indian: {
      adult_cost: getPrice(1, ACTIVITY_PRICE_TYPE_ADULT),
      child_cost: getPrice(1, ACTIVITY_PRICE_TYPE_CHILD),
      infant_cost: getPrice(1, ACTIVITY_PRICE_TYPE_INFANT),
      unit_cost: indianUnitCost,
    },
    nonindian: {
      adult_cost: getPrice(2, ACTIVITY_PRICE_TYPE_ADULT),
      child_cost: getPrice(2, ACTIVITY_PRICE_TYPE_CHILD),
      infant_cost: getPrice(2, ACTIVITY_PRICE_TYPE_INFANT),
      unit_cost: nonIndianUnitCost,
    },
  };
}

  async savePriceBook(
  activityId: number,
  dto: {
 hotspot_id: number | string; // BigInt in schema
 start_date: string; // yyyy-mm-dd
 end_date: string; // yyyy-mm-dd
    pricing_unit_type?: ActivityPricingUnitType | string;
    createdby?: number;
 // flags per nationality
    indian?: {
      adult_cost?: number | string;
      child_cost?: number | string;
      infant_cost?: number | string;
      unit_cost?: number | string;
    };
    nonindian?: {
      adult_cost?: number | string;
      child_cost?: number | string;
      infant_cost?: number | string;
      unit_cost?: number | string;
    };
  },
) {
  const existing = await this.prisma.dvi_activity.findFirst({ where: { activity_id: activityId, deleted: 0 } });
  if (!existing) throw new NotFoundException('Activity not found');

  const hotspotId = toBigIntSafe(dto.hotspot_id);
  const start = toDateOnly(dto.start_date);
  const end = toDateOnly(dto.end_date);
  if (!start || !end || start > end) throw new BadRequestException('Invalid date range');

  const createdby = toInt(dto.createdby, 0);

  const indianUnitCost = toFloat(dto.indian?.unit_cost, 0);
  const nonIndianUnitCost = toFloat(dto.nonindian?.unit_cost, 0);

  const pricingUnitType = normalizeActivityPricingUnitType(
    dto.pricing_unit_type ??
      (indianUnitCost > 0 || nonIndianUnitCost > 0 ? 'UNIT' : 'PER_ADULT'),
  );

 // Expand month by month
  const months: Array<{ y: number; m: number }> = [];
  {
    const cur = new Date(start);
    cur.setDate(1);
    const endMonth = new Date(end);
    endMonth.setDate(1);
    while (cur <= endMonth) {
      months.push({ y: cur.getFullYear(), m: cur.getMonth() + 1 });
      cur.setMonth(cur.getMonth() + 1);
    }
  }

  const deactivatePriceTypes = async (priceTypes: number[]) => {
    for (const { y, m } of months) {
      const monthName = new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long' });

      await this.prisma.dvi_activity_pricebook.updateMany({
        where: {
          activity_id: activityId,
          hotspot_id: hotspotId,
          price_type: {
            in: priceTypes,
          },
          year: String(y),
 // @ts-ignore (Prisma model has `month` as string, e.g. "January")
          month: monthName,
          deleted: 0,
        },
        data: {
          status: 0,
          deleted: 1,
          updatedon: new Date(),
        } as any,
      });
    }
  };

 // helper to upsert a month row with a flat price across all days in that month
  const upsertMonth = async (year: number, month: number, priceType: number, nationality: number, value: number) => {
    const yyyy = String(year);
 const monthName = new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'long' }); // e.g., "January"
    const dayVals: Record<string, number> = {};
 // fill all possible day1..31 with the price; PHP does the same when a month row is created
    for (let d = 1; d <= 31; d++) {
      dayVals[`day_${d}`] = value;
    }

    const existingRow = await this.prisma.dvi_activity_pricebook.findFirst({
      where: {
        activity_id: activityId,
        hotspot_id: hotspotId,
        nationality,
        price_type: priceType,
        year: yyyy,
 // @ts-ignore (Prisma model has `month` as string, e.g. "January")
        month: monthName,
        deleted: 0,
      },
      select: { activity_price_book_id: true },
    });

    if (existingRow) {
      await this.prisma.dvi_activity_pricebook.update({
        where: { activity_price_book_id: existingRow.activity_price_book_id },
        data: {
          ...dayVals,
          updatedon: new Date(),
          status: 1,
          deleted: 0,
        } as any,
      });
    } else {
      await this.prisma.dvi_activity_pricebook.create({
        data: {
          hotspot_id: hotspotId,
          activity_id: activityId,
          nationality,
          price_type: priceType,
          year: yyyy,
          month: monthName,
          ...dayVals,
          createdby,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        } as any,
      });
    }
  };

  if (pricingUnitType === 'UNIT') {
    await deactivatePriceTypes([
      ACTIVITY_PRICE_TYPE_ADULT,
      ACTIVITY_PRICE_TYPE_CHILD,
      ACTIVITY_PRICE_TYPE_INFANT,
    ]);

    for (const { y, m } of months) {
      if (indianUnitCost > 0) {
        await upsertMonth(y, m, ACTIVITY_PRICE_TYPE_UNIT, 1, indianUnitCost);
      }

      if (nonIndianUnitCost > 0) {
        await upsertMonth(y, m, ACTIVITY_PRICE_TYPE_UNIT, 2, nonIndianUnitCost);
      }
    }

    return {
      ok: true,
      months: months.length,
      pricing_unit_type: pricingUnitType,
    };
  }

  await deactivatePriceTypes([ACTIVITY_PRICE_TYPE_UNIT]);

 // Indian: nationality=1; price_type: 1=Adult, 2=Child, 3=Infant
  if (dto.indian) {
    const adult = toFloat(dto.indian.adult_cost, 0);
    const child = toFloat(dto.indian.child_cost, 0);
    const infant = toFloat(dto.indian.infant_cost, 0);
    for (const { y, m } of months) {
      if (adult > 0) await upsertMonth(y, m, ACTIVITY_PRICE_TYPE_ADULT, 1, adult);
      if (child > 0) await upsertMonth(y, m, ACTIVITY_PRICE_TYPE_CHILD, 1, child);
      if (infant > 0) await upsertMonth(y, m, ACTIVITY_PRICE_TYPE_INFANT, 1, infant);
    }
  }

 // Non-Indian: nationality=2
  if (dto.nonindian) {
    const adult = toFloat(dto.nonindian.adult_cost, 0);
    const child = toFloat(dto.nonindian.child_cost, 0);
    const infant = toFloat(dto.nonindian.infant_cost, 0);
    for (const { y, m } of months) {
      if (adult > 0) await upsertMonth(y, m, ACTIVITY_PRICE_TYPE_ADULT, 2, adult);
      if (child > 0) await upsertMonth(y, m, ACTIVITY_PRICE_TYPE_CHILD, 2, child);
      if (infant > 0) await upsertMonth(y, m, ACTIVITY_PRICE_TYPE_INFANT, 2, infant);
    }
  }

  return {
    ok: true,
    months: months.length,
    pricing_unit_type: pricingUnitType,
  };
}

 // ====== REVIEWS ======
  async addOrUpdateReview(
    activityId: number,
    dto: { reviewId?: number; activity_rating: string; activity_description?: string; createdby?: number },
  ) {
    const existing = await this.prisma.dvi_activity.findFirst({ where: { activity_id: activityId, deleted: 0 } });
    if (!existing) throw new NotFoundException('Activity not found');

    if (!dto.activity_rating) throw new BadRequestException('activity_rating required');
 // NOTE: schema has VarChar(20) for activity_description (!)
    const trimmedDesc = (dto.activity_description ?? '').slice(0, 20);

    if (dto.reviewId) {
      const rev = await this.prisma.dvi_activity_review_details.findFirst({
        where: { activity_review_id: dto.reviewId, activity_id: activityId, deleted: 0 },
      });
      if (!rev) throw new NotFoundException('Review not found');
      return this.prisma.dvi_activity_review_details.update({
        where: { activity_review_id: dto.reviewId },
        data: {
          activity_rating: dto.activity_rating,
          activity_description: trimmedDesc || null,
          updatedon: new Date(),
        },
      });
    }

    return this.prisma.dvi_activity_review_details.create({
      data: {
        activity_id: activityId,
        activity_rating: dto.activity_rating,
        activity_description: trimmedDesc || null,
        createdby: toInt(dto.createdby, 0),
        createdon: new Date(),
        status: 1,
        deleted: 0,
      },
    });
  }

  async deleteReview(activityId: number, reviewId: number) {
    const rev = await this.prisma.dvi_activity_review_details.findFirst({
      where: { activity_review_id: reviewId, activity_id: activityId, deleted: 0 },
    });
    if (!rev) throw new NotFoundException('Review not found');
    await this.prisma.dvi_activity_review_details.update({
      where: { activity_review_id: reviewId },
      data: { deleted: 1, updatedon: new Date() },
    });
    return { ok: true };
  }

 // ====== PREVIEW ======
  async preview(activityId: number) {
    const act = await this.prisma.dvi_activity.findFirst({
      where: { activity_id: activityId, deleted: 0 },
    });
    if (!act) throw new NotFoundException('Activity not found');

    const [hotspot, images, slots, reviews] = await Promise.all([
      this.prisma.dvi_hotspot_place.findFirst({
        where: { hotspot_ID: act.hotspot_id as any },
        select: { hotspot_ID: true, hotspot_name: true, hotspot_location: true },
      }),
      this.prisma.dvi_activity_image_gallery_details.findMany({
        where: { activity_id: activityId, deleted: 0, status: 1 },
        orderBy: { activity_image_gallery_details_id: 'asc' },
        select: { activity_image_gallery_details_id: true, activity_image_gallery_name: true },
      }),
      this.prisma.dvi_activity_time_slot_details.findMany({
        where: { activity_id: activityId, deleted: 0, status: 1 },
        orderBy: [{ time_slot_type: 'asc' }, { special_date: 'asc' }, { start_time: 'asc' }],
      }),
      this.prisma.dvi_activity_review_details.findMany({
        where: { activity_id: activityId, deleted: 0, status: 1 },
        orderBy: { activity_review_id: 'desc' },
      }),
    ]);

 // ---- NEW: serialize time/date fields to strings ----
    const basic = {
      ...act,
      activity_duration: fmtHMS(act.activity_duration),
      createdon: fmtDateTimeISO(act.createdon),
      updatedon: fmtDateTimeISO(act.updatedon),
    };

    const defaultSlots = slots
      .filter((s) => s.time_slot_type === 1)
      .map((s) => ({
        ...s,
        start_time: fmtHMS(s.start_time),
        end_time: fmtHMS(s.end_time),
        special_date: null,
        createdon: fmtDateTimeISO(s.createdon),
        updatedon: fmtDateTimeISO(s.updatedon),
      }));

    const specialSlots = slots
      .filter((s) => s.time_slot_type === 2)
      .map((s) => ({
        ...s,
        start_time: fmtHMS(s.start_time),
        end_time: fmtHMS(s.end_time),
        special_date: fmtDateISO(s.special_date),
        createdon: fmtDateTimeISO(s.createdon),
        updatedon: fmtDateTimeISO(s.updatedon),
      }));

    const reviewsOut = reviews.map((r) => ({
      ...r,
      createdon: fmtDateTimeISO(r.createdon),
      updatedon: fmtDateTimeISO(r.updatedon),
    }));

    return {
      basic,
      hotspot,
      images,
      defaultSlots,
      specialSlots,
      reviews: reviewsOut,
    };
  }

 // ====== DETAILS ======
  async details(activityId: number) {
    const act = await this.prisma.dvi_activity.findFirst({
      where: { activity_id: activityId, deleted: 0 },
    });
    if (!act) throw new NotFoundException('Activity not found');

    const [hotspot, images] = await Promise.all([
      this.prisma.dvi_hotspot_place.findFirst({
        where: { hotspot_ID: act.hotspot_id as any },
        select: { hotspot_ID: true, hotspot_name: true, hotspot_location: true },
      }),
      this.prisma.dvi_activity_image_gallery_details.findMany({
        where: { activity_id: activityId, deleted: 0, status: 1 },
        orderBy: { activity_image_gallery_details_id: 'asc' },
        select: { activity_image_gallery_details_id: true, activity_image_gallery_name: true },
      }),
    ]);

 // ---- NEW: serialize time/date in details as well ----
    const out = {
      ...act,
      activity_duration: fmtHMS(act.activity_duration),
      createdon: fmtDateTimeISO(act.createdon),
      updatedon: fmtDateTimeISO(act.updatedon),
    };

    return { ...out, hotspot, images };
  }
}
