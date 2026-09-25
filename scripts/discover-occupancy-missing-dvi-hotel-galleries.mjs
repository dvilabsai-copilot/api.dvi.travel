#!/usr/bin/env node

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const root = process.cwd();
const outputPath = String(process.argv.find((value) => value.startsWith('--output=')) || '--output=hotel-image-manifests/occupancy-missing-dvi-hotels.json').slice('--output='.length);
const targetImagesPerHotel = 3;
const concurrency = Math.max(1, Number(String(process.argv.find((value) => value.startsWith('--concurrency=')) || '--concurrency=2').slice('--concurrency='.length)) || 2);
const delayMs = Math.max(0, Number(String(process.argv.find((value) => value.startsWith('--delay-ms=')) || '--delay-ms=500').slice('--delay-ms='.length)) || 0);
const stopWords = new Set(['the', 'hotel', 'resort', 'resorts', 'inn', 'by', 'and', 'of', 'a', 'an', 'spa', 'private', 'limited', 'pvt', 'ltd']);

function tokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&amp;/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !stopWords.has(token));
}

function norm(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&amp;/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasToken(value, token) {
  return new RegExp(`(?:^|\\s)${token}(?:\\s|$)`, 'i').test(String(value || ''));
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
  const searchUrl = `https://duckduckgo.com/?iax=images&ia=images&q=${encodeURIComponent(query)}`;
  const response = await fetch(searchUrl, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`DuckDuckGo search HTTP ${response.status}`);
  const html = await response.text();
  const vqdMatch = html.match(/vqd=(?:"([^"]+)"|'([^']+)'|([^&"'\s]+))/i);
  const vqd = vqdMatch?.[1] || vqdMatch?.[2] || vqdMatch?.[3] || '';
  if (!vqd) throw new Error('DuckDuckGo image token not found');
  const apiUrl = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${encodeURIComponent(vqd)}&f=,,,,,&p=1`;
  const apiResponse = await fetch(apiUrl, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
      referer: searchUrl,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!apiResponse.ok) throw new Error(`DuckDuckGo image API HTTP ${apiResponse.status}`);
  const payload = await apiResponse.json();
  const parsed = (Array.isArray(payload?.results) ? payload.results : [])
    .map((candidate) => ({
      imageUrl: String(candidate?.image || '').trim(),
      sourcePage: String(candidate?.url || '').trim(),
      title: String(candidate?.title || '').trim(),
    }))
    .filter((candidate) => candidate.imageUrl);
  const candidates = parsed
    .map((candidate) => ({ ...candidate, score: score(candidate, item.name, item.city) }))
    .filter((candidate) => candidate.score >= 0)
    .sort((left, right) => right.score - left.score);
  const sourceUrls = [];
  const sourcePages = [];
  for (const candidate of candidates) {
    if (item.existingUrls.includes(candidate.imageUrl) || sourceUrls.includes(candidate.imageUrl)) continue;
    sourceUrls.push(candidate.imageUrl);
    sourcePages.push(candidate.sourcePage);
    if (sourceUrls.length >= targetImagesPerHotel) break;
  }
  return {
    ...item,
    source: 'duckduckgo-image-search',
    sourcePage: sourcePages[0] || '',
    sourceUrls,
    sourcePages,
    candidateCount: candidates.length,
    query,
  };
}

async function main() {
  const occupancyRows = await prisma.dvi_hotel_occupancy_rate.findMany({
    select: { hotel_id: true },
    distinct: ['hotel_id'],
  });
  const occupancyHotelIds = Array.from(new Set(
    occupancyRows.map((row) => Number(row.hotel_id)).filter((id) => Number.isInteger(id) && id > 0),
  ));
  const hotels = await prisma.dvi_hotel.findMany({
    where: { hotel_id: { in: occupancyHotelIds }, status: 1, deleted: false },
    select: {
      hotel_id: true,
      hotel_name: true,
      hotel_city: true,
      hotel_place: true,
      axisrooms_enabled: true,
    },
  });
  const cityIds = Array.from(new Set(
    hotels.map((hotel) => Number(hotel.hotel_city)).filter((id) => Number.isInteger(id) && id > 0),
  ));
  const cities = cityIds.length
    ? await prisma.dvi_cities.findMany({ where: { id: { in: cityIds }, deleted: 0 }, select: { id: true, name: true } })
    : [];
  const cityById = new Map(cities.map((city) => [String(city.id), String(city.name || '').trim()]));
  const galleryRows = hotels.length
    ? await prisma.dvi_hotel_gallery_details.findMany({
      where: { hotel_id: { in: hotels.map((hotel) => hotel.hotel_id) }, status: 1, deleted: 0 },
      select: { hotel_id: true, source_url: true },
    })
    : [];
  const existingById = new Map();
  for (const row of galleryRows) {
    const id = Number(row.hotel_id);
    existingById.set(id, [...(existingById.get(id) || []), String(row.source_url || '').trim()]);
  }

  const candidates = hotels.map((hotel) => {
    const code = Number(hotel.hotel_id);
    const city = cityById.get(String(hotel.hotel_city)) || String(hotel.hotel_place || '').trim();
    const existingUrls = existingById.get(code) || [];
    return {
      provider: Number(hotel.axisrooms_enabled) === 1 ? 'axisrooms' : 'offline',
      code: String(code),
      name: String(hotel.hotel_name || '').replace(/&amp;/g, '&').trim(),
      city,
      existingCount: existingUrls.length,
      existingUrls,
    };
  }).filter((item) => item.name && item.city && item.existingCount === 0);

  const ready = [];
  const short = [];
  const failed = [];
  for (let index = 0; index < candidates.length; index += concurrency) {
    const batch = candidates.slice(index, index + concurrency);
    const results = await Promise.all(batch.map(async (item) => {
      try {
        return await discover(item);
      } catch (error) {
        return { ...item, sourceUrls: [], sourcePages: [], error: error instanceof Error ? error.message : String(error) };
      }
    }));
    for (const result of results) {
      if (result.sourceUrls.length >= targetImagesPerHotel) ready.push(result);
      else if (result.error) failed.push(result);
      else short.push(result);
    }
    console.log(`Image discovery ${Math.min(index + concurrency, candidates.length)}/${candidates.length}`);
    if (delayMs > 0 && index + concurrency < candidates.length) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const output = path.resolve(root, outputPath);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    scope: 'active-dvi-hotels-with-occupancy-rates-and-no-active-gallery',
    occupancyHotelIds: occupancyHotelIds.length,
    activeHotels: hotels.length,
    candidates: candidates.length,
    targetImagesPerHotel,
    sources: ready,
    short,
    failed,
  }, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    occupancyHotelIds: occupancyHotelIds.length,
    activeHotels: hotels.length,
    candidates: candidates.length,
    ready: ready.length,
    short: short.length,
    failed: failed.length,
    manifest: path.relative(root, output),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
