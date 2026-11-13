import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, IsUrl, Matches, Max, MaxLength, Min } from 'class-validator';

/** DVI_AGENT_ADS_JSON_STORAGE_V1: Matches the already-installed frontend API contract. */
export class SaveAgentDashboardAdDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title!: string;

  @IsString()
  @Matches(/^\/uploads\/agent_dashboard_ads\/[A-Za-z0-9._-]+$/)
  imagePath!: string;

  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['https'] })
  @MaxLength(2048)
  targetUrl?: string | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;
}

export class SetAgentDashboardAdEnabledDto {
  @IsBoolean()
  enabled!: boolean;
}
