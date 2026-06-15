import { Injectable } from '@nestjs/common';
import { Response } from 'express';
import PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';
import { ItinerariesService } from './itineraries.service';
import { PrismaService } from '../../prisma.service';

@Injectable()
export class ItineraryPdfService {
  constructor(
    private readonly itinerariesService: ItinerariesService,
    private readonly prisma: PrismaService,
  ) {}

  private normalizeCurrency(value: any): string {
    return Number(value || 0).toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  private formatDate(value?: string | Date | null): string {
    if (!value) return '--';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '--';
    return date.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }

  private formatDateTime(value?: string | Date | null): string {
    if (!value) return '--';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '--';
    return date.toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private sanitizeFileName(value: string): string {
    return String(value || 'document')
      .replace(/[^\w.-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private amountToWords(amount: any): string {
    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
      'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

    const convertBelowThousand = (n: number): string => {
      let result = '';
      if (n >= 100) {
        result += `${ones[Math.floor(n / 100)]} Hundred `;
        n %= 100;
      }
      if (n >= 20) {
        result += `${tens[Math.floor(n / 10)]} `;
        n %= 10;
      }
      if (n > 0) {
        result += `${ones[n]} `;
      }
      return result.trim();
    };

    const numericAmount = Number(amount || 0);
    const integerPart = Math.floor(numericAmount);
    const paise = Math.round((numericAmount - integerPart) * 100);
    if (integerPart === 0) return 'Zero Rupees Only';

    const crore = Math.floor(integerPart / 10000000);
    const lakh = Math.floor((integerPart % 10000000) / 100000);
    const thousand = Math.floor((integerPart % 100000) / 1000);
    const hundred = integerPart % 1000;

    const parts: string[] = [];
    if (crore) parts.push(`${convertBelowThousand(crore)} Crore`);
    if (lakh) parts.push(`${convertBelowThousand(lakh)} Lakh`);
    if (thousand) parts.push(`${convertBelowThousand(thousand)} Thousand`);
    if (hundred) parts.push(convertBelowThousand(hundred));

    return `${parts.join(' ').trim()} Rupees${paise ? ` and ${convertBelowThousand(paise)} Paise` : ''} Only`;
  }

  private resolveBackendRoot(): string {
    const candidate = path.resolve(__dirname, '../../..');
    return fs.existsSync(path.join(candidate, 'package.json')) ? candidate : process.cwd();
  }

  private resolveLogoPath(raw?: string | null): string | null {
    const normalized = String(raw || '').trim();
    if (!normalized || /^https?:\/\//i.test(normalized)) {
      return null;
    }

    const relative = normalized.replace(/^\/+/, '');
    const absolute = path.join(this.resolveBackendRoot(), 'public', relative.replace(/^uploads[\\/]/, 'uploads/'));
    return fs.existsSync(absolute) ? absolute : null;
  }

  private drawLabelValue(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    label: string,
    value: string,
    width: number,
  ) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#7A6A8D').text(label, x, y, { width });
    doc.font('Helvetica').fontSize(10).fillColor('#2F2A36').text(value || '--', x, y + 12, { width });
  }

  private drawRule(doc: PDFKit.PDFDocument, y?: number) {
    const lineY = y ?? doc.y;
    doc
      .moveTo(40, lineY)
      .lineTo(doc.page.width - 40, lineY)
      .lineWidth(1)
      .strokeColor('#E7DFF0')
      .stroke();
  }

  private drawSectionBand(doc: PDFKit.PDFDocument, title: string, y: number) {
    doc.roundedRect(40, y, doc.page.width - 80, 24, 8).fillAndStroke('#F7F1FF', '#E7DFF0');
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#6E46A3').text(title, 52, y + 7);
  }

  private drawVoucherBrandHeader(
    doc: PDFKit.PDFDocument,
    brand: { companyName: string; address: string; logoUrl: string; contactNo: string; email: string },
    title: string,
    quoteId: string,
  ) {
    doc.roundedRect(30, 30, doc.page.width - 60, 92, 18).fillAndStroke('#FFFDF9', '#E7D9C4');

    const logoPath = this.resolveLogoPath(brand.logoUrl);
    if (logoPath) {
      try {
        doc.image(logoPath, 42, 42, { fit: [92, 50] });
      } catch {
        // Ignore image rendering failures and keep PDF generation successful.
      }
    }

    doc.fillColor('#3F3654').font('Helvetica-Bold').fontSize(18).text(title, 148, 42);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#7B58A9').text(brand.companyName || 'DVI', 148, 64, {
      width: 220,
    });
    doc.font('Helvetica').fontSize(9).fillColor('#6A6077').text(brand.address || '--', 148, 82, {
      width: 230,
    });

    doc.roundedRect(398, 42, 150, 54, 12).fillAndStroke('#FFFFFF', '#EADFF3');
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#8A6AB0').text('BOOKING ID', 410, 54);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#3F3654').text(quoteId || '--', 410, 70, { width: 120 });

    doc.font('Helvetica').fontSize(8).fillColor('#6A6077').text(
      [brand.contactNo, brand.email].filter(Boolean).join(' | '),
      398,
      102,
      { width: 150, align: 'right' },
    );
  }

  private addPageIfNeeded(doc: PDFKit.PDFDocument, nextBlockHeight = 40) {
    if (doc.y + nextBlockHeight > doc.page.height - 60) {
      doc.addPage();
    }
  }

  private createPdfResponse(res: Response, filename: string): PDFKit.PDFDocument {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      compress: true,
    });
    doc.pipe(res);
    return doc;
  }

