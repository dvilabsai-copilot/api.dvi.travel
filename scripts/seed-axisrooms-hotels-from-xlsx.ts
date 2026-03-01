// FILE: scripts/seed-axisrooms-hotels-from-xlsx.ts
// Import AxisRooms hotel mappings from Excel
// 
// Usage:
//   npx ts-node scripts/seed-axisrooms-hotels-from-xlsx.ts --file "South India.xlsx"
//   npx ts-node scripts/seed-axisrooms-hotels-from-xlsx.ts --file "South India.xlsx" --dryRun

import { PrismaClient } from '@prisma/client';
import * as XLSX from 'xlsx';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

interface ExcelRow {
  supplier_name: string;
  hotel_name: string;
  country: string;
  city: string;
  state: string;
}

interface ImportResult {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
}

interface ErrorRecord {
  row: number;
  hotel_name: string;
  city: string;
  error: string;
}

// Generate slug from text
function slugify(text: string): string {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')           // Replace spaces with -
    .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
    .replace(/\-\-+/g, '-')         // Replace multiple - with single -
    .replace(/^-+/, '')             // Trim - from start of text
    .replace(/-+$/, '');            // Trim - from end of text
}

// Generate deterministic AxisRooms property ID
function generatePropertyId(
  supplier: string,
  hotelName: string,
  city: string,
  state: string,
  country: string
): string {
  // Create stable hash input
  const hashInput = `${supplier}|${hotelName}|${city}|${state}|${country}`;
  const hash = crypto.createHash('sha1').update(hashInput).digest('hex').substring(0, 8);
  
  // Create readable prefix
  const hotelSlug = slugify(hotelName).substring(0, 20);
  const citySlug = slugify(city).substring(0, 15);
  
  return `AX_${hotelSlug}_${citySlug}_${hash}`;
}

// Parse command line arguments
function parseArgs(): { filePath: string; dryRun: boolean } {
  const args = process.argv.slice(2);
  let filePath = 'South India.xlsx';
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) {
      filePath = args[i + 1];
      i++;
    } else if (args[i] === '--dryRun') {
      dryRun = true;
    }
  }

  return { filePath, dryRun };
}

