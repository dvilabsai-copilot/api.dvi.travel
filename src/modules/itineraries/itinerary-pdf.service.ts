import { Injectable } from '@nestjs/common';
import { Response } from 'express';
import PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';
import { ItinerariesService } from './itineraries.service';
import { PrismaService } from '../../prisma.service';
import { TransportVoucherDetails } from './dto/transport-voucher-details.dto';
import { renderInvoicePdfKit } from './templates/invoice-pdfkit.template';

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
    renderInvoicePdfKit(
      doc,
      data,
      type,
      {
        logoDataUri: this.fileToDataUri(this.resolveLogoPath(data?.company?.logoUrl)),
      },
    );
    doc.end();
  }

  async downloadVoucherPdf(itineraryPlanId: number, res: Response) {
    return this.downloadVoucherPdfByScope(itineraryPlanId, 'all', res);
  }

  async downloadHotelVoucherPdf(itineraryPlanId: number, res: Response) {
    return this.downloadVoucherPdfByScope(itineraryPlanId, 'hotel', res);
  }

  async downloadVehicleVoucherPdf(itineraryPlanId: number, res: Response) {
    const data = await this.itinerariesService.getTransportVoucherDetails(itineraryPlanId);
    const safeVoucherNo = data?.voucher?.voucherNo || String(itineraryPlanId);
    const safeName = this.sanitizeFileName(`transport-voucher-${safeVoucherNo}.pdf`);
    const doc = this.createPdfResponse(res, safeName);
    this.drawTransportVoucherPdf(doc, data);
    doc.end();
  }

  private fileToDataUri(filePath?: string | null): string | null {
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }

    const extension = path.extname(filePath).toLowerCase();
    const mimeTypeMap: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.gif': 'image/gif',
    };
    const mimeType = mimeTypeMap[extension];

    if (!mimeType) {
      return null;
    }

    return `data:${mimeType};base64,${fs.readFileSync(filePath).toString('base64')}`;
  }

  private resolveTransportDefaultVehicleImage(vehicleType?: string | null): string | null {
    const normalizedType = String(vehicleType || '').toLowerCase();
    const typedCandidates =
      normalizedType.includes('sedan')
        ? [
            '/assets/vehicles/sedan.png',
            '/assets/vehicles/car-sedan.png',
            '/uploads/hd_vehicle_gallery/exterior (1).jpg',
            '/uploads/vehicle_gallery/exterior (1).jpeg',
          ]
        : normalizedType.includes('innova') || normalizedType.includes('crysta')
          ? [
              '/assets/vehicles/innova.png',
              '/assets/vehicles/muv.png',
              '/uploads/hd_vehicle_gallery/exterior (2).jpg',
              '/uploads/vehicle_gallery/exterior (2).jpeg',
            ]
          : normalizedType.includes('tempo') || normalizedType.includes('traveller')
            ? [
                '/assets/vehicles/tempo-traveller.png',
                '/assets/vehicles/traveller.png',
                '/uploads/hd_vehicle_gallery/exterior (3).jpg',
                '/uploads/vehicle_gallery/exterior (3).jpeg',
              ]
            : [
                '/assets/vehicles/default-vehicle.png',
                '/assets/vehicles/car-default.png',
                '/uploads/hd_vehicle_gallery/exterior (1).jpg',
                '/uploads/vehicle_gallery/exterior (1).jpeg',
              ];

    const fallbackCandidates = [
      ...typedCandidates,
      '/uploads/hd_vehicle_gallery/no_vehicle.jpg',
      '/uploads/vehicle_gallery/no_vehicle.jpeg',
    ];

    for (const candidate of fallbackCandidates) {
      const resolved = this.resolveLogoPath(candidate);
      if (resolved) {
        return resolved;
      }
    }

    return null;
  }

  private drawTransportVoucherPdfCompact(doc: PDFKit.PDFDocument, data: TransportVoucherDetails): void {
    const colors = {
      primary: '#3d18d6',
      primaryDark: '#08005d',
      border: '#e3dcff',
      softBg: '#faf9ff',
      headerBg: '#f8f6ff',
      muted: '#6b6699',
      success: '#20a85a',
      danger: '#e53935',
    };
    const margin = 14;
    const contentWidth = doc.page.width - margin * 2;
    const pageHeight = doc.page.height;
    const cardGap = 10;
    const cardWidth = (contentWidth - cardGap * 2) / 3;
    const footerReserve = data.days.length <= 5 ? 145 : 24;
    let y = 18;

    const addPageIfNeeded = (requiredHeight: number, redrawTableHeader = false) => {
      if (y + requiredHeight <= pageHeight - 24) return;
      doc.addPage();
      y = 18;
      if (redrawTableHeader) {
        y += 12;
        y = this.drawTransportTableHeaderCompact(doc, margin, y, colors);
      }
    };

    doc.rect(0, 0, doc.page.width, doc.page.height).fill('#ffffff');
    this.drawTransportHeaderCompact(doc, data, colors);

    y = 130;
    this.drawTransportTrustStripCompact(doc, data, colors, y);

    y = 190;
    this.drawTransportInfoCardsCompact(doc, data, colors, y, cardWidth, cardGap, margin);

    y = 388;
    this.drawTransportVehicleCardCompact(doc, data, colors, y);

    y = 525;
    doc.fillColor(colors.primaryDark).font('Helvetica-Bold').fontSize(12).text('Day-wise Transport Itinerary', margin, y, {
      width: contentWidth,
    });
    y += 18;
    y = this.drawTransportTableHeaderCompact(doc, margin, y, colors);

    for (let index = 0; index < data.days.length; index += 1) {
      const row = data.days[index];
      const rowHeight = this.measureTransportTableRowCompact(doc, row);
      if (y + rowHeight + footerReserve > pageHeight - 24) {
        addPageIfNeeded(rowHeight + 20, true);
      }
      this.drawTransportTableRowCompact(doc, margin, y, row, index, colors);
      y += rowHeight;
    }

    y = data.days.length <= 5 ? Math.max(y + 8, pageHeight - 145) : y + 10;
    this.drawTransportFooterCompact(doc, data, colors, y, margin, contentWidth);
  }

  private drawTransportHeaderCompact(
    doc: PDFKit.PDFDocument,
    data: TransportVoucherDetails,
    colors: Record<string, string>,
  ) {
    doc.roundedRect(18, 18, 559, 100, 12).fillAndStroke(colors.headerBg, colors.border);
    const logoPath = this.resolveLogoPath(data.company.logoPath || '');
    if (logoPath) {
      try {
        doc.image(logoPath, 35, 38, { fit: [60, 50], align: 'center', valign: 'center' });
      } catch {
        this.drawTransportLogoFallbackCompact(doc, 35, 38, colors);
      }
    } else {
      this.drawTransportLogoFallbackCompact(doc, 35, 38, colors);
    }

    const company = this.wrapTransportCompanyNameCompact(data.company.name || 'Doview Holidays India Pvt Ltd');
    const companyX = 115;
    const companyY = 38;
    doc.fillColor(colors.primaryDark).font('Helvetica-Bold').fontSize(20).text(company.line1, companyX, companyY, {
      width: 260,
      lineGap: 1,
    });
    if (company.line2) {
      doc.text(company.line2, companyX, companyY + 22, { width: 260, lineGap: 1 });
    }
    const taglineY = company.line2 ? companyY + 45 : companyY + 28;
    doc.fillColor(colors.primary).font('Helvetica').fontSize(9).text(
      data.company.tagline || 'Travel Beyond Expectations',
      companyX,
      taglineY,
      { width: 260 },
    );
    doc.fillColor(colors.muted).font('Helvetica').fontSize(8).text(
      `${data.company.phone || '9919911948'} | ${data.company.email || 'vsr@dvi.co.in'} | ${data.company.website || 'www.dvi.travel'}`,
      companyX,
      taglineY + 17,
      { width: 300 },
    );

    doc.roundedRect(450, 34, 110, 72, 12).fillAndStroke('#ffffff', colors.border);
    doc.fillColor(colors.primary).font('Helvetica-Bold').fontSize(14).text('TRANSPORT', 458, 46, { width: 94, align: 'center' });
    doc.text('VOUCHER', 458, 60, { width: 94, align: 'center' });
    doc.fillColor(colors.primaryDark).font('Helvetica-Bold').fontSize(7.2).text(
      `Voucher No.: ${this.transportTruncateCompact(data.voucher.voucherNo || '--', 22)}`,
      456,
      77,
      { width: 98, align: 'center' },
    );
    doc.font('Helvetica').fontSize(7.2).text(`Date: ${data.voucher.date || '--'}`, 456, 88, { width: 98, align: 'center' });
    doc.roundedRect(470, 97, 70, 10, 5).fill(colors.primary);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(6.8).text('Scan for Assistance', 472, 100, { width: 66, align: 'center' });
  }

  private drawTransportTrustStripCompact(
    doc: PDFKit.PDFDocument,
    data: TransportVoucherDetails,
    colors: Record<string, string>,
    y: number,
  ) {
    doc.roundedRect(18, y, 559, 45, 12).fillAndStroke('#ffffff', colors.border);
    doc.fillColor(colors.muted).font('Helvetica').fontSize(7.5).text(
      'This voucher is valid for the following booking only and is non-transferable.',
      30,
      y + 11,
      { width: 176 },
    );
    doc.fillColor(colors.primaryDark).font('Helvetica-Bold').fontSize(12).text(data.voucher.title || 'Trip', 208, y + 10, {
      width: 180,
      align: 'center',
    });
    doc.fillColor(colors.primary).font('Helvetica').fontSize(8.8).text(`(${data.voucher.dateRange || '--'})`, 208, y + 25, {
      width: 180,
      align: 'center',
    });
    doc.fillColor(colors.success).font('Helvetica-Bold').fontSize(8.5).text('Verified & Trusted', 402, y + 11, {
      width: 160,
      align: 'center',
    });
    doc.fillColor(colors.muted).font('Helvetica').fontSize(7.5).text('Thank you for choosing DVI Holidays', 402, y + 24, {
      width: 160,
      align: 'center',
    });
  }

  private drawTransportInfoCardsCompact(
    doc: PDFKit.PDFDocument,
    data: TransportVoucherDetails,
    colors: Record<string, string>,
    y: number,
    cardWidth: number,
    cardGap: number,
    margin: number,
  ) {
    const height = 188;
    this.drawTransportCardCompact(doc, margin, y, cardWidth, height, 'Guest Details', colors);
    this.drawTransportCardCompact(doc, margin + cardWidth + cardGap, y, cardWidth, height, 'Trip Details', colors);
    this.drawTransportCardCompact(doc, margin + (cardWidth + cardGap) * 2, y, cardWidth, height, 'Flight Details', colors);

    let guestY = y + 34;
    guestY = this.drawTransportFieldCompact(doc, margin + 12, guestY, cardWidth - 24, 'Guest Name', data.guest.name, colors, 70);
    guestY = this.drawTransportFieldCompact(doc, margin + 12, guestY, cardWidth - 24, 'No. of Pax', data.guest.pax, colors, 50);
    guestY = this.drawTransportFieldCompact(doc, margin + 12, guestY, cardWidth - 24, 'Contact', data.guest.contactNo, colors, 48);
    guestY = this.drawTransportFieldCompact(doc, margin + 12, guestY, cardWidth - 24, 'Email', data.guest.email, colors, 50);
    guestY = this.drawTransportFieldCompact(doc, margin + 12, guestY, cardWidth - 24, 'Pickup', data.guest.pickupLocation, colors, 70);
    this.drawTransportFieldCompact(doc, margin + 12, guestY, cardWidth - 24, 'Drop', data.guest.dropLocation, colors, 70);

    let tripY = y + 34;
    tripY = this.drawTransportFieldCompact(doc, margin + cardWidth + cardGap + 12, tripY, cardWidth - 24, 'Tour Type', data.trip.tourType, colors, 40);
    tripY = this.drawTransportFieldCompact(doc, margin + cardWidth + cardGap + 12, tripY, cardWidth - 24, 'Travel Region', data.trip.travelRegion, colors, 78);
    tripY = this.drawTransportFieldCompact(doc, margin + cardWidth + cardGap + 12, tripY, cardWidth - 24, 'Check-in', data.trip.checkInDate, colors, 40);
    tripY = this.drawTransportFieldCompact(doc, margin + cardWidth + cardGap + 12, tripY, cardWidth - 24, 'Check-out', data.trip.checkOutDate, colors, 40);
    this.drawTransportFieldCompact(doc, margin + cardWidth + cardGap + 12, tripY, cardWidth - 24, 'Duration', data.trip.duration, colors, 40);

    const flightX = margin + (cardWidth + cardGap) * 2 + 12;
    let flightY = y + 34;
    doc.fillColor(colors.primary).font('Helvetica-Bold').fontSize(8).text('ARRIVAL FLIGHT', flightX, flightY, { width: cardWidth - 24 });
    flightY += 14;
    flightY = this.drawTransportFlightBlockCompact(doc, flightX, flightY, cardWidth - 24, data.flight.arrival, colors, 70);
    doc.fillColor(colors.primary).font('Helvetica-Bold').fontSize(8).text('DEPARTURE FLIGHT', flightX, flightY + 4, { width: cardWidth - 24 });
    this.drawTransportFlightBlockCompact(doc, flightX, flightY + 18, cardWidth - 24, data.flight.departure, colors, 70);
  }

  private drawTransportVehicleCardCompact(
    doc: PDFKit.PDFDocument,
    data: TransportVoucherDetails,
    colors: Record<string, string>,
    y: number,
  ) {
    this.drawTransportCardCompact(doc, 18, y, 559, 120, 'Vehicle Details', colors);
    const imageX = 35;
    const imageY = 425;
    const imageW = 150;
    const imageH = 70;
    const vehicleImagePath = this.resolveLogoPath(data.vehicle.imagePath || '');
    if (vehicleImagePath) {
      try {
        doc.roundedRect(imageX, imageY, imageW, imageH, 10).fillAndStroke('#ffffff', colors.border);
        doc.image(vehicleImagePath, imageX + 6, imageY + 6, { fit: [imageW - 12, imageH - 12], align: 'center', valign: 'center' });
      } catch {
        this.drawTransportImagePlaceholderCompact(doc, imageX, imageY, imageW, imageH, colors, data.vehicle.type);
      }
    } else {
      this.drawTransportImagePlaceholderCompact(doc, imageX, imageY, imageW, imageH, colors, data.vehicle.type);
    }

    let leftY = 425;
    let rightY = 425;
    leftY = this.drawTransportFieldCompact(doc, 215, leftY, 160, 'Vehicle Type', data.vehicle.type, colors, 42, true);
    leftY = this.drawTransportFieldCompact(doc, 215, leftY, 160, 'Vehicle No.', data.vehicle.vehicleNo, colors, 42, true);
    this.drawTransportFieldCompact(doc, 215, leftY, 160, 'Seating Capacity', data.vehicle.seatingCapacity, colors, 42, true);
    rightY = this.drawTransportFieldCompact(doc, 405, rightY, 150, 'AC', data.vehicle.ac, colors, 28, true);
    rightY = this.drawTransportFieldCompact(doc, 405, rightY, 150, 'Luggage Space', data.vehicle.luggageSpace, colors, 34, true);
    this.drawTransportFieldCompact(doc, 405, rightY, 150, 'Insurance', data.vehicle.insurance, colors, 42, true);
  }

  private drawTransportFooterCompact(
    doc: PDFKit.PDFDocument,
    data: TransportVoucherDetails,
    colors: Record<string, string>,
    y: number,
    margin: number,
    contentWidth: number,
  ) {
    const footerCards = [
      { title: 'Inclusions', items: data.footer.inclusions, accent: colors.success },
      { title: 'Important Notes', items: data.footer.notes, accent: colors.primaryDark },
      { title: 'Emergency Contact', items: [`Customer Support: ${data.footer.emergencyPhone || '--'}`, `Email: ${data.footer.emergencyEmail || '--'}`], accent: colors.danger },
    ];
    const cardGap = 8;
    const cardWidth = (contentWidth - cardGap * 2) / 3;
    const cardHeight = 105;
    footerCards.forEach((card, index) => {
      const x = margin + index * (cardWidth + cardGap);
      this.drawTransportCardCompact(doc, x, y, cardWidth, cardHeight, card.title, colors, card.accent);
      let itemY = y + 34;
      card.items.forEach((item) => {
        const compact = this.transportTruncateCompact(item, card.title === 'Emergency Contact' ? 52 : 78);
        doc.fillColor(colors.primaryDark).font('Helvetica').fontSize(7.2).text(`- ${compact}`, x + 10, itemY, {
          width: cardWidth - 20,
          lineGap: 1,
        });
        itemY += doc.heightOfString(`- ${compact}`, { width: cardWidth - 20, lineGap: 1 }) + 3;
      });
    });

    doc.fillColor(colors.muted).font('Helvetica-Oblique').fontSize(8).text(
      'Thank you for choosing DVI Holidays. We wish you a safe & memorable journey!',
      margin,
      doc.page.height - 28,
      { width: contentWidth, align: 'center' },
    );
  }

  private drawTransportCardCompact(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    width: number,
    height: number,
    title: string,
    colors: Record<string, string>,
    accentColor?: string,
  ) {
    doc.roundedRect(x, y, width, height, 12).fillAndStroke('#ffffff', colors.border);
    doc.roundedRect(x, y, width, 26, 12).fill(accentColor || colors.softBg);
    doc.fillColor(accentColor ? '#ffffff' : colors.primaryDark).font('Helvetica-Bold').fontSize(10.5).text(title, x + 12, y + 8, {
      width: width - 24,
    });
  }

  private drawTransportFieldCompact(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    width: number,
    label: string,
    value: string,
    colors: Record<string, string>,
    maxChars = 70,
    showMarker = false,
  ): number {
    const safeValue = this.transportTruncateCompact(String(value || '--').trim() || '--', maxChars);
    if (showMarker) {
      doc.roundedRect(x, y + 3, 6, 6, 2).fill(colors.primary);
    }
    const textX = x + (showMarker ? 12 : 0);
    const textWidth = width - (showMarker ? 12 : 0);
    doc.fillColor(colors.muted).font('Helvetica-Bold').fontSize(7.4).text(label.toUpperCase(), textX, y, { width: textWidth });
    const valueHeight = doc.heightOfString(safeValue, { width: textWidth, lineGap: 0 });
    doc.fillColor(colors.primaryDark).font('Helvetica').fontSize(8.4).text(safeValue, textX, y + 10, {
      width: textWidth,
      lineGap: 0,
    });
    return y + 14 + valueHeight;
  }

  private drawTransportFlightBlockCompact(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    width: number,
    flight: TransportVoucherDetails['flight']['arrival'],
    colors: Record<string, string>,
    maxChars = 70,
  ): number {
    const notProvided =
      (!flight.airline || flight.airline === 'Not Provided')
      && (!flight.flightNo || flight.flightNo === 'Not Provided')
      && (!flight.rawText || flight.rawText === 'Not Provided');
    const fields = notProvided
      ? ['Flight details not provided']
      : [
          this.transportTruncateCompact(`${flight.airline || 'Not Provided'} | ${flight.flightNo || 'Not Provided'}`, maxChars),
          this.transportTruncateCompact(`${flight.from || 'Not Provided'} | ${flight.to || 'Not Provided'}`, maxChars),
          this.transportTruncateCompact(`${flight.date || '--'} | ${flight.time || 'Not Provided'}`, maxChars),
        ];

    let currentY = y;
    for (const field of fields) {
      doc.fillColor(colors.primaryDark).font('Helvetica').fontSize(8).text(field, x, currentY, { width, lineGap: 0 });
      currentY += doc.heightOfString(field, { width, lineGap: 0 }) + 3;
    }
    return currentY;
  }

  private drawTransportImagePlaceholderCompact(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    width: number,
    height: number,
    colors: Record<string, string>,
    vehicleType?: string,
  ) {
    doc.roundedRect(x, y, width, height, 10).fillAndStroke(colors.softBg, colors.border);
    doc.fillColor(colors.muted).font('Helvetica-Bold').fontSize(10).text('Vehicle Image', x, y + 22, {
      width,
      align: 'center',
    });
    doc.fillColor(colors.primary).font('Helvetica').fontSize(8).text(
      this.transportTruncateCompact(vehicleType || 'Sedan / Innova / Tempo Traveller', 32),
      x + 10,
      y + 39,
      { width: width - 20, align: 'center' },
    );
  }

  private drawTransportTableHeaderCompact(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    colors: Record<string, string>,
  ): number {
    doc.roundedRect(x, y, doc.page.width - x * 2, 22, 8).fillAndStroke(colors.primary, colors.primary);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7);
    const columns = this.getTransportTableColumnsCompact();
    let cursor = x;
    for (const column of columns) {
      doc.text(column.label, cursor + 4, y + 7, { width: column.width - 8, align: column.align || 'left' });
      cursor += column.width;
    }
    return y + 24;
  }

  private getTransportTableColumnsCompact(): Array<{ key: string; label: string; width: number; align?: 'left' | 'center' | 'right' }> {
    return [
      { key: 'day', label: 'Day', width: 48, align: 'center' },
      { key: 'date', label: 'Date', width: 72 },
      { key: 'routeAndPlaces', label: 'Route & Places to Visit', width: 185 },
      { key: 'travelRoute', label: 'Travel Route', width: 125 },
      { key: 'startTime', label: 'Reporting / Start Time', width: 70, align: 'center' },
      { key: 'endTime', label: 'End Time', width: 59, align: 'center' },
    ];
  }

  private measureTransportTableRowCompact(doc: PDFKit.PDFDocument, row: TransportVoucherDetails['days'][number]): number {
    const columns = this.getTransportTableColumnsCompact();
    const heights = columns.map((column) => {
      if (column.key === 'day') return 26;
      const text = column.key === 'date'
        ? `${row.date}\n${row.weekday}`
        : column.key === 'routeAndPlaces'
          ? this.transportTruncateCompact(String((row as Record<string, unknown>)[column.key] || '--'), 140)
          : column.key === 'travelRoute'
            ? this.transportTruncateCompact(String((row as Record<string, unknown>)[column.key] || '--'), 72)
            : String((row as Record<string, unknown>)[column.key] || '--');
      return doc.heightOfString(text, { width: column.width - 8, lineGap: 0 }) + 10;
    });
    return Math.max(42, Math.min(64, Math.max(...heights)));
  }

  private drawTransportTableRowCompact(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    row: TransportVoucherDetails['days'][number],
    rowIndex: number,
    colors: Record<string, string>,
  ) {
    const columns = this.getTransportTableColumnsCompact();
    const rowHeight = this.measureTransportTableRowCompact(doc, row);
    doc.roundedRect(x, y, doc.page.width - x * 2, rowHeight, 8).fillAndStroke(rowIndex % 2 === 0 ? '#ffffff' : colors.softBg, colors.border);

    let cursor = x;
    for (const column of columns) {
      if (column.key === 'day') {
        doc.roundedRect(cursor + 5, y + 11, column.width - 10, 16, 8).fill(colors.primary);
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7).text(`DAY ${row.dayNo}`, cursor + 5, y + 16, {
          width: column.width - 10,
          align: 'center',
        });
      } else {
        const text = column.key === 'date'
          ? `${row.date}\n${row.weekday}`
          : column.key === 'routeAndPlaces'
            ? this.transportTruncateCompact(String((row as Record<string, unknown>)[column.key] || '--'), 140)
            : column.key === 'travelRoute'
              ? this.transportTruncateCompact(String((row as Record<string, unknown>)[column.key] || '--'), 72)
              : String((row as Record<string, unknown>)[column.key] || '--');
        doc.fillColor(colors.primaryDark).font('Helvetica').fontSize(7.2).text(text, cursor + 4, y + 7, {
          width: column.width - 8,
          align: column.align || 'left',
          lineGap: 0,
        });
      }
      cursor += column.width;
      if (cursor < doc.page.width - x) {
        doc.moveTo(cursor, y + 4).lineTo(cursor, y + rowHeight - 4).lineWidth(0.4).strokeColor(colors.border).stroke();
      }
    }
  }

  private drawTransportLogoFallbackCompact(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    colors: Record<string, string>,
  ) {
    doc.roundedRect(x, y, 60, 50, 10).fillAndStroke('#ffffff', colors.border);
    doc.fillColor(colors.primary).font('Helvetica-Bold').fontSize(16).text('DVi', x, y + 10, { width: 60, align: 'center' });
    doc.fillColor(colors.primaryDark).font('Helvetica-Bold').fontSize(10).text('holidays', x, y + 28, { width: 60, align: 'center' });
  }

  private wrapTransportCompanyNameCompact(name: string): { line1: string; line2: string } {
    const safe = String(name || '').trim() || 'Doview Holidays India Pvt Ltd';
    if (safe.length <= 27) {
      return { line1: safe, line2: '' };
    }
    if (safe.match(/Pvt Ltd\.?$/i)) {
      return {
        line1: safe.replace(/\s*Pvt Ltd\.?$/i, '').trim(),
        line2: 'Pvt Ltd.',
      };
    }
    return {
      line1: this.transportTruncateCompact(safe, 26),
      line2: '',
    };
  }

  private transportTruncateCompact(value: string, maxChars: number): string {
    const safe = String(value || '').replace(/\s+/g, ' ').trim();
    if (!safe) return '--';
    return safe.length > maxChars ? `${safe.slice(0, Math.max(0, maxChars - 3)).trim()}...` : safe;
  }

  private drawTransportVoucherPdf(doc: PDFKit.PDFDocument, data: TransportVoucherDetails): void {
    const colors = {
      primary: '#3d18d6',
      text: '#08005d',
      border: '#e7e2ff',
      soft: '#faf9ff',
      red: '#e53935',
      green: '#2eaf5d',
      muted: '#6f6897',
    };
    const margin = 34;
    const contentWidth = doc.page.width - margin * 2;
    const cardGap = 12;
    const smallCardWidth = (contentWidth - cardGap * 2) / 3;
    const bottomLimit = doc.page.height - 48;
    let y = 32;

    const addPageIfNeeded = (requiredHeight: number, redrawTableHeader = false) => {
      if (y + requiredHeight <= bottomLimit) return;
      doc.addPage();
      y = 34;
      if (redrawTableHeader) {
        y = this.drawTransportTableHeader(doc, margin, y, colors);
      }
    };

    doc.rect(0, 0, doc.page.width, doc.page.height).fill('#ffffff');
    doc.roundedRect(margin, y, contentWidth, 108, 20).fillAndStroke(colors.soft, colors.border);
    doc.roundedRect(doc.page.width - 188, y + 14, 140, 80, 16).fillAndStroke('#ffffff', colors.border);

    const logoPath = this.resolveLogoPath(data.company.logoPath || '');
    if (logoPath) {
      try {
        doc.image(logoPath, margin + 14, y + 16, { fit: [86, 54], align: 'center', valign: 'center' });
      } catch {
        // Keep generation successful if the image is unreadable.
      }
    } else {
      doc.fillColor(colors.primary).font('Helvetica-Bold').fontSize(20).text('DVi', margin + 18, y + 22);
      doc.fillColor(colors.text).font('Helvetica-Bold').fontSize(18).text('holidays', margin + 18, y + 48);
    }

    doc.fillColor(colors.text).font('Helvetica-Bold').fontSize(20).text(data.company.name || 'DVI Holidays', margin + 112, y + 18, { width: 230 });
    doc.fillColor(colors.primary).font('Helvetica').fontSize(10).text(data.company.tagline || 'Travel Beyond Expectations', margin + 112, y + 44);
    doc.fillColor(colors.muted).fontSize(9).text(
      [data.company.phone, data.company.email, data.company.website].filter(Boolean).join(' | '),
      margin + 112,
      y + 64,
      { width: 250 },
    );

    doc.fillColor(colors.primary).font('Helvetica-Bold').fontSize(15).text('TRANSPORT VOUCHER', doc.page.width - 177, y + 18, {
      width: 118,
      align: 'center',
    });
    doc.fillColor(colors.text).fontSize(9).font('Helvetica-Bold').text(`Voucher No.: ${data.voucher.voucherNo || '--'}`, doc.page.width - 177, y + 44, {
      width: 118,
      align: 'center',
    });
    doc.font('Helvetica').fontSize(9).text(`Date: ${data.voucher.date || '--'}`, doc.page.width - 177, y + 60, {
      width: 118,
      align: 'center',
    });
    doc.roundedRect(doc.page.width - 170, y + 76, 104, 16, 6).fillAndStroke('#ffffff', colors.border);
    doc.fillColor(colors.primary).font('Helvetica-Bold').fontSize(7).text('Scan for Assistance', doc.page.width - 166, y + 81, {
      width: 96,
      align: 'center',
    });

    y += 122;
    doc.roundedRect(margin, y, contentWidth, 44, 16).fillAndStroke('#ffffff', colors.border);
    doc.fillColor(colors.muted).font('Helvetica').fontSize(8.5).text(
      'This voucher is valid for the following booking only and is non-transferable.',
      margin + 16,
      y + 9,
      { width: 145 },
    );
    doc.fillColor(colors.text).font('Helvetica-Bold').fontSize(12).text(data.voucher.title || 'Trip', margin + 172, y + 8, {
      width: 190,
      align: 'center',
    });
    doc.fillColor(colors.primary).font('Helvetica').fontSize(9).text(`(${data.voucher.dateRange || '--'})`, margin + 172, y + 24, {
      width: 190,
      align: 'center',
    });
    doc.fillColor(colors.green).font('Helvetica-Bold').fontSize(9).text('Verified & Trusted', margin + 388, y + 10, {
      width: 110,
      align: 'center',
    });
    doc.fillColor(colors.muted).font('Helvetica').fontSize(8).text('Thank you for choosing DVI Holidays', margin + 388, y + 24, {
      width: 110,
      align: 'center',
    });

    y += 58;
    const detailTop = y;
    const detailHeight = 176;
    this.drawTransportCard(doc, margin, detailTop, smallCardWidth, detailHeight, 'Guest Details', colors);
    this.drawTransportCard(doc, margin + smallCardWidth + cardGap, detailTop, smallCardWidth, detailHeight, 'Trip Details', colors);
    this.drawTransportCard(doc, margin + (smallCardWidth + cardGap) * 2, detailTop, smallCardWidth, detailHeight, 'Flight Details', colors);

    let guestY = detailTop + 34;
    guestY = this.drawTransportField(doc, margin + 14, guestY, smallCardWidth - 28, 'Guest Name', data.guest.name, colors);
    guestY = this.drawTransportField(doc, margin + 14, guestY, smallCardWidth - 28, 'No. of Pax', data.guest.pax, colors);
    guestY = this.drawTransportField(doc, margin + 14, guestY, smallCardWidth - 28, 'Contact', data.guest.contactNo, colors);
    guestY = this.drawTransportField(doc, margin + 14, guestY, smallCardWidth - 28, 'Email', data.guest.email, colors);
    guestY = this.drawTransportField(doc, margin + 14, guestY, smallCardWidth - 28, 'Pickup', data.guest.pickupLocation, colors);
    this.drawTransportField(doc, margin + 14, guestY, smallCardWidth - 28, 'Drop', data.guest.dropLocation, colors);

    let tripY = detailTop + 34;
    tripY = this.drawTransportField(doc, margin + smallCardWidth + cardGap + 14, tripY, smallCardWidth - 28, 'Tour Type', data.trip.tourType, colors);
    tripY = this.drawTransportField(doc, margin + smallCardWidth + cardGap + 14, tripY, smallCardWidth - 28, 'Travel Region', data.trip.travelRegion, colors);
    tripY = this.drawTransportField(doc, margin + smallCardWidth + cardGap + 14, tripY, smallCardWidth - 28, 'Check-in', data.trip.checkInDate, colors);
    tripY = this.drawTransportField(doc, margin + smallCardWidth + cardGap + 14, tripY, smallCardWidth - 28, 'Check-out', data.trip.checkOutDate, colors);
    this.drawTransportField(doc, margin + smallCardWidth + cardGap + 14, tripY, smallCardWidth - 28, 'Duration', data.trip.duration, colors);

    const flightX = margin + (smallCardWidth + cardGap) * 2 + 14;
    let flightY = detailTop + 36;
    doc.fillColor(colors.primary).font('Helvetica-Bold').fontSize(8.5).text('ARRIVAL FLIGHT', flightX, flightY, { width: smallCardWidth - 28 });
    flightY += 16;
    flightY = this.drawTransportFlightBlock(doc, flightX, flightY, smallCardWidth - 28, data.flight.arrival, colors);
    doc.fillColor(colors.primary).font('Helvetica-Bold').fontSize(8.5).text('DEPARTURE FLIGHT', flightX, flightY + 4, { width: smallCardWidth - 28 });
    this.drawTransportFlightBlock(doc, flightX, flightY + 20, smallCardWidth - 28, data.flight.departure, colors);

    y += detailHeight + 14;
    addPageIfNeeded(160);
    this.drawTransportCard(doc, margin, y, contentWidth, 132, 'Vehicle Details', colors);
    const vehicleImageX = margin + 16;
    const vehicleImageY = y + 18;
    const vehicleImageW = 132;
    const vehicleImageH = 88;
    const vehicleImagePath = this.resolveLogoPath(data.vehicle.imagePath || '');
    if (vehicleImagePath) {
      try {
        doc.roundedRect(vehicleImageX, vehicleImageY, vehicleImageW, vehicleImageH, 12).fillAndStroke('#ffffff', colors.border);
        doc.image(vehicleImagePath, vehicleImageX + 6, vehicleImageY + 6, { fit: [vehicleImageW - 12, vehicleImageH - 12], align: 'center', valign: 'center' });
      } catch {
        this.drawTransportImagePlaceholder(doc, vehicleImageX, vehicleImageY, vehicleImageW, vehicleImageH, colors);
      }
    } else {
      this.drawTransportImagePlaceholder(doc, vehicleImageX, vehicleImageY, vehicleImageW, vehicleImageH, colors);
    }

    const vehicleFieldX = vehicleImageX + vehicleImageW + 18;
    const vehicleColumnGap = 20;
    const vehicleFieldWidth = (contentWidth - (vehicleFieldX - margin) - 22 - vehicleColumnGap) / 2;
    let vehicleYLeft = y + 26;
    let vehicleYRight = y + 26;
    vehicleYLeft = this.drawTransportField(doc, vehicleFieldX, vehicleYLeft, vehicleFieldWidth, 'Vehicle Type', data.vehicle.type, colors);
    vehicleYLeft = this.drawTransportField(doc, vehicleFieldX, vehicleYLeft, vehicleFieldWidth, 'Vehicle No.', data.vehicle.vehicleNo, colors);
    vehicleYLeft = this.drawTransportField(doc, vehicleFieldX, vehicleYLeft, vehicleFieldWidth, 'Seating Capacity', data.vehicle.seatingCapacity, colors);
    vehicleYRight = this.drawTransportField(doc, vehicleFieldX + vehicleFieldWidth + vehicleColumnGap, vehicleYRight, vehicleFieldWidth, 'AC', data.vehicle.ac, colors);
    vehicleYRight = this.drawTransportField(doc, vehicleFieldX + vehicleFieldWidth + vehicleColumnGap, vehicleYRight, vehicleFieldWidth, 'Luggage Space', data.vehicle.luggageSpace, colors);
    this.drawTransportField(doc, vehicleFieldX + vehicleFieldWidth + vehicleColumnGap, vehicleYRight, vehicleFieldWidth, 'Insurance', data.vehicle.insurance, colors);

    y += 146;
    addPageIfNeeded(90, false);
    doc.fillColor(colors.text).font('Helvetica-Bold').fontSize(13).text('Day-wise Transport Itinerary', margin, y, { width: contentWidth });
    y += 20;
    y = this.drawTransportTableHeader(doc, margin, y, colors);
    for (let index = 0; index < data.days.length; index += 1) {
      const row = data.days[index];
      const rowHeight = this.measureTransportTableRow(doc, row);
      addPageIfNeeded(rowHeight + 8, true);
      this.drawTransportTableRow(doc, margin, y, row, index, colors);
      y += rowHeight + 6;
    }

    y += 8;
    const footerCards = [
      { title: 'Inclusions', items: data.footer.inclusions, accent: colors.primary },
      { title: 'Important Notes', items: data.footer.notes, accent: colors.red },
      { title: 'Emergency Contact', items: [`Customer Support: ${data.footer.emergencyPhone || '--'}`, `Email: ${data.footer.emergencyEmail || '--'}`], accent: colors.green },
    ];

    for (const card of footerCards) {
      const cardHeight = 34 + card.items.length * 16 + 16;
      addPageIfNeeded(cardHeight + 10, false);
      this.drawTransportCard(doc, margin, y, contentWidth, cardHeight, card.title, colors, card.accent);
      let itemY = y + 36;
      for (const item of card.items) {
        doc.fillColor(colors.text).font('Helvetica').fontSize(9.5).text(`• ${item}`, margin + 16, itemY, { width: contentWidth - 32 });
        itemY += 16;
      }
      y += cardHeight + 10;
    }

    addPageIfNeeded(42, false);
    doc.roundedRect(margin, y, contentWidth, 34, 14).fillAndStroke(colors.soft, colors.border);
    doc.fillColor(colors.text).font('Helvetica-Bold').fontSize(10.5).text(
      'Thank you for choosing DVI Holidays. We wish you a safe and memorable journey!',
      margin + 16,
      y + 11,
      { width: contentWidth - 32, align: 'center' },
    );
  }

  private drawTransportCard(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    width: number,
    height: number,
    title: string,
    colors: Record<string, string>,
    accentColor?: string,
  ) {
    doc.roundedRect(x, y, width, height, 16).fillAndStroke('#ffffff', colors.border);
    doc.roundedRect(x, y, width, 26, 16).fill(accentColor || colors.soft);
    doc.fillColor(accentColor ? '#ffffff' : colors.text).font('Helvetica-Bold').fontSize(10).text(title, x + 14, y + 8, {
      width: width - 28,
    });
  }

  private drawTransportField(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    width: number,
    label: string,
    value: string,
    colors: Record<string, string>,
  ): number {
    const safeValue = String(value || '--').trim() || '--';
    doc.fillColor(colors.muted).font('Helvetica-Bold').fontSize(8).text(label.toUpperCase(), x, y, { width });
    const valueHeight = doc.heightOfString(safeValue, { width, align: 'left' });
    doc.fillColor(colors.text).font('Helvetica').fontSize(9.2).text(safeValue, x, y + 11, { width });
    return y + 17 + valueHeight;
  }

  private drawTransportFlightBlock(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    width: number,
    flight: TransportVoucherDetails['flight']['arrival'],
    colors: Record<string, string>,
  ): number {
    const fields = [
      `${flight.airline || 'Not Provided'} | ${flight.flightNo || 'Not Provided'}`,
      `${flight.from || 'Not Provided'} → ${flight.to || 'Not Provided'}`,
      `${flight.date || '--'} | ${flight.time || 'Not Provided'}`,
    ];
    if (
      (!flight.airline || flight.airline === 'Not Provided')
      && flight.rawText
      && flight.rawText !== 'Not Provided'
    ) {
      fields.push(flight.rawText);
    }

    let currentY = y;
    for (const field of fields) {
      doc.fillColor(colors.text).font('Helvetica').fontSize(8.8).text(field, x, currentY, { width });
      currentY += doc.heightOfString(field, { width }) + 4;
    }
    return currentY;
  }

  private drawTransportImagePlaceholder(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    width: number,
    height: number,
    colors: Record<string, string>,
  ) {
    doc.roundedRect(x, y, width, height, 12).fillAndStroke(colors.soft, colors.border);
    doc.fillColor(colors.muted).font('Helvetica-Bold').fontSize(10).text('Vehicle Image', x, y + height / 2 - 6, {
      width,
      align: 'center',
    });
  }

  private drawTransportTableHeader(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    colors: Record<string, string>,
  ): number {
    doc.roundedRect(x, y, doc.page.width - x * 2, 24, 10).fillAndStroke(colors.primary, colors.primary);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5);
    const columns = this.getTransportTableColumns();
    let cursor = x;
    for (const column of columns) {
      doc.text(column.label, cursor + 6, y + 8, { width: column.width - 12, align: column.align || 'left' });
      cursor += column.width;
    }
    return y + 30;
  }

  private getTransportTableColumns(): Array<{ key: string; label: string; width: number; align?: 'left' | 'center' | 'right' }> {
    return [
      { key: 'day', label: 'Day', width: 54, align: 'center' },
      { key: 'date', label: 'Date', width: 72 },
      { key: 'routeAndPlaces', label: 'Route & Places to Visit', width: 152 },
      { key: 'travelRoute', label: 'Travel Route', width: 118 },
      { key: 'startTime', label: 'Reporting / Start Time', width: 76, align: 'center' },
      { key: 'endTime', label: 'End Time', width: 60, align: 'center' },
    ];
  }

  private measureTransportTableRow(doc: PDFKit.PDFDocument, row: TransportVoucherDetails['days'][number]): number {
    const columns = this.getTransportTableColumns();
    const heights = columns.map((column) => {
      if (column.key === 'day') return 26;
      const text = column.key === 'date'
        ? `${row.date}\n${row.weekday}`
        : String((row as Record<string, unknown>)[column.key] || '--');
      return doc.heightOfString(text, { width: column.width - 12 }) + 14;
    });
    return Math.max(38, ...heights);
  }

  private drawTransportTableRow(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    row: TransportVoucherDetails['days'][number],
    rowIndex: number,
    colors: Record<string, string>,
  ) {
    const columns = this.getTransportTableColumns();
    const rowHeight = this.measureTransportTableRow(doc, row);
    doc.roundedRect(x, y, doc.page.width - x * 2, rowHeight, 10).fillAndStroke(rowIndex % 2 === 0 ? '#ffffff' : colors.soft, colors.border);

    let cursor = x;
    for (const column of columns) {
      if (column.key === 'day') {
        doc.roundedRect(cursor + 8, y + 8, column.width - 16, 20, 10).fill(colors.primary);
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8).text(`DAY ${row.dayNo}`, cursor + 8, y + 14, {
          width: column.width - 16,
          align: 'center',
        });
      } else {
        const text = column.key === 'date'
          ? `${row.date}\n${row.weekday}`
          : String((row as Record<string, unknown>)[column.key] || '--');
        doc.fillColor(colors.text).font('Helvetica').fontSize(8.8).text(text, cursor + 6, y + 8, {
          width: column.width - 12,
          align: column.align || 'left',
        });
      }
      cursor += column.width;
      if (cursor < doc.page.width - x) {
        doc.moveTo(cursor, y + 5).lineTo(cursor, y + rowHeight - 5).lineWidth(0.5).strokeColor(colors.border).stroke();
      }
    }
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

