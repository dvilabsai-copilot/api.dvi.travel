import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsDefined, IsEmail, IsIn, IsInt,
  IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { offlineHotelBookingStatuses, type OfflineHotelBookingStatus } from '../utils/offline-hotel-booking-status';

const calendarDate = /^\d{4}-\d{2}-\d{2}$/;
const maxInt = 2_147_483_647;

export class RespondToOfflineVoucherDto {
  @IsIn(offlineHotelBookingStatuses)
  status!: OfflineHotelBookingStatus;

  @IsString()
  @MaxLength(100)
  reservationNumber!: string;

  @IsString()
  @Matches(/\S/)
  @MaxLength(100)
  verifiedBy!: string;

  @IsString()
  @Matches(/\S/)
  @MaxLength(32)
  phone!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MaxLength(2000)
  remarks!: string;
}

class OfflineVoucherResponseDto extends RespondToOfflineVoucherDto {
  @IsDateString()
  submittedAt!: string;
}

class OfflineBookingRoomDto {
  @IsOptional()
  @Matches(calendarDate)
  @IsDateString({ strict: true })
  nightDate?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(250)
  category!: string;

  @IsInt()
  @Min(1)
  @Max(maxInt)
  quantity!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  rate!: number;

  @IsInt()
  @Min(0)
  @Max(maxInt)
  extraBeds!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  extraBedRate!: number;

  @IsInt()
  @Min(0)
  @Max(maxInt)
  childrenWithoutBed!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  childWithoutBedRate!: number;
}

class OfflineBookingCancellationDto {
  @Matches(calendarDate)
  @IsDateString({ strict: true })
  beforeDate!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  percentage!: number;
}

export class OfflineHotelBookingDetailsDto {
  @IsString()
  @MaxLength(250)
  confirmedBy!: string;

  @IsArray()
  @ArrayMaxSize(20)
  @IsEmail({}, { each: true })
  @MaxLength(254, { each: true })
  emails!: string[];

  @IsString()
  @MaxLength(32)
  phone!: string;

  @IsIn(offlineHotelBookingStatuses)
  status!: OfflineHotelBookingStatus;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OfflineBookingRoomDto)
  rooms!: OfflineBookingRoomDto[];

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OfflineBookingCancellationDto)
  cancellationPolicies!: OfflineBookingCancellationDto[];

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => OfflineVoucherResponseDto)
  hotelResponse?: OfflineVoucherResponseDto;
}

class OfflineHotelStayIdentityDto {
  @IsInt()
  @Min(1)
  @Max(maxInt)
  routeId!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  hotelKey!: string;

  @Matches(calendarDate)
  @IsDateString({ strict: true })
  checkIn!: string;

  @Matches(calendarDate)
  @IsDateString({ strict: true })
  checkOut!: string;
}

export class SaveOfflineHotelBookingDto extends OfflineHotelStayIdentityDto {
  @IsInt()
  @Min(0)
  @Max(maxInt - 1)
  version!: number;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => OfflineHotelBookingDetailsDto)
  details!: OfflineHotelBookingDetailsDto;
}

export class ReadOfflineHotelContactsDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  hotelKeys!: string[];
}

export class OfflineVoucherStayDto extends OfflineHotelStayIdentityDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  hotelName!: string;

  @IsString()
  @MaxLength(500)
  destination!: string;
}

export class PreviewOfflineVoucherDto {
  @IsIn(['hotel-voucher'])
  template!: 'hotel-voucher';

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => OfflineVoucherStayDto)
  stay!: OfflineVoucherStayDto;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => OfflineHotelBookingDetailsDto)
  details!: OfflineHotelBookingDetailsDto;
}

class OfflineVoucherTargetDto extends OfflineVoucherStayDto {
  @IsInt()
  @Min(1)
  @Max(maxInt)
  version!: number;
}

export class SendOfflineVouchersDto {
  @IsIn(['hotel-voucher'])
  template!: 'hotel-voucher';

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => OfflineVoucherTargetDto)
  stays!: OfflineVoucherTargetDto[];
}
