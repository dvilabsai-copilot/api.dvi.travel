/**
 * Latest Itinerary: Option 2-style downloadable comparison.
 * Receives the already computed source rows from ItineraryExportService.
 * No database writes, price allocation or guessed single/double room rates.
 */
import * as ExcelJS from 'exceljs';

type SourceCell = string | number | Date | null;
type HotelLine = {
  date: SourceCell;
  destination: SourceCell;
  hotel: SourceCell;
  category: SourceCell;
  meal: SourceCell;
  roomCount: number | null;
  ebCount: number | null;
  cwbCount: number | null;
  cnbCount: number | null;
  sale: number | null;
  purchase: number | null;
  profit: number | null;
};
type HotelOption = { number: number; hotels: HotelLine[] };

const PALETTE = {
  navy: 'FF18354B',
  teal: 'FF146C78',
  powder: 'FFE4F2F6',
  input: 'FFEDF5FF',
  profit: 'FFE5F1E4',
  border: 'FFD9E2E6',
  blue: 'FF226CC7',
  white: 'FFFFFFFF',
  dark: 'FF172B3A',
};
const HOTEL_COLUMNS = [
  'Date', 'Destination', 'Hotel name', 'Room category', 'Particulars',
  'Single', 'Double', 'EB', 'CWB', 'CNB', 'Hotel nett', 'Meal plan',
];

const sourceText = (value: ExcelJS.CellValue): string => {
  if (value == null) return '';
  if (typeof value === 'object') {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if ('text' in value && typeof value.text === 'string') return value.text;
    return '';
  }
  return String(value).trim();
};
const numeric = (value: ExcelJS.CellValue): number | null => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const smallBorder = (): Partial<ExcelJS.Borders> => ({
  bottom: { style: 'hair', color: { argb: PALETTE.border } },
  right: { style: 'hair', color: { argb: PALETTE.border } },
});
const solidFill = (argb: string): ExcelJS.Fill => ({
  type: 'pattern', pattern: 'solid', fgColor: { argb },
});
const formatRow = (
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
  bg: string,
  color = PALETTE.dark,
  bold = false,
) => {
  const row = sheet.getRow(rowNumber);
  row.height = 21;
  for (let col = 1; col <= 12; col++) {
    const cell = row.getCell(col);
    cell.fill = solidFill(bg);
    cell.font = { name: 'Calibri', size: 10, color: { argb: color }, bold };
    cell.border = smallBorder();
    cell.alignment = {
      vertical: 'middle', horizontal: col >= 6 && col <= 11 ? 'right' : 'left',
      wrapText: true,
    };
  }
};
const setNumeric = (sheet: ExcelJS.Worksheet, row: number, col: number, val: number | null, isPercent = false) => {
  const cell = sheet.getRow(row).getCell(col);
  if (val === null) return; // Missing source is NOT zero.
  cell.value = val;
  cell.numFmt = isPercent ? '0.00%' : '#,##0.00;[Red](#,##0.00);0.00';
};

/**
 * Build a styled Option 2-like workbook from the unchanged internal export.
 * Uses price totals the backend has already computed; unavailable Single/Double
 * quantity and per-room pricing breakdowns are deliberately left blank.
 */
