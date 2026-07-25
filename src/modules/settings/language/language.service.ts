// FILE: src/modules/language/language.service.ts

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { CreateLanguageDto, UpdateLanguageDto } from './dto/language.dto';

@Injectable()
export class LanguageService {
  constructor(private readonly prisma: PrismaService) {}

 /**
   * Convert boolean/number to 0 or 1 for DB (create).
   * Default for create = 1 (active) if not specified.
 */
  private statusForCreate(input?: boolean | number | null): number {
    if (input === null || input === undefined) return 1;
    if (typeof input === 'boolean') return input ? 1 : 0;
    if (typeof input === 'number') return input ? 1 : 0;
    return 1;
  }

 /**
   * Convert boolean/number to 0 or 1 for DB (update).
   * Default for update = keep existing DB status if not specified.
 */
  private statusForUpdate(
    existingStatus: number,
    input?: boolean | number | null,
  ): number {
    if (input === null || input === undefined) return existingStatus;
    if (typeof input === 'boolean') return input ? 1 : 0;
    if (typeof input === 'number') return input ? 1 : 0;
    return existingStatus;
  }

 /**
   * Mirrors __JSONlanguage.php:
   * - Only non-deleted rows (deleted = 0)
   * - Sorted by language_id DESC
   * - Returns shape that your React service can normalize
 */
  async findAll() {
    const rows = await this.prisma.dvi_language.findMany({
      where: {
        deleted: false,
      },
      orderBy: {
        language_id: 'desc',
      },
    });

    return rows.map((row, index) => ({
 // Your frontend normalizes id via r.id || r.language_id etc.
      id: row.language_id,
      language_id: row.language_id,
      language: row.language ?? '',
 status: row.status, // frontend will convert 0/1 boolean
      count: index + 1,
    }));
  }

 /**
   * Mirrors edit-prefill from __ajax_add_language_form.php
 */
  async findOne(id: number) {
    const row = await this.prisma.dvi_language.findFirst({
      where: {
        language_id: id,
        deleted: false,
      },
    });

    if (!row) {
      throw new NotFoundException(`Language with id ${id} not found`);
    }

    return row;
  }

 /**
   * Create new language
   * Mirrors INSERT part of __ajax_manage_language.php?type=add
 */
  async create(dto: CreateLanguageDto, createdByUserId = 1) {
    const now = new Date();
    const statusInt = this.statusForCreate(dto.status);

 // PHP uses ucwords()
    const languageTitle = this.ucwords(dto.language.trim());

    const row = await this.prisma.dvi_language.create({
      data: {
        language: languageTitle,
        createdby: createdByUserId,
        createdon: now,
        updatedon: now,
        status: statusInt,
        deleted: false,
      },
    });

    return row;
  }

 /**
   * Update existing language
   * Mirrors UPDATE part of __ajax_manage_language.php?type=add
   * (when old_language has value)
 */
  async update(id: number, dto: UpdateLanguageDto) {
    const existing = await this.prisma.dvi_language.findFirst({
      where: {
        language_id: id,
        deleted: false,
      },
    });

    if (!existing) {
      throw new NotFoundException(`Language with id ${id} not found`);
    }

    const now = new Date();

    const statusInt = this.statusForUpdate(existing.status, dto.status);

 // PHP uses ucwords()
    const languageTitle =
      typeof dto.language === 'string'
        ? this.ucwords(dto.language.trim())
        : existing.language;

    const row = await this.prisma.dvi_language.update({
      where: { language_id: id },
      data: {
        language: languageTitle,
        status: statusInt,
        updatedon: now,
      },
    });

    return row;
  }

 /**
   * Soft delete – mirrors __ajax_manage_language.php?type=delete
   * NOTE: In PHP, there is a "used in guides" check before delete.
 */
  async softDelete(id: number) {
    const existing = await this.prisma.dvi_language.findFirst({
      where: {
        language_id: id,
        deleted: false,
      },
    });

    if (!existing) {
      throw new NotFoundException(`Language with id ${id} not found`);
    }

 // Parity check: used in guides (FIND_IN_SET)
 // guide_language_proficiency is a comma-separated string of IDs
    const usageCount: any[] = await this.prisma.$queryRaw`
      SELECT COUNT(guide_id) as count
      FROM dvi_guide_details
      WHERE FIND_IN_SET(${id.toString()}, guide_language_proficiency)
      AND deleted = 0
    `;

    const count = Number(usageCount[0]?.count || 0);

    if (count > 0) {
      throw new Error(
        'Sorry !!! You cannot delete this record. Since its assigned to specific guide with proficiency.',
      );
    }

    const now = new Date();

    const row = await this.prisma.dvi_language.update({
      where: { language_id: id },
      data: {
        deleted: true,
        updatedon: now,
      },
    });

    return row;
  }

  private ucwords(str: string): string {
    return str
      .toLowerCase()
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
}
