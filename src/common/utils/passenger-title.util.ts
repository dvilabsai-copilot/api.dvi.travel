export type PassengerTitle = 'Mr' | 'Mrs' | 'Ms' | 'Miss' | 'Mx' | 'Dr';

const TITLE_MAP: Record<string, PassengerTitle> = {
  mr: 'Mr',
  mrs: 'Mrs',
  ms: 'Ms',
  miss: 'Miss',
  mx: 'Mx',
  dr: 'Dr',
  master: 'Mr',
  mstr: 'Mr',
};

export function normalizePassengerTitle(
  ...candidates: Array<string | null | undefined>
): PassengerTitle | undefined {
  for (const candidate of candidates) {
    const key = String(candidate || '').trim().toLowerCase();
    if (!key) {
      continue;
    }

    const normalized = TITLE_MAP[key];
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

export function resolveProviderPassengerTitle(
  ...candidates: Array<string | null | undefined>
): PassengerTitle {
  // Some downstream hotel providers reject empty title fields.
  // Use a valid passenger/guest title when available and fall back only here.
  return normalizePassengerTitle(...candidates) ?? 'Mr';
}
