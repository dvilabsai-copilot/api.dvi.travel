import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../../prisma.service";
import { CreateVehicleTypeDto } from "./dto/create-vehicle-type.dto";
import { UpdateVehicleTypeDto } from "./dto/update-vehicle-type.dto";

function to01(v: any): 0 | 1 {
  if (typeof v === "number") return v === 1 ? 1 : 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "1" || s === "true" ? 1 : 0;
  }
  return 0;
}

function pickTitle(dto: CreateVehicleTypeDto | UpdateVehicleTypeDto): string | undefined {
  const t = (dto.title ?? dto.vehicle_type_title ?? "").toString().trim();
  return t.length ? t : undefined;
}

function pickOccupancy(dto: CreateVehicleTypeDto | UpdateVehicleTypeDto): number | undefined {
  const v = dto.occupancy ?? dto.no_of_seats;
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

@Injectable()
export class VehicleTypesService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const rows = await this.prisma.dvi_vehicle_type.findMany({
      where: { deleted: 0 },
      orderBy: { vehicle_type_id: "desc" },
      select: {
        vehicle_type_id: true,
        vehicle_type_title: true,
        occupancy: true,
        status: true,
      },
    });

 // Match PHP-ish response shape used by DataTables JSON
    return { data: rows };
  }

  async getOne(id: number) {
    const row = await this.prisma.dvi_vehicle_type.findFirst({
      where: { vehicle_type_id: id, deleted: 0 },
      select: {
        vehicle_type_id: true,
        vehicle_type_title: true,
        occupancy: true,
        status: true,
      },
    });

    if (!row) throw new NotFoundException("Vehicle Type not found");
    return { data: row };
  }

 /**
   * Mirrors PHP "check title" logic (used by parsley remote validators in legacy UI).
   * If title equals oldTitle, PHP typically treats it as valid.
 */
  async checkTitle(titleRaw: string, excludeId?: number, oldTitle?: string) {
    const title = (titleRaw ?? "").toString().trim();
    const old = (oldTitle ?? "").toString().trim();

    if (!title) return { available: false };
    if (old && title.toLowerCase() === old.toLowerCase()) return { available: true };

    const found = await this.prisma.dvi_vehicle_type.findFirst({
      where: {
        deleted: 0,
        vehicle_type_title: title,
        ...(excludeId ? { vehicle_type_id: { not: excludeId } } : {}),
      },
      select: { vehicle_type_id: true },
    });

    return { available: !found };
  }

  async create(dto: CreateVehicleTypeDto, userId: number) {
    const title = pickTitle(dto);
    const occupancy = pickOccupancy(dto);

    if (!title) throw new Error("vehicle_type_title is required");
    if (occupancy === undefined) throw new Error("occupancy is required");

 // PHP effectively makes new records active
    const created = await this.prisma.dvi_vehicle_type.create({
      data: {
        vehicle_type_title: title,
        occupancy,
        createdby: userId ?? 0,
        createdon: new Date(),
        updatedon: new Date(),
        status: 1,
        deleted: 0,
      },
      select: {
        vehicle_type_id: true,
        vehicle_type_title: true,
        occupancy: true,
        status: true,
      },
    });

    return { data: created };
  }

  async update(id: number, dto: UpdateVehicleTypeDto, userId: number) {
    const existing = await this.prisma.dvi_vehicle_type.findFirst({
      where: { vehicle_type_id: id, deleted: 0 },
      select: { vehicle_type_id: true, status: true },
    });
    if (!existing) throw new NotFoundException("Vehicle Type not found");

    const title = pickTitle(dto);
    const occupancy = pickOccupancy(dto);

    const hasTitleOrOccupancy = title !== undefined || occupancy !== undefined;
    const hasOnlyStatusToggle =
      !hasTitleOrOccupancy && Object.prototype.hasOwnProperty.call(dto, "status");

 // PHP has a dedicated updatestatus action that toggles.
    if (hasOnlyStatusToggle) {
      const current = to01(dto.status);
      const next = current === 1 ? 0 : 1;

      const updated = await this.prisma.dvi_vehicle_type.update({
        where: { vehicle_type_id: id },
        data: {
          status: next,
          createdby: userId ?? 0, // PHP often overwrites createdby on edits
          updatedon: new Date(),
        },
        select: {
          vehicle_type_id: true,
          vehicle_type_title: true,
          occupancy: true,
          status: true,
        },
      });

      return { data: updated };
    }

 // PHP edit path: updates title/occupancy and forces status=1
    const updated = await this.prisma.dvi_vehicle_type.update({
      where: { vehicle_type_id: id },
      data: {
        ...(title !== undefined ? { vehicle_type_title: title } : {}),
        ...(occupancy !== undefined ? { occupancy } : {}),
        status: 1,
        createdby: userId ?? 0,
        updatedon: new Date(),
      },
      select: {
        vehicle_type_id: true,
        vehicle_type_title: true,
        occupancy: true,
        status: true,
      },
    });

    return { data: updated };
  }

 /**
   * Mirrors PHP delete cascade 1:1:
   * - soft delete on dvi_vehicle_type
   * - then hard deletes across related tables (including vendor_vehicle_type_ID mapping)
 */
  async remove(id: number) {
    const existing = await this.prisma.dvi_vehicle_type.findFirst({
      where: { vehicle_type_id: id, deleted: 0 },
      select: { vehicle_type_id: true },
    });
    if (!existing) throw new NotFoundException("Vehicle Type not found");

    await this.prisma.$transaction(async (tx) => {
 // soft delete main record
      await tx.dvi_vehicle_type.update({
        where: { vehicle_type_id: id },
        data: { deleted: 1, updatedon: new Date() },
      });

 // find vehicles for this type and delete their gallery rows
      const vehicles = await tx.dvi_vehicle.findMany({
        where: { vehicle_type_id: id, deleted: 0 },
        select: { vehicle_id: true },
      });

      const vehicleIds = vehicles.map((v) => v.vehicle_id).filter(Boolean) as number[];
      if (vehicleIds.length) {
        await tx.dvi_vehicle_gallery_details.deleteMany({
          where: { vehicle_id: { in: vehicleIds } },
        });
      }

 // delete hotspot parking charges + toll charges for this vehicle type
      await tx.dvi_hotspot_vehicle_parking_charges.deleteMany({
        where: { vehicle_type_id: id },
      });

      await tx.dvi_vehicle_toll_charges.deleteMany({
        where: { vehicle_type_id: id },
      });

 // vendor vehicle types for this vehicle_type_id
      const vendorTypes = await tx.dvi_vendor_vehicle_types.findMany({
        where: { vehicle_type_id: id, deleted: 0 },
        select: { vendor_vehicle_type_ID: true },
      });

 // For each vendor_vehicle_type_ID, PHP deletes multiple tables using that ID
      for (const vt of vendorTypes) {
        const vendorVehicleTypeId = vt.vendor_vehicle_type_ID;

        await tx.dvi_vehicle_outstation_price_book.deleteMany({
 // NOTE: PHP uses vehicle_type_id column for vendor_vehicle_type_ID value
          where: { vehicle_type_id: vendorVehicleTypeId },
        });

        await tx.dvi_vehicle_local_pricebook.deleteMany({
 // NOTE: PHP uses vehicle_type_id column for vendor_vehicle_type_ID value
          where: { vehicle_type_id: vendorVehicleTypeId },
        });

        await tx.dvi_time_limit.deleteMany({
          where: { vendor_vehicle_type_id: vendorVehicleTypeId },
        });

        await tx.dvi_kms_limit.deleteMany({
          where: { vendor_vehicle_type_id: vendorVehicleTypeId },
        });

        await tx.dvi_permit_cost.deleteMany({
 // NOTE: PHP uses vehicle_type_id column for vendor_vehicle_type_ID value
          where: { vehicle_type_id: vendorVehicleTypeId },
        });

 // NOTE: PHP also deletes vehicles where vehicle_type_id == vendor_vehicle_type_ID
        await tx.dvi_vehicle.deleteMany({
          where: { vehicle_type_id: vendorVehicleTypeId },
        });
      }

 // finally remove vendor vehicle types rows for this vehicle type
      await tx.dvi_vendor_vehicle_types.deleteMany({
        where: { vehicle_type_id: id },
      });
    });

    return { success: true };
  }
}

