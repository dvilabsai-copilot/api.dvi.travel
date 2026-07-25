import { IsBoolean, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Transform } from 'class-transformer';

export class UpdateGstSettingDto {
  @IsOptional()
  @IsString()
  gstTitle?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  gst?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cgst?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  sgst?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  igst?: number;

 /**
   * ✅ Allow UI to toggle status.
   * Handles: true/false, 1/0, "true"/"false", "1"/"0"
 */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value === 'string') {
      const s = value.trim().toLowerCase();
      if (s === 'true' || s === '1') return true;
      if (s === 'false' || s === '0') return false;
    }
    return Boolean(value);
  })
  @IsBoolean()
  status?: boolean;
}
