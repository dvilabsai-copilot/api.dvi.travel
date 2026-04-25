import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, Min } from 'class-validator';

export class CreateWalletTopupOrderDto {
  @ApiProperty({ example: 5000, description: 'Top up amount in INR' })
  @IsNumber()
  @Min(1)
  amountInInr!: number;

  @ApiProperty({ required: false, description: 'Optional explicit agent id for admin-triggered top-up' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  agentId?: number;
}
