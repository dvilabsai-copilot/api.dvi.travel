import { Controller, Post, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { Public } from '../../auth/public.decorator';
import { StaahService } from './staah.service';
import { StaahApiKeyGuard } from './guards/staah-api-key.guard';
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
import {
  ReservationRequestDto,
  ReservationAckDto,
  ReservationTrackingDto,
} from './dto/reservation.dto';
import {
  ModifyReservationRequestDto,
  ModifyReservationResponseDto,
} from './dto/modify-reservation.dto';
import {
  CancelReservationRequestDto,
  CancelReservationResponseDto,
} from './dto/cancel-reservation.dto';
import { ArrInfoRequestDto, ArrInfoResponseDto } from './dto/arr-info.dto';
import { YearInfoArrRequestDto, YearInfoArrResponseDto } from './dto/year-info-arr.dto';

@Controller('staah')
@Public()
@UseGuards(StaahApiKeyGuard)
export class StaahController {
  constructor(private readonly staahService: StaahService) {}

  @Post('productInfo')
  @HttpCode(HttpStatus.OK)
  async productInfo(
    @Body() dto: ProductInfoRequestDto,
  ): Promise<ProductInfoResponseDto> {
    return this.staahService.getProductInfo(dto);
  }

  @Post('ratePlanInfo')
  @HttpCode(HttpStatus.OK)
  async ratePlanInfo(
    @Body() dto: RatePlanInfoRequestDto,
  ): Promise<RatePlanInfoResponseDto> {
    return this.staahService.getRatePlanInfo(dto);
  }

  @Post('inventoryUpdate')
  @HttpCode(HttpStatus.OK)
  async inventoryUpdate(
    @Body() dto: InventoryUpdateRequestDto,
  ): Promise<InventoryUpdateResponseDto> {
    return this.staahService.inventoryUpdate(dto);
  }

  @Post('rateUpdate')
  @HttpCode(HttpStatus.OK)
  async rateUpdate(
    @Body() dto: RateUpdateRequestDto,
  ): Promise<RateUpdateResponseDto> {
    return this.staahService.rateUpdate(dto);
  }

  @Post('restrictionUpdate')
  @HttpCode(HttpStatus.OK)
  async restrictionUpdate(
    @Body() dto: RestrictionUpdateRequestDto,
  ): Promise<RestrictionUpdateResponseDto> {
    return this.staahService.restrictionUpdate(dto);
  }

  @Post('reservation')
  @HttpCode(HttpStatus.OK)
  async reservation(
    @Body() dto: ReservationRequestDto,
  ): Promise<Array<ReservationAckDto | ReservationTrackingDto>> {
    return this.staahService.receiveReservation(dto);
  }

    /**
     * ADAPTER/CUSTOM EXTENSION — NOT a confirmed official STAAH v2 operation.
     * Kept for local business flow (payload logging/storage only).
     * Do NOT document as an official STAAH contract in Excel or certification forms.
     */
    @Post('modifyReservation')
    @HttpCode(HttpStatus.OK)
    async modifyReservation(
      @Body() dto: ModifyReservationRequestDto,
    ): Promise<ModifyReservationResponseDto> {
      return this.staahService.modifyReservation(dto);
    }

    /**
     * ADAPTER/CUSTOM EXTENSION — NOT a confirmed official STAAH v2 operation.
     * Kept for local business flow (payload logging/storage only).
     * Do NOT document as an official STAAH contract in Excel or certification forms.
     */
    @Post('cancelReservation')
    @HttpCode(HttpStatus.OK)
    async cancelReservation(
      @Body() dto: CancelReservationRequestDto,
    ): Promise<CancelReservationResponseDto> {
      return this.staahService.cancelReservation(dto);
    }

    /**
     * ADAPTER ENDPOINT — exposes STAAH v2 doc-native ARR_info pull contract.
     * Route path is our internal adapter name; request body matches STAAH v2 doc exactly.
     * Response format is adapter-defined (from our stored DB records).
     */
    @Post('arrInfo')
    @HttpCode(HttpStatus.OK)
    async arrInfo(
      @Body() dto: ArrInfoRequestDto,
    ): Promise<ArrInfoResponseDto> {
      return this.staahService.getArrInfo(dto);
    }

    /**
     * ADAPTER ENDPOINT — exposes STAAH v2 doc-native year_info_ARR full-year pull contract.
     * Route path is our internal adapter name; request body matches STAAH v2 doc exactly.
     * Response format is adapter-defined (from our stored DB records).
     */
    @Post('yearInfoArr')
    @HttpCode(HttpStatus.OK)
    async yearInfoArr(
      @Body() dto: YearInfoArrRequestDto,
    ): Promise<YearInfoArrResponseDto> {
      return this.staahService.getYearInfoArr(dto);
    }
}
