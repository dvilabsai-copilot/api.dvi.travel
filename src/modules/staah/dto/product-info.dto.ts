import { IsIn, IsNotEmpty, IsString } from 'class-validator';

export class ProductInfoRequestDto {
  @IsString()
  @IsNotEmpty()
  propertyid: string;

  @IsString()
  @IsNotEmpty()
  apikey: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(['property_info'])
  action: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(['2'])
  version: string;
}

export class ContactInfoDto {
  zip: string;
  latitude: string;
  longitude: string;
  country: string;
  addressline: string;
  city: string;
  fax: string;
  telephone: string;
  location: string;
}

export class ProductInfoResponseDto {
  /**
   * Adapter-defined response body based on current implementation.
   * The fully official STAAH response schema is not yet proven from docs.
   */
  currency: string;
  propertyname: string;
  checkintime: string;
  checkouttime: string;
  contactinfo: ContactInfoDto;
  trackingId: string;
  status?: 'success' | 'fail';
  error_desc?: string;
}
