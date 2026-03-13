/**
 * ARR_info — ARI Date-Range Pull
 *
 * Adapter endpoint: POST /api/v1/staah/arrInfo
 *
 * Request body matches the verified STAAH v2 doc contract for the ARR_info pull call.
 * Route path is our internal adapter name, not a STAAH simulator URL.
 *
 * STAAH v2 doc baseline:
 * {
 *   "propertyid": "934001",
 *   "apikey": "...",
 *   "room_id": "10512556XPQ3",
 *   "rate_id": "STAAH194181",
 *   "action": "ARR_info",
 *   "from_date": "YYYY-MM-DD",
 *   "to_date": "YYYY-MM-DD",
 *   "version": "2"
 * }
 *
 * Response format is adapter-defined (using our stored staah_inventory + staah_rate records).
 * The exact shape STAAH expects in a pull response is not confirmed from available doc snippets.
 */

import { IsDateString, IsIn, IsNotEmpty, IsString } from 'class-validator';

export class ArrInfoRequestDto {
  @IsString()
  @IsNotEmpty()
  propertyid: string;

  @IsString()
  @IsNotEmpty()
  apikey: string;

  @IsString()
  @IsNotEmpty()
  room_id: string;

  @IsString()
  @IsNotEmpty()
  rate_id: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(['ARR_info'])
  action: string;

  @IsDateString()
  @IsNotEmpty()
  from_date: string;

  @IsDateString()
  @IsNotEmpty()
  to_date: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(['2'])
  version: string;
}

/** Adapter-defined inventory record returned in ARR_info pull response */
export class ArrInventoryEntryDto {
  start_date: string;
  end_date: string;
  free: number;
}

/** Adapter-defined rate record returned in ARR_info pull response */
export class ArrRateEntryDto {
  start_date: string;
  end_date: string;
  occupancy_rates: Record<string, any>;
}

/**
 * ArrInfoResponseDto — adapter-defined response.
 * NOTE: exact response shape expected by STAAH is not confirmed from available doc snippets.
 */
export class ArrInfoResponseDto {
  status: 'success' | 'fail';
  error_desc: string;
  trackingId: string;
  inventory?: ArrInventoryEntryDto[];
  rates?: ArrRateEntryDto[];
}
