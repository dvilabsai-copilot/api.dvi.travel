// FILE: src/modules/vendors/vendors.controller.ts

import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { VendorsService } from './vendors.service';
import { VendorListItemDto } from './dto/vendor-list-item.dto';
import { Public } from '../../auth/public.decorator';

type DropdownItem = {
  id: string;
  label: string;
};

@ApiTags('vendors')
@Controller('vendors')
export class VendorsController {
  constructor(private readonly vendorsService: VendorsService) {}

  /**
   * List vendors for the main Vendors grid.
   *
   * This is equivalent to the old engine/json/__JSONvendor.php,
   * but returns a clean JSON collection of VendorListItemDto.
   *
   * NOTE: Marked as @Public() so it can be used before auth is fully wired.
   * You can remove @Public() later if needed.
   */
  @Public()
  @Get()
  @ApiOperation({
    summary: 'List vendors',
    description:
      'Returns all active vendors from dvi_vendor_details along with computed branch counts from dvi_vendor_branches.',
  })
  @ApiOkResponse({ type: VendorListItemDto, isArray: true })
  async list(): Promise<VendorListItemDto[]> {
    return this.vendorsService.listVendors();
  }

  /**
   * Get full vendor details (basic info + branches) for the edit form.
   * This is what the React "Edit Vendor" form should call for pre-fill.
   */
  @Public()
  @Get(':id')
  @ApiOperation({
    summary: 'Get vendor detail',
    description:
      'Loads a single vendor row from dvi_vendor_details and all its non-deleted branches from dvi_vendor_branches.',
  })
  async getOne(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<any> {
    return this.vendorsService.getVendorDetail(id);
  }

  /**
   * Create a new vendor (basic info step).
   *
   * The payload should mirror what the old PHP form was posting to
   * __ajax_manage_vendor.php?type=vendor_basic_info, i.e. use column-style
   * keys such as vendor_name, vendor_code, vendor_primary_mobile_number,
   * vendor_email, vendor_margin, vendor_margin_gst_type, etc.
   */
  @Post()
  @ApiOperation({
    summary: 'Create vendor basic info',
    description:
      'Creates a new row in dvi_vendor_details and returns data suitable for the vendor edit wizard pre-fill.',
  })
  async create(
    @Body() body: any,
  ): Promise<any> {
    return this.vendorsService.createVendorBasicInfo(body);
  }

  /**
   * Update vendor basic info for an existing vendor.
   * Called when saving the Basic Info step in the edit form.
   */
  @Put(':id')
  @ApiOperation({
    summary: 'Update vendor basic info',
    description:
      'Updates dvi_vendor_details for the given vendor_id using the payload coming from the vendor form.',
  })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ): Promise<any> {
    return this.vendorsService.updateVendorBasicInfo(id, body);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Patch vendor basic info',
    description: 'Partial update support for wizard compatibility.',
  })
  async patch(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ): Promise<any> {
    return this.vendorsService.updateVendorBasicInfo(id, body);
  }

  @Public()
  @Post(':id/status-toggle')
  @ApiOperation({ summary: 'Toggle vendor active status' })
  async toggleStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { oldstatus?: number; status?: number },
  ): Promise<{ success: boolean; status: number }> {
    const oldStatus = Number(body?.oldstatus ?? body?.status ?? 0);
    const status = await this.vendorsService.toggleVendorStatus(id, oldStatus);
    return { success: true, status };
  }

  @Public()
  @Delete(':id')
  @ApiOperation({
    summary: 'Soft delete vendor',
    description:
      'Marks vendor and its branches as deleted (deleted = 1, status = 0) in dvi_vendor_details and dvi_vendor_branches.',
  })
  async deleteVendor(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ success: boolean }> {
    await this.vendorsService.softDeleteVendor(id);
    return { success: true };
  }

  // --- Step 3: Driver Costs ---

  @Public()
  @Get(':id/vehicle-types')
  @ApiOperation({ summary: 'Get vendor vehicle types (Driver Costs)' })
  async getVehicleTypes(@Param('id', ParseIntPipe) id: number): Promise<any[]> {
    return this.vendorsService.getVendorVehicleTypes(id);
  }

  @Public()
  @Post(':id/vehicle-types')
  @ApiOperation({ summary: 'Update vendor vehicle type (Driver Cost)' })
  async updateVehicleType(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ): Promise<any> {
    return this.vendorsService.updateVendorVehicleType(id, body);
  }

  @Public()
  @Get(':id/vehicle-type-costs')
  @ApiOperation({ summary: 'Alias: get vendor vehicle type costs' })
  async getVehicleTypeCosts(@Param('id', ParseIntPipe) id: number): Promise<any[]> {
    return this.vendorsService.getVendorVehicleTypes(id);
  }

  @Public()
  @Post(':id/vehicle-type-costs')
  @ApiOperation({ summary: 'Alias: update vendor vehicle type costs' })
  async updateVehicleTypeCosts(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ): Promise<any> {
    return this.vendorsService.updateVendorVehicleType(id, body);
  }

  @Public()
