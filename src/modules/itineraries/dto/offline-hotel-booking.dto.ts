import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsDateString, IsDefined, IsEmail, IsIn, IsInt,
  IsNotEmpty, IsNumber, IsObject, IsString, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';

const bookingStatuses = ['pending', 'confirmed', 'cancelled'] as const;
const calendarDate = /^\d{4}-\d{2}-\d{2}$/;
const maxInt = 2_147_483_647;

class OfflineBookingRoomDto {
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

  @IsIn(bookingStatuses)
  status!: (typeof bookingStatuses)[number];

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
}

export class SaveOfflineHotelBookingDto {
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