export function buildOption2StyleExport(
  workbook: ExcelJS.Workbook,
  horizontalSource: ExcelJS.Worksheet,
  quoteId: string,
): boolean {
  const options: HotelOption[] = [];
  let active: HotelOption | null = null;
  horizontalSource.eachRow((row) => {
    const first = sourceText(row.getCell(1).value);
    if (/^Hotel Recommendation\s*-\s*\d+/i.test(first)) {
      active = { number: options.length + 1, hotels: [] };
      options.push(active);
      return;
    }
    // Hotel-only reference formatting: never rebuild the vehicle section here.
    // The original vehicle rows are preserved by the legacy Worksheet exporter.
    if (/^Vehicle Type\s*:/i.test(first)) {
      active = null;
      return;
    }
    if (!active) return;
    const hotelName = sourceText(row.getCell(3).value);
    const date = sourceText(row.getCell(1).value);
    const roomCategory = sourceText(row.getCell(4).value);
    if (!date || !hotelName || !roomCategory || date === 'Day' || hotelName === 'Hotel & Category') return;
    // HotelPricingService.hotel() uses a legacy naming convention:
    // pricing.sales = supplier/purchase amount, pricing.cost = that amount
    // plus hotel margin and separate margin GST. The horizontal export writes
    // col19=pricing.cost, col20=pricing.sales, col17=margin, col18=marginGst.
    // The Option 2 reference explicitly EXCLUDES separate margin GST from
    // Sale nett. Therefore sale nett = purchase + stored margin.
    const purchase = numeric(row.getCell(20).value);
    const profit = numeric(row.getCell(17).value);
    const inclusiveSelling = numeric(row.getCell(19).value);
    const marginGst = numeric(row.getCell(18).value);
    const round2 = (num: number) => Math.round((num + Number.EPSILON) * 100) / 100;
    const sale = purchase !== null && profit !== null
      ? round2(purchase + profit)
      : inclusiveSelling !== null && marginGst !== null
        ? round2(inclusiveSelling - marginGst)
        : null;
    if (purchase === null && sale === null && profit === null) return;
    const fromValue = (col: number): SourceCell => {
      const value = row.getCell(col).value;
      if (value instanceof Date || typeof value === 'string' || typeof value === 'number') return value;
      return null;
    };
    active.hotels.push({
      date: fromValue(1), destination: fromValue(2), hotel: fromValue(3),
      category: fromValue(4), meal: fromValue(5),
      roomCount: numeric(row.getCell(6).value),
      ebCount: numeric(row.getCell(7).value),
      // Existing source writes col8 CNB and col9 CWB, regardless of headers.
      cwbCount: numeric(row.getCell(9).value),
      cnbCount: numeric(row.getCell(8).value),
      sale, purchase, profit,
    });
  });

  // Vehicle-only quotations keep the original workbook unchanged.
  if (!options.length) return false;
  for (const opt of options) {
    const sheet = workbook.addWorksheet(`Option ${opt.number}`);
    sheet.views = [{ state: 'normal', zoomScale: 85, zoomScaleNormal: 85, showGridLines: false }];
    sheet.pageSetup = {
      paperSize: 8 as ExcelJS.PaperSize, // A3, landscape, 12-column table fits one page wide.
      orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    };
    sheet.pageSetup.margins = { left: 0.22, right: 0.22, top: 0.32, bottom: 0.32, header: 0.14, footer: 0.14 };
    sheet.columns = [
      { width: 17 }, { width: 24 }, { width: 25 }, { width: 23 },
      { width: 20 }, { width: 13 }, { width: 13 }, { width: 11 },
      { width: 11 }, { width: 11 }, { width: 16 }, { width: 16 },
    ];
    sheet.mergeCells('A1:L1');
    sheet.getCell('A1').value = `DVI.travel | OPTION ${String(opt.number).padStart(2, '0')} — HOTEL COSTING`;
    formatRow(sheet, 1, PALETTE.navy, PALETTE.white, true);
    sheet.getRow(1).height = 29;
    sheet.mergeCells('A2:L2');
    sheet.getCell('A2').value = 'Blue cells = source amounts  •  INR  •  Margin % = profit / purchase  •  Missing room-type breakdowns are not estimated';
    formatRow(sheet, 2, PALETTE.white);
    sheet.getCell('A3').value = 'Vendor slot';
    sheet.getCell('B3').value = opt.number;
    sheet.getCell('B3').fill = solidFill(PALETTE.input);
    sheet.getCell('C3').value = 'Selected vendor:';
    sheet.getCell('D3').value = '';
    sheet.getCell('F3').value = 'Quote ID:';
    sheet.getCell('G3').value = quoteId;
    sheet.getRow(3).height = 21;
    sheet.mergeCells('A5:L5');
    sheet.getCell('A5').value = '01  DAILY HOTEL COSTING';
    formatRow(sheet, 5, PALETTE.teal, PALETTE.white, true);
    sheet.getRow(5).height = 28;
    sheet.getRow(6).values = HOTEL_COLUMNS;
    formatRow(sheet, 6, PALETTE.navy, PALETTE.white, true);
    sheet.getRow(6).height = 31;

    for (const hotel of opt.hotels) {
      const start = sheet.lastRow!.number + 1;
      const date = hotel.date;
      const dateVal = date instanceof Date ? date : sourceText(date);
      sheet.getRow(start).values = [
        dateVal, hotel.destination, hotel.hotel, hotel.category,
        hotel.roomCount !== null ? `Quantity (${hotel.roomCount} ${hotel.roomCount === 1 ? 'room' : 'rooms'})` : 'Quantity',
        null, null, hotel.ebCount, hotel.cwbCount, hotel.cnbCount, null, hotel.meal,
      ];
      // Hotel cells A-L exactly match the twelve reference headers; no leading empty offset.
      formatRow(sheet, start, PALETTE.powder, PALETTE.blue);
      sheet.getRow(start).height = 36; // Make wrapped destinations and hotel names legible.
      const entries: Array<{ name: string; value: number | null; colour: string; percent?: boolean }> = [
        { name: 'Sale', value: hotel.sale, colour: PALETTE.white },
        { name: 'Purchase', value: hotel.purchase, colour: PALETTE.white },
        { name: 'Profit', value: hotel.profit, colour: PALETTE.profit },
        { name: 'Margin %', value: hotel.profit !== null && hotel.purchase && hotel.purchase !== 0 ? hotel.profit / hotel.purchase : null, colour: PALETTE.white, percent: true },
      ];
      for (let i = 0; i < entries.length; i++) {
        const r = start + i + 1;
        sheet.getCell(`E${r}`).value = entries[i].name;
        formatRow(sheet, r, entries[i].colour);
        if (entries[i].name === 'Sale' || entries[i].name === 'Purchase') {
          for (let c = 6; c <= 10; c++) sheet.getRow(r).getCell(c).fill = solidFill(PALETTE.input);
        }
        setNumeric(sheet, r, 11, entries[i].value, Boolean(entries[i].percent));
        if (entries[i].name === 'Sale' || entries[i].name === 'Purchase') {
          sheet.getCell(`K${r}`).font = { name: 'Calibri', size: 10, color: { argb: PALETTE.blue } };
        }
      }
    }
    if (!opt.hotels.length) {
      sheet.mergeCells('A7:L7');
      sheet.getCell('A7').value = 'No hotel recommendation was available for this quotation.';
      formatRow(sheet, 7, PALETTE.white);
    }
    sheet.pageSetup.printTitlesRow = '1:6';
  }

  // Vehicle rows are intentionally not formatted by this helper.
  // The service appends its unchanged legacy Worksheet for those details.
  return true;
}
