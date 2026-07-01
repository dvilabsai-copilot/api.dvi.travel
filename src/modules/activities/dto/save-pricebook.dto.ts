import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

class NationBlockDto {
  @IsString() @IsOptional()
  adult_cost?: string;

  @IsString() @IsOptional()
  child_cost?: string;

  @IsString() @IsOptional()
  infant_cost?: string;

  @IsString() @IsOptional()
  unit_cost?: string;
}

export class SavePriceBookDto {
  @IsInt()
  hotspot_id!: number; // schema is BigInt -> we cast safely

  @IsString() @IsNotEmpty()
  start_date!: string; // YYYY-MM-DD

  @IsString() @IsNotEmpty()
  end_date!: string;   // YYYY-MM-DD

  @IsString()
  @IsOptional()
  @IsIn(['PER_ADULT', 'UNIT'])
  pricing_unit_type?: 'PER_ADULT' | 'UNIT';

  @IsInt() @IsOptional()
  createdby?: number;

  @IsObject() @IsOptional()
  indian?: NationBlockDto;

  @IsObject() @IsOptional()
  nonindian?: NationBlockDto;
}