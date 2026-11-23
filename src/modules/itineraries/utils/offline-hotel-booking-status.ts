export const offlineHotelBookingStatusLabels = {
  pending: 'Awaiting',
  waitinglist: 'Waitinglist',
  blocked: 'Blocked',
  confirmed: 'Confirmed',
  sold_out: 'Sold Out',
  cancelled: 'Cancelled',
} as const;

export type OfflineHotelBookingStatus = keyof typeof offlineHotelBookingStatusLabels;

export const offlineHotelBookingStatuses = Object.keys(offlineHotelBookingStatusLabels) as OfflineHotelBookingStatus[];