@Patch(':id/vehicle-type-costs/:rowId')
@ApiOperation({ summary: 'Update one vendor vehicle type cost row' })
async patchVehicleTypeCost(
  @Param('id', ParseIntPipe) id: number,
  @Param('rowId', ParseIntPipe) rowId: number,
  @Body() body: any,
): Promise<any> {
  return this.vendorsService.patchVendorVehicleTypeCost(id, rowId, body);
}

@Public()
@Delete(':id/vehicle-type-costs/:rowId')
@ApiOperation({ summary: 'Delete one vendor vehicle type cost row' })
async deleteVehicleTypeCost(
  @Param('id', ParseIntPipe) id: number,
  @Param('rowId', ParseIntPipe) rowId: number,
): Promise<{ success: boolean }> {
  await this.vendorsService.deleteVendorVehicleTypeCost(id, rowId);
  return { success: true };
}

  // --- Step 4: Vehicle Info ---

  @Public()
  @Get(':id/vehicles')
  @ApiOperation({ summary: 'Get vendor vehicles' })
  async getVehicles(@Param('id', ParseIntPipe) id: number): Promise<any[]> {
    return this.vendorsService.getVendorVehicles(id);
  }

  @Public()
  @Post(':id/vehicles')
  @ApiOperation({ summary: 'Create vendor vehicle' })
  async createVehicle(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ): Promise<any> {
    return this.vendorsService.createVendorVehicle(id, body);
  }

  @Public()
  @Put('vehicles/:vehicleId')
  @ApiOperation({ summary: 'Update vendor vehicle' })
  async updateVehicle(
    @Param('vehicleId', ParseIntPipe) vehicleId: number,
    @Body() body: any,
  ): Promise<any> {
    return this.vendorsService.updateVendorVehicle(vehicleId, body);
  }

  @Public()
  @Post('vehicles/:vehicleId/status-toggle')
  @ApiOperation({ summary: 'Toggle vendor vehicle status' })
  async toggleVehicleStatus(
    @Param('vehicleId', ParseIntPipe) vehicleId: number,
    @Body() body: { oldstatus?: number; status?: number },
  ): Promise<{ success: boolean; status: number }> {
    const oldStatus = Number(body?.oldstatus ?? body?.status ?? 0);
    const status = await this.vendorsService.toggleVendorVehicleStatus(vehicleId, oldStatus);
    return { success: true, status };
  }

  @Public()
  @Delete('vehicles/:vehicleId')
  @ApiOperation({ summary: 'Delete vendor vehicle' })
  async deleteVehicle(@Param('vehicleId', ParseIntPipe) vehicleId: number): Promise<void> {
    return this.vendorsService.softDeleteVehicle(vehicleId);
  }

  // --- Step 5: Pricebook ---

  @Public()
  @Get(':id/pricebook/local')
  @ApiOperation({ summary: 'Get vendor local pricebook' })
  async getLocalPricebook(@Param('id', ParseIntPipe) id: number): Promise<any[]> {
    return this.vendorsService.getVendorLocalPricebook(id);
  }

  @Public()
  @Post(':id/pricebook/local')
  @ApiOperation({ summary: 'Update vendor local pricebook' })
  async updateLocalPricebook(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ): Promise<any> {
    return this.vendorsService.updateVendorLocalPricebook(id, body);
  }

  @Public()
  @Get(':id/local-pricebook')
  @ApiOperation({ summary: 'Alias: get vendor local pricebook' })
  async getLocalPricebookAlias(@Param('id', ParseIntPipe) id: number): Promise<any[]> {
    return this.vendorsService.getVendorLocalPricebook(id);
  }

  @Public()
  @Get(':id/pricebook/local/form-rows')
  @ApiOperation({ summary: 'Get PHP-parity local pricebook form rows (branch + vehicle type + time limit)' })
  async getLocalPricebookFormRows(@Param('id', ParseIntPipe) id: number): Promise<any[]> {
    return this.vendorsService.getVendorLocalPricebookFormRows(id);
  }

  @Public()
  @Get(':id/pricebook/local/preview')
  @ApiOperation({ summary: 'Get local pricebook date-range preview (PHP ajax parity)' })
  async getLocalPricebookPreview(
    @Param('id', ParseIntPipe) id: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<any> {
    return this.vendorsService.getVendorLocalPricebookPreview(id, startDate, endDate);
  }

  @Public()
  @Get(':id/pricebook/outstation/preview')
  @ApiOperation({ summary: 'Get outstation pricebook date-range preview (PHP ajax parity)' })
  async getOutstationPricebookPreview(
    @Param('id', ParseIntPipe) id: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<any> {
    return this.vendorsService.getVendorOutstationPricebookPreview(id, startDate, endDate);
  }

  @Public()
  @Post(':id/local-pricebook')
  @ApiOperation({ summary: 'Alias: update vendor local pricebook' })
  async updateLocalPricebookAlias(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ): Promise<any> {
    return this.vendorsService.updateVendorLocalPricebook(id, body);
  }

  @Public()
  @Get(':id/pricebook/outstation')
  @ApiOperation({ summary: 'Get vendor outstation pricebook' })
  async getOutstationPricebook(@Param('id', ParseIntPipe) id: number): Promise<any[]> {
    return this.vendorsService.getVendorOutstationPricebook(id);
  }

  @Public()
  @Post(':id/pricebook/outstation')
  @ApiOperation({ summary: 'Update vendor outstation pricebook' })
  async updateOutstationPricebook(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ): Promise<any> {
    return this.vendorsService.updateVendorOutstationPricebook(id, body);
  }

  @Public()
  @Get(':id/outstation-pricebook')
  @ApiOperation({ summary: 'Alias: get vendor outstation pricebook' })
  async getOutstationPricebookAlias(@Param('id', ParseIntPipe) id: number): Promise<any[]> {
    return this.vendorsService.getVendorOutstationPricebook(id);
  }

  @Public()
  @Get(':id/pricebook/outstation/form-rows')
  @ApiOperation({ summary: 'Get PHP-parity outstation pricebook form rows (branch + vehicle type + kms limit)' })
  async getOutstationPricebookFormRows(@Param('id', ParseIntPipe) id: number): Promise<any[]> {
    return this.vendorsService.getVendorOutstationPricebookFormRows(id);
  }

  @Public()
  @Post(':id/outstation-pricebook')
  @ApiOperation({ summary: 'Alias: update vendor outstation pricebook' })
  async updateOutstationPricebookAlias(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ): Promise<any> {
    return this.vendorsService.updateVendorOutstationPricebook(id, body);
  }

  // --- Step 6: Permit Cost ---

  @Public()
  @Get(':id/permit-costs')
  @ApiOperation({ summary: 'Get vendor permit costs' })
  async getPermitCosts(@Param('id', ParseIntPipe) id: number): Promise<any[]> {
    return this.vendorsService.getVendorPermitCosts(id);
  }

  @Public()
  @Post(':id/permit-costs')
  @ApiOperation({ summary: 'Update vendor permit cost' })
  async updatePermitCost(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ): Promise<any> {
    return this.vendorsService.updateVendorPermitCost(id, body);
  }

  @Public()
  @Delete(':id/permit-costs')
  @ApiOperation({ summary: 'Delete vendor permit cost group by vendor vehicle type and source state' })
  async deletePermitCostGroup(
    @Param('id', ParseIntPipe) id: number,
    @Query('vendor_vehicle_type_id', ParseIntPipe) vendorVehicleTypeId: number,
    @Query('source_state_id', ParseIntPipe) sourceStateId: number,
  ): Promise<{ success: boolean; deletedCount: number }> {
    return this.vendorsService.deleteVendorPermitCostGroup(id, vendorVehicleTypeId, sourceStateId);
  }

  @Public()
  @Get(':id/outstation-km-limits')
  @ApiOperation({ summary: 'Get vendor outstation KM limits' })
  async getOutstationKmLimits(@Param('id', ParseIntPipe) id: number): Promise<any[]> {
    return this.vendorsService.getVendorOutstationKmLimits(id);
  }

  @Public()
  @Get(':id/vehicle-extra-costs')
  @ApiOperation({ summary: 'Get vendor vehicle extra cost rows (PHP parity)' })
  async getVehicleExtraCosts(@Param('id', ParseIntPipe) id: number): Promise<any[]> {
    return this.vendorsService.getVendorVehicleExtraCosts(id);
  }

  @Public()
  @Post(':id/vehicle-extra-costs')
  @ApiOperation({ summary: 'Update vendor vehicle extra costs (PHP parity)' })
  async updateVehicleExtraCosts(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ): Promise<any> {
    return this.vendorsService.updateVendorVehicleExtraCosts(id, body);
  }

  @Public()
  @Post(':id/outstation-km-limits')
  @ApiOperation({ summary: 'Create or update vendor outstation KM limit' })
  async upsertOutstationKmLimit(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ): Promise<any> {
    return this.vendorsService.upsertVendorOutstationKmLimit(id, body);
  }

  @Public()
  @Get(':id/local-km-limits')
  @ApiOperation({ summary: 'Get vendor local KM limits' })
  async getLocalKmLimits(@Param('id', ParseIntPipe) id: number): Promise<any[]> {
    return this.vendorsService.getVendorLocalKmLimits(id);
  }

  @Public()
  @Post(':id/local-km-limits')
  @ApiOperation({ summary: 'Create or update vendor local KM limit' })
  async upsertLocalKmLimit(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ): Promise<any> {
    return this.vendorsService.upsertVendorLocalKmLimit(id, body);
  }

  @Public()
  @Delete(':id/local-km-limits/:timeLimitId')
  @ApiOperation({ summary: 'Soft-delete a vendor local KM limit' })
  async deleteLocalKmLimit(
    @Param('id', ParseIntPipe) id: number,
    @Param('timeLimitId', ParseIntPipe) timeLimitId: number,
  ): Promise<void> {
    return this.vendorsService.deleteLocalKmLimit(id, timeLimitId);
  }

  @Public()
  @Delete(':id/outstation-km-limits/:kmsLimitId')
  @ApiOperation({ summary: 'Soft-delete a vendor outstation KM limit' })
  async deleteOutstationKmLimit(
    @Param('id', ParseIntPipe) id: number,
    @Param('kmsLimitId', ParseIntPipe) kmsLimitId: number,
  ): Promise<void> {
    return this.vendorsService.deleteOutstationKmLimit(id, kmsLimitId);
  }

  /**
   * List all branches for a vendor.
   * Can be used to hydrate a separate Branches tab if needed.
   */
  @Public()
  @Get(':id/branches')
  @ApiOperation({
    summary: 'List vendor branches',
    description:
      'Returns all non-deleted branches from dvi_vendor_branches for the given vendor_id.',
  })
  async listBranches(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<any[]> {
    return this.vendorsService.listBranches(id);
  }

  /**
   * Create a new branch for a vendor.
   * Equivalent to __ajax_manage_vendor.php?type=vendor_branch (insert).
   */
  @Post(':id/branches')
  @ApiOperation({
    summary: 'Create vendor branch',
    description:
      'Inserts a new row into dvi_vendor_branches linked to the given vendor_id.',
  })
  async createBranch(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ): Promise<any> {
    return this.vendorsService.createBranch(id, body);
  }

  /**
   * Update an existing vendor branch.
   * Equivalent to __ajax_manage_vendor.php?type=vendor_branch (update).
   */
  @Put('branches/:branchId')
  @ApiOperation({
    summary: 'Update vendor branch',
    description:
      'Updates a row in dvi_vendor_branches identified by vendor_branch_id.',
  })
  async updateBranch(
    @Param('branchId', ParseIntPipe) branchId: number,
    @Body() body: any,
  ): Promise<any> {
    return this.vendorsService.updateBranch(branchId, body);
  }

  /**
   * Soft-delete a vendor branch (marks deleted = 1).
   * Mirrors __ajax_manage_vendor.php?type=confirm_branch_delete.
   */
  @Delete('branches/:branchId')
  @ApiOperation({
    summary: 'Delete vendor branch',
    description:
      'Soft-deletes a row in dvi_vendor_branches by setting deleted = 1.',
  })
  async deleteBranch(
    @Param('branchId', ParseIntPipe) branchId: number,
  ): Promise<{ success: boolean }> {
    await this.vendorsService.softDeleteBranch(branchId);
    return { success: true };
  }

  
  // ===========================================================================
  // EXISTING: Vendor-scoped dropdown endpoints (keep as-is for compatibility)
  // These stay under /vendors/dropdowns/*
  // ===========================================================================

  @Public()
  @Get('dropdowns/roles')
  @ApiOperation({
    summary: 'Vendor form - role options',
    description: 'Returns role options from dvi_rolemenu for the Vendor form.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
            },
          },
        },
      },
    },
  })
  async getRoleOptions(): Promise<{ items: DropdownItem[] }> {
    return this.vendorsService.getRoleOptions();
  }

  @Public()
  @Get('dropdowns/countries')
  @ApiOperation({
    summary: 'Vendor form - country options',
    description: 'Returns country options from dvi_countries for the Vendor form.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
            },
          },
        },
      },
    },
  })
  async getCountryOptions(): Promise<{ items: DropdownItem[] }> {
    return this.vendorsService.getCountryOptions();
  }

  @Public()
  @Get('dropdowns/states')
  @ApiOperation({
    summary: 'Vendor form - state options',
    description:
      'Returns state options from dvi_states filtered by countryId for the Vendor form.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
            },
          },
        },
      },
    },
  })
  async getStateOptions(
    @Query('countryId') countryId: string,
  ): Promise<{ items: DropdownItem[] }> {
    return this.vendorsService.getStateOptions(countryId);
  }

  @Public()
  @Get('dropdowns/cities')
  @ApiOperation({
    summary: 'Vendor form - city options',
    description:
      'Returns city options from dvi_cities filtered by stateId for the Vendor form.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
            },
          },
        },
      },
    },
  })
  async getCityOptions(
    @Query('stateId') stateId: string,
  ): Promise<{ items: DropdownItem[] }> {
    return this.vendorsService.getCityOptions(stateId);
  }

  @Public()
  @Get('dropdowns/gst-types')
  @ApiOperation({
    summary: 'Vendor form - GST type options',
    description:
      'Returns GST type options (Included / Excluded) from dvi_gst_setting for the Vendor form.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
            },
          },
        },
      },
    },
  })
  async getGstTypeOptions(): Promise<{ items: DropdownItem[] }> {
    return this.vendorsService.getGstTypeOptions();
  }

  @Public()
  @Get('dropdowns/gst-percents')
  @ApiOperation({
    summary: 'Vendor form - GST percentage options',
    description:
      'Returns GST percentage options from dvi_gst_setting for the Vendor form.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
            },
          },
        },
      },
    },
  })
  async getGstPercentOptions(): Promise<{ items: DropdownItem[] }> {
    return this.vendorsService.getGstPercentOptions();
  }
}

