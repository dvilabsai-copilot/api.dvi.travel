/** Pure local-vehicle pricing and slab-selection policy. */

export function toNum(v: any): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
}

export function normalizeLocalTimeLimitSignature(
  hours: number | null,
  kmLimit: number | null,
  title: string | null | undefined,
): { normalizedHours: number; normalizedKm: number } {
  const normalizedTitle = String(title ?? '').trim();
  const numericHours = Number(hours ?? 0);
  const numericKm = Number(kmLimit ?? 0);

  if (Number.isFinite(numericHours) && numericHours > 0 && Number.isFinite(numericKm) && numericKm > 0) {
    return { normalizedHours: numericHours, normalizedKm: numericKm };
  }

  const matches = normalizedTitle.match(/(\d+(?:\.\d+)?)/g) ?? [];
  const parsedHours = Number(matches[0] ?? 0);
  const parsedKm = Number(matches[1] ?? 0);

  return {
    normalizedHours: Number.isFinite(parsedHours) ? parsedHours : 0,
    normalizedKm: Number.isFinite(parsedKm) ? parsedKm : 0,
  };
}

export type LocalSlabCandidate = {
  time_limit_id: number;
  hours_limit: number;
  km_limit: number;
  title?: string;
};

export type LocalSlabSelection<T extends LocalSlabCandidate> = {
  chosen: T;
  selected?: T;
  noHigherSlabAvailable: boolean;
  slabUpgraded: boolean;
};

export function sortLocalSlabs<T extends LocalSlabCandidate>(slabs: T[]): T[] {
  return [...slabs].sort((a, b) => {
    if (a.hours_limit !== b.hours_limit) return a.hours_limit - b.hours_limit;
    if (a.km_limit !== b.km_limit) return a.km_limit - b.km_limit;
    return a.time_limit_id - b.time_limit_id;
  });
}

export function slabCoversUsage(
  slab: LocalSlabCandidate | undefined,
  dutyHours: number,
  dutyKm: number,
): boolean {
  if (!slab) return false;
  return Number(slab.hours_limit || 0) >= dutyHours && Number(slab.km_limit || 0) >= dutyKm;
}

export function selectChargeableLocalSlab<T extends LocalSlabCandidate>(
  slabs: T[],
  dutyHours: number,
  dutyKm: number,
  selectedTimeLimitId?: number,
): LocalSlabSelection<T> | null {
  if (!slabs.length) return null;

  const sorted = sortLocalSlabs(slabs);
  const safeDutyHours = Math.max(0, Number(dutyHours || 0));
  const safeDutyKm = Math.max(0, Number(dutyKm || 0));
  const selected = Number(selectedTimeLimitId || 0) > 0
    ? sorted.find((slab) => Number(slab.time_limit_id || 0) === Number(selectedTimeLimitId || 0))
    : undefined;

  if (selected && slabCoversUsage(selected, safeDutyHours, safeDutyKm)) {
    return {
      chosen: selected,
      selected,
      noHigherSlabAvailable: false,
      slabUpgraded: false,
    };
  }

  const covering = sorted.find((slab) => slabCoversUsage(slab, safeDutyHours, safeDutyKm));
  const chosen = covering || sorted[sorted.length - 1];

  return {
    chosen,
    selected,
    noHigherSlabAvailable: !covering,
    slabUpgraded:
      !!selected &&
      Number(selected.time_limit_id || 0) > 0 &&
      Number(chosen.time_limit_id || 0) > 0 &&
      Number(selected.time_limit_id || 0) !== Number(chosen.time_limit_id || 0),
  };
}
