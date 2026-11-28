import { ApiProperty } from '@nestjs/swagger';
import { TransportAvailabilityKind } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateTransportAvailabilityPeriodDto {
  @ApiProperty({
    enum: TransportAvailabilityKind,
  })
  @IsEnum(TransportAvailabilityKind)
  kind!: TransportAvailabilityKind;

  @ApiProperty()
  @IsInt()
  @Min(1)
  resourceId!: number;

  @ApiProperty()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  startsAt!: string;

  @ApiProperty()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  endsAt!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  reason!: string;
}

export class TransportAvailabilityRangeDto {
  @ApiProperty()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateFrom!: string;

  @ApiProperty()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateTo!: string;
}

export class CancelTransportAvailabilityPeriodDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  id!: number;
}