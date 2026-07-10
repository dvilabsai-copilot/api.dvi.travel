// REPLACE-WHOLE-FILE
// src/modules/vehicle-availability/vehicle-availability.controller.ts

import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { VehicleAvailabilityService } from './vehicle-availability.service';
import { VehicleAvailabilityQueryDto } from './dto/vehicle-availability-query.dto';
import { VehicleAvailabilityResponseDto } from './dto/vehicle-availability-response.dto';

@ApiTags('vehicle-availability')
@ApiBearerAuth()
@Controller('vehicle-availability')
export class VehicleAvailabilityController {
  constructor(private readonly service: VehicleAvailabilityService) {}

  // ---------------------------------------------------------------------------
  // CHART
  // ---------------------------------------------------------------------------
  @Get()
  @ApiOperation({ summary: 'Vehicle availability chart (date range + vendor/type filters)' })
  async getChart(@Query() query: VehicleAvailabilityQueryDto): Promise<VehicleAvailabilityResponseDto> {
    return this.service.getVehicleAvailabilityChart(query);
  }

  // ---------------------------------------------------------------------------
  // DROPDOWNS (filters & modals) — mirrors PHP selectize/autocomplete behavior
  // ---------------------------------------------------------------------------

  @Get('vendors')
  @ApiOperation({ summary: 'Vendors dropdown' })
  async vendors() {
    return this.service.listVendors();
  }

  @Get('vendor-branches')
  @ApiOperation({ summary: 'Vendor branches dropdown (GET ?vendorId=...)' })
  async vendorBranchesGet(@Query('vendorId') vendorId?: string) {
    return this.service.listVendorBranches(vendorId ? Number(vendorId) : null);
  }

  @Get('vehicle-types')
  @ApiOperation({ summary: 'Vehicle types master (for filters)' })
  async vehicleTypes() {
    return this.service.listVehicleTypes();
  }

  @Get('agents')
  @ApiOperation({ summary: 'Agents dropdown (optional)' })
  async agents() {
    return this.service.listAgents();
  }

  @Get('locations')
  @ApiOperation({ summary: 'Location suggestions for Vehicle Origin (GET ?q=...)' })
  async locations(@Query('q') q?: string) {
    return this.service.listLocations(q);
  }

  @Get('location-meta')
  @ApiOperation({ summary: 'Resolve label → {location_id, city_id, state_id, country_id}' })
  async locationMeta(@Query('label') label?: string) {
    return this.service.getLocationMeta(label ?? '');
  }

  // Vendor-specific vehicle types (Selectize in PHP: __ajax_get_vendor_vehicle_types.php)
  @Get('vendor-vehicle-types')
  @ApiOperation({ summary: 'Vendor-specific vehicle types (GET ?vendorId=...)' })
  async vendorVehicleTypes(
    @Query('vendorId') vendorId?: string,
    @Query('vendorIds') vendorIds?: string | string[],
  ) {
    const normalizedVendorIds = Array.isArray(vendorIds)
      ? vendorIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
      : vendorIds
        ? [Number(vendorIds)].filter((id) => Number.isFinite(id) && id > 0)
        : [];
    return this.service.listVendorVehicleTypes(
      vendorId ? Number(vendorId) : null,
      normalizedVendorIds.length > 0 ? normalizedVendorIds : null,
    );
  }

  // Vehicles by vendor + vendor_vehicle_type (Assign modal vehicle dropdown)
  @Get('vehicles-for-assign')
  @ApiOperation({ summary: 'Vehicles for Assign modal (GET ?vendorId=&vendorVehicleTypeId=...)' })
  async vehiclesForAssign(
    @Query('vendorId') vendorId?: string,
    @Query('vendorVehicleTypeId') vendorVehicleTypeId?: string,
  ) {
    return this.service.listVehiclesForAssign(
      vendorId ? Number(vendorId) : null,
      vendorVehicleTypeId ? Number(vendorVehicleTypeId) : null,
    );
  }

  // Drivers by vendor (+ optional vendor_vehicle_type) for Assign modal
  @Get('drivers-for-assign')
  @ApiOperation({ summary: 'Drivers for Assign modal (GET ?vendorId=&vendorVehicleTypeId=...)' })
  async driversForAssign(
    @Query('vendorId') vendorId?: string,
    @Query('vendorVehicleTypeId') vendorVehicleTypeId?: string,
    @Query('itineraryPlanId') itineraryPlanId?: string,
  ) {
    return this.service.listDriversForAssign(
      vendorId ? Number(vendorId) : null,
      vendorVehicleTypeId ? Number(vendorVehicleTypeId) : null,
      itineraryPlanId ? Number(itineraryPlanId) : null,
    );
  }

  @Get('check-vehicle-duplication')
  @ApiOperation({ summary: 'PHP parity: duplicate checks for registration/engine/chassis/insurance' })
  async checkVehicleDuplication(
    @Query('type') type: 'registration_number' | 'engine_number' | 'chassis_number' | 'insurance_policy_number',
    @Query('value') value?: string,
    @Query('vendorId') vendorId?: string,
    @Query('oldValue') oldValue?: string,
  ) {
    return this.service.checkVehicleDuplication({
      type,
      value: value ?? '',
      vendorId: vendorId ? Number(vendorId) : 0,
      oldValue,
    });
  }

  @Get('customer-name')
  @ApiOperation({ summary: 'PHP parity: get primary customer name by itinerary plan id' })
  async customerName(@Query('itineraryPlanId') itineraryPlanId?: string) {
    return this.service.getCustomerName(itineraryPlanId ? Number(itineraryPlanId) : 0);
  }

  // ---------------------------------------------------------------------------
  // MODAL ACTIONS (mirror PHP handlers)
  // ---------------------------------------------------------------------------

  // Add New Vehicle modal → inserts into dvi_vehicle
  @Post('vehicles')
  @ApiOperation({ summary: 'Create vehicle (PHP: ?type=add_vehicle)' })
  async createVehicle(@Body() dto: any) {
    return this.service.createVehicle(dto);
  }

  // Add New Driver modal → inserts into driver master
  @Post('drivers')
  @ApiOperation({ summary: 'Create driver (PHP: ?type=add_driver)' })
  async createDriver(@Body() dto: any) {
    return this.service.createDriver(dto);
  }

  // Assign Vehicle (and optionally driver) to itinerary
  @Post('assign-vehicle')
  @ApiOperation({
    summary:
      'Assign vehicle (and optional driver) to itinerary. Expects itineraryPlanId, vendor_id, vehicle_type_id (vendor_vehicle_type_ID), vehicle_id, driver_id?',
  })
  async assignVehicle(@Body() dto: { itineraryPlanId: number; vendor_id: number; vehicle_type_id: number; vehicle_id: number; driver_id?: number; createdby?: number }) {
    return this.service.assignVehicle(dto);
  }

  // Reassign Driver on an itinerary/vendor (update latest active assignment)
  @Post('reassign-driver')
  @ApiOperation({ summary: 'Reassign driver (PHP: ?type=reassign_driver). Expects itineraryPlanId, vendor_id, driver_id, vehicle_id?' })
  async reassignDriver(@Body() dto: { itineraryPlanId: number; vendor_id: number; driver_id: number; vehicle_id?: number; createdby?: number }) {
    return this.service.reassignDriver(dto);
  }
}
