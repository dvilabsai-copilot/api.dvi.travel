import { IsIn, IsNotEmpty, IsString } from 'class-validator';

export class RatePlanInfoRequestDto {
  @IsString()
  @IsNotEmpty()
  propertyid: string;

  @IsString()
  @IsNotEmpty()
  apikey: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(['roomrate_info'])
  action: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(['2'])
  version: string;
}

export class RoomTypeDto {
  room_id: string;
  OTA_room_id?: string;
  room_name: string;
}

export class RatePlanDto {
  room_id: string;
  rate_id: string;
  OTA_room_id?: string;
  OTA_rate_id?: string;
  rate_name: string;
  currency: string;
}

export class RoomRateMappingDto {
  room_id: string;
  rate_id: string;
  OTA_room_id?: string;
  OTA_rate_id?: string;
}

export class RatePlanInfoResponseDto {
  /**
   * Adapter-defined response body based on current implementation.
   * The fully official STAAH response schema is not yet proven from docs.
   */
  roomtypes: RoomTypeDto[];
  rateplans: RatePlanDto[];
  room_rate_mapping: RoomRateMappingDto[];
  trackingId: string;
  status?: 'success' | 'fail';
  error_desc?: string;
}
