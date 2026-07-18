export enum TransportEarlyArrivalOption {
  HOTEL_REST = 'HOTEL_REST',
  REFRESHMENT_BEFORE_SIGHTSEEING = 'REFRESHMENT_BEFORE_SIGHTSEEING',
}

export const DEFAULT_TRANSPORT_EARLY_ARRIVAL_CUTOFF = '08:00';
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

export function getTransportEarlyArrivalMessage(option?: string | null): string | null {
  if (option === TransportEarlyArrivalOption.HOTEL_REST) {
    return 'Guest has opted to proceed to the hotel first for rest and refreshment before commencing sightseeing.';
  }
  if (option === TransportEarlyArrivalOption.REFRESHMENT_BEFORE_SIGHTSEEING) {
    return 'Guest has opted to take a refreshment or waiting break after arrival and commence sightseeing at the earliest practical time.';
  }
  return null;
}
