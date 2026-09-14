import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

const STRICT_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TRAVEL_IMPACTS = ['UNSPECIFIED', 'LOW', 'MEDIUM', 'HIGH'] as const;

export class CreateCalendarEventDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  eventKey!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  shortTitle?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  eventType!: string;

  @IsString()
  @Matches(STRICT_DATE)
  eventStartDate!: string;

  @IsString()
  @Matches(STRICT_DATE)
  eventEndDate!: string;

  @IsString()
  @Matches(STRICT_DATE)
  travelWindowStartDate!: string;

  @IsString()
  @Matches(STRICT_DATE)
  travelWindowEndDate!: string;

  @IsOptional()
  @IsBoolean()
  isPublicHoliday?: boolean;

  @IsOptional()
  @IsIn(TRAVEL_IMPACTS)
  travelImpact?: (typeof TRAVEL_IMPACTS)[number];

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  travelAdvisory?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  sourceName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  sourceReference?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortPriority?: number;

  @IsOptional()
  @IsInt()
  @IsIn([0, 1])
  status?: number;
}
