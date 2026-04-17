export interface IHotelProvider {
  getName(): string;

  search(
    criteria: HotelSearchCriteria,
    preferences?: HotelPreferences,
  ): Promise<HotelSearchResult[]>;

  getConfirmation(
    confirmationRef: string,
  ): Promise<HotelConfirmationDetails>;

  confirmBooking(
    bookingDetails: HotelConfirmationDTO,
  ): Promise<HotelConfirmationResult>;

  cancelBooking(
    confirmationRef: string,
    reason: string,
  ): Promise<CancellationResult>;
}

export interface HotelSearchResult {
  provider: string;
  hotelCode: string;
  hotelName: string;
  cityCode: string;
  address: string;
  latitude?: number | string | null;
  longitude?: number | string | null;
  rating: number;
  category?: string; // Hotel category/star rating
  facilities: string[];
  images: string[];
  price: number;
  currency: string;
  roomTypes: RoomType[];
  roomType?: string; // Current room type name
  mealPlan?: string; // Meal plan info (if available)
  searchReference: string; // Used for confirmation
  expiresAt: Date; // When search result expires
  // Supplement summary at hotel level
  supplementSummary?: {
    hasSupplements: boolean;
    supplementCount: number;
    atPropertyChargeCount: number;
    requiresReview: boolean; // true if unknown types or mandatory charges
  };
}

export interface RoomType {
  roomCode: string;
  roomName: string;
  bedType: string;
  capacity: number;
  price: number;
  cancellationPolicy: string;
  // Supplements (optional - from search response)
  supplements?: Array<{
    type: string; // "AtProperty", etc
    description: string;
    amount: number;
    currency: string;
    chargeType?: string;
    fromDate?: string;
  }>;
}

export interface HotelSearchCriteria {
  cityCode: string;
  checkInDate: string; // YYYY-MM-DD
  checkOutDate: string;
  roomCount: number;
  guestCount: number;
  guestNationality?: string;
  occupancies?: RoomOccupancy[];
  hotelCodes?: string; // Optional: specific hotel codes to search (comma-separated)
}

export interface RoomOccupancy {
  adults: number;
  children: number;
  childrenAges?: number[];
}

export interface HotelPreferences {
  minRating?: number;
  maxPrice?: number;
  facilities?: string[];
  preferredProvider?: string;
}

export interface HotelConfirmationDTO {
  itineraryPlanId: number;
  searchReference: string;
  hotelCode: string;
  checkInDate: string;
  checkOutDate: string;
  roomCount: number;
  guestNationality?: string;
  guests: GuestDetails[];
  rooms: RoomSelection[];
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  invCode?: number;
  rateCode?: number;
}

export interface GuestDetails {
  title?: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  nationality?: string;
  pan?: string;
  passportNo?: string;
}

export interface RoomSelection {
  roomCode: string;
  quantity: number;
  guestCount: number;
}

export interface HotelConfirmationResult {
  provider: string;
  confirmationReference: string;
  hotelCode: string;
  hotelName: string;
  checkIn: string;
  checkOut: string;
  roomCount: number;
  totalPrice: number;
  priceBreadown: {
    roomCharges: number;
    taxes: number;
    discounts: number;
  };
  cancellationPolicy: string;
  status: string;
  bookingDeadline: string;
}

export interface HotelConfirmationDetails {
  confirmationRef: string;
  hotelName: string;
  checkIn: string;
  checkOut: string;
  roomCount: number;
  totalPrice: number;
  status: string;
  cancellationPolicy: string;
}

export interface CancellationResult {
  cancellationRef: string;
  refundAmount: number;
  charges: number;
  refundDays: number;
}
