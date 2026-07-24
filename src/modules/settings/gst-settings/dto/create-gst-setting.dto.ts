import { IsNumber, IsString, Min } from 'class-validator';

export class CreateGstSettingDto {
  @IsString()
  gstTitle!: string;

  @IsNumber()
  @Min(0)
  gst!: number;

  @IsNumber()
  @Min(0)
  cgst!: number;

  @IsNumber()
  @Min(0)
  sgst!: number;

  @IsNumber()
  @Min(0)
  igst!: number;

 // frontend may send status, but PHP ignores on create (always sets status=1)
  status?: boolean;
}
