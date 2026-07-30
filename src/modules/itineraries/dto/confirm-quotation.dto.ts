import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsInt,
  IsOptional,
  IsArray,
  Min,
  IsNumber,
  IsBoolean,
  Max,
  Matches,
  ValidateNested,
  IsIn,
  IsDateString,
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';

export class HotelPassengerDto {
  @ApiProperty({ example: 'Mr' })
  @IsString()
  @Matches(/^(mr|mrs|ms|miss|mx|dr)$/i, {
    message: 'title must be one of Mr, Mrs, Ms, Miss, Mx, Dr',
  })
  title!: string;

  @ApiProperty({ example: 'John' })
  @IsString()
  @Matches(/^[A-Za-z][A-Za-z\s'-]{1,24}$/, {
    message: 'firstName must be 2-25 characters and contain only letters, spaces, apostrophe or hyphen',
  })
  firstName!: string;

  @ApiProperty({ example: '', required: false })
  @IsOptional()
  @IsString()
  middleName?: string;

  @ApiProperty({ example: 'Doe' })
  @IsString()
  @Matches(/^[A-Za-z][A-Za-z\s'-]{1,24}$/, {
    message: 'lastName must be 2-25 characters and contain only letters, spaces, apostrophe or hyphen',
  })
  lastName!: string;

  @ApiProperty({ example: 'john@example.com', required: false })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiProperty({ example: 1, description: '1=Adult, 2=Child' })
  @IsInt()
  @IsIn([1, 2], { message: 'paxType must be 1 (Adult) or 2 (Child)' })
  paxType!: number;

  @ApiProperty({ example: true })
  @IsBoolean()
  leadPassenger!: boolean;

  @ApiProperty({ example: 30 })
  @IsInt()
  @Min(0)
  @Max(120)
  age!: number;

  @ApiProperty({ example: '', required: false })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9]{6,20}$/i, {
    message: 'passportNo must be 6-20 alphanumeric characters',
  })
  passportNo?: string;

  @ApiProperty({ example: '', required: false })
  @IsOptional()
  @IsString()
  passportIssueDate?: string;

  @ApiProperty({ example: '', required: false })
  @IsOptional()
  @IsString()
  passportExpDate?: string;

  @ApiProperty({ example: '', required: false })
  @IsOptional()
  @IsString()
  phoneNo?: string;

  @ApiProperty({ example: '', required: false })
  @IsOptional()
  @IsString()
  gstNumber?: string;

  @ApiProperty({ example: '', required: false })
  @IsOptional()
  @IsString()
  gstCompanyName?: string;

  @ApiProperty({ example: '', required: false })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{5}[0-9]{4}[A-Z]$/, {
    message: 'pan must be a valid PAN format (e.g. ABCDE1234F)',
  })
  pan?: string;

  @ApiProperty({ example: '', required: false })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{5}[0-9]{4}[A-Z]$/, {
    message: 'panNo must be a valid PAN format (e.g. ABCDE1234F)',
  })
  panNo?: string;
}

export class HotelRoomOccupancyDto {
  @ApiProperty({ example: 2 })
  @IsInt()
  @Min(1)
  @Max(8)
  adults!: number;

  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(0)
  @Max(4)
  children!: number;

  @ApiProperty({ type: [Number], example: [8], required: false })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(11, { each: true })
  childrenAges?: number[];
}

export class HotelSelectionDto {
  @ApiProperty({ example: 'tbo', description: 'Hotel provider: tbo, ResAvenue, etc.' })
  @IsString()
  provider!: string;

  @ApiProperty({ example: 1 })
  @IsInt()
  routeId!: number;

  @ApiProperty({ example: '1035259' })
  @IsString()
  hotelCode!: string;

  @ApiProperty({ example: 'Sample Hotel', required: false })
  @IsOptional()
  @IsString()
  hotelName?: string;

  @ApiProperty({ example: '1035259!TB!2!TB!27fe40ea-75db-11f0-8023-825b5693933e!TB!AFF!' })
  @IsString()
  bookingCode!: string;

  @ApiProperty({ example: 'STAAH-STAAHTESTHOTEL1-DELUXE_ROOM-CP_PLAN-20260714123000', required: false })
  @IsOptional()
  @IsString()
  searchReference?: string;

  @ApiProperty({ example: 'DELUXE_ROOM', required: false })
  @IsOptional()
  @IsString()
  roomId?: string;

  @ApiProperty({ example: 'CP_PLAN', required: false })
  @IsOptional()
  @IsString()
  rateId?: string;

