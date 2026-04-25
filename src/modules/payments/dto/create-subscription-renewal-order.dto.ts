import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, Min } from 'class-validator';

export class CreateSubscriptionRenewalOrderDto {
  @ApiProperty({ example: 3 })
  @IsNumber()
  @Min(1)
  subscriptionPlanId!: number;

  @ApiProperty({ required: false, description: 'Existing subscribed plan row used for renewal with additional staff charges' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  agentSubscribedPlanId?: number;

  @ApiProperty({ required: false, description: 'Optional explicit agent id for admin-triggered renewal' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  agentId?: number;
}
