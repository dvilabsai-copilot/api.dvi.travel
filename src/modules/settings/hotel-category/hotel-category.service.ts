// FILE: src/modules/hotel-category/hotel-category.service.ts

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, dvi_hotel_category } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';
import { CreateHotelCategoryDto } from './dto/create-hotel-category.dto';
import { UpdateHotelCategoryDto } from './dto/update-hotel-category.dto';

@Injectable()
export class HotelCategoryService {
  constructor(private readonly prisma: PrismaService) {}

 /**
   * PHP parity of __JSONhotelcategory.php:
   * - only rows where deleted = 0
   * - ordered by hotel_category_id DESC
 */
  async findAll(): Promise<dvi_hotel_category[]> {
    return this.prisma.dvi_hotel_category.findMany({
      where: { deleted: 0 },
      orderBy: { hotel_category_id: 'desc' },
    });
  }

  async findOne(id: number): Promise<dvi_hotel_category> {
    const category = await this.prisma.dvi_hotel_category.findUnique({
      where: { hotel_category_id: id },
    });

    if (!category || category.deleted === 1) {
      throw new NotFoundException('Hotel category not found.');
    }

    return category;
  }

 /**
   * Create new category (PHP: INSERT branch of __ajax_manage_hotelcategory.php?type=add)
 */
  async create(dto: CreateHotelCategoryDto, userId: number): Promise<dvi_hotel_category> {
    const title = dto.title?.trim();
    const code = dto.code?.trim();

    await this.ensureCodeUnique(code);
    await this.ensureTitleUnique(title);

    const data: Prisma.dvi_hotel_categoryCreateInput = {
      hotel_category_title: title,
      hotel_category_code: code,
      createdby: userId ?? 0,
 status: dto.status 1, // PHP always sets status = 1 on insert
 // createdon / updatedon are left to DB defaults or remain null,
 // just like PHP did via sqlACTIONS().
    };

    return this.prisma.dvi_hotel_category.create({ data });
  }

 /**
   * Update existing category (PHP: UPDATE branch of __ajax_manage_hotelcategory.php?type=add)
 */
  async update(id: number, dto: UpdateHotelCategoryDto): Promise<dvi_hotel_category> {
 const existing = await this.findOne(id); // ensures NotFound if missing

    const data: Prisma.dvi_hotel_categoryUpdateInput = {};

    if (dto.title !== undefined) {
      const title = dto.title.trim();
      await this.ensureTitleUnique(title, id);
      data.hotel_category_title = title;
    }

    if (dto.code !== undefined) {
      const code = dto.code.trim();
      await this.ensureCodeUnique(code, id);
      data.hotel_category_code = code;
    }

    if (dto.status !== undefined) {
      data.status = dto.status;
    }

 // PHP did not explicitly update updatedon for normal updates,
 // so we keep parity and don't touch that here.

    return this.prisma.dvi_hotel_category.update({
      where: { hotel_category_id: existing.hotel_category_id },
      data,
    });
  }

 /**
   * Toggle status (PHP: __ajax_manage_hotelcategory.php?type=updatestatus)
   * - If status = 0 → 1
   * - Else → 0
 */
  async toggleStatus(id: number): Promise<dvi_hotel_category> {
    const existing = await this.findOne(id);

    const newStatus = existing.status === 0 ? 1 : 0;

    return this.prisma.dvi_hotel_category.update({
      where: { hotel_category_id: id },
      data: { status: newStatus },
    });
  }

 /**
   * Soft delete with dependency check (PHP: __ajax_manage_hotelcategory.php?type=delete)
   *
   * [Inference] Assumes:
   * - you have a Prisma model `dvi_hotel`
   * - with fields: hotel_category_id, status, deleted
   * Adjust these names if your schema differs.
 */
async softDelete(id: number): Promise<void> {
  const existing = await this.findOne(id);

 // 1. check dependency in dvi_hotel
  const usageCount = await this.prisma.dvi_hotel.count({
    where: {
 // keep these names exactly as in your dvi_hotel model
      hotel_category: existing.hotel_category_id,
 status: 1, // if status is also boolean in your model, change to: status: true
 deleted: false, // FIX: Prisma expects boolean here, not number 0
    },
  });

  if (usageCount > 0) {
    throw new BadRequestException(
      'Cannot delete this hotel category because it is used by active hotels.',
    );
  }

 // 2. soft delete the category (deleted = 1, updatedon = NOW)
  await this.prisma.dvi_hotel_category.update({
    where: { hotel_category_id: existing.hotel_category_id },
    data: {
 deleted: 1, // Int in dvi_hotel_category model, so 1 is fine here
      updatedon: new Date(),
    },
  });
}

 /**
   * Code uniqueness check
   * - Equivalent to __ajax_check_hotelcategory_code.php
 */
  async ensureCodeUnique(code: string, excludeId?: number): Promise<void> {
    if (!code) return;

    const existing = await this.prisma.dvi_hotel_category.findFirst({
      where: {
        hotel_category_code: code,
        deleted: 0,
        ...(excludeId
          ? {
              hotel_category_id: { not: excludeId },
            }
          : {}),
      },
    });

    if (existing) {
      throw new BadRequestException('Hotel category code already exists.');
    }
  }

 /**
   * Title uniqueness check
   * - Equivalent to __ajax_check_hotelcategory_title.php
 */
  async ensureTitleUnique(title: string, excludeId?: number): Promise<void> {
    if (!title) return;

    const existing = await this.prisma.dvi_hotel_category.findFirst({
      where: {
        hotel_category_title: title,
        deleted: 0,
        ...(excludeId
          ? {
              hotel_category_id: { not: excludeId },
            }
          : {}),
      },
    });

    if (existing) {
      throw new BadRequestException('Hotel category title already exists.');
    }
  }

 /**
   * Convenience methods for the /check-code and /check-title endpoints,
   * returning boolean instead of throwing.
 */
  async isCodeUnique(code: string, excludeId?: number): Promise<{ unique: boolean }> {
    const existing = await this.prisma.dvi_hotel_category.findFirst({
      where: {
        hotel_category_code: code,
        deleted: 0,
        ...(excludeId ? { hotel_category_id: { not: excludeId } } : {}),
      },
    });

    return { unique: !existing };
  }

  async isTitleUnique(title: string, excludeId?: number): Promise<{ unique: boolean }> {
    const existing = await this.prisma.dvi_hotel_category.findFirst({
      where: {
        hotel_category_title: title,
        deleted: 0,
        ...(excludeId ? { hotel_category_id: { not: excludeId } } : {}),
      },
    });

    return { unique: !existing };
  }
}
