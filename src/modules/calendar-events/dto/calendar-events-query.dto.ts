import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDefined, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const STRICT_DATE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeLocations(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return Array.from(new Set(values.map((item) => String(item ?? '').trim()).filter(Boolean)));
}

export class CalendarEventsQueryDto {
  @ApiProperty({ example: '2026-10-01' })
  @IsDefined()
  @IsString()
  @Matches(STRICT_DATE)
  from!: string;

  @ApiProperty({ example: '2026-11-30' })
  @IsDefined()
  @IsString()
  @Matches(STRICT_DATE)
  to!: string;

  @ApiPropertyOptional({ type: [String], example: ['Chennai', 'Madurai'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(150, { each: true })
  @Transform(({ value }) => normalizeLocations(value))
  location: string[] = [];
}
