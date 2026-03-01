import { IsNotEmpty, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AuthDto } from './auth.dto';

export class ProductInfoRequestDto {
  @ValidateNested()
  @Type(() => AuthDto)
  @IsNotEmpty()
  auth: AuthDto;

  @IsNotEmpty()
  propertyId: string;
}

export class ProductInfoDataDto {
  name: string;
  id: string;
}

export class ProductInfoResponseDto {
  message: string;
  status: 'success' | 'failure';
  data: ProductInfoDataDto[];
}
