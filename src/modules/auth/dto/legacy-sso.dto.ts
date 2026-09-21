import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class RedeemLegacySsoTicketDto {
  @IsString()
  @MinLength(64)
  @MaxLength(64)
  @Matches(/^[a-f0-9]{64}$/i)
  ticket!: string;
}
