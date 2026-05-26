// FILE: src/modules/vendors/vendors.service.ts

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { VendorListItemDto } from './dto/vendor-list-item.dto';

type DropdownItem = {
  id: string;
  label: string;
};

@Injectable()
export class VendorsService {
  constructor(private readonly prisma: PrismaService) {}

  private toNumberOrNull(value: any): number | null {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  private toGstTypeNumber(value: any): number {
    if (value === 'included' || value === 1 || value === '1') return 1;
    if (value === 'excluded' || value === 2 || value === '2') return 2;
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return 1;
  }

  private mapVendorBasicPayload(data: any): Record<string, any> {
    return {
      vendor_name: data.vendor_name ?? data.vendorName ?? null,
      vendor_code: data.vendor_code ?? data.vendorCode ?? null,
      vendor_email: data.vendor_email ?? data.email ?? null,
      vendor_primary_mobile_number:
        data.vendor_primary_mobile_number ?? data.primaryMobile ?? null,
      vendor_alternative_mobile_number:
        data.vendor_alternative_mobile_number ?? data.altMobile ?? null,
      vendor_country:
        this.toNumberOrNull(data.vendor_country ?? data.vendor_country_id ?? data.countryId) ?? 0,
      vendor_state:
        this.toNumberOrNull(data.vendor_state ?? data.vendor_state_id ?? data.stateId) ?? 0,
      vendor_city:
        this.toNumberOrNull(data.vendor_city ?? data.vendor_city_id ?? data.cityId) ?? 0,
      vendor_pincode: data.vendor_pincode ?? data.pincode ?? null,
      vendor_othernumber: data.vendor_othernumber ?? data.vendor_other_number ?? data.otherNumber ?? null,
      vendor_margin:
        this.toNumberOrNull(data.vendor_margin ?? data.vendor_margin_percent ?? data.marginPercent) ?? 0,
      vendor_margin_gst_type: this.toGstTypeNumber(
        data.vendor_margin_gst_type ?? data.marginGstType,
      ),
      vendor_margin_gst_percentage:
        this.toNumberOrNull(
          data.vendor_margin_gst_percentage ?? data.vendor_margin_gst_percent ?? data.marginGstPercent,
        ) ?? 0,
      vendor_address: data.vendor_address ?? data.address ?? null,
      vendor_company_name:
        data.vendor_company_name ?? data.invoice_company_name ?? data.invoiceCompanyName ?? null,
      invoice_gstin_number: data.invoice_gstin_number ?? data.invoice_gstin ?? data.invoiceGstin ?? null,
      invoice_pan_number: data.invoice_pan_number ?? data.invoice_pan ?? data.invoicePan ?? null,
      invoice_pincode: data.invoice_pincode ?? data.invoicePincode ?? null,
      invoice_mobile_number:
        data.invoice_mobile_number ?? data.invoice_contact_no ?? data.invoiceContactNo ?? null,
      invoice_email: data.invoice_email ?? data.invoiceEmail ?? null,
      invoice_address: data.invoice_address ?? data.invoiceAddress ?? null,
    };
  }

  private mapVendorBranchPayload(data: any): Record<string, any> {
    return {
      vendor_branch_name: data.vendor_branch_name ?? data.branch_name ?? data.name ?? null,
      vendor_branch_emailid: data.vendor_branch_emailid ?? data.branch_email ?? data.email ?? null,
      vendor_branch_primary_mobile_number:
        data.vendor_branch_primary_mobile_number ?? data.primary_mobile_number ?? data.primaryMobile ?? null,
      vendor_branch_alternative_mobile_number:
        data.vendor_branch_alternative_mobile_number ?? data.alternative_mobile_number ?? data.altMobile ?? null,
      vendor_branch_country:
        this.toNumberOrNull(data.vendor_branch_country ?? data.country_id ?? data.countryId) ?? 0,
      vendor_branch_state:
        this.toNumberOrNull(data.vendor_branch_state ?? data.state_id ?? data.stateId) ?? 0,
      vendor_branch_city:
        this.toNumberOrNull(data.vendor_branch_city ?? data.city_id ?? data.cityId) ?? 0,
      vendor_branch_pincode:
        this.toNumberOrNull(data.vendor_branch_pincode ?? data.pincode) ?? 0,
      vendor_branch_location:
        data.vendor_branch_location ?? data.branch_location ?? data.location ?? null,
      vendor_branch_gst_type: this.toGstTypeNumber(
        data.vendor_branch_gst_type ?? data.gst_type ?? data.gstType,
      ),
      vendor_branch_gst:
        this.toNumberOrNull(data.vendor_branch_gst ?? data.gst_percent ?? data.gstPercent) ?? 0,
      vendor_branch_address: data.vendor_branch_address ?? data.address ?? null,
    };
  }

  private async resolveVendorVehicleTypeId(vendorId: number, value: any): Promise<number | null> {
    const raw = this.toNumberOrNull(value);
    if (!raw) return null;

    const direct = await this.prisma.dvi_vendor_vehicle_types.findFirst({
      where: {
        vendor_vehicle_type_ID: raw,
        vendor_id: vendorId,
        deleted: 0,
      },
      select: { vendor_vehicle_type_ID: true },
    });
    if (direct?.vendor_vehicle_type_ID) return direct.vendor_vehicle_type_ID;

    const byBaseType = await this.prisma.dvi_vendor_vehicle_types.findFirst({
      where: {
        vendor_id: vendorId,
        vehicle_type_id: raw,
        deleted: 0,
      },
      select: { vendor_vehicle_type_ID: true },
    });
    return byBaseType?.vendor_vehicle_type_ID ?? null;
  }

  /**
   * Returns all vendors (non-deleted) with computed branch count.
   * Mirrors the behaviour of engine/json/__JSONvendor.php.
   */
  async listVendors(): Promise<VendorListItemDto[]> {
    // 1) Base vendor rows
    const vendors = await this.prisma.dvi_vendor_details.findMany({
      where: {
        deleted: 0,
      },
      orderBy: {
        vendor_id: 'desc',
      },
    });

    // 2) Branch counts per vendor
    const branchCounts = await this.prisma.dvi_vendor_branches.groupBy({
      by: ['vendor_id'],
      where: {
        deleted: 0,
      },
      _count: {
        vendor_id: true,
      },
    });

    const branchCountMap = new Map<number, number>();
    for (const row of branchCounts) {
      branchCountMap.set(
        // Prisma type for vendor_id is numeric in our schema
        row.vendor_id as unknown as number,
        row._count.vendor_id,
      );
    }

    // 3) Map to DTO
    const result: VendorListItemDto[] = vendors.map((v) => ({
      id: v.vendor_id as unknown as number,
      vendorName: v.vendor_name ?? '',
      vendorCode: v.vendor_code ?? '',
      vendorMobile: v.vendor_primary_mobile_number ?? '',
      vendorEmail: v.vendor_email ?? null,
      totalBranch: branchCountMap.get(v.vendor_id as unknown as number) ?? 0,
      status: v.status ?? 0,
    }));

    return result;
  }

  /**
   * Fetch full vendor info for the edit form (basic info + all branches).
   * This is the equivalent of what the PHP newvendor.php + __ajax_add_vendor_newform.php
   * do when loading the edit wizard.
   */
  async getVendorDetail(vendorId: number): Promise<any> {
    const vendor = await this.prisma.dvi_vendor_details.findFirst({
      where: {
        vendor_id: vendorId,
        deleted: 0,
      },
    });

    if (!vendor) {
      throw new NotFoundException(`Vendor ${vendorId} not found`);
    }

    const branches = await this.prisma.dvi_vendor_branches.findMany({
      where: {
        vendor_id: vendorId,
        deleted: 0,
      },
    });

    return {
      vendor,
      branches,
    };
  }

  /**
   * Create a new vendor basic record.
   *
   * Expectation:
   *  - `data` already uses column-style keys compatible with dvi_vendor_details,
   *    e.g. vendor_name, vendor_code, vendor_primary_mobile_number, vendor_email, etc.
   *  - The frontend should send the same fields the PHP form was posting.
   */
  async createVendorBasicInfo(data: any): Promise<any> {
    const mapped = this.mapVendorBasicPayload(data);

    const created = await this.prisma.dvi_vendor_details.create({
      data: {
        deleted: 0,
        status: data.status ?? 1,
        ...mapped,
      },
    });

    // Return the same shape as the edit pre-fill endpoint
    return this.getVendorDetail(created.vendor_id as unknown as number);
  }

  /**
   * Update an existing vendor basic record (edit form save).
   */
  async updateVendorBasicInfo(vendorId: number, data: any): Promise<any> {
    // Ensure vendor exists (and not deleted)
    await this.getVendorDetail(vendorId);

    const mapped = this.mapVendorBasicPayload(data);

    await this.prisma.dvi_vendor_details.update({
      where: {
        vendor_id: vendorId,
      },
      data: mapped,
    });

    return this.getVendorDetail(vendorId);
  }

  /**
   * List all non-deleted branches for a vendor.
   * Used for the "Branch Info" step.
   */
  async listBranches(vendorId: number): Promise<any[]> {
    return this.prisma.dvi_vendor_branches.findMany({
      where: {
        vendor_id: vendorId,
        deleted: 0,
      },
    });
  }

  /**
   * Create a new branch for a vendor.
   * The payload structure should mirror the PHP vendor branch form and
   * the dvi_vendor_branches schema (branch name, contacts, address, etc.).
   */
  async createBranch(vendorId: number, data: any): Promise<any> {
    // Make sure the vendor exists
    await this.getVendorDetail(vendorId);

    const mapped = this.mapVendorBranchPayload(data);

    const created = await this.prisma.dvi_vendor_branches.create({
      data: {
        vendor_id: vendorId,
        deleted: 0,
        status: data.status ?? 1,
        ...mapped,
      },
    });

    return created;
  }

  /**
   * Update an existing vendor branch.
   */
  async updateBranch(branchId: number, data: any): Promise<any> {
    const existing = await this.prisma.dvi_vendor_branches.findFirst({
      where: {
        vendor_branch_id: branchId,
        deleted: 0,
      },
    });

    if (!existing) {
      throw new NotFoundException(`Vendor branch ${branchId} not found`);
    }

    const mapped = this.mapVendorBranchPayload(data);

    return this.prisma.dvi_vendor_branches.update({
      where: {
        vendor_branch_id: branchId,
      },
      data: mapped,
    });
  }

  /**
   * Soft-delete a vendor branch (sets deleted = 1), mirroring the PHP behaviour.
   */
  async softDeleteBranch(branchId: number): Promise<void> {
    const existing = await this.prisma.dvi_vendor_branches.findFirst({
      where: {
        vendor_branch_id: branchId,
        deleted: 0,
      },
    });

    if (!existing) {
      // Idempotent delete
      return;
    }

    await this.prisma.dvi_vendor_branches.update({
      where: {
        vendor_branch_id: branchId,
      },
      data: {
        deleted: 1,
      },
    });
  }

  /**
   * Mirrors legacy PHP confirmdelete behaviour (mixed soft/hard delete cascade).
   */
  async softDeleteVendor(vendorId: number): Promise<void> {
    const existing = await this.prisma.dvi_vendor_details.findFirst({
      where: {
        vendor_id: vendorId,
        deleted: 0,
      },
    });

    // If vendor doesn't exist or already deleted, make it idempotent
    if (!existing) {
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      const vehicles = await tx.dvi_vehicle.findMany({
        where: { vendor_id: vendorId },
        select: { vehicle_id: true },
      });
      const vehicleIds = vehicles
        .map((v) => v.vehicle_id)
        .filter((id): id is number => Number.isInteger(id));

      // Soft deletes in PHP
      await tx.dvi_vendor_details.update({
        where: { vendor_id: vendorId },
        data: {
          deleted: 1,
          status: 0,
        },
      });

      await tx.dvi_vendor_branches.updateMany({
        where: { vendor_id: vendorId },
        data: {
          deleted: 1,
          status: 0,
        },
      });

      if (vehicleIds.length) {
        await tx.dvi_vehicle_gallery_details.updateMany({
          where: { vehicle_id: { in: vehicleIds } },
          data: {
            deleted: 1,
            status: 0,
          },
        });
      }

      // Hard deletes in PHP
      await tx.dvi_vehicle_outstation_price_book.deleteMany({
        where: { vendor_id: vendorId },
      });
      await tx.dvi_vehicle_local_pricebook.deleteMany({
        where: { vendor_id: vendorId },
      });
      await tx.dvi_time_limit.deleteMany({
        where: { vendor_id: vendorId },
      });
      await tx.dvi_kms_limit.deleteMany({
        where: { vendor_id: vendorId },
      });
      await tx.dvi_permit_cost.deleteMany({
        where: { vendor_id: vendorId },
      });
      await tx.dvi_vendor_vehicle_types.deleteMany({
        where: { vendor_id: vendorId },
      });
      await tx.dvi_vehicle.deleteMany({
        where: { vendor_id: vendorId },
      });
      await tx.dvi_users.deleteMany({
        where: { vendor_id: BigInt(vendorId) },
      });
    });
  }

