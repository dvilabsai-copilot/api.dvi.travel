import { expect, test } from '@playwright/test';

const PHP_URL = 'http://localhost/dvi_b2b/latestitinerary.php?id=41015';
const NEST_URL = 'http://localhost:8080/itinerary-details/DVI202604230';
const NEST_API_URL = 'http://localhost:4006/api/v1/itineraries/details/DVI202604230';

// Baseline captured from PHP plan 41015 (dvi_travels).
const PHP_BASELINE_BY_DAY: Record<number, number[]> = {
  1: [5, 11],
  2: [4, 342, 746],
  3: [56, 59, 57, 15, 455, 456],
  4: [454, 344, 451],
  5: [278],
  6: [144, 125],
  7: [122, 124, 93, 90],
  8: [],
};

type DiffRow = {
  day: number;
  php: number[];
  nest: number[];
  missingInNest: number[];
  extraInNest: number[];
};

const sorted = (arr: number[]): number[] => [...arr].sort((a, b) => a - b);

test('PHP baseline vs Nest API parity for DVI202604230', async ({ page, request }) => {
  await page.goto(PHP_URL, { waitUntil: 'domcontentloaded' });
  const phpResolvedUrl = page.url();
  const phpAccessible = !/restricted\.php|index\.php\?msg=log_out/i.test(phpResolvedUrl);

  await page.goto(NEST_URL, { waitUntil: 'domcontentloaded' });
  const nestResolvedUrl = page.url();

  const apiRes = await request.get(NEST_API_URL);
  expect(apiRes.ok()).toBeTruthy();

  const data = await apiRes.json();
  const days = Array.isArray(data?.days) ? data.days : [];

  const nestByDay: Record<number, number[]> = {};
  for (let i = 0; i < days.length; i++) {
    const dayNo = i + 1;
    const segments = Array.isArray(days[i]?.segments) ? days[i].segments : [];
    const ids: number[] = [];

    for (const seg of segments) {
      if (seg?.type === 'attraction' && Number.isFinite(Number(seg?.hotspotId))) {
        ids.push(Number(seg.hotspotId));
      }
    }

    nestByDay[dayNo] = ids;
  }

  const diffs: DiffRow[] = [];
  for (let day = 1; day <= 8; day++) {
    const php = sorted(PHP_BASELINE_BY_DAY[day] ?? []);
    const nest = sorted(nestByDay[day] ?? []);
    const phpSet = new Set(php);
    const nestSet = new Set(nest);

    const missingInNest = php.filter((id) => !nestSet.has(id));
    const extraInNest = nest.filter((id) => !phpSet.has(id));

    diffs.push({ day, php, nest, missingInNest, extraInNest });
  }

  console.log('[PLAYWRIGHT_PARITY] phpAccessible=', phpAccessible, 'phpResolvedUrl=', phpResolvedUrl);
  console.log('[PLAYWRIGHT_PARITY] nestResolvedUrl=', nestResolvedUrl);
  for (const row of diffs) {
    const ok = row.missingInNest.length === 0 && row.extraInNest.length === 0;
    console.log(
      `[PLAYWRIGHT_PARITY] Day ${row.day} ${ok ? 'MATCH' : 'DIFF'} | PHP=${row.php.join(',')} | NEST=${row.nest.join(',')} | missing=${row.missingInNest.join(',')} | extra=${row.extraInNest.join(',')}`,
    );
  }

  const mismatchDays = diffs.filter(
    (r) => r.missingInNest.length > 0 || r.extraInNest.length > 0,
  );

  // Keep this strict so test turns green only when parity is truly achieved.
  expect(mismatchDays, 'PHP-to-Nest hotspot parity mismatch').toEqual([]);
});