  @ApiProperty({
    required: false,
    description: 'Independent supplier room/rate selection for each requested room',
    type: 'array',
    items: {
      type: 'object',
      properties: {
        roomIndex: { type: 'number', example: 0 },
        roomId: { type: 'string', example: 'DELUXEROOM' },
        rateId: { type: 'string', example: 'CP_PLAN' },
        roomType: { type: 'string', example: 'Deluxe Room' },
        mealPlan: { type: 'string', example: 'CP' },
        rateOptionId: { type: 'string', example: 'STAAH-44596-DELUXEROOM-CP_PLAN-20260801' },
      },
    },
  })
  @IsOptional()
  @IsArray()
  @IsObject({ each: true })
  roomSelections?: Array<Record<string, unknown>>;

  @ApiProperty({ example: 'MAP', required: false })
  @IsOptional()
  @IsString()
  mealPlan?: string;

  @ApiProperty({ example: 'Double Bed' })
  @IsString()
  roomType!: string;

  @ApiProperty({ example: '2025-12-12' })
  @IsString()
  checkInDate!: string;

  @ApiProperty({ example: '2025-12-13' })
  @IsString()
  checkOutDate!: string;

  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  @Max(6)
  numberOfRooms!: number;

  @ApiProperty({ example: 'IN' })
  @IsString()
  @Matches(/^[A-Z]{2}$/i, { message: 'guestNationality must be ISO-2 country code' })
  guestNationality!: string;

  @ApiProperty({ example: 5000 })
  @IsNumber()
  netAmount!: number;

  @ApiProperty({
    example: '2026-03-22T10:15:00.000Z',
    required: false,
    description: 'Timestamp when hotel search result/session was generated',
  })
  @IsOptional()
  @IsDateString()
  searchInitiatedAt?: string;

  @ApiProperty({ type: [HotelPassengerDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HotelPassengerDto)
  passengers!: HotelPassengerDto[];

  @ApiProperty({ type: [HotelRoomOccupancyDto], required: false })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HotelRoomOccupancyDto)
  occupancies?: HotelRoomOccupancyDto[];

  @ApiProperty({
    example: {
      bookingCode: '1035259!TB!...',
      finalPrice: 5230.45,
      traceId: 'trace-id',
    },
    required: false,
    description: 'Prebook response context captured from the confirm popup review step',
  })
  @IsOptional()
  @IsObject()
  prebookContext?: Record<string, any>;

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  @IsBoolean()
  isBookable?: boolean;

  @ApiProperty({ example: false, required: false })
  @IsOptional()
  @IsBoolean()
  externalStay?: boolean;

  @ApiProperty({ example: 'AVAILABLE', required: false })
  @IsOptional()
  @IsString()
  availabilityStatus?: string;

  @ApiProperty({ example: null, required: false })
  @IsOptional()
  @IsString()
  availabilityMessage?: string | null;

  @ApiProperty({ example: 'MANUAL_APPROVAL', required: false })
  @IsOptional()
  @IsString()
  bookingMode?: string;

  @ApiProperty({ example: 'DATABASE', required: false })
  @IsOptional()
  @IsString()
  priceSource?: string;

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  @IsBoolean()
  requiresHotelApproval?: boolean;

  @ApiProperty({ example: 'PENDING_APPROVAL', required: false })
  @IsOptional()
  @IsString()
  approvalStatus?: string;

  @ApiProperty({ example: 'NOT_STARTED', required: false })
  @IsOptional()
  @IsString()
  manualConfirmationStatus?: string;

  @ApiProperty({ example: '123-ROOM-CP-20260726', required: false })
  @IsOptional()
  @IsString()
  selectedRateOptionId?: string;

  @ApiProperty({ example: 2500, required: false })
  @IsOptional()
  @IsNumber()
  selectedPricePerNight?: number;

  @ApiProperty({ example: 5000, required: false })
  @IsOptional()
  @IsNumber()
  selectedTotalPrice?: number;

  @ApiProperty({ example: 'INR', required: false })
  @IsOptional()
  @IsString()
  selectedCurrency?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  selectedPriceSnapshot?: string;

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  @IsBoolean()
  multiNightBooking?: boolean;

  @ApiProperty({ example: false, required: false })
  @IsOptional()
  @IsBoolean()
  manualRoomMealMismatchOverride?: boolean;

  @ApiProperty({ example: 'staah:934001:10512556XPQ3:STAAH194181:2026-07-15_to_2026-07-17', required: false })
  @IsOptional()
  @IsString()
  stayKey?: string;

  @ApiProperty({ type: [Number], required: false })
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  routeIds?: number[];

  @ApiProperty({ example: 2, required: false })
  @IsOptional()
  @IsInt()
  nights?: number;

  @ApiProperty({
    type: [Object],
    required: false,
  })
  @IsOptional()
  @IsArray()
  nightlyRates?: Array<{
    date: string;
    amountAfterTax: number;
    baseAmount?: number;
    extraAdultCount?: number;
    extraChildCount?: number;
    extraAdultRate?: number;
    extraChildRate?: number;
  }>;

  @ApiProperty({ example: 2526, required: false })
  @IsOptional()
  @IsNumber()
  totalAmountAfterTax?: number;
}

export class ConfirmQuotationDto {
  @ApiProperty({ example: 12 })
  @IsInt()
  @Min(1)
  itinerary_plan_ID!: number;

