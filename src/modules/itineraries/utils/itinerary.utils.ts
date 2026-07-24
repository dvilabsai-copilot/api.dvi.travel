export function isValidDate(d: Date) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

export function toBigInt(v: any): bigint {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return BigInt(Math.trunc(v));
    if (typeof v === "string" && v.trim() !== "") return BigInt(v.trim());
  } catch {}
  return BigInt(0);
}

/**
 * NORMALIZED DATE-ONLY (LOCAL TIME)
 *
 * Previously this used UTC parts (getUTCFullYear / getUTCDate) which caused
 * 2025-12-02T00:00:00+05:30 to become 2025-12-01 in the DB.
 * Now we use LOCAL parts so the calendar date is preserved.
 */
export function normalizeToDateOnlyUTC(d: Date): Date {
  if (!isValidDate(d)) return d;
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
 // Local midnight (server timezone, e.g. IST)
  return new Date(y, m, day, 0, 0, 0, 0);
}

export function isoTimeToPrismaTime(d: Date): Date {
  const hh = isValidDate(d) ? d.getHours() : 0;
  const mm = isValidDate(d) ? d.getMinutes() : 0;
  const ss = isValidDate(d) ? d.getSeconds() : 0;
  return new Date(Date.UTC(1970, 0, 1, hh, mm, ss));
}

export function timeStringToPrismaTime(hms: string): Date {
  const s = String(hms ?? "").trim() || "00:00:00";
  const [h, m, sec] = s.split(":").map((x) => Number(x));
  const hh = Number.isFinite(h) ? h : 0;
  const mm = Number.isFinite(m) ? m : 0;
  const ss = Number.isFinite(sec) ? sec : 0;
  return new Date(Date.UTC(1970, 0, 1, hh, mm, ss));
}

export function secondsToPrismaTime(seconds: number): Date {
  const s = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(s / 3600) % 24;
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return new Date(Date.UTC(1970, 0, 1, hh, mm, ss));
}

export function dateTimeToPrismaTime(dt: Date): Date {
  return new Date(
    Date.UTC(1970, 0, 1, dt.getUTCHours(), dt.getUTCMinutes(), dt.getUTCSeconds()),
  );
}

// PHP: date('N') is 1(Mon)..7(Sun) => -1 => 0..6
// Use *local* weekday so the day doesn't shift by timezone.
export function phpDayOfWeekNumericFromDateOnly(dateOnly: Date): number {
 const d = dateOnly.getDay(); // 0 Sun..6 Sat (local)
  return d === 0 ? 6 : d - 1;
}

/**
 * Combine a date-only (local midnight) and a time-only (stored as UTC 1970-01-01 HH:MM:SS)
 * into a single Date representing that local date + time.
 */
export function combineDateOnlyAndTime(
  dateOnly: Date,
  timeOnly: Date | null,
  fallbackHms: string,
): Date {
  const y = dateOnly.getFullYear();
  const m = dateOnly.getMonth();
  const d = dateOnly.getDate();

  const t = timeOnly ?? timeStringToPrismaTime(fallbackHms);
  const hh = t.getUTCHours();
  const mm = t.getUTCMinutes();
  const ss = t.getUTCSeconds();

 // local datetime (e.g. IST)
  return new Date(y, m, d, hh, mm, ss, 0);
}

