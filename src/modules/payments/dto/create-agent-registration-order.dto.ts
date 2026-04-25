import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, Min } from 'class-validator';

export class CreateAgentRegistrationOrderDto {
  @ApiProperty({ example: 17, description: 'Target agent id already created in pending/onboarding state' })
  @IsNumber()
  @Min(1)
  agentId!: number;

  @ApiProperty({ example: 2 })
  @IsNumber()
  @Min(1)
  subscriptionPlanId!: number;

  @ApiProperty({ required: false, description: 'Referring agent id to receive referral coupon credit' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  referralAgentId?: number;
}
