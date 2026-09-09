export const HotelAdminPermissionKey = {
  HOTELS: 'hotels',
  HOTEL_DETAILS: 'hotel_details',
  ROOMS: 'rooms',
  RATES: 'rates',
  AVAILABILITY: 'availability',
  BOOKINGS: 'bookings',
  HOTEL_USERS: 'hotel_users',
  PERMISSIONS: 'permissions',
  GALLERY: 'gallery',
} as const;

export type HotelAdminPermissionKeyValue =
  (typeof HotelAdminPermissionKey)[keyof typeof HotelAdminPermissionKey];

export type HotelAdminPermissionAction =
  | 'view'
  | 'create'
  | 'edit'
  | 'delete';

export const HOTEL_ADMIN_PERMISSION_KEYS =
  Object.values(HotelAdminPermissionKey);

export interface HotelAdminPermissionInput {
  key: string;
  view?: boolean;
  create?: boolean;
  edit?: boolean;
  delete?: boolean;
}