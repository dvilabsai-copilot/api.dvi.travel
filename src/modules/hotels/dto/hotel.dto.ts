import {
  IsString,
  IsNotEmpty,
  IsDateString,
  IsNumber,
  Min,
  IsArray,
  IsOptional,
  IsObject,
  ValidateNested,
  IsEmail,
  IsMobilePhone,
  IsInt,
  Max,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';

export class RoomOccupancyDTO {
  @IsInt()
  @Min(1)
  @Max(8)
  adults: number;

  @IsInt()
  @Min(0)
  @Max(4)
  children: number;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(17, { each: true })
  childrenAges?: number[];
}

export class HotelSearchDTO {
  @IsString()
  @IsNotEmpty()
  cityCode: string;

  @IsDateString()
  @IsNotEmpty()
  checkInDate: string;

  @IsDateString()
  @IsNotEmpty()
  checkOutDate: string;

  @IsNumber()
  @Min(1)
  @Max(6)
  @IsNotEmpty()
  roomCount: number;

  @IsNumber()
  @Min(1)
  @Max(48)
  @IsNotEmpty()
  guestCount: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  adultCount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  childCount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  infantCount?: number;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(17, { each: true })
  childAges?: number[];

  @IsOptional()
  @IsString()
  hotelName?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{2}$/i, { message: 'guestNationality must be ISO-2 country code' })
  guestNationality?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoomOccupancyDTO)
  occupancies?: RoomOccupancyDTO[];

  @IsArray()
  @IsOptional()
  providers?: string[];

  @IsObject()
  @IsOptional()
  preferences?: {
    minRating?: number;
    maxPrice?: number;
    facilities?: string[];
  };
}

export class GuestDetailsDTO {
  @IsOptional()
  @IsString()
  @Matches(/^(mr|mrs|ms|miss|mx|dr)$/i, {
    message: 'title must be one of Mr, Mrs, Ms, Miss, Mx, Dr',
  })
  title?: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z][A-Za-z\s'-]{1,24}$/, {
    message: 'firstName must be 2-25 characters and contain only letters, spaces, apostrophe or hyphen',
  })
  firstName: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z][A-Za-z\s'-]{1,24}$/, {
    message: 'lastName must be 2-25 characters and contain only letters, spaces, apostrophe or hyphen',
  })
  lastName: string;

  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsMobilePhone()
  @IsNotEmpty()
  phone: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{2}$/i, { message: 'nationality must be ISO-2 country code' })
  nationality?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{5}[0-9]{4}[A-Z]$/, {
    message: 'pan must be a valid PAN format (e.g. ABCDE1234F)',
  })
  pan?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9]{6,20}$/i, {
    message: 'passportNo must be 6-20 alphanumeric characters',
  })
  passportNo?: string;
}

export class RoomSelectionDTO {
  @IsString()
  @IsNotEmpty()
  roomCode: string;

  @IsNumber()
  @Min(1)
  @IsNotEmpty()
  quantity: number;

  @IsNumber()
  @Min(1)
  @IsNotEmpty()
  guestCount: number;
}

export class HotelConfirmationDTO {
  @IsNumber()
  @IsNotEmpty()
  itineraryPlanId: number;

  @IsString()
  @IsNotEmpty()
  searchReference: string;

  @IsString()
  @IsNotEmpty()
  hotelCode: string;

  @IsDateString()
  @IsNotEmpty()
  checkInDate: string;

  @IsDateString()
  @IsNotEmpty()
  checkOutDate: string;

  @IsNumber()
  @Min(1)
  @IsNotEmpty()
  roomCount: number;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{2}$/i, { message: 'guestNationality must be ISO-2 country code' })
  guestNationality?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GuestDetailsDTO)
  @IsNotEmpty()
  guests: GuestDetailsDTO[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoomSelectionDTO)
  @IsNotEmpty()
  rooms: RoomSelectionDTO[];

  @IsString()
  @IsNotEmpty()
  contactName: string;

  @IsEmail()
  @IsNotEmpty()
  contactEmail: string;

  @IsMobilePhone()
  @IsNotEmpty()
  contactPhone: string;
}

export class HotelPaymentDTO {
  @IsString()
  @IsNotEmpty()
  confirmationReference: string;

  @IsString()
  @IsNotEmpty()
  paymentMethod: string; // 'razorpay', 'netbanking', etc.
}

export class CancellationDTO {
  @IsString()
  @IsNotEmpty()
  reason: string;
}
