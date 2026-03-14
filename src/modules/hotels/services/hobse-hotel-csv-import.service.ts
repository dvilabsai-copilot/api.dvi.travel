import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { PrismaService } from '../../../prisma.service';

interface ImportOptions {
  createMissingCities: boolean;
}

interface ImportSummary {
  totalRows: number;
  cityMappingsUpdated: number;
  cityMappingsSkipped: number;
  cityMappingsCreated: number;
  hotelsInserted: number;
  hotelsUpdated: number;
  hotelsSkipped: number;
  hotelsFailed: number;
  unmatchedCities: Array<{ cityName: string; cityId: string }>;
}

@Injectable()
export class HobseHotelCsvImportService {
  private readonly logger = new Logger(HobseHotelCsvImportService.name);

  private readonly CITY_ALIASES: Record<string, string> = {
    bangalore: 'bengaluru',
    bengaluru: 'bengaluru',
    gurgaon: 'gurugram',
    newdelhi: 'delhi',
    goa: 'goa',
    nathdwara: 'nathdwara',
    rameswaram: 'rameswaram',
    varanasi: 'varanasi',
    manali: 'manali',
    rishikesh: 'rishikesh',
  };

  constructor(private readonly prisma: PrismaService) {}

  async importFromFileBuffer(fileBuffer: Buffer, options: ImportOptions): Promise<ImportSummary> {
    if (!fileBuffer || fileBuffer.length === 0) {
      throw new BadRequestException('Uploaded file is empty');
    }

    const rows = this.readRows(fileBuffer);
    if (rows.length === 0) {
      throw new BadRequestException('No rows found in uploaded CSV/XLSX file');
    }

    const citySummary = await this.updateCityMappings(rows, options.createMissingCities);
    const hotelSummary = await this.upsertHotels(rows);

    return {
      totalRows: rows.length,
      cityMappingsUpdated: citySummary.updated,
      cityMappingsSkipped: citySummary.skipped,
      cityMappingsCreated: citySummary.created,
      hotelsInserted: hotelSummary.inserted,
      hotelsUpdated: hotelSummary.updated,
      hotelsSkipped: hotelSummary.skipped,
      hotelsFailed: hotelSummary.failed,
      unmatchedCities: citySummary.unmatchedCities,
    };
  }

  private readRows(fileBuffer: Buffer): Record<string, any>[] {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const firstSheetName = workbook.SheetNames[0];

    if (!firstSheetName) {
      throw new BadRequestException('Workbook does not contain any sheets');
    }

    const worksheet = workbook.Sheets[firstSheetName];
    return XLSX.utils.sheet_to_json(worksheet, {
      defval: '',
      raw: false,
    }) as Record<string, any>[];
  }

  private normalize(value: any): string {
    if (value === null || value === undefined) return '';
    return String(value).trim();
  }

  private normalizeCityName(value: any): string {
    return this.normalize(value).toLowerCase();
  }

  private normalizeCityKey(value: any): string {
    return this.normalizeCityName(value).replace(/[^a-z0-9]/g, '');
  }

