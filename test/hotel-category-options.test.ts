import assert from 'node:assert/strict';
import test from 'node:test';
import { HotelsService } from '../src/modules/hotels/hotels.service';

test('hotel list category options include only active, non-deleted categories', async () => {
  let query: any;
  const service = new HotelsService({
    dvi_hotel_category: {
      findMany: async (args: any) => {
        query = args;
        return [
          { hotel_category_id: 3, hotel_category_title: '3*', hotel_category_code: 'DVI3-122193' },
        ];
      },
    },
  } as any);

  const categories = await service.getCategories();

  assert.deepEqual(query.where, { status: 1, deleted: 0 });
  assert.deepEqual(categories, [
    { id: 3, name: '3*', code: 'DVI3-122193' },
  ]);
});
