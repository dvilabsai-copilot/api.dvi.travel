#!/usr/bin/env node

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const root = process.cwd();
const month = String(process.argv.find((value) => value.startsWith('--month=')) || '--month=2026-10').slice('--month='.length);
const outputPath = String(process.argv.find((value) => value.startsWith('--output=')) || `--output=hotel-image-manifests/${month}-priced-dvi-hotels.json`).slice('--output='.length);
const year = month.slice(0, 4);
const monthNumber = Number(month.slice(5, 7));
const monthLabels = [String(monthNumber), new Date(Date.UTC(year, monthNumber - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })];
const stopWords = new Set(['the', 'hotel', 'resort', 'resorts', 'inn', 'by', 'and', 'of', 'a', 'an', 'spa', 'private', 'limited', 'pvt', 'ltd']);

function tokens(value) {
  return String(value || '').toLowerCase().replace(/&amp;/g, ' and ').replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter((token) => token.length >= 3 && !stopWords.has(token));
}

function norm(value) {
  return String(value || '').toLowerCase().replace(/&amp;/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function hasToken(value, token) {
  return new RegExp(`(?:^|\\s)${token}(?:\\s|$)`, 'i').test(String(value || ''));
}

function decode(value) {
  return String(value || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function parseBingImages(html) {
  const result = [];
  const regex = /\bm="([^"]+)"/gi;
  let match;
  while ((match = regex.exec(html))) {
    try {
      const value = JSON.parse(decode(match[1]));
      if (value?.murl) result.push({ imageUrl: String(value.murl), sourcePage: String(value.purl || ''), title: String(value.t || '') });
    } catch {
      // Skip only malformed Bing cards.
    }
  }
  return result;
}

function score(candidate, name, city) {
  const haystack = norm(`${candidate.title} ${candidate.sourcePage} ${candidate.imageUrl}`);
  const wanted = tokens(name);
  const anchors = wanted.filter((token) => token.length >= 5);
  const matches = wanted.filter((token) => hasToken(haystack, token)).length;
  const cityMatches = tokens(city).filter((token) => hasToken(haystack, token)).length;
  if (anchors.length >= 2 && anchors.some((token) => !hasToken(haystack, token))) return -1;
  if (wanted.length >= 2 && matches < Math.max(2, Math.ceil(wanted.length * 0.75))) return -1;
  if (wanted.length === 1 && matches < 1) return -1;
  if (tokens(city).length > 0 && cityMatches < 1) return -1;
  return matches * 10 + Math.min(cityMatches, 3);
}

async function discover(item) {
  const query = `"${item.name}" "${item.city}" hotel photos`;
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Bing HTTP ${response.status}`);
  const parsed = parseBingImages(await response.text());
  const candidates = parsed
    .map((candidate) => ({ ...candidate, score: score(candidate, item.name, item.city) }))
    .filter((candidate) => candidate.score >= 0)
    .sort((a, b) => b.score - a.score);
  const sourceUrls = [];
  const sourcePages = [];
  for (const candidate of candidates) {
    if (item.existingUrls.includes(candidate.imageUrl) || sourceUrls.includes(candidate.imageUrl)) continue;
    sourceUrls.push(candidate.imageUrl);
    sourcePages.push(candidate.sourcePage);
    if (sourceUrls.length >= Math.max(0, 3 - item.existingCount)) break;
  }
  return { ...item, source: 'bing-image-search', sourcePage: sourcePages[0] || '', sourceUrls, sourcePages, candidateCount: candidates.length, query };
}

async function main() {
  if (!/^\d{4}-\d{2}$/.test(month) || monthNumber < 1 || monthNumber > 12) throw new Error(`Invalid --month=${month}; use YYYY-MM`);
  const dayFields = Array.from({ length: 31 }, (_, index) => ({ [`day_${index + 1}`]: { gt: 0 } }));
  const priceRows = await prisma.dvi_hotel_room_price_book.findMany({
    where: { year, month: { in: monthLabels }, status: 1, deleted: 0, OR: dayFields },
    select: { hotel_id: true },
  });
  const hotelIds = Array.from(new Set(priceRows.map((row) => Number(row.hotel_id)).filter((id) => Number.isInteger(id) && id > 0)));
  const hotels = await prisma.dvi_hotel.findMany({
    where: { hotel_id: { in: hotelIds }, status: 1, deleted: false },
    select: { hotel_id: true, hotel_name: true, hotel_city: true, hotel_place: true, axisrooms_enabled: true },
  });
  const cityIds = Array.from(new Set(hotels.map((hotel) => Number(hotel.hotel_city)).filter((id) => Number.isInteger(id) && id > 0)));
  const cities = cityIds.length ? await prisma.dvi_cities.findMany({ where: { id: { in: cityIds }, deleted: 0 }, select: { id: true, name: true } }) : [];
  const cityById = new Map(cities.map((city) => [String(city.id), String(city.name || '').trim()]));
  const galleryRows = await prisma.dvi_hotel_gallery_details.findMany({ where: { hotel_id: { in: hotels.map((hotel) => hotel.hotel_id) }, status: 1, deleted: 0 }, select: { hotel_id: true, source_url: true } });
  const existingById = new Map();
  for (const row of galleryRows) existingById.set(Number(row.hotel_id), [...(existingById.get(Number(row.hotel_id)) || []), String(row.source_url || '').trim()]);

  const candidates = hotels.map((hotel) => {
    const code = Number(hotel.hotel_id);
    const city = cityById.get(String(hotel.hotel_city)) || String(hotel.hotel_place || '').trim();
    const existingUrls = existingById.get(code) || [];
    return { provider: Number(hotel.axisrooms_enabled) === 1 ? 'axisrooms' : 'offline', code: String(code), name: String(hotel.hotel_name || '').replace(/&amp;/g, '&').trim(), city, existingCount: existingUrls.length, existingUrls };
  }).filter((item) => item.name && item.city && item.existingCount < 3);

  const ready = [];
  const short = [];
  const concurrency = 4;
  for (let index = 0; index < candidates.length; index += concurrency) {
    const batch = candidates.slice(index, index + concurrency);
    const results = await Promise.all(batch.map(async (item) => {
      try { return await discover(item); }
      catch (error) { return { ...item, sourceUrls: [], sourcePages: [], error: error instanceof Error ? error.message : String(error) }; }
    }));
    for (const result of results) {
      if (result.sourceUrls.length >= Math.max(0, 3 - result.existingCount)) ready.push(result);
      else short.push(result);
    }
    console.log(`Bing price-scope discovery ${Math.min(index + concurrency, candidates.length)}/${candidates.length}`);
  }

  const output = path.resolve(root, outputPath);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify({ generatedAt: new Date().toISOString(), month, priceRows: priceRows.length, pricedHotelIds: hotelIds.length, activeHotels: hotels.length, targetImagesPerHotel: 3, sources: ready, short }, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ month, priceRows: priceRows.length, pricedHotelIds: hotelIds.length, activeHotels: hotels.length, candidates: candidates.length, ready: ready.length, short: short.length, manifest: path.relative(root, output) }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
