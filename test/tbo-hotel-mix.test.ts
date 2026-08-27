import assert from 'node:assert/strict';
import test from 'node:test';
import { TBOHotelProvider } from '../src/modules/hotels/providers/tbo-hotel.provider';

type Candidate = {
  hotelCode: string;
  starRating: number;
  isPriority: boolean;
};

const candidate = (
  hotelCode: string,
  starRating: number,
  isPriority = false,
): Candidate => ({ hotelCode, starRating, isPriority });

const candidatesFor = (prefix: string, starRating: number, count: number): Candidate[] =>
  Array.from({ length: count }, (_, index) =>
    candidate(`${prefix}-${String(index + 1).padStart(3, '0')}`, starRating),
  );

const balancedCandidates = (multiplier = 1): Candidate[] => [
  ...candidatesFor('E1', 1, 10 * multiplier),
  ...candidatesFor('E2', 2, 10 * multiplier),
  ...candidatesFor('S3', 3, 50 * multiplier),
  ...candidatesFor('S4', 4, 20 * multiplier),
  ...candidatesFor('S5', 5, 10 * multiplier),
];

const createProvider = (prisma: Record<string, unknown> = {}): any =>
  new TBOHotelProvider(prisma as any, {} as any) as any;

const selectMixed = (items: Candidate[]): Candidate[] =>
  createProvider().selectHotelsByPercentage(items);

const segmentCounts = (items: Candidate[]) => ({
  economy: items.filter((item) => item.starRating === 1 || item.starRating === 2).length,
  threeStar: items.filter((item) => item.starRating === 3).length,
  fourStar: items.filter((item) => item.starRating === 4).length,
  fiveStar: items.filter((item) => item.starRating === 5).length,
});

const withHotelLimit = async (value: string | undefined, action: () => void | Promise<void>) => {
  const previous = process.env.TBO_MIXED_HOTEL_LIMIT;
  if (value === undefined) delete process.env.TBO_MIXED_HOTEL_LIMIT;
  else process.env.TBO_MIXED_HOTEL_LIMIT = value;

  try {
    await action();
  } finally {
    if (previous === undefined) delete process.env.TBO_MIXED_HOTEL_LIMIT;
    else process.env.TBO_MIXED_HOTEL_LIMIT = previous;
  }
};

test('selects a 20/50/20/10 mix for 100 hotels', () => {
  assert.deepEqual(segmentCounts(selectMixed(balancedCandidates())), {
    economy: 20,
    threeStar: 50,
    fourStar: 20,
    fiveStar: 10,
  });
});

test('selects a 20/50/20/10 mix for 50 hotels', async () => {
  await withHotelLimit('50', () => {
    assert.deepEqual(segmentCounts(selectMixed(balancedCandidates())), {
      economy: 10,
      threeStar: 25,
      fourStar: 10,
      fiveStar: 5,
    });
  });
});

test('selects a 20/50/20/10 mix for 10 hotels', async () => {
  await withHotelLimit('10', () => {
    assert.deepEqual(segmentCounts(selectMixed(balancedCandidates())), {
      economy: 2,
      threeStar: 5,
      fourStar: 2,
      fiveStar: 1,
    });
  });
});

test('redistributes a three-star shortage and still returns 100 hotels', () => {
  const selected = selectMixed([
    ...candidatesFor('E', 2, 40),
    ...candidatesFor('S3', 3, 30),
    ...candidatesFor('S4', 4, 35),
    ...candidatesFor('S5', 5, 20),
  ]);

  assert.equal(selected.length, 100);
  assert.equal(segmentCounts(selected).threeStar, 30);
  assert.equal(new Set(selected.map((item) => item.hotelCode)).size, 100);
});

test('treats both one-star and two-star hotels as economy', async () => {
  await withHotelLimit('10', () => {
    const selected = selectMixed([
      candidate('ONE', 1),
      candidate('TWO', 2),
      ...candidatesFor('S3', 3, 5),
      ...candidatesFor('S4', 4, 2),
      candidate('FIVE', 5),
    ]);
    assert.equal(selected.some((item) => item.hotelCode === 'ONE'), true);
    assert.equal(selected.some((item) => item.hotelCode === 'TWO'), true);
  });
});

test('excludes null-equivalent, zero, and out-of-range ratings', () => {
  const selected = selectMixed([
    candidate('ZERO', 0),
    candidate('NULL', Number(null)),
    candidate('SIX', 6),
    candidate('VALID', 3),
  ]);
  assert.deepEqual(selected.map((item) => item.hotelCode), ['VALID']);
});

test('deduplicates hotel property codes', () => {
  const selected = selectMixed([
    candidate('DUPLICATE', 3),
    candidate('DUPLICATE', 3, true),
    candidate('UNIQUE', 3),
  ]);
  assert.deepEqual(
    selected.map((item) => item.hotelCode).sort(),
    ['DUPLICATE', 'UNIQUE'],
  );
});

test('selects priority hotels first within a segment', async () => {
  await withHotelLimit('1', () => {
    const selected = selectMixed([
      candidate('001-NON-PRIORITY', 3),
      candidate('999-PRIORITY', 3, true),
    ]);
    assert.equal(selected[0]?.hotelCode, '999-PRIORITY');
  });
});

test('explicit star ratings bypass the standard mix', () => {
  const provider = createProvider();
  const selected = provider.selectExplicitStarRatingHotels(
    balancedCandidates(),
    [4],
  ) as Candidate[];
  assert.equal(selected.length, 20);
  assert.equal(selected.every((item) => item.starRating === 4), true);
});

test('returns every valid unique hotel when a city has fewer than the limit', () => {
  const selected = selectMixed([
    candidate('E', 2),
    candidate('THREE-A', 3),
    candidate('THREE-B', 3),
    candidate('FOUR', 4),
    candidate('FIVE', 5),
  ]);
  assert.equal(selected.length, 5);
});

test('invalid environment limit defaults to 100', async () => {
  await withHotelLimit('invalid', () => {
    assert.equal(createProvider().getMixedHotelLimit(), 100);
  });
});

test('environment limit above 500 is capped at 500', async () => {
  await withHotelLimit('900', () => {
    assert.equal(createProvider().getMixedHotelLimit(), 500);
  });
});

test('explicit hotelCodes bypass master-data percentage allocation', async () => {
  const provider = createProvider();
  let databaseSelectorCalled = false;
  let sentCodes = '';
  provider.resolveTboCityCode = async () => ({ tboCityCode: '130443', source: 'test' });
  provider.ensureCityAndHotelsInDb = async () => undefined;
  provider.getHotelCodesForCityFromDb = async () => {
    databaseSelectorCalled = true;
    return '';
  };
  provider.executeTBOSearch = async (request: any) => {
    sentCodes = request.HotelCodes;
    return [];
  };

  await provider.search({
    cityCode: '1979',
    checkInDate: '2026-09-06',
    checkOutDate: '2026-09-07',
    roomCount: 1,
    guestCount: 2,
    guestNationality: 'IN',
    occupancies: [{ adults: 2, children: 0 }],
    hotelCodes: 'EXPLICIT-1,EXPLICIT-2',
  });

  assert.equal(databaseSelectorCalled, false);
  assert.equal(sentCodes, 'EXPLICIT-1,EXPLICIT-2');
});

test('search sends the allocated master hotel codes to TBO', async () => {
  const masterRows = balancedCandidates().map((item) => ({
    tbo_hotel_code: item.hotelCode,
    star_rating: item.starRating,
    is_priority: item.isPriority ? 1 : 0,
  }));
  const provider = createProvider({
    tbo_hotel_master: {
      findMany: async () => masterRows,
    },
  });
  let sentCodes: string[] = [];
  provider.resolveTboCityCode = async () => ({ tboCityCode: '130443', source: 'test' });
  provider.ensureCityAndHotelsInDb = async () => undefined;
  provider.executeTBOSearch = async (request: any) => {
    sentCodes = String(request.HotelCodes).split(',');
    return [];
  };

  await provider.search({
    cityCode: '1979',
    checkInDate: '2026-09-06',
    checkOutDate: '2026-09-07',
    roomCount: 1,
    guestCount: 2,
    guestNationality: 'IN',
    occupancies: [{ adults: 2, children: 0 }],
  });

  assert.equal(sentCodes.length, 100);
  const selected = masterRows.filter((row) => sentCodes.includes(row.tbo_hotel_code));
  assert.deepEqual(segmentCounts(selected.map((row) => candidate(
    row.tbo_hotel_code,
    row.star_rating,
  ))), {
    economy: 20,
    threeStar: 50,
    fourStar: 20,
    fiveStar: 10,
  });
});
