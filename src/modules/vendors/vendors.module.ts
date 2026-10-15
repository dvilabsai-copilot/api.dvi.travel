import { Module } from '@nestjs/common';
import { VendorsController } from './vendors.controller';
import { VendorsDropdownsController } from './vendors.controller';
import { VendorsService } from './vendors.service';
import { PrismaService } from '../../prisma.service';

import { VendorBankDetailsController } from './vendor-bank-details.controller';
import { VendorBankDetailsService } from './vendor-bank-details.service';

@Module({
  controllers: [
    VendorsController,
    VendorsDropdownsController,
    VendorBankDetailsController,
  ],
  providers: [
    VendorsService,
    PrismaService,
    VendorBankDetailsService,
  ],
  exports: [VendorsService],
})
export class VendorsModule {}
