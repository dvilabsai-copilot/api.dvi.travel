// FILE: src/modules/inbuilt-amenities/inbuilt-amenities.controller.ts

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { InbuiltAmenitiesService } from "./inbuilt-amenities.service";
import { CreateInbuiltAmenityDto } from "./dto/create-inbuilt-amenity.dto";
import { UpdateInbuiltAmenityDto } from "./dto/update-inbuilt-amenity.dto";

@ApiTags("inbuilt-amenities")
@ApiBearerAuth()
@Controller("inbuilt-amenities")
export class InbuiltAmenitiesController {
  constructor(private readonly service: InbuiltAmenitiesService) {}

  private getUserId(req: Request): number {
 // If your project attaches req.user, we use it. Otherwise default 0 (safe).
    const anyReq = req as any;
    return Number(anyReq?.user?.id ?? anyReq?.user?.userId ?? 0) || 0;
  }

  @Get()
  list() {
    return this.service.list();
  }

  @Get(":id")
  getOne(@Param("id", ParseIntPipe) id: number) {
    return this.service.getOne(id);
  }

  @Post()
  create(@Body() dto: CreateInbuiltAmenityDto, @Req() req: Request) {
    const userId = this.getUserId(req);
    return this.service.create(dto, userId);
  }

  @Put(":id")
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateInbuiltAmenityDto,
    @Req() req: Request
  ) {
    const userId = this.getUserId(req);
    return this.service.update(id, dto, userId);
  }

  @Delete(":id")
  async remove(@Param("id", ParseIntPipe) id: number) {
    await this.service.remove(id);
 // Your frontend delete() expects void, so return nothing.
    return;
  }
}
