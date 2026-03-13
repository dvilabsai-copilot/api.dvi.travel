/**
 * year_info_ARR — ARI Full-Year Pull
 *
 * Adapter endpoint: POST /api/v1/staah/yearInfoArr
 *
 * Request body matches the verified STAAH v2 doc contract for the year_info_ARR pull call.
 * Route path is our internal adapter name, not a STAAH simulator URL.
 *
 * STAAH v2 doc baseline:
 * {
 *   "propertyid": "934001",
 *   "apikey": "...",
 *   "room_id": "10512556XPQ3",
 *   "rate_id": "STAAH194181",
 *   "action": "year_info_ARR",
 *   "version": "2"
 * }
 *
 * Response format is adapter-defined (using our stored staah_inventory + staah_rate records).
 * The exact shape STAAH expects in a full-year pull response is not confirmed from available doc snippets.
 */

import { IsIn, IsNotEmpty, IsString } from 'class-validator';
import {
  ArrDataEntryDto,
  ArrInventoryEntryDto,
  ArrRateEntryDto,
  ArrRestrictionEntryDto,
} from './arr-info.dto';

export class YearInfoArrRequestDto {
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
  @IsIn(['year_info_ARR'])
  action: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(['2'])
  version: string;
}

/**
 * YearInfoArrResponseDto — adapter-defined response.
 * NOTE: exact response shape expected by STAAH is not confirmed from available doc snippets.
 */
export class YearInfoArrResponseDto {
  status: 'success' | 'fail';
  error_desc: string;
  trackingId: string;
  propertyid?: string;
  room_id?: string;
  rate_id?: string;
  currency?: string;
  data?: ArrDataEntryDto[];
  inventory?: ArrInventoryEntryDto[];
  rates?: ArrRateEntryDto[];
  restrictions?: ArrRestrictionEntryDto[];
}