  async downloadPluckCardPdf(itineraryPlanId: number, res: Response) {
    const data: any = await this.itinerariesService.getPluckCardData(itineraryPlanId);
    const safeName = this.sanitizeFileName(`pluck-card-${data?.guestName || itineraryPlanId}.pdf`);
    const doc = this.createPdfResponse(res, safeName);

    doc.roundedRect(24, 24, doc.page.width - 48, doc.page.height - 48, 28).fillAndStroke('#FFFDF6', '#E7D9C4');

    const logoPath = this.resolveLogoPath(data?.companyLogoUrl);
    if (logoPath) {
      try {
        doc.image(logoPath, 380, 48, { fit: [150, 60], align: 'right' });
      } catch {
        // Ignore image rendering failures and keep PDF generation successful.
      }
    }

    doc.fillColor('#8A6AB0').font('Helvetica-Bold').fontSize(14).text('ARRIVAL WELCOME CARD', 48, 52);
    doc.fillColor('#3E3050').font('Helvetica-Bold').fontSize(20).text(data?.companyName || 'Doview Holidays India Pvt Ltd', 48, 76);

    doc
      .fillColor('#B98D22')
      .font('Helvetica-Bold')
      .fontSize(24)
      .text('WELCOME', 48, 150, { align: 'center', width: doc.page.width - 96 });
    doc
      .fillColor('#432A57')
      .font('Helvetica-Bold')
      .fontSize(30)
      .text(data?.guestName || '--', 48, 188, { align: 'center', width: doc.page.width - 96 });

    doc.roundedRect(48, 270, 240, 150, 16).fillAndStroke('#FFFFFF', '#EADFF3');
    doc.roundedRect(307, 270, 240, 150, 16).fillAndStroke('#FFFFFF', '#EADFF3');

    doc.fillColor('#8A6AB0').font('Helvetica-Bold').fontSize(12).text('ARRIVAL', 64, 288);
    doc.fillColor('#342B40').font('Helvetica-Bold').fontSize(18).text(data?.arrivalLocation || '--', 64, 314, { width: 200 });
    doc.fillColor('#655B75').font('Helvetica').fontSize(11).text(this.formatDateTime(data?.arrivalDateTime), 64, 350, { width: 200 });
    doc.text(data?.arrivalFlightDetails || '--', 64, 378, { width: 200 });

    doc.fillColor('#8A6AB0').font('Helvetica-Bold').fontSize(12).text('DEPARTURE', 323, 288);
    doc.fillColor('#342B40').font('Helvetica-Bold').fontSize(18).text(data?.departureLocation || '--', 323, 314, { width: 200 });
    doc.fillColor('#655B75').font('Helvetica').fontSize(11).text(this.formatDateTime(data?.departureDateTime), 323, 350, { width: 200 });
    doc.text(data?.departureFlightDetails || '--', 323, 378, { width: 200 });

    doc.roundedRect(48, 460, doc.page.width - 96, 70, 16).fillAndStroke('#FFF9F1', '#E8D7B0');
    doc.fillColor('#8A6AB0').font('Helvetica-Bold').fontSize(11).text('CONTACT NUMBER', 48, 478, {
      align: 'center',
      width: doc.page.width - 96,
    });
    doc.fillColor('#342B40').font('Helvetica-Bold').fontSize(24).text(data?.contactNo || '--', 48, 500, {
      align: 'center',
      width: doc.page.width - 96,
    });

    doc.end();
  }

