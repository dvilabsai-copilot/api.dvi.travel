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
  @Max(17, { each: true })
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

  @ApiProperty({ example: '1035259!TB!2!TB!27fe40ea-75db-11f0-8023-825b5693933e!TB!AFF!' })
  @IsString()
  bookingCode!: string;

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
