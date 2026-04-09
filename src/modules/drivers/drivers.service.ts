// NEW FILE: src/modules/drivers/drivers.service.ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { DriverListItemDto } from './dto/driver-list-item.dto';
import { CreateDriverDto } from './dto/create-driver.dto';
import { UpdateDriverDto } from './dto/update-driver.dto';

@Injectable()
export class DriversService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);
  private readonly documentExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf']);

  private toNumberOrNull(value: any): number | null {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  private toDateOrNull(value: any): Date | null {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

    const raw = String(value).trim();
    if (!raw) return null;

    if (/^\d{2}-\d{2}-\d{4}$/.test(raw)) {
      const [dd, mm, yyyy] = raw.split('-').map(Number);
      const d = new Date(yyyy, mm - 1, dd);
      return Number.isNaN(d.getTime()) ? null : d;
    }

    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  private getBasicPayload(body: any): any {
    return body?.basic ?? body ?? {};
  }

  private validateDocumentExtension(documentType: string, fileName: string): void {
    const ext = (fileName ? fileName.substring(fileName.lastIndexOf('.')) : '').toLowerCase();
    if (!ext || !this.documentExtensions.has(ext)) {
      throw new BadRequestException('Invalid document file type. Allowed: jpg, jpeg, png, webp, pdf');
    }

    const normalizedType = String(documentType || '').trim().toLowerCase();
    if (normalizedType === 'profile_image' && !this.imageExtensions.has(ext)) {
      throw new BadRequestException('Profile Image supports only: jpg, jpeg, png, webp');
    }
  }

  private resolveBackendBaseUrl(): string {
    const raw =
      process.env.BASE_URL ||
      process.env.BACKEND_URL ||
      process.env.API_BASE_URL ||
      `http://localhost:${process.env.PORT || 4006}`;
    return String(raw).replace(/\/+$/, '');
  }

  private toPublicFileUrl(relativePath: string): string {
    const cleanRelative = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
    return `${this.resolveBackendBaseUrl()}${cleanRelative}`;
  }

  private mapBasicData(basic: any, profileImageName?: string): Record<string, any> {
    const vendorId = this.toNumberOrNull(basic.vendorId) ?? this.toNumberOrNull(basic.vendor_id) ?? 0;
    const vehicleTypeId =
      this.toNumberOrNull(basic.vehicleTypeId) ??
      this.toNumberOrNull(basic.vehicle_type_id) ??
      this.toNumberOrNull(basic.vendor_vehicle_id) ??
      0;

    const primaryMobile =
      basic.primaryMobile ?? basic.primaryMobileNumber ?? basic.driver_primary_mobile_number ?? null;

    const bloodGroup =
      this.toNumberOrNull(basic.bloodGroup) ?? this.toNumberOrNull(basic.driver_blood_group) ?? 0;

    const gender = this.toNumberOrNull(basic.gender) ?? this.toNumberOrNull(basic.driver_gender) ?? 0;

    const licenseExpiryDate =
      this.toDateOrNull(basic.licenseExpireDate) ??
      this.toDateOrNull(basic.licenseExpiryDate) ??
      this.toDateOrNull(basic.driver_license_expiry_date);

    const mapped: Record<string, any> = {
      vendor_id: vendorId,
      vehicle_type_id: vehicleTypeId,
      driver_name: basic.driverName ?? basic.driver_name ?? null,
      driver_primary_mobile_number: primaryMobile,
      driver_alternate_mobile_number:
        basic.alternativeMobile ?? basic.alternateMobileNumber ?? basic.driver_alternate_mobile_number ?? null,
      driver_whatsapp_mobile_number:
        basic.whatsappMobile ?? basic.whatsappMobileNumber ?? basic.driver_whatsapp_mobile_number ?? null,
      driver_email: basic.email ?? basic.driver_email ?? null,
      driver_license_number: basic.licenseNumber ?? basic.driver_license_number ?? null,
      driver_license_issue_date:
        this.toDateOrNull(basic.licenseIssueDate) ?? this.toDateOrNull(basic.driver_license_issue_date),
      driver_license_expiry_date: licenseExpiryDate,
      driver_date_of_birth:
        this.toDateOrNull(basic.dateOfBirth) ?? this.toDateOrNull(basic.driver_date_of_birth),
      driver_aadharcard_num: basic.aadharNumber ?? basic.driver_aadharcard_num ?? null,
      driver_voter_id_num: basic.voterId ?? basic.voterIdNumber ?? basic.driver_voter_id_num ?? null,
      driver_pan_card: basic.panNumber ?? basic.driver_pan_card ?? null,
      driver_blood_group: bloodGroup,
      driver_gender: gender,
      driver_address: basic.address ?? basic.driver_address ?? null,
      status: licenseExpiryDate && licenseExpiryDate < new Date(new Date().toDateString()) ? 0 : 1,
    };

    if (profileImageName) mapped.driver_profile_image = profileImageName;
    return mapped;
  }

  async getLookups() {
    const [vendors, vehicleTypes] = await Promise.all([
      this.prisma.dvi_vendor_details.findMany({
        where: { deleted: 0 },
        orderBy: { vendor_name: 'asc' },
        select: { vendor_id: true, vendor_name: true },
      }),
      this.prisma.dvi_vehicle_type.findMany({
        where: { deleted: 0, status: 1 },
        orderBy: { vehicle_type_title: 'asc' },
        select: { vehicle_type_id: true, vehicle_type_title: true },
      }),
    ]);

    return {
      vendors: vendors.map((v) => ({ id: v.vendor_id, label: v.vendor_name ?? '' })),
      vehicleTypes: vehicleTypes.map((v) => ({ id: v.vehicle_type_id, label: v.vehicle_type_title ?? '' })),
      bloodGroups: [
        { id: '1', label: 'A+' },
        { id: '2', label: 'A-' },
        { id: '3', label: 'B+' },
        { id: '4', label: 'B-' },
        { id: '5', label: 'AB+' },
        { id: '6', label: 'AB-' },
        { id: '7', label: 'O+' },
        { id: '8', label: 'O-' },
      ],
      genders: [
        { id: '1', label: 'Male' },
        { id: '2', label: 'Female' },
        { id: '3', label: 'Other' },
      ],
      documentTypes: [
        { id: 'aadhar_card', label: 'Aadhar Card' },
        { id: 'pan_card', label: 'PAN Card' },
        { id: 'driving_license', label: 'Driving License' },
        { id: 'voter_id', label: 'Voter ID' },
        { id: 'profile_image', label: 'Profile Image' },
        { id: 'other', label: 'Other' },
      ],
    };
  }

  async create(dto: CreateDriverDto | any, profileImageName?: string) {
    const basic = this.getBasicPayload(dto);
    const mapped = this.mapBasicData(basic, profileImageName);

    const created = await this.prisma.dvi_driver_details.create({
      data: {
        ...mapped,
        deleted: 0,
        createdon: new Date(),
      },
    });

    if (!created.driver_code) {
      await this.prisma.dvi_driver_details.update({
        where: { driver_id: created.driver_id },
        data: { driver_code: `DRI${String(created.driver_id).padStart(5, '0')}` },
      });
    }

    return { id: created.driver_id, driverId: created.driver_id };
  }

  async findOne(id: number) {
    const driver = await this.prisma.dvi_driver_details.findFirst({
      where: { driver_id: id, deleted: 0 },
    });
    if (!driver) throw new NotFoundException('Driver not found');
    return driver;
  }

  async findOneForWizard(id: number) {
    const driver = await this.findOne(id);
    const [costDetails, documents, reviews] = await Promise.all([
      this.prisma.dvi_driver_costdetails.findFirst({
        where: { driver_id: id },
        orderBy: { driver_costdetails_id: 'desc' },
      }),
      this.listDocuments(id),
      this.listReviews(id),
    ]);

    return {
      id: driver.driver_id,
      basicInfo: {
        vendorId: driver.vendor_id,
        vehicleTypeId: driver.vehicle_type_id,
        driverName: driver.driver_name ?? '',
        primaryMobile: driver.driver_primary_mobile_number ?? '',
        alternativeMobile: driver.driver_alternate_mobile_number ?? '',
        whatsappMobile: driver.driver_whatsapp_mobile_number ?? '',
        email: driver.driver_email ?? '',
        licenseNumber: driver.driver_license_number ?? '',
        licenseIssueDate: driver.driver_license_issue_date,
        licenseExpireDate: driver.driver_license_expiry_date,
        dateOfBirth: driver.driver_date_of_birth,
        bloodGroup: String(driver.driver_blood_group ?? ''),
        gender: String(driver.driver_gender ?? ''),
        aadharNumber: driver.driver_aadharcard_num ?? '',
        panNumber: driver.driver_pan_card ?? '',
        voterId: driver.driver_voter_id_num ?? '',
        profileUrl: driver.driver_profile_image
          ? this.toPublicFileUrl(`/uploads/driver_gallery/${driver.driver_profile_image}`)
          : '',
        address: driver.driver_address ?? '',
      },
      costDetails: costDetails
        ? {
            driverSalary: costDetails.driver_salary,
            foodCost: costDetails.driver_food_cost,
            accommodationCost: costDetails.driver_accomdation_cost,
            bhattaCost: costDetails.driver_bhatta_cost,
            earlyMorningCharges: costDetails.driver_early_morning_charges,
            eveningCharges: costDetails.driver_evening_charges,
          }
        : null,
      documents,
      reviews,
    };
  }

  async updateBasic(id: number, dto: any, profileImageName?: string) {
    const existing = await this.findOne(id);
    const basic = this.getBasicPayload(dto);
    const mapped = this.mapBasicData(basic, profileImageName);

    await this.prisma.dvi_driver_details.update({
      where: { driver_id: id },
      data: {
        ...mapped,
        driver_code: existing.driver_code || `DRI${String(existing.driver_id).padStart(5, '0')}`,
        updatedon: new Date(),
      },
    });

    return { id, driverId: id };
  }

  async upsertCost(id: number, data: any) {
    await this.findOne(id);

    const mapped = {
      driver_salary: Number(data?.driverSalary ?? data?.driver_salary ?? 0) || 0,
      driver_food_cost: Number(data?.foodCost ?? data?.driver_food_cost ?? 0) || 0,
      driver_accomdation_cost:
        Number(data?.accommodationCost ?? data?.driver_accomdation_cost ?? 0) || 0,
      driver_bhatta_cost: Number(data?.bhattaCost ?? data?.driver_bhatta_cost ?? 0) || 0,
      driver_early_morning_charges:
        Number(data?.earlyMorningCharges ?? data?.driver_early_morning_charges ?? 0) || 0,
      driver_evening_charges:
        Number(data?.eveningCharges ?? data?.driver_evening_charges ?? 0) || 0,
      driver_gst_type: Number(data?.driver_gst_type ?? 1) || 1,
    };

    const existing = await this.prisma.dvi_driver_costdetails.findFirst({
      where: { driver_id: id },
      orderBy: { driver_costdetails_id: 'desc' },
    });

    if (existing) {
      await this.prisma.dvi_driver_costdetails.update({
        where: { driver_costdetails_id: existing.driver_costdetails_id },
        data: { ...mapped, updatedon: new Date(), status: 1, deleted: 0 },
      });
    } else {
      await this.prisma.dvi_driver_costdetails.create({
        data: {
          driver_id: id,
          ...mapped,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });
    }

    return { success: true };
  }

  async listDocuments(id: number) {
    await this.findOne(id);
    const rows = await this.prisma.dvi_driver_document_details.findMany({
      where: { driver_id: id, deleted: 0 },
      orderBy: { driver_document_details_id: 'asc' },
    });

    return rows.map((r) => ({
      id: r.driver_document_details_id,
      documentType: r.document_type ?? '',
      fileName: r.driver_document_name ?? '',
      fileUrl: r.driver_document_name
        ? this.toPublicFileUrl(`/uploads/driver_gallery/${r.driver_document_name}`)
        : '',
      createdAt: r.createdon,
    }));
  }

  async uploadDocument(id: number, documentType: string, fileName: string) {
    await this.findOne(id);
    const docType = String(documentType || '').trim() || 'other';
    this.validateDocumentExtension(docType, fileName);

    const existing = await this.prisma.dvi_driver_document_details.findFirst({
      where: { driver_id: id, document_type: docType, deleted: 0 },
      orderBy: { driver_document_details_id: 'desc' },
    });

    if (existing) {
      await this.prisma.dvi_driver_document_details.update({
        where: { driver_document_details_id: existing.driver_document_details_id },
        data: {
          driver_document_name: fileName,
          updatedon: new Date(),
          status: 1,
        },
      });
    } else {
      await this.prisma.dvi_driver_document_details.create({
        data: {
          driver_id: id,
          document_type: docType,
          driver_document_name: fileName,
          createdon: new Date(),
          status: 1,
          deleted: 0,
        },
      });
    }

    return { success: true };
  }

  async listReviews(id: number) {
    await this.findOne(id);
    const rows = await this.prisma.dvi_driver_review_details.findMany({
      where: { driver_id: id, deleted: 0 },
      orderBy: { driver_review_id: 'desc' },
    });

    return rows.map((r) => ({
      id: r.driver_review_id,
      rating: Number(r.driver_rating ?? 0) || 0,
      description: r.driver_description ?? '',
      createdAt: r.createdon,
    }));
  }

  async createReview(id: number, data: { rating?: number | string; description?: string }) {
    await this.findOne(id);
    await this.prisma.dvi_driver_review_details.create({
      data: {
        driver_id: id,
        driver_rating: String(data?.rating ?? ''),
        driver_description: String(data?.description ?? ''),
        createdon: new Date(),
        status: 1,
        deleted: 0,
      },
    });
    return { success: true };
  }

  async update(id: number, dto: UpdateDriverDto) {
    const existing = await this.findOne(id);
    const b = dto.basic;
    return this.prisma.dvi_driver_details.update({
      where: { driver_id: id },
      data: {
        vendor_id: b?.vendorId ?? existing.vendor_id,
        vehicle_type_id: b?.vehicleTypeId ?? existing.vehicle_type_id,
        driver_name: b?.driverName ?? existing.driver_name,
        driver_primary_mobile_number: b?.primaryMobileNumber ?? existing.driver_primary_mobile_number,
        driver_alternate_mobile_number: b?.alternateMobileNumber ?? existing.driver_alternate_mobile_number,
        driver_whatsapp_mobile_number: b?.whatsappMobileNumber ?? existing.driver_whatsapp_mobile_number,
        driver_email: b?.email ?? existing.driver_email,
        driver_license_number: b?.licenseNumber ?? existing.driver_license_number,
        driver_license_issue_date: b?.licenseIssueDate ? new Date(b.licenseIssueDate) : existing.driver_license_issue_date,
        driver_license_expiry_date: b?.licenseExpiryDate ? new Date(b.licenseExpiryDate) : existing.driver_license_expiry_date,
        driver_aadharcard_num: b?.aadharNumber ?? existing.driver_aadharcard_num,
        driver_voter_id_num: b?.voterIdNumber ?? existing.driver_voter_id_num,
        driver_pan_card: b?.panNumber ?? existing.driver_pan_card,
        driver_blood_group: b?.bloodGroup ? parseInt(b.bloodGroup) : existing.driver_blood_group,
        driver_gender: b?.gender ? parseInt(b.gender) : existing.driver_gender,
        driver_address: b?.address ?? existing.driver_address,
        updatedon: new Date(),
      },
    });
  }

  /**
   * List drivers (equivalent of __JSONdriver.php)
   * - Optional vendor filter (like $logged_vendor_id)
   */
  async findAll(vendorId?: number): Promise<DriverListItemDto[]> {
    const drivers = await this.prisma.dvi_driver_details.findMany({
      where: vendorId ? { vendor_id: vendorId, deleted: 0 } : { deleted: 0 },
      orderBy: { driver_id: 'desc' },
    });

    const todayStr = new Date().toISOString().slice(0, 10);

    return drivers.map((d: any) => {
      const exp: Date | null = d.driver_license_expiry_date
        ? new Date(d.driver_license_expiry_date)
        : null;

      let licenseStatus = 'Active';
      if (exp) {
        const expStr = exp.toISOString().slice(0, 10);
        if (expStr === todayStr) {
          licenseStatus = 'Expires Today';
        } else if (expStr < todayStr) {
          licenseStatus = 'In-Active';
        } else {
          licenseStatus = 'Active';
        }
      }

      return {
        id: d.driver_id,
        name: d.driver_name,
        mobile: d.driver_primary_mobile_number,
        licenseNumber: d.driver_license_number,
        licenseExpiryDate: exp,
        licenseStatus,
        status: d.status === 1 || d.status === true,
      };
    });
  }

  async updateStatus(id: number, status: boolean): Promise<void> {
    const existing = await this.findOne(id);
    const exp = existing.driver_license_expiry_date
      ? new Date(existing.driver_license_expiry_date)
      : null;
    const isExpired = exp ? exp < new Date(new Date().toDateString()) : false;
    const nextStatus = status && !isExpired ? 1 : 0;

    await this.prisma.dvi_driver_details.update({
      where: { driver_id: id },
      data: { status: nextStatus, updatedon: new Date() },
    });
  }

  async remove(id: number): Promise<void> {
    await this.prisma.dvi_driver_details.update({
      where: { driver_id: id },
      data: { deleted: 1, updatedon: new Date() },
    });
  }
}