  async downloadInvoicePdf(
    itineraryPlanId: number,
    type: 'tax' | 'proforma',
    res: Response,
  ) {
    const data: any = await this.itinerariesService.getInvoiceData(itineraryPlanId);
    const invoiceNo = data?.meta?.invoiceNo || `invoice-${itineraryPlanId}`;
    const safeName = this.sanitizeFileName(`${type}-${invoiceNo}.pdf`);
    const doc = this.createPdfResponse(res, safeName);
    const logoPath = this.resolveLogoPath(data?.company?.logoUrl);

    if (logoPath) {
      try {
        doc.image(logoPath, 40, 36, { fit: [110, 48] });
      } catch {
        // Ignore image rendering failures and keep PDF generation successful.
      }
    }

    doc.fillColor('#3F3654').font('Helvetica-Bold').fontSize(18).text(
      type === 'tax' ? 'Tax Invoice' : 'Proforma Invoice',
      40,
      40,
      { align: 'right' },
    );
    doc.font('Helvetica-Bold').fontSize(16).text(data?.company?.name || 'DVI', 40, 92);
    doc.font('Helvetica').fontSize(10).fillColor('#5A5268').text(
      [data?.company?.address, data?.company?.pincode ? `- ${data.company.pincode}` : ''].filter(Boolean).join(' '),
      40,
      112,
      { width: 300 },
    );

    this.drawLabelValue(doc, 360, 92, 'Invoice No', String(data?.meta?.invoiceNo || '--'), 180);
    this.drawLabelValue(doc, 360, 126, 'Dated', this.formatDate(data?.meta?.invoiceDate), 180);
    this.drawLabelValue(doc, 360, 160, 'Travel Expert', String(data?.meta?.travelExpertName || '--'), 180);
    this.drawRule(doc, 202);

    doc.y = 216;
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#8A6AB0').text('Buyer Details', 40, doc.y);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#2F2A36').text(data?.buyer?.companyName || '--', 40, doc.y + 18);
    doc.font('Helvetica').fontSize(10).fillColor('#5A5268').text(data?.buyer?.address || '--', 40, doc.y + 38, { width: 245 });
    doc.text(`GSTIN/UIN: ${data?.buyer?.gstNo || '--'}`, 40, doc.y + 72);
    doc.text(`State: ${data?.buyer?.gstStateName || '--'}`, 40, doc.y + 88);
    doc.text(`PAN: ${data?.buyer?.panNo || '--'}`, 40, doc.y + 104);

    doc.font('Helvetica-Bold').fontSize(12).fillColor('#8A6AB0').text('Guest Details', 320, 216);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#2F2A36').text(data?.guest?.name || '--', 320, 234);
    doc.font('Helvetica').fontSize(10).fillColor('#5A5268').text(`Contact: ${data?.guest?.contactNo || '--'}`, 320, 256);
    doc.text(`Arrival: ${data?.guest?.arrivalPlace || '--'}`, 320, 272);
    doc.text(this.formatDateTime(data?.guest?.arrivalDateTime), 320, 288);
    doc.text(`Departure: ${data?.guest?.departurePlace || '--'}`, 320, 304);
    doc.text(this.formatDateTime(data?.guest?.departureDateTime), 320, 320);

    this.drawRule(doc, 348);

    const tableTop = 362;
    const col1 = 40;
    const col2 = 82;
    const col3 = 380;
    const col4 = 455;

    doc.rect(40, tableTop, doc.page.width - 80, 24).fillAndStroke('#FAF6FF', '#E7DFF0');
    doc.fillColor('#3F3654').font('Helvetica-Bold').fontSize(10);
    doc.text('SI No.', col1 + 6, tableTop + 7);
    doc.text('Particulars', col2 + 6, tableTop + 7);
    doc.text('HSN/SAC', col3 + 6, tableTop + 7);
    doc.text('Amount', col4 + 6, tableTop + 7, { width: 80, align: 'right' });

    let y = tableTop + 28;
    const lineItems = Array.isArray(data?.lineItems) ? data.lineItems : [];
    for (const item of lineItems) {
      const notes = Array.isArray(item?.notes) ? item.notes.map((note: any) => String(note?.label || '')).filter(Boolean) : [];
      const itemText = [String(item?.title || '--'), ...notes].join('\n');
      const rowHeight = Math.max(
        doc.heightOfString(itemText, { width: 285 }),
        16,
      ) + 12;

      this.addPageIfNeeded(doc, rowHeight + 60);
      if (doc.y > y) {
        y = doc.y;
      }

      doc.rect(40, y, doc.page.width - 80, rowHeight).strokeColor('#EFE6F8').stroke();
      doc.font('Helvetica').fontSize(10).fillColor('#2F2A36');
      doc.text(String(item?.serialNo || ''), col1 + 6, y + 6, { width: 28 });
      doc.text(itemText, col2 + 6, y + 6, { width: 285 });
      doc.text(String(item?.hsnSac || '--'), col3 + 6, y + 6, { width: 65 });
      doc.text(this.normalizeCurrency(item?.amount), col4 + 6, y + 6, { width: 74, align: 'right' });
      y += rowHeight;
      doc.y = y;
    }

    if (Number(data?.totals?.couponDiscount || 0) > 0) {
      this.addPageIfNeeded(doc, 40);
      doc.rect(40, y, doc.page.width - 80, 24).strokeColor('#EFE6F8').stroke();
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#7A6A8D');
      doc.text('Coupon Discount', 40, y + 7, { width: 430, align: 'right' });
      doc.text(this.normalizeCurrency(data?.totals?.couponDiscount), col4 + 6, y + 7, { width: 74, align: 'right' });
      y += 24;
    }

    doc.rect(40, y, doc.page.width - 80, 28).fillAndStroke('#FFF8EC', '#E7D9C4');
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#3F3654');
    doc.text('Total Amount', 40, y + 8, { width: 430, align: 'right' });
    doc.text(this.normalizeCurrency(data?.totals?.totalAmount), col4 + 6, y + 8, { width: 74, align: 'right' });
    y += 44;

    this.addPageIfNeeded(doc, 180);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#3F3654').text('Amount Chargeable (in words)', 40, y);
    doc.font('Helvetica').fontSize(10).fillColor('#5A5268').text(
      String(data?.totals?.amountInWords || data?.totals?.amountInWordsText || this.amountToWords(data?.totals?.totalAmount)),
      40,
      y + 16,
      { width: 500 },
    );

    y += 60;
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#3F3654').text('Bank Details', 40, y);
    doc.font('Helvetica').fontSize(10).fillColor('#5A5268');
    doc.text(`Account Name: ${data?.company?.bank?.accountName || '--'}`, 40, y + 16);
    doc.text(`Account Number: ${data?.company?.bank?.accountNo || '--'}`, 40, y + 32);
    doc.text(`Bank Name: ${data?.company?.bank?.bankName || '--'}`, 40, y + 48);
    doc.text(`Branch & IFSC: ${[data?.company?.bank?.branchName, data?.company?.bank?.ifscCode].filter(Boolean).join(', ') || '--'}`, 40, y + 64, {
      width: 280,
    });

    doc.font('Helvetica-Bold').fontSize(11).fillColor('#3F3654').text('Declaration', 330, y);
    doc.font('Helvetica').fontSize(10).fillColor('#5A5268').text(String(data?.declaration || '--'), 330, y + 16, {
      width: 210,
    });

    doc.font('Helvetica').fontSize(10).fillColor('#5A5268').text(`for ${data?.company?.name || 'DVI'}`, 350, doc.page.height - 92);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#3F3654').text('Authorized Signatory', 350, doc.page.height - 54);

    doc.end();
  }

