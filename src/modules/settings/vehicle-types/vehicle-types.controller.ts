import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { VehicleTypesService } from "./vehicle-types.service";
import { CreateVehicleTypeDto } from "./dto/create-vehicle-type.dto";
import { UpdateVehicleTypeDto } from "./dto/update-vehicle-type.dto";

function resolveUserId(req: any): number {
 // supports different auth payload shapes
  return Number(req?.user?.user_id ?? req?.user?.id ?? req?.user?.ID ?? 0) || 0;
}

@ApiTags("vehicle-types")
@ApiBearerAuth()
@Controller("vehicle-types")
export class VehicleTypesController {
  constructor(private readonly service: VehicleTypesService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get("check-title")
  checkTitle(
    @Query("title") title: string,
    @Query("excludeId") excludeId?: string,
    @Query("oldTitle") oldTitle?: string,
  ) {
    const ex = excludeId ? Number(excludeId) : undefined;
    return this.service.checkTitle(title, ex, oldTitle);
  }

  @Get(":id")
  getOne(@Param("id", ParseIntPipe) id: number) {
    return this.service.getOne(id);
  }

  @Post()
  create(@Body() dto: CreateVehicleTypeDto, @Req() req: any) {
    return this.service.create(dto, resolveUserId(req));
  }

  @Put(":id")
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateVehicleTypeDto,
    @Req() req: any,
  ) {
    return this.service.update(id, dto, resolveUserId(req));
  }

  @Delete(":id")
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
