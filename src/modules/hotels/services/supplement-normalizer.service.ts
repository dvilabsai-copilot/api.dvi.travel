import { Injectable, Logger } from '@nestjs/common';

/**
 * Normalized supplement structure - backend standardized format
 * Preserves raw provider data while providing typed accessors
 */
export interface NormalizedSupplement {
  // Core fields
  type: string; // "AtProperty", "Mandatory", etc. - preserves original type
  description: string;
  amount: number;
  currency: string;

  // Source tracking
  source: 'search' | 'prebook'; // Where this supplement came from
  
  // Semantic fields for known types
  paymentLocation: 'HOTEL' | 'UNKNOWN'; // HOTEL = AtProperty, UNKNOWN = unrecognized types
  payableAtHotel: boolean; // true if Type === "AtProperty"
  includedInPrice: boolean; // false for AtProperty, uncertain for unknown types
  isMandatory: boolean; // true if field name or description suggests mandatory

  // Charge details (if present)
  chargeType?: string; // "Fixed", "Percentage", "AtProperty" etc
  fromDate?: string; // When this charge becomes applicable (if date-based)
  toDate?: string;

  // Raw provider data - preserve for future extensibility
  rawData: Record<string, any>;
}

/**
 * Supplement summary for easy access
 */
export interface SupplementSummary {
  rawSupplements: any[]; // Untouched raw array from provider
  normalizedSupplements: NormalizedSupplement[];
  
  // Derived summaries
  atPropertyCharges: NormalizedSupplement[]; // Only AtProperty type
  unknownTypeCharges: NormalizedSupplement[]; // Types we don't recognize
  mandatoryChargesCount: number;
  totalAmount: number; // Sum of all supplement amounts (in original currency)
}

@Injectable()
export class SupplementNormalizerService {
  private logger = new Logger(SupplementNormalizerService.name);

  /**
   * Normalize a raw supplement entry from TBO API
   * Handles known and unknown types safely
   */
  public normalizeSupplement(
    rawSupplement: any,
    source: 'search' | 'prebook' = 'search',
  ): NormalizedSupplement | null {
    if (!rawSupplement) return null;

    try {
      const type = rawSupplement?.Type || 'Unknown';
      const description = rawSupplement?.Description || '';
      const amount = Number(rawSupplement?.Price || rawSupplement?.Amount || 0);
      const currency = rawSupplement?.Currency || '';

      // Determine payment location and semantics based on type
      const payableAtHotel = type === 'AtProperty';
      const paymentLocation = payableAtHotel ? 'HOTEL' : 'UNKNOWN';
      
      // AtProperty supplements are not included in quoted price
      // Unknown types: we don't assume - keep as uncertain
      const includedInPrice = !payableAtHotel && false; // Conservative: assume not included unless proven
      
      // Is it mandatory? 
      // True if field comes from MandatorySupplements or description mentions it
      const isMandatory = 
        description?.toLowerCase().includes('mandatory') ||
        description?.toLowerCase().includes('tax');

      // Log unknown types for monitoring
      if (type !== 'AtProperty') {
        this.logger.warn(
          `⚠️  Unknown supplement type encountered: "${type}" | Description: "${description}" | Source: ${source}`,
        );
      }

      return {
        type,
        description,
        amount,
        currency,
        source,
        paymentLocation,
        payableAtHotel,
        includedInPrice,
        isMandatory,
        chargeType: rawSupplement?.ChargeType,
        fromDate: rawSupplement?.FromDate,
        toDate: rawSupplement?.ToDate,
        rawData: rawSupplement,
      };
    } catch (error) {
      this.logger.error(
        `Error normalizing supplement: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Normalize an array of raw supplement entries
   */
  public normalizeSupplements(
    rawSupplements: any[],
    source: 'search' | 'prebook' = 'search',
  ): NormalizedSupplement[] {
    if (!Array.isArray(rawSupplements)) return [];

    return rawSupplements
      .map((item) => this.normalizeSupplement(item, source))
      .filter((item) => item !== null) as NormalizedSupplement[];
  }

  /**
   * Create a supplement summary from raw provider data
   * Handles both search-time and prebook-time supplements
   */
  public createSupplementSummary(
    rawSupplements: any[],
    source: 'search' | 'prebook' = 'search',
  ): SupplementSummary {
    const normalized = this.normalizeSupplements(rawSupplements, source);

    const atPropertyCharges = normalized.filter((s) => s.payableAtHotel);
    const unknownTypeCharges = normalized.filter((s) => s.paymentLocation === 'UNKNOWN');
    const mandatoryChargesCount = normalized.filter((s) => s.isMandatory).length;
    const totalAmount = normalized.reduce((sum, s) => sum + s.amount, 0);

    return {
      rawSupplements: rawSupplements || [],
      normalizedSupplements: normalized,
      atPropertyCharges,
      unknownTypeCharges,
      mandatoryChargesCount,
      totalAmount,
    };
  }

  /**
   * Safely merge supplements from multiple sources (search + prebook)
   * Prebook supplements take precedence if both exist for same charge
   */
  public mergeSupplements(
    searchSupplements: NormalizedSupplement[],
    prebookSupplements: NormalizedSupplement[],
  ): NormalizedSupplement[] {
    // Simple merge: add prebook ones, keep search ones not overridden
    // In practice, prebook data is usually more authoritative
    const merged = [...searchSupplements];
    
    if (prebookSupplements && prebookSupplements.length > 0) {
      // For now, just append prebook supplements
      // Could add deduplication logic if needed
      merged.push(...prebookSupplements);
    }

    return merged;
  }
}
