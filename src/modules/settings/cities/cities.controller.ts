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
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CitiesService } from "./cities.service";
import { ListCitiesQueryDto } from "./dto/list-cities.query.dto";
import { CreateCityDto } from "./dto/create-city.dto";
import { UpdateCityDto } from "./dto/update-city.dto";
import { SuggestCitiesDto } from "./dto/suggest-cities.dto";
import { CheckCityDuplicateDto } from "./dto/check-city.dto";

@ApiTags("cities")
@ApiBearerAuth()
@Controller("cities")
export class CitiesController {
  constructor(private readonly service: CitiesService) {}

 // GET /cities/states?countryId=101
  @Get("states")
  listStates(@Query() q: ListCitiesQueryDto) {
    return this.service.listStates(q.countryId ?? 101);
  }

 // NEW: GET /cities/by-state/:stateId
 // Fetch cities only for a specific state_id
  @Get("by-state/:stateId")
  listByState(@Param("stateId", ParseIntPipe) stateId: number) {
    return this.service.listByState(stateId);
  }

 // (Keep your existing endpoints)
  @Get()
  list(@Query() q: ListCitiesQueryDto) {
    return this.service.list(q.countryId ?? 101);
  }

@Get("by-country")
listByCountry(@Query() q: ListCitiesQueryDto) {
  return this.service.listByCountry(q.countryId ?? 101, q);
}

  @Post("suggest")
  suggest(@Body() dto: SuggestCitiesDto) {
    return this.service.suggest(dto);
  }

  @Post("check-duplicate")
  checkDuplicate(@Body() dto: CheckCityDuplicateDto) {
    return this.service.checkDuplicate(dto);
  }

  @Get(":id/delete-usage")
  deleteUsage(@Param("id", ParseIntPipe) id: number) {
    return this.service.getDeleteUsageCount(id);
  }

  @Get(":id")
  getOne(@Param("id", ParseIntPipe) id: number) {
    return this.service.getOne(id);
  }

  @Post()
  create(@Body() dto: CreateCityDto) {
    return this.service.create(dto);
  }

  @Put(":id")
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateCityDto) {
    return this.service.update(id, dto);
  }

  @Delete(":id")
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.service.softDelete(id);
  }
}
