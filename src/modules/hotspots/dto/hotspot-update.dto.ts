// FILE: src/modules/hotspots/dto/hotspot-update.dto.ts

import { PartialType } from '@nestjs/mapped-types';
import { HotspotCreateDto } from './hotspot-create.dto';
import { IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

// Update = partial create + optional id (since your save uses body.id)
export class HotspotUpdateDto extends PartialType(HotspotCreateDto) {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
 id?: number; // hotspot_ID
}