  async downloadVoucherPdf(itineraryPlanId: number, res: Response) {
    return this.downloadVoucherPdfByScope(itineraryPlanId, 'all', res);
  }

  async downloadHotelVoucherPdf(itineraryPlanId: number, res: Response) {
    return this.downloadVoucherPdfByScope(itineraryPlanId, 'hotel', res);
  }

  async downloadVehicleVoucherPdf(itineraryPlanId: number, res: Response) {
    return this.downloadVoucherPdfByScope(itineraryPlanId, 'vehicle', res);
  }

  async downloadVoucherPdfByScope(
    itineraryPlanId: number,
    scope: 'all' | 'hotel' | 'vehicle',
    res: Response,
  ) {
    const data: any = await this.itinerariesService.getVoucherDetails(itineraryPlanId);
    const settings = await this.prisma.dvi_global_settings.findFirst({
      where: { status: 1, deleted: 0 },
    });
    const quoteId = String(data?.summary?.quotationNo || itineraryPlanId);
    const fileName =
      scope === 'hotel'
        ? `hotel-voucher-${quoteId}.pdf`
        : scope === 'vehicle'
          ? `vehicle-voucher-${quoteId}.pdf`
          : `voucher-details-${quoteId}.pdf`;
    const safeName = this.sanitizeFileName(fileName);
    const doc = this.createPdfResponse(res, safeName);

    const brand = {
      companyName: String(settings?.company_name || 'DVI'),
      address: [
        String(settings?.company_address || '').trim(),
        String(settings?.company_pincode || '').trim(),
      ]
        .filter(Boolean)
        .join(' - '),
      logoUrl: settings?.company_logo ? `/uploads/logo/${String(settings.company_logo)}` : '',
      contactNo: String(settings?.company_contact_no || ''),
      email: String(settings?.company_email_id || ''),
    };

    this.drawVoucherBrandHeader(
      doc,
      brand,
      scope === 'hotel'
        ? 'Hotel Voucher Details'
        : scope === 'vehicle'
          ? 'Vehicle Voucher Details'
          : 'Voucher Details',
      quoteId,
    );

    doc.roundedRect(30, 132, doc.page.width - 60, 163, 18).fillAndStroke('#FFFDF9', '#E7D9C4');
    doc.font('Helvetica').fontSize(10).fillColor('#6A6077').text(
      `${Number(data?.summary?.noOfNights || 0)} Nights / ${Number(data?.summary?.noOfDays || 0)} Days`,
      46,
      146,
    );

    doc.roundedRect(400, 146, 150, 62, 12).fillAndStroke('#FFFFFF', '#EADFF3');
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#8A6AB0').text('VOUCHER COUNTS', 414, 150);
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#3F3654').text(
      `${Number(data?.summary?.existingHotelVoucherCount || 0)} Hotel`,
      414,
      168,
    );
    doc.font('Helvetica-Bold').fontSize(14).text(
      `${Number(data?.summary?.existingVehicleVoucherCount || 0)} Vehicle`,
      414,
      184,
    );

