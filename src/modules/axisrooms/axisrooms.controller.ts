import { Controller, Post, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { AxisRoomsService } from './axisrooms.service';
import { AxisRoomsApiKeyGuard } from './guards/axisrooms-api-key.guard';
import { Public } from '../../auth/public.decorator';
import {
  ProductInfoRequestDto,
  ProductInfoResponseDto,
} from './dto/product-info.dto';
import {
  RatePlanInfoRequestDto,
  RatePlanInfoResponseDto,
} from './dto/rate-plan-info.dto';
import {
  InventoryUpdateRequestDto,
  InventoryUpdateResponseDto,
} from './dto/inventory-update.dto';
import {
  RateUpdateRequestDto,
  RateUpdateResponseDto,
} from './dto/rate-update.dto';
import {
  RestrictionUpdateRequestDto,
  RestrictionUpdateResponseDto,
} from './dto/restriction-update.dto';

@Controller('axisrooms')
@Public() // Skip JWT auth - AxisRooms uses its own API key auth
@UseGuards(AxisRoomsApiKeyGuard)
export class AxisRoomsController {
  constructor(private readonly axisRoomsService: AxisRoomsService) {}

  @Post('productInfo')
  @HttpCode(HttpStatus.OK)
  async productInfo(
    @Body() dto: ProductInfoRequestDto,
  ): Promise<ProductInfoResponseDto> {
    return this.axisRoomsService.getProductInfo(dto);
  }

  @Post('ratePlanInfo')
  @HttpCode(HttpStatus.OK)
  async ratePlanInfo(
    @Body() dto: RatePlanInfoRequestDto,
  ): Promise<RatePlanInfoResponseDto> {
    return this.axisRoomsService.getRatePlanInfo(dto);
  }

  @Post('inventoryUpdate')
  @HttpCode(HttpStatus.OK)
  async inventoryUpdate(
    @Body() dto: InventoryUpdateRequestDto,
  ): Promise<InventoryUpdateResponseDto> {
    return this.axisRoomsService.updateInventory(dto);
  }

  @Post('rateUpdate')
  @HttpCode(HttpStatus.OK)
  async rateUpdate(
    @Body() dto: RateUpdateRequestDto,
  ): Promise<RateUpdateResponseDto> {
    return this.axisRoomsService.updateRate(dto);
  }

  @Post('restrictionUpdate')
  @HttpCode(HttpStatus.OK)
  async restrictionUpdate(
    @Body() dto: RestrictionUpdateRequestDto,
  ): Promise<RestrictionUpdateResponseDto> {
    return this.axisRoomsService.updateRestriction(dto);
  }
}