  async toggleVendorStatus(vendorId: number, oldStatus: number): Promise<number> {
    const nextStatus = Number(oldStatus) === 1 ? 0 : 1;

    await this.prisma.$transaction([
      this.prisma.dvi_vendor_details.update({
        where: { vendor_id: vendorId },
        data: { status: nextStatus },
      }),
      this.prisma.dvi_users.updateMany({
        where: { vendor_id: vendorId as any, deleted: 0 as any },
        data: { userbanned: nextStatus === 1 ? 0 : 1 },
      }),
    ]);

    return nextStatus;
  }

  // =====================================================================================
  // NEW: Dropdowns for Vendor Form
  //   - Roles: dvi_rolemenu
  //   - Countries / States / Cities: dvi_countries / dvi_states / dvi_cities
  //   - GST Types / Percentages: dvi_gst_setting
  // =====================================================================================

  /**
   * Roles dropdown.
   * Source: dvi_rolemenu
   *
   * NOTE: We do NOT filter on deleted/status here because those columns
   * are not present in the Prisma model (earlier error "Argument `deleted` is missing").
   */
  async getRoleOptions(): Promise<{ items: DropdownItem[] }> {
  // Fetch all active roles (status = 1). We don't filter on `deleted`
  // to avoid Prisma schema mismatches; the table already uses 0 for active.
  const rows = await this.prisma.dvi_rolemenu.findMany({
    where: {
      status: 1 as any,
    },
    orderBy: {
      role_name: 'asc' as any,
    },
  } as any);

  const items: DropdownItem[] = (rows as any[])
    .map((row) => {
      // Handle different possible field names safely
      const id =
        row.role_ID ??
        row.role_id ??
        row.roleId ??
        row.id;

      const label =
        row.role_name ??
        row.rolename ??
        row.name;

      if (!id || !label) return null;

      return {
        id: String(id),
        label: String(label),
      };
    })
    .filter((x): x is DropdownItem => x !== null);

  return { items };
}

