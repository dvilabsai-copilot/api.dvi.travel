// FILE: src/modules/accounts-ledger/accounts-ledger.module.ts
import { Module } from "@nestjs/common";
import { AccountsLedgerController } from "./accounts-ledger.controller";
import { AccountsLedgerService } from "./accounts-ledger.service";
import { PrismaService } from "../../prisma.service";
import { AccountsManagerModule } from "../accounts-manager/accounts-manager.module";

@Module({
  imports: [
    AccountsManagerModule,
  ],

  controllers: [
    AccountsLedgerController,
  ],

  providers: [
    AccountsLedgerService,
    PrismaService,
  ],

  exports: [
    AccountsLedgerService,
  ],
})
export class AccountsLedgerModule {}
