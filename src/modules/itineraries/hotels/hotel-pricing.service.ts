// FILE: src/modules/itineraries/services/hotel-pricing.service.ts
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../prisma.service";

type DayCol =
  | "day_1" | "day_2" | "day_3" | "day_4" | "day_5" | "day_6" | "day_7" | "day_8" | "day_9" | "day_10"
  | "day_11" | "day_12" | "day_13" | "day_14" | "day_15" | "day_16" | "day_17" | "day_18" | "day_19" | "day_20"
  | "day_21" | "day_22" | "day_23" | "day_24" | "day_25" | "day_26" | "day_27" | "day_28" | "day_29" | "day_30"
  | "day_31";

function dayCol(d: Date): DayCol {
  // Use getDate (calendar day) like PHP/MySQL
  return `day_${d.getDate()}` as DayCol;
}

function monthName(d: Date) {
  return d.toLocaleString("en-US", { month: "long" });
}

function N(v: any) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

@Injectable()
export class HotelPricingService {
  // Removed Logger for performance

  constructor(private readonly prisma: PrismaService) {}

  /** Simple money round (2 decimals) */
  money(v: any) {
    const n = Number(v ?? 0);
    if (!Number.isFinite(n)) return 0;
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  /**
   * PHP GST split logic:
   * gstType: 1 = inclusive, 2 = exclusive
   * Returns { amount (before GST), tax }
   */
  splitGST(
    gross: number,
    gstPct: number,
    gstType: number,
  ) {
    const g = this.money(gross);
    const pct = Number(gstPct ?? 0);

    if (g <= 0 || pct <= 0) {
      return { amount: this.money(g), tax: 0 };
    }

    if (gstType === 1) {
      // Inclusive: gross already includes GST
      const base = g / (1 + pct / 100);
      const baseRounded = this.money(base);
      const tax = this.money(g - baseRounded);
      return { amount: baseRounded, tax };
    }

    // Exclusive: GST on top of gross
    const tax = this.money((g * pct) / 100);
    return { amount: g, tax };
  }

  /**
   * Check if a hotel has at least one non-zero room rate for the given date.
   * PHP filters hotels this way to ensure valid pricing exists.
   */
  async hasValidRates(hotel_id: number, onDate: Date): Promise<boolean> {
    const dc = dayCol(onDate);
    const y = String(onDate.getFullYear());
    const m = monthName(onDate);

    const rows: any[] = await this.prisma.dvi_hotel_room_price_book.findMany({
      where: { 
        hotel_id, 
        year: y, 
        month: m,
        [dc]: { gt: 0 } // Only get rows where day_X > 0
      },
      select: { room_id: true },
      take: 1,
    });

    return rows.length > 0;
  }

  /**
   * Hotel picker:
   * - Filters by category
   * - Tries exact city match (case insensitive) if provided
   * - Falls back to any hotel in that category
   * - NOW: Only picks hotels with valid (non-zero) rates for the date
   */
  async pickHotelByCategory(hotel_category: number, city?: string | null, onDate?: Date) {
    const hotelCategory = Number(hotel_category) || 0;
    const cityTrim = (city ?? "").trim();
    const whereBase: any = { hotel_category: hotelCategory, deleted: false, status: 1 };

    let targetStateId: string | null = null;

    if (cityTrim) {
      // 1. Try to resolve city name to ID
      const { candidates, stateId } = await this.resolveCityCandidates(cityTrim);
      targetStateId = stateId;

      for (const c of candidates) {
        const hotels = await this.prisma.dvi_hotel.findMany({
          where: { ...whereBase, hotel_city: c },
          select: {
            hotel_id: true,
            hotel_margin: true,
            hotel_margin_gst_type: true,
            hotel_margin_gst_percentage: true,
            hotel_hotspot_status: true,
            hotel_city: true,
            hotel_state: true,
          },
        });

        if (hotels.length > 0) {
          // Filter hotels to only those with valid rates for the date
          if (onDate) {
            const validHotels = [];
            for (const h of hotels) {
              const hasRates = await this.hasValidRates(h.hotel_id, onDate);
              if (hasRates) {
                validHotels.push(h);
              }
            }
            if (validHotels.length > 0) {
              const hotel = validHotels[Math.floor(Math.random() * validHotels.length)];
              return hotel;
            }
          } else {
            const hotel = hotels[Math.floor(Math.random() * hotels.length)];
            return hotel;
          }
        }
      }
    }

    // 2. Fallback: Try hotels in the same STATE (if city search failed but we have a state)
    if (targetStateId) {
      const stateHotels = await this.prisma.dvi_hotel.findMany({
        where: { ...whereBase, hotel_state: targetStateId },
        select: {
          hotel_id: true,
          hotel_margin: true,
          hotel_margin_gst_type: true,
          hotel_margin_gst_percentage: true,
          hotel_hotspot_status: true,
          hotel_city: true,
          hotel_state: true,
        },
      });

      if (stateHotels.length > 0) {
        if (onDate) {
          const validStateHotels = [];
          for (const h of stateHotels) {
            if (await this.hasValidRates(h.hotel_id, onDate)) {
              validStateHotels.push(h);
            }
          }
          if (validStateHotels.length > 0) {
            return validStateHotels[Math.floor(Math.random() * validStateHotels.length)];
          }
        } else {
          return stateHotels[Math.floor(Math.random() * stateHotels.length)];
        }
      }
    }

    // 3. Final Fallback: Any hotel in category (only if city and state search failed)
    const fallbacks = await this.prisma.dvi_hotel.findMany({
      where: whereBase,
      select: {
        hotel_id: true,
        hotel_margin: true,
        hotel_margin_gst_type: true,
        hotel_margin_gst_percentage: true,
        hotel_hotspot_status: true,
        hotel_city: true,
        hotel_state: true,
      },
    });

    if (fallbacks.length > 0) {
      // Filter fallback hotels by valid rates
      if (onDate) {
        const validFallbacks = [];
        for (const h of fallbacks) {
          if (await this.hasValidRates(h.hotel_id, onDate)) {
            validFallbacks.push(h);
          }
        }
        if (validFallbacks.length > 0) {
          const selected = validFallbacks[Math.floor(Math.random() * validFallbacks.length)];
          return selected;
        }
        // No hotels with valid rates found at all
        return null;
      }
      // No date filtering
      const selected = fallbacks[Math.floor(Math.random() * fallbacks.length)];
      return selected;
    }

    return null;
  }

  /**
   * Get MULTIPLE hotels by category (for user selection)
   * - Filters by category
   * - Returns all hotels matching the city (or state fallback)
   * - Sorted by lowest price first
   * - Max 10 results
   */
  async getHotelsByCategory(hotel_category: number, city?: string | null, onDate?: Date, limit: number = 10) {
    const hotelCategory = Number(hotel_category) || 0;
    const cityTrim = (city ?? "").trim();
    const whereBase: any = { hotel_category: hotelCategory, deleted: false, status: 1 };

    let targetStateId: string | null = null;
    let allHotels: any[] = [];

    if (cityTrim) {
      // 1. Try to resolve city name to ID
      const { candidates, stateId } = await this.resolveCityCandidates(cityTrim);
      targetStateId = stateId;

      for (const c of candidates) {
        const hotels = await this.prisma.dvi_hotel.findMany({
          where: { ...whereBase, hotel_city: c },
          select: {
            hotel_id: true,
            hotel_name: true,
            hotel_margin: true,
            hotel_margin_gst_type: true,
            hotel_margin_gst_percentage: true,
            hotel_hotspot_status: true,
            hotel_city: true,
            hotel_state: true,
          },
        });

        if (hotels.length > 0) {
          allHotels = allHotels.concat(hotels);
        }
      }
    }

    // 2. If no city match, try state fallback
    // 1b. If no hotels found with preferred category in city, try ANY category in city
    if (allHotels.length === 0 && cityTrim) {
      const { candidates: candidatesAny } = await this.resolveCityCandidates(cityTrim);
      const whereAny: any = { deleted: false, status: 1 };
      for (const c of candidatesAny) {
        const hotels = await this.prisma.dvi_hotel.findMany({
          where: { ...whereAny, hotel_city: c },
          select: {
            hotel_id: true,
            hotel_name: true,
            hotel_margin: true,
            hotel_margin_gst_type: true,
            hotel_margin_gst_percentage: true,
            hotel_hotspot_status: true,
            hotel_city: true,
            hotel_state: true,
          },
        });
        if (hotels.length > 0) {
          allHotels = allHotels.concat(hotels);
        }
      }
    }

    // 2. If no city match, try state fallback
    if (allHotels.length === 0 && targetStateId) {
      const stateHotels = await this.prisma.dvi_hotel.findMany({
        where: { ...whereBase, hotel_state: targetStateId },
        select: {
          hotel_id: true,
          hotel_name: true,
          hotel_margin: true,
          hotel_margin_gst_type: true,
          hotel_margin_gst_percentage: true,
          hotel_hotspot_status: true,
          hotel_city: true,
          hotel_state: true,
        },
      });
      allHotels = stateHotels;
    }

    // 3. Final fallback: any hotel in category
    if (allHotels.length === 0) {
      allHotels = await this.prisma.dvi_hotel.findMany({
        where: whereBase,
        select: {
          hotel_id: true,
          hotel_name: true,
          hotel_margin: true,
          hotel_margin_gst_type: true,
          hotel_margin_gst_percentage: true,
          hotel_hotspot_status: true,
          hotel_city: true,
          hotel_state: true,
        },
      });
    }

    // Filter by valid rates if date provided
    if (onDate && allHotels.length > 0) {
      const validHotels = [];
      for (const h of allHotels) {
        const hasRates = await this.hasValidRates(h.hotel_id, onDate);
        if (hasRates) {
          validHotels.push(h);
        }
      }
      allHotels = validHotels;
    }

    return allHotels.slice(0, limit);
  }

  /**
   * Room prices for that date from dvi_hotel_room_price_book.
   * We return ALL room rows, PHP will typically pick the first non-zero rate.
   * GST for rooms is stored elsewhere → gstPct=0, gstType=2 (exclusive) for now.
   */
  async getRoomPrices(hotel_id: number, onDate: Date) {
    const dc = dayCol(onDate);
    const y = String(onDate.getFullYear());
    const m = monthName(onDate);

    const rows: any[] = await this.prisma.dvi_hotel_room_price_book.findMany({
      where: { hotel_id, year: y, month: m },
      select: { room_id: true, [dc]: true } as any,
      orderBy: { room_id: "asc" },
    });

    const mapped = rows.map((r) => ({
      room_id: N(r.room_id),
      rate: N(r[dc]),
      gstPct: 0,
      gstType: 2,
    }));

    // Debug log removed for performance
    return mapped;
  }

  private async resolveCityCandidates(cityStr: string): Promise<{ candidates: string[], stateId: string | null }> {
    const candidates: string[] = [];
    let stateId: string | null = null;
    if (!cityStr) return { candidates, stateId };

    const cityTrim = cityStr.trim();

    // 1. Try exact match or split by comma, parenthesis, or hyphen
    const cityName = cityTrim.split(/[,\(\-]/)[0].trim();

    // 2. Clean up common suffixes
    let cleanCity = cityName
      .replace(/International Airport/gi, "")
      .replace(/Domestic Airport/gi, "")
      .replace(/Airport/gi, "")
      .replace(/Railway Station/gi, "")
      .trim();

    // 2b. Handle common aliases
    const aliases: Record<string, string> = {
      'Trichy': 'Thiruchirapalli',
      'Tiruchirappalli': 'Thiruchirapalli',
      'Trivandrum': 'Thiruvananthapuram',
      'Cochin': 'Kochi',
      'Calicut': 'Kozhikode',
      'Ooty': 'Udhagamandalam',
      'Pondicherry': 'Puducherry',
      'Banaras': 'Varanasi',
      'Bombay': 'Mumbai',
      'Madras': 'Chennai',
      'Bangalore': 'Bengaluru',
      'Alleppey': 'Alappuzha',
      'Mangaluru': 'Mangalore',
      'Guruvayoor': 'Guruvayur',
    };

    if (aliases[cleanCity]) {
      cleanCity = aliases[cleanCity];
    }

    // 3. Search in dvi_cities
    const cityRecords = await this.prisma.dvi_cities.findMany({
      where: {
        OR: [
          { name: { equals: cityName } },
          { name: { equals: cleanCity } },
          { name: { contains: cleanCity } },
        ],
        deleted: 0,
      },
      select: { id: true, name: true, state_id: true },
    });

    if (cityRecords.length > 0) {
      // Sort by exact match first
      cityRecords.sort((a, b) => {
        const aName = a.name.toLowerCase();
        const bName = b.name.toLowerCase();
        const targetName = cityName.toLowerCase();
        const targetClean = cleanCity.toLowerCase();

        if (aName === targetName) return -1;
        if (bName === targetName) return 1;
        if (aName === targetClean) return -1;
        if (bName === targetClean) return 1;
        return 0;
      });

      cityRecords.forEach((r) => candidates.push(String(r.id)));
      stateId = String(cityRecords[0].state_id);
    }

    // Always include the strings as fallback
    candidates.push(cityTrim);
    candidates.push(cityName);
    if (cleanCity !== cityName) candidates.push(cleanCity);

    return { candidates: [...new Set(candidates)], stateId };
  }

  /**
   * Meal prices for that date from dvi_hotel_meal_price_book.
   * Schema only has a single price per day, no GST columns → gstPct=0.
   * We use it as BREAKFAST price (matching your sample rows where only breakfast is non-zero).
   */
  async getMealPrice(hotel_id: number, onDate: Date) {
    const dc = dayCol(onDate);
    const y = String(onDate.getFullYear());
    const m = monthName(onDate);

    const row: any = await this.prisma.dvi_hotel_meal_price_book.findFirst({
      where: { hotel_id, year: y, month: m },
      select: { [dc]: true } as any,
    });

    const price = this.money(row?.[dc]);

    // Debug log removed for performance

    // Only breakfast used in your sample (lunch/dinner kept 0)
    return {
      breakfast: { price, gstPct: 0, gstType: 2 },
      lunch: { price: 0, gstPct: 0, gstType: 2 },
      dinner: { price: 0, gstPct: 0, gstType: 2 },
    };
  }
}
