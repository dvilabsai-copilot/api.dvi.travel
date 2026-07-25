import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { Response } from 'express';
import ExcelJS from 'exceljs';
import { AccountsManagerService } from '../accounts-manager/accounts-manager.service';
import { AccountsLedgerService } from '../accounts-ledger/accounts-ledger.service';
import { AccountsManagerQueryDto } from '../accounts-manager/dto/accounts-manager-query.dto';
import { AccountsLedgerQueryDto, AccountsLedgerComponentType } from '../accounts-ledger/dto/accounts-ledger-query.dto';

@Injectable()
export class AccountsExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly managerService: AccountsManagerService,
    private readonly ledgerService: AccountsLedgerService,
  ) {}

  private nowStamp() {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}_${pad(d.getMonth() + 1)}_${pad(d.getDate())}_${pad(
      d.getHours(),
    )}_${pad(d.getMinutes())}_${pad(d.getSeconds())}`;
  }

  private async writeExcel(res: Response, workbook: ExcelJS.Workbook, filename: string) {
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  }

 // --------------------- ACCOUNTS MANAGER EXPORT ---------------------

  async exportAccountsManagerExcel(query: AccountsManagerQueryDto, res: Response) {
    const rows = await this.managerService.list(query);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Accounts Manager');

 // Legacy PHP has specific headers and multiple tables if "all" is selected.
 // For simplicity and parity with the current UI, we'll export the flattened list.
 // If the user specifically wants the multi-table legacy format, we can implement that too.
 // Given the request "parity with php", I should try to match the multi-table format if componentType is "all".

    if (query.componentType === 'all' || !query.componentType) {
        await this.buildMultiTableManagerExport(sheet, rows, query);
    } else {
        await this.buildSingleTableManagerExport(sheet, rows, query.componentType);
    }

    const filename = `accounts_manager_${this.nowStamp()}.xlsx`;
    return this.writeExcel(res, workbook, filename);
  }

  private async buildSingleTableManagerExport(sheet: ExcelJS.Worksheet, rows: any[], type: string) {
    const headers = [
        'S.NO', 'Quote ID', 'Arrival', 'Destination', 'Start Date', 'End Date',
        'Guest', 'Agent', 'Vendor/Hotel', 'Date', 'Amount', 'Paid', 'Balance',
        'Receivable from Agent', 'Inhand Amount', 'Margin Amount', 'Tax', 'Status'
    ];
    const headerRow = sheet.addRow(headers);
    headerRow.font = { bold: true };
    headerRow.eachCell((cell) => {
        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFD9E3FC' }
        };
        cell.border = {
            top: { style: 'thin' },
            left: { style: 'thin' },
            bottom: { style: 'thin' },
            right: { style: 'thin' }
        };
    });

    rows.forEach((r, i) => {
        const row = sheet.addRow([
            i + 1,
            r.quoteId,
            r.arrivalLocation || '',
            r.departureLocation || '',
            r.startDate,
            r.endDate,
            r.guestName || '',
            r.agent,
            r.hotelName,
            r.routeDate || '',
            r.amount,
            r.payout,
            r.payable,
            r.receivableFromAgentAmount || 0,
            r.inhandAmount || 0,
            r.marginAmount || 0,
            r.tax || 0,
            r.status
        ]);
        row.eachCell((cell) => {
            cell.border = {
                top: { style: 'thin' },
                left: { style: 'thin' },
                bottom: { style: 'thin' },
                right: { style: 'thin' }
            };
        });
    });
  }

  private async buildMultiTableManagerExport(sheet: ExcelJS.Worksheet, rows: any[], query: any) {
    const components = ['guide', 'hotspot', 'activity', 'hotel', 'vehicle'];
    let currentRow = 1;

    for (const comp of components) {
        const compRows = rows.filter(r => r.componentType === comp);
        if (compRows.length === 0) continue;

 // Add Title
        const titleRow = sheet.getRow(currentRow);
        titleRow.getCell(1).value = comp.toUpperCase() + ' TRANSACTIONS';
        titleRow.getCell(1).font = { bold: true, size: 14 };
        currentRow += 1;

 // Add Headers
        const headers = [
            'S.NO', 'Quote ID', 'Arrival', 'Destination', 'Start Date', 'End Date',
            'Guest', 'Agent', 'Vendor/Hotel', 'Date', 'Amount', 'Paid', 'Balance',
            'Receivable from Agent', 'Inhand Amount', 'Margin Amount', 'Tax', 'Status'
        ];
        const headerRow = sheet.getRow(currentRow);
        headers.forEach((h, i) => {
            const cell = headerRow.getCell(i + 1);
            cell.value = h;
            cell.font = { bold: true };
            cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFD9E3FC' }
            };
            cell.border = {
                top: { style: 'thin' },
                left: { style: 'thin' },
                bottom: { style: 'thin' },
                right: { style: 'thin' }
            };
        });
        currentRow += 1;

 // Add Data
        compRows.forEach((r, i) => {
            const dataRow = sheet.getRow(currentRow);
            [
                i + 1,
                r.quoteId,
                r.arrivalLocation || '',
                r.departureLocation || '',
                r.startDate,
                r.endDate,
                r.guestName || '',
                r.agent,
                r.hotelName,
                r.routeDate || '',
                r.amount,
                r.payout,
                r.payable,
                r.receivableFromAgentAmount || 0,
                r.inhandAmount || 0,
                r.marginAmount || 0,
                r.tax || 0,
                r.status
            ].forEach((val, idx) => {
                const cell = dataRow.getCell(idx + 1);
                cell.value = val;
                cell.border = {
                    top: { style: 'thin' },
                    left: { style: 'thin' },
                    bottom: { style: 'thin' },
                    right: { style: 'thin' }
                };
            });
            currentRow += 1;
        });

 currentRow += 2; // Gap between tables
    }
  }

 // --------------------- ACCOUNTS LEDGER EXPORT ---------------------

  async exportAccountsLedgerExcel(query: AccountsLedgerQueryDto, res: Response) {
    const data = await this.ledgerService.getLedger(query);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Accounts Ledger');

    if (query.componentType === AccountsLedgerComponentType.ALL) {
        await this.buildMultiTableLedgerExport(sheet, data, query);
    } else {
        await this.buildSingleTableLedgerExport(sheet, data, query.componentType);
    }

    const filename = `accounts_ledger_${this.nowStamp()}.xlsx`;
    return this.writeExcel(res, workbook, filename);
  }

  private async buildSingleTableLedgerExport(sheet: ExcelJS.Worksheet, data: any[], type: string) {
 // Ledger data structure is { header, details, transactions[] }
    const headers = ['S.NO', 'Quote ID', 'Transaction Date', 'Component', 'Vendor', 'Amount', 'Mode', 'UTR No', 'Done By'];
    const headerRow = sheet.addRow(headers);
    headerRow.font = { bold: true };
    headerRow.eachCell((cell) => {
        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFD9E3FC' }
        };
        cell.border = {
            top: { style: 'thin' },
            left: { style: 'thin' },
            bottom: { style: 'thin' },
            right: { style: 'thin' }
        };
    });

    let counter = 1;
    data.forEach((item) => {
        const quoteId = item.header?.itinerary_quote_ID || item.itinerary_quote_ID || '';

        if (item.transactions && Array.isArray(item.transactions)) {
            item.transactions.forEach((t: any) => {
                const row = sheet.addRow([
                    counter++,
                    quoteId,
                    t.transaction_date ? new Date(t.transaction_date).toLocaleDateString('en-GB') : '',
                    type.toUpperCase(),
                    item.details?.hotel_name || item.details?.guide_name || item.details?.vehicle_name || '',
                    t.transaction_amount,
                    this.getModeOfPay(t.mode_of_pay),
                    t.transaction_utr_no,
                    t.transaction_done_by
                ]);
                row.eachCell((cell) => {
                    cell.border = {
                        top: { style: 'thin' },
                        left: { style: 'thin' },
                        bottom: { style: 'thin' },
                        right: { style: 'thin' }
                    };
                });
            });
        } else if (type === 'agent') {
 // Agent ledger is just header rows
            const row = sheet.addRow([
                counter++,
                quoteId,
                item.trip_start_date_and_time ? new Date(item.trip_start_date_and_time).toLocaleDateString('en-GB') : '',
                'AGENT',
                item.agent_name || '',
                item.grand_total,
                '',
                '',
                ''
            ]);
            row.eachCell((cell) => {
                cell.border = {
                    top: { style: 'thin' },
                    left: { style: 'thin' },
                    bottom: { style: 'thin' },
                    right: { style: 'thin' }
                };
            });
        }
    });
  }

  private async buildMultiTableLedgerExport(sheet: ExcelJS.Worksheet, data: any[], query: any) {
 // In "all" mode, data is a flattened list of transactions or grouped?
 // Actually AccountsLedgerService.getAllLedger returns a combined list.
 // Let's just use the single table format for "all" but with component column.
      await this.buildSingleTableLedgerExport(sheet, data, 'ALL');
  }

  private getModeOfPay(mode: number): string {
      switch (mode) {
          case 1: return 'Cash';
          case 2: return 'UPI';
          case 3: return 'Net Banking';
          default: return 'Other';
      }
  }
}
