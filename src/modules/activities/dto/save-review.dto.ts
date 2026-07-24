import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class SaveReviewDto {
  @IsInt() @IsOptional()
  reviewId?: number;

  @IsString() @IsNotEmpty()
 activity_rating!: string; // keep as string to mirror PHP; validate UI-side 1..5

  @IsString() @IsOptional()
 @MaxLength(20) // schema limit: VarChar(20)
  activity_description?: string;

  @IsInt() @IsOptional()
  createdby?: number;
}
