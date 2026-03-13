import { IsIn, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

/**
 * ModifyReservationRequestDto — ADAPTER/CUSTOM EXTENSION
 *
 * This endpoint is NOT a confirmed official STAAH v2 operation.
 * It is kept for local business flow purposes (payload logging/storage only).
 * Do NOT reference this as an official STAAH contract in Excel or certification forms.
 */
export class ModifyReservationRequestDto {
  @IsString()
  @IsNotEmpty()
  propertyid: string;

  @IsString()
  @IsNotEmpty()
  apikey: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(['2'])
  version: string;

  @IsString()
  @IsOptional()
  reservationId?: string;

  @IsObject()
  @IsOptional()
  data?: Record<string, any>;

  @IsObject()
  @IsOptional()
  reservations?: Record<string, any>;

  @IsString()
  @IsOptional()
  trackingId?: string;
}

export class ModifyReservationResponseDto {
  status: 'success' | 'fail';
  error_desc: string;
}
