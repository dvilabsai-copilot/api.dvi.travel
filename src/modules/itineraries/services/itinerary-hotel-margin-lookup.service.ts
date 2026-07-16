import { Injectable } from '@nestjs/common';

export interface ItineraryHotelMarginLookupFilters {
  tboCodes: string[];
  resavenueCodes: string[];
  hobseCodes: string[];
  axisroomsHotelIds: number[];
  staahHotelIds: number[];
}

/** Loads and indexes master margin rows used by hotel-tab totals. */
@Injectable()
export class ItineraryHotelMarginLookupService {
  async load(input: {
    packages: Array<{ hotels: any[] }>;
    loadMasters: (filters: ItineraryHotelMarginLookupFilters) => Promise<any[]>;
  }): Promise<Map<string, any>> {
    const providerCodeSet = new Set<string>();
    for (const pkg of input.packages) {
      for (const hotel of pkg.hotels || []) {
        const provider = String(hotel?.provider || 'tbo').trim().toLowerCase();
        const hotelCode = String(hotel?.hotelCode || '').trim();
        if (provider && hotelCode) providerCodeSet.add(`${provider}|${hotelCode}`);
      }
    }

    const filters: ItineraryHotelMarginLookupFilters = {
      tboCodes: Array.from(providerCodeSet)
        .filter((key) => key.startsWith('tbo|'))
        .map((key) => key.slice('tbo|'.length)),
      resavenueCodes: Array.from(providerCodeSet)
        .filter((key) => key.startsWith('resavenue|'))
        .map((key) => key.slice('resavenue|'.length)),
      hobseCodes: Array.from(providerCodeSet)
        .filter((key) => key.startsWith('hobse|'))
        .map((key) => key.slice('hobse|'.length)),
      axisroomsHotelIds: Array.from(providerCodeSet)
        .filter((key) => key.startsWith('axisrooms|'))
        .map((key) => Number(key.slice('axisrooms|'.length)))
        .filter((id) => Number.isFinite(id) && id > 0),
      staahHotelIds: Array.from(providerCodeSet)
        .filter((key) => key.startsWith('staah|'))
        .map((key) => Number(key.slice('staah|'.length)))
        .filter((id) => Number.isFinite(id) && id > 0),
    };
    const rows = providerCodeSet.size ? await input.loadMasters(filters) : [];
    const indexed = new Map<string, any>();
    for (const row of rows) {
      const tboCode = String(row.tbo_hotel_code || '').trim();
      const resavenueCode = String(row.resavenue_hotel_code || '').trim();
      const hobseCode = String(row.hotel_code || '').trim();
      const hotelId = Number(row.hotel_id || 0);
      if (tboCode) indexed.set(`tbo|${tboCode}`, row);
      if (resavenueCode) indexed.set(`resavenue|${resavenueCode}`, row);
      if (hobseCode) indexed.set(`hobse|${hobseCode}`, row);
      if (hotelId > 0) indexed.set(`axisrooms|${hotelId}`, row);
      if (hotelId > 0) indexed.set(`staah|${hotelId}`, row);
    }
    return indexed;
  }
}
