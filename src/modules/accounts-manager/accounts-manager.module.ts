import { Module } from "@nestjs/common";
import { AccountsManagerController } from "./accounts-manager.controller";
import { AccountsManagerService } from "./accounts-manager.service";
import { AccountsComponentSyncService } from "./accounts-component-sync.service";
import { PrismaService } from "../../prisma.service";

@Module({
  controllers: [
    AccountsManagerController,
  ],

  providers: [
    AccountsManagerService,
    AccountsComponentSyncService,
    PrismaService,
  ],

  exports: [
    AccountsManagerService,
    AccountsComponentSyncService,
  ],
})
export class AccountsManagerModule {}
