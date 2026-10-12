import {
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';
import {
  IMPERSONATION_ENTITY_TYPES,
  ImpersonationEntityType,
} from '../impersonation.constants';

export class ResolveImpersonationDto {
  @IsIn(IMPERSONATION_ENTITY_TYPES)
  entityType!: ImpersonationEntityType;

  @IsInt()
  @Min(1)
  entityId!: number;

  /**
   * Optional verified login-account ID.  When omitted, resolve returns every
   * active eligible account so the ADMIN can explicitly choose one.
   */
  @IsOptional()
  @IsString()
  targetUserId?: string;

  /**
   * Legacy management-row contact value. It is accepted for compatibility
   * but is never used to choose a login account.
   */
  @IsOptional()
  @IsEmail()
  targetEmail?: string;
}

export class StartImpersonationDto {
  @IsString()
  @IsNotEmpty()
  targetUserId!: string;

  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class RedeemImpersonationDto {
  @IsString()
  @Length(32, 128)
  ticket!: string;
}
