import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * ReservationItemDto intentionally validates only the small subset of fields
 * currently observed/used in this codebase. The full STAAH reservation item
 * schema is not yet proven from official docs, so unknown fields are preserved
 * as pass-through payload data by the global ValidationPipe configuration.
 */
export class ReservationItemDto {
  @IsString()
  @IsOptional()
  bookingId?: string;

  @IsString()
  @IsOptional()
  bookingid?: string;

  @IsString()
  @IsOptional()
  room_id?: string;

  @IsString()
  @IsOptional()
  rate_id?: string;

  @IsString()
  @IsOptional()
  checkIn?: string;

  @IsString()
  @IsOptional()
  checkOut?: string;
}

export class ReservationEnvelopeDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReservationItemDto)
  reservation: ReservationItemDto[];
}

export class ReservationRequestDto {
  @IsString()
  @IsNotEmpty()
  propertyid: string;

  @IsString()
  @IsNotEmpty()
  apikey: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(['reservation_info'])
  action: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(['2'])
  version: string;

  @IsObject()
  @IsNotEmpty()
  @ValidateNested()
  @Type(() => ReservationEnvelopeDto)
  reservations: ReservationEnvelopeDto;

  @IsObject()
  @IsOptional()
  extraData?: Record<string, any>;

  @IsString()
  @IsOptional()
  trackingId?: string;
}

export class ReservationAckDto {
  /**
   * Adapter-defined acknowledgement item based on current verified samples.
   * The fully official STAAH acknowledgement schema is not fully proven yet.
   */
  bookingId: string;
  status: 'success' | 'fail';
  error_desc: string;
}

export class ReservationTrackingDto {
  trackingId: string;
}
