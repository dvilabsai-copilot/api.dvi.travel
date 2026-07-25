export interface InvoicePdfKitAssets {
  logoDataUri?: string | null;
}

type InvoiceType = 'tax' | 'proforma';

function safeText(value: any): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || '--';
}

function formatDate(value?: string | Date | null): string {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date
    .toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
    .replace(/\s+/g, '-');
}

function formatCurrency(value: any): string {
  return Number(value || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function amountToWords(amount: any): string {
  const ones = [
    '',
    'One',
    'Two',
    'Three',
    'Four',
    'Five',
    'Six',
    'Seven',
    'Eight',
    'Nine',
    'Ten',
    'Eleven',
    'Twelve',
    'Thirteen',
    'Fourteen',
    'Fifteen',
    'Sixteen',
    'Seventeen',
    'Eighteen',
    'Nineteen',
  ];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const convertBelowHundred = (n: number): string => {
    if (n < 20) return ones[n] || '';
    const ten = Math.floor(n / 10);
    const one = n % 10;
    return `${tens[ten]}${one ? ` ${ones[one]}` : ''}`.trim();
  };

  const convertBelowThousand = (n: number): string => {
    let result = '';
    if (n >= 100) {
      result += `${ones[Math.floor(n / 100)]} Hundred `;
      n %= 100;
    }
    if (n > 0) {
      result += convertBelowHundred(n);
    }
    return result.trim();
  };

  const numericAmount = Number(amount || 0);
  const integerPart = Math.floor(numericAmount);
  const paise = Math.round((numericAmount - integerPart) * 100);

  if (!integerPart) {
    return 'Zero Rupees Only';
  }

  const crore = Math.floor(integerPart / 10000000);
  const lakh = Math.floor((integerPart % 10000000) / 100000);
  const thousand = Math.floor((integerPart % 100000) / 1000);
  const hundred = integerPart % 1000;

  const parts: string[] = [];
  if (crore) parts.push(`${convertBelowThousand(crore)} Crore`);
  if (lakh) parts.push(`${convertBelowThousand(lakh)} Lakh`);
  if (thousand) parts.push(`${convertBelowThousand(thousand)} Thousand`);
  if (hundred) parts.push(convertBelowThousand(hundred));

  return `${parts.join(' ').trim()} Rupees${paise ? ` and ${convertBelowHundred(paise)} Paise` : ''} Only`;
}

function drawCellBorder(doc: any, x: number, y: number, width: number, height: number, fill = '#ffffff', stroke = '#d8d8d8') {
  doc.rect(x, y, width, height).fillAndStroke(fill, stroke);
}

function drawTopRightMetaCell(
  doc: any,
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
  value: string,
) {
  drawCellBorder(doc, x, y, width, height, '#ffffff', '#d8d8d8');
  doc.font('Helvetica').fontSize(8.8).fillColor('#7B6A8D').text(label, x + 8, y + 7, {
    width: width - 16,
  });
  doc.font('Helvetica').fontSize(10.2).fillColor('#2F2A36').text(value || '--', x + 8, y + 22, {
    width: width - 16,
  });
}

function drawDetailBlock(
  doc: any,
  x: number,
  y: number,
  width: number,
  title: string,
  lines: Array<{ label?: string; value: string; bold?: boolean }>,
  height?: number,
) {
  const contentHeight = height || 140;
  drawCellBorder(doc, x, y, width, contentHeight, '#ffffff', '#d8d8d8');
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#3F3654').text(title, x + 10, y + 9);

  let currentY = y + 28;
  for (const line of lines) {
    if (line.label) {
      doc.font('Helvetica').fontSize(9.5).fillColor('#6A6077').text(`${line.label}:`, x + 10, currentY, {
        width: width - 20,
      });
      doc.font(line.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10.2).fillColor('#2F2A36').text(line.value || '--', x + 10, currentY + 12, {
        width: width - 20,
      });
      currentY += 31;
    } else {
      doc.font(line.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10.2).fillColor('#2F2A36').text(line.value || '--', x + 10, currentY, {
        width: width - 20,
      });
      currentY += 18;
    }
  }
}

function measureItemRowHeight(doc: any, item: any, particularsWidth: number): number {
  const title = safeText(item?.title);
  const notes = Array.isArray(item?.notes) ? item.notes : [];
  const titleHeight = doc.heightOfString(title, {
    width: particularsWidth - 12,
    lineGap: 1,
  });
  const notesHeight = notes.reduce((sum: number, note: any) => {
    const label = safeText(note?.label);
    return sum + doc.heightOfString(label, {
      width: particularsWidth - 16,
      lineGap: 0,
    }) + 2;
  }, 0);
  return Math.max(28, Math.ceil(titleHeight + notesHeight + 12));
}

export function renderInvoicePdfKit(
  doc: any,
  data: any,
  type: InvoiceType,
  assets: InvoicePdfKitAssets = {},
) {
  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const margin = 34;
  const contentWidth = pageWidth - margin * 2;
  const primary = '#7B58A9';
  const text = '#3F3654';
  const muted = '#6A6077';
  const border = '#D8D1E6';
  const soft = '#F9F6FF';
  const softAlt = '#FFFDF9';

  const safe = {
    company: data?.company || {},
    buyer: data?.buyer || {},
    guest: data?.guest || {},
    meta: data?.meta || {},
    itinerary: data?.itinerary || {},
    lineItems: Array.isArray(data?.lineItems) ? data.lineItems : [],
    totals: data?.totals || {},
    declaration: safeText(data?.declaration),
  };

  doc.rect(0, 0, pageWidth, pageHeight).fill('#ffffff');

  const logo = assets.logoDataUri;
  if (logo) {
    try {
      doc.image(logo, pageWidth - 135, 30, { fit: [88, 52], align: 'right', valign: 'center' });
    } catch {
 // Keep generation successful even if logo data is invalid.
    }
  }

  doc.font('Helvetica-Bold').fontSize(22).fillColor(text).text(
    type === 'proforma' ? 'Proforma Invoice' : 'Tax Invoice',
    margin,
    36,
    { width: contentWidth - 110, align: 'center' },
  );

  let y = 90;

  const sellerX = margin;
  const sellerWidth = 320;
  const metaX = sellerX + sellerWidth;
  const metaWidth = contentWidth - sellerWidth;
  const sellerHeight = 176;

  drawCellBorder(doc, sellerX, y, sellerWidth, sellerHeight, '#ffffff', '#d8d8d8');
  doc.font('Helvetica-Bold').fontSize(12.5).fillColor(text).text('Seller:', sellerX + 10, y + 8);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(text).text(safeText(safe.company.name), sellerX + 10, y + 26, { width: sellerWidth - 20 });
  doc.font('Helvetica').fontSize(9.5).fillColor('#000000').text(`Address: ${safeText(safe.company.address)}${safe.company.pincode ? ` - ${safe.company.pincode}` : ''}`, sellerX + 10, y + 46, { width: sellerWidth - 20 });
  doc.text(`GSTIN/UIN: ${safeText(safe.company.gstNo)}`, sellerX + 10, y + 64, { width: sellerWidth - 20 });
  doc.text(`State Name: ${safeText(safe.company.gstStateName)}${safe.company.gstStateCode ? `, Code: ${safe.company.gstStateCode}` : ''}`, sellerX + 10, y + 82, { width: sellerWidth - 20 });
  doc.text(`CIN: ${safeText(safe.company.cin)}`, sellerX + 10, y + 100, { width: sellerWidth - 20 });
  doc.text(`Email Id: ${safeText(safe.company.email)}`, sellerX + 10, y + 118, { width: sellerWidth - 20 });
  doc.text(`Contact Number: ${safeText(safe.company.contactNo)}`, sellerX + 10, y + 136, { width: sellerWidth - 20 });

  drawCellBorder(doc, metaX, y, metaWidth, sellerHeight, '#ffffff', '#d8d8d8');
  drawTopRightMetaCell(doc, metaX, y, metaWidth / 2, 58, 'Invoice No', safeText(safe.meta.invoiceNo));
  drawTopRightMetaCell(doc, metaX + metaWidth / 2, y, metaWidth / 2, 58, 'Dated', formatDate(safe.meta.invoiceDate));
  drawTopRightMetaCell(doc, metaX, y + 58, metaWidth / 2, 58, 'Delivery Note', safeText(safe.meta.deliveryNote));
  drawTopRightMetaCell(doc, metaX + metaWidth / 2, y + 58, metaWidth / 2, 58, 'Dispatch Doc No', '--');
  drawTopRightMetaCell(doc, metaX, y + 116, metaWidth / 2, 60, 'Travel Expert', safeText(safe.meta.travelExpertName));
  drawTopRightMetaCell(doc, metaX + metaWidth / 2, y + 116, metaWidth / 2, 60, 'Dispatched through', '--');

  y += sellerHeight + 2;
  const buyerHeight = 112;
  const buyerWidth = 320;
  const guestWidth = contentWidth - buyerWidth;

  drawCellBorder(doc, margin, y, buyerWidth, buyerHeight, '#ffffff', '#d8d8d8');
  doc.font('Helvetica-Bold').fontSize(12.5).fillColor(text).text('Buyer:', margin + 10, y + 8);
  doc.font('Helvetica-Bold').fontSize(11.5).fillColor(text).text(safeText(safe.buyer.companyName || safe.buyer.agentName), margin + 10, y + 26, {
    width: buyerWidth - 20,
  });
  doc.font('Helvetica').fontSize(9.5).fillColor('#000000').text(`Address: ${safeText(safe.buyer.address)}`, margin + 10, y + 46, { width: buyerWidth - 20 });
  doc.text(`GSTIN/UIN: ${safeText(safe.buyer.gstNo)}`, margin + 10, y + 64, { width: buyerWidth - 20 });
  doc.text(`State Name: ${safeText(safe.buyer.gstStateName)}${safe.buyer.gstStateCode ? `, Code: ${safe.buyer.gstStateCode}` : ''}`, margin + 10, y + 82, {
    width: buyerWidth - 20,
  });

  drawCellBorder(doc, margin + buyerWidth, y, guestWidth, buyerHeight, '#ffffff', '#d8d8d8');
  doc.font('Helvetica').fontSize(10).fillColor('#6A6077').text(`Guest Name: ${safeText(safe.guest.name)}`, margin + buyerWidth + 10, y + 8, {
    width: guestWidth - 20,
  });
  doc.text(`Contact Number: ${safeText(safe.guest.contactNo)}`, margin + buyerWidth + 10, y + 28, { width: guestWidth - 20 });
  doc.text(`Arrival: ${safeText(safe.guest.arrivalPlace)}, ${formatDate(safe.guest.arrivalDateTime)}`, margin + buyerWidth + 10, y + 48, {
    width: guestWidth - 20,
  });
  doc.text(`Departure: ${safeText(safe.guest.departurePlace)}, ${formatDate(safe.guest.departureDateTime)}`, margin + buyerWidth + 10, y + 68, {
    width: guestWidth - 20,
  });

  y += buyerHeight + 4;

  const tableX = margin;
  const tableWidth = contentWidth;
  const colSlNo = 40;
  const colParticulars = 345;
  const colHsn = 78;
  const colAmount = tableWidth - colSlNo - colParticulars - colHsn;
  const headerHeight = 28;

  const drawTableHeader = () => {
    drawCellBorder(doc, tableX, y, tableWidth, headerHeight, soft, border);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000');
    doc.text('Sl No.', tableX + 6, y + 8, { width: colSlNo - 12, align: 'center' });
    doc.text('Particulars', tableX + colSlNo + 6, y + 8, { width: colParticulars - 12, align: 'center' });
    doc.text('HSN/SAC', tableX + colSlNo + colParticulars + 6, y + 8, { width: colHsn - 12, align: 'center' });
    doc.text('Amount', tableX + colSlNo + colParticulars + colHsn + 6, y + 8, { width: colAmount - 12, align: 'center' });
    y += headerHeight;
  };

  const ensureSpace = (required: number, redrawHeader = false) => {
    if (y + required <= pageHeight - 92) return;
    doc.addPage();
    y = 34;
    if (redrawHeader) {
      drawTableHeader();
    }
  };

  drawTableHeader();

  const items = safe.lineItems.filter((item: any) => Number(item?.amount || 0) > 0);
  if (items.length === 0) {
    ensureSpace(30, false);
    drawCellBorder(doc, tableX, y, tableWidth, 28, '#ffffff', border);
    doc.font('Helvetica').fontSize(10).fillColor('#2F2A36').text('No charge items found.', tableX + 8, y + 8, {
      width: tableWidth - 16,
      align: 'center',
    });
    y += 28;
  } else {
    items.forEach((item: any, index: number) => {
      const rowHeight = measureItemRowHeight(doc, item, colParticulars);
      ensureSpace(rowHeight + 4, true);

      drawCellBorder(doc, tableX, y, colSlNo, rowHeight, '#ffffff', border);
      drawCellBorder(doc, tableX + colSlNo, y, colParticulars, rowHeight, '#ffffff', border);
      drawCellBorder(doc, tableX + colSlNo + colParticulars, y, colHsn, rowHeight, '#ffffff', border);
      drawCellBorder(doc, tableX + colSlNo + colParticulars + colHsn, y, colAmount, rowHeight, '#ffffff', border);

      const serialLabel = String(item?.serialNo || index + 1);
      doc.font('Helvetica').fontSize(10).fillColor('#2F2A36').text(serialLabel, tableX + 4, y + 6, {
        width: colSlNo - 8,
        align: 'left',
      });

      const title = safeText(item?.title);
      doc.font('Helvetica-Bold').fontSize(10.2).fillColor('#2F2A36').text(title, tableX + colSlNo + 6, y + 5, {
        width: colParticulars - 12,
      });

      const notes = Array.isArray(item?.notes) ? item.notes : [];
      let noteY = y + 5 + doc.heightOfString(title, { width: colParticulars - 12 });
      for (const note of notes) {
        const noteText = safeText(note?.label);
        doc.font('Helvetica').fontSize(9).fillColor('#4f4a5a').text(noteText, tableX + colSlNo + 8, noteY + 2, {
          width: colParticulars - 16,
        });
        noteY += doc.heightOfString(noteText, { width: colParticulars - 16 }) + 2;
      }

      doc.font('Helvetica').fontSize(10).fillColor('#2F2A36').text(safeText(item?.hsnSac), tableX + colSlNo + colParticulars + 4, y + 6, {
        width: colHsn - 8,
        align: 'center',
      });
      doc.font('Helvetica').fontSize(10).fillColor('#2F2A36').text(formatCurrency(item?.amount), tableX + colSlNo + colParticulars + colHsn + 4, y + 6, {
        width: colAmount - 8,
        align: 'right',
      });

      y += rowHeight;
    });
  }

  ensureSpace(32, false);
  drawCellBorder(doc, tableX, y, tableWidth, 28, '#ffffff', border);
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#000000').text('Total Amount', tableX + tableWidth - 140, y + 8, {
    width: 108,
    align: 'right',
  });
  doc.font('Helvetica').fontSize(10.5).fillColor('#000000').text(formatCurrency(safe.totals.totalAmount), tableX + tableWidth - 24, y + 8, {
    width: 18,
    align: 'right',
  });
  y += 34;

  const footerTop = y + 4;
  const footerLeftWidth = 265;
  const footerRightX = margin + footerLeftWidth + 16;
  const footerRightWidth = contentWidth - footerLeftWidth - 16;

  const leftLines = [
    { label: 'Amount Chargeable (in words) :', value: amountToWords(safe.totals.totalAmount), bold: true },
  ];
  drawDetailBlock(doc, margin, footerTop, footerLeftWidth, ' ', leftLines, 76);
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(text).text('Declaration :', margin, footerTop + 84);
  doc.font('Helvetica').fontSize(9).fillColor('#2F2A36').text(safe.declaration, margin, footerTop + 98, {
    width: footerLeftWidth,
  });

  drawCellBorder(doc, footerRightX, footerTop, footerRightWidth, 176, '#ffffff', border);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(text).text('Company PAN No :', footerRightX + 10, footerTop + 10);
  doc.font('Helvetica').fontSize(10).fillColor('#2F2A36').text(safeText(safe.buyer.panNo || safe.company.panNo), footerRightX + 120, footerTop + 10);

  doc.font('Helvetica-Bold').fontSize(10).fillColor(text).text('Company Bank Details :', footerRightX + 10, footerTop + 36);
  doc.font('Helvetica').fontSize(9.2).fillColor('#2F2A36').text(
    [
      safe.company.bank?.accountName ? `A/c Name: ${safe.company.bank.accountName}` : '',
      safe.company.bank?.accountNo ? `A/c No: ${safe.company.bank.accountNo}` : '',
      safe.company.bank?.bankName ? `Bank: ${safe.company.bank.bankName}` : '',
      safe.company.bank?.branchName ? `Branch: ${safe.company.bank.branchName}` : '',
      safe.company.bank?.ifscCode ? `IFSC: ${safe.company.bank.ifscCode}` : '',
    ].filter(Boolean).join('\n'),
    footerRightX + 10,
    footerTop + 52,
    { width: footerRightWidth - 20 },
  );

  doc.font('Helvetica-Bold').fontSize(10).fillColor(text).text('Authorized Signatory', footerRightX + 10, footerTop + 150, {
    width: footerRightWidth - 20,
    align: 'right',
  });
}
