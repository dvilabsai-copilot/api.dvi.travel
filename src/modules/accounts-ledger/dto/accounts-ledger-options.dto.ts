// FILE: src/modules/accounts-ledger/dto/accounts-ledger-options.dto.ts

export class AccountsLedgerOptionDto {
  id!: number;
  label!: string;
}

export class AccountsLedgerOptionsDto {
  agents!: AccountsLedgerOptionDto[];
  vehicleBranches!: AccountsLedgerOptionDto[];
  vehicles!: AccountsLedgerOptionDto[];
  vendors!: AccountsLedgerOptionDto[];
  guides!: AccountsLedgerOptionDto[];
  hotspots!: AccountsLedgerOptionDto[];
  activities!: AccountsLedgerOptionDto[];
  hotels!: AccountsLedgerOptionDto[];
}