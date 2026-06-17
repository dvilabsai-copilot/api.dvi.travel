import 'reflect-metadata';
import { chromium } from 'playwright';
import { PrismaService } from '../src/prisma.service';
import { ItinerariesService } from '../src/modules/itineraries/itineraries.service';
import { ItineraryPdfService } from '../src/modules/itineraries/itinerary-pdf.service';
import { renderTransportVoucherHtml } from '../src/modules/itineraries/templates/transport-voucher.template';

const pxToMm = (px) => Number((((px || 0) * 25.4) / 96).toFixed(2));

async function main() {
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const itineraryId = 9633;
    const itinerariesService = new ItinerariesService(
      prisma,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
    const pdfService = new ItineraryPdfService(itinerariesService, prisma);
    const data = await itinerariesService.getTransportVoucherDetails(itineraryId);
    const html = renderTransportVoucherHtml(data, pdfService['buildTransportVoucherAssets'](data));

    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    try {
      const page = await browser.newPage({ viewport: { width: 1240, height: 1754 }, deviceScaleFactor: 1 });
      await page.emulateMedia({ media: 'print' });
      await page.setContent(html, { waitUntil: 'networkidle' });
      await page.screenshot({ path: 'c:/tmp/vehicle-voucher-9633-polished.png', fullPage: true });

      const getBox = async (selector) => {
        const box = await page.locator(selector).boundingBox();
        return box ? { top: pxToMm(box.y), bottom: pxToMm(box.y + box.height), height: pxToMm(box.height) } : null;
      };

      const itinerarySection = await getBox('.itinerary-section');
      const footerGrid = await getBox('.footer-grid');
      const thankYou = await getBox('.thank-you');
      const rowCount = await page.locator('.itinerary-table tbody tr').count();
      const rows = [];
      for (let i = 0; i < rowCount; i += 1) {
        const box = await page.locator('.itinerary-table tbody tr').nth(i).boundingBox();
        if (box) rows.push({ top: pxToMm(box.y), bottom: pxToMm(box.y + box.height), height: pxToMm(box.height) });
      }

      const visibleRows = itinerarySection ? rows.filter((row) => row.bottom <= itinerarySection.bottom + 0.2).length : 0;
      const footerOverlap = itinerarySection && footerGrid
        ? !(itinerarySection.bottom <= footerGrid.top || footerGrid.bottom <= itinerarySection.top)
        : null;
      const thankYouBelowFooter = footerGrid && thankYou ? thankYou.top >= footerGrid.bottom - 0.2 : null;

      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
        preferCSSPageSize: true,
      });
      const pageCount = (pdfBuffer.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
      console.log(JSON.stringify({ pageCount, itinerarySection, footerGrid, thankYou, rowCount, visibleRows, footerOverlap, thankYouBelowFooter, rows }, null, 2));
    } finally {
      await browser.close();
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
