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
 /** User-facing provider label; keep provider unchanged for internal routing. */
  providerDisplayName?: string;
  canonicalHotelId?: number | null;
  providerHotelCode?: string;
  rateOptionId?: string;
  roomId?: string | number;
  rateId?: string | number;
  roomTypeId?: number;
  rateOptions?: Array<Record<string, unknown>>;
  hotelCode: string;
  hotelName: string;
  cityCode: string;
  address: string;
  latitude?: number | string | null;
  longitude?: number | string | null;
  rating: number;
 category?: string; // Hotel category/star rating
  facilities: string[];
  amenities?: string[];
  inclusions?: string[];
  rateConditions?: any[];
  cancellationPolicy?: any[] | string;
  images: string[];
  price: number;
  netAmount?: number;
  totalFare?: number;
  currency: string;
  roomTypes: RoomType[];
 roomType?: string; // Current room type name
 mealPlan?: string; // Meal plan info (if available)
 searchReference: string; // Used for confirmation
  bookingCode?: string;
 expiresAt: Date; // When search result expires
  pricePerNight?: number;
  totalStayPrice?: number;
  numberOfNights?: number;
  nightlyRates?: Array<{
    date: string;
    baseAmount: number;
    sellAmount: number;
  }>;
  priceLabel?: string;
  priceSource?: 'LIVE_API' | 'DATABASE' | 'LEGACY_UNKNOWN';
  bookingMode?: 'LIVE_API' | 'MANUAL_APPROVAL';
  requiresHotelApproval?: boolean;
  isLiveRate?: boolean;
  isLiveBookable?: boolean;
  isSelectable?: boolean;
  approvalStatus?: 'NOT_REQUESTED' | 'NOT_REQUIRED' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
  manualConfirmationStatus?: 'NOT_STARTED' | 'PENDING_CONFIRMATION' | 'CONFIRMED' | 'FAILED' | 'CANCELLED';
 // Supplement summary at hotel level
  supplementSummary?: {
    hasSupplements: boolean;
    supplementCount: number;
    atPropertyChargeCount: number;
 requiresReview: boolean; // true if unknown types or mandatory charges
  };
  isBookable?: boolean;
  externalStay?: boolean;
  availabilityStatus?: 'AVAILABLE' | 'LIVE_AVAILABLE' | 'OFFLINE_APPROVAL_REQUIRED' | 'NO_SUPPLIER_AVAILABILITY' | 'NO_AVAILABILITY' | 'NOT_BOOKABLE';
  availabilityMessage?: string | null;
  availableAgainFrom?: string | null;
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
  hotelName?: string;
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
  starRatings?: number[];
  mealPlanCode?: string;
  tboMealType?: string;
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
 /** User-facing provider label; keep provider unchanged for internal routing. */
  providerDisplayName?: string;
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
