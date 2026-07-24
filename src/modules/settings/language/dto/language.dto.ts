// FILE: src/modules/language/dto/language.dto.ts

import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateLanguageDto {
  @IsString()
  @MaxLength(100)
  language!: string;

 /**
   * Frontend sends boolean (true/false).
   * DB stores Int (1/0).
 */
  @IsOptional()
  @IsBoolean()
  status?: boolean;
}

export class UpdateLanguageDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  language?: string;

  @IsOptional()
  @IsBoolean()
  status?: boolean;
}
