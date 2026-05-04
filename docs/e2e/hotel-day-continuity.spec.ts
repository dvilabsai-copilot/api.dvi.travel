/**
 * E2E test: Hotel continuity across days for DVI202604230
 *
 * Verifies that:
 * 1. Each day's check-in card shows a real hotel name (not "Hotel" placeholder)
 * 2. Each day's first "Travelling from X" label matches the previous day's check-in hotel
 * 3. Each day's last "Travelling to X" label matches the current day's check-in hotel
 *
 * The user reported: "User checked previous night OYO 9443 but day starts from Ramco"
 * This test catches that inconsistency automatically.
 */

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const USER_EMAIL = process.env.E2E_HOTSPOT_USER ?? 'admin@dvi.co.in';
const USER_PASSWORD = process.env.E2E_HOTSPOT_PASSWORD ?? 'Keerthi@2404ias';
const API_BASE_URL = process.env.E2E_API_BASE_URL ?? 'http://127.0.0.1:4006/api/v1';
const QUOTE_ID = process.env.E2E_ITINERARY_QUOTE_ID ?? 'DVI202604230';

async function loginForToken(request: APIRequestContext): Promise<string> {
  const loginRes = await request.post(`${API_BASE_URL}/auth/login`, {
    data: { email: USER_EMAIL, password: USER_PASSWORD },
  });
  if (!loginRes.ok()) throw new Error(`Auth login failed: ${loginRes.status()}`);
  const json = (await loginRes.json()) as { accessToken?: string };
  const token = String(json?.accessToken || '').trim();
  if (!token) throw new Error('accessToken missing');
  return token;
}

async function seedAuthToken(page: Page, request: APIRequestContext): Promise<string> {
  const token = await loginForToken(request);
  await page.addInitScript((t) => {
    window.localStorage.setItem('accessToken', t);
  }, token);
  return token;
}