// ===========================================================================
// NEW: Top-level /dropdowns/* controller used by React form
// This matches calls like api("/dropdowns/countries") etc.
// ===========================================================================

@ApiTags('dropdowns')
@Public()
@Controller('dropdowns')
export class VendorsDropdownsController {
  constructor(private readonly vendorsService: VendorsService) {}

  @Get('roles')
  @ApiOperation({
    summary: 'Role dropdown (flat array)',
  })
  async roles(): Promise<DropdownItem[]> {
    const { items } = await this.vendorsService.getRoleOptions();
    return items;
  }

  @Get('countries')
  @ApiOperation({
    summary: 'Country dropdown (flat array)',
  })
  async countries(): Promise<DropdownItem[]> {
    const { items } = await this.vendorsService.getCountryOptions();
    return items;
  }

  @Get('states')
  @ApiOperation({
    summary: 'State dropdown (flat array, filtered by countryId)',
  })
  async states(
    @Query('countryId') countryId: string,
  ): Promise<DropdownItem[]> {
    const { items } = await this.vendorsService.getStateOptions(countryId);
    return items;
  }

  @Get('cities')
  @ApiOperation({
    summary: 'City dropdown (flat array, filtered by stateId)',
  })
  async cities(
    @Query('stateId') stateId: string,
  ): Promise<DropdownItem[]> {
    const { items } = await this.vendorsService.getCityOptions(stateId);
    return items;
  }

