import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from "class-validator";

export class CreateVehicleTypeDto {
  @IsOptional()
  @IsString()
  title?: string;

 // PHP name
  @IsOptional()
  @IsString()
  vehicle_type_title?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  occupancy?: number;

 // alternate name seen in legacy UIs
  @IsOptional()
  @IsInt()
  @Min(0)
  no_of_seats?: number;

 // frontend may send boolean; some screens send 0/1
  @IsOptional()
  status?: any;
}
