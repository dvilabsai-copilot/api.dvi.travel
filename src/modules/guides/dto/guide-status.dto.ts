
// FILE: src/modules/guides/dto/guide-status.dto.ts
import { IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class GuideStatusDto {
  @Type(() => Number) @IsInt() @Min(0)
 status!: number; // 0/1
}
