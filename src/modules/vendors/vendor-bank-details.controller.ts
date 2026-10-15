
import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { VendorBankDetailsService } from './vendor-bank-details.service';

@ApiTags('Vendor Bank Details')
@ApiBearerAuth()
@Controller('vendor-bank-details')
export class VendorBankDetailsController {
  constructor(
    private readonly bankService: VendorBankDetailsService,
  ) {}

  
  @Get('me')
  getMyVendor(@Req() req: any) {
    return this.bankService.getMyVendor(req);
  }

  @Get(':vendorId')
  getStatus(

    @Param('vendorId', ParseIntPipe) vendorId: number,
    @Req() req: any,
  ) {
    return this.bankService.getStatus(vendorId, req);
  }

  @Post(':vendorId/requests')
  submit(
    @Param('vendorId', ParseIntPipe) vendorId: number,
    @Body() body: any,
    @Req() req: any,
  ) {
    return this.bankService.submit(vendorId, body, req);
  }

  @Post('requests/:requestId/approve')
  approve(
    @Param('requestId', ParseIntPipe) requestId: number,
    @Req() req: any,
  ) {
    return this.bankService.approve(requestId, req);
  }

  @Post('requests/:requestId/reject')
  reject(
    @Param('requestId', ParseIntPipe) requestId: number,
    @Body() body: { reason?: string },
    @Req() req: any,
  ) {
    return this.bankService.reject(
      requestId,
      body?.reason,
      req,
    );
  }
}
