import { IsIn, IsNotEmpty, IsString } from 'class-validator';

export class MappingRequestDto {
  @IsString()
  @IsNotEmpty()
  propertyid: string;

  @IsString()
  @IsNotEmpty()
  apikey: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(['2'])
  version: string;
}

export class MappingEntryDto {
  room_id: string;
  room_name: string;
  rate_id: string;
  rate_name: string;
  manageable: 'Y' | 'N';
}

export class MappingResponseDto {
  room_rate_mapping: MappingEntryDto[];
  status: 'success' | 'fail';
  error_desc: string;
}