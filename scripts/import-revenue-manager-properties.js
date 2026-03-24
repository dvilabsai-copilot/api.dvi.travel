const path = require('path');
const XLSX = require('xlsx');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function parseArgs() {
  const args = process.argv.slice(2);
  let file = 'Revenue Manager Properties-3.xls';

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--file' && args[i + 1]) {
      file = args[i + 1];
      i += 1;
    }
  }

  return { file };
}

function readProperties(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  const parsed = rows
    .map((row) => {
      const propId = String(row.__EMPTY || '').trim();
      const propertyName = String(row.__EMPTY_1 || '').trim();
      const city = String(row['Properties Details'] || '').trim();
      const country = String(row.__EMPTY_2 || '').trim();

      const numericId = /^\d+$/.test(propId) ? propId : '';
      if (!numericId || !propertyName || !city) return null;

      return {
        propId: numericId,
        propertyName,
        city,
        country: country || 'India',
      };
    })
    .filter(Boolean);

  return parsed;
}

async function upsertProperty(p) {
  const existing = await prisma.dvi_hotel.findFirst({
    where: {
      OR: [
        { resavenue_hotel_code: p.propId },
        {
          hotel_name: p.propertyName,
          hotel_city: p.city,
        },
      ],
    },
  });

  if (existing) {
    await prisma.dvi_hotel.update({
      where: { hotel_id: existing.hotel_id },
      data: {
        hotel_name: p.propertyName,
        hotel_city: p.city,
        hotel_country: p.country,
        resavenue_hotel_code: p.propId,
        hotel_code: existing.hotel_code || `RESAVENUE-${p.propId}`,
        status: 1,
        deleted: false,
        updatedon: new Date(),
      },
    });
    return 'updated';
  }

  await prisma.dvi_hotel.create({
    data: {
      hotel_name: p.propertyName,
      hotel_code: `RESAVENUE-${p.propId}`,
      hotel_city: p.city,
      hotel_state: '',
      hotel_country: p.country,
      hotel_address: '',
      hotel_category: 2,
      resavenue_hotel_code: p.propId,
      status: 1,
      deleted: false,
      createdon: new Date(),
    },
  });

  return 'created';
}

async function main() {
  const { file } = parseArgs();
  const filePath = path.isAbsolute(file) ? file : path.join(process.cwd(), file);

  const properties = readProperties(filePath);
  if (!properties.length) {
    throw new Error('No valid property rows found in XLS.');
  }

  let created = 0;
  let updated = 0;

  for (const p of properties) {
    const result = await upsertProperty(p);
    if (result === 'created') created += 1;
    if (result === 'updated') updated += 1;
  }

  const uniqueCities = [...new Set(properties.map((p) => p.city))].sort((a, b) => a.localeCompare(b));

  console.log('Import complete.');
  console.log(JSON.stringify({
    file: filePath,
    totalRows: properties.length,
    created,
    updated,
    uniqueCities,
  }, null, 2));
}

main()
  .catch((err) => {
    console.error('Import failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
