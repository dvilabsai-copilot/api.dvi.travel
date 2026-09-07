import { IsInt, Max, Min } from 'class-validator';

export class CreatePublicItineraryLinkDto {
  @IsInt()
  @Min(1)
  itineraryPlanId!: number;

  @IsInt()
  @Min(1)
  @Max(4)
  groupType!: number;
}