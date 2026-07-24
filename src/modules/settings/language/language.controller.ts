// FILE: src/modules/language/language.controller.ts

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { LanguageService } from './language.service';
import { CreateLanguageDto, UpdateLanguageDto } from './dto/language.dto';

@ApiTags('languages')
@ApiBearerAuth()
@Controller('languages')
export class LanguageController {
  constructor(private readonly languageService: LanguageService) {}

 /**
   * GET /languages
   * Used by languageService.list()
 */
  @Get()
  async getAll() {
 // Returns array React normalizes to LanguageRow[]
    return this.languageService.findAll();
  }

 /**
   * GET /languages/:id
   * (Optional – useful for dedicated edit screens)
 */
  @Get(':id')
  async getOne(@Param('id', ParseIntPipe) id: number) {
    return this.languageService.findOne(id);
  }

 /**
   * POST /languages
   * Used by languageService.create()
   *
   * Body: { language: string, status?: boolean }
 */
  @Post()
  async create(@Body() dto: CreateLanguageDto) {
 // TODO: Replace 1 with req.user.id once auth is wired
    const createdByUserId = 1;
    const row = await this.languageService.create(dto, createdByUserId);

 // React expects either row or { data: row }.
 // We'll send row directly.
    return row;
  }

 /**
   * PUT /languages/:id
   * Used by languageService.update(id, payload)
   *
   * Body: { language?: string, status?: boolean }
 */
  @Put(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateLanguageDto,
  ) {
    const row = await this.languageService.update(id, dto);
    return row;
  }

 /**
   * DELETE /languages/:id
   * Used by languageService.remove(id)
   *
   * Soft delete: sets deleted = true
 */
  @Delete(':id')
  async delete(@Param('id', ParseIntPipe) id: number) {
    const row = await this.languageService.softDelete(id);
    return {
      success: true,
      id: row.language_id,
    };
  }
}
