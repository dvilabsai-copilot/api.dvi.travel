export enum TransportEarlyArrivalOption {
  HOTEL_REST = 'HOTEL_REST',
  REFRESHMENT_BEFORE_SIGHTSEEING = 'REFRESHMENT_BEFORE_SIGHTSEEING',
  AIRPORT_LOUNGE = 'AIRPORT_LOUNGE',
  RESTAURANT_REST = 'RESTAURANT_REST',
  OTHER_LOCATION = 'OTHER_LOCATION',
}

export const DEFAULT_TRANSPORT_EARLY_ARRIVAL_CUTOFF = '07:00';
export const DEFAULT_TRANSPORT_EARLIEST_SIGHTSEEING_TIME = '09:00';
export const DEFAULT_TRANSPORT_REFRESHMENT_MINUTES = 60;
export const DEFAULT_TRANSPORT_HOTEL_REST_MINUTES = 180;

export function getTransportEarlyArrivalSetting(
  name: string,
  fallback: string,
): string {
  const value = String(process.env[name] || '').trim();
  return value || fallback;
}

export function wallClockMinutes(value: unknown): number | null {
  const match = String(value || '').trim().match(/(?:T|^)(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function transportEarlyArrivalCutoffMinutes(): number {
  return wallClockMinutes(getTransportEarlyArrivalSetting(
    'TRANSPORT_EARLY_ARRIVAL_CUTOFF',
    DEFAULT_TRANSPORT_EARLY_ARRIVAL_CUTOFF,
  )) ?? 7 * 60;
}

export function isTransportIntercityTransfer(source?: string | null, destination?: string | null): boolean {
  const city = (value?: string | null) => String(value ?? '')
    .toLowerCase()
    .split(/[|,]/)[0]
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(international|domestic|airport|railway|station|junction|bus stand|terminal)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const from = city(source);
  const to = city(destination);
  return Boolean(from && to && from !== to);
}

export function isEarlyDirectTransportTransfer(
  preference: unknown, pickupTime: string, source?: string | null, destination?: string | null,
): boolean {
  const pickupMinutes = wallClockMinutes(pickupTime);
  // The requested 07:00 transfer is direct even at the default prompt cutoff.
  const directTransferCutoff = Math.max(transportEarlyArrivalCutoffMinutes(), 7 * 60 + 1);
  return Number(preference) === 2 && pickupMinutes !== null && pickupMinutes < directTransferCutoff &&
    isTransportIntercityTransfer(source, destination);
}

export function getTransportEarlyArrivalMessage(option?: string | null): string | null {
  if (option === TransportEarlyArrivalOption.HOTEL_REST) {
    return 'Guest has opted to proceed to the hotel first for rest and refreshment before commencing sightseeing.';
  }
  if (option === TransportEarlyArrivalOption.REFRESHMENT_BEFORE_SIGHTSEEING) {
    return 'Guest has opted to take a refreshment or waiting break after arrival and commence sightseeing at the earliest practical time.';
  }
  if (option === TransportEarlyArrivalOption.AIRPORT_LOUNGE) {
    return 'Guest has opted to rest at an airport lounge before commencing sightseeing.';
  }
  if (option === TransportEarlyArrivalOption.RESTAURANT_REST) {
    return 'Guest has opted to take a rest or refreshment break at a nearby restaurant before commencing sightseeing.';
  }
  if (option === TransportEarlyArrivalOption.OTHER_LOCATION) {
    return 'Guest has opted to rest at another preferred location before commencing sightseeing.';
  }
  return null;
}