// Read Excel file and parse rows
function readExcelFile(filePath: string): ExcelRow[] {
  const absolutePath = path.isAbsolute(filePath) 
    ? filePath 
    : path.join(process.cwd(), filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  const workbook = XLSX.readFile(absolutePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json<any>(worksheet);

  return data.map((row, index) => {
    // Handle different possible column names (case-insensitive)
    const getColumn = (names: string[]): string => {
      for (const name of names) {
        const key = Object.keys(row).find(k => k.toLowerCase() === name.toLowerCase());
        if (key && row[key]) {
          return String(row[key]).trim();
        }
      }
      return '';
    };

    return {
      supplier_name: getColumn(['supplier_name', 'supplier', 'provider']),
      hotel_name: getColumn(['hotel_name', 'hotelname', 'name']),
      country: getColumn(['country']),
      city: getColumn(['city']),
      state: getColumn(['state']),
    };
  }).filter(row => row.hotel_name && row.city); // Filter out empty rows
}

// Process import
async function importHotels(dryRun: boolean): Promise<void> {
  const { filePath } = parseArgs();
  
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║    AxisRooms Hotel Import from Excel                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
  console.log(`📁 File: ${filePath}`);
  console.log(`🔧 Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE (will update database)'}\n`);

  // Read Excel
  console.log('📖 Reading Excel file...');
  const rows = readExcelFile(filePath);
  console.log(`✅ Found ${rows.length} rows\n`);

  // Initialize results
  const result: ImportResult = {
    total: rows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
  };

  const errors: ErrorRecord[] = [];
  const processedIds = new Set<string>();

  // Process each row
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNumber = i + 2; // Excel rows start at 1, header is row 1

    // Progress indicator
    if ((i + 1) % 100 === 0) {
      console.log(`📊 Progress: ${i + 1}/${rows.length} rows processed...`);
    }

    try {
      // Generate property ID
      const propertyId = generatePropertyId(
        row.supplier_name,
        row.hotel_name,
        row.city,
        row.state,
        row.country
      );

      // Check for duplicates in this import batch
      if (processedIds.has(propertyId)) {
        result.skipped++;
        continue;
      }
      processedIds.add(propertyId);

      if (dryRun) {
        // In dry run, just check if hotel exists
        const existingHotel = await prisma.dvi_hotel.findFirst({
          where: {
            hotel_name: row.hotel_name,
            hotel_city: row.city,
            hotel_state: row.state,
            hotel_country: row.country,
            deleted: { not: true },
          },
        });

        if (existingHotel) {
          result.updated++;
          console.log(`[DRY RUN] Would update: ${row.hotel_name} (${row.city}) -> ${propertyId}`);
        } else {
          result.created++;
          console.log(`[DRY RUN] Would create: ${row.hotel_name} (${row.city}) -> ${propertyId}`);
        }
      } else {
        // Live mode - perform actual database operations
        const existingHotel = await prisma.dvi_hotel.findFirst({
          where: {
            hotel_name: row.hotel_name,
            hotel_city: row.city,
            hotel_state: row.state,
            hotel_country: row.country,
            deleted: { not: true },
          },
        });

        if (existingHotel) {
          // Update existing hotel
          await prisma.dvi_hotel.update({
            where: { hotel_id: existingHotel.hotel_id },
            data: {
              axisrooms_property_id: propertyId,
              axisrooms_enabled: 1,
              status: 1,
              updatedon: new Date(),
            },
          });
          result.updated++;
          if (result.updated % 10 === 0) {
            console.log(`✅ Updated: ${row.hotel_name} (${row.city})`);
          }
        } else {
          // Create new hotel
          await prisma.dvi_hotel.create({
            data: {
              hotel_name: row.hotel_name,
              hotel_country: row.country,
              hotel_city: row.city,
              hotel_state: row.state,
              hotel_category: 1, // Default category
              axisrooms_property_id: propertyId,
              axisrooms_enabled: 1,
              status: 1,
              createdon: new Date(),
            },
          });
          result.created++;
          if (result.created % 10 === 0) {
            console.log(`✨ Created: ${row.hotel_name} (${row.city})`);
          }
        }
      }
    } catch (error) {
      result.errors++;
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push({
        row: rowNumber,
        hotel_name: row.hotel_name,
        city: row.city,
        error: errorMsg,
      });
      console.error(`❌ Error on row ${rowNumber} (${row.hotel_name}): ${errorMsg}`);
    }
  }

  // Print summary
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                    IMPORT SUMMARY                         ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
  console.log(`📊 Total rows:    ${result.total}`);
  console.log(`✨ Created:       ${result.created}`);
  console.log(`✅ Updated:       ${result.updated}`);
  console.log(`⏭️  Skipped:       ${result.skipped}`);
  console.log(`❌ Errors:        ${result.errors}\n`);

  // Write report
  const outputDir = path.join(process.cwd(), 'scripts', 'output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(outputDir, `axisrooms_import_report_${timestamp}.json`);
  
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        mode: dryRun ? 'dry-run' : 'live',
        file: filePath,
        result,
        errors: errors.length > 0 ? errors : undefined,
      },
      null,
      2
    )
  );
  console.log(`📄 Report saved to: ${reportPath}`);

  // Write errors CSV if any
  if (errors.length > 0) {
    const errorsCsvPath = path.join(outputDir, `axisrooms_import_errors_${timestamp}.csv`);
    const csvHeader = 'row,hotel_name,city,error\n';
    const csvRows = errors.map(e => 
      `${e.row},"${e.hotel_name.replace(/"/g, '""')}","${e.city.replace(/"/g, '""')}","${e.error.replace(/"/g, '""')}"`
    ).join('\n');
    fs.writeFileSync(errorsCsvPath, csvHeader + csvRows);
    console.log(`📄 Error report saved to: ${errorsCsvPath}`);
  }

  console.log('\n✨ Import complete!\n');
}

// Main execution
async function main() {
  try {
    const { dryRun } = parseArgs();
    await importHotels(dryRun);
  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
