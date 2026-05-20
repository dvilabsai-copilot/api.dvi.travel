import { expect, test } from '@playwright/test';
import {
  SCENARIO_QUOTE_ENV,
  allAttractions,
  allCheckins,
  dayOne,
  extractVisitStartMinutes,
  fetchItineraryDetails,
  findFirstIndex,
  loginForToken,
  parseDisplayTimeToMinutes,
  scenarioQuoteId,
  seedAuthToken,
  segmentsOf,
} from './booking-engine-test-utils';

const TWO_PM_MINUTES = 14 * 60;

test.describe('Booking engine validation', () => {
  test('1) before noon + same-city hotel -> sightseeing first, hotel after 2 PM', async ({ request }) => {
    const quoteId = scenarioQuoteId('beforeNoonSameCity');
    test.skip(!quoteId, `Set ${SCENARIO_QUOTE_ENV.beforeNoonSameCity}`);

    const token = await loginForToken(request);
    const details = await fetchItineraryDetails(request, token, quoteId as string);
    const segments = segmentsOf(dayOne(details));

    const firstAttractionIndex = findFirstIndex(segments, (s) => s.type === 'attraction');
    const firstCheckinIndex = findFirstIndex(segments, (s) => s.type === 'checkin');

    expect(firstAttractionIndex).toBeGreaterThanOrEqual(0);
    expect(firstCheckinIndex).toBeGreaterThanOrEqual(0);
    expect(firstAttractionIndex).toBeLessThan(firstCheckinIndex);

    const firstCheckin = allCheckins(segments)[0];
    const checkinMinutes = parseDisplayTimeToMinutes(firstCheckin?.time || null);
    expect(checkinMinutes).not.toBeNull();
    expect(checkinMinutes as number).toBeGreaterThanOrEqual(TWO_PM_MINUTES);
  });

  test('2) after noon + same-city + <=20km -> hotel first, 2 PM clamp, rest gap, then sightseeing if available', async ({ request }) => {
    const quoteId = scenarioQuoteId('afterNoonSameCityWithin20');
    test.skip(!quoteId, `Set ${SCENARIO_QUOTE_ENV.afterNoonSameCityWithin20}`);

    const token = await loginForToken(request);
    const details = await fetchItineraryDetails(request, token, quoteId as string);
    const segments = segmentsOf(dayOne(details));

    const firstAttractionIndex = findFirstIndex(segments, (s) => s.type === 'attraction');
    const firstCheckinIndex = findFirstIndex(segments, (s) => s.type === 'checkin');

    expect(firstCheckinIndex).toBeGreaterThanOrEqual(0);
    if (firstAttractionIndex >= 0) {
      expect(firstCheckinIndex).toBeLessThan(firstAttractionIndex);
    }

    const firstCheckin = allCheckins(segments)[0];
    const checkinMinutes = parseDisplayTimeToMinutes(firstCheckin?.time || null);
    expect(checkinMinutes).not.toBeNull();
    expect(checkinMinutes as number).toBeGreaterThanOrEqual(TWO_PM_MINUTES);

    const attractions = allAttractions(segments);
    expect(attractions.length).toBeGreaterThanOrEqual(2);

    const firstAttractionStartMinutes = extractVisitStartMinutes(attractions[0]);
    expect(firstAttractionStartMinutes).not.toBeNull();
    expect((firstAttractionStartMinutes as number) - (checkinMinutes as number)).toBeGreaterThanOrEqual(120);
  });

  test('3) after noon + same-city + >20km -> hotel not forced first, remains last-stop behavior', async ({ request }) => {
    const quoteId = scenarioQuoteId('afterNoonSameCityBeyond20');
    test.skip(!quoteId, `Set ${SCENARIO_QUOTE_ENV.afterNoonSameCityBeyond20}`);

    const token = await loginForToken(request);
    const details = await fetchItineraryDetails(request, token, quoteId as string);
    const segments = segmentsOf(dayOne(details));

    const firstAttractionIndex = findFirstIndex(segments, (s) => s.type === 'attraction');
    const firstCheckinIndex = findFirstIndex(segments, (s) => s.type === 'checkin');

    expect(firstAttractionIndex).toBeGreaterThanOrEqual(0);
    expect(firstCheckinIndex).toBeGreaterThanOrEqual(0);
    expect(firstAttractionIndex).toBeLessThan(firstCheckinIndex);

    const lastSegment = segments[segments.length - 1];
    expect(
      lastSegment?.type === 'checkin' ||
      lastSegment?.type === 'travel' ||
      lastSegment?.type === 'hotspot',
    ).toBeTruthy();
  });

  test('4) Day 1 different-city hotel -> en-route/source/via sightseeing before hotel', async ({ request }) => {
    const quoteId = scenarioQuoteId('differentCityDay1');
    test.skip(!quoteId, `Set ${SCENARIO_QUOTE_ENV.differentCityDay1}`);

    const token = await loginForToken(request);
    const details = await fetchItineraryDetails(request, token, quoteId as string);
    const segments = segmentsOf(dayOne(details));

    const firstAttractionIndex = findFirstIndex(segments, (s) => s.type === 'attraction');
    const firstCheckinIndex = findFirstIndex(segments, (s) => s.type === 'checkin');

    expect(firstAttractionIndex).toBeGreaterThanOrEqual(0);
    expect(firstCheckinIndex).toBeGreaterThanOrEqual(0);
    expect(firstAttractionIndex).toBeLessThan(firstCheckinIndex);

    const hasTravelBeforeHotel = segments
      .slice(0, firstCheckinIndex)
      .some((s) => s.type === 'travel' && String(s.from || '').trim() !== String(s.to || '').trim());

    expect(hasTravelBeforeHotel).toBeTruthy();
  });

  test('5a) closed hotspot handling -> closed/outside-hours annotations present for deferred/skipped behavior', async ({ request }) => {
    const quoteId = scenarioQuoteId('closedHotspotDeferred');
    test.skip(!quoteId, `Set ${SCENARIO_QUOTE_ENV.closedHotspotDeferred}`);

    const token = await loginForToken(request);
    const details = await fetchItineraryDetails(request, token, quoteId as string);
    const segments = segmentsOf(dayOne(details));
    const attractions = allAttractions(segments);

    expect(attractions.length).toBeGreaterThan(0);

    const hasTimingAnnotation = attractions.some((s) =>
      /(opens at|outside operating hours|closed on this day)/i.test(String(s.visitTime || '')),
    );

    expect(hasTimingAnnotation).toBeTruthy();
  });

  test('5b) mustVisitProxy deferred priority -> optional assertion with explicit expected hotspot id', async ({ request }) => {
    const quoteId = scenarioQuoteId('closedHotspotDeferred');
    test.skip(!quoteId, `Set ${SCENARIO_QUOTE_ENV.closedHotspotDeferred}`);

    const expectedMustVisitFirstHotspotId = Number(
      String(process.env.E2E_BOOKING_RULE_EXPECTED_MUST_VISIT_FIRST_HOTSPOT_ID || '0'),
    );
    test.skip(
      !expectedMustVisitFirstHotspotId,
      'Set E2E_BOOKING_RULE_EXPECTED_MUST_VISIT_FIRST_HOTSPOT_ID for deterministic mustVisitProxy-order validation.',
    );

    const token = await loginForToken(request);
    const details = await fetchItineraryDetails(request, token, quoteId as string);
    const segments = segmentsOf(dayOne(details));
    const attractions = allAttractions(segments);

    expect(attractions.length).toBeGreaterThan(0);
    expect(Number(attractions[0].hotspotId || 0)).toBe(expectedMustVisitFirstHotspotId);
  });

  test('6) houseboat stay -> sightseeing suppressed on that route/day', async ({ request }) => {
    const quoteId = scenarioQuoteId('houseboat');
    test.skip(!quoteId, `Set ${SCENARIO_QUOTE_ENV.houseboat}`);

    const token = await loginForToken(request);
    const details = await fetchItineraryDetails(request, token, quoteId as string);
    const segments = segmentsOf(dayOne(details));

    const attractions = allAttractions(segments);
    const checkins = allCheckins(segments);

    expect(attractions.length).toBe(0);
    expect(checkins.length).toBeGreaterThan(0);
  });

  test('7) KM limit warning exposed in itinerary details API', async ({ request, page, baseURL }) => {
    const quoteId = scenarioQuoteId('kmWarning');
    test.skip(!quoteId, `Set ${SCENARIO_QUOTE_ENV.kmWarning}`);

    const token = await loginForToken(request);
    const details = await fetchItineraryDetails(request, token, quoteId as string);

    expect(String(details?.costBreakdown?.kmLimitWarning || '').trim().length).toBeGreaterThan(0);

    await seedAuthToken(page, request);
    await page.goto(`${baseURL}/itinerary-details/${encodeURIComponent(quoteId as string)}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page).toHaveURL(new RegExp(`/itinerary-details/${quoteId}$`), { timeout: 30000 });
  });

  test('8) guide total aggregation reflected in API and UI', async ({ request, page, baseURL }) => {
    const quoteId = scenarioQuoteId('guideTotal');
    test.skip(!quoteId, `Set ${SCENARIO_QUOTE_ENV.guideTotal}`);

    const token = await loginForToken(request);
    const details = await fetchItineraryDetails(request, token, quoteId as string);

    const totalGuideCost = Number(details?.costBreakdown?.totalGuideCost || 0);
    expect(totalGuideCost).toBeGreaterThan(0);

    await seedAuthToken(page, request);
    await page.goto(`${baseURL}/itinerary-details/${encodeURIComponent(quoteId as string)}`, {
      waitUntil: 'domcontentloaded',
    });

    await expect(page).toHaveURL(new RegExp(`/itinerary-details/${quoteId}$`), { timeout: 30000 });
    await expect(page.getByText(/Total Guide Cost/i).first()).toBeVisible({ timeout: 30000 });
  });
});
