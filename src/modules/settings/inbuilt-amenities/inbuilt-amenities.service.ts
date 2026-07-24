import { Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../../../prisma.service";
import { CreateInbuiltAmenityDto } from "./dto/create-inbuilt-amenity.dto";
import { UpdateInbuiltAmenityDto } from "./dto/update-inbuilt-amenity.dto";

type AmenityRow = {
  id: number;
  title: string;
  status: 0 | 1;
};

@Injectable()
export class InbuiltAmenitiesService {
  constructor(private readonly prisma: PrismaService) {}

  private toRow(db: any): AmenityRow {
    return {
      id: Number(db.inbuilt_amenity_type_id),
      title: String(db.inbuilt_amenity_title ?? "").trim(),
      status: (Number(db.status) === 1 ? 1 : 0) as 0 | 1,
    };
  }

  async list(): Promise<AmenityRow[]> {
    const rows = await this.prisma.dvi_inbuilt_amenities.findMany({
      where: { deleted: 0 },
      orderBy: { inbuilt_amenity_type_id: "desc" },
      select: {
        inbuilt_amenity_type_id: true,
        inbuilt_amenity_title: true,
        status: true,
      },
    });

    return rows.map((r) => this.toRow(r));
  }

  async getOne(id: number): Promise<AmenityRow> {
    const row = await this.prisma.dvi_inbuilt_amenities.findFirst({
      where: { inbuilt_amenity_type_id: id, deleted: 0 },
      select: {
        inbuilt_amenity_type_id: true,
        inbuilt_amenity_title: true,
        status: true,
      },
    });

    if (!row) throw new NotFoundException("Inbuilt amenity not found");
    return this.toRow(row);
  }

 /**
   * PHP parity:
   * - Always inserts status=1
   * - Writes createdby = logged_user_id
 */
  async create(dto: CreateInbuiltAmenityDto, userId = 0): Promise<AmenityRow> {
    const title = String(dto.title ?? "").trim();
    if (!title) throw new BadRequestException("title is required");

    const created = await this.prisma.dvi_inbuilt_amenities.create({
      data: {
        inbuilt_amenity_title: title,
        createdby: Number(userId) || 0,
 status: 1, // PHP hardcodes "1"
        deleted: 0,
      },
      select: {
        inbuilt_amenity_type_id: true,
        inbuilt_amenity_title: true,
        status: true,
      },
    });

    return this.toRow(created);
  }

 /**
   * ✅ FIXED update behavior for modern API:
   * - If dto.status is provided, it is treated as the FINAL status (0|1) to store.
   *   (NOT "current status to flip")
   * - If dto.title is provided, update title and (PHP parity) force status=1.
   * - Supports title-only, status-only, and title+status (title wins parity logic).
 */
  async update(id: number, dto: UpdateInbuiltAmenityDto, userId = 0): Promise<AmenityRow> {
    const existing = await this.prisma.dvi_inbuilt_amenities.findFirst({
      where: { inbuilt_amenity_type_id: id, deleted: 0 },
      select: {
        inbuilt_amenity_type_id: true,
      },
    });

    if (!existing) throw new NotFoundException("Inbuilt amenity not found");

 // CASE 1: Title update (keep PHP parity: set status=1 and overwrite createdby)
    if (dto.title !== undefined) {
      const title = String(dto.title ?? "").trim();
      if (!title) throw new BadRequestException("title is required");

      const updated = await this.prisma.dvi_inbuilt_amenities.update({
        where: { inbuilt_amenity_type_id: id },
        data: {
          inbuilt_amenity_title: title,
          createdby: Number(userId) || 0,
 status: 1, // PHP parity on edit/add
        },
        select: {
          inbuilt_amenity_type_id: true,
          inbuilt_amenity_title: true,
          status: true,
        },
      });

      return this.toRow(updated);
    }

 // CASE 2: Status update (store FINAL status directly)
    if (dto.status !== undefined) {
      const nextStatus = (Number(dto.status) === 1 ? 1 : 0) as 0 | 1;

      const updated = await this.prisma.dvi_inbuilt_amenities.update({
        where: { inbuilt_amenity_type_id: id },
        data: { status: nextStatus },
        select: {
          inbuilt_amenity_type_id: true,
          inbuilt_amenity_title: true,
          status: true,
        },
      });

      return this.toRow(updated);
    }

    throw new BadRequestException("Nothing to update");
  }

 /**
   * PHP parity:
   * confirmdelete => deleted=1, updatedon=NOW() WHERE id
 */
  async remove(id: number): Promise<{ result: true }> {
    const existing = await this.prisma.dvi_inbuilt_amenities.findFirst({
      where: { inbuilt_amenity_type_id: id, deleted: 0 },
      select: { inbuilt_amenity_type_id: true },
    });

    if (!existing) throw new NotFoundException("Inbuilt amenity not found");

    await this.prisma.dvi_inbuilt_amenities.update({
      where: { inbuilt_amenity_type_id: id },
      data: {
        deleted: 1,
        updatedon: new Date(),
      },
    });

    return { result: true };
  }
}
