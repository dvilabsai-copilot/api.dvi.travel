import { IsInt } from 'class-validator';

export class ToggleStatusDto {
  @IsInt()
 status!: number; // 0/1
}
