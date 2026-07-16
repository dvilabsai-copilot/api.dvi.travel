import { Injectable } from '@nestjs/common';

export interface HotelCityCodeCallbacks {
  loadCities: () => Promise<Array<{ name: string; tbo_city_code?: string | null }>>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface HobseCityCodeCallbacks {
  loadCities: () => Promise<Array<{ name: string; hobse_city_code?: string | null }>>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/** Resolves itinerary destinations to TBO city codes with the legacy aliases and fallbacks. */
@Injectable()
export class ItineraryHotelCityCodeService {
  private readonly cityAliases: Record<string, string[]> = {
    cochin: ['kochi'],
    alleppey: ['alappuzha'],
    alleppe: ['alappuzha'],
    calicut: ['kozhikode'],
    trivandrum: ['thiruvananthapuram'],
    pondicherry: ['puducherry'],
    bangalore: ['bengaluru'],
  };

  async map(
    routes: any[],
    callbacks: HotelCityCodeCallbacks,
  ): Promise<Record<string, string>> {
    const cityCodeMap: Record<string, string> = {};
    const log = callbacks.log || (() => undefined);
    const warn = callbacks.warn || (() => undefined);
    const uniqueDestinations = [...new Set(routes.map((route) => route?.next_visiting_location))];

    log(`Extracting city codes for ${uniqueDestinations.length} unique destinations`);
    if (uniqueDestinations.length === 0) return cityCodeMap;

    const allCities = await callbacks.loadCities();
    log(`Loaded ${allCities.length} cities from database in single query`);

    const cityNameMap: Record<string, string> = {};
    const cityPrefixMap: Record<string, string> = {};
    for (const city of allCities) {
      if (!city.tbo_city_code) continue;

      const lowerName = String(city.name || '').toLowerCase();
      if (!cityNameMap[lowerName]) cityNameMap[lowerName] = city.tbo_city_code;

      const prefix = String(city.name || '').split(',')[0].trim().toUpperCase();
      if (!cityPrefixMap[prefix]) cityPrefixMap[prefix] = city.tbo_city_code;
    }

    for (const destination of uniqueDestinations) {
      if (!destination) continue;

      const rawDestination = String(destination).trim();
      const firstPart = rawDestination.split(/[,\(\-]/)[0].trim();
      const normalizedToken = this.normalizeCityToken(rawDestination);
      const aliasTokens = this.cityAliases[normalizedToken] || [];
      const lookupTerms = Array.from(
        new Set(
          [
            normalizedToken,
            ...aliasTokens,
            rawDestination.toLowerCase(),
            firstPart.toLowerCase(),
          ].filter(Boolean),
        ),
      );

      let cityCode = '';
      for (const term of lookupTerms) {
        cityCode = cityNameMap[term];
        if (cityCode) break;
      }

      if (!cityCode) {
        const prefixTerms = Array.from(
          new Set([firstPart, normalizedToken, ...aliasTokens].map((value) => value.toUpperCase())),
        );
        for (const prefix of prefixTerms) {
          cityCode = cityPrefixMap[prefix];
          if (cityCode) break;
        }
      }

      if (cityCode) {
        if (normalizedToken !== firstPart.toLowerCase() || aliasTokens.length > 0) {
          log(`"${destination}" -> TBO Code: ${cityCode} (preferred lookup: ${[normalizedToken, ...aliasTokens].join(' -> ')})`);
        } else {
          log(`"${destination}" -> TBO Code: ${cityCode}`);
        }
        cityCodeMap[destination] = cityCode;
      } else {
        warn(`No city code found for: "${destination}"`);
      }
    }

    return cityCodeMap;
  }

  async mapHobse(
    routes: any[],
    callbacks: HobseCityCodeCallbacks,
  ): Promise<Record<string, string>> {
    const cityCodeMap: Record<string, string> = {};
    const log = callbacks.log || (() => undefined);
    const warn = callbacks.warn || (() => undefined);
    const uniqueDestinations = [...new Set(routes.map((route) => route?.next_visiting_location))] as string[];

    log(`Loading HOBSE city codes for ${uniqueDestinations.length} unique destinations`);
    if (uniqueDestinations.length === 0) return cityCodeMap;

    const allCities = await callbacks.loadCities();
    log(`Loaded ${allCities.length} cities for HOBSE code lookup`);

    const cityNameMap: Record<string, string> = {};
    const cityPrefixMap: Record<string, string> = {};
    for (const city of allCities) {
      if (!city.hobse_city_code) continue;
      cityNameMap[String(city.name || '').toLowerCase()] = String(city.hobse_city_code);
      const prefix = String(city.name || '').split(',')[0].trim().toLowerCase();
      cityPrefixMap[prefix] = String(city.hobse_city_code);
    }

    for (const destination of uniqueDestinations) {
      if (!destination) continue;
      const lower = destination.toLowerCase();
      let code = cityNameMap[lower];

      if (!code) {
        const firstPart = destination.split(/[,\(\-]/)[0].trim().toLowerCase();
        code = cityNameMap[firstPart] || cityPrefixMap[firstPart];
      }

      if (code) {
        log(`HOBSE "${destination}" -> code: ${code}`);
        cityCodeMap[destination] = code;
      } else {
        warn(`No HOBSE city code found for: "${destination}"`);
      }
    }

    return cityCodeMap;
  }

  private normalizeCityToken(value: string): string {
    const token = String(value || '')
      .trim()
      .toLowerCase()
      .split(/[,\(\-]/)[0]
      .trim();
    return this.cityAliases[token]?.[0] || token;
  }
}
