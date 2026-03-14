require('dotenv').config();

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const CREATE_MISSING_CITIES = process.argv.includes('--create-missing-cities');

const DEFAULT_WORKBOOK_PATHS = [
  process.env.JUSTA_XLSX_PATH,
  '/mnt/data/Justa Active Hotels City Details.xlsx',
  path.join(process.cwd(), 'Justa Active Hotels City Details.xlsx'),
  path.join(process.cwd(), 'uploads', 'Justa Active Hotels City Details.xlsx'),
].filter(Boolean);

function resolveWorkbookPath() {
  const workbookPath = DEFAULT_WORKBOOK_PATHS.find((candidate) => fs.existsSync(candidate));

  if (!workbookPath) {
    throw new Error(
      `Workbook not found. Checked: ${DEFAULT_WORKBOOK_PATHS.join(', ')}. ` +
        'Set JUSTA_XLSX_PATH to the Excel file location if needed.',
    );
  }

  return workbookPath;
}

function normalizeValue(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
}

function normalizeCityName(value) {
  return normalizeValue(value).toLowerCase();
}

const CITY_ALIASES = {
  bangalore: 'bengaluru',
  bengaluru: 'bengaluru',
  gurgaon: 'gurugram',
  newdelhi: 'delhi',
  nathdwara: 'nathdwara',
  mussoorie: 'mussoorie',
  rameswaram: 'rameswaram',
  ahmedabad: 'ahmedabad',
  varanasi: 'varanasi',
  manali: 'manali',
  rishikesh: 'rishikesh',
  goa: 'goa',
};

function normalizeCityKey(value) {
  return normalizeCityName(value).replace(/[^a-z0-9]/g, '');
}

function buildCityCandidates(cityName) {
  const raw = normalizeValue(cityName);
  if (!raw) {
    return [];
  }

  const beforeComma = raw.split(',')[0].trim();
  const rawKey = normalizeCityKey(raw);
  const beforeCommaKey = normalizeCityKey(beforeComma);
  const aliasFromRaw = CITY_ALIASES[rawKey];
  const aliasFromBeforeComma = CITY_ALIASES[beforeCommaKey];

  const candidates = [
    raw,
    normalizeCityName(raw),
    beforeComma,
    normalizeCityName(beforeComma),
    aliasFromRaw,
    aliasFromBeforeComma,
  ].filter(Boolean);

  return Array.from(new Set(candidates));
}

function readRows(workbookPath) {
  const workbook = XLSX.readFile(workbookPath);
  const firstSheetName = workbook.SheetNames[0];

  if (!firstSheetName) {
    throw new Error('Workbook does not contain any sheets.');
  }

  const worksheet = workbook.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_json(worksheet, {
    defval: '',
    raw: false,
  });
}

function getRowValue(row, key) {
  return normalizeValue(row[key]);
}

async function updateCityMappings(rows) {
  const summary = {
    updated: 0,
    skipped: 0,
    created: 0,
    unmatchedCities: [],
  };

  const processedKeys = new Set();
  const allCities = await prisma.dvi_cities.findMany({
    where: {
      deleted: 0,
    },
    select: {
      id: true,
      name: true,
      hobse_city_code: true,
    },
  });

  const cityByExact = new Map();
  const cityByLower = new Map();
  const cityByKey = new Map();

  allCities.forEach((entry) => {
    const exact = normalizeValue(entry.name);
    const lower = normalizeCityName(entry.name);
    const key = normalizeCityKey(entry.name);

    if (exact && !cityByExact.has(exact)) {
      cityByExact.set(exact, entry);
    }
    if (lower && !cityByLower.has(lower)) {
      cityByLower.set(lower, entry);
    }
    if (key && !cityByKey.has(key)) {
      cityByKey.set(key, entry);
    }
  });

  for (const row of rows) {
    const cityName = getRowValue(row, 'City Name');
    const cityId = getRowValue(row, 'City Id');

    if (!cityName || !cityId) {
      summary.skipped += 1;
      continue;
    }

    const dedupeKey = `${normalizeCityName(cityName)}::${cityId}`;
    if (processedKeys.has(dedupeKey)) {
      continue;
    }
    processedKeys.add(dedupeKey);

    const candidates = buildCityCandidates(cityName);

    let city = null;
    for (const candidate of candidates) {
      city =
        cityByExact.get(candidate) ||
        cityByLower.get(candidate) ||
        cityByKey.get(normalizeCityKey(candidate)) ||
        null;

      if (city) {
        break;
      }
    }

    if (!city) {
      if (CREATE_MISSING_CITIES) {
        const createName = normalizeValue(cityName.split(',')[0]) || cityName;
        const createdCity = await prisma.dvi_cities.create({
          data: {
            name: createName,
            state_id: 0,
            hobse_city_code: cityId,
            status: 1,
            deleted: 0,
            createdon: new Date(),
          },
          select: {
            id: true,
            name: true,
            hobse_city_code: true,
          },
        });

        cityByExact.set(normalizeValue(createdCity.name), createdCity);
        cityByLower.set(normalizeCityName(createdCity.name), createdCity);
        cityByKey.set(normalizeCityKey(createdCity.name), createdCity);
        summary.created += 1;
        continue;
      }

      summary.unmatchedCities.push({ cityName, cityId });
      continue;
    }

    if (city.hobse_city_code === cityId) {
      summary.skipped += 1;
      continue;
    }

    await prisma.dvi_cities.update({
      where: { id: city.id },
      data: {
        hobse_city_code: cityId,
      },
    });

    summary.updated += 1;
  }

  return summary;
}

