import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';
import { Public } from '../../auth/public.decorator';
import { ConfirmSupplierVoucherDto, OpenSupplierVoucherDto } from './dto/supplier-voucher.dto';
import { SupplierVoucherService } from './services/supplier-voucher.service';

@Controller('supplier-vouchers')
export class SupplierVoucherController {
  constructor(private readonly vouchers: SupplierVoucherService) {}

  @Public()
  @Post('open')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  open(@Body() body: OpenSupplierVoucherDto) {
    return this.vouchers.open(body.token);
  }

  @Public()
  @Post('confirm')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  confirm(@Body() body: ConfirmSupplierVoucherDto) {
    return this.vouchers.confirm(body);
  }
}
