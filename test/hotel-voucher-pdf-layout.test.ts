import assert from 'node:assert/strict';
import test from 'node:test';
import PDFDocument from 'pdfkit';
import { ItineraryPdfService } from '../src/modules/itineraries/itinerary-pdf.service';

test('hotel voucher separates wrapped labels and fits each row in both voucher scopes', async (t) => {
  const hotelName = 'Grand Bay Resort and Spa';
  const location = 'Mahabalipuram';
  const longLocation = 'Mahabalipuram Beach Resort District, Chengalpattu District, Tamil Nadu, India';
  const longRooms = ['Deluxe Twin', 'Grande Studio', 'Premium Double', 'Family Suite'];
  const groups = [
    {
      hotelName: hotelName.toUpperCase(), destinations: [location], dayNumbers: [1, 2],
      routeDates: ['2026-11-26', '2026-11-27'], roomTypes: ['Grande Studio'],
    },
    {
      hotelName: 'Harbour Hotel', hotelStateCity: longLocation, dayNumbers: [3, 4, 5, 6],
      routeDates: ['2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01'],
      roomTypeQuantities: longRooms.map(roomType => ({ roomType, roomCount: 1 })),
      confirmedBy: 'Test Contact', confirmedEmail: 'supplier.test@example.com', voucherCount: 1,
    },
  ];
  const service = new ItineraryPdfService({
    getVoucherDetails: async () => ({
      summary: { quotationNo: 'DVD2026117', shouldShowHotels: true },
      customer: {}, hotelVoucherGroups: groups,
    }),
  } as any, { dvi_global_settings: { findFirst: async () => null } } as any);

  const fields: Array<{ text: string; top: number; bottom: number }> = [];
  const rows: Array<{ top: number; bottom: number }> = [];
  const originalText = PDFDocument.prototype.text;
  const originalRect = PDFDocument.prototype.rect;
  t.mock.method(PDFDocument.prototype, 'text', function (
    this: PDFKit.PDFDocument, value: string, x?: number, y?: number, options?: PDFKit.Mixins.TextOptions,
  ) {
    if (y !== undefined && options?.width) {
      fields.push({ text: value, top: y, bottom: y + this.heightOfString(value, options) });
    }
    return originalText.call(this, value, x, y, options);
  });
  t.mock.method(PDFDocument.prototype, 'rect', function (
    this: PDFKit.PDFDocument, x: number, y: number, width: number, height: number,
  ) {
    if (x === 40 && height >= 58 && width === this.page.width - 80) rows.push({ top: y, bottom: y + height });
    return originalRect.call(this, x, y, width, height);
  });

  for (const scope of ['hotel', 'all'] as const) {
    fields.length = 0;
    rows.length = 0;
    const pdf = await service.createVoucherPdfBuffer(12268, scope);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    const find = (text: string) => {
      const field = fields.find(field => field.text === text);
      assert.ok(field, `Missing rendered field: ${text}`);
      return field;
    };

    const name = find(hotelName.toUpperCase());
    const city = find(location);
    assert.ok(name.bottom < city.top, 'the full wrapped hotel name must finish above the location');
    assert.ok(city.bottom < find('Days 1, 2').top);
    assert.equal(find('26 Nov 2026, 27 Nov 2026').text, '26 Nov 2026, 27 Nov 2026');
    assert.ok(find('Harbour Hotel').bottom < find(longLocation).top);
    assert.ok(find(longLocation).bottom < find('Days 3, 4, 5, 6').top);
    const rooms = find(longRooms.map(room => `1 × ${room}`).join('\n'));
    const contact = find('Confirmed: Test Contact | -- | supplier.test@example.com');
    assert.ok(rooms.bottom < contact.top);
    assert.ok(rows.some(row => row.top <= name.top && city.bottom < row.bottom));
    assert.ok(rows.some(row => row.top <= rooms.top && contact.bottom < row.bottom));
  }
});