    this.drawLabelValue(doc, 46, 178, 'Arrival Location', String(data?.summary?.arrivalLocation || '--'), 155);
    this.drawLabelValue(doc, 212, 178, 'Departure Location', String(data?.summary?.departureLocation || '--'), 155);
    this.drawLabelValue(doc, 378, 178, 'Primary Guest', String(data?.customer?.name || '--'), 155);
    this.drawLabelValue(doc, 46, 216, 'Trip Start', this.formatDateTime(data?.summary?.tripStartDateTime), 155);
    this.drawLabelValue(doc, 212, 216, 'Trip End', this.formatDateTime(data?.summary?.tripEndDateTime), 155);
    this.drawLabelValue(
      doc,
      378,
      216,
      'Passenger Mix',
      `${Number(data?.summary?.adults || 0)} Adult, ${Number(data?.summary?.children || 0)} Child, ${Number(data?.summary?.infants || 0)} Infant`,
      155,
    );
    this.drawLabelValue(doc, 46, 254, 'Contact Number', String(data?.customer?.contactNo || '--'), 155);
    this.drawLabelValue(doc, 212, 254, 'Email', String(data?.customer?.emailId || '--'), 155);
    this.drawLabelValue(
      doc,
      378,
      254,
      'Itinerary Preference',
      Boolean(data?.summary?.shouldShowHotels) && Boolean(data?.summary?.shouldShowVehicles)
        ? 'Hotel + Vehicle'
        : Boolean(data?.summary?.shouldShowHotels)
          ? 'Hotel'
          : 'Vehicle',
      155,
    );