  @Get('gst-types')
  @ApiOperation({
    summary: 'GST type dropdown (flat array)',
  })
  async gstTypes(): Promise<DropdownItem[]> {
    const { items } = await this.vendorsService.getGstTypeOptions();
    return items;
  }

  @Get('gst-percents')
  @ApiOperation({
    summary: 'GST percentage dropdown (flat array)',
  })
  async gstPercents(): Promise<DropdownItem[]> {
    const { items } = await this.vendorsService.getGstPercentOptions();
    return items;
  }

  @Get('gst-percentages')
  @ApiOperation({
    summary: 'Alias: GST percentage dropdown (flat array)',
  })
  async gstPercentages(): Promise<DropdownItem[]> {
    const { items } = await this.vendorsService.getGstPercentOptions();
    return items;
  }

  @Get('vehicle-types')
  @ApiOperation({
    summary: 'Vehicle type dropdown (flat array)',
  })
  async vehicleTypes(): Promise<DropdownItem[]> {
    const { items } = await this.vendorsService.getVehicleTypeOptions();
    return items;
  }

  @Get('time-limits')
  @ApiOperation({
    summary: 'Time limit dropdown (flat array, filtered by vendorId)',
  })
  async timeLimits(
    @Query('vendorId', ParseIntPipe) vendorId: number,
  ): Promise<DropdownItem[]> {
    const { items } = await this.vendorsService.getTimeLimitOptions(vendorId);
    return items;
  }

  @Get('kms-limits')
  @ApiOperation({
    summary: 'KMS limit dropdown (flat array, filtered by vendorId)',
  })
  async kmsLimits(
    @Query('vendorId', ParseIntPipe) vendorId: number,
  ): Promise<DropdownItem[]> {
    const { items } = await this.vendorsService.getKmsLimitOptions(vendorId);
    return items;
  }

  @Get('permit-states')
  @ApiOperation({
    summary: 'Permit source/destination state dropdown (flat array)',
  })
  async permitStates(): Promise<DropdownItem[]> {
    const { items } = await this.vendorsService.getPermitStateOptions();
    return items;
  }
}
