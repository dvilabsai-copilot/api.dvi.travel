// FILE: src/modules/hotel-category/hotel-category.controller.ts

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HotelCategoryService } from './hotel-category.service';
import { CreateHotelCategoryDto } from './dto/create-hotel-category.dto';
import { UpdateHotelCategoryDto } from './dto/update-hotel-category.dto';
import { CheckHotelCategoryCodeDto } from './dto/check-hotel-category-code.dto';
import { CheckHotelCategoryTitleDto } from './dto/check-hotel-category-title.dto';

@ApiTags('hotel-categories')
@ApiBearerAuth()
@Controller('hotel-categories')
export class HotelCategoryController {
  constructor(private readonly hotelCategoryService: HotelCategoryService) {}

 /**
   * List hotel categories (PHP: __JSONhotelcategory.php)
   * - Returns all categories with deleted = 0, ordered by id DESC.
 */
  @Get()
  async findAll() {
    const items = await this.hotelCategoryService.findAll();

 // If you want DataTables-like shape, you could add draw/count here.
 // For now, return plain rows React can map to whatever you need.
    return items;
  }

 /**
   * Get single hotel category details (PHP: __ajax_add_hotelcategory.php in EDIT mode)
 */
  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.hotelCategoryService.findOne(id);
  }

 /**
   * Create a new hotel category (PHP: INSERT branch of __ajax_manage_hotelcategory.php?type=add)
 */
  @Post()
  async create(@Body() dto: CreateHotelCategoryDto, @Req() req: any) {
 // [Inference] standard JWT pattern: req.user.id
    const userId = req?.user?.id ?? 0;
    return this.hotelCategoryService.create(dto, userId);
  }

 /**
   * Update an existing hotel category (PHP: UPDATE branch of __ajax_manage_hotelcategory.php?type=add)
 */
  @Put(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateHotelCategoryDto,
  ) {
    return this.hotelCategoryService.update(id, dto);
  }

 /**
   * Toggle status (active/inactive)
   * - PHP: __ajax_manage_hotelcategory.php?type=updatestatus
   * - In PHP they passed STATUS_ID and toggled.
   *   Here, we just toggle based on current DB value.
 */
  @Patch(':id/status')
  async toggleStatus(@Param('id', ParseIntPipe) id: number) {
    return this.hotelCategoryService.toggleStatus(id);
  }

 /**
   * Soft delete with dependency check (PHP: __ajax_manage_hotelcategory.php?type=delete)
 */
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.hotelCategoryService.softDelete(id);
    return { success: true };
  }

 /**
   * Duplicate code check (PHP: __ajax_check_hotelcategory_code.php)
   *
   * Example request body:
   * { "code": "STD", "excludeId": 123 }
 */
  @Post('check-code')
  async checkCode(@Body() dto: CheckHotelCategoryCodeDto) {
    return this.hotelCategoryService.isCodeUnique(dto.code.trim(), dto.excludeId);
  }

 /**
   * Duplicate title check (PHP: __ajax_check_hotelcategory_title.php)
   *
   * Example request body:
   * { "title": "3 Star", "excludeId": 123 }
 */
  @Post('check-title')
  async checkTitle(@Body() dto: CheckHotelCategoryTitleDto) {
    return this.hotelCategoryService.isTitleUnique(dto.title.trim(), dto.excludeId);
  }
}