    if (Boolean(data?.summary?.shouldShowHotels)) {
      doc.roundedRect(46, 286, 498, 20, 8).fillAndStroke('#FFFFFF', '#F0E6FB');
      this.drawLabelValue(doc, 58, 290, 'Room Count', String(data?.summary?.roomCount || 0), 90);
      this.drawLabelValue(doc, 176, 290, 'Extra Bed', String(data?.summary?.extraBed || 0), 90);
      this.drawLabelValue(doc, 294, 290, 'Child With Bed', String(data?.summary?.childWithBed || 0), 100);
      this.drawLabelValue(doc, 422, 290, 'Child Without Bed', String(data?.summary?.childWithoutBed || 0), 110);
    }

    doc.y = Boolean(data?.summary?.shouldShowHotels) ? 332 : 312;

    const hotelGroups = Array.isArray(data?.hotelVoucherGroups) ? data.hotelVoucherGroups : [];
    if (scope !== 'vehicle' && Boolean(data?.summary?.shouldShowHotels)) {
      this.drawSectionBand(doc, 'Hotel Voucher Details', doc.y);
      doc.y += 34;

      if (hotelGroups.length === 0) {
        doc.font('Helvetica').fontSize(10).fillColor('#5A5268').text('No hotel voucher rows found for this itinerary.', 40, doc.y + 10);
        doc.y += 34;
      } else {
        const hotelHeaderY = doc.y;
        doc.rect(40, hotelHeaderY, doc.page.width - 80, 22).fillAndStroke('#FBF8FF', '#E7DFF0');
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#3F3654');
        doc.text('HOTEL / LOCATION', 48, hotelHeaderY + 7, { width: 150 });
        doc.text('DATES', 205, hotelHeaderY + 7, { width: 110 });
        doc.text('ROOMS', 320, hotelHeaderY + 7, { width: 90 });
        doc.text('STATUS', 415, hotelHeaderY + 7, { width: 60 });
        doc.text('META', 480, hotelHeaderY + 7, { width: 60 });
        doc.y += 24;

        for (const group of hotelGroups) {
          this.addPageIfNeeded(doc, 72);
          const top = doc.y;
          const rowBg = Number(group?.voucherCount || 0) > 0 ? '#FFFFFF' : '#FFFCF5';
          doc.rect(40, top, doc.page.width - 80, 58).fillAndStroke(rowBg, '#EFE6F8');
          doc.font('Helvetica-Bold').fontSize(10).fillColor('#3F3654').text(String(group?.hotelName || '--'), 48, top + 6, { width: 150 });
          doc.font('Helvetica').fontSize(9).fillColor('#5A5268').text(
            String(group?.hotelStateCity || (Array.isArray(group?.destinations) ? group.destinations.join(', ') : '--')),
            48,
            top + 22,
            { width: 150 },
          );
          doc.text(`Days ${Array.isArray(group?.dayNumbers) ? group.dayNumbers.join(', ') : '--'}`, 48, top + 38, {
            width: 150,
          });

          doc.text(
            Array.isArray(group?.routeDates) ? group.routeDates.map((value: string) => this.formatDate(value)).join(', ') : '--',
            205,
            top + 10,
            { width: 105 },
          );
          doc.text(
            Array.isArray(group?.roomTypes) && group.roomTypes.length > 0 ? group.roomTypes.join(', ') : 'N/A',
            320,
            top + 10,
            { width: 85 },
          );
          doc.font('Helvetica-Bold').fillColor('#6E46A3').text(String(group?.bookingStatusLabel || 'Not Created'), 415, top + 10, { width: 55 });
          doc.font('Helvetica').fillColor('#5A5268').text(
            `Vouchers: ${Number(group?.voucherCount || 0)}\nPolicies: ${Number(group?.cancellationPolicyCount || 0)}\nInvoice: ${String(group?.invoiceToLabel || 'Not Set')}`,
            480,
            top + 6,
            { width: 58 },
          );

          if (group?.confirmedBy || group?.confirmedMobile || group?.confirmedEmail) {
            doc.fontSize(8).fillColor('#7A6A8D').text(
              `Confirmed: ${String(group?.confirmedBy || '--')} | ${String(group?.confirmedMobile || '--')} | ${String(group?.confirmedEmail || '--')}`,
              205,
              top + 40,
              { width: 270 },
            );
          }

          doc.y += 58;
        }
        doc.y += 8;
      }
    }