test.describe('Hotel day continuity - DVI202604230', () => {
  test('each day check-in and travel-from/to match across all days', async ({
    page,
    request,
    baseURL,
  }) => {
    test.setTimeout(180_000);

    await seedAuthToken(page, request);

    // Navigate to itinerary details
    const url = `${baseURL ?? 'http://localhost:8080'}/itinerary-details/${QUOTE_ID}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Wait for hotel data to load — the loading spinner should disappear
    // and the timeline should be visible
    await page.waitForSelector('[data-testid="itinerary-timeline"], .timeline-card, [class*="timeline"]', {
      timeout: 30_000,
    }).catch(() => {/* may not have test id, continue */});

    // Wait for any "Loading" text to disappear
    await page.waitForFunction(() => {
      const body = document.body.innerText;
      return !body.includes('Loading hotel data') && !body.includes('Preparing timeline');
    }, { timeout: 30_000 }).catch(() => {});

    // Give JS one more tick to finish rendering hydrated names
    await page.waitForTimeout(2000);

    // ─── Scrape Day Cards ─────────────────────────────────────────────────────
    // Each day has a header with "DAY N" and segments below it.
    // We'll collect per-day: checkinHotel, firstTravelFrom, lastTravelTo
    type DayData = {
      dayNumber: number;
      checkinHotels: string[];    // may be multiple checkins (e.g., Day 1 early + end-of-day)
      firstTravelFrom: string | null;
      lastTravelTo: string | null;
      allTravelFromTo: Array<{ from: string; to: string }>;
    };

    const dayData: DayData[] = await page.evaluate(() => {
      const results: DayData[] = [];

      // Find day header containers — look for text "DAY N"
      // The page renders days in sequence; we'll walk the DOM
      const allText = document.querySelectorAll('*');
      const dayHeaderEls: Element[] = [];

      allText.forEach((el) => {
        if (
          el.children.length === 0 &&
          /^DAY\s+\d+/i.test((el.textContent || '').trim())
        ) {
          // Walk up to find the day-section root
          dayHeaderEls.push(el);
        }
      });

      // Alternative: look for any element whose text matches DAY N pattern
      // and is a heading-level element or day-card
      const dayCards = Array.from(document.querySelectorAll('[class*="day"], [data-day]'))
        .filter(el => /DAY\s+\d+/i.test(el.textContent || ''));

      // Strategy: find all "Check-in to X" text and "Travelling from X to Y" text
      // by querying the rendered segment cards

      // Get all card-like containers
      const cards = Array.from(document.querySelectorAll('div, section, article'));

      const checkinCards: Array<{ text: string; rect: DOMRect }> = [];
      const travelCards: Array<{ from: string; to: string; rect: DOMRect }> = [];
      const dayHeaders: Array<{ dayNum: number; rect: DOMRect }> = [];

      cards.forEach((card) => {
        const text = (card.textContent || '').trim();
        const rect = card.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        // Day headers
        const dayMatch = text.match(/^DAY\s+(\d+)\s*[-–]/im);
        if (dayMatch && card.children.length > 0 && card.children.length < 5) {
          dayHeaders.push({ dayNum: parseInt(dayMatch[1]), rect });
        }

        // Check-in cards: contain "Check-in to" text
        if (/Check-in to\s+\S/i.test(text) && card.children.length < 6) {
          const match = text.match(/Check-in to\s+(.+?)(?:\n|$)/i);
          if (match) {
            checkinCards.push({ text: match[1].trim(), rect });
          }
        }

        // Travel cards: contain "Travelling from X to Y"
        if (/Travelling from\s+.+\s+to\s+/i.test(text) && card.children.length < 8) {
          const match = text.match(/Travelling from\s+(.+?)\s+to\s+(.+?)(?:\n|📍|🕐|$)/i);
          if (match) {
            travelCards.push({ from: match[1].trim(), to: match[2].trim(), rect });
          }
        }
      });

      // Sort by vertical position
      dayHeaders.sort((a, b) => a.rect.top - b.rect.top);
      checkinCards.sort((a, b) => a.rect.top - b.rect.top);
      travelCards.sort((a, b) => a.rect.top - b.rect.top);

      // Assign segments to days by vertical position
      dayHeaders.forEach((header, i) => {
        const nextHeaderTop = i + 1 < dayHeaders.length ? dayHeaders[i + 1].rect.top : Infinity;

        const dayCheckins = checkinCards
          .filter(c => c.rect.top > header.rect.top && c.rect.top < nextHeaderTop)
          .map(c => c.text);

        const dayTravels = travelCards
          .filter(t => t.rect.top > header.rect.top && t.rect.top < nextHeaderTop);

        results.push({
          dayNumber: header.dayNum,
          checkinHotels: dayCheckins,
          firstTravelFrom: dayTravels.length > 0 ? dayTravels[0].from : null,
          lastTravelTo: dayTravels.length > 0 ? dayTravels[dayTravels.length - 1].to : null,
          allTravelFromTo: dayTravels.map(t => ({ from: t.from, to: t.to })),
        });
      });

      return results;
    });

    // ─── Scroll and repeat for all days ──────────────────────────────────────
    // The page may be virtualized; scroll to bottom to load all days
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);

    // Re-scrape after scroll
    const dayDataFull: DayData[] = await page.evaluate(() => {
      const results: DayData[] = [];
      const cards = Array.from(document.querySelectorAll('div'));

      const checkinCards: Array<{ text: string; top: number }> = [];
      const travelCards: Array<{ from: string; to: string; top: number }> = [];
      const dayHeaders: Array<{ dayNum: number; top: number }> = [];

      cards.forEach((card) => {
        const text = (card.textContent || '').trim();
        const rect = card.getBoundingClientRect();
        const scrollTop = window.scrollY || document.documentElement.scrollTop;
        const absTop = rect.top + scrollTop;
        if (rect.width === 0 && rect.height === 0) return;

        // Day headers
        const dayMatch = text.match(/^DAY\s+(\d+)\s*[-–—\s]/im);
        if (dayMatch && card.children.length >= 1 && card.children.length <= 8) {
          const num = parseInt(dayMatch[1]);
          if (!dayHeaders.find(h => h.dayNum === num)) {
            dayHeaders.push({ dayNum: num, top: absTop });
          }
        }

        // Check-in cards
        if (/^Check-in to\s+\S/i.test(text) && card.children.length <= 5) {
          const match = text.match(/^Check-in to\s+(.+?)(?:\n|Click|$)/i);
          if (match) {
            checkinCards.push({ text: match[1].trim(), top: absTop });
          }
        }

        // Travel cards
        if (/^Travelling from\s+.+?\s+to\s+\S/i.test(text) && card.children.length <= 6) {
          const match = text.match(/^Travelling from\s+(.+?)\s+to\s+(.+?)(?:\n|🕐|📍|$)/is);
          if (match) {
            travelCards.push({ from: match[1].trim(), to: match[2].split('\n')[0].trim(), top: absTop });
          }
        }
      });

      dayHeaders.sort((a, b) => a.top - b.top);
      checkinCards.sort((a, b) => a.top - b.top);
      travelCards.sort((a, b) => a.top - b.top);

      dayHeaders.forEach((header, i) => {
        const nextHeaderTop = i + 1 < dayHeaders.length ? dayHeaders[i + 1].top : Infinity;

        const dayCheckins = checkinCards
          .filter(c => c.top > header.top && c.top < nextHeaderTop)
          .map(c => c.text);

        const dayTravels = travelCards
          .filter(t => t.top > header.top && t.top < nextHeaderTop);

        results.push({
          dayNumber: header.dayNum,
          checkinHotels: dayCheckins,
          firstTravelFrom: dayTravels.length > 0 ? dayTravels[0].from : null,
          lastTravelTo: dayTravels.length > 0 ? dayTravels[dayTravels.length - 1].to : null,
          allTravelFromTo: dayTravels.map(t => ({ from: t.from, to: t.to })),
        });
      });

      return results;
    });

    const days = dayDataFull.length > 0 ? dayDataFull : dayData;

    // ─── Print Summary ────────────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════');
    console.log(`  Hotel Continuity Report — ${QUOTE_ID}`);
    console.log('═══════════════════════════════════════════════════════');

    for (const d of days) {
      console.log(`\nDay ${d.dayNumber}:`);
      console.log(`  First travel FROM : ${d.firstTravelFrom ?? '(none)'}`);
      console.log(`  Last  travel TO   : ${d.lastTravelTo ?? '(none)'}`);
      console.log(`  Check-in hotel(s) : ${d.checkinHotels.join(' | ') || '(none)'}`);
    }

    // ─── Assertions: continuity check ────────────────────────────────────────
    const errors: string[] = [];

    for (let i = 1; i < days.length; i++) {
      const prevDay = days[i - 1];
      const currDay = days[i];

      // Previous day must have a check-in hotel
      const prevCheckinHotel = prevDay.checkinHotels.at(-1); // last checkin of previous day
      if (!prevCheckinHotel) {
        // Not all days have hotels (e.g. last day with airport)
        continue;
      }

      // Normalize: strip everything after a time-like pattern (HH:MM AM/PM) or KM/note suffix
      const stripSuffix = (s: string): string =>
        s.replace(/\s*\d{1,2}:\d{2}\s*(AM|PM).*$/i, '').replace(/\s+\d+\.?\d*\s*KM.*/i, '').trim();

      // Previous day's last travel should end at the hotel
      if (
        prevDay.lastTravelTo &&
        !/airport/i.test(prevDay.lastTravelTo)
      ) {
        const lastTravelToNorm = stripSuffix(prevDay.lastTravelTo).toLowerCase();
        const prevCheckinNorm = stripSuffix(prevCheckinHotel).toLowerCase();
        if (lastTravelToNorm !== prevCheckinNorm) {
          errors.push(
            `Day ${prevDay.dayNumber}: last travel goes to "${stripSuffix(prevDay.lastTravelTo)}" but check-in shows "${stripSuffix(prevCheckinHotel)}"`
          );
        }
      }

      // Current day's first travel FROM should match previous day's check-in hotel
      if (currDay.firstTravelFrom) {
        const fromNorm = currDay.firstTravelFrom.toLowerCase().trim();
        const hotelNorm = stripSuffix(prevCheckinHotel).toLowerCase();

        // Only flag if the from label looks like a hotel (not just a city name)
        const isHotelName = /hotel|resort|inn|residency|palace|lodge|stay|oyo/i.test(currDay.firstTravelFrom);
        const matchesPrevHotel =
          fromNorm === hotelNorm ||
          fromNorm.startsWith(hotelNorm.substring(0, 12)) ||
          hotelNorm.startsWith(fromNorm.substring(0, 12));

        if (isHotelName && !matchesPrevHotel) {
          errors.push(
            `Day ${currDay.dayNumber}: first travel FROM "${currDay.firstTravelFrom}" does NOT match previous Day ${prevDay.dayNumber} check-in hotel "${stripSuffix(prevCheckinHotel)}"`
          );
        }
      }

      // Check-in card on current day should NOT be a placeholder
      for (const hotelName of currDay.checkinHotels) {
        if (hotelName.toLowerCase() === 'hotel') {
          errors.push(`Day ${currDay.dayNumber}: check-in shows placeholder "Hotel" — hotel name not hydrated`);
        }
      }
    }

    // Print errors
    if (errors.length > 0) {
      console.log('\n✗ CONTINUITY ERRORS FOUND:');
      errors.forEach((e) => console.log(`  • ${e}`));
    } else {
      console.log('\n✓ All days pass hotel continuity checks');
    }

    console.log('═══════════════════════════════════════════════════════\n');

    // Actually assert
    expect(errors, `Hotel continuity failures:\n${errors.join('\n')}`).toHaveLength(0);
  });
});