export function uniqueTokens(values: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const s = String(v ?? "").trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

export function parseViaRoute(v?: string) {
  const s = String(v ?? "").trim();
  if (!s) return [];
  return s
    .split(/[,|]/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function countTravellers(
  travellers: Array<{ traveller_type: number }> = [],
) {
  let adults = 0,
    children = 0,
    infants = 0;
  for (const t of travellers) {
    if (t.traveller_type === 1) adults++;
    else if (t.traveller_type === 2) children++;
    else if (t.traveller_type === 3) infants++;
  }
  return { adults, children, infants };
}

export function toFloat(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function getTravelType(
  prevLocation: string,
  nextLocation: string,
): 1 | 2 {
  const a = prevLocation
    .split("|")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const b = nextLocation
    .split("|")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!a.length || !b.length) return 2;
  const setA = new Set(a);
  for (const x of b) if (setA.has(x)) return 1;
  return 2;
}

export function computeTravelParity(args: {
  prevLat: number | null;
  prevLng: number | null;
  prevLocation: string;
  nextLat: number;
  nextLng: number;
  nextLocation: string;
}) {
  const DEFAULT_TRAVEL_MINUTES = Number(
    process.env.ITINERARY_DEFAULT_HOTSPOT_TRAVEL_MINUTES ?? 15,
  );
  const CORR = Number(
    process.env.ITINERARY_HOTSPOT_TRAVEL_CORRECTION_FACTOR ?? 1.5,
  );
  const LOCAL_SPEED = Number(
    process.env.ITINERARY_LOCAL_SPEED_LIMIT_KMPH ?? 25,
  );
  const OUT_SPEED = Number(
    process.env.ITINERARY_OUTSTATION_SPEED_LIMIT_KMPH ?? 55,
  );

  if (args.prevLat == null || args.prevLng == null) {
    return {
      distanceKm: 0,
      travelSeconds: Math.max(
        0,
        Math.floor(DEFAULT_TRAVEL_MINUTES * 60),
      ),
    };
  }

  const baseKm = haversineKm(
    args.prevLat,
    args.prevLng,
    args.nextLat,
    args.nextLng,
  );
  const distanceKm = baseKm * CORR;

  const travelType = getTravelType(
    args.prevLocation,
    args.nextLocation,
  );
  const speed = travelType === 1 ? LOCAL_SPEED : OUT_SPEED;

  const hours = speed > 0 ? distanceKm / speed : 0;
  const travelSeconds = Math.max(0, Math.floor(hours * 3600));

  const normalizeTravelPlace = (value: string) =>
    String(value || '')
      .split('|')[0]
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  const namesDiffer =
    normalizeTravelPlace(args.prevLocation) !== normalizeTravelPlace(args.nextLocation);

  if (namesDiffer && distanceKm <= 0.01) {
    return {
      distanceKm: 0.1,
      travelSeconds: Math.max(travelSeconds, 300),
    };
  }

  return { distanceKm, travelSeconds };
}

export function timeToSeconds(timeOnly?: Date | null): number | null {
  if (!timeOnly) return null;
 // time-only is stored as UTC 1970-01-01 HH:MM:SS
  return (
    timeOnly.getUTCHours() * 3600 +
    timeOnly.getUTCMinutes() * 60 +
    timeOnly.getUTCSeconds()
  );
}

export function resolveTimingForDay(
  dateOnly: Date,
  timings: Array<{
    hotspot_open_all_time: number;
    hotspot_start_time: Date | null;
    hotspot_end_time: Date | null;
  }>,
  travelEnd: Date,
  durationSeconds: number,
): { allowed: boolean; visitStart: Date } {
  if (
    timings.some(
      (t) => Number((t as any).hotspot_open_all_time ?? 0) === 1,
    )
  ) {
    return { allowed: true, visitStart: travelEnd };
  }

  const durMs = durationSeconds * 1000;

  const windows = timings
    .map((t) => {
      if (!t.hotspot_start_time || !t.hotspot_end_time) return null;
      const ws = combineDateOnlyAndTime(
        dateOnly,
        t.hotspot_start_time,
        "00:00:00",
      );
      const we = combineDateOnlyAndTime(
        dateOnly,
        t.hotspot_end_time,
        "23:59:59",
      );
      if (we.getTime() <= ws.getTime()) return null;
      return { ws, we };
    })
    .filter(Boolean) as Array<{ ws: Date; we: Date }>;

  if (!windows.length)
    return { allowed: false, visitStart: travelEnd };

  for (const w of windows) {
    const proposedEnd = new Date(travelEnd.getTime() + durMs);

    if (
      travelEnd.getTime() >= w.ws.getTime() &&
      proposedEnd.getTime() <= w.we.getTime()
    ) {
      return { allowed: true, visitStart: travelEnd };
    }

    if (travelEnd.getTime() < w.ws.getTime()) {
      const waitStart = w.ws;
      const waitEnd = new Date(waitStart.getTime() + durMs);
      if (waitEnd.getTime() <= w.we.getTime()) {
        return { allowed: true, visitStart: waitStart };
      }
    }
  }

  return { allowed: false, visitStart: travelEnd };
}

export function computeEntryCost(args: {
  entryTicketRequired: boolean;
  nationality: number;
  adults: number;
  children: number;
  infants: number;
  hotspot: any;
}) {
  if (!args.entryTicketRequired) {
    return {
      totalAmount: 0,
      adultUnit: 0,
      childUnit: 0,
      infantUnit: 0,
      foreignAdultUnit: 0,
      foreignChildUnit: 0,
      foreignInfantUnit: 0,
      costByTravellerType: {
        1: 0,
        2: 0,
        3: 0,
      } as Record<number, number>,
    };
  }

  const isDomestic = Number(args.nationality ?? 0) === 101;

  const adultUnit = Number(args.hotspot.hotspot_adult_entry_cost ?? 0);
  const childUnit = Number(args.hotspot.hotspot_child_entry_cost ?? 0);
  const infantUnit = Number(args.hotspot.hotspot_infant_entry_cost ?? 0);

  const foreignAdultUnit = Number(
    args.hotspot.hotspot_foreign_adult_entry_cost ?? 0,
  );
  const foreignChildUnit = Number(
    args.hotspot.hotspot_foreign_child_entry_cost ?? 0,
  );
  const foreignInfantUnit = Number(
    args.hotspot.hotspot_foreign_infant_entry_cost ?? 0,
  );

  const usedAdult = isDomestic ? adultUnit : foreignAdultUnit;
  const usedChild = isDomestic ? childUnit : foreignChildUnit;
  const usedInfant = isDomestic ? infantUnit : foreignInfantUnit;

  const totalAmount =
    Math.max(0, args.adults) * usedAdult +
    Math.max(0, args.children) * usedChild +
    Math.max(0, args.infants) * usedInfant;

  return {
    totalAmount,
    adultUnit,
    childUnit,
    infantUnit,
    foreignAdultUnit,
    foreignChildUnit,
    foreignInfantUnit,
    costByTravellerType: {
      1: usedAdult,
      2: usedChild,
      3: usedInfant,
    } as Record<number, number>,
  };
}

export function buildTravellers(
  adults: number,
  children: number,
  infants: number,
) {
  const out: Array<{ type: number; name: string }> = [];
  for (let i = 1; i <= Math.max(0, adults); i++)
    out.push({ type: 1, name: `Adult ${i}` });
  for (let i = 1; i <= Math.max(0, children); i++)
    out.push({ type: 2, name: `Child ${i}` });
  for (let i = 1; i <= Math.max(0, infants); i++)
    out.push({ type: 3, name: `Infant ${i}` });
  return out;
}

export function normalizeFirstInt(v: any): number {
  if (Array.isArray(v) && v.length) {
    const n = Number(v[0]);
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function buildGroupTypesFromTravellersRoomIds(): number[] {
  return [1];
}
