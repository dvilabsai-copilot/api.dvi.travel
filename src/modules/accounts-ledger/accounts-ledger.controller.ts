// FILE: src/modules/accounts-ledger/accounts-ledger.controller.ts

import {
  Controller,
  ForbiddenException,
  Get,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AccountsLedgerService } from './accounts-ledger.service';
import {
  AccountsLedgerComponentType,
  AccountsLedgerQueryDto,
} from './dto/accounts-ledger-query.dto';
import { AccountsLedgerOptionsDto } from './dto/accounts-ledger-options.dto';

@ApiTags('Accounts Ledger')
@ApiBearerAuth() // uses default bearer auth from main.ts
@Controller('accounts-ledger')
export class AccountsLedgerController {
  constructor(private readonly service: AccountsLedgerService) {}

  private applyLoggedInVendorScope(
    query: AccountsLedgerQueryDto,
    req: any,
  ): AccountsLedgerQueryDto {
   const roleId = Number(
  req?.user?.roleID ??
  req?.user?.roleId ??
  req?.user?.role ??
  0,
);

    if (roleId !== 2) {
      return query;
    }

   const vendorId = Number(
  req?.user?.vendorId ??
  req?.user?.vendor_id ??
  0,
);

    if (
      !Number.isInteger(vendorId) ||
      vendorId <= 0
    ) {
      throw new ForbiddenException(
        'Vendor account is not linked to a valid vendor',
      );
    }

    return {
      ...query,

      // Vendor Accounts always belongs to vehicle/vendor ledger.
      componentType:
        AccountsLedgerComponentType.VEHICLE,

      // IMPORTANT:
      // Never trust vendorId supplied from the browser.
      vendorId,
    };
  }

  @Get()
  @ApiQuery({ name: 'quoteId', required: false })
  @ApiQuery({
    name: 'componentType',
    enum: AccountsLedgerComponentType,
    required: true,
  })
  @ApiQuery({ name: 'fromDate', required: false, description: 'DD/MM/YYYY' })
  @ApiQuery({ name: 'toDate', required: false, description: 'DD/MM/YYYY' })
  @ApiQuery({ name: 'guideId', required: false, type: Number })
  @ApiQuery({ name: 'hotelId', required: false, type: Number })
  @ApiQuery({ name: 'activityId', required: false, type: Number })
  @ApiQuery({ name: 'hotspotId', required: false, type: Number })
  @ApiQuery({ name: 'vendorId', required: false, type: Number })
  @ApiQuery({ name: 'agentId', required: false, type: Number })
async getLedger(
  @Query() query: AccountsLedgerQueryDto,
  @Req() req: Request,
): Promise<any[]> {
  const scopedQuery = this.applyLoggedInVendorScope(
    query,
    req,
  );

  return this.service.getLedger(scopedQuery);
}
  @Get('options')
  @ApiQuery({
    name: 'componentType',
    enum: AccountsLedgerComponentType,
    required: false,
  })
  @ApiQuery({ name: 'fromDate', required: false, description: 'DD/MM/YYYY' })
  @ApiQuery({ name: 'toDate', required: false, description: 'DD/MM/YYYY' })
async getFilterOptions(
  @Query() query: AccountsLedgerQueryDto,
  @Req() req: Request,
): Promise<AccountsLedgerOptionsDto> {
  const scopedQuery = this.applyLoggedInVendorScope(
    query,
    req,
  );

  return this.service.getFilterOptions(scopedQuery);
}
}