async function upsertHotels(rows) {
  const summary = {
    totalRows: rows.length,
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  };

  for (const row of rows) {
    const hotelCode = getRowValue(row, 'Hotel Id');
    const hotelName = getRowValue(row, 'Hotel Name');
    const hotelCity = getRowValue(row, 'City Name');
    const hotelAddress = getRowValue(row, 'Address');

    if (!hotelCode || !hotelName || !hotelCity) {
      summary.skipped += 1;
      continue;
    }

    try {
      let existing = await prisma.dvi_hotel.findFirst({
        where: {
          hotel_code: hotelCode,
        },
        select: {
          hotel_id: true,
        },
      });

      if (!existing) {
        existing = await prisma.dvi_hotel.findFirst({
          where: {
            hotel_name: hotelName,
            hotel_city: hotelCity,
            OR: [{ deleted: false }, { deleted: null }],
          },
          select: {
            hotel_id: true,
          },
        });
      }

      // Default category 2 (Mid-Range); preserve if existing record already has a valid category
      const DEFAULT_HOTEL_CATEGORY = 2;
      let hotelCategoryToSet = DEFAULT_HOTEL_CATEGORY;
      if (existing) {
        const existingFull = await prisma.dvi_hotel.findUnique({
          where: { hotel_id: existing.hotel_id },
          select: { hotel_category: true },
        });
        const existingCategory = Number(existingFull?.hotel_category || 0);
        if (existingCategory > 0) {
          hotelCategoryToSet = existingCategory;
        }
      }

      const hotelData = {
        hotel_code: hotelCode,
        hotel_name: hotelName,
        hotel_city: hotelCity,
        hotel_address: hotelAddress || null,
        hotel_category: hotelCategoryToSet,
        status: 1,
        deleted: false,
      };

      if (existing) {
        await prisma.dvi_hotel.update({
          where: { hotel_id: existing.hotel_id },
          data: hotelData,
        });
        summary.updated += 1;
      } else {
        await prisma.dvi_hotel.create({
          data: {
            ...hotelData,
            createdon: new Date(),
            createdby: 0,
          },
        });
        summary.inserted += 1;
      }
    } catch (error) {
      summary.failed += 1;
      console.error(`Failed to import hotel ${hotelName} (${hotelCode}):`, error.message || error);
    }
  }

  return summary;
}

async function main() {
  const workbookPath = resolveWorkbookPath();
  const rows = readRows(workbookPath);

  console.log(`Using workbook: ${workbookPath}`);
  console.log(`Rows loaded: ${rows.length}`);

  const citySummary = await updateCityMappings(rows);
  const hotelSummary = await upsertHotels(rows);

  console.log('');
  console.log('Import summary');
  console.log(`Total rows: ${hotelSummary.totalRows}`);
  console.log(`Inserted: ${hotelSummary.inserted}`);
  console.log(`Updated: ${hotelSummary.updated}`);
  console.log(`Skipped: ${hotelSummary.skipped}`);
  console.log(`Failed: ${hotelSummary.failed}`);
  console.log(`City mappings updated: ${citySummary.updated}`);
  console.log(`City mappings skipped: ${citySummary.skipped}`);
  console.log(`City mappings created: ${citySummary.created}`);
  console.log(`Create missing cities mode: ${CREATE_MISSING_CITIES ? 'ON' : 'OFF'}`);

  if (citySummary.unmatchedCities.length > 0) {
    console.log('');
    console.log('Unmatched cities:');
    citySummary.unmatchedCities.forEach(({ cityName, cityId }) => {
      console.log(`- ${cityName} (${cityId})`);
    });
  }
}

main()
  .catch((error) => {
    console.error('Justa hotel import failed:', error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });