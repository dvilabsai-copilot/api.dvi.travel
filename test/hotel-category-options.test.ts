import assert from 'node:assert/strict';
import test from 'node:test';
import { HotelsService } from '../src/modules/hotels/hotels.service';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PaginationQueryDto } from '../src/modules/hotels/dto/pagination.dto';

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

test('hotel category filters both the requested page and total count', async () => {
  let pageQuery: any;
  let countQuery: any;
  const service = new HotelsService({
    dvi_hotel: {
      findMany: async (query: any) => { pageQuery = query; return []; },
      count: async (query: any) => { countQuery = query; return 21; },
    },
    $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
  } as any);

  for (const [input, expected] of [['12', 12], ['0', 0], ['', undefined], [undefined, undefined]] as const) {
    const query = plainToInstance(PaginationQueryDto, {
      page: '2', limit: '10', hotel_state: '19', provider: 'AX', categoryId: input,
    });
    assert.deepEqual(await validate(query), []);
    const result = await service.list(query);

    assert.equal(result.total, 21);
    assert.equal(pageQuery.skip, 10);
    assert.deepEqual(pageQuery.where, countQuery.where);
    assert.ok(pageQuery.where.AND.some((condition: any) => condition.hotel_state === '19'));
    assert.ok(pageQuery.where.AND.some((condition: any) => condition.axisrooms_enabled === 1));
    assert.equal(pageQuery.where.AND.find((condition: any) => 'hotel_category' in condition)?.hotel_category, expected);
  }

  const invalid = plainToInstance(PaginationQueryDto, { categoryId: '-1' });
  assert.ok((await validate(invalid)).some(error => error.property === 'categoryId'));
});
