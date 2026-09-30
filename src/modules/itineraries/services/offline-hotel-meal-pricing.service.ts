import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import {
  calculateOfflineMealBreakdown,
  OfflineMealBreakdown,
  OfflineMealFlags,
  OfflineMealPrices,
} from '../utils/offline-hotel-meal-plan.util';

export type OfflineMealPricebookByDate = Map<string, OfflineMealPrices>;

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const dateOnly = (value: string): string => String(value || '').slice(0, 10);

const monthMatches = (value: unknown, month: number): boolean => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === String(month).padStart(2, '0') ||
    normalized === String(month) ||
    normalized === MONTH_NAMES[month - 1] ||
    normalized === MONTH_NAMES[month - 1].slice(0, 3);
};

const positiveNumber = (value: unknown): number => {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

@Injectable()
export class OfflineHotelMealPricingService {
  constructor(private readonly prisma: PrismaService) {}

  async loadPricebookByDate(hotelIds: number[], dates: string[]): Promise<Map<number, OfflineMealPricebookByDate>> {
    const ids = Array.from(new Set(hotelIds.map(Number).filter((id) => id > 0)));
    const normalizedDates = Array.from(new Set(dates.map(dateOnly).filter(Boolean)));
    const result = new Map<number, OfflineMealPricebookByDate>();
    if (ids.length === 0 || normalizedDates.length === 0) return result;

    const rows = await this.prisma.dvi_hotel_meal_price_book.findMany({
      where: { hotel_id: { in: ids }, status: 1, deleted: 0 },
    });

    for (const date of normalizedDates) {
      const parsed = new Date(`${date}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime())) continue;
      const year = String(parsed.getUTCFullYear());
      const month = parsed.getUTCMonth() + 1;
      const dayKey = `day_${parsed.getUTCDate()}` as keyof typeof rows[number];

      for (const hotelId of ids) {
        const prices: OfflineMealPrices = { breakfast: 0, lunch: 0, dinner: 0 };
        for (const mealType of [1, 2, 3]) {
          const row: any = (rows as any[]).find((candidate) =>
            Number(candidate.hotel_id) === hotelId &&
            Number(candidate.meal_type) === mealType &&
            String(candidate.year || '').trim() === year &&
            monthMatches(candidate.month, month),
          );
          const price = positiveNumber(row?.[dayKey]);
          if (mealType === 1) prices.breakfast = price;
          if (mealType === 2) prices.lunch = price;
          if (mealType === 3) prices.dinner = price;
        }
        const byDate = result.get(hotelId) || new Map<string, OfflineMealPrices>();
        byDate.set(date, prices);
        result.set(hotelId, byDate);
      }
    }
    return result;
  }

  calculate(input: {
    flags: OfflineMealFlags;
    prices?: OfflineMealPrices;
    fallbackMealPlanCode?: string;
    adultCount: number;
    childCount: number;
    roomCount: number;
    roomQuantity?: number;
  }): OfflineMealBreakdown {
    return calculateOfflineMealBreakdown({
      ...input,
      prices: input.prices || { breakfast: 0, lunch: 0, dinner: 0 },
    });
  }
}