  @ApiProperty({ example: 3 })
  @IsInt()
  @Min(1)
  agent!: number;

  @ApiProperty({ example: 'Mr' })
  @IsString()
  primary_guest_salutation!: string;

  @ApiProperty({ example: 'John Doe' })
  @IsString()
  primary_guest_name!: string;

  @ApiProperty({ example: '9876543210' })
  @IsString()
  primary_guest_contact_no!: string;

  @ApiProperty({ example: '34' })
  @IsString()
  primary_guest_age!: string;

  @ApiProperty({ example: '', required: false })
  @IsOptional()
  @IsString()
  primary_guest_alternative_contact_no?: string;

  @ApiProperty({ example: 'john@example.com', required: false })
  @IsOptional()
  @IsString()
  primary_guest_email_id?: string;

  @ApiProperty({ type: [String], example: [], required: false })
  @IsOptional()
  @IsArray()
  adult_name?: string[];

  @ApiProperty({ type: [String], example: [], required: false })
  @IsOptional()
  @IsArray()
  adult_age?: string[];

  @ApiProperty({ type: [String], example: [], required: false })
  @IsOptional()
  @IsArray()
  child_name?: string[];

  @ApiProperty({ type: [String], example: [], required: false })
  @IsOptional()
  @IsArray()
  child_age?: string[];

  @ApiProperty({ type: [String], example: [], required: false })
  @IsOptional()
  @IsArray()
  infant_name?: string[];

  @ApiProperty({ type: [String], example: [], required: false })
  @IsOptional()
  @IsArray()
  infant_age?: string[];

  @ApiProperty({ example: '12-12-2025 9:00 AM' })
  @IsString()
  arrival_date_time!: string;

  @ApiProperty({ example: 'Chennai International Airport' })
  @IsString()
  arrival_place!: string;

  @ApiProperty({ example: '', required: false })
  @IsOptional()
  @IsString()
  arrival_flight_details?: string;

  @ApiProperty({ example: '19-12-2025 4:00 PM' })
  @IsString()
  departure_date_time!: string;

  @ApiProperty({ example: 'Trivandrum, Domestic Airport' })
  @IsString()
  departure_place!: string;

  @ApiProperty({ example: '', required: false })
  @IsOptional()
  @IsString()
  departure_flight_details?: string;

  @ApiProperty({ example: 'old', description: 'old or new' })
  @IsString()
  price_confirmation_type!: string;

  @ApiProperty({ example: 'undefined', required: false })
  @IsOptional()
  @IsString()
  hotel_group_type?: string;

  @ApiProperty({
    type: [HotelSelectionDto],
    description: 'Selected hotels to be booked during confirmation (multi-provider)',
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HotelSelectionDto)
  hotel_bookings?: HotelSelectionDto[];

  @ApiProperty({
    type: [Number],
    required: false,
    description: 'Route IDs that have supplier-bookable hotels selected in the confirm modal',
  })
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  selected_hotel_route_ids?: number[];

  @ApiProperty({
    type: [Number],
    required: false,
    description: 'Route IDs that are external/self-arranged and must not be copied as booked hotels',
  })
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  external_stay_route_ids?: number[];

  @ApiProperty({ example: '192.168.1.1', required: false })
  @IsOptional()
  @IsString()
  endUserIp?: string;
}

export class WalletBalanceResponseDto {
  @ApiProperty({ example: 12834.0 })
  balance!: number;

  @ApiProperty({ example: '₹ 12,834.00' })
  formatted_balance!: string;

  @ApiProperty({ example: true })
  is_sufficient!: boolean;
}

export class CustomerInfoFormResponseDto {
  @ApiProperty({ example: 'DVI20251210' })
  quotation_no!: string;

  @ApiProperty({ example: 'Aalim Khoja' })
  agent_name!: string;

  @ApiProperty({ example: '12,834.00' })
  wallet_balance!: string;

  @ApiProperty({ example: true })
  balance_sufficient!: boolean;
}