    const vehicleGroups = Array.isArray(data?.vehicleVoucherGroups) ? data.vehicleVoucherGroups : [];
    if (scope !== 'hotel' && Boolean(data?.summary?.shouldShowVehicles)) {
      this.addPageIfNeeded(doc, 60);
      this.drawSectionBand(doc, 'Vehicle Voucher Details', doc.y);
      doc.y += 34;

      if (vehicleGroups.length === 0) {
        doc.font('Helvetica').fontSize(10).fillColor('#5A5268').text('No vehicle voucher rows found for this itinerary.', 40, doc.y + 10);
        doc.y += 34;
      } else {
        const vehicleHeaderY = doc.y;
        doc.rect(40, vehicleHeaderY, doc.page.width - 80, 22).fillAndStroke('#FBF8FF', '#E7DFF0');
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#3F3654');
        doc.text('VEHICLE / VENDOR', 48, vehicleHeaderY + 7, { width: 170 });
        doc.text('BRANCH / ORIGIN', 220, vehicleHeaderY + 7, { width: 125 });
        doc.text('QTY / AMOUNT', 350, vehicleHeaderY + 7, { width: 95 });
        doc.text('STATUS', 448, vehicleHeaderY + 7, { width: 45 });
        doc.text('META', 495, vehicleHeaderY + 7, { width: 40 });
        doc.y += 24;

        for (const group of vehicleGroups) {
          this.addPageIfNeeded(doc, 76);
          const top = doc.y;
          const rowBg = Number(group?.voucherCount || 0) > 0 ? '#FFFFFF' : '#FFFCF5';
          doc.rect(40, top, doc.page.width - 80, 62).fillAndStroke(rowBg, '#EFE6F8');
          doc.font('Helvetica-Bold').fontSize(10).fillColor('#3F3654').text(String(group?.vehicleTypeTitle || '--'), 48, top + 6, { width: 165 });
          doc.font('Helvetica').fontSize(9).fillColor('#5A5268').text(String(group?.vendorName || '--'), 48, top + 22, { width: 165 });
          if (group?.reservationNo) {
            doc.text(`Reservation: ${String(group?.reservationNo)}`, 48, top + 38, { width: 165 });
          }

          doc.text(String(group?.vendorBranchName || '--'), 220, top + 10, { width: 120 });
          doc.text(`Origin: ${String(group?.vehicleOrigin || '--')}`, 220, top + 28, { width: 120 });
          doc.text(
            group?.verifiedBy ? `Verified: ${String(group?.verifiedBy)}` : `Confirmed: ${String(group?.confirmedBy || '--')}`,
            220,
            top + 44,
            { width: 120 },
          );

          doc.font('Helvetica-Bold').fillColor('#3F3654').text(`Qty ${Number(group?.totalQty || 0)}`, 350, top + 10, { width: 90 });
          doc.text(`Rs. ${this.normalizeCurrency(group?.totalAmount)}`, 350, top + 28, { width: 90 });
          doc.font('Helvetica').fillColor('#5A5268').text(
            `Policies ${Number(group?.cancellationPolicyCount || 0)}\nVouchers ${Number(group?.voucherCount || 0)}`,
            350,
            top + 42,
            { width: 90 },
          );

          doc.font('Helvetica-Bold').fillColor('#6E46A3').text(String(group?.bookingStatusLabel || 'Not Created'), 448, top + 18, { width: 42 });
          doc.font('Helvetica').fillColor('#5A5268').text(
            `Invoice\n${String(group?.invoiceToLabel || 'Not Set')}`,
            495,
            top + 12,
            { width: 40 },
          );

          doc.y += 62;
        }
      }
    }

    doc.end();
  }
}
