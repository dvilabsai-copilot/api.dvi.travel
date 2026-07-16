import { Injectable } from '@nestjs/common';

export interface GuestNationalityCallbacks {
  findById: (id: number) => Promise<any>;
  findByLegacyName: (name: string) => Promise<any>;
  legacyNameForId: (id: number) => string | undefined;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/** Resolves the TBO guest nationality code from the plan, country master and legacy fallbacks. */
@Injectable()
export class GuestNationalityService {
  async resolve(plan: any, callbacks: GuestNationalityCallbacks): Promise<string> {
    const nationalityId = Number(plan?.nationality ?? 0);
    const rawNationality = String(plan?.nationality ?? '').trim().toUpperCase();

    if (nationalityId > 0) {
      try {
        const iso2 = this.extractIso2(await callbacks.findById(nationalityId));
        if (iso2) {
          callbacks.log?.(`Resolved guestNationality from country table: nationality=${nationalityId} -> ${iso2}`);
          return iso2;
        }
      } catch (error) {
        callbacks.warn?.(`Could not resolve country mapping from table dvi_countries for nationality=${nationalityId}: ${this.errorMessage(error)}`);
      }
    }

    if (nationalityId >= 101 && nationalityId <= 295) {
      const legacyName = callbacks.legacyNameForId(nationalityId);
      if (legacyName) {
        try {
          const iso2 = this.extractIso2(await callbacks.findByLegacyName(legacyName));
          if (iso2) {
            callbacks.log?.(`Resolved guestNationality via legacy name lookup: nationality=${nationalityId} (${legacyName}) -> ${iso2}`);
            return iso2;
          }
        } catch (error) {
          callbacks.warn?.(`Legacy name lookup failed for "${legacyName}": ${this.errorMessage(error)}`);
        }
      }
    }

    if (/^[A-Z]{2}$/.test(rawNationality)) {
      callbacks.warn?.(`Using direct ISO-2 nationality from plan value: ${rawNationality}`);
      return rawNationality;
    }

    const envFallback = String(process.env.TBO_DEFAULT_GUEST_NATIONALITY || '').trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(envFallback)) {
      callbacks.warn?.(`Using TBO_DEFAULT_GUEST_NATIONALITY fallback: ${envFallback}`);
      return envFallback;
    }

    callbacks.warn?.('Unable to resolve guestNationality from plan/country table/env. Falling back to IN.');
    return 'IN';
  }

  private extractIso2(row: any): string | null {
    if (!row || typeof row !== 'object') return null;
    for (const value of [row.shortname, row.country_code, row.iso2, row.iso_code, row.sortname, row.alpha2, row.code]) {
      const normalized = String(value ?? '').trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(normalized)) return normalized;
    }
    return null;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
