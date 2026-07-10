// src/modules/vehicle-availability/dto/vehicle-availability-response.dto.ts

import { ApiProperty } from '@nestjs/swagger';

export class VehicleAvailabilityRouteSegmentDto {
  @ApiProperty()
  locationName!: string;

  @ApiProperty()
  nextVisitingLocation!: string;
}

export class VehicleAvailabilityCellDto {
  @ApiProperty()
  date!: string; // YYYY-MM-DD

  @ApiProperty({ required: false, nullable: true })
  itineraryPlanId!: number | null;

  @ApiProperty({ required: false, nullable: true })
  itineraryQuoteId!: string | null;

  @ApiProperty()
  isWithinTrip!: boolean;

  @ApiProperty()
  isStart!: boolean;

  @ApiProperty()
  isEnd!: boolean;

  @ApiProperty()
  isInBetween!: boolean;

  @ApiProperty()
  isToday!: boolean;

  @ApiProperty()
  isVehicleAssigned!: boolean;

  @ApiProperty({ required: false, nullable: true })
  assignedVehicleId!: number | null;

  @ApiProperty()
  hasDriver!: boolean;

  @ApiProperty({ required: false, nullable: true })
  driverId!: number | null;

  @ApiProperty({ required: false, nullable: true })
  driverAssignmentId!: number | null;

  @ApiProperty({ type: [VehicleAvailabilityRouteSegmentDto] })
  routeSegments!: VehicleAvailabilityRouteSegmentDto[];

  @ApiProperty({ required: false, nullable: true })
  customerName!: string | null;

  @ApiProperty({ required: false, nullable: true })
  customerContactNo!: string | null;

  @ApiProperty({ required: false, nullable: true })
  customerLabel!: string | null;

  @ApiProperty({ required: false, nullable: true })
  hotelName!: string | null;

  @ApiProperty({ required: false, nullable: true })
  tripStartLabel!: string | null;

  @ApiProperty({ required: false, nullable: true })
  tripEndLabel!: string | null;

  @ApiProperty({ required: false, nullable: true })
  tripStartTime!: string | null;

  @ApiProperty({ required: false, nullable: true })
  tripEndTime!: string | null;
}

export class VehicleAvailabilityRowDto {
  @ApiProperty()
  vendorId!: number;

  @ApiProperty()
  vendorName!: string;

  @ApiProperty()
  vehicleTypeId!: number;

  @ApiProperty()
  vehicleTypeTitle!: string;

  @ApiProperty()
  vehicleId!: number;

  @ApiProperty()
  registrationNumber!: string;

  @ApiProperty({ type: [VehicleAvailabilityCellDto] })
  cells!: VehicleAvailabilityCellDto[];
}

export class VehicleAvailabilityResponseDto {
  @ApiProperty({ type: [String] })
  dates!: string[]; // YYYY-MM-DD

  @ApiProperty({ type: [VehicleAvailabilityRowDto] })
  rows!: VehicleAvailabilityRowDto[];
}