  private getRowValue(row: Record<string, any>, keys: string[]): string {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(row, key)) {
        const value = this.normalize(row[key]);
        if (value) return value;
      }
    }
    return '';
  }

  private buildCityCandidates(cityName: string): string[] {
    const raw = this.normalize(cityName);
    if (!raw) return [];

    const beforeComma = raw.split(',')[0].trim();
    const rawKey = this.normalizeCityKey(raw);
    const beforeCommaKey = this.normalizeCityKey(beforeComma);
    const aliasFromRaw = this.CITY_ALIASES[rawKey];
    const aliasFromBeforeComma = this.CITY_ALIASES[beforeCommaKey];

    const candidates = [
      raw,
      this.normalizeCityName(raw),
      beforeComma,
      this.normalizeCityName(beforeComma),
      aliasFromRaw,
      aliasFromBeforeComma,
    ].filter(Boolean) as string[];

    return Array.from(new Set(candidates));
  }

  private async updateCityMappings(rows: Record<string, any>[], createMissingCities: boolean) {
    const summary = {
      updated: 0,
      skipped: 0,
      created: 0,
      unmatchedCities: [] as Array<{ cityName: string; cityId: string }>,
    };

    const processedKeys = new Set<string>();

    const allCities = await this.prisma.dvi_cities.findMany({
      where: { deleted: 0 },
      select: { id: true, name: true, hobse_city_code: true },
    });

    const cityByExact = new Map<string, { id: number; name: string; hobse_city_code: string | null }>();
    const cityByLower = new Map<string, { id: number; name: string; hobse_city_code: string | null }>();
    const cityByKey = new Map<string, { id: number; name: string; hobse_city_code: string | null }>();

    allCities.forEach((entry) => {
      const exact = this.normalize(entry.name);
      const lower = this.normalizeCityName(entry.name);
      const key = this.normalizeCityKey(entry.name);
      const mapped = { id: entry.id, name: entry.name, hobse_city_code: entry.hobse_city_code };

      if (exact && !cityByExact.has(exact)) cityByExact.set(exact, mapped);
      if (lower && !cityByLower.has(lower)) cityByLower.set(lower, mapped);
      if (key && !cityByKey.has(key)) cityByKey.set(key, mapped);
    });

    for (const row of rows) {
      const cityName = this.getRowValue(row, ['City Name', 'CityName', 'city_name', 'city']);
      const cityId = this.getRowValue(row, ['City Id', 'CityId', 'city_id', 'hobse_city_code']);

      if (!cityName || !cityId) {
        summary.skipped += 1;
        continue;
      }

      const dedupeKey = `${this.normalizeCityName(cityName)}::${cityId}`;
      if (processedKeys.has(dedupeKey)) continue;
      processedKeys.add(dedupeKey);

      const candidates = this.buildCityCandidates(cityName);
      let city = null as { id: number; name: string; hobse_city_code: string | null } | null;

      for (const candidate of candidates) {
        city =
          cityByExact.get(candidate) ||
          cityByLower.get(candidate) ||
          cityByKey.get(this.normalizeCityKey(candidate)) ||
          null;
        if (city) break;
      }

      if (!city) {
        if (createMissingCities) {
          const createName = this.normalize(cityName.split(',')[0]) || cityName;
          const createdCity = await this.prisma.dvi_cities.create({
            data: {
              name: createName,
              state_id: 0,
              hobse_city_code: cityId,
              status: 1,
              deleted: 0,
              createdon: new Date(),
            } as any,
            select: { id: true, name: true, hobse_city_code: true },
          });

          const mapped = {
            id: createdCity.id,
            name: createdCity.name,
            hobse_city_code: createdCity.hobse_city_code,
          };

          cityByExact.set(this.normalize(createdCity.name), mapped);
          cityByLower.set(this.normalizeCityName(createdCity.name), mapped);
          cityByKey.set(this.normalizeCityKey(createdCity.name), mapped);
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

      await this.prisma.dvi_cities.update({
        where: { id: city.id },
        data: { hobse_city_code: cityId } as any,
      });

      summary.updated += 1;
    }

    return summary;
  }

  private async upsertHotels(rows: Record<string, any>[]) {
    const summary = {
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
    };

    for (const row of rows) {
      const hotelCode = this.getRowValue(row, ['Hotel Id', 'HotelId', 'hotel_id', 'hotel_code']);
      const hotelName = this.getRowValue(row, ['Hotel Name', 'HotelName', 'hotel_name']);
      const hotelCity = this.getRowValue(row, ['City Name', 'CityName', 'city_name', 'city']);
      const hotelAddress = this.getRowValue(row, ['Address', 'address', 'Hotel Address', 'hotel_address']);

      if (!hotelCode || !hotelName || !hotelCity) {
        summary.skipped += 1;
        continue;
      }

      try {
        let existing = await this.prisma.dvi_hotel.findFirst({
          where: { hotel_code: hotelCode } as any,
          select: { hotel_id: true },
        });

        if (!existing) {
          existing = await this.prisma.dvi_hotel.findFirst({
            where: {
              hotel_name: hotelName,
              hotel_city: hotelCity,
              OR: [{ deleted: false }, { deleted: null }],
            } as any,
            select: { hotel_id: true },
          });
        }

        const DEFAULT_HOTEL_CATEGORY = 2;
        let hotelCategoryToSet = DEFAULT_HOTEL_CATEGORY;

        if (existing) {
          const existingFull = await this.prisma.dvi_hotel.findUnique({
            where: { hotel_id: existing.hotel_id },
            select: { hotel_category: true },
          });
          const existingCategory = Number((existingFull as any)?.hotel_category || 0);
          if (existingCategory > 0) {
            hotelCategoryToSet = existingCategory;
          }
        }

        const hotelData: any = {
          hotel_code: hotelCode,
          hotel_name: hotelName,
          hotel_city: hotelCity,
          hotel_address: hotelAddress || null,
          hotel_category: hotelCategoryToSet,
          status: 1,
          deleted: false,
        };

        if (existing) {
          await this.prisma.dvi_hotel.update({
            where: { hotel_id: existing.hotel_id },
            data: hotelData,
          });
          summary.updated += 1;
        } else {
          await this.prisma.dvi_hotel.create({
            data: {
              ...hotelData,
              createdon: new Date(),
              createdby: 0,
            },
          });
          summary.inserted += 1;
        }
      } catch (error: any) {
        summary.failed += 1;
        this.logger.error(`Failed to import hotel ${hotelName} (${hotelCode}): ${error?.message || error}`);
      }
    }

    return summary;
  }
}
