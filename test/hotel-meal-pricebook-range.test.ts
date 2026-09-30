import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HotelsService } from '../src/modules/hotels/hotels.service';

describe('hotel meal pricebook range view', () => {
  it('reads legacy month names and numeric months for the same date range', async () => {
    const rows = [
      { hotel_meal_price_book_id: 1, meal_type: 1, year: '2026', month: 'October', day_26: 0.1, day_27: 0.1 },
      { hotel_meal_price_book_id: 2, meal_type: 2, year: '2026', month: 'October', day_26: 500, day_27: 500 },
      { hotel_meal_price_book_id: 3, meal_type: 3, year: '2026', month: '10', day_26: 500, day_27: 500 },
      { hotel_meal_price_book_id: 4, meal_type: 1, year: '2026', month: 'November', day_1: 0.1 },
      { hotel_meal_price_book_id: 5, meal_type: 2, year: '2026', month: '11', day_1: 500 },
      { hotel_meal_price_book_id: 6, meal_type: 3, year: '2026', month: 'Nov', day_1: 500 },
    ];
    const prisma = {
      dvi_hotel_meal_price_book: {
        findMany: async () => rows,
      },
    };
    const service = new HotelsService(prisma as any);

    const result = await (service as any).getMealPricebookRangeView(403, {
      startDate: '2026-10-26',
      endDate: '2026-11-01',
    });

    assert.equal(result.rows.length, 3);
    assert.equal(result.rows.find((row: any) => row.mealType === 'Breakfast').values['2026-10-26'], 0.1);
    assert.equal(result.rows.find((row: any) => row.mealType === 'Lunch').values['2026-10-26'], 500);
    assert.equal(result.rows.find((row: any) => row.mealType === 'Dinner').values['2026-11-01'], 500);
  });
});
