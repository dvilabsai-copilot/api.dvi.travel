// FILE: src/modules/vendors/dto/vendor-list-item.dto.ts
export class VendorListItemDto {
 id!: number; // vendor_id
 vendorName!: string; // vendor_name
 vendorCode!: string; // vendor_code
 vendorMobile!: string; // vendor_primary_mobile_number
  vendorEmail?: string | null;
 totalBranch!: number; // branch_count
 status!: number; // 1 / 0 (Active / In-Active)
}