  /**
   * Country dropdown.
   * Source: dvi_countries
   *
   * Mirrors HotelsService.countries() but mapped to DropdownItem.
   * No deleted/status filter because those fields are not in Prisma model.
   */
  async getCountryOptions(): Promise<{ items: DropdownItem[] }> {
    const rows = await this.prisma.dvi_countries.findMany({
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }] as any,
    } as any);

    const items: DropdownItem[] = (rows as any[])
      .map((r: any) => {
        if (!r.id || !r.name) return null;
        return {
          id: String(r.id),
          label: String(r.name),
        };
      })
      .filter((x): x is DropdownItem => x !== null);

    return { items };
  }

  /**
   * State dropdown, filtered by country.
   * Source: dvi_states
   *
   * Mirrors HotelsService.states(), but wraps in DropdownItem.
   */
  async getStateOptions(
    countryId: number | string,
  ): Promise<{ items: DropdownItem[] }> {
    const cid = Number(countryId);
    if (!Number.isFinite(cid) || cid <= 0) {
      return { items: [] };
    }

    const rows = await this.prisma.dvi_states.findMany({
      where: { country_id: cid } as any,
      select: { id: true, name: true, country_id: true },
      orderBy: [{ name: 'asc' }] as any,
    } as any);

    const items: DropdownItem[] = (rows as any[])
      .map((r: any) => {
        if (!r.id || !r.name) return null;
        return {
          id: String(r.id),
          label: String(r.name),
        };
      })
      .filter((x): x is DropdownItem => x !== null);

    return { items };
  }

  /**
   * City dropdown, filtered by state.
   * Source: dvi_cities
   *
   * Mirrors HotelsService.cities(), but wraps in DropdownItem.
   */
  async getCityOptions(
    stateId: number | string,
  ): Promise<{ items: DropdownItem[] }> {
    const sid = Number(stateId);
    if (!Number.isFinite(sid) || sid <= 0) {
      return { items: [] };
    }

    const rows = await this.prisma.dvi_cities.findMany({
      where: { state_id: sid } as any,
      select: { id: true, name: true, state_id: true },
      orderBy: [{ name: 'asc' }] as any,
    } as any);

    const items: DropdownItem[] = (rows as any[])
      .map((r: any) => {
        if (!r.id || !r.name) return null;
        return {
          id: String(r.id),
          label: String(r.name),
        };
      })
      .filter((x): x is DropdownItem => x !== null);

    return { items };
  }

  /**
   * Vendor Margin GST Type dropdown.
   *
   * For now we keep this static because:
   *  - Your React form already uses "included"/"excluded" from gstTypeOptions.
   *  - dvi_gst_setting Prisma model fields for type/category are not guaranteed.
   */
  async getGstTypeOptions(): Promise<{ items: DropdownItem[] }> {
    return {
      items: [
        { id: 'included', label: 'Included' },
        { id: 'excluded', label: 'Excluded' },
      ],
    };
  }

  /**
   * Vendor Margin GST Percentage dropdown.
   * Source: dvi_gst_setting
   *
   * Mirrors HotelsService.gstPercentages() logic, but mapped to DropdownItem.
   * No deleted/status filter (those columns are not in Prisma model).
   */
  async getGstPercentOptions(): Promise<{ items: DropdownItem[] }> {
    const rows = await this.prisma.dvi_gst_setting.findMany({
      select: { gst_setting_id: true, gst_value: true },
      orderBy: [{ gst_value: 'asc' }] as any,
    } as any);

    const seen = new Set<number>();
    const items: DropdownItem[] = [];

    for (const r of rows as any[]) {
      const v = Number(r.gst_value);
      if (!Number.isFinite(v)) continue;
      if (seen.has(v)) continue;
      seen.add(v);

      items.push({
        id: String(v),
        label: String(v), // "0", "5", "12", "18", etc.
      });
    }

    // Fallback if table is empty / not configured
    if (!items.length) {
      [0, 5, 12, 18].forEach((v) => {
        items.push({
          id: String(v),
          label: String(v),
        });
      });
    }

    return { items };
  }

  // =====================================================================================
  // NEW: Vendor Wizard Steps 3-6
  // =====================================================================================

  // --- Step 3: Driver Costs (dvi_vendor_vehicle_types) ---

  async getVendorVehicleTypes(vendorId: number): Promise<any[]> {
    const rows = await this.prisma.dvi_vendor_vehicle_types.findMany({
      where: { vendor_id: vendorId, deleted: 0 },
    });

    const typeIds = [...new Set(rows.map((r) => r.vehicle_type_id).filter((id) => Number(id) > 0))];
    const types = typeIds.length
      ? await this.prisma.dvi_vehicle_type.findMany({
          where: { vehicle_type_id: { in: typeIds } },
          select: { vehicle_type_id: true, vehicle_type_title: true },
        })
      : [];
    const typeMap = new Map(types.map((t) => [t.vehicle_type_id, t.vehicle_type_title ?? '']));

    return rows.map((r) => ({
      ...r,
      vehicle_type_title: typeMap.get(r.vehicle_type_id) ?? '',
    }));
  }



  async updateVendorVehicleType(vendorId: number, data: any): Promise<any> {
    const vehicleTypeId = this.toNumberOrNull(data.vehicle_type_id);
    if (!vehicleTypeId) {
      throw new NotFoundException('vehicle_type_id is required');
    }

    const mapped = {
      driver_batta: this.toNumberOrNull(data.driver_bhatta ?? data.driver_batta) ?? 0,
      food_cost: this.toNumberOrNull(data.food_cost) ?? 0,
      accomodation_cost:
        this.toNumberOrNull(data.accommodation_cost ?? data.accomdation_cost ?? data.accomodation_cost) ?? 0,
      extra_cost: this.toNumberOrNull(data.extra_cost) ?? 0,
      driver_early_morning_charges:
        this.toNumberOrNull(data.morning_charges ?? data.driver_early_morning_charges) ?? 0,
      driver_evening_charges:
        this.toNumberOrNull(data.evening_charges ?? data.driver_evening_charges) ?? 0,
    };

    // Check if exists
    const existing = await this.prisma.dvi_vendor_vehicle_types.findFirst({
      where: { vendor_id: vendorId, vehicle_type_id: vehicleTypeId, deleted: 0 },
    });

    if (existing) {
      return this.prisma.dvi_vendor_vehicle_types.update({
        where: { vendor_vehicle_type_ID: existing.vendor_vehicle_type_ID },
        data: { ...mapped, updatedon: new Date() },
      });
    } else {
      return this.prisma.dvi_vendor_vehicle_types.create({
        data: {
          vendor_id: vendorId,
          vehicle_type_id: vehicleTypeId,
          ...mapped,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });
    }
  }

  async patchVendorVehicleTypeCost(
    vendorId: number,
    rowId: number,
    data: any,
  ): Promise<any> {
    const existing = await this.prisma.dvi_vendor_vehicle_types.findFirst({
      where: {
        vendor_vehicle_type_ID: rowId,
        vendor_id: vendorId,
        deleted: 0,
      },
    });

    if (!existing) {
      throw new NotFoundException(`Vehicle type cost ${rowId} not found`);
    }

    return this.prisma.dvi_vendor_vehicle_types.update({
      where: {
        vendor_vehicle_type_ID: rowId,
      },
      data: {
        vehicle_type_id:
          this.toNumberOrNull(data.vehicle_type_id) ?? existing.vehicle_type_id,
        driver_batta:
          this.toNumberOrNull(data.driver_bhatta ?? data.driver_batta) ?? 0,
        food_cost: this.toNumberOrNull(data.food_cost) ?? 0,
        accomodation_cost:
          this.toNumberOrNull(
            data.accommodation_cost ??
              data.accomdation_cost ??
              data.accomodation_cost,
          ) ?? 0,
        extra_cost: this.toNumberOrNull(data.extra_cost) ?? 0,
        driver_early_morning_charges:
          this.toNumberOrNull(
            data.morning_charges ?? data.driver_early_morning_charges,
          ) ?? 0,
        driver_evening_charges:
          this.toNumberOrNull(
            data.evening_charges ?? data.driver_evening_charges,
          ) ?? 0,
        updatedon: new Date(),
      },
    });
  }

  async deleteVendorVehicleTypeCost(
    vendorId: number,
    rowId: number,
  ): Promise<void> {
    const existing = await this.prisma.dvi_vendor_vehicle_types.findFirst({
      where: {
        vendor_vehicle_type_ID: rowId,
        vendor_id: vendorId,
        deleted: 0,
      },
    });

    if (!existing) return;

    await this.prisma.dvi_vendor_vehicle_types.update({
      where: {
        vendor_vehicle_type_ID: rowId,
      },
      data: {
        deleted: 1,
        status: 0,
        updatedon: new Date(),
      },
    });
  }

  // --- Step 4: Vehicle Info (dvi_vehicle) ---

  async getVendorVehicles(vendorId: number): Promise<any[]> {
    return this.prisma.dvi_vehicle.findMany({
      where: { vendor_id: vendorId, deleted: 0 },
    });
  }

  private mapVendorVehiclePayload(data: any): Record<string, any> {
    const toDateOrNull = (value: any): Date | null => {
      if (value === null || value === undefined || value === '') return null;
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d;
    };

    return {
      ...data,
      vendor_branch_id: this.toNumberOrNull(data.vendor_branch_id) ?? 0,
      vehicle_type_id: this.toNumberOrNull(data.vehicle_type_id),
      registration_date: toDateOrNull(data.registration_date),
      owner_country: this.toNumberOrNull(data.owner_country) ?? 0,
      fuel_type: this.toNumberOrNull(data.fuel_type) ?? 0,
      owner_pincode: data.owner_pincode ?? '',
      extra_km_charge: this.toNumberOrNull(data.extra_km_charge) ?? 0,
      early_morning_charges: this.toNumberOrNull(data.early_morning_charges) ?? 0,
      evening_charges: this.toNumberOrNull(data.evening_charges) ?? 0,
      vehicle_fc_expiry_date: toDateOrNull(data.vehicle_fc_expiry_date),
      insurance_start_date: toDateOrNull(data.insurance_start_date),
      insurance_end_date: toDateOrNull(data.insurance_end_date),
    };
  }

  async createVendorVehicle(vendorId: number, data: any): Promise<any> {
    const mapped = this.mapVendorVehiclePayload(data);
    return this.prisma.dvi_vehicle.create({
      data: {
        ...mapped,
        owner_pincode: String(mapped.owner_pincode ?? ''),
        vendor_id: vendorId,
        createdon: new Date(),
        status: 1,
        deleted: 0,
      },
    });
  }

  async updateVendorVehicle(vehicleId: number, data: any): Promise<any> {
    const mapped = this.mapVendorVehiclePayload(data);
    return this.prisma.dvi_vehicle.update({
      where: { vehicle_id: vehicleId },
      data: { ...mapped, updatedon: new Date() },
    });
  }

  async toggleVendorVehicleStatus(vehicleId: number, oldStatus: number): Promise<number> {
    const nextStatus = Number(oldStatus) === 1 ? 0 : 1;
    await this.prisma.dvi_vehicle.update({
      where: { vehicle_id: vehicleId },
      data: { status: nextStatus, updatedon: new Date() },
    });
    return nextStatus;
  }

  async softDeleteVehicle(vehicleId: number): Promise<void> {
    await this.prisma.dvi_vehicle.update({
      where: { vehicle_id: vehicleId },
      data: { deleted: 1 },
    });
  }

  async deleteLocalKmLimit(vendorId: number, timeLimitId: number): Promise<void> {
    const row = await this.prisma.dvi_time_limit.findFirst({
      where: { time_limit_id: timeLimitId, vendor_id: vendorId, deleted: 0 },
    });
    if (!row) throw new NotFoundException(`Local KM limit ${timeLimitId} not found for vendor ${vendorId}`);
    await this.prisma.dvi_time_limit.update({
      where: { time_limit_id: timeLimitId },
      data: { deleted: 1 },
    });
  }

  async deleteOutstationKmLimit(vendorId: number, kmsLimitId: number): Promise<void> {
    const row = await this.prisma.dvi_kms_limit.findFirst({
      where: { kms_limit_id: kmsLimitId, vendor_id: vendorId, deleted: 0 },
    });
    if (!row) throw new NotFoundException(`Outstation KM limit ${kmsLimitId} not found for vendor ${vendorId}`);
    await this.prisma.dvi_kms_limit.update({
      where: { kms_limit_id: kmsLimitId },
      data: { deleted: 1 },
    });
  }

  async getVendorVehicleExtraCosts(vendorId: number): Promise<any[]> {
    const [branches, vehicles] = await Promise.all([
      this.prisma.dvi_vendor_branches.findMany({
        where: { vendor_id: vendorId, deleted: 0, status: 1 },
        select: { vendor_branch_id: true, vendor_branch_name: true },
        orderBy: { vendor_branch_id: 'asc' },
      }),
      this.prisma.dvi_vehicle.findMany({
        where: { vendor_id: vendorId, deleted: 0, status: 1 },
        select: {
          vehicle_id: true,
          vendor_branch_id: true,
          vehicle_type_id: true,
          extra_km_charge: true,
          extra_hour_charge: true,
          early_morning_charges: true,
          evening_charges: true,
        },
        orderBy: { vehicle_id: 'asc' },
      }),
    ]);

    const grouped = new Map<string, any>();
    for (const v of vehicles) {
      const typeId = this.toNumberOrNull(v.vehicle_type_id);
      if (!typeId) continue;
      const key = `${v.vendor_branch_id}:${typeId}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          vendor_id: vendorId,
          vendor_branch_id: v.vendor_branch_id,
          vehicle_type_id: typeId,
          extra_km_charge: v.extra_km_charge ?? 0,
          extra_hour_charge: v.extra_hour_charge ?? 0,
          early_morning_charges: v.early_morning_charges ?? 0,
          evening_charges: v.evening_charges ?? 0,
        });
      }
    }

    const rows = Array.from(grouped.values());
    const branchNameMap = new Map(
      branches.map((b) => [b.vendor_branch_id, b.vendor_branch_name ?? '']),
    );

    const vendorVehicleTypeIds = [...new Set(rows.map((r) => r.vehicle_type_id))];
    const vendorVehicleTypes = vendorVehicleTypeIds.length
      ? await this.prisma.dvi_vendor_vehicle_types.findMany({
          where: { vendor_vehicle_type_ID: { in: vendorVehicleTypeIds } },
          select: { vendor_vehicle_type_ID: true, vehicle_type_id: true },
        })
      : [];

    const vtMap = new Map(
      vendorVehicleTypes.map((v) => [v.vendor_vehicle_type_ID, v.vehicle_type_id]),
    );

    const baseTypeIds = [...new Set(vendorVehicleTypes.map((v) => v.vehicle_type_id))];
    const baseTypes = baseTypeIds.length
      ? await this.prisma.dvi_vehicle_type.findMany({
          where: { vehicle_type_id: { in: baseTypeIds } },
          select: { vehicle_type_id: true, vehicle_type_title: true },
        })
      : [];

    const baseTypeTitleMap = new Map(
      baseTypes.map((t) => [t.vehicle_type_id, t.vehicle_type_title ?? '']),
    );

    return rows.map((r) => {
      const baseTypeId = vtMap.get(r.vehicle_type_id) ?? r.vehicle_type_id;
      return {
        ...r,
        vendor_branch_name: branchNameMap.get(r.vendor_branch_id) ?? '',
        vehicle_type_title: baseTypeTitleMap.get(baseTypeId) ?? String(baseTypeId),
      };
    });
  }

  async updateVendorVehicleExtraCosts(vendorId: number, data: any): Promise<any> {
    const toArray = (v: any): any[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

    const vehicleTypeIds = toArray(data.vehicle_type_id);
    const extraKmCharges = toArray(data.extra_km_charge);
    const extraHourCharges = toArray(data.extra_hour_charge);
    const earlyMorningCharges = toArray(data.early_morning_charges);
    const eveningCharges = toArray(data.evening_charges);

    const branchRaw = data.vendor_branch_id;
    const branchIds = Array.isArray(branchRaw)
      ? branchRaw
      : vehicleTypeIds.map(() => branchRaw);

    let processed = 0;

    for (let i = 0; i < vehicleTypeIds.length; i += 1) {
      const vehicleTypeId = this.toNumberOrNull(vehicleTypeIds[i]);
      const vendorBranchId = this.toNumberOrNull(branchIds[i]);
      if (!vehicleTypeId || !vendorBranchId) continue;

      await this.prisma.dvi_vehicle.updateMany({
        where: {
          vendor_id: vendorId,
          vendor_branch_id: vendorBranchId,
          vehicle_type_id: vehicleTypeId,
          deleted: 0,
        },
        data: {
          extra_km_charge: this.toNumberOrNull(extraKmCharges[i]) ?? 0,
          extra_hour_charge: this.toNumberOrNull(extraHourCharges[i]) ?? 0,
          early_morning_charges: this.toNumberOrNull(earlyMorningCharges[i]) ?? 0,
          evening_charges: this.toNumberOrNull(eveningCharges[i]) ?? 0,
          updatedon: new Date(),
        },
      });
      processed += 1;
    }

    return { success: true, processed };
  }

  // --- Step 5: Pricebook (dvi_vehicle_local_pricebook, dvi_vehicle_outstation_price_book) ---

  async getVendorLocalPricebook(vendorId: number): Promise<any[]> {
    return this.prisma.dvi_vehicle_local_pricebook.findMany({
      where: { vendor_id: vendorId, deleted: 0 },
    });
  }

  async getVendorLocalPricebookPreview(
    vendorId: number,
    startDateRaw: any,
    endDateRaw: any,
  ): Promise<{ days: Array<{ key: string; label: string }>; rows: Array<{ vehicle_type_id: number; time_limit_id: number; vehicle_type_title: string; time_limit_title: string; prices: Array<number | null> }> }> {
    const start = this.parseFlexibleDate(startDateRaw);
    const end = this.parseFlexibleDate(endDateRaw);
    if (!start || !end) {
      return { days: [], rows: [] };
    }

    const from = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const to = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    if (from > to) {
      return { days: [], rows: [] };
    }

    const dayPoints: Array<{ date: Date; year: string; month: string; dayCol: string; key: string; label: string }> = [];
    const monthKeys = new Set<string>();

    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      const year = String(d.getFullYear());
      const month = d.toLocaleString('en-US', { month: 'long' });
      const dayNum = d.getDate();
      dayPoints.push({
        date: new Date(d),
        year,
        month,
        dayCol: `day_${dayNum}`,
        key: `${year}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`,
        label: d.toLocaleDateString('en-US', {
          weekday: 'short',
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        }),
      });
      monthKeys.add(`${year}|${month}`);
    }

    const monthWhere = Array.from(monthKeys).map((k) => {
      const [year, month] = k.split('|');
      return { year, month };
    });

    const entries = await this.prisma.dvi_vehicle_local_pricebook.findMany({
      where: {
        vendor_id: vendorId,
        deleted: 0,
        OR: monthWhere,
      },
      select: {
        vehicle_type_id: true,
        time_limit_id: true,
        year: true,
        month: true,
        day_1: true,
        day_2: true,
        day_3: true,
        day_4: true,
        day_5: true,
        day_6: true,
        day_7: true,
        day_8: true,
        day_9: true,
        day_10: true,
        day_11: true,
        day_12: true,
        day_13: true,
        day_14: true,
        day_15: true,
        day_16: true,
        day_17: true,
        day_18: true,
        day_19: true,
        day_20: true,
        day_21: true,
        day_22: true,
        day_23: true,
        day_24: true,
        day_25: true,
        day_26: true,
        day_27: true,
        day_28: true,
        day_29: true,
        day_30: true,
        day_31: true,
      },
    });

    const vvTypeIds = [...new Set(entries.map((e) => e.vehicle_type_id))];
    const vendorTypes = vvTypeIds.length
      ? await this.prisma.dvi_vendor_vehicle_types.findMany({
          where: { vendor_vehicle_type_ID: { in: vvTypeIds } },
          select: { vendor_vehicle_type_ID: true, vehicle_type_id: true },
        })
      : [];
    const vendorTypeToBaseType = new Map(
      vendorTypes.map((v) => [v.vendor_vehicle_type_ID, v.vehicle_type_id]),
    );

    const baseTypeIds = [...new Set(vendorTypes.map((v) => v.vehicle_type_id))];
    const baseTypes = baseTypeIds.length
      ? await this.prisma.dvi_vehicle_type.findMany({
          where: { vehicle_type_id: { in: baseTypeIds } },
          select: { vehicle_type_id: true, vehicle_type_title: true },
        })
      : [];
    const baseTypeTitleMap = new Map(
      baseTypes.map((b) => [b.vehicle_type_id, b.vehicle_type_title ?? '']),
    );

    const timeLimitIds = [...new Set(entries.map((e) => e.time_limit_id))];
    const timeLimits = timeLimitIds.length
      ? await this.prisma.dvi_time_limit.findMany({
          where: { time_limit_id: { in: timeLimitIds } },
          select: { time_limit_id: true, time_limit_title: true },
        })
      : [];
    const timeLimitTitleMap = new Map(
      timeLimits.map((t) => [t.time_limit_id, t.time_limit_title ?? '']),
    );

    const recordMap = new Map<string, any>();
    for (const e of entries) {
      recordMap.set(`${e.vehicle_type_id}|${e.time_limit_id}|${e.year}|${e.month}`, e);
    }

    const rowKeySet = new Set<string>();
    for (const e of entries) {
      rowKeySet.add(`${e.vehicle_type_id}|${e.time_limit_id}`);
    }

    const rows = Array.from(rowKeySet).map((key) => {
      const [vehicleTypeIdRaw, timeLimitIdRaw] = key.split('|');
      const vehicleTypeId = Number(vehicleTypeIdRaw);
      const timeLimitId = Number(timeLimitIdRaw);
      const baseTypeId = vendorTypeToBaseType.get(vehicleTypeId) ?? vehicleTypeId;
      const vehicleTypeTitle = baseTypeTitleMap.get(baseTypeId) ?? String(baseTypeId);
      const timeLimitTitle = timeLimitTitleMap.get(timeLimitId) ?? String(timeLimitId);

      const prices = dayPoints.map((dp) => {
        const rec = recordMap.get(`${vehicleTypeId}|${timeLimitId}|${dp.year}|${dp.month}`);
        if (!rec) return null;
        const value = rec[dp.dayCol];
        return value === null || value === undefined ? null : Number(value);
      });

      return {
        vehicle_type_id: vehicleTypeId,
        time_limit_id: timeLimitId,
        vehicle_type_title: vehicleTypeTitle,
        time_limit_title: timeLimitTitle,
        prices,
      };
    });

    return {
      days: dayPoints.map((d) => ({ key: d.key, label: d.label })),
      rows,
    };
  }

  async getVendorOutstationPricebookPreview(
    vendorId: number,
    startDateRaw: any,
    endDateRaw: any,
  ): Promise<{ days: Array<{ key: string; label: string }>; rows: Array<{ vehicle_type_id: number; kms_limit_id: number; vehicle_type_title: string; kms_limit_title: string; prices: Array<number | null> }> }> {
    const start = this.parseFlexibleDate(startDateRaw);
    const end = this.parseFlexibleDate(endDateRaw);
    if (!start || !end) return { days: [], rows: [] };

    const from = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const to = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    if (from > to) return { days: [], rows: [] };

    const dayPoints: Array<{ date: Date; year: string; month: string; dayCol: string; key: string; label: string }> = [];
    const monthKeys = new Set<string>();

    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      const year = String(d.getFullYear());
      const month = d.toLocaleString('en-US', { month: 'long' });
      const dayNum = d.getDate();
      dayPoints.push({
        date: new Date(d),
        year,
        month,
        dayCol: `day_${dayNum}`,
        key: `${year}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`,
        label: d.toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }),
      });
      monthKeys.add(`${year}|${month}`);
    }

    const monthWhere = Array.from(monthKeys).map((k) => {
      const [year, month] = k.split('|');
      return { year, month };
    });

    const entries = await this.prisma.dvi_vehicle_outstation_price_book.findMany({
      where: { vendor_id: vendorId, deleted: 0, OR: monthWhere },
      select: {
        vehicle_type_id: true, kms_limit_id: true, year: true, month: true,
        day_1: true, day_2: true, day_3: true, day_4: true, day_5: true, day_6: true,
        day_7: true, day_8: true, day_9: true, day_10: true, day_11: true, day_12: true,
        day_13: true, day_14: true, day_15: true, day_16: true, day_17: true, day_18: true,
        day_19: true, day_20: true, day_21: true, day_22: true, day_23: true, day_24: true,
        day_25: true, day_26: true, day_27: true, day_28: true, day_29: true, day_30: true,
        day_31: true,
      },
    });

    const vvTypeIds = [...new Set(entries.map((e) => e.vehicle_type_id))];
    const vendorTypes = vvTypeIds.length
      ? await this.prisma.dvi_vendor_vehicle_types.findMany({
          where: { vendor_vehicle_type_ID: { in: vvTypeIds } },
          select: { vendor_vehicle_type_ID: true, vehicle_type_id: true },
        })
      : [];
    const vendorTypeToBaseType = new Map(vendorTypes.map((v) => [v.vendor_vehicle_type_ID, v.vehicle_type_id]));

    const baseTypeIds = [...new Set(vendorTypes.map((v) => v.vehicle_type_id))];
    const baseTypes = baseTypeIds.length
      ? await this.prisma.dvi_vehicle_type.findMany({
          where: { vehicle_type_id: { in: baseTypeIds } },
          select: { vehicle_type_id: true, vehicle_type_title: true },
        })
      : [];
    const baseTypeTitleMap = new Map(baseTypes.map((b) => [b.vehicle_type_id, b.vehicle_type_title ?? '']));

    const kmsLimitIds = [...new Set(entries.map((e) => e.kms_limit_id))];
    const kmsLimits = kmsLimitIds.length
      ? await this.prisma.dvi_kms_limit.findMany({
          where: { kms_limit_id: { in: kmsLimitIds } },
          select: { kms_limit_id: true, kms_limit_title: true },
        })
      : [];
    const kmsLimitTitleMap = new Map(kmsLimits.map((k) => [k.kms_limit_id, k.kms_limit_title ?? '']));

    const recordMap = new Map<string, any>();
    for (const e of entries) {
      recordMap.set(`${e.vehicle_type_id}|${e.kms_limit_id}|${e.year}|${e.month}`, e);
    }

    const rowKeySet = new Set<string>();
    for (const e of entries) rowKeySet.add(`${e.vehicle_type_id}|${e.kms_limit_id}`);

    const rows = Array.from(rowKeySet).map((key) => {
      const [vehicleTypeIdRaw, kmsLimitIdRaw] = key.split('|');
      const vehicleTypeId = Number(vehicleTypeIdRaw);
      const kmsLimitId = Number(kmsLimitIdRaw);
      const baseTypeId = vendorTypeToBaseType.get(vehicleTypeId) ?? vehicleTypeId;
      const vehicleTypeTitle = baseTypeTitleMap.get(baseTypeId) ?? String(baseTypeId);
      const kmsLimitTitle = kmsLimitTitleMap.get(kmsLimitId) ?? String(kmsLimitId);

      const prices = dayPoints.map((dp) => {
        const rec = recordMap.get(`${vehicleTypeId}|${kmsLimitId}|${dp.year}|${dp.month}`);
        if (!rec) return null;
        const value = rec[dp.dayCol];
        return value === null || value === undefined ? null : Number(value);
      });

      return { vehicle_type_id: vehicleTypeId, kms_limit_id: kmsLimitId, vehicle_type_title: vehicleTypeTitle, kms_limit_title: kmsLimitTitle, prices };
    });

    return { days: dayPoints.map((d) => ({ key: d.key, label: d.label })), rows };
  }

  private parseFlexibleDate(value: any): Date | null {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

    const raw = String(value).trim();
    if (!raw) return null;

    // Supports dd-mm-yyyy used by PHP and yyyy-mm-dd from date inputs.
    if (/^\d{2}-\d{2}-\d{4}$/.test(raw)) {
      const [dd, mm, yyyy] = raw.split('-').map(Number);
      const d = new Date(yyyy, mm - 1, dd);
      return Number.isNaN(d.getTime()) ? null : d;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const [yyyy, mm, dd] = raw.split('-').map(Number);
      const d = new Date(yyyy, mm - 1, dd);
      return Number.isNaN(d.getTime()) ? null : d;
    }

    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private monthSlicesBetween(start: Date, end: Date): Array<{ year: string; month: string; startDay: number; endDay: number }> {
    const from = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const to = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    if (from > to) return [];

    const result: Array<{ year: string; month: string; startDay: number; endDay: number }> = [];
    let cur = new Date(from.getFullYear(), from.getMonth(), 1);

    while (cur <= to) {
      const y = cur.getFullYear();
      const m = cur.getMonth();
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      const startDay = y === from.getFullYear() && m === from.getMonth() ? from.getDate() : 1;
      const endDay = y === to.getFullYear() && m === to.getMonth() ? to.getDate() : daysInMonth;

      result.push({
        year: String(y),
        month: new Date(y, m, 1).toLocaleString('en-US', { month: 'long' }),
        startDay,
        endDay,
      });

      cur = new Date(y, m + 1, 1);
    }

    return result;
  }

  private fullDayMap(defaultValue = 0): Record<string, number> {
    const map: Record<string, number> = {};
    for (let d = 1; d <= 31; d += 1) {
      map[`day_${d}`] = defaultValue;
    }
    return map;
  }

  private rangedDayPatch(value: number, startDay: number, endDay: number): Record<string, number> {
    const patch: Record<string, number> = {};
    for (let d = startDay; d <= endDay; d += 1) {
      patch[`day_${d}`] = value;
    }
    return patch;
  }

  private asArray<T = any>(value: any): T[] {
    if (Array.isArray(value)) return value as T[];
    if (value === null || value === undefined) return [];
    return [value as T];
  }

  async getVendorLocalPricebookFormRows(vendorId: number): Promise<any[]> {
    const [branches, vendorTypes, timeLimits, vehicleTypes, vehicles] = await Promise.all([
      this.prisma.dvi_vendor_branches.findMany({
        where: { vendor_id: vendorId, deleted: 0, status: 1 },
        select: { vendor_branch_id: true, vendor_branch_name: true },
        orderBy: { vendor_branch_id: 'asc' },
      }),
      this.prisma.dvi_vendor_vehicle_types.findMany({
        where: { vendor_id: vendorId, deleted: 0, status: 1 },
        select: { vendor_vehicle_type_ID: true, vehicle_type_id: true },
        orderBy: { vendor_vehicle_type_ID: 'asc' },
      }),
      this.prisma.dvi_time_limit.findMany({
        where: { vendor_id: vendorId, deleted: 0, status: 1 },
        select: { time_limit_id: true, vendor_vehicle_type_id: true, time_limit_title: true },
        orderBy: { time_limit_id: 'asc' },
      }),
      this.prisma.dvi_vehicle_type.findMany({
        where: { deleted: 0 },
        select: { vehicle_type_id: true, vehicle_type_title: true },
      }),
      this.prisma.dvi_vehicle.findMany({
        where: { vendor_id: vendorId, deleted: 0, status: 1 },
        select: { vehicle_id: true, vendor_branch_id: true, vehicle_type_id: true },
        orderBy: { vehicle_id: 'asc' },
      }),
    ]);

    const typeTitleMap = new Map(vehicleTypes.map((t) => [t.vehicle_type_id, t.vehicle_type_title ?? '']));

    const minVehicleMap = new Map<string, number>();
    for (const v of vehicles) {
      const key = `${v.vendor_branch_id}:${v.vehicle_type_id}`;
      if (!minVehicleMap.has(key)) minVehicleMap.set(key, v.vehicle_id);
    }

    const limitsByVendorType = new Map<number, typeof timeLimits>();
    for (const tl of timeLimits) {
      const list = limitsByVendorType.get(tl.vendor_vehicle_type_id) ?? [];
      list.push(tl);
      limitsByVendorType.set(tl.vendor_vehicle_type_id, list);
    }

    const rows: any[] = [];
    for (const b of branches) {
      for (const vt of vendorTypes) {
        const limits = limitsByVendorType.get(vt.vendor_vehicle_type_ID) ?? [];
        for (const tl of limits) {
          rows.push({
            vendor_id: vendorId,
            vendor_branch_id: b.vendor_branch_id,
            vendor_branch_name: b.vendor_branch_name ?? '',
            vehicle_id: minVehicleMap.get(`${b.vendor_branch_id}:${vt.vendor_vehicle_type_ID}`) ?? 0,
            time_limit_id: tl.time_limit_id,
            vehicle_type_id: vt.vendor_vehicle_type_ID,
            vehicle_type_title: typeTitleMap.get(vt.vehicle_type_id) ?? '',
            time_limit_title: tl.time_limit_title ?? '',
          });
        }
      }
    }

    return rows;
  }

  async getVendorOutstationPricebookFormRows(vendorId: number): Promise<any[]> {
    const [branches, vendorTypes, kmsLimits, vehicleTypes, vehicles] = await Promise.all([
      this.prisma.dvi_vendor_branches.findMany({
        where: { vendor_id: vendorId, deleted: 0, status: 1 },
        select: { vendor_branch_id: true, vendor_branch_name: true },
        orderBy: { vendor_branch_id: 'asc' },
      }),
      this.prisma.dvi_vendor_vehicle_types.findMany({
        where: { vendor_id: vendorId, deleted: 0, status: 1 },
        select: { vendor_vehicle_type_ID: true, vehicle_type_id: true },
        orderBy: { vendor_vehicle_type_ID: 'asc' },
      }),
      this.prisma.dvi_kms_limit.findMany({
        where: { vendor_id: vendorId, deleted: 0, status: 1 },
        select: { kms_limit_id: true, vendor_vehicle_type_id: true, kms_limit_title: true, kms_limit: true },
        orderBy: { kms_limit_id: 'asc' },
      }),
      this.prisma.dvi_vehicle_type.findMany({
        where: { deleted: 0 },
        select: { vehicle_type_id: true, vehicle_type_title: true },
      }),
      this.prisma.dvi_vehicle.findMany({
        where: { vendor_id: vendorId, deleted: 0, status: 1 },
        select: { vehicle_id: true, vendor_branch_id: true, vehicle_type_id: true },
        orderBy: { vehicle_id: 'asc' },
      }),
    ]);

    const typeTitleMap = new Map(vehicleTypes.map((t) => [t.vehicle_type_id, t.vehicle_type_title ?? '']));

    const minVehicleMap = new Map<string, number>();
    for (const v of vehicles) {
      const key = `${v.vendor_branch_id}:${v.vehicle_type_id}`;
      if (!minVehicleMap.has(key)) minVehicleMap.set(key, v.vehicle_id);
    }

    const limitsByVendorType = new Map<number, typeof kmsLimits>();
    for (const kl of kmsLimits) {
      const list = limitsByVendorType.get(kl.vendor_vehicle_type_id) ?? [];
      list.push(kl);
      limitsByVendorType.set(kl.vendor_vehicle_type_id, list);
    }

    const rows: any[] = [];
    for (const b of branches) {
      for (const vt of vendorTypes) {
        const limits = limitsByVendorType.get(vt.vendor_vehicle_type_ID) ?? [];
        for (const kl of limits) {
          rows.push({
            vendor_id: vendorId,
            vendor_branch_id: b.vendor_branch_id,
            vendor_branch_name: b.vendor_branch_name ?? '',
            vehicle_id: minVehicleMap.get(`${b.vendor_branch_id}:${vt.vendor_vehicle_type_ID}`) ?? 0,
            kms_limit_id: kl.kms_limit_id,
            vehicle_type_id: vt.vendor_vehicle_type_ID,
            vehicle_type_title: typeTitleMap.get(vt.vehicle_type_id) ?? '',
            kms_limit_title: kl.kms_limit_title ?? '',
            kms_limit: kl.kms_limit ?? 0,
          });
        }
      }
    }

    return rows;
  }

  private async saveVendorLocalPricebookBulk(vendorId: number, data: any): Promise<any> {
    const vendorIds = this.asArray(data.vendor_id);
    const branchIds = this.asArray(data.vendor_branch_id);
    const vehicleTypeIds = this.asArray(data.vehicle_type_id);
    const timeLimitIds = this.asArray(data.time_limit_id);
    const rentalCharges = this.asArray(data.vehicle_rental_charge);

    const start = this.parseFlexibleDate(data.local_pricebook_start_date);
    const end = this.parseFlexibleDate(data.local_pricebook_end_date);
    if (!start || !end) {
      throw new NotFoundException('local_pricebook_start_date and local_pricebook_end_date are required');
    }

    const slices = this.monthSlicesBetween(start, end);
    let processed = 0;

    for (let i = 0; i < vehicleTypeIds.length; i += 1) {
      const charge = this.toNumberOrNull(rentalCharges[i]);
      if (charge === null) continue;

      const rowVendorId = this.toNumberOrNull(vendorIds[i]) ?? vendorId;
      const vendorBranchId = this.toNumberOrNull(branchIds[i]) ?? 0;
      const vehicleTypeId = this.toNumberOrNull(vehicleTypeIds[i]) ?? 0;
      const timeLimitId = this.toNumberOrNull(timeLimitIds[i]) ?? 0;
      if (!vehicleTypeId || !timeLimitId) continue;

      for (const slice of slices) {
        const where = {
          vendor_id: rowVendorId,
          vendor_branch_id: vendorBranchId,
          vehicle_type_id: vehicleTypeId,
          time_limit_id: timeLimitId,
          year: slice.year,
          month: slice.month,
          deleted: 0,
        };

        const patch = this.rangedDayPatch(charge, slice.startDay, slice.endDay);
        const existing = await this.prisma.dvi_vehicle_local_pricebook.findFirst({ where });

        if (existing) {
          await this.prisma.dvi_vehicle_local_pricebook.update({
            where: { vehicle_price_book_id: existing.vehicle_price_book_id },
            data: { ...patch, updatedon: new Date(), status: 1 },
          });
        } else {
          await this.prisma.dvi_vehicle_local_pricebook.create({
            data: {
              ...this.fullDayMap(0),
              ...patch,
              vendor_id: rowVendorId,
              vendor_branch_id: vendorBranchId,
              vehicle_type_id: vehicleTypeId,
              time_limit_id: timeLimitId,
              cost_type: 1,
              year: slice.year,
              month: slice.month,
              createdby: 0,
              createdon: new Date(),
              status: 1,
              deleted: 0,
            },
          });
        }
        processed += 1;
      }
    }

    return { success: true, processed };
  }

  async updateVendorLocalPricebook(vendorId: number, data: any): Promise<any> {
    const isBulk =
      data?.local_pricebook_start_date !== undefined ||
      data?.local_pricebook_end_date !== undefined ||
      Array.isArray(data?.vehicle_rental_charge);

    if (isBulk) {
      return this.saveVendorLocalPricebookBulk(vendorId, data);
    }

    const { vehicle_price_book_id, ...rest } = data;
    if (vehicle_price_book_id) {
      return this.prisma.dvi_vehicle_local_pricebook.update({
        where: { vehicle_price_book_id },
        data: { ...rest, updatedon: new Date() },
      });
    } else {
      return this.prisma.dvi_vehicle_local_pricebook.create({
        data: {
          ...rest,
          vendor_id: vendorId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });
    }
  }

  async getVendorOutstationPricebook(vendorId: number): Promise<any[]> {
    return this.prisma.dvi_vehicle_outstation_price_book.findMany({
      where: { vendor_id: vendorId, deleted: 0 },
    });
  }

  private async saveVendorOutstationPricebookBulk(vendorId: number, data: any): Promise<any> {
    const vendorIds = this.asArray(data.vendor_id);
    const branchIds = this.asArray(data.vendor_branch_id);
    const vehicleTypeIds = this.asArray(data.vehicle_type_id);
    const kmsLimitIds = this.asArray(data.kms_limit_id);
    const rentalCharges = this.asArray(data.outstation_vehicle_rental_charge ?? data.vehicle_rental_charge);

    const start = this.parseFlexibleDate(data.outstation_pricebook_start_date);
    const end = this.parseFlexibleDate(data.outstation_pricebook_end_date);
    if (!start || !end) {
      throw new NotFoundException('outstation_pricebook_start_date and outstation_pricebook_end_date are required');
    }

    const slices = this.monthSlicesBetween(start, end);
    let processed = 0;

    for (let i = 0; i < vehicleTypeIds.length; i += 1) {
      const charge = this.toNumberOrNull(rentalCharges[i]);
      if (charge === null) continue;

      const rowVendorId = this.toNumberOrNull(vendorIds[i]) ?? vendorId;
      const vendorBranchId = this.toNumberOrNull(branchIds[i]) ?? 0;
      const vehicleTypeId = this.toNumberOrNull(vehicleTypeIds[i]) ?? 0;
      const kmsLimitId = this.toNumberOrNull(kmsLimitIds[i]) ?? 0;
      if (!vehicleTypeId || !kmsLimitId) continue;

      for (const slice of slices) {
        const where = {
          vendor_id: rowVendorId,
          vendor_branch_id: vendorBranchId,
          vehicle_type_id: vehicleTypeId,
          kms_limit_id: kmsLimitId,
          year: slice.year,
          month: slice.month,
          deleted: 0,
        };

        const patch = this.rangedDayPatch(charge, slice.startDay, slice.endDay);
        const existing = await this.prisma.dvi_vehicle_outstation_price_book.findFirst({ where });

        if (existing) {
          await this.prisma.dvi_vehicle_outstation_price_book.update({
            where: { vehicle_outstation_price_book_id: existing.vehicle_outstation_price_book_id },
            data: { ...patch, updatedon: new Date(), status: 1 },
          });
        } else {
          await this.prisma.dvi_vehicle_outstation_price_book.create({
            data: {
              ...this.fullDayMap(0),
              ...patch,
              vendor_id: rowVendorId,
              vendor_branch_id: vendorBranchId,
              vehicle_type_id: vehicleTypeId,
              kms_limit_id: kmsLimitId,
              year: slice.year,
              month: slice.month,
              createdby: 0,
              createdon: new Date(),
              status: 1,
              deleted: 0,
            },
          });
        }
        processed += 1;
      }
    }

    return { success: true, processed };
  }

  async updateVendorOutstationPricebook(vendorId: number, data: any): Promise<any> {
    const isBulk =
      data?.outstation_pricebook_start_date !== undefined ||
      data?.outstation_pricebook_end_date !== undefined ||
      Array.isArray(data?.outstation_vehicle_rental_charge) ||
      Array.isArray(data?.vehicle_rental_charge);

    if (isBulk) {
      return this.saveVendorOutstationPricebookBulk(vendorId, data);
    }

    const { vehicle_outstation_price_book_id, ...rest } = data;
    if (vehicle_outstation_price_book_id) {
      return this.prisma.dvi_vehicle_outstation_price_book.update({
        where: { vehicle_outstation_price_book_id },
        data: { ...rest, updatedon: new Date() },
      });
    } else {
      return this.prisma.dvi_vehicle_outstation_price_book.create({
        data: {
          ...rest,
          vendor_id: vendorId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });
    }
  }

  // --- Step 6: Permit Cost (dvi_permit_cost) ---

  async getVendorPermitCosts(vendorId: number): Promise<any[]> {
    const rows = await this.prisma.dvi_permit_cost.findMany({
      where: { vendor_id: vendorId, deleted: 0 },
    });

    const vendorTypeIds = [...new Set(rows.map((r) => r.vehicle_type_id).filter((id) => Number(id) > 0))];
    const vendorTypes = vendorTypeIds.length
      ? await this.prisma.dvi_vendor_vehicle_types.findMany({
          where: { vendor_vehicle_type_ID: { in: vendorTypeIds } },
          select: {
            vendor_vehicle_type_ID: true,
            vehicle_type_id: true,
          },
        })
      : [];
    const vtMap = new Map(
      vendorTypes.map((v) => [v.vendor_vehicle_type_ID, v.vehicle_type_id]),
    );

    return rows.map((r) => ({
      ...r,
      vendor_vehicle_type_id: r.vehicle_type_id,
      vehicle_type_id: vtMap.get(r.vehicle_type_id) ?? r.vehicle_type_id,
    }));
  }

  async updateVendorPermitCost(vendorId: number, data: any): Promise<any> {
    const permitCostId = this.toNumberOrNull(data.permit_cost_id);
    const sourceStateId = this.toNumberOrNull(data.source_state_id);
    const destinationStateId = this.toNumberOrNull(data.destination_state_id);
    const permitCost = this.toNumberOrNull(data.permit_cost) ?? 0;
    const vendorVehicleTypeId = await this.resolveVendorVehicleTypeId(vendorId, data.vehicle_type_id);

    if (!sourceStateId || !destinationStateId || !vendorVehicleTypeId) {
      throw new NotFoundException('vehicle_type_id, source_state_id and destination_state_id are required');
    }

    const mapped = {
      vehicle_type_id: vendorVehicleTypeId,
      source_state_id: sourceStateId,
      destination_state_id: destinationStateId,
      permit_cost: permitCost,
    };

    if (permitCostId) {
      return this.prisma.dvi_permit_cost.update({
        where: { permit_cost_id: permitCostId },
        data: { ...mapped, updatedon: new Date() },
      });
    } else {
      const existing = await this.prisma.dvi_permit_cost.findFirst({
        where: {
          vendor_id: vendorId,
          vehicle_type_id: vendorVehicleTypeId,
          source_state_id: sourceStateId,
          destination_state_id: destinationStateId,
          deleted: 0,
        },
      });

      if (existing) {
        return this.prisma.dvi_permit_cost.update({
          where: { permit_cost_id: existing.permit_cost_id },
          data: { permit_cost: permitCost, updatedon: new Date() },
        });
      }

      return this.prisma.dvi_permit_cost.create({
        data: {
          ...mapped,
          vendor_id: vendorId,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });
    }
  }

  async getVendorOutstationKmLimits(vendorId: number): Promise<any[]> {
    const rows = await this.prisma.dvi_kms_limit.findMany({
      where: { vendor_id: vendorId, deleted: 0 },
      orderBy: { kms_limit_id: 'desc' },
    });

    const vendorTypeIds = [...new Set(rows.map((r) => r.vendor_vehicle_type_id).filter((id) => Number(id) > 0))];
    const vendorTypes = vendorTypeIds.length
      ? await this.prisma.dvi_vendor_vehicle_types.findMany({
          where: { vendor_vehicle_type_ID: { in: vendorTypeIds } },
          select: { vendor_vehicle_type_ID: true, vehicle_type_id: true },
        })
      : [];
    const vtMap = new Map(vendorTypes.map((v) => [v.vendor_vehicle_type_ID, v.vehicle_type_id]));

    return rows.map((r) => ({
      ...r,
      vehicle_type_id: vtMap.get(r.vendor_vehicle_type_id) ?? r.vendor_vehicle_type_id,
    }));
  }

  async upsertVendorOutstationKmLimit(vendorId: number, data: any): Promise<any> {
    const kmsLimitId = this.toNumberOrNull(data.out_km_id ?? data.kms_limit_id ?? data.id);
    const deleteRequested = this.toNumberOrNull(data.deleted) === 1 || this.toNumberOrNull(data.status) === 0;

    if (deleteRequested) {
      if (!kmsLimitId) {
        throw new BadRequestException('kms_limit_id is required for delete');
      }

      const existingDeleteRow = await this.prisma.dvi_kms_limit.findFirst({
        where: { kms_limit_id: kmsLimitId, vendor_id: vendorId, deleted: 0 },
      });
      if (!existingDeleteRow) {
        throw new NotFoundException(`Outstation KM limit ${kmsLimitId} not found for vendor ${vendorId}`);
      }

      return this.prisma.dvi_kms_limit.update({
        where: { kms_limit_id: kmsLimitId },
        data: { deleted: 1, status: 0, updatedon: new Date() },
      });
    }

    const requestedVehicleTypeId = this.toNumberOrNull(data.vehicle_type_id ?? data.vehicleTypeId);
    if (!requestedVehicleTypeId) {
      throw new BadRequestException('vehicle_type_id is required');
    }
    const vendorVehicleTypeId = await this.resolveVendorVehicleTypeId(
      vendorId,
      requestedVehicleTypeId,
    );
    if (!vendorVehicleTypeId) {
      throw new BadRequestException(`vehicle_type_id ${requestedVehicleTypeId} is not configured for this vendor`);
    }

    const title = String(data.out_km_title ?? data.kms_limit_title ?? data.title ?? '').trim();
    const limit = this.toNumberOrNull(data.out_km_limit ?? data.kms_limit ?? data.kmLimit) ?? 0;
    const mapped = {
      vendor_id: vendorId,
      vendor_vehicle_type_id: vendorVehicleTypeId,
      kms_limit_title: title,
      kms_limit: limit,
      status: 1,
    };

    if (kmsLimitId) {
      return this.prisma.dvi_kms_limit.update({
        where: { kms_limit_id: kmsLimitId },
        data: { ...mapped, updatedon: new Date() },
      });
    }

    const existing = await this.prisma.dvi_kms_limit.findFirst({
      where: {
        vendor_id: vendorId,
        vendor_vehicle_type_id: vendorVehicleTypeId,
        deleted: 0,
      },
    });

    if (existing) {
      return this.prisma.dvi_kms_limit.update({
        where: { kms_limit_id: existing.kms_limit_id },
        data: { ...mapped, updatedon: new Date() },
      });
    }

    return this.prisma.dvi_kms_limit.create({
      data: {
        ...mapped,
        createdon: new Date(),
        deleted: 0,
      },
    });
  }

  async getVendorLocalKmLimits(vendorId: number): Promise<any[]> {
    const rows = await this.prisma.dvi_time_limit.findMany({
      where: { vendor_id: vendorId, deleted: 0 },
      orderBy: { time_limit_id: 'desc' },
    });

    const vendorTypeIds = [...new Set(rows.map((r) => r.vendor_vehicle_type_id).filter((id) => Number(id) > 0))];
    const vendorTypes = vendorTypeIds.length
      ? await this.prisma.dvi_vendor_vehicle_types.findMany({
          where: { vendor_vehicle_type_ID: { in: vendorTypeIds } },
          select: { vendor_vehicle_type_ID: true, vehicle_type_id: true },
        })
      : [];
    const vtMap = new Map(vendorTypes.map((v) => [v.vendor_vehicle_type_ID, v.vehicle_type_id]));

    return rows.map((r) => ({
      ...r,
      vehicle_type_id: vtMap.get(r.vendor_vehicle_type_id) ?? r.vendor_vehicle_type_id,
    }));
  }

  async upsertVendorLocalKmLimit(vendorId: number, data: any): Promise<any> {
    const timeLimitId = this.toNumberOrNull(data.loc_km_id ?? data.time_limit_id ?? data.id);
    const deleteRequested = this.toNumberOrNull(data.deleted) === 1 || this.toNumberOrNull(data.status) === 0;

    if (deleteRequested) {
      if (!timeLimitId) {
        throw new BadRequestException('time_limit_id is required for delete');
      }

      const existingDeleteRow = await this.prisma.dvi_time_limit.findFirst({
        where: { time_limit_id: timeLimitId, vendor_id: vendorId, deleted: 0 },
      });
      if (!existingDeleteRow) {
        throw new NotFoundException(`Local KM limit ${timeLimitId} not found for vendor ${vendorId}`);
      }

      return this.prisma.dvi_time_limit.update({
        where: { time_limit_id: timeLimitId },
        data: { deleted: 1, status: 0, updatedon: new Date() },
      });
    }

    const requestedVehicleTypeId = this.toNumberOrNull(data.vehicle_type_id ?? data.vehicleTypeId);
    if (!requestedVehicleTypeId) {
      throw new BadRequestException('vehicle_type_id is required');
    }
    const vendorVehicleTypeId = await this.resolveVendorVehicleTypeId(
      vendorId,
      requestedVehicleTypeId,
    );
    if (!vendorVehicleTypeId) {
      throw new BadRequestException(`vehicle_type_id ${requestedVehicleTypeId} is not configured for this vendor`);
    }

    const title = String(data.loc_km_title ?? data.time_limit_title ?? data.title ?? '').trim();
    const hours = this.toNumberOrNull(data.loc_km_hour ?? data.hours_limit ?? data.hours ?? data.hourLimit) ?? 0;
    const km = this.toNumberOrNull(data.loc_km_limit ?? data.km_limit ?? data.km ?? data.kmLimit) ?? 0;
    const mapped = {
      vendor_id: vendorId,
      vendor_vehicle_type_id: vendorVehicleTypeId,
      time_limit_title: title,
      hours_limit: hours,
      km_limit: km,
      status: 1,
    };

    if (timeLimitId) {
      return this.prisma.dvi_time_limit.update({
        where: { time_limit_id: timeLimitId },
        data: { ...mapped, updatedon: new Date() },
      });
    }

    const existing = await this.prisma.dvi_time_limit.findFirst({
      where: {
        vendor_id: vendorId,
        vendor_vehicle_type_id: vendorVehicleTypeId,
        hours_limit: hours,
        km_limit: km,
        deleted: 0,
      },
    });

    if (existing) {
      return this.prisma.dvi_time_limit.update({
        where: { time_limit_id: existing.time_limit_id },
        data: { ...mapped, updatedon: new Date() },
      });
    }

    return this.prisma.dvi_time_limit.create({
      data: {
        ...mapped,
        createdon: new Date(),
        deleted: 0,
      },
    });
  }

  // --- Dropdowns for Steps 3-6 ---

  async getVehicleTypeOptions(): Promise<{ items: DropdownItem[] }> {
    const rows = await this.prisma.dvi_vehicle_type.findMany({
      where: { deleted: 0, status: 1 },
      orderBy: { vehicle_type_title: 'asc' },
    });
    return {
      items: rows.map((r) => ({
        id: String(r.vehicle_type_id),
        label: r.vehicle_type_title || '',
      })),
    };
  }

  async getTimeLimitOptions(vendorId: number): Promise<{ items: DropdownItem[] }> {
    const rows = await this.prisma.dvi_time_limit.findMany({
      where: { vendor_id: vendorId, deleted: 0 },
    });
    return {
      items: rows.map((r) => ({
        id: String(r.time_limit_id),
        label: r.time_limit_title || '',
      })),
    };
  }

  async getKmsLimitOptions(vendorId: number): Promise<{ items: DropdownItem[] }> {
    const rows = await this.prisma.dvi_kms_limit.findMany({
      where: { vendor_id: vendorId, deleted: 0 },
    });
    return {
      items: rows.map((r) => ({
        id: String(r.kms_limit_id),
        label: r.kms_limit_title || '',
      })),
    };
  }

  async getPermitStateOptions(): Promise<{ items: DropdownItem[] }> {
    const rows = await this.prisma.dvi_permit_state.findMany({
      where: { deleted: 0, status: 1 },
      orderBy: { state_name: 'asc' },
      select: { permit_state_id: true, state_name: true },
    });

    return {
      items: rows.map((r) => ({
        id: String(r.permit_state_id),
        label: r.state_name,
      })),
    };
  }
}
