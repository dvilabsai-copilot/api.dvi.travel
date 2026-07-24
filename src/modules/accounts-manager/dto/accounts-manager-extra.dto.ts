// FILE: src/modules/accounts-manager/dto/accounts-manager-extra.dto.ts

import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
} from "class-validator";
import { AccountsManagerRowComponentType } from "./accounts-manager-row.dto";

/**
 * Returned by GET /accounts-manager/summary
 */
export class AccountsManagerSummaryDto {
 totalPayable!: number; // sum of total_payable across all visible rows
 totalPaid!: number; // sum of total_paid across all visible rows
 totalBalance!: number; // sum of total_balance across all visible rows
 rowCount!: number; // number of component rows included in totals
}

/**
 * Returned by GET /accounts-manager/quotes
 */
export class AccountsManagerQuoteDto {
  quoteId!: string;
}

/**
 * Returned by GET /accounts-manager/agents
 */
export class AccountsManagerAgentDto {
  id!: number;
  name!: string;
}

/**
 * Returned by GET /accounts-manager/payment-modes
 *
 * Legacy mapping (PHP):
 *   1 => Cash
 *   2 => UPI
 *   3 => Net Banking
 *
 * Your service can return:
 *   [{ id: 1, label: "Cash" }, { id: 2, label: "UPI" }, { id: 3, label: "Net Banking" }]
 */
export class AccountsManagerPaymentModeDto {
  @IsInt()
  @Min(1)
  id!: number;

  @IsString()
  label!: string;
}

/**
 * Payload for POST /accounts-manager/pay
 *
 * This version updates only the per-component totals
 * (total_paid, total_balance) on the accounts detail tables.
 * It does NOT store a separate payments ledger row – you can extend
 * it later if you have a dedicated payments table.
 */
export class AccountsManagerPayDto {
  @IsIn(["guide", "hotspot", "activity", "hotel", "vehicle"])
  componentType!: AccountsManagerRowComponentType;

  @IsInt()
  @Min(1)
  accountsItineraryDetailsId!: number;

  @IsInt()
  @Min(1)
  componentDetailId!: number;

  @IsOptional()
  @IsString()
  routeDate?: string;

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsOptional()
  @IsInt()
  modeOfPaymentId?: number;

  @IsOptional()
  @IsString()
  utrNumber?: string;

  @IsOptional()
  @IsString()
  processedBy?: string;

 /**
   * Optional storage for the uploaded payment screenshot path / filename.
   * Frontend is not required to send this yet, so it won't break anything.
 */
  @IsOptional()
  @IsString()
  paymentScreenshotPath?: string;
}
