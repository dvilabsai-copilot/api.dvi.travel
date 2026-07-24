// FILE: src/modules/hotels/dto/create-review.dto.ts
import { IsInt, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * CreateReviewDto
 *
 * Accepts multiple legacy/new field names from the UI and normalizes them:
 * - rating:     accepts rating | hotel_rating
 * - description: accepts description | hotel_description | hotel_review_description
 * - hotel_id:   required
 *
 * This keeps backward compatibility with existing payloads.
 */
export class CreateReviewDto {
  @IsInt()
  hotel_id!: number;

 /** Normalized rating (string in legacy table) */
  @IsOptional()
  @IsString()
  @Transform(({ value, obj }) => value ?? obj?.hotel_rating ?? obj?.rating)
  rating?: string;

 /** Normalized review description */
  @IsOptional()
  @IsString()
  @Transform(
    ({ value, obj }) =>
      value ?? obj?.hotel_description ?? obj?.hotel_review_description ?? obj?.description,
  )
  description?: string;

  @IsOptional()
  @IsInt()
  createdby?: number;

  @IsOptional()
  @IsInt()
  status?: number;

 /* --------- Legacy aliases (kept optional so existing callers don't break) --------- */

 /** Alias: hotel_rating */
  @IsOptional()
  @IsString()
  hotel_rating?: string;

 /** Alias: hotel_description */
  @IsOptional()
  @IsString()
  hotel_description?: string;

 /** Alias: hotel_review_description */
  @IsOptional()
  @IsString()
  hotel_review_description?: string;
}
